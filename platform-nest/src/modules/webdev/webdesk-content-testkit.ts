// WSK-59 test kit — an in-process stand-in for the WebDesk control plane (Zone B), shaped like WSK-41/51's
// REAL answers (webdesk/api/src/control/content/*), plus the editorial-signer double. Not a test file.
//
// The fake is deliberately STRICT where Zone B is: it decodes the editorial assertion the BFF attached and
// refuses (403 `editorial-assertion-command-mismatch`) when `cmd`, `ten`, `site` or `cmh` do not match the
// request as received, or when an `apr` claim rides a MEDIUM command (WSK-40's rule). A BFF that signs the
// wrong thing fails here exactly as it would against the real thing.
import { createHash, randomUUID } from "node:crypto";
import {
  WebdeskControlTransportError,
  type WebdeskControlClient,
  type WebdeskControlRequest,
  type WebdeskControlResponse,
} from "./webdesk-control-client";
import type { EditorialAssertionRequest, EditorialAssertionSigner } from "./webdesk-approved-command";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "./webdesk-ws4-assertion";

export const GAIADA_SLUG = "gaiada";
export const GAIADA_SITE = "0b6f1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4";
export const OTHER_SLUG = "othertenant";
export const OTHER_SITE = "5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e";

const b64 = (v: unknown): string => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** A signer double: records every call and returns a compact JWS-shaped string the fake can decode. */
export function makeTestSigner(): EditorialAssertionSigner & { calls: EditorialAssertionRequest[]; configured: boolean } {
  const signer = {
    configured: true,
    calls: [] as EditorialAssertionRequest[],
    sign(input: EditorialAssertionRequest): string {
      signer.calls.push(input);
      return `${b64({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: "test" })}.${b64(input)}.${b64("sig")}`;
    },
  };
  return signer;
}

export interface FakeItem {
  itemId: string;
  siteId: string;
  collectionKey: string;
  locale: string;
  slug: string;
  headVersion: number;
  publishedVersion: number | null;
  publishState: "draft" | "published" | "unpublished";
  deletedAt: string | null;
  versions: Array<{ version: number; fields: unknown; contentHash: string; createdBy: string; createdAt: string; note: string | null }>;
}

export interface FakeCall {
  command: string;
  method: string;
  path: string;
  params: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
  idempotencyKey?: string;
  editorialAssertion?: string;
  hadWs4: boolean;
}

const WRITES = new Set(["content.create", "content.update", "content.restoreVersion", "content.unpublish", "content.delete", "schema.apply", "site.provision"]);
const EDITORIAL = new Set(["content.create", "content.update", "content.restoreVersion", "content.unpublish", "content.delete"]);

export function problem(status: number, slug: string, extra: Record<string, unknown> = {}): WebdeskControlResponse {
  const json = { type: `https://webdesk.gaiada.online/errors/${slug}`, title: slug, status, ...extra };
  return { status, contentType: "application/problem+json", json, bodyText: JSON.stringify(json) };
}
const ok = (json: unknown, status = 200): WebdeskControlResponse => ({
  status,
  contentType: "application/json",
  json,
  bodyText: JSON.stringify(json),
});

const hashOf = (fields: unknown): string => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

export class FakeZoneB {
  readonly calls: FakeCall[] = [];
  readonly items = new Map<string, FakeItem>();
  /** companyRef → tenant entry; `tenant.list` filters on it, as the real SQL does. */
  readonly tenants: Array<{ companyRef: string; slug: string; status: string; siteId: string }> = [];
  /** Throw this from the NEXT `send` (a breaker-open, a transport failure, ...). Persistent until cleared. */
  failWith: Error | null = null;
  /** Respond to the NEXT write with this instead of applying it. */
  nextWriteResponse: WebdeskControlResponse | null = null;
  /** The NEXT write is applied, then the link "dies" (an ambiguous failure). */
  dropAfterApply = false;
  /** The NEXT write dies before it is applied (a provable non-delivery that the client could not resend). */
  dropBeforeApply = false;

  constructor(readonly companyA: string, readonly companyB: string) {
    this.tenants.push({ companyRef: companyA, slug: GAIADA_SLUG, status: "active", siteId: GAIADA_SITE });
    this.tenants.push({ companyRef: companyB, slug: OTHER_SLUG, status: "active", siteId: OTHER_SITE });
  }

  get writes(): FakeCall[] {
    return this.calls.filter((c) => WRITES.has(c.command));
  }
  reset(): void {
    this.calls.length = 0;
    this.items.clear();
    this.failWith = null;
    this.nextWriteResponse = null;
    this.dropAfterApply = false;
    this.dropBeforeApply = false;
  }

  seedItem(p: Partial<FakeItem> & { siteId: string; slug: string }): FakeItem {
    const fields = { h1: p.slug };
    const item: FakeItem = {
      itemId: randomUUID(),
      collectionKey: "service",
      locale: "en",
      headVersion: 1,
      publishedVersion: null,
      publishState: "draft",
      deletedAt: null,
      versions: [{ version: 1, fields, contentHash: hashOf(fields), createdBy: "seed", createdAt: new Date().toISOString(), note: null }],
      ...p,
    };
    this.items.set(item.itemId, item);
    return item;
  }

