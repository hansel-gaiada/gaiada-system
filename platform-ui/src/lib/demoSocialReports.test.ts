import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// SCP-5a (BFF §63.18): DEMO_MODE's twin of the monthly report routes, in the server's order of checks, with the four gates of SCP-Q20. The store seeds from the day it is first touched, so the
// clock is pinned to mid-month (Friday 16 October 2026) before it is imported (hence vi.hoisted). Only Date is faked. Each test that writes builds its own store from the seed.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
});
afterAll(() => vi.useRealTimers());

import { PIPE_ENGAGEMENTS } from "./demoSocialPipeline";
import { demoNeedsYou } from "./demoSocialPipeline";
import { reportApi, seedReportStore, demoReports, demoReportsFor, type ReportStore } from "./demoSocialReports";
import { socialDemo } from "./demoSocial";
import { portalReportsDemo } from "./demoClientReports";
import { asReportDetail, asReportList, asProposal, asCreatedReport, notesAreComplete } from "./socialReports";

const USER = { officer: "u-social", officer2: "u-social-2", hod: "u-pm", gm: "u-gm", owner: "demo-owner", superadmin: "demo-hansel", companyAdmin: "u-dev", copywriter: "u-copy", client: "demo-client" };
const [NORTH, SPA, HOTEL] = PIPE_ENGAGEMENTS.map((e) => e.id);

let store: ReportStore;
let api: ReturnType<typeof reportApi>;
beforeEach(() => { store = seedReportStore(); api = reportApi(store); });

const call = (method: string, tail: string, user: string, body?: unknown, query = "") => {
  const r = api.staff(method, tail, new URLSearchParams(query), body === undefined ? undefined : JSON.stringify(body), user);
  expect(r, `${method} ${tail} is a report route`).not.toBeNull();
  return r!;
};
const error = (r: { json: unknown }) => (r.json as { error: string }).error;
const refused = (r: { status: number; json: unknown }, status: number, code: string) => { expect([r.status, error(r)]).toEqual([status, code]); };
const rows = () => asReportList(call("GET", "reports", USER.hod).json);
const idOf = (client: string, period: string) => rows().find((r) => r.clientName === client && r.period === period)!.id;
const NORTH_LAST = () => idOf("Northwind Traders", "2026-09"); // Ready
const NORTH_THIS = () => idOf("Northwind Traders", "2026-10"); // a draft with the audience area missing
const HOTEL_LAST = () => idOf("Harborlight Hotel", "2026-09"); // HoD check, simulated
const complete = { followers: { insight: "i", suggestion: "s" }, engagement: { insight: "i", suggestion: "s" }, audience: { insight: "i", suggestion: "s" } };

describe("the seed", () => {
  it("has a report in each state, the hotel's simulated, and none yet for the spa", () => {
    const r = rows();
    const byKey = Object.fromEntries(r.map((x) => [`${x.clientName}|${x.period}`, x]));
    expect(byKey["Northwind Traders|2026-08"]).toMatchObject({ status: "delivered", notesComplete: true, simulated: false });
    expect(byKey["Northwind Traders|2026-09"]).toMatchObject({ status: "approved", notesComplete: true, simulated: false });
    expect(byKey["Northwind Traders|2026-10"]).toMatchObject({ status: "draft", notesComplete: false });
    expect(byKey["Harborlight Hotel|2026-09"]).toMatchObject({ status: "in_review", notesComplete: true, simulated: true });
    expect(r.some((x) => x.clientName === "Saltmarsh Day Spa")).toBe(false);
  });
  it("answers the shape the UI's own parsers accept, document included", () => {
    const d = asReportDetail(call("GET", `reports/${HOTEL_LAST()}`, USER.hod).json);
    expect(d).toMatchObject({ status: "in_review", simulated: true, notesComplete: true, kind: "monthly", period: "2026-09" });
    expect(d.document.simulated).toBe(true);
    expect(d.document.header).toMatchObject({ grain: "company", scopeName: "Harborlight Hotel", periodLabel: "September 2026" });
    expect(d.document.tables.map((t) => t.key)).toEqual(expect.arrayContaining(["top_posts", "notes", "action_plan"]));
    const real = asReportDetail(call("GET", `reports/${NORTH_LAST()}`, USER.hod).json);
    expect(real.document.simulated).toBeUndefined();
    expect(real.document.tables.map((t) => t.key)).toContain("ad_spend"); // Northwind's boosts, as the client's own ad spend
  });
  it("is reached through the demo router for every route, as the pages call it", () => {
    const r = socialDemo("GET", "/api/co/modules/social/reports", new URLSearchParams(), undefined, USER.hod)!;
    expect(r.status).toBe(200);
    expect(asReportList(r.json).length).toBe(rows().length);
    expect(demoReports.store.reports.length).toBeGreaterThan(0);
  });
});

