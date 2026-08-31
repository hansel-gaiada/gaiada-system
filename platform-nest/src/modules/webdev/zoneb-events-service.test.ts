// WSK-12 — the idempotency + RLS third-wall core, against LIVE Postgres (same strategy
// `provisioning-idempotency.test.ts` already documents for its own module: "the idempotency ...
// core itself is proven at the service layer", bypassing the HTTP/Cerbos guard chain entirely so
// this suite proves the DATA-LAYER guarantee independent of whatever Cerbos policy state happens
// to be loaded in a given environment).
//
// ── WHAT THIS SUITE IS TRYING TO FALSIFY ────────────────────────────────────────────────────────
//   1. A duplicate delivery of the SAME (tenantId, eventId) never creates a second row — the whole
//      point of `ux_wzel_tenant_event UNIQUE (tenant_id, event_id)` and the every-webhook-fires-
//      twice doctrine this table exists to absorb.
//   2. The THIRD WALL actually walls: a DIFFERENT tenant's event_id (even an IDENTICAL string) is
//      a completely separate row, invisible cross-tenant — RLS's job, not app logic's.
//   3. `{modules:['webdev']}` is not optional decoration: a plain `withTenants()` call (no module
//      scope declared) reads/writes ZERO ROWS on this table, silently — the WD-23A-1 regression
//      class every webdev_* table in this program has to positively disprove for itself.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { withTenants } from "../../db";
import { recordZoneBEvent, listRecentZoneBEvents } from "./zoneb-events.service";
import type { ZoneBEventInput } from "./zoneb-event-schema";

function event(overrides: Partial<ZoneBEventInput> = {}, tenantId: string): ZoneBEventInput {
  return {
    eventId: "evt-fixed-1",
    kind: "form.received",
    tenantId,
    originSite: "webdesk-test",
    occurredAt: new Date().toISOString(),
    data: { siteSlug: "acme", formId: "contact", submissionId: "sub-1", hasAttachments: false },
    ...overrides,
  };
}

describe.skipIf(!TEST_URL)("WSK-12 · webdev_zoneb_event_log — idempotency + third wall (live Postgres)", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    await initTestDb();
    tenantA = await createCompany("WSK-12 Tenant A", ["webdev"]);
    tenantB = await createCompany("WSK-12 Tenant B", ["webdev"]);
  });
  afterAll(async () => {
    await teardownTestDb();
  });

  it("a fresh event INSERTS — inserted:true, a new id", async () => {
    const outcome = await recordZoneBEvent(tenantA, event({}, tenantA));
    expect(outcome.inserted).toBe(true);
    expect(typeof outcome.id).toBe("string");
  });

  it("a DUPLICATE delivery of the SAME (tenantId, eventId) is a no-op — inserted:false, SAME id, still exactly one row", async () => {
    const first = await recordZoneBEvent(tenantA, event({ eventId: "evt-dup-1" }, tenantA));
    const second = await recordZoneBEvent(tenantA, event({ eventId: "evt-dup-1", data: { siteSlug: "acme", formId: "contact", submissionId: "DIFFERENT-attempt", hasAttachments: true } }, tenantA));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id); // the SAME row, not a second one

    const recent = await listRecentZoneBEvents(tenantA);
    const matching = recent.filter((r) => r.eventId === "evt-dup-1");
    expect(matching).toHaveLength(1); // never two rows for one idempotency key
  });

  it("THIRD WALL: the SAME event_id string for a DIFFERENT tenant is a SEPARATE row, not a collision", async () => {
    const outcomeA = await recordZoneBEvent(tenantA, event({ eventId: "evt-shared-id" }, tenantA));
    const outcomeB = await recordZoneBEvent(tenantB, event({ eventId: "evt-shared-id" }, tenantB));

    expect(outcomeA.inserted).toBe(true);
    expect(outcomeB.inserted).toBe(true); // NOT deduped against tenant A's row
    expect(outcomeA.id).not.toBe(outcomeB.id);
  });

  it("THIRD WALL: tenant A cannot read tenant B's events via listRecentZoneBEvents (RLS, cross-tenant)", async () => {
    await recordZoneBEvent(tenantB, event({ eventId: "evt-b-only" }, tenantB));
    const asA = await listRecentZoneBEvents(tenantA);
    expect(asA.some((r) => r.eventId === "evt-b-only")).toBe(false);

    const asB = await listRecentZoneBEvents(tenantB);
    expect(asB.some((r) => r.eventId === "evt-b-only")).toBe(true);
  });

  it("THIRD WALL: a plain withTenants() call with NO module scope reads ZERO rows, silently (the WD-23A-1 regression class)", async () => {
    await recordZoneBEvent(tenantA, event({ eventId: "evt-scope-check" }, tenantA));

    // Deliberately bypasses the service's own withWebdev() helper to prove the RAW policy behavior
    // the helper exists to make impossible to forget — a bare withTenants([tenant]) declares NO
    // module scope, so app_module_allowed('webdev') is false and the third wall zeroes the read.
    const rows = await withTenants([tenantA], (c) =>
      c.query(`SELECT id FROM webdev_zoneb_event_log WHERE tenant_id = $1 AND event_id = $2`, [tenantA, "evt-scope-check"]),
    );
    expect(rows.rowCount).toBe(0); // NOT an error — the defining, dangerous shape of this failure mode

    // Same query, WITH the module scope declared, finds the row — proving the zero above was the
    // wall doing its job, not a bug elsewhere (e.g. a bad tenant id) masquerading as one.
    const rowsWithScope = await withTenants([tenantA], (c) =>
      c.query(`SELECT id FROM webdev_zoneb_event_log WHERE tenant_id = $1 AND event_id = $2`, [tenantA, "evt-scope-check"]),
      { modules: ["webdev"] },
    );
    expect(rowsWithScope.rowCount).toBe(1);
  });

  it("REFUSES a NULL/empty kind or payload at the DB layer too (CHECK constraints, defense beneath the app validator)", async () => {
    // The service always passes a `kind` that already survived `validateZoneBEvent` — this pins
    // the DB-level backstop directly, bypassing the app validator entirely, the same "prove the
    // constraint independent of the code that is supposed to prevent reaching it" doctrine the
    // migration lint suite already applies elsewhere in this repo.
    await expect(
      withTenants([tenantA], (c) =>
        c.query(
          `INSERT INTO webdev_zoneb_event_log (tenant_id, event_id, kind, payload, origin_site)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantA, "evt-bad-kind", "not-a-real-kind", "{}", "webdesk-test"],
        ),
        { modules: ["webdev"] },
      ),
    ).rejects.toThrow();
  });
});
