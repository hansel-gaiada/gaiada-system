// M6-P4r-b -- the post-commit triggers on tenant.provision, schema.apply and contract.regenerate, with NO
// services. The REAL CommandEnvelope, LifecycleService, SchemaService and ContractRegenerateService run over
// a fake database (a recording client), a fake idempotency store and a recording queue, so the ORDER of
// events is observable: the commit, then the enqueue. Covers
//   - the enqueue happens only after the command committed, and never for a refused or failed command;
//   - a replay answers from the stored record and enqueues nothing;
//   - a queue or codegen failure leaves the command's response and its stored idempotency record exactly as
//     they are with a healthy queue;
//   - schema.apply still refuses a MAJOR change (409 contract-major-change) before anything is enqueued, and
//     a MINOR change (a new collection) is accepted and enqueued;
//   - the backfill command enqueues per tenant.
// The same flows against a real database, Redis and RustFS are in contract-codegen-live.spec.ts.
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { AuditService } from "../src/audit/audit.service";
import { CommandEnvelope } from "../src/control/command-envelope";
import { ControlProblem } from "../src/control/content/content-problem";
import { LifecycleService } from "../src/control/lifecycle/lifecycle.service";
import { SchemaService, rateCollectionChange } from "../src/control/schema/schema.service";
import { ContractRegenerateService } from "../src/control/contract/contract-regenerate.service";
import { ContractCodegenTrigger } from "../src/codegen/contract-codegen.trigger";
import { ENQUEUE_TIMEOUT_MS } from "../src/codegen/contract-codegen.config";
import type { ContractCodegenQueue } from "../src/codegen/contract-codegen.queue";
import type { DbService } from "../src/db/db.service";
import type { IdempotencyBegin, PgIdempotencyStore } from "../src/control/idempotency/pg-idempotency-store";
import type { TenantLookupService } from "../src/tenants/tenant-lookup.service";
import type { CommandAuditService } from "../src/control/command-audit.service";

const TENANT = { id: "11111111-1111-4111-8111-111111111111", slug: "acme", status: "active", companyRef: "22222222-2222-4222-8222-222222222222" };
const SITE = "33333333-3333-4333-8333-333333333333";

interface Rig {
  events: string[];
  stored: unknown[];
  queueFails: { mode: "ok" | "reject" | "hang" };
  nextBegin: { value: IdempotencyBegin<unknown> };
  collectionRows: { schema: unknown }[];
  tenantSlugs: string[];
  lifecycle: LifecycleService;
  schema: SchemaService;
  regenerate: ContractRegenerateService;
}

function rig(): Rig {
  const events: string[] = [];
  const stored: unknown[] = [];
  const queueFails: Rig["queueFails"] = { mode: "ok" };
  const nextBegin: Rig["nextBegin"] = { value: { kind: "fresh", claim: { rowId: "row-1", tenantId: null, scopeKey: "k" } } };
  const collectionRows: Rig["collectionRows"] = [];
  const tenantSlugs = ["acme", "globex", "initech"];

  const client = {
    async query(sql: string) {
      if (/^\s*BEGIN/.test(sql)) events.push("begin");
      else if (/^\s*COMMIT/.test(sql)) events.push("commit");
      else if (/^\s*ROLLBACK/.test(sql)) events.push("rollback");
      else if (/INSERT INTO audit_entries/.test(sql)) events.push("audit");
      else if (/INSERT INTO tenants/.test(sql)) {
        events.push("effect:tenant-insert");
        return { rows: [{ id: "t", slug: "newco", company_ref: TENANT.companyRef, status: "active", created_at: "now", default_locale: "id-ID", locales: ["id-ID"] }] };
      } else if (/SELECT 1 FROM sites/.test(sql)) return { rows: [{ "?column?": 1 }] };
      else if (/FOR UPDATE/.test(sql)) return { rows: collectionRows };
      else if (/INSERT INTO collections/.test(sql)) {
        events.push("effect:collection-upsert");
        return { rows: [{ id: "c1", key: "page", schema: {}, updated_at: "now" }] };
      } else if (/FROM tenants WHERE status = 'active'/.test(sql)) return { rows: tenantSlugs.map((slug) => ({ slug })) };
      return { rows: [] };
    },
  } as unknown as PoolClient;

  const db = {
    withPlatformCtx: async (fn: (c: PoolClient) => Promise<unknown>) => fn(client),
    withTenant: async (_id: string, fn: (d: unknown) => Promise<unknown>) =>
      fn({
        transaction: async (f: (c: PoolClient) => Promise<unknown>) => {
          await client.query("BEGIN");
          try {
            const r = await f(client);
            await client.query("COMMIT");
            return r;
          } catch (e) {
            await client.query("ROLLBACK");
            throw e;
          }
        },
      }),
  } as unknown as DbService;

  const idempotency = {
    begin: async () => nextBegin.value,
    complete: async (_c: PoolClient, _claim: unknown, body: unknown) => void (events.push("idem-complete"), stored.push(body)),
    release: async () => void events.push("idem-release"),
  } as unknown as PgIdempotencyStore;

  const audit = new AuditService();
  const envelope = new CommandEnvelope(db, audit, idempotency);

  const queue = {
    enqueue: async (slug: string) => {
      if (queueFails.mode === "reject") throw new Error("redis down");
      if (queueFails.mode === "hang") return new Promise<string>(() => undefined);
      events.push(`enqueue:${slug}`);
      return "added";
    },
  } as unknown as ContractCodegenQueue;
  const trigger = new ContractCodegenTrigger(queue);

  const tenants = { bySlug: async (slug: string) => (slug === "missing" ? null : { ...TENANT, slug }) } as unknown as TenantLookupService;
  const commandAudit = {} as unknown as CommandAuditService;

  return {
    events,
    stored,
    queueFails,
    nextBegin,
    collectionRows,
    tenantSlugs,
    lifecycle: new LifecycleService(tenants, envelope, audit, trigger),
    schema: new SchemaService(db, tenants, commandAudit, envelope, audit, trigger),
    regenerate: new ContractRegenerateService(tenants, envelope, audit, trigger),
  };
}

