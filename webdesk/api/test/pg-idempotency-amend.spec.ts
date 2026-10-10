// M3 T5b — PgIdempotencyStore.amend(): overwrite the stored response of a COMPLETED record, inside the
// caller's transaction, fenced on the record still holding the expected reference. Used by the promotion
// saga (claim stores { promotionRunId }, the terminal transaction stores the final body). Real 0009
// table, dual-mode RLS.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asPlatform, asTenant, createContentFixture, type ContentFixture } from "./content-test-kit";
import { DbService } from "../src/db/db.service";
import { PgIdempotencyStore } from "../src/control/idempotency/pg-idempotency-store";

describe("PgIdempotencyStore.amend", () => {
  let db: DbService;
  let store: PgIdempotencyStore;
  let a: ContentFixture;
  let b: ContentFixture;

  beforeAll(async () => {
    db = new DbService(process.env.APP_DATABASE_URL as string, 4);
    store = new PgIdempotencyStore(db);
    a = await createContentFixture("amend-a");
    b = await createContentFixture("amend-b");
  });
  afterAll(async () => {
    await db.onModuleDestroy();
  });

  const inTenant = <T>(tenantId: string, fn: (c: PoolClient) => Promise<T>) => db.withTenant(tenantId, (d) => d.transaction(fn));
  const inPlatform = <T>(fn: (c: PoolClient) => Promise<T>) =>
    db.withPlatformCtx(async (c) => {
      await c.query("BEGIN");
      try {
        const r = await fn(c);
        await c.query("COMMIT");
        return r;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      }
    });

  /** A tenant record that is `completed` holding `response`. */
  async function completed(tenantId: string, response: unknown) {
    const scopeKey = `amend:${randomUUID()}`;
    const first = await store.begin({ tenantId, scopeKey, command: "content.promote", requestHash: "h" });
    if (first.kind !== "fresh") throw new Error("expected a fresh claim");
    await inTenant(tenantId, (c) => store.complete(c, first.claim, response));
    return scopeKey;
  }
  const stored = (tenantId: string, scopeKey: string) =>
    asTenant(tenantId, async (c) => (await c.query(`SELECT status, response FROM control_idempotency_keys WHERE tenant_id = $1 AND scope_key = $2`, [tenantId, scopeKey])).rows[0]);

  it("overwrites a completed record that still holds the expected reference; a replay then returns the new response", async () => {
    const scopeKey = await completed(a.tenantId, { promotionRunId: "run-1" });
    const wrote = await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey }, { promotionRunId: "run-1" }, { promotionRunId: "run-1", finalBody: "{}" }));
    expect(wrote).toBe(true);
    expect(await stored(a.tenantId, scopeKey)).toEqual({ status: "completed", response: { promotionRunId: "run-1", finalBody: "{}" } });
    expect(await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.promote", requestHash: "h" })).toEqual({
      kind: "replay",
      response: { promotionRunId: "run-1", finalBody: "{}" },
    });
  });

  it("is fenced: a second amend (the record no longer equals the reference) writes nothing", async () => {
    const scopeKey = await completed(a.tenantId, { promotionRunId: "run-2" });
    const target = { tenantId: a.tenantId, scopeKey };
    expect(await inTenant(a.tenantId, (c) => store.amend(c, target, { promotionRunId: "run-2" }, { promotionRunId: "run-2", finalBody: "first" }))).toBe(true);
    expect(await inTenant(a.tenantId, (c) => store.amend(c, target, { promotionRunId: "run-2" }, { promotionRunId: "run-2", finalBody: "second" }))).toBe(false);
    expect((await stored(a.tenantId, scopeKey)).response.finalBody).toBe("first");
  });

  it("a WRONG reference is refused and the record is untouched", async () => {
    const scopeKey = await completed(a.tenantId, { promotionRunId: "run-3" });
    const wrote = await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey }, { promotionRunId: "some-other-run" }, { promotionRunId: "x", finalBody: "no" }));
    expect(wrote).toBe(false);
    expect((await stored(a.tenantId, scopeKey)).response).toEqual({ promotionRunId: "run-3" });
  });

  it("an in_flight claim (not completed), a missing record and an expired record are refused", async () => {
    const scopeKey = `amend:${randomUUID()}`;
    const claim = await store.begin({ tenantId: a.tenantId, scopeKey, command: "content.promote", requestHash: "h" });
    expect(claim.kind).toBe("fresh");
    expect(await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey }, {}, { finalBody: "no" }))).toBe(false); // still in_flight (response defaults to {})
    expect((await stored(a.tenantId, scopeKey)).status).toBe("in_flight");

    expect(await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey: `amend:${randomUUID()}` }, {}, {}))).toBe(false);

    const expiredKey = await completed(a.tenantId, { promotionRunId: "run-4" });
    await asTenant(a.tenantId, (c) => c.query(`UPDATE control_idempotency_keys SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE scope_key = $1`, [expiredKey]));
    expect(await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey: expiredKey }, { promotionRunId: "run-4" }, { promotionRunId: "run-4", finalBody: "no" }))).toBe(false);
  });

  it("respects scope: another tenant, the platform scope, and a tenant id that does not own the record cannot amend it", async () => {
    const scopeKey = await completed(a.tenantId, { promotionRunId: "run-5" });
    const ref = { promotionRunId: "run-5" };
    const next = { promotionRunId: "run-5", finalBody: "no" };
    // tenant B's context and id, A's scope key
    expect(await inTenant(b.tenantId, (c) => store.amend(c, { tenantId: b.tenantId, scopeKey }, ref, next))).toBe(false);
    // A's id on B's connection: row-level security hides the row
    expect(await inTenant(b.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey }, ref, next))).toBe(false);
    // the platform scope (tenant_id IS NULL) never matches a tenant row
    expect(await inPlatform((c) => store.amend(c, { tenantId: null, scopeKey }, ref, next))).toBe(false);
    expect((await stored(a.tenantId, scopeKey)).response).toEqual(ref);

    // and the platform scope itself works, only under platform_ctx and with a null tenant id
    const platformKey = `amend:${randomUUID()}`;
    const claim = await store.begin({ tenantId: null, scopeKey: platformKey, command: "tenant.archive", requestHash: "h" });
    if (claim.kind !== "fresh") throw new Error("expected a fresh claim");
    await inPlatform((c) => store.complete(c, claim.claim, { ref: 1 }));
    expect(await inTenant(a.tenantId, (c) => store.amend(c, { tenantId: a.tenantId, scopeKey: platformKey }, { ref: 1 }, { ref: 2 }))).toBe(false);
    expect(await inPlatform((c) => store.amend(c, { tenantId: null, scopeKey: platformKey }, { ref: 1 }, { ref: 2 }))).toBe(true);
    const row = await asPlatform(async (c) => (await c.query(`SELECT response FROM control_idempotency_keys WHERE tenant_id IS NULL AND scope_key = $1`, [platformKey])).rows[0]);
    expect(row.response).toEqual({ ref: 2 });
  });

  it("is part of the caller's transaction: a rollback after amend leaves the reference in place", async () => {
    const scopeKey = await completed(a.tenantId, { promotionRunId: "run-6" });
    await expect(
      inTenant(a.tenantId, async (c) => {
        expect(await store.amend(c, { tenantId: a.tenantId, scopeKey }, { promotionRunId: "run-6" }, { promotionRunId: "run-6", finalBody: "x" })).toBe(true);
        throw new Error("the terminal transaction failed");
      }),
    ).rejects.toThrow("terminal transaction failed");
    expect((await stored(a.tenantId, scopeKey)).response).toEqual({ promotionRunId: "run-6" });
  });
});