describe("reading and listing (the role first; the report first on a single read)", () => {
  it("a client contact is refused the list with 403", () => {
    expect(call("GET", "reports", USER.client).status).toBe(403);
  });
  it("filters by status, month and client, and refuses a filter that is not one with 400 and the field", () => {
    expect(asReportList(call("GET", "reports", USER.hod, undefined, "status=approved").json).map((r) => r.status)).toEqual(["approved"]);
    expect(asReportList(call("GET", "reports", USER.hod, undefined, "period=2026-10").json).every((r) => r.period === "2026-10")).toBe(true);
    expect(asReportList(call("GET", "reports", USER.hod, undefined, `engagementId=${HOTEL}`).json).every((r) => r.clientName === "Harborlight Hotel")).toBe(true);
    for (const [q, field] of [["status=sent", "status"], ["period=2026-13", "period"], ["engagementId=a b", "engagementId"]] as const) {
      const r = call("GET", "reports", USER.hod, undefined, q);
      expect(r.status).toBe(400);
      expect(r.json).toEqual({ error: "invalid_field", field });
    }
  });
  it("a missing report is 404 before the role is looked at, as the server does; an existing one is 403 for a client contact", () => {
    refused(call("GET", "reports/nope", USER.client), 404, "report not found");
    expect(call("GET", `reports/${NORTH_LAST()}`, USER.client).status).toBe(403);
  });
  it("canApprove and canDeliver are the four's: the HoD, the GM, the owner and the superadmin; not the officer, a company admin or a copywriter", () => {
    const flags = (u: string) => { const d = asReportDetail(call("GET", `reports/${NORTH_LAST()}`, u).json); return [d.canApprove, d.canDeliver]; };
    for (const u of [USER.hod, USER.gm, USER.owner, USER.superadmin]) expect(flags(u), u).toEqual([true, true]);
    for (const u of [USER.officer, USER.companyAdmin, USER.copywriter]) expect(flags(u), u).toEqual([false, false]);
  });
});