  asClient(): WebdeskControlClient {
    return { send: (req: WebdeskControlRequest) => this.send(req), close: () => undefined } as unknown as WebdeskControlClient;
  }

  private itemJson(i: FakeItem) {
    return {
      itemId: i.itemId,
      collectionKey: i.collectionKey,
      locale: i.locale,
      slug: i.slug,
      localizationGroupId: i.itemId,
      headVersion: i.headVersion,
      publishedVersion: i.publishedVersion,
      publishState: i.publishState,
      publishAt: null,
      unpublishAt: null,
      deletedAt: i.deletedAt,
      updatedAt: new Date().toISOString(),
      title: i.slug,
      pendingChanges: i.headVersion > (i.publishedVersion ?? 0),
      headCreatedAt: i.versions[i.headVersion - 1].createdAt,
      headCreatedBy: i.versions[i.headVersion - 1].createdBy,
    };
  }

  private versionJson(i: FakeItem, n: number) {
    const v = i.versions[n - 1];
    return { n, version: n, contentHash: v.contentHash, createdAt: v.createdAt, createdBy: v.createdBy, attribution: {}, note: v.note, blocks: [{ type: "fields", props: v.fields }], seo: {} };
  }

  /** Zone B's editorial check, restated: the assertion must bind THIS request. */
  private verifyEditorial(req: WebdeskControlRequest): WebdeskControlResponse | { sub: string } {
    if (!req.editorialAssertion) return problem(401, "editorial-assertion-missing");
    const claims = JSON.parse(Buffer.from(req.editorialAssertion.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    const cmh = computeCommandHash(req.command, commandArgsAsZoneBSeesThem(req.params ?? {}, req.body));
    if (claims.cmd !== req.command || claims.cmh !== cmh) return problem(403, "editorial-assertion-command-mismatch");
    if (claims.ten !== req.params?.tenantSlug || claims.site !== req.params?.siteId) return problem(403, "editorial-assertion-scope-mismatch");
    if (claims.apr !== undefined) return problem(403, "editorial-assertion-command-mismatch", { detail: "apr on a MEDIUM command" });
    return { sub: String(claims.sub) };
  }

  async send(req: WebdeskControlRequest): Promise<WebdeskControlResponse> {
    this.calls.push({
      command: req.command, method: req.method, path: req.path, params: { ...(req.params ?? {}) },
      query: req.query, body: req.body, idempotencyKey: req.idempotencyKey, editorialAssertion: req.editorialAssertion, hadWs4: !!req.ws4,
    });
    if (this.failWith) throw this.failWith;
    const p = req.params ?? {};

    if (req.command === "tenant.list") {
      const rows = this.tenants.filter((t) => t.companyRef === req.query?.companyRef);
      return ok({
        tenants: rows.map((t) => ({
          slug: t.slug, status: t.status, defaultLocale: "en", locales: ["en", "id"],
          sites: [{ siteId: t.siteId, name: "Main", kind: "astro", environments: [{ envId: randomUUID(), name: "staging", domain: null, status: "active" }] }],
        })),
      });
    }
    // Zone B resolves tenant+site itself; an unknown pair is a typed 404.
    if (p.tenantSlug !== undefined && !this.tenants.some((t) => t.slug === p.tenantSlug && t.siteId === p.siteId)) {
      if (req.command !== "site.provision") return problem(404, "site-not-found");
    }

    switch (req.command) {
      case "collection.list":
        return ok({ collections: [{ key: "service", composition: { ui: { label: "Service pages" } }, vocabularyVersion: "1.1.0", counts: { items: this.items.size, byLocale: {}, live: 0, pendingChanges: 0 }, updatedAt: new Date().toISOString() }] });
      case "collection.get":
        return p.key === "service" ? ok({ key: "service", composition: {}, vocabularyVersion: "1.1.0", updatedAt: new Date().toISOString() }) : problem(404, "collection-not-found");
      case "item.list": {
        const q = req.query ?? {};
        const rows = [...this.items.values()].filter(
          (i) => i.siteId === p.siteId && i.collectionKey === p.key && !i.deletedAt && (!q.locale || i.locale === q.locale) && (!q.q || i.slug.includes(q.q)),
        );
        return ok({ items: rows.map((i) => this.itemJson(i)), page: { cursor: null, hasMore: false, limit: Number(q.limit ?? 50) } });
      }
      case "item.get": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        const sel = req.query?.version;
        const n = sel === undefined || sel === "head" ? i.headVersion : sel === "live" ? i.publishedVersion : Number(sel);
        if (!n || !i.versions[n - 1]) return problem(404, "version-not-found");
        return ok({
          item: this.itemJson(i), version: this.versionJson(i, n),
          live: i.publishedVersion ? this.versionJson(i, i.publishedVersion) : null,
          group: [{ locale: i.locale, itemId: i.itemId, slug: i.slug, headVersion: i.headVersion, publishedVersion: i.publishedVersion, publishState: i.publishState }],
          lint: { placeholders: { unresolvedTokens: [], markers: {} } },
        });
      }
      case "item.versions": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        return ok({ versions: i.versions.map((_, k) => ({ version: i.versions.length - k })), page: { cursor: null, hasMore: false, limit: 50 } });
      }
      case "item.versionGet": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        return i.versions[Number(p.n) - 1] ? ok(this.versionJson(i, Number(p.n))) : problem(404, "version-not-found");
      }
      case "media.list":
        return ok({ assets: [{ assetId: randomUUID(), bucketKey: "a/b.png", mime: "image/png", sizeBytes: 12, scanStatus: "clean", createdAt: new Date().toISOString() }], page: { cursor: null, hasMore: false, limit: 50 } });
      default:
        break;
    }

