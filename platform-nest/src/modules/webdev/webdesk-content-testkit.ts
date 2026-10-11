// WSK-59 test kit — an in-process stand-in for the WebDesk control plane (Zone B), shaped like WSK-41/51's
// REAL answers (webdesk/api/src/control/content/*), plus the editorial-signer double. Not a test file.
//
// The fake is deliberately STRICT where Zone B is: it decodes the editorial assertion the BFF attached and
// refuses (403 `editorial-assertion-command-mismatch`) when `cmd`, `ten`, `site` or `cmh` do not match the
// request as received, or when an `apr` claim rides a MEDIUM command (WSK-40's rule). A BFF that signs the
// wrong thing fails here exactly as it would against the real thing.
//
// WSK-44b: the READ shapes were re-diffed against webdesk/api/src/control/{content/content-reads.service.ts,
// content/content-commands.service.ts,tenants/tenant-reads.service.ts} and brought up to the real ones where the
// first cut was thinner: the versions list rows carry the full row, an environment may have `domain: null`, a
// pre-0009 item (`headVersion: 0`, no version row) has `headCreatedAt/headCreatedBy: null`, write results' `lint`
// is `{placeholders:{unresolvedTokens,markers}}`, and a collection's composition can be set per test. The UI
// contract test (webdesk-content-ui-contract.test.ts) is only as good as these shapes.
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
/** Each fake site's two environments. Stable, so a caller can name one (key.mint takes an `envId`). */
export const GAIADA_ENV = { production: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", staging: "2b3c4d5e-6f70-4b8c-9d0e-1f2a3b4c5d6e" } as const;
export const OTHER_ENV = { production: "3c4d5e6f-7081-4c9d-8e0f-2a3b4c5d6e7f", staging: "4d5e6f70-8192-4dae-9f10-3b4c5d6e7f80" } as const;

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

const WRITES = new Set(["content.publish", "content.create", "content.update", "content.restoreVersion", "content.unpublish", "content.delete", "schema.apply", "site.provision", "key.mint", "media.uploadToken", "media.update", "media.delete"]);
const EDITORIAL = new Set(["content.create", "content.update", "content.restoreVersion", "content.unpublish", "content.delete", "media.uploadToken", "media.update", "media.delete"]);

/** WSK-43b: one library asset as the fake holds it (the real row is `media_assets`, migration 0014). */
export interface FakeMediaAsset {
  assetId: string;
  siteId: string;
  title: string | null;
  alt: Record<string, string>;
  tags: string[];
  mime: string;
  sizeBytes: number;
  originalFilename: string;
  createdAt: string;
  deletedAt: string | null;
  /** The items that use the asset (`media.usage` and the 409 `media-in-use` body list them). */
  usedBy: Array<{ itemId: string; collectionKey: string; locale: string; slug: string; in: string }>;
}

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

const NO_LINT = { placeholders: { unresolvedTokens: [] as string[], markers: {} as Record<string, number> } };
const hashOf = (fields: unknown): string => createHash("sha256").update(JSON.stringify(fields)).digest("hex");

export class FakeZoneB {
  readonly calls: FakeCall[] = [];
  readonly items = new Map<string, FakeItem>();
  /** collectionKey → the composition `collection.list` returns (default: `{ui:{label}}`). */
  readonly compositions = new Map<string, unknown>();
  /** companyRef → tenant entry; `tenant.list` filters on it, as the real SQL does. */
  /** `env`: the site's two environment ids. Optional so a test can push a bare tenant; one is assigned (once,
   *  then stable) the first time the tenant is listed or a key is minted for it. */
  readonly tenants: Array<{ companyRef: string; slug: string; status: string; siteId: string; env?: { production: string; staging: string } }> = [];
  /** Every plaintext `key.mint` returned, in order (so a test can scan storage and logs for it). */
  readonly mintedKeys: string[] = [];
  /** WSK-43b: the media library, by asset id. While it is EMPTY `media.list` answers the legacy one-row fixture. */
  readonly media = new Map<string, FakeMediaAsset>();
  /** WSK-43b: every plaintext upload token `media.uploadToken` returned, in order (so a test can scan storage and logs for it). */
  readonly mintedUploadTokens: string[] = [];
  private readonly mintKeys = new Set<string>();
  /** Throw this from the NEXT `send` (a breaker-open, a transport failure, ...). Persistent until cleared. */
  failWith: Error | null = null;
  /** Respond to the NEXT write with this instead of applying it. */
  nextWriteResponse: WebdeskControlResponse | null = null;
  /** The NEXT write is applied, then the link "dies" (an ambiguous failure). */
  dropAfterApply = false;
  /** The NEXT write dies before it is applied (a provable non-delivery that the client could not resend). */
  dropBeforeApply = false;

  constructor(readonly companyA: string, readonly companyB: string) {
    this.tenants.push({ companyRef: companyA, slug: GAIADA_SLUG, status: "active", siteId: GAIADA_SITE, env: GAIADA_ENV });
    this.tenants.push({ companyRef: companyB, slug: OTHER_SLUG, status: "active", siteId: OTHER_SITE, env: OTHER_ENV });
  }

  private envOf(t: FakeZoneB["tenants"][number]): { production: string; staging: string } {
    t.env ??= { production: randomUUID(), staging: randomUUID() };
    return t.env;
  }

  get writes(): FakeCall[] {
    return this.calls.filter((c) => WRITES.has(c.command));
  }
  reset(): void {
    this.calls.length = 0;
    this.mintedKeys.length = 0;
    this.mintedUploadTokens.length = 0;
    this.mintKeys.clear();
    this.media.clear();
    this.items.clear();
    this.failWith = null;
    this.nextWriteResponse = null;
    this.dropAfterApply = false;
    this.dropBeforeApply = false;
  }

  /** A PRE-0009 row: content lives only in the projection, `head_version` is 0 and there is no version row. */
  seedPreVersioned(p: Partial<FakeItem> & { siteId: string; slug: string }): FakeItem {
    const item = this.seedItem(p);
    item.headVersion = 0;
    item.versions = [];
    return item;
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

  seedMedia(p: Partial<FakeMediaAsset> & { siteId: string }): FakeMediaAsset {
    const a: FakeMediaAsset = {
      assetId: randomUUID(), title: null, alt: {}, tags: [], mime: "image/png", sizeBytes: 1234, originalFilename: "hero.png",
      createdAt: new Date().toISOString(), deletedAt: null, usedBy: [], ...p,
    };
    this.media.set(a.assetId, a);
    return a;
  }

  private assetJson(a: FakeMediaAsset) {
    return {
      assetId: a.assetId, bucketKey: `media/${a.assetId}`, mime: a.mime, sizeBytes: a.sizeBytes, scanStatus: "clean", createdAt: a.createdAt,
      title: a.title, alt: a.alt, tags: a.tags, originalFilename: a.originalFilename, width: 640, height: 480, createdBy: null,
      url: `/v1/t/gaiada/media/${a.assetId}`, updatedAt: a.createdAt, deletedAt: a.deletedAt,
    };
  }

  asClient(): WebdeskControlClient {
    return { send: (req: WebdeskControlRequest) => this.send(req), close: () => undefined } as unknown as WebdeskControlClient;
  }

  private itemJson(i: FakeItem) {
    const headRow = i.headVersion > 0 ? i.versions[i.headVersion - 1] : undefined;
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
      headCreatedAt: headRow ? headRow.createdAt : null,
      headCreatedBy: headRow ? headRow.createdBy : null,
    };
  }

  /** A write result's `item` is the write plane's ItemState: the editor extras (title, pendingChanges, headCreated*) are item.get/list only. */
  private stateJson(i: FakeItem) {
    const { title: _t, pendingChanges: _p, headCreatedAt: _a, headCreatedBy: _b, ...state } = this.itemJson(i);
    void [_t, _p, _a, _b];
    return state;
  }

  /** `item.get`'s `version` for a pre-0009 row: version 0, the projection's own content. */
  private projectionJson(i: FakeItem) {
    return { n: 0, version: 0, contentHash: hashOf({ h1: i.slug }), createdAt: new Date().toISOString(), createdBy: null, attribution: {}, note: null, blocks: [{ type: "fields", props: { h1: i.slug } }], seo: {} };
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
          sites: [{
            siteId: t.siteId, name: "Main", kind: "astro",
            // `environments.domain` is nullable in WebDesk (a site with no hostname yet): one of each.
            environments: [
              { envId: this.envOf(t).production, name: "production", domain: null, status: "pending" },
              { envId: this.envOf(t).staging, name: "staging", domain: "staging.gaiada.test", status: "active" },
            ],
          }],
        })),
      });
    }
    // Zone B resolves tenant+site itself; an unknown pair is a typed 404.
    // (key.mint is tenant-scoped, like Zone B's keys controller: no siteId in its path.)
    if (p.tenantSlug !== undefined && !this.tenants.some((t) => t.slug === p.tenantSlug && t.siteId === p.siteId)) {
      if (req.command !== "site.provision" && req.command !== "key.mint") return problem(404, "site-not-found");
    }

    switch (req.command) {
      case "collection.list": {
        const keys = [...new Set(["service", ...this.compositions.keys()])];
        return ok({
          collections: keys.map((key) => {
            const its = [...this.items.values()].filter((i) => i.siteId === p.siteId && i.collectionKey === key && !i.deletedAt);
            const byLocale: Record<string, number> = {};
            for (const i of its) byLocale[i.locale] = (byLocale[i.locale] ?? 0) + 1;
            return {
              key,
              composition: this.compositions.get(key) ?? { ui: { label: "Service pages" } },
              vocabularyVersion: "1.1.0",
              counts: { items: its.length, byLocale, live: its.filter((i) => i.publishedVersion !== null).length, pendingChanges: its.filter((i) => i.headVersion > (i.publishedVersion ?? 0)).length },
              updatedAt: new Date().toISOString(),
            };
          }),
        });
      }
      case "collection.get":
        return p.key === "service" || this.compositions.has(p.key)
          ? ok({ key: p.key, composition: this.compositions.get(p.key) ?? {}, vocabularyVersion: "1.1.0", updatedAt: new Date().toISOString() })
          : problem(404, "collection-not-found");
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
        if (i.headVersion === 0 && (sel === undefined || sel === "head")) {
          return ok({ item: this.itemJson(i), version: this.projectionJson(i), live: null, group: [{ locale: i.locale, itemId: i.itemId, slug: i.slug, headVersion: 0, publishedVersion: i.publishedVersion, publishState: i.publishState }], lint: { placeholders: { unresolvedTokens: [], markers: {} } } });
        }
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
        return ok({
          versions: i.versions.map((_, k) => {
            const v = i.versions[i.versions.length - 1 - k];
            const n = i.versions.length - k;
            return { version: n, contentHash: v.contentHash, createdAt: v.createdAt, createdBy: v.createdBy, attribution: {}, note: v.note };
          }),
          page: { cursor: null, hasMore: false, limit: 50 },
        });
      }
      case "item.versionGet": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        return i.versions[Number(p.n) - 1] ? ok(this.versionJson(i, Number(p.n))) : problem(404, "version-not-found");
      }
      case "media.list": {
        if (this.media.size === 0) {
          return ok({ assets: [{ assetId: randomUUID(), bucketKey: "a/b.png", mime: "image/png", sizeBytes: 12, scanStatus: "clean", createdAt: new Date().toISOString() }], page: { cursor: null, hasMore: false, limit: 50 } });
        }
        const q = req.query ?? {};
        const needle = q.q?.toLowerCase();
        const rows = [...this.media.values()].filter(
          (a) =>
            a.siteId === p.siteId &&
            (q.includeDeleted === "true" || !a.deletedAt) &&
            (!q.tag || a.tags.includes(q.tag)) &&
            (!q.mime || (q.mime.endsWith("/*") ? a.mime.startsWith(q.mime.slice(0, -1)) : a.mime === q.mime)) &&
            (!needle || (a.title ?? "").toLowerCase().includes(needle) || a.originalFilename.toLowerCase().includes(needle) || a.tags.some((t) => t.includes(needle))),
        );
        return ok({ assets: rows.map((a) => this.assetJson(a)), page: { cursor: null, hasMore: false, limit: Number(q.limit ?? 50) } });
      }
      case "media.usage": {
        const a = this.media.get(p.assetId);
        if (!a || a.siteId !== p.siteId) return problem(404, "media-asset-not-found");
        return ok({ assetId: a.assetId, url: `/v1/t/gaiada/media/${a.assetId}`, total: a.usedBy.length, items: a.usedBy });
      }
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
        return ok({ item: this.stateJson(item), version: { version: 1, contentHash: item.versions[0].contentHash, createdAt: now }, unchanged: false, lint: NO_LINT, replayed: false }, 201);
      }
      case "content.update": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (b.baseVersion !== i.headVersion) return problem(409, "version-conflict", { currentHeadVersion: i.headVersion, currentContentHash: i.versions[i.headVersion - 1].contentHash, updatedAt: now });
        const fields = b.fields ?? {};
        i.headVersion += 1;
        i.versions.push({ version: i.headVersion, fields, contentHash: hashOf(fields), createdBy: sub, createdAt: now, note: b.note ?? null });
        return ok({ item: this.stateJson(i), version: { version: i.headVersion, contentHash: hashOf(fields), createdAt: now }, unchanged: false, lint: NO_LINT, replayed: false });
      }
      case "content.restoreVersion": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (b.baseVersion !== i.headVersion) return problem(409, "version-conflict", { currentHeadVersion: i.headVersion });
        const src = i.versions[b.version - 1];
        if (!src) return problem(409, "version-not-found");
        i.headVersion += 1;
        i.versions.push({ ...src, version: i.headVersion, createdBy: sub, createdAt: now });
        return ok({ item: this.stateJson(i), version: { version: i.headVersion, contentHash: src.contentHash, createdAt: now }, unchanged: false, lint: NO_LINT, replayed: false });
      }
      case "content.unpublish": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (i.publishedVersion === null) return problem(409, "not-live");
        if (i.publishedVersion !== b.expectedPublishedVersion) return problem(409, "published-version-changed");
        i.publishedVersion = null;
        i.publishState = "unpublished";
        return ok({ item: this.stateJson(i), replayed: false });
      }
      case "content.delete": {
        const i = this.items.get(p.itemId);
        if (!i || i.siteId !== p.siteId) return problem(404, "item-not-found");
        if (i.publishedVersion !== null) return problem(409, "item-is-live");
        i.deletedAt = now;
        return ok({ item: this.stateJson(i), replayed: false });
      }
      case "key.mint": {
        // WebDesk keys-command.service#mint: the env must be one of THIS tenant's (else 404), and the plaintext
        // appears once, in this response; only its hash is stored there.
        const t = this.tenants.find((x) => x.slug === p.tenantSlug);
        if (!t) return problem(404, "tenant-not-found");
        const env = this.envOf(t);
        if (b.envId !== env.production && b.envId !== env.staging) return problem(404, "not-found", { detail: "environment not found for this tenant" });
        const key = `wdsk_${randomBytes(24).toString("base64url")}`;
        this.mintedKeys.push(key);
        return ok({ id: randomUUID(), key, scope: b.scope, envId: b.envId, tenantId: randomUUID(), createdAt: now, replayed: false }, 201);
      }
      case "content.publish": {
        // WSK-66's in-band publish (WS4 + editorial `apr`); the fake only needs to flip the state.
        const published = (b.items as Array<{ itemId: string; version: number }>).map(({ itemId, version }) => {
          const i = this.items.get(itemId)!;
          i.publishedVersion = version;
          i.publishState = "published";
          return { itemId, collectionKey: i.collectionKey, locale: i.locale, slug: i.slug, version, publishedAt: now };
        });
        return ok({ published, replayed: false });
      }
      case "media.uploadToken": {
        // WebDesk media-commands.service#mintUploadToken: the token (and the uploadPath that embeds it) is returned ONCE and
        // withheld from the idempotency record, so a replay under the same key is a 409.
        if (b.bucket !== "media" && b.bucket !== "video") return problem(400, "invalid-request", { detail: "bucket must be one of media, video" });
        if (this.mintKeys.has(String(req.idempotencyKey))) return problem(409, "idempotency-response-withheld");
        this.mintKeys.add(String(req.idempotencyKey));
        const token = randomBytes(32).toString("base64url");
        this.mintedUploadTokens.push(token);
        const allowed = b.bucket === "media" ? ["image/png", "image/jpeg", "image/webp", "image/gif"] : ["video/mp4", "video/webm"];
        return ok({
          tokenId: randomUUID(), token, uploadPath: `/v1/t/${p.tenantSlug}/media/upload/${token}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(), bucket: b.bucket,
          maxBytes: Math.min(typeof b.maxBytes === "number" ? b.maxBytes : 10_485_760, 10_485_760),
          allowedMimes: Array.isArray(b.mime) ? b.mime : typeof b.mime === "string" ? [b.mime] : allowed, replayed: false,
        }, 201);
      }
      case "media.update": {
        const a = this.media.get(p.assetId);
        if (!a || a.siteId !== p.siteId) return problem(404, "media-asset-not-found");
        if (a.deletedAt) return problem(409, "media-asset-deleted");
        if ("title" in b) a.title = b.title;
        if ("alt" in b) a.alt = b.alt;
        if ("tags" in b) a.tags = b.tags;
        return ok({ asset: this.assetJson(a), replayed: false });
      }
      case "media.delete": {
        const a = this.media.get(p.assetId);
        if (!a || a.siteId !== p.siteId) return problem(404, "media-asset-not-found");
        if (a.deletedAt) return ok({ assetId: a.assetId, deletedAt: a.deletedAt, purgeAfter: a.deletedAt, alreadyDeleted: true, replayed: false });
        if (a.usedBy.length > 0) return problem(409, "media-in-use", { detail: "The asset is used by content.", total: a.usedBy.length, items: a.usedBy });
        a.deletedAt = now;
        return ok({ assetId: a.assetId, deletedAt: now, purgeAfter: new Date(Date.now() + 86_400_000).toISOString(), alreadyDeleted: false, replayed: false });
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