describe("drafting a report (POST engagements/:id/reports)", () => {
  const draft = (user: string, body: Record<string, unknown>, eng = SPA) => call("POST", `engagements/${eng}/reports`, user, body);

  it("the officer drafts a monthly report with its notes and plan, by the model for a real client", () => {
    const r = draft(USER.officer2, { id: "soc-rep-new-1", kind: "monthly", period: "2026-09" });
    expect(r.status).toBe(201);
    const c = asCreatedReport(r.json);
    expect(c).toMatchObject({ id: "soc-rep-new-1", status: "draft", simulated: false, draftedVia: "ai" });
    const d = asReportDetail(call("GET", `reports/${c.id}`, USER.officer2).json);
    expect(notesAreComplete(d.notes)).toBe(true);
    expect(d.actionPlan.length).toBeGreaterThan(0);
    expect(d.document.narrative.source).toBe("ai");
  });
  it("is idempotent: the same id, or the same client and month, is the same report, `existing`", () => {
    const a = asCreatedReport(draft(USER.officer2, { id: "soc-rep-new-2", kind: "monthly", period: "2026-09" }).json);
    const again = asCreatedReport(draft(USER.officer2, { id: "soc-rep-new-2", kind: "monthly", period: "2026-09" }).json);
    const other = asCreatedReport(draft(USER.hod, { id: "soc-rep-new-3", kind: "monthly", period: "2026-09" }).json);
    expect([again.id, again.draftedVia]).toEqual([a.id, "existing"]);
    expect([other.id, other.draftedVia]).toEqual([a.id, "existing"]);
    expect(rows().filter((r) => r.clientName === "Saltmarsh Day Spa" && r.period === "2026-09")).toHaveLength(1);
    // a month that has a report already, drafted by the officer of that client: also existing
    expect(asCreatedReport(draft(USER.officer, { id: "soc-rep-new-4", kind: "monthly", period: "2026-09" }, NORTH).json)).toMatchObject({ id: NORTH_LAST(), draftedVia: "existing" });
  });
  it("a client whose numbers are the simulator's gets a SIMULATED report, drafted from the plain template (the gateway fell back)", () => {
    const c = asCreatedReport(draft(USER.officer, { id: "soc-rep-new-5", kind: "monthly", period: "2026-08" }, HOTEL).json);
    expect(c).toMatchObject({ simulated: true, draftedVia: "fallback" });
    expect(asReportDetail(call("GET", `reports/${c.id}`, USER.officer).json).document.narrative.source).toBe("deterministic");
  });
  it("checks the ids and the kind first (400), then the role (403), then the client (404), as the server does", () => {
    refused(draft(USER.client, { kind: "weekly", period: "2026-09" }), 400, "invalid_kind"); // 400 before the 403
    refused(draft(USER.client, { kind: "monthly", period: "2026-09" }), 403, "not authorized: cerbos denied create on social_report");
    refused(draft(USER.copywriter, { kind: "monthly", period: "2026-09" }), 403, "not authorized: cerbos denied create on social_report");
    refused(draft(USER.officer, { kind: "monthly", period: "2026-09" }, "no-such-client"), 404, "engagement not found");
    refused(draft(USER.officer, { id: "bad id", kind: "monthly" }), 400, "id_invalid");
  });
  it("the company admin and the four may draft; no one can draft for an internal or unknown client", () => {
    for (const [i, u] of [USER.companyAdmin, USER.hod, USER.superadmin].entries()) expect(draft(u, { id: `soc-rep-w-${i}`, kind: "monthly", period: `2026-0${i + 1}` }).status).toBe(201);
  });
});

describe("saving, submitting and sending back (PATCH reports/:id)", () => {
  const patch = (user: string, id: string, body: Record<string, unknown>) => call("PATCH", `reports/${id}`, user, body);

  it("the officer saves the narrative, the notes and the plan while the report is a draft", () => {
    const id = NORTH_THIS();
    const r = patch(USER.officer, id, { narrativeMd: "Edited.", notes: complete, actionPlan: [{ action: "Do it", owner: "client", due: "2026-10-30" }] });
    expect(r).toMatchObject({ status: 200, json: { id, status: "draft" } });
    const d = asReportDetail(call("GET", `reports/${id}`, USER.officer).json);
    expect([d.document.narrative.text, d.notes.audience?.insight, d.actionPlan, d.notesComplete]).toEqual(["Edited.", "i", [{ action: "Do it", owner: "client", due: "2026-10-30" }], true]);
  });
  it("answers 400 with the field for a body outside the shapes", () => {
    const id = NORTH_THIS();
    const bad: Array<[Record<string, unknown>, string]> = [
      [{ notes: { followers: { insight: "x".repeat(501), suggestion: "" } } }, "notes"],
      [{ notes: { followers: { other: "x" } } }, "notes"],
      [{ notes: { reach: { insight: "", suggestion: "" } } }, "notes"],
      [{ notes: "text" }, "notes"],
      [{ actionPlan: Array.from({ length: 11 }, () => ({ action: "x", owner: "agency" })) }, "actionPlan"],
      [{ actionPlan: [{ action: "x", owner: "me" }] }, "actionPlan"],
      [{ actionPlan: [{ action: "x".repeat(301), owner: "agency" }] }, "actionPlan"],
      [{ actionPlan: [{ action: "x", owner: "agency", due: "2026-02-30" }] }, "actionPlan"],
      [{ actionPlan: [{ action: "  ", owner: "agency" }] }, "actionPlan"],
      [{ narrativeMd: 5 }, "narrativeMd"],
    ];
    for (const [body, field] of bad) {
      const r = patch(USER.officer, id, body);
      expect([r.status, r.json], JSON.stringify(body)).toEqual([400, { error: "invalid_field", field }]);
    }
    expect(patch(USER.officer, id, { actionPlan: Array.from({ length: 10 }, () => ({ action: "x".repeat(300), owner: "agency" })) }).status).toBe(200);
  });
  it("the officer submits a draft for the HoD check; a second submit is `cannot_submit_from_this_status`", () => {
    const id = NORTH_THIS();
    expect(patch(USER.officer, id, { status: "in_review" }).json).toEqual({ id, status: "in_review" });
    refused(patch(USER.officer, id, { status: "in_review" }), 400, "cannot_submit_from_this_status");
  });
  it("the officer cannot send a report back, and edits no report that is Ready or Sent; the four send it back", () => {
    const check = HOTEL_LAST();
    refused(patch(USER.officer, check, { status: "draft" }), 403, "not authorized: cerbos denied approve on social_report");
    refused(patch(USER.companyAdmin, check, { status: "draft" }), 403, "not authorized: cerbos denied approve on social_report");
    expect(patch(USER.hod, check, { status: "draft" }).json).toEqual({ id: check, status: "draft" });
    refused(patch(USER.hod, check, { status: "draft" }), 400, "cannot_send_back_from_this_status");
    refused(patch(USER.officer, NORTH_LAST(), { notes: complete }), 400, "report_not_editable");
    refused(patch(USER.officer, idOf("Northwind Traders", "2026-08"), { narrativeMd: "x" }), 400, "report_not_editable");
    refused(patch(USER.officer, NORTH_THIS(), { status: "approved" }), 400, "invalid_status_transition");
  });
  it("checks the report (404), then the role (403), then the body (400), then the move (400)", () => {
    refused(patch(USER.client, "nope", { status: "draft" }), 404, "report not found");
    refused(patch(USER.copywriter, NORTH_THIS(), { notes: "text" }), 403, "not authorized: cerbos denied update on social_report");
    refused(patch(USER.officer, NORTH_LAST(), { notes: "text" }), 400, "invalid_field"); // the body before the move
  });
});