const provision = (r: Rig) => r.lifecycle.provisionTenant({ slug: "newco", companyRef: TENANT.companyRef, actor: "test", idempotencyKey: "idem-key-0001" });
const apply = (r: Rig, schema: Record<string, unknown>) =>
  r.schema.applySchema({ tenantSlug: "acme", siteId: SITE, collectionKey: "page", schema, actor: "test", idempotencyKey: "idem-key-0002" });

const TITLE = { name: "title", primitive: "text" };
const BODY = { name: "body", primitive: "text" };

describe("tenant.provision queues codegen strictly after commit", () => {
  it("the enqueue comes AFTER the commit and the stored idempotency record", async () => {
    const r = rig();
    const out = await provision(r);
    expect(out).toMatchObject({ tenant: { slug: "newco" }, replayed: false });
    expect(r.events).toEqual(["begin", "audit", "effect:tenant-insert", "idem-complete", "commit", "enqueue:newco"]);
  });

  it("a REPLAY answers from the stored record and enqueues nothing", async () => {
    const r = rig();
    r.nextBegin.value = { kind: "replay", response: { tenant: { slug: "newco" } } };
    const out = await provision(r);
    expect(out).toEqual({ tenant: { slug: "newco" }, replayed: true });
    expect(r.events.filter((e) => e.startsWith("enqueue"))).toEqual([]);
    expect(r.events).not.toContain("effect:tenant-insert");
  });

  it("a queue FAILURE leaves the response and the stored idempotency record identical to a healthy run", async () => {
    const healthy = rig();
    const healthyOut = await provision(healthy);

    const broken = rig();
    broken.queueFails.mode = "reject";
    const brokenOut = await provision(broken);

    expect(brokenOut).toEqual(healthyOut);
    expect(broken.stored).toEqual(healthy.stored);
    expect(broken.stored).toHaveLength(1);
    expect(broken.events).not.toContain("idem-release"); // the claim was not released: the command committed
    expect(broken.events).not.toContain("rollback");
    expect(broken.events.filter((e) => e.startsWith("enqueue"))).toEqual([]);
  });

  it("a queue that never answers delays the response by at most the enqueue timeout, then answers normally", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const r = rig();
      r.queueFails.mode = "hang";
      const p = provision(r);
      await vi.advanceTimersByTimeAsync(ENQUEUE_TIMEOUT_MS + 5);
      await expect(p).resolves.toMatchObject({ tenant: { slug: "newco" }, replayed: false });
      expect(r.stored).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("schema.apply queues codegen strictly after commit, and only for an accepted change", () => {
  it("a MINOR apply (a new collection) commits, then enqueues the tenant", async () => {
    const r = rig(); // no stored composition for this collection: "collection added" is MINOR
    const out = await apply(r, { fields: [TITLE] });
    expect(out).toMatchObject({ bump: "minor", replayed: false });
    expect(r.events).toEqual(["begin", "audit", "effect:collection-upsert", "idem-complete", "commit", "enqueue:acme"]);
  });

  it("a MAJOR change is refused 409 contract-major-change BEFORE anything is enqueued, and nothing is stored", async () => {
    const r = rig();
    r.collectionRows.push({ schema: { fields: [TITLE, BODY] } });
    // The premise, stated outright: dropping a field is a MAJOR contract change.
    expect(rateCollectionChange("page", { fields: [TITLE, BODY] }, { fields: [TITLE] }).bump).toBe("major");

    const err = await apply(r, { fields: [TITLE] }).catch((e) => e);
    expect(err).toBeInstanceOf(ControlProblem);
    expect((err as ControlProblem).getStatus()).toBe(409);
    expect((err as ControlProblem).slug).toBe("contract-major-change");
    expect(r.events.filter((e) => e.startsWith("enqueue"))).toEqual([]);
    expect(r.events).toContain("rollback");
    expect(r.events).toContain("idem-release");
    expect(r.events).not.toContain("effect:collection-upsert");
    expect(r.stored).toEqual([]);
  });

  it("a MINOR apply over an existing collection (a field added) is accepted and enqueued", async () => {
    const r = rig();
    r.collectionRows.push({ schema: { fields: [TITLE] } });
    const out = await apply(r, { fields: [TITLE, BODY] });
    expect(out).toMatchObject({ bump: "minor" });
    expect(r.events.at(-1)).toBe("enqueue:acme");
  });

  it("a REPLAY enqueues nothing", async () => {
    const r = rig();
    r.nextBegin.value = { kind: "replay", response: { collection: { id: "c1" }, bump: "minor", reasons: [] } };
    const out = await apply(r, { fields: [TITLE] });
    expect(out.replayed).toBe(true);
    expect(r.events.filter((e) => e.startsWith("enqueue"))).toEqual([]);
  });

  it("a queue FAILURE leaves the response and the stored record identical to a healthy run", async () => {
    const healthy = rig();
    const healthyOut = await apply(healthy, { fields: [TITLE] });
    const broken = rig();
    broken.queueFails.mode = "reject";
    const brokenOut = await apply(broken, { fields: [TITLE] });
    expect(brokenOut).toEqual(healthyOut);
    expect(broken.stored).toEqual(healthy.stored);
    expect(broken.events).not.toContain("idem-release");
  });
});

describe("contract.regenerate (the re-run and backfill command)", () => {
  it("one tenant: enqueues exactly that tenant after the commit and reports it", async () => {
    const r = rig();
    const out = await r.regenerate.regenerate({ tenantSlug: "acme", actor: "test", idempotencyKey: "idem-key-0003" });
    expect(out).toMatchObject({ scope: "tenant", tenants: ["acme"], replayed: false, enqueue: { enqueued: 1, failed: 0 } });
    expect(r.events).toEqual(["begin", "audit", "idem-complete", "commit", "enqueue:acme"]);
  });

  it("an unknown tenant is a 404 before the envelope: no claim, no audit row, no enqueue", async () => {
    const r = rig();
    await expect(r.regenerate.regenerate({ tenantSlug: "missing", actor: "test", idempotencyKey: "idem-key-0003" })).rejects.toThrow("tenant not found");
    expect(r.events).toEqual([]);
  });

  it("all tenants: enqueues one run per ACTIVE tenant, in slug order, only after the commit", async () => {
    const r = rig();
    const out = await r.regenerate.regenerate({ actor: "test", idempotencyKey: "idem-key-0004" });
    expect(out).toMatchObject({ scope: "all", tenants: ["acme", "globex", "initech"], enqueue: { enqueued: 3, failed: 0 } });
    expect(r.events.slice(0, 4)).toEqual(["begin", "audit", "idem-complete", "commit"]);
    expect(r.events.slice(4)).toEqual(["enqueue:acme", "enqueue:globex", "enqueue:initech"]);
  });

  it("a replay enqueues nothing and carries no enqueue report", async () => {
    const r = rig();
    r.nextBegin.value = { kind: "replay", response: { scope: "all", tenants: ["acme"] } };
    const out = await r.regenerate.regenerate({ actor: "test", idempotencyKey: "idem-key-0004" });
    expect(out).toEqual({ scope: "all", tenants: ["acme"], replayed: true });
    expect(r.events.filter((e) => e.startsWith("enqueue"))).toEqual([]);
  });

  it("with the queue down the command still answers, and says plainly that nothing was queued", async () => {
    const r = rig();
    r.queueFails.mode = "reject";
    const out = await r.regenerate.regenerate({ actor: "test", idempotencyKey: "idem-key-0005" });
    expect(out).toMatchObject({ scope: "all", tenants: ["acme", "globex", "initech"], replayed: false, enqueue: { enqueued: 0, failed: 3 } });
    expect(r.stored).toHaveLength(1);
  });
});
