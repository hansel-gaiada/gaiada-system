import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { resetDemoBilling } from "./demoBilling";
import { buildDemoClientHealth, type DemoHealthInput } from "./demoClientHealth";
import { STATE_LABEL, type ClientHealthDetail, type HealthReasonCode } from "./clientHealth";
import type { PortalHealth } from "./portal";

// PV7-03 — the demo twins of BFF §54: field names exactly as the contract, null rules as the contract, and the state the
// way the rules table gives it for the signals the demo has. A demo that drifts from the contract hides a UI bug.

const T = "co-agency";
const HANSEL = "demo-hansel";
const staff = (cid: string) => getDemoResponse("GET", `/api/${T}/clients/${cid}/health`, HANSEL);
const portal = (user: string) => getDemoResponse("GET", `/api/${T}/portal/health`, user);

beforeEach(() => resetDemoBilling());

const CODES: HealthReasonCode[] = [
  "waiting_on_us_7d", "waiting_on_us_14d", "waiting_on_client_14d", "late_work", "late_work_14d",
  "invoice_overdue", "invoice_overdue_30d", "site_incident_open", "site_incident_open_24h", "no_active_work", "source_unavailable",
];

describe("demo staff health · GET :t/clients/:clientId/health (§54.2)", () => {
  it("has exactly the contract's fields, and every reason code is one of §54.2's", () => {
    const r = staff("cl-1");
    expect(r.status).toBe(200);
    const h = r.json as ClientHealthDetail;
    expect(Object.keys(h).sort()).toEqual([
      "asOf", "clientId", "name", "onTimeKnownSince", "ownerName", "ownerUserId", "projects", "reasons", "signals", "state", "status", "turnaround", "unavailable",
    ]);
    expect(Object.keys(h.signals).sort()).toEqual([
      "activeProjects", "activeServices", "conversationsAwaitingReply", "deliveryOnTime", "lateDeliverables", "lateMilestones",
      "openChangeRequests", "overdueInvoices", "site", "waitingOnClient", "waitingOnUs",
    ]);
    expect(h.signals.deliveryOnTime).toBeNull();
    for (const x of h.reasons) expect(CODES).toContain(x.code);
    expect(STATE_LABEL[h.state]).toBeTruthy();
    for (const p of h.projects!) {
      expect(Object.keys(p).sort()).toEqual(["clientVisible", "deliverables", "milestones", "name", "nextMilestone", "projectId", "status"]);
      const m = p.milestones;
      expect(m.done + m.upcoming + m.late + m.undated).toBe(m.total);
    }
    const ta = h.turnaround!;
    expect(ta.windowDays).toBe(90);
    for (const side of [ta.client, ta.ours]) {
      expect(Object.keys(side).sort()).toEqual(["medianDays", "n", "parts", "withheld"]);
      // The contract: below 3 samples the median is null and withheld is true; never the other way round.
      for (const x of [side, ...side.parts]) expect(x.withheld).toBe(x.n < 3), expect(x.medianDays === null).toBe(x.withheld);
    }
  });

  it("the Health card's waiting counts are the overview's own lists (they cannot disagree)", () => {
    const ov = getDemoResponse("GET", `/api/${T}/clients/cl-1/overview`, HANSEL).json as { needsUs: unknown[]; needsClient: unknown[] };
    const h = staff("cl-1").json as ClientHealthDetail;
    expect(h.signals.waitingOnUs!.count).toBe(ov.needsUs.length);
    expect(h.signals.waitingOnClient!.count).toBe(ov.needsClient.length);
  });

  it("cl-1 is off track on late work 14+ days, reported once; cl-3 shows a failed source as 'unknown', never on track", () => {
    const a = staff("cl-1").json as ClientHealthDetail;
    expect(a.state).toBe("off_track");
    expect(a.reasons.map((x) => x.code)).toContain("late_work_14d");
    expect(a.reasons.map((x) => x.code)).not.toContain("late_work");
    const c = staff("cl-3").json as ClientHealthDetail;
    expect(c.unavailable).toEqual(["turnaround"]);
    expect(c.turnaround).toBeNull();
    expect(c.state).toBe("unknown");
    expect(c.reasons).toEqual([{ code: "source_unavailable", count: 1, since: null }]);
  });

  it("an unknown client is a 404", () => {
    expect(staff("cl-nope").status).toBe(404);
  });
});