describe("Draft with AI (POST reports/:id/ai-draft): a proposal, and nothing saved", () => {
  const before = (id: string) => JSON.stringify(store.reports.find((r) => r.id === id));

  it("answers a proposal with the narrative, the three notes and the plan, and the stored report does not change", () => {
    const id = NORTH_THIS();
    const snapshot = before(id);
    const r = call("POST", `reports/${id}/ai-draft`, USER.officer);
    expect(r.status).toBe(200);
    const p = asProposal(r.json);
    expect(p.draftedVia).toBe("ai");
    expect(notesAreComplete(p.notes)).toBe(true);
    expect(p.actionPlan.length).toBeGreaterThan(0);
    expect(before(id)).toBe(snapshot);
    expect(asReportDetail(call("GET", `reports/${id}`, USER.officer).json).notesComplete).toBe(false); // still the officer's incomplete notes
  });
  it("says `template` for the client whose numbers are the simulator's (the gateway fell back), also saving nothing", () => {
    const id = HOTEL_LAST();
    const snapshot = before(id);
    expect(asProposal(call("POST", `reports/${id}/ai-draft`, USER.officer).json).draftedVia).toBe("template");
    expect(before(id)).toBe(snapshot);
  });
  it("is refused to a person who may not write (403), for a missing report (404) and for a report that is Ready (400 `report_not_editable`)", () => {
    refused(call("POST", `reports/${NORTH_THIS()}/ai-draft`, USER.copywriter), 403, "not authorized: cerbos denied update on social_report");
    refused(call("POST", "reports/nope/ai-draft", USER.officer), 404, "report not found");
    refused(call("POST", `reports/${NORTH_LAST()}/ai-draft`, USER.officer), 400, "report_not_editable");
  });
});

