// WSK-67 — the gaiada.com content importer (`src/seed/webdesk-import.ts`).
//
// Real: Postgres (RLS, the activities ledger, the approval rows), Cerbos (the real WSK-47 policies), the
// real `webdeskContent` service and WSK-66's `fileWebdeskCommandApproval`. Stand-in: Zone B, an in-process
// fake (`ImporterFake`, built on WSK-59's `FakeZoneB` for tenant.list) that is strict where WebDesk is: it
// verifies the editorial assertion's cmd/ten/site/cmh, stores `{blocks, seo}` under WebDesk's real
// assembly rules and content hash, pages its lists, honours `twinOf`, and replays or refuses an idempotency
// key the way WSK-41 does.
//
// Every lifecycle test runs twice: on a small synthetic bundle (always) and on the REAL gaiada bundle when
// WSK67_BUNDLE names it (the gate exports it from the site repo). Needs DATABASE_URL_TEST + CERBOS_URL.
//
// Done-when map (design §12 WSK-67):  1 dry run → "1 dry run";  2 apply twice → "2 apply twice";
// 3 one changed item → "3 one changed item";  4 refusals → "4 the principal";  5 one approval → "5 request-publish";
// 6 static test → "6 static: no publish";  7 Cerbos probe → "7 Cerbos probe".
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authorize } from "../core/http";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { assemblePrincipal } from "../rbac/principal";
import type { WebdeskControlRequest, WebdeskControlResponse } from "../modules/webdev/webdesk-control-client";
import { setWebdeskApprovedCommandDepsForTests } from "../modules/webdev/webdesk-approved-command";
import { webdeskZoneB } from "../modules/webdev/webdesk-content.service";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "../modules/webdev/webdesk-ws4-assertion";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, makeTestSigner, problem } from "../modules/webdev/webdesk-content-testkit";
import {
  ImporterRefusal,
  assembledContent,
  canonicalize,
  contentHashOf,
  idempotencyKeyFor,
  loadBundle,
  parseArgs,
  resolveImporterPrincipal,
  runImport,
  type Bundle,
  type BundleItem,
  type ImportOptions,
} from "./webdesk-import";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const REAL_BUNDLE = process.env.WSK67_BUNDLE ?? "";
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The fake WebDesk
// ══════════════════════════════════════════════════════════════════════════════════════════════════

interface StoredVersion {
  version: number;
  blocks: unknown[];
  seo: Record<string, unknown>;
  contentHash: string;
  createdBy: string;
  note: string | null;
}
interface StoredItem {
  itemId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  groupId: string;
  deletedAt: string | null;
  versions: StoredVersion[];
}

const reply = (json: unknown, status = 200): WebdeskControlResponse => ({
  status,
  contentType: "application/json",
  json,
  bodyText: JSON.stringify(json),
});

class ImporterFake extends FakeZoneB {
  readonly comps = new Map<string, Record<string, unknown>>();
  readonly store = new Map<string, StoredItem>();
  private readonly idem = new Map<string, { hash: string; res: WebdeskControlResponse }>();
  /** Page size cap: small, so a 300-item collection must follow cursors. */
  pageSize = 40;

  resetAll(): void {
    this.reset();
    this.comps.clear();
    this.store.clear();
    this.idem.clear();
  }

  versionCount(): number {
    let n = 0;
    for (const i of this.store.values()) n += i.versions.length;
    return n;
  }
  heads(): Map<string, number> {
    return new Map([...this.store.values()].map((i) => [i.itemId, i.versions.length]));
  }
  byIdentity(collectionKey: string, locale: string, slug: string): StoredItem | undefined {
    return [...this.store.values()].find((i) => i.collectionKey === collectionKey && i.locale === locale && i.slug === slug);
  }

  private wireItem(i: StoredItem) {
    const head = i.versions[i.versions.length - 1];
    return {
      itemId: i.itemId,
      collectionKey: i.collectionKey,
      locale: i.locale,
      slug: i.slug,
      localizationGroupId: i.groupId,
      headVersion: i.versions.length,
      publishedVersion: null,
      publishState: "draft",
      deletedAt: i.deletedAt,
      headCreatedBy: head.createdBy,
      title: i.slug,
    };
  }
  private wireVersion(i: StoredItem, n: number) {
    const v = i.versions[n - 1];
    return { version: v.version, contentHash: v.contentHash, blocks: v.blocks, seo: v.seo, note: v.note, createdBy: v.createdBy };
  }