describe("buildDemoClientHealth · the thresholds of §54.3", () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const base: DemoHealthInput = {
    clientId: "cl-x", name: "X", status: "active", now,
    projects: [{ id: "p-x", name: "P", status: "active" }], deliverables: [], invoices: [], needsUs: [], needsClient: [], conversationsAwaitingReply: 0,
  };
  const verdict = (over: Partial<DemoHealthInput>) => {
    const h = buildDemoClientHealth({ ...base, ...over });
    return { state: h.state, codes: h.reasons.map((r) => r.code) };
  };
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

  it("nothing waiting is on track; 6 days is still on track, 7 is at risk, 14 is off track", () => {
    expect(verdict({})).toEqual({ state: "on_track", codes: [] });
    expect(verdict({ needsUs: [{ since: ago(6) }] }).state).toBe("on_track");
    expect(verdict({ needsUs: [{ since: ago(7) }] })).toEqual({ state: "at_risk", codes: ["waiting_on_us_7d"] });
    expect(verdict({ needsUs: [{ since: ago(14) }] })).toEqual({ state: "off_track", codes: ["waiting_on_us_14d"] });
  });
  it("the client taking 14 days is at risk, never off track", () => {
    expect(verdict({ needsClient: [{ since: ago(13) }] }).state).toBe("on_track");
    expect(verdict({ needsClient: [{ since: ago(30) }] })).toEqual({ state: "at_risk", codes: ["waiting_on_client_14d"] });
  });
  it("an overdue issued invoice is at risk, 30 days overdue is off track", () => {
    expect(verdict({ invoices: [{ status: "sent", dueDate: "2026-10-14" }] })).toEqual({ state: "at_risk", codes: ["invoice_overdue"] });
    expect(verdict({ invoices: [{ status: "sent", dueDate: "2026-09-15" }] })).toEqual({ state: "off_track", codes: ["invoice_overdue_30d"] });
    expect(verdict({ invoices: [{ status: "draft", dueDate: "2026-01-01" }] }).state).toBe("on_track");
  });
  it("no active project is quiet, and quiet carries no_active_work", () => {
    expect(verdict({ projects: [] })).toEqual({ state: "quiet", codes: ["no_active_work"] });
    expect(verdict({ projects: [{ id: "p-x", name: "P", status: "completed" }] }).state).toBe("quiet");
  });
});

describe("demo portal health · GET :t/portal/health (§54.5)", () => {
  const read = (user: string) => {
    const r = portal(user);
    expect(r.status).toBe(200);
    return r.json as PortalHealth;
  };

  it("a client-wide contact of Northwind and a project-scoped contact of Harbour (demo-client): two sections", () => {
    const h = read("demo-client");
    expect(Object.keys(h).sort()).toEqual(["asOf", "clients", "unavailable"]);
    expect(h.clients.map((c) => [c.clientId, c.wide])).toEqual([["cl-1", true], ["cl-harbour", false]]);
    const [nw, hb] = h.clients;
    expect(nw.clientWide).not.toBeNull();
    // The project-scoped contact: nothing client-wide, and a turnaround counted on their own project (so one side is withheld).
    expect(hb.clientWide).toBeNull();
    expect(hb.projects!.length).toBe(1);
    expect(hb.turnaround!.ours.withheld).toBe(true);
    expect(hb.turnaround!.ours.medianDays).toBeNull();
  });

  it("every other portal identity reads Northwind only", () => {
    for (const u of ["demo-client-admin", "demo-client-viewer", "demo-viceroy-marketing", "demo-two-company-client"]) {
      expect(read(u).clients.map((c) => c.clientId), u).toEqual(["cl-1"]);
    }
  });

  it("the Northwind section is derived from the portal stores: milestone counts add up, the unsigned agreement is waiting on the client", () => {
    const nw = read("demo-client").clients[0];
    const site = nw.projects!.find((p) => p.projectId === "proj-nw-site")!;
    const m = site.milestones;
    expect(m.done + m.upcoming + m.late + m.undated).toBe(m.total);
    expect(m.late).toBeGreaterThan(0); // the deliberately overdue "Content sign-off"
    const you = site.waitingOnYou!;
    expect(you.count).toBe(you.items.length);
    expect(you.items.map((i) => i.kind)).toEqual(expect.arrayContaining(["gate", "contract"]));
    // A payment is client-wide and carries no amount.
    const pay = nw.clientWide!.waitingOnUs!.items.find((i) => i.kind === "payment");
    if (pay) expect(pay.context).toBeNull();
  });

  it("🔴 never carries a state label, tasks, people, internal gates or money", () => {
    const body = JSON.stringify(read("demo-client"));
    expect(body).not.toMatch(/"(state|reasons|tasks|assignee|owner|ownerName|actor_side|internal|amount|outstanding|blocked|currency)":/);
    expect(body).not.toMatch(/on_track|at_risk|off_track/);
  });

  it("a staff member is refused as on every portal read", () => {
    expect(portal(HANSEL).status).toBe(403);
  });
});