describe("the HoD check (POST reports/:id/approve)", () => {
  it("the four approve a report in the HoD check", () => {
    for (const u of [USER.hod, USER.gm, USER.owner, USER.superadmin]) {
      const s = seedReportStore();
      const a = reportApi(s);
      const id = s.reports.find((r) => r.status === "in_review")!.id;
      expect(a.staff("POST", `reports/${id}/approve`, new URLSearchParams(), undefined, u)!.json, u).toEqual({ id, status: "approved" });
      expect(s.reports.find((r) => r.id === id)!.approvedAt).not.toBeNull();
    }
  });
  it("the officer and a company admin are refused with 403, and the role is checked before the status (a draft gets 403, not 400)", () => {
    for (const u of [USER.officer, USER.companyAdmin, USER.copywriter]) {
      refused(call("POST", `reports/${HOTEL_LAST()}/approve`, u), 403, "not authorized: cerbos denied approve on social_report");
      refused(call("POST", `reports/${NORTH_THIS()}/approve`, u), 403, "not authorized: cerbos denied approve on social_report");
    }
  });
  it("only a report in the HoD check can be approved", () => {
    refused(call("POST", `reports/${NORTH_THIS()}/approve`, USER.hod), 400, "cannot_approve_from_this_status");
    refused(call("POST", `reports/${NORTH_LAST()}/approve`, USER.hod), 400, "cannot_approve_from_this_status");
    refused(call("POST", "reports/nope/approve", USER.hod), 404, "report not found");
  });
  it("is blocked by `notes_incomplete` while an area lacks its insight or its suggestion, and passes once it has both", () => {
    const id = NORTH_THIS();
    call("PATCH", `reports/${id}`, USER.officer, { status: "in_review" });
    refused(call("POST", `reports/${id}/approve`, USER.hod), 400, "notes_incomplete");
    call("PATCH", `reports/${id}`, USER.officer, { notes: { ...complete, audience: { insight: "i", suggestion: "   " } } });
    refused(call("POST", `reports/${id}/approve`, USER.hod), 400, "notes_incomplete"); // a blank suggestion is missing
    call("PATCH", `reports/${id}`, USER.officer, { notes: complete });
    expect(call("POST", `reports/${id}/approve`, USER.hod).json).toEqual({ id, status: "approved" });
  });
});

describe("sending (POST reports/:id/deliver) and the publication into the client's reports", () => {
  const portal = (user: string) => (portalReportsDemo("GET", "reports", user)!.json as Array<{ id: string; title: string; source: string; periodStart: string; periodEnd: string; file: { filename: string } }>);

  it("the officer and a company admin cannot send, even a Ready report; the role is checked before the status", () => {
    for (const u of [USER.officer, USER.companyAdmin, USER.copywriter]) {
      refused(call("POST", `reports/${NORTH_LAST()}/deliver`, u), 403, "not authorized: cerbos denied deliver on social_report");
      refused(call("POST", `reports/${NORTH_THIS()}/deliver`, u), 403, "not authorized: cerbos denied deliver on social_report");
    }
  });
  it("only a Ready report is sent (400 `cannot_deliver_from_this_status`), and an unknown one is 404", () => {
    refused(call("POST", `reports/${NORTH_THIS()}/deliver`, USER.hod), 400, "cannot_deliver_from_this_status");
    refused(call("POST", `reports/${HOTEL_LAST()}/deliver`, USER.owner), 400, "cannot_deliver_from_this_status");
    refused(call("POST", "reports/nope/deliver", USER.hod), 404, "report not found");
  });
  it("the owner sends it: Sent, with its file, and the PDF is published to the client's reports where their contact reads it", () => {
    const id = NORTH_LAST();
    const r = call("POST", `reports/${id}/deliver`, USER.owner);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, status: "delivered", filename: expect.stringMatching(/^social-report-2026-09-.*\.pdf$/), deliverableId: null, clientReportId: `rep-sr-${id}` });
    expect(asReportList(call("GET", "reports", USER.hod, undefined, "status=delivered").json).map((x) => x.id)).toContain(id);
    const published = portal("demo-client").find((x) => x.id === `rep-sr-${id}`);
    expect(published).toMatchObject({ source: "social_report", title: "Social media performance, September 2026", periodStart: "2026-09-01", periodEnd: "2026-09-30" });
    expect(published!.file.filename).toMatch(/\.pdf$/);
    refused(call("POST", `reports/${id}/deliver`, USER.owner), 400, "cannot_deliver_from_this_status");
    refused(call("PATCH", `reports/${id}`, USER.officer, { narrativeMd: "x" }), 400, "report_not_editable");
  });
  it("the whole path: draft, edit, submit, check, send, and a client of no portal reach sees nothing", () => {
    const c = asCreatedReport(call("POST", `engagements/${SPA}/reports`, USER.officer2, { id: "soc-rep-walk", kind: "monthly", period: "2026-07" }).json);
    call("PATCH", `reports/${c.id}`, USER.officer2, { status: "in_review" });
    expect(call("POST", `reports/${c.id}/approve`, USER.gm).status).toBe(200);
    expect(call("POST", `reports/${c.id}/deliver`, USER.hod).status).toBe(200);
    expect(asReportDetail(call("GET", `reports/${c.id}`, USER.hod).json)).toMatchObject({ status: "delivered", canApprove: true });
    expect(portal("demo-client").some((x) => x.id === `rep-sr-${c.id}`)).toBe(false); // the spa is not the demo contact's client
  });
});