    // ── writes ──────────────────────────────────────────────────────────────────────────────────
    if (!WRITES.has(req.command)) return problem(400, "invalid-request", { detail: `unknown command ${req.command}` });
    if (!req.idempotencyKey) return problem(400, "invalid-request", { detail: "Idempotency-Key required" });
    let sub = "";
    if (EDITORIAL.has(req.command)) {
      const v = this.verifyEditorial(req);
      if ("status" in v) return v;
      sub = v.sub;
    }
    if (this.nextWriteResponse) {
      const r = this.nextWriteResponse;
      this.nextWriteResponse = null;
      return r;
    }
    if (this.dropBeforeApply) {
      this.dropBeforeApply = false;
      throw new WebdeskControlTransportError("link died before the request was written", 1, true, "ECONNRESET");
    }
    const result = this.apply(req, sub);
    if (this.dropAfterApply) {
      this.dropAfterApply = false;
      throw new WebdeskControlTransportError("link died after the request was written", 1, true, "ECONNRESET");
    }
    return result;
  }

  private apply(req: WebdeskControlRequest, sub: string): WebdeskControlResponse {
    const p = req.params ?? {};
    const b = (req.body ?? {}) as Record<string, any>;
    const now = new Date().toISOString();
    switch (req.command) {
      case "content.create": {
        const dup = [...this.items.values()].find((i) => i.siteId === p.siteId && i.collectionKey === b.collectionKey && i.locale === b.locale && i.slug === b.slug);
        if (dup) return problem(409, "slug-taken");
        if (b.fields && b.fields.h1 === 42) return problem(422, "composition-violation", { issues: [{ path: "/blocks/0/props/h1", message: "must be a string", expected: "text" }] });
        const item = this.seedItem({ siteId: p.siteId, slug: b.slug, locale: b.locale, collectionKey: b.collectionKey });
        item.versions[0] = { version: 1, fields: b.fields ?? {}, contentHash: hashOf(b.fields ?? {}), createdBy: sub, createdAt: now, note: b.note ?? null };
        return ok({ item: this.itemJson(item), version: { version: 1, contentHash: item.versions[0].contentHash, createdAt: now }, unchanged: false, lint: {}, replayed: false }, 201);
      }
      case "content.update": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (b.baseVersion !== i.headVersion) return problem(409, "version-conflict", { currentHeadVersion: i.headVersion, currentContentHash: i.versions[i.headVersion - 1].contentHash, updatedAt: now });
        const fields = b.fields ?? {};
        i.headVersion += 1;
        i.versions.push({ version: i.headVersion, fields, contentHash: hashOf(fields), createdBy: sub, createdAt: now, note: b.note ?? null });
        return ok({ item: this.itemJson(i), version: { version: i.headVersion, contentHash: hashOf(fields), createdAt: now }, unchanged: false, lint: {}, replayed: false });
      }
      case "content.restoreVersion": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (b.baseVersion !== i.headVersion) return problem(409, "version-conflict", { currentHeadVersion: i.headVersion });
        const src = i.versions[b.version - 1];
        if (!src) return problem(409, "version-not-found");
        i.headVersion += 1;
        i.versions.push({ ...src, version: i.headVersion, createdBy: sub, createdAt: now });
        return ok({ item: this.itemJson(i), version: { version: i.headVersion, contentHash: src.contentHash, createdAt: now }, unchanged: false, lint: {}, replayed: false });
      }
      case "content.unpublish": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (i.publishedVersion === null) return problem(409, "not-live");
        if (i.publishedVersion !== b.expectedPublishedVersion) return problem(409, "published-version-changed");
        i.publishedVersion = null;
        i.publishState = "unpublished";
        return ok({ item: this.itemJson(i), replayed: false });
      }
      case "content.delete": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (i.publishedVersion !== null) return problem(409, "item-is-live");
        i.deletedAt = now;
        return ok({ item: this.itemJson(i), replayed: false });
      }
      case "schema.apply":
        return ok({ collectionKey: p.collectionKey, bump: "minor", reasons: [], persisted: true, replayed: false }, 201);
      case "site.provision":
        return ok({ site: { id: randomUUID(), kind: b.kind, name: b.name, created_at: now }, replayed: false }, 201);
      default:
        return problem(400, "invalid-request");
    }
  }
}
