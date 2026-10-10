// WSK-41 — the pure write-plane helpers (content-projection / search-text / content-lint) and the
// durable idempotency store (pg-idempotency-store.ts) against the real 0009 table, including its
// dual-mode RLS: tenant rows under tenant_ctx, platform rows under platform_ctx, and the expiry
// sweep that has to walk both.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { asPlatform, asTenant, createContentFixture, type ContentFixture } from "./content-test-kit";
import { DbService } from "../src/db/db.service";
import { PgIdempotencyStore } from "../src/control/idempotency/pg-idempotency-store";
import { ControlProblem } from "../src/control/content/content-problem";
import {
  assembleItemContent,
  contentHash,
  fieldsCarrierFor,
  sizeViolation,
  slugIssue,
  MAX_MARKDOWN_BYTES,
} from "../src/control/content/content-projection";
import { extractSearchText, SEARCH_TEXT_MAX_BYTES, truncateUtf8 } from "../src/control/content/search-text";
import { lintPlaceholders } from "../src/control/content/content-lint";
import type { CollectionComposition } from "../src/delivery/vocabulary/composition";

describe("content-projection", () => {
  it("fieldsCarrierFor: redirect is the one seo.redirect collection", () => {
    expect(fieldsCarrierFor("redirect")).toBe("seo.redirect");
    expect(fieldsCarrierFor("service")).toBe("block");
    expect(fieldsCarrierFor("redirects")).toBe("block");
  });

  it("contentHash is key-order independent, array-order dependent, and sensitive to every value", () => {
    const a = contentHash([{ type: "fields", props: { a: 1, b: "x" } }], { title: "t", description: "d" });
    const b = contentHash([{ props: { b: "x", a: 1 }, type: "fields" }], { description: "d", title: "t" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(contentHash([{ type: "fields", props: { a: 1, b: "y" } }], { title: "t", description: "d" })).not.toBe(a);
    expect(contentHash([1, 2], {})).not.toBe(contentHash([2, 1], {}));
  });

  it("assembleItemContent puts fields at blocks[0], refuses fields where none are declared, and routes redirect values to seo.redirect", () => {
    const comp: CollectionComposition = { fields: [{ name: "h1", primitive: "text" }], blocks: ["richText"] };
    const ok = assembleItemContent("service", comp, { fields: { h1: "x" }, blocks: [{ type: "richText", props: { content: "y" } }] });
    expect(ok.issues).toEqual([]);
    expect(ok.blocks).toEqual([{ type: "fields", props: { h1: "x" } }, { type: "richText", props: { content: "y" } }]);

    const noFields = assembleItemContent("post", { blocks: ["richText"] }, { fields: { h1: "x" } });
    expect(noFields.issues.map((i) => i.path)).toContain("/fields");

    const redirect = assembleItemContent("redirect", {}, { fields: { toPath: "/n", status: "302", active: "false" }, seo: { title: "t" } });
    expect(redirect.issues).toEqual([]);
    expect(redirect.blocks).toEqual([]);
    expect(redirect.seo).toEqual({ title: "t", redirect: { toPath: "/n", status: "302", active: "false" } });

    const reservedSeo = assembleItemContent("service", comp, { fields: { h1: "x" }, seo: { redirect: {} } });
    expect(reservedSeo.issues.map((i) => i.path)).toContain("/seo/redirect");
  });

  it("sizeViolation: 256 KiB per markdown value and 512 KiB per item", () => {
    const comp: CollectionComposition = { fields: [{ name: "body", primitive: "markdown" }] };
    expect(sizeViolation(comp, [{ type: "fields", props: { body: "x".repeat(MAX_MARKDOWN_BYTES) } }], {})).toBeNull();
    expect(sizeViolation(comp, [{ type: "fields", props: { body: "x".repeat(MAX_MARKDOWN_BYTES + 1) } }], {})).toMatch(/markdown/);
    expect(sizeViolation({}, [{ type: "richText", props: { content: "x".repeat(600 * 1024) } }], {})).toMatch(/limit is 524288/);
  });

  it("slugIssue: the item grammar, and the redirect path rule", () => {
    expect(slugIssue("service", "service.local-seo")).toBeNull();
    expect(slugIssue("service", "Service")).not.toBeNull();
    expect(slugIssue("service", "a..b")).not.toBeNull();
    expect(slugIssue("service", "a".repeat(201))).not.toBeNull();
    expect(slugIssue("redirect", "/old/path/")).toBeNull();
    expect(slugIssue("redirect", "old")).not.toBeNull();
  });
});

describe("search-text", () => {
  it("collects string leaves in order, skipping block type names", () => {
    expect(extractSearchText([{ type: "fields", props: { a: "Alpha", n: 2, list: ["Beta", { c: "Gamma" }] } }, { type: "richText", props: { content: "Delta" } }])).toBe(
      "Alpha Beta Gamma Delta",
    );
  });

  it("truncates to 64 KiB of UTF-8 without splitting a character", () => {
    const long = "é".repeat(SEARCH_TEXT_MAX_BYTES); // 2 bytes each
    const out = extractSearchText([{ type: "fields", props: { a: long } }]);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SEARCH_TEXT_MAX_BYTES);
    expect(out.endsWith("�")).toBe(false);
    expect(truncateUtf8("ab€", 4)).toBe("ab"); // € is 3 bytes: cutting at 4 would split it
    expect(truncateUtf8("abc", 10)).toBe("abc");
  });
});

describe("content-lint", () => {
  const rules = [
    { kind: "token" as const, open: "{{", close: "}}", registry: { collection: "token-registry", listField: "tokens", keyField: "key", valueField: "value" } },
    { kind: "marker" as const, open: "[CONFIRM:", close: "]", label: "CONFIRM" },
  ];
  it("reports unresolved tokens once each, in order, and counts markers", () => {
    const blocks = [{ type: "fields", props: { a: "{{X}} {{Y}} [CONFIRM: a]", b: ["{{X}}", "[CONFIRM: b]"] } }];
    expect(lintPlaceholders(rules, blocks, null)).toEqual({ placeholders: { unresolvedTokens: ["{{X}}", "{{Y}}"], markers: { CONFIRM: 2 } } });
    expect(lintPlaceholders(rules, blocks, new Map([["X", "1"], ["Y", null]]))).toEqual({
      placeholders: { unresolvedTokens: ["{{Y}}"], markers: { CONFIRM: 2 } },
    });
  });
  it("no rules -> an empty report; an unclosed delimiter is not a token", () => {
    expect(lintPlaceholders([], [{ type: "fields", props: { a: "{{X}}" } }], null)).toEqual({ placeholders: { unresolvedTokens: [], markers: {} } });
    expect(lintPlaceholders(rules, [{ type: "fields", props: { a: "{{never closed" } }], null).placeholders.unresolvedTokens).toEqual([]);
  });
});

describe("PgIdempotencyStore (real control_idempotency_keys, dual-mode RLS)", () => {
  let db: DbService;
  let store: PgIdempotencyStore;
  let a: ContentFixture;
  let b: ContentFixture;

  beforeAll(async () => {
    db = new DbService(process.env.APP_DATABASE_URL as string, 4);
    store = new PgIdempotencyStore(db);
    a = await createContentFixture("idem-a");
    b = await createContentFixture("idem-b");
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });

  it("fresh -> complete -> replay; a different request hash -> 409 idempotency-key-reused", async () => {
    const scopeKey = `t:${randomUUID()}`;
    const first = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "h1" });
    expect(first.kind).toBe("fresh");
    if (first.kind !== "fresh") return;
    await db.withTenant(a.tenantId, (d) => d.transaction((c) => store.complete(c, first.claim, { ok: 1 })));
    const again = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "h1" });
    expect(again).toEqual({ kind: "replay", response: { ok: 1 } });
    await expect(store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "h2" })).rejects.toMatchObject({
      slug: "idempotency-key-reused",
    });
  });

  it("a concurrent second caller waits for the first and replays its response (never runs twice)", async () => {
    const scopeKey = `t:${randomUUID()}`;
    const first = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.update", requestHash: "h" });
    if (first.kind !== "fresh") throw new Error("expected fresh");
    const waiting = store.begin({ tenantId: a.tenantId, scopeKey, command: "content.update", requestHash: "h" });
    await new Promise((r) => setTimeout(r, 200));
    await db.withTenant(a.tenantId, (d) => d.transaction((c) => store.complete(c, first.claim, { v: 2 })));
    expect(await waiting).toEqual({ kind: "replay", response: { v: 2 } });
  });

  it("release() frees the key for a retry; complete() on a superseded claim throws (fencing)", async () => {
    const scopeKey = `t:${randomUUID()}`;
    const first = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.update", requestHash: "h" });
    if (first.kind !== "fresh") throw new Error("expected fresh");
    await store.release(first.claim);
    const retry = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.update", requestHash: "h" });
    expect(retry.kind).toBe("fresh");
    await expect(db.withTenant(a.tenantId, (d) => d.transaction((c) => store.complete(c, first.claim, {})))).rejects.toBeInstanceOf(ControlProblem);
  });

  it("an expired row reads as absent; a stale in-flight claim is taken over", async () => {
    const scopeKey = `t:${randomUUID()}`;
    const first = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "old" });
    if (first.kind !== "fresh") throw new Error("expected fresh");
    await db.withTenant(a.tenantId, (d) => d.transaction((c) => store.complete(c, first.claim, { old: true })));
    await asTenant(a.tenantId, (c) =>
      c.query(`UPDATE control_idempotency_keys SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE scope_key = $1`, [scopeKey]),
    );
    // Expired: a DIFFERENT request hash is not a reuse conflict, it is a fresh claim.
    const fresh = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "new" });
    expect(fresh.kind).toBe("fresh");

    const staleKey = `t:${randomUUID()}`;
    await store.begin({ tenantId: a.tenantId, scopeKey: staleKey, command: "content.create", requestHash: "h" });
    await asTenant(a.tenantId, (c) =>
      c.query(`UPDATE control_idempotency_keys SET created_at = now() - interval '10 minutes' WHERE scope_key = $1`, [staleKey]),
    );
    const takeover = await store.begin({ tenantId: a.tenantId, scopeKey: staleKey, command: "content.create", requestHash: "h" });
    expect(takeover.kind).toBe("fresh");
  });

  it("tenant isolation: tenant B cannot see or collide with tenant A's key", async () => {
    const scopeKey = `shared:${randomUUID()}`;
    const ka = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.create", requestHash: "A" });
    const kb = await store.begin({ tenantId: b.tenantId, scopeKey, command: "content.create", requestHash: "B" });
    expect(ka.kind).toBe("fresh");
    expect(kb.kind).toBe("fresh"); // same scope key, different tenant: no conflict, no oracle
    const seenByB = await asTenant(b.tenantId, async (c) => (await c.query(`SELECT tenant_id FROM control_idempotency_keys WHERE scope_key = $1`, [scopeKey])).rows);
    expect(seenByB).toEqual([{ tenant_id: b.tenantId }]);
  });

  it("sweepExpired walks every tenant under its own context plus the platform rows, and deletes only expired rows", async () => {
    const keep = `keep:${randomUUID()}`;
    const goneA = `gone-a:${randomUUID()}`;
    const goneB = `gone-b:${randomUUID()}`;
    const gonePlatform = `gone-p:${randomUUID()}`;
    const keepPlatform = `keep-p:${randomUUID()}`;
    for (const [t, k] of [[a.tenantId, keep], [a.tenantId, goneA], [b.tenantId, goneB], [null, gonePlatform], [null, keepPlatform]] as const) {
      const r = await store.begin({ tenantId: t, scopeKey: k, command: "tenant.provision", requestHash: "h" });
      expect(r.kind).toBe("fresh");
    }
    const expire = `UPDATE control_idempotency_keys SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE scope_key = $1`;
    await asTenant(a.tenantId, (c) => c.query(expire, [goneA]));
    await asTenant(b.tenantId, (c) => c.query(expire, [goneB]));
    await asPlatform((c) => c.query(expire, [gonePlatform]));

    const swept = await store.sweepExpired();
    expect(swept.tenantsSwept).toBeGreaterThanOrEqual(2);
    expect(swept.tenantRows).toBeGreaterThanOrEqual(2);
    expect(swept.platformRows).toBeGreaterThanOrEqual(1);

    const leftA = await asTenant(a.tenantId, async (c) => (await c.query(`SELECT scope_key FROM control_idempotency_keys WHERE scope_key = ANY($1)`, [[keep, goneA]])).rows.map((r) => r.scope_key));
    const leftB = await asTenant(b.tenantId, async (c) => (await c.query(`SELECT scope_key FROM control_idempotency_keys WHERE scope_key = $1`, [goneB])).rows);
    const leftP = await asPlatform(async (c) =>
      (await c.query(`SELECT scope_key FROM control_idempotency_keys WHERE tenant_id IS NULL AND scope_key = ANY($1)`, [[gonePlatform, keepPlatform]])).rows.map((r) => r.scope_key),
    );
    expect(leftA).toEqual([keep]);
    expect(leftB).toEqual([]);
    expect(leftP).toEqual([keepPlatform]);
  });
});