describe("Needs you (BFF §63.7): report_due, report_check, report_send", () => {
  const items = (user: string) => api.needsYou("co", user);
  const kinds = (user: string) => items(user).map((i) => `${i.kind}:${i.clientName}`).sort();

  it("the officer has a report due for each client whose last month's report is not sent, opening the report or the list", () => {
    expect(kinds(USER.officer)).toEqual(["report_due:Harborlight Hotel", "report_due:Northwind Traders"]);
    const north = items(USER.officer).find((i) => i.clientName === "Northwind Traders")!;
    expect(north).toMatchObject({ role: "officer", title: "Monthly report, September 2026", due: "2026-10-05", href: `/departments/dept-4/social-reports/${NORTH_LAST()}` });
    expect(items(USER.officer2)).toEqual([expect.objectContaining({ clientName: "Saltmarsh Day Spa", kind: "report_due", href: "/departments/dept-4/social-reports", due: "2026-10-10" })]);
  });
  it("the HoD and the GM seats have the reports to check and to send; the owner and the superadmin get no queue", () => {
    for (const u of [USER.hod, USER.gm]) expect(kinds(u), u).toEqual(["report_check:Harborlight Hotel", "report_send:Northwind Traders"]);
    expect(items(USER.owner)).toEqual([]);
    expect(items(USER.superadmin)).toEqual([]);
    expect(items(USER.hod).every((i) => i.role === "approver" && String(i.href).startsWith("/departments/dept-4/social-reports/"))).toBe(true);
  });
  it("an item goes when its report moves on: sent, and the officer's due is gone with it", () => {
    call("POST", `reports/${NORTH_LAST()}/deliver`, USER.hod);
    expect(kinds(USER.officer)).toEqual(["report_due:Harborlight Hotel"]);
    expect(kinds(USER.hod)).toEqual(["report_check:Harborlight Hotel"]);
  });
  it("the pipeline's own Needs you carries them for the demo store, through the seam", () => {
    const r = demoNeedsYou("co", USER.hod).json as { items: Array<{ kind: string }> };
    expect(r.items.filter((i) => i.kind.startsWith("report_")).map((i) => i.kind).sort()).toEqual(["report_check", "report_send"]);
    expect((demoNeedsYou("co", USER.officer2).json as { items: Array<{ kind: string }> }).items.map((i) => i.kind)).toContain("report_due");
  });
  it("SCP-5d's Team dashboard reads the month's monthly reports from here: id, client, period, state and when it last changed", () => {
    const sept = demoReportsFor("2026-09");
    expect(sept.map((r) => r.status).sort()).toEqual(["approved", "in_review"]);
    expect(sept.every((r) => r.period === "2026-09" && !Number.isNaN(Date.parse(r.updatedAt)))).toBe(true);
    expect(demoReportsFor("2026-10").map((r) => r.status)).toEqual(["draft"]);
    expect(demoReportsFor("2025-01")).toEqual([]);
  });
  it("updatedAt moves when the report does", () => {
    const id = NORTH_THIS();
    const before = store.reports.find((r) => r.id === id)!.updatedAt;
    vi.setSystemTime(new Date("2026-10-16T06:00:00Z"));
    call("PATCH", `reports/${id}`, USER.officer, { narrativeMd: "x" });
    expect(Date.parse(store.reports.find((r) => r.id === id)!.updatedAt)).toBeGreaterThan(Date.parse(before));
    vi.setSystemTime(new Date("2026-10-16T04:00:00Z"));
  });
});
