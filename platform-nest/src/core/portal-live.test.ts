// CP-5 — the portal live bus's fan-out rules, with no Redis and no Postgres.
//
// Worth having as a pure test precisely BECAUSE the bus is deliberately content-free: the only things
// that can go wrong here are (a) a frame reaching the wrong tenant, (b) an internal event type waking a
// client's browser, and (c) a payload field leaking into a frame. All three are decidable without any
// infrastructure, so they are pinned where they will actually run on every commit rather than only in
// the CI job that has a database.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatchPortalFrame, resetPortalLive, subscribePortal, type PortalFrame } from "./portal-live.service";

function collector(tenantId: string, clientIds: string[]) {
  const frames: PortalFrame[] = [];
  const off = subscribePortal({ tenantId, clientIds: new Set(clientIds), send: (f) => frames.push(f) });
  return { frames, off };
}

const AT = "2026-08-04T10:00:00.000Z";

describe("portal live bus (CP-5)", () => {
  beforeEach(() => resetPortalLive());
  afterEach(() => resetPortalLive());

  it("maps a mapped event to its topic", () => {
    const a = collector("t1", ["c1"]);
    dispatchPortalFrame("t1", "invoice.payment.recorded", { clientId: "c1" }, AT);
    expect(a.frames).toEqual([{ topic: "invoices", at: AT }]);
    a.off();
  });

  it("carries NO payload data — only a topic and a timestamp", () => {
    const a = collector("t1", ["c1"]);
    dispatchPortalFrame("t1", "contract.signed", { clientId: "c1", value: 25000, title: "MSA", secret: "x" }, AT);
    expect(Object.keys(a.frames[0]).sort()).toEqual(["at", "topic"]);
    expect(JSON.stringify(a.frames)).not.toContain("25000");
    expect(JSON.stringify(a.frames)).not.toContain("MSA");
    a.off();
  });

  it("drops an unmapped event type — the topic map is an allowlist", () => {
    const a = collector("t1", ["c1"]);
    // Real internal events on tailed streams. None of these may wake a client.
    for (const t of ["hr.case.opened", "pm.task.deleted", "report.appraisal.scored", "user.invited"]) {
      dispatchPortalFrame("t1", t, { clientId: "c1" }, AT);
    }
    expect(a.frames).toEqual([]);
    a.off();
  });

  it("never crosses tenants", () => {
    const a = collector("t1", ["c1"]);
    const b = collector("t2", ["c1"]);   // same client id, different tenant — must not match
    dispatchPortalFrame("t1", "invoice.updated", { clientId: "c1" }, AT);
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(0);
    a.off(); b.off();
  });

  it("narrows to the owning client when the event names one", () => {
    const a = collector("t1", ["c1"]);
    const b = collector("t1", ["c2"]);
    dispatchPortalFrame("t1", "contract.client_signed", { clientId: "c2" }, AT);
    expect(a.frames).toHaveLength(0);
    expect(b.frames).toHaveLength(1);
    a.off(); b.off();
  });

  it("falls back to tenant-wide delivery when the event names no client", () => {
    // The deliberate over-delivery documented in the service: costs a redundant refetch, never a
    // disclosure, and avoids a per-event DB lookup on a connection held open by an external party.
    const a = collector("t1", ["c1"]);
    const b = collector("t1", ["c2"]);
    dispatchPortalFrame("t1", "deliverable.updated", {}, AT);
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
    a.off(); b.off();
  });

  it("stops delivering after unsubscribe", () => {
    const a = collector("t1", ["c1"]);
    a.off();
    dispatchPortalFrame("t1", "invoice.updated", { clientId: "c1" }, AT);
    expect(a.frames).toEqual([]);
  });

  it("one dead subscriber does not starve the others", () => {
    const boom = subscribePortal({
      tenantId: "t1", clientIds: new Set(["c1"]),
      send: () => { throw new Error("socket gone"); },
    });
    const good = collector("t1", ["c1"]);
    expect(() => dispatchPortalFrame("t1", "invoice.updated", { clientId: "c1" }, AT)).not.toThrow();
    expect(good.frames).toHaveLength(1);
    boom(); good.off();
  });

  it("ignores a non-string clientId rather than matching everyone by accident", () => {
    const a = collector("t1", ["c1"]);
    const b = collector("t1", ["c2"]);
    // A malformed payload must degrade to the tenant-wide fallback, not to "matches nothing" (which
    // would silently stop the portal updating) and not to a thrown error in the loop.
    dispatchPortalFrame("t1", "invoice.updated", { clientId: 42 as unknown as string }, AT);
    expect(a.frames).toHaveLength(1);
    expect(b.frames).toHaveLength(1);
    a.off(); b.off();
  });

  // MI-02/MI-03 (webdev maintenance intake, D-7): both the portal-submit event (MI-02) and the
  // staff triage/convert event (MI-03) must land on the SAME topic so the portal page refetches
  // regardless of which side changed the request.
  it("maps both change-request event types to the new 'requests' topic", () => {
    const a = collector("t1", ["c1"]);
    dispatchPortalFrame("t1", "webdev.change_request.created", { clientId: "c1" }, AT);
    dispatchPortalFrame("t1", "webdev.change_request.updated", { clientId: "c1" }, AT);
    expect(a.frames).toEqual([{ topic: "requests", at: AT }, { topic: "requests", at: AT }]);
    a.off();
  });
});