  private checkEditorial(req: WebdeskControlRequest): { sub: string } | WebdeskControlResponse {
    if (!req.editorialAssertion) return problem(401, "editorial-assertion-missing");
    const claims = JSON.parse(Buffer.from(req.editorialAssertion.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const cmh = computeCommandHash(req.command, commandArgsAsZoneBSeesThem(req.params ?? {}, req.body));
    if (claims.cmd !== req.command || claims.cmh !== cmh) return problem(403, "editorial-assertion-command-mismatch");
    if (claims.ten !== req.params?.tenantSlug || claims.site !== req.params?.siteId) return problem(403, "editorial-assertion-scope-mismatch");
    if (claims.apr !== undefined) return problem(403, "editorial-assertion-command-mismatch");
    return { sub: String(claims.sub) };
  }

  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    const mine = new Set(["collection.list", "collection.get", "item.list", "item.get", "schema.apply", "content.create", "content.update"]);
    if (!mine.has(req.command)) return super.send(req); // tenant.list, and anything unexpected (a publish would be recorded)
    this.calls.push({
      command: req.command, method: req.method, path: req.path, params: { ...(req.params ?? {}) },
      query: req.query, body: req.body, idempotencyKey: req.idempotencyKey, editorialAssertion: req.editorialAssertion, hadWs4: !!req.ws4,
    });
    if (this.failWith) throw this.failWith;
    const p = req.params ?? {};
    switch (req.command) {
      case "collection.list":
        return reply({ collections: [...this.comps].map(([key, composition]) => ({ key, composition, vocabularyVersion: "1.1.0" })) });
      case "collection.get":
        return this.comps.has(p.key) ? reply({ key: p.key, composition: this.comps.get(p.key), vocabularyVersion: "1.1.0" }) : problem(404, "collection-not-found");
      case "item.list": {
        if (!this.comps.has(p.key)) return problem(404, "collection-not-found");
        const q = req.query ?? {};
        const rows = [...this.store.values()].filter((i) => i.collectionKey === p.key && (!q.locale || i.locale === q.locale) && (q.includeDeleted === "true" || !i.deletedAt));
        const start = q.cursor ? Number(q.cursor) : 0;
        const size = Math.min(Number(q.limit ?? 50), this.pageSize);
        const slice = rows.slice(start, start + size);
        const more = start + size < rows.length;
        return reply({ items: slice.map((i) => this.wireItem(i)), page: { cursor: more ? String(start + size) : null, hasMore: more, limit: size } });
      }
      case "item.get": {
        const i = this.store.get(p.itemId);
        if (!i) return problem(404, "item-not-found");
        const n = req.query?.version === undefined || req.query.version === "head" ? i.versions.length : Number(req.query.version);
        if (!i.versions[n - 1]) return problem(404, "version-not-found");
        return reply({ item: this.wireItem(i), version: this.wireVersion(i, n), lint: {} });
      }
      default:
        break;
    }

    // ── writes ──
    if (!req.idempotencyKey) return problem(400, "invalid-request", { detail: "Idempotency-Key required" });
    let sub = "";
    if (req.command !== "schema.apply") {
      const v = this.checkEditorial(req);
      if ("status" in v) return v;
      sub = v.sub;
    }
    const scope = `${p.tenantSlug}:${req.command}:${req.idempotencyKey}`;
    const bodyHash = sha(canonicalize({ p, b: req.body ?? {} }));
    const seen = this.idem.get(scope);
    if (seen) {
      return seen.hash === bodyHash
        ? { ...seen.res, json: { ...(seen.res.json as object), replayed: true } }
        : problem(422, "idempotency-key-reuse", { detail: "same key, different request" });
    }
    const res = this.applyWrite(req, sub);
    if (res.status < 300) this.idem.set(scope, { hash: bodyHash, res });
    return res;
  }

  private applyWrite(req: WebdeskControlRequest, sub: string): WebdeskControlResponse {
    const p = req.params ?? {};
    const b = (req.body ?? {}) as Record<string, any>;
    if (req.command === "schema.apply") {
      this.comps.set(p.collectionKey, b.schema);
      return reply({ collectionKey: p.collectionKey, bump: "minor", reasons: [], persisted: true, replayed: false }, 201);
    }
    if (req.command === "content.create") {
      const comp = this.comps.get(b.collectionKey);
      if (!comp) return problem(404, "collection-not-found");
      if ([...this.store.values()].some((i) => i.collectionKey === b.collectionKey && i.locale === b.locale && i.slug === b.slug)) return problem(409, "slug-taken");
      let groupId: string = randomUUID();
      if (b.twinOf) {
        const twin = this.store.get(b.twinOf);
        if (!twin || twin.collectionKey !== b.collectionKey) return problem(404, "item-not-found");
        if ([...this.store.values()].some((i) => i.groupId === twin.groupId && i.locale === b.locale)) return problem(409, "twin-locale-taken");
        groupId = twin.groupId;
      }
      const { blocks, seo } = assemble(b.collectionKey, comp, b);
      const item: StoredItem = {
        itemId: randomUUID(), collectionKey: b.collectionKey, locale: b.locale, slug: b.slug, groupId, deletedAt: null,
        versions: [{ version: 1, blocks, seo, contentHash: hashOf(blocks, seo), createdBy: sub, note: b.note ?? null }],
      };
      this.store.set(item.itemId, item);
      return reply({ item: this.wireItem(item), version: { version: 1, contentHash: item.versions[0].contentHash }, unchanged: false, lint: {}, replayed: false }, 201);
    }
    // content.update
    const i = this.store.get(p.itemId);
    if (!i) return problem(404, "item-not-found");
    if (b.baseVersion !== i.versions.length) return problem(409, "version-conflict", { currentHeadVersion: i.versions.length });
    const { blocks, seo } = assemble(i.collectionKey, this.comps.get(i.collectionKey) ?? {}, b);
    const head = i.versions[i.versions.length - 1];
    const hash = hashOf(blocks, seo);
    if (hash === head.contentHash) return reply({ item: this.wireItem(i), version: { version: head.version, contentHash: hash }, unchanged: true, lint: {}, replayed: false });
    i.versions.push({ version: i.versions.length + 1, blocks, seo, contentHash: hash, createdBy: sub, note: b.note ?? null });
    return reply({ item: this.wireItem(i), version: { version: i.versions.length, contentHash: hash }, unchanged: false, lint: {}, replayed: false });
  }
}

/** WebDesk's `assembleItemContent`, restated independently of the importer (the parity test below pins both
 *  against WebDesk's own function on the real bundle). */
function assemble(collectionKey: string, comp: Record<string, unknown>, input: Record<string, any>): { blocks: unknown[]; seo: Record<string, unknown> } {
  const seoIn = (input.seo ?? {}) as Record<string, unknown>;
  if (collectionKey === "redirect") return { blocks: [], seo: { ...seoIn, redirect: input.fields ?? {} } };
  const tail = (input.blocks ?? []) as unknown[];
  return { blocks: Array.isArray(comp.fields) ? [{ type: "fields", props: input.fields ?? {} }, ...tail] : [...tail], seo: seoIn };
}
const hashOf = (blocks: unknown, seo: unknown): string => sha(canonicalize({ blocks, seo }));

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// Bundles
// ══════════════════════════════════════════════════════════════════════════════════════════════════

function seal(b: Omit<Bundle, "sha256">): Bundle {
  return { ...b, sha256: sha(canonicalize(b)) };
}

function syntheticBundle(): Bundle {
  const items: BundleItem[] = [
    { collectionKey: "redirect", locale: "en", slug: "/old-path", fields: { toPath: "/new-path", status: "301", active: "true" }, seo: {} },
    { collectionKey: "service", locale: "en", slug: "seo", fields: { h1: "SEO" }, seo: { title: "SEO" } },
    { collectionKey: "service", locale: "id", slug: "seo", twinOfSlug: "seo", fields: { h1: "SEO id" }, seo: { title: "SEO id" } },
    { collectionKey: "service", locale: "en", slug: "web-design", fields: { h1: "Web design" }, seo: {} },
    { collectionKey: "tool", locale: "en", slug: "roi-calc", fields: { h1: "ROI" }, blocks: [{ type: "text", props: { body: "hi" } }], seo: {} },
  ];
  return seal({
    bundleVersion: 1,
    vocabularyVersion: "1.1.0",
    site: "gaiada-com",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    compositions: {
      service: { ui: { label: "Services" }, fields: [{ name: "h1", primitive: "text" }] },
      tool: { ui: { label: "Tools" }, fields: [{ name: "h1", primitive: "text" }] },
      redirect: { ui: { label: "Redirects" } },
    },
    items,
  } as Omit<Bundle, "sha256">);
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The suite
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe.skipIf(!live)("WSK-67 · the gaiada.com importer", () => {
  let A: string;
  let importerId: string;
  let humanId: string;
  let unlistedBotId: string;
  let ownerId: string;
  const zb = new ImporterFake("", "");
  const signer = makeTestSigner();
  let dir: string;
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, WEBDESK_IMPORTER_PRINCIPALS: importerId });

  const opts = (bundlePath: string, extra: Partial<ImportOptions> = {}): ImportOptions => ({
    tenantId: A,
    site: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE },
    bundlePath,
    principalId: importerId,
    apply: false,
    requestPublish: false,
    ...extra,
  });
  /** The webdesk approvals of company A; `bundleSha` narrows to one bundle's (the suites share the company). */
  const approvals = async (bundleSha?: string) =>
    (await adminPool().query<{ id: string; status: string; workflow_id: string; requested_by: string; tool_args: any }>(
      `SELECT id, status, workflow_id, requested_by, tool_args FROM automation_approvals
        WHERE tenant_id = $1 AND origin = 'webdesk' AND ($2::text IS NULL OR tool_args->'summary'->>'bundleSha256' = $2) ORDER BY created_at`,
      [A, bundleSha ?? null],
    )).rows;
  const ledgerCount = async () =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A])).rows[0].n);

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("WSK-67 Co", ["webdev"]);
    const B = await createCompany("WSK-67 Other Co", ["webdev"]);
    const mk = async (email: string, role: string, kind?: string) => {
      const id = await createUser(email);
      await addMembership(A, id);
      await grantRole(id, await createRole(role), "company", A);
      if (kind) await adminPool().query(`UPDATE users SET kind = $2 WHERE id = $1`, [id, kind]);
      return id;
    };
    importerId = await mk("wsk67-importer@ex.test", "webdev_manager", "automation");
    unlistedBotId = await mk("wsk67-other-bot@ex.test", "webdev_manager", "automation");
    humanId = await mk("wsk67-human@ex.test", "webdev_manager");
    ownerId = await mk("wsk67-owner@ex.test", "company_admin");
    zb.tenants.length = 0;
    zb.tenants.push({ companyRef: A, slug: GAIADA_SLUG, status: "active", siteId: GAIADA_SITE });
    zb.tenants.push({ companyRef: B, slug: "othertenant", status: "active", siteId: randomUUID() });
    dir = mkdtempSync(join(tmpdir(), "wsk67-"));
  }, 120_000);

  beforeEach(() => {
    signer.calls.length = 0;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
  });
  afterAll(async () => {
    setWebdeskApprovedCommandDepsForTests(null);
    rmSync(dir, { recursive: true, force: true });
    await teardownTestDb();
  });

  const write = (name: string, b: Bundle): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(b, null, 2));
    return p;
  };

  // ── 4 ────────────────────────────────────────────────────────────────────────────────────────
  describe("4 · the principal", () => {
    it("refuses a human id, an unlisted automation id, an unknown id and an empty allow-list, before any WebDesk call", async () => {
      zb.resetAll();
      const p = write("syn-principal.json", syntheticBundle());
      const base = (id: string) => ({ ...opts(p), principalId: id });
      // a HUMAN, even when listed
      await expect(runImport(base(humanId), { ...process.env, WEBDESK_IMPORTER_PRINCIPALS: `${importerId},${humanId}` })).rejects.toThrow(/users\.kind='automation'/);
      // an automation user that is NOT listed
      await expect(runImport(base(unlistedBotId), env())).rejects.toThrow(/not listed in WEBDESK_IMPORTER_PRINCIPALS/);
      // a uuid that is no user, but is listed
      const ghost = randomUUID();
      await expect(runImport(base(ghost), { ...process.env, WEBDESK_IMPORTER_PRINCIPALS: ghost })).rejects.toThrow(/not a user/);
      // not a uuid
      await expect(runImport(base("anthony@gaiada.com"), env())).rejects.toThrow(ImporterRefusal);
      // nothing listed
      await expect(runImport(opts(p), { ...process.env, WEBDESK_IMPORTER_PRINCIPALS: "" })).rejects.toThrow(/is empty/);
      expect(zb.calls).toHaveLength(0);
      expect(await ledgerCount()).toBe(0);
    });

    it("the listed automation principal resolves; assurance is explicitly non-low and the signer sees pk 'automation'", async () => {
      const principal = await resolveImporterPrincipal(importerId, env());
      expect(principal.assurance).not.toBe("low");
      expect(principal.userId).toBe(importerId);
      // the unmodified principal an automation user would get on its own channels is `low`
      expect((await assemblePrincipal(importerId, "low"))?.assurance).toBe("low");
    });

    it("--request-publish needs --apply; bad CLI arguments are refused", async () => {
      await expect(runImport(opts("x.json", { requestPublish: true }), env())).rejects.toThrow(/needs --apply/);
      expect(() => parseArgs(["--tenant-id", "t"])).toThrow(/--site is required|--bundle is required|--principal is required/);
      expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
      expect(parseArgs(["--tenant-id", A, "--site", "gaiada/abc", "--bundle", "b.json", "--principal", importerId]).apply).toBe(false);
      expect(() => parseArgs(["--tenant-id", A, "--site", "gaiada", "--bundle", "b.json", "--principal", importerId])).toThrow(/<tenantSlug>\/<siteId>/);
    });

    it("refuses a bundle whose sha256 does not match its content", () => {
      const b = syntheticBundle();
      const tampered = { ...b, items: b.items.map((i, k) => (k === 1 ? { ...i, fields: { h1: "tampered" } } : i)) };
      expect(() => loadBundle(write("tampered.json", tampered))).toThrow(/sha256 does not match/);
    });
  });

  // ── 1, 2, 3, 5: the lifecycle, on the synthetic bundle and the real one ─────────────────────────
  const cases: Array<{ name: string; skip: boolean; load: () => { path: string; bundle: Bundle } }> = [
    { name: "synthetic bundle", skip: false, load: () => { const b = syntheticBundle(); return { path: write("syn.json", b), bundle: b }; } },
    { name: "REAL gaiada bundle", skip: !REAL_BUNDLE, load: () => ({ path: REAL_BUNDLE, bundle: loadBundle(REAL_BUNDLE) }) },
  ];

  describe.each(cases)("lifecycle · $name", ({ skip, load }) => {
    const run = skip ? describe.skip : describe;
    run("sequence", () => {
      let path = "";
      let bundle: Bundle;
      let versionsAfterApply = 0;
      let writesAfterApply = 0;

      beforeAll(() => {
        zb.resetAll();
        ({ path, bundle } = load());
      });

      it("1 · a dry run prints the plan per collection and locale and writes NOTHING", async () => {
        const before = await ledgerCount();
        const r = await runImport(opts(path), env());
        console.log(r.lines.join("\n"));
        if (r.publishPreview) console.log(`publish request preview: ${JSON.stringify(r.publishPreview)}`);
        expect(r.dryRun).toBe(true);
        expect(r.totals).toEqual({ create: bundle.items.length, update: 0, skip: 0, blocked: 0 });
        expect(r.compositions.apply.sort()).toEqual(Object.keys(bundle.compositions).sort());
        // the per-collection/locale table accounts for every item
        let counted = 0;
        for (const byLocale of Object.values(r.plan)) for (const c of Object.values(byLocale)) counted += c.create;
        expect(counted).toBe(bundle.items.length);
        // ZERO writes: no write command reached WebDesk, no ledger row, no version, no approval
        expect(zb.writes).toHaveLength(0);
        expect(zb.store.size).toBe(0);
        expect(await ledgerCount()).toBe(before);
        expect((await approvals(bundle.sha256)).length).toBe(0);
        expect(r.writes).toEqual({ schemaApplied: 0, created: 0, updated: 0, unchanged: 0, versionsWritten: 0 });
      });

      it("2 · --apply creates everything (compositions first, twins linked, spec idempotency keys, pk 'automation'); the SECOND run writes 0 versions", async () => {
        const r1 = await runImport(opts(path, { apply: true }), env());
        console.log(r1.lines.filter((l) => l.startsWith("APPLIED")).join("\n"));
        expect(r1.failures).toEqual([]);
        expect(r1.writes.created).toBe(bundle.items.length);
        expect(r1.writes.schemaApplied).toBe(Object.keys(bundle.compositions).length);
        expect(zb.store.size).toBe(bundle.items.length);

        // compositions went first
        const cmds = zb.writes.map((c) => c.command);
        expect(cmds.slice(0, Object.keys(bundle.compositions).length).every((c) => c === "schema.apply")).toBe(true);
        expect(cmds.slice(Object.keys(bundle.compositions).length).every((c) => c === "content.create")).toBe(true);

        // idempotency keys: import:<sha>:<collection>:<locale>:<slug>
        const creates = zb.writes.filter((c) => c.command === "content.create");
        for (const c of creates) {
          const b = c.body as { collectionKey: string; locale: string; slug: string };
          expect(c.idempotencyKey).toBe(idempotencyKeyFor(bundle.sha256, b));
        }
        const plain = bundle.items.find((i) => /^[\x21-\x7e]{1,40}$/.test(i.slug) && !i.slug.includes("/"));
        if (plain) expect(creates.map((c) => c.idempotencyKey)).toContain(`import:${bundle.sha256}:${plain.collectionKey}:${plain.locale}:${plain.slug}`);

        // twins preserved: every bundle twin shares its group with its source
        const twins = bundle.items.filter((i) => i.twinOfSlug !== undefined);
        for (const t of twins) {
          const mine = zb.byIdentity(t.collectionKey, t.locale, t.slug);
          const src = zb.byIdentity(t.collectionKey, t.locale === "en" ? "id" : "en", t.twinOfSlug as string);
          expect(mine && src && mine.groupId === src.groupId).toBe(true);
        }
        // every stored item holds EXACTLY the bundle's content under WebDesk's assembly
        for (const i of bundle.items) {
          const s = zb.byIdentity(i.collectionKey, i.locale, i.slug)!;
          const want = assembledContent(i, bundle.compositions[i.collectionKey]);
          expect(canonicalize({ blocks: s.versions[0].blocks, seo: s.versions[0].seo })).toBe(canonicalize(want));
        }
        // signed as the importer, as an automation (attribution only)
        expect(signer.calls.length).toBe(creates.length);
        expect(new Set(signer.calls.map((c) => c.sub))).toEqual(new Set([importerId]));
        expect(new Set(signer.calls.map((c) => c.pk))).toEqual(new Set(["automation"]));
        // never a publish, an unpublish or a delete
        expect(zb.calls.filter((c) => /publish|delete|schedule|restore/i.test(c.command))).toHaveLength(0);
        // the ledger has the two-row pattern for each write
        expect(await ledgerCount()).toBeGreaterThanOrEqual(creates.length * 2);

        versionsAfterApply = zb.versionCount();
        writesAfterApply = zb.writes.length;
        expect(versionsAfterApply).toBe(bundle.items.length);

        // ── the second run ──
        const r2 = await runImport(opts(path, { apply: true }), env());
        expect(r2.failures).toEqual([]);
        expect(r2.totals).toEqual({ create: 0, update: 0, skip: bundle.items.length, blocked: 0 });
        expect(r2.writes).toEqual({ schemaApplied: 0, created: 0, updated: 0, unchanged: 0, versionsWritten: 0 });
        expect(zb.versionCount()).toBe(versionsAfterApply);
        expect(zb.writes.length).toBe(writesAfterApply); // no write command at all, not just no new version
      });

      it("3 · ONE changed item produces exactly ONE update (baseVersion = head), and only that item's version moves", async () => {
        const items = bundle.items.map((i) => ({ ...i }));
        const k = items.findIndex((i) => i.collectionKey !== "redirect" && Object.keys(i.fields).length > 0);
        const target = items[k];
        const firstKey = Object.keys(target.fields)[0];
        target.fields = { ...target.fields, [firstKey]: `${JSON.stringify(target.fields[firstKey])} (edited)` };
        const { sha256: _s, ...rest } = bundle;
        void _s;
        const changed = seal({ ...rest, items } as Omit<Bundle, "sha256">);
        const cpath = write(`changed-${bundle.sha256.slice(0, 8)}.json`, changed);

        const dry = await runImport(opts(cpath), env());
        expect(dry.totals).toEqual({ create: 0, update: 1, skip: bundle.items.length - 1, blocked: 0 });

        const heads0 = zb.heads();
        const r = await runImport(opts(cpath, { apply: true }), env());
        expect(r.failures).toEqual([]);
        expect(r.writes).toMatchObject({ created: 0, updated: 1, unchanged: 0, versionsWritten: 1, schemaApplied: 0 });
        const upd = zb.writes.filter((c) => c.command === "content.update");
        expect(upd).toHaveLength(1);
        expect(upd[0].body).toMatchObject({ baseVersion: 1 });
        expect(upd[0].idempotencyKey).toBe(idempotencyKeyFor(changed.sha256, target, ":b1"));
        const moved = [...zb.heads()].filter(([id, n]) => n !== heads0.get(id));
        expect(moved).toHaveLength(1);
        expect(zb.byIdentity(target.collectionKey, target.locale, target.slug)!.versions).toHaveLength(2);

        // and the changed bundle is now a no-op too
        const again = await runImport(opts(cpath, { apply: true }), env());
        expect(again.writes.versionsWritten).toBe(0);
        // restore the original content for the next test (one update back)
        const back = await runImport(opts(path, { apply: true }), env());
        expect(back.writes).toMatchObject({ updated: 1, versionsWritten: 1 });
      });

      it("5 · --request-publish files exactly ONE approval whose items are the head versions; it never publishes", async () => {
        expect((await approvals(bundle.sha256)).length).toBe(0);
        const r = await runImport(opts(path, { apply: true, requestPublish: true }), env());
        expect(r.failures).toEqual([]);
        expect(r.publishApprovalId).toBeTruthy();
        const rows = await approvals(bundle.sha256);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.id).toBe(r.publishApprovalId);
        expect(row.status).toBe("pending");
        expect(row.workflow_id).toBe("content.publish");
        expect(row.requested_by).toBe(importerId);

        const items = row.tool_args.items as Array<{ itemId: string; version: number }>;
        expect(items).toHaveLength(bundle.items.length);
        const heads = zb.heads();
        expect(new Map(items.map((i) => [i.itemId, i.version]))).toEqual(heads);
        const counts: Record<string, number> = {};
        for (const i of bundle.items) counts[i.collectionKey] = (counts[i.collectionKey] ?? 0) + 1;
        expect(row.tool_args.summary).toMatchObject({ bundleSha256: bundle.sha256, counts });
        expect(row.tool_args.summary.title).toContain(bundle.sha256);
        expect(row.tool_args.summary.title).toContain(`${bundle.items.length} items`);
        expect(zb.calls.filter((c) => /publish|schedule/.test(c.command))).toHaveLength(0);

        // a second request for the same bundle is refused, not filed twice
        const again = await runImport(opts(path, { apply: true, requestPublish: true }), env());
        expect(again.publishApprovalId).toBeNull();
        expect(again.failures.map((f) => f.reason).join(" ")).toMatch(/already pending/);
        expect(await approvals(bundle.sha256)).toHaveLength(1);
      });
    });
  });

  // ── 7 ────────────────────────────────────────────────────────────────────────────────────────
  describe("7 · Cerbos probe: the importer may create and apply a schema, and may NOT publish", () => {
    it("ALLOW create + apply_schema (+ read, request_publish); DENY publish with an approvalId when the importer is the requester; DENY at `low`", async () => {
      const p = await resolveImporterPrincipal(importerId, env());
      const item = { kind: "webdesk_content_item", tenantId: A, module: "webdev" } as const;
      await expect(authorize(p, item, "create")).resolves.toBeUndefined();
      await expect(authorize(p, item, "request_publish")).resolves.toBeUndefined();
      await expect(authorize(p, { kind: "webdesk_collection", tenantId: A, module: "webdev" }, "apply_schema")).resolves.toBeUndefined();
      await expect(authorize(p, { kind: "webdesk_collection", tenantId: A, module: "webdev" }, "read")).resolves.toBeUndefined();

      const approvalId = randomUUID();
      // publish, WITH an approvalId, on an approval the importer itself requested: maker != checker
      await expect(authorize(p, { ...item, approvalId, creatorId: importerId }, "publish")).rejects.toThrow(/not authorized/);
      // publish with an approvalId and no creator on record
      await expect(authorize(p, { ...item, approvalId }, "publish")).rejects.toThrow(/not authorized/);
      // publish with no approval at all (and the schedule twin)
      await expect(authorize(p, item, "publish")).rejects.toThrow(/not authorized/);
      await expect(authorize(p, { ...item, approvalId, creatorId: importerId }, "schedule")).rejects.toThrow(/not authorized/);

      // positive control for the publish DENY above: the SAME request with the owner as requester is allowed
      // for a decider, so the denials are the maker-checker rule, not a malformed request.
      const owner = await assemblePrincipal(ownerId, "high");
      await expect(authorize(owner!, { ...item, approvalId, creatorId: importerId }, "publish")).resolves.toBeUndefined();

      // why the CLI assembles the principal with an explicit non-low assurance: at `low`, EVERY allow is a deny
      const low = (await assemblePrincipal(importerId, "low"))!;
      await expect(authorize(low, item, "create")).rejects.toThrow(/not authorized/);
      await expect(authorize(low, { kind: "webdesk_collection", tenantId: A, module: "webdev" }, "apply_schema")).rejects.toThrow(/not authorized/);
    });
  });

  // ── 6 ────────────────────────────────────────────────────────────────────────────────────────
  describe("6 · static: the module can never publish, unpublish or delete", () => {
    const src = readFileSync(join(__dirname, "webdesk-import.ts"), "utf8");
    // whole-line // comments first: a `/*` inside one (a glob like `scripts/*.ts`) must not open a block comment
    const code = src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

    it("imports only an allow-listed set of names from an allow-listed set of modules", () => {
      const imports = [...code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)].map((m) => ({
        names: m[1].split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean),
        from: m[2],
      }));
      const allowed: Record<string, string[] | "*"> = {
        "node:crypto": ["createHash"],
        "node:fs": ["readFileSync"],
        "../core/http": ["authorize"],
        "../db": ["closePool", "withGlobal", "withTenants"],
        "../rbac/principal": ["assemblePrincipal", "Principal"],
        "../modules/webdev/webdesk-approved-command": ["fileWebdeskCommandApproval"],
        // main() wires the editorial signer exactly as main.ts does at boot (a CLI is its own process); the
        // signer only signs what the content service sends, so it adds no command.
        "../modules/webdev/webdesk-editorial-signer": ["wireWebdeskEditorialSigner"],
        "../modules/webdev/webdesk-content.service": [
          "WebdeskProblem", "authorizeContent", "controlApplySchema", "problemSlug", "resolveEditableSite", "webdeskContent", "ContentGate", "SiteRef",
        ],
      };
      expect(imports.length).toBeGreaterThan(5);
      for (const imp of imports) {
        expect(Object.keys(allowed), `unexpected module ${imp.from}`).toContain(imp.from);
        for (const n of imp.names) expect(allowed[imp.from], `${n} from ${imp.from}`).toContain(n);
      }
      // and not a single imported name is one that could publish, unpublish, delete or decide
      const all = imports.flatMap((i) => i.names);
      expect(all.filter((n) => /^(publish|unpublish|schedule|deleteItem|restoreVersion|decide|approve|execute\w*|runApproved\w*)$/i.test(n))).toEqual([]);
      // no namespace/default/require import can smuggle one in
      expect(code).not.toMatch(/import\s+\*\s+as/);
      expect(code).not.toMatch(/require\(/);
      expect(code).not.toMatch(/import\(/);
    });

    it("never calls a publish, unpublish, schedule, delete or restore function, or names those commands", () => {
      expect(code).not.toMatch(/\.(publish|unpublish|schedule|deleteItem|restoreVersion|decide)\s*\(/);
      expect(code).not.toMatch(/content\.(unpublish|delete|schedule|restoreVersion)/);
      // the only publish words left in code are the command name the approval is FILED under, and the
      // lookup of an already-pending one
      const rest = code.replace(/workflow_id = 'content.publish'/g, "").replace(/command: "content.publish"/g, "");
      expect(rest).not.toMatch(/content.publish/);

      expect(code).toMatch(/fileWebdeskCommandApproval\(/);
    });
  });

  // ── the mirror of WebDesk's assembly, pinned against WebDesk's own functions ──────────────────
  describe("parity · assembledContent/contentHashOf equal WebDesk's assembleItemContent/contentHash", () => {
    it.skipIf(!REAL_BUNDLE)("on every item of the real bundle (skipped when the webdesk sources are not shipped)", async () => {
      const mod = join(__dirname, "..", "..", "..", "webdesk", "api", "src", "control", "content", "content-projection.ts");
      let wd: { assembleItemContent: Function; contentHash: Function } | null = null;
      try {
        wd = await import(/* @vite-ignore */ mod);
      } catch (err) {
        if (process.env.WSK67_REQUIRE_PARITY) throw err; // the gate ships webdesk/ and demands the comparison
        console.log(`parity: webdesk sources not importable here (${(err as Error).message.slice(0, 120)}); skipped`);
      }
      if (!wd) return;
      const bundle = loadBundle(REAL_BUNDLE);
      let checked = 0;
      for (const i of bundle.items) {
        const comp = bundle.compositions[i.collectionKey];
        const theirs = wd.assembleItemContent(i.collectionKey, comp, { fields: i.fields, blocks: i.blocks, seo: i.seo }) as { blocks: unknown; seo: unknown; issues: unknown[] };
        const mine = assembledContent(i, comp);
        expect(canonicalize(mine), `${i.collectionKey}/${i.locale}/${i.slug}`).toBe(canonicalize({ blocks: theirs.blocks, seo: theirs.seo }));
        expect(contentHashOf(mine.blocks, mine.seo)).toBe(wd.contentHash(theirs.blocks, theirs.seo));
        checked++;
      }
      expect(checked).toBe(bundle.items.length);
      console.log(`parity: ${checked} items, assembly and content hash identical to WebDesk's own functions`);
    });
  });
});
