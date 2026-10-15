import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { resetDemoClientReports } from "./demoClientReports";
import type { PortalReport } from "./portal";
import type { StaffClientReport } from "./clientReports";

// PV7-07 — the demo twins of BFF §56: draft an account summary, edit its narrative, publish it (which makes its own file), with the
// controllers' own refusals in the controllers' own order, and the shared store (a published summary reaches the portal's client-wide
// contacts; a draft never does).

const T = "co-agency";
const HANSEL = "demo-hansel";
const READER = "dept-manager";         // may read client reports, may not draft or publish
const STRANGER = "demo-client";        // not staff
const VIEWER = "demo-client-viewer";   // Northwind client-wide only

const draftPost = (cid: string, body: unknown, user = HANSEL) =>
  getDemoResponse("POST", `/api/${T}/clients/${cid}/reports/summary`, user, typeof body === "string" ? body : JSON.stringify(body));
const patch = (id: string, body: unknown, user = HANSEL) =>
  getDemoResponse("PATCH", `/api/${T}/client-reports/${id}`, user, JSON.stringify(body));
const publish = (id: string, user = HANSEL) => getDemoResponse("POST", `/api/${T}/client-reports/${id}/publish`, user);
const staffReports = (cid = "cl-1") => (getDemoResponse("GET", `/api/${T}/clients/${cid}/reports`, HANSEL).json as { reports: StaffClientReport[] }).reports;
const portalReports = (user: string) => getDemoResponse("GET", `/api/${T}/portal/reports`, user).json as PortalReport[];
const thisMonth = () => new Date().toISOString().slice(0, 7);

beforeEach(() => { resetDemoClientReports(); });

describe("demo: draft an account summary (§56.3)", () => {
  it("makes a draft with a frozen snapshot and a narrative, and no file", () => {
    const r = draftPost("cl-1", { period: "2026-08" });
    expect(r.status).toBe(200);
    const { created, report } = r.json as { created: boolean; report: StaffClientReport };
    expect(created).toBe(true);
    expect(report).toMatchObject({ source: "account_summary", status: "draft", clientId: "cl-1", period: "2026-08", periodStart: "2026-08-01", periodEnd: "2026-08-31", file: null, narrativeSource: "deterministic", clientVisible: false });
    expect(report.title).toBe("Account summary, August 2026");
    expect(report.snapshot!.period).toBe("2026-08");
    expect(report.narrativeMd).toContain("August 2026");
    expect(staffReports().some((x) => x.id === report.id)).toBe(true);
  });

  it("a second request for the same month returns the existing draft (created: false) and adds nothing", () => {
    const first = (draftPost("cl-1", { period: "2026-08" }).json as { report: StaffClientReport }).report;
    const before = staffReports().length;
    const second = draftPost("cl-1", { period: "2026-08" });
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({ created: false, report: { id: first.id } });
    expect(staffReports()).toHaveLength(before);
    // The seed already has a September draft for Northwind: asking for it returns that one.
    const seeded = (draftPost("cl-1", { period: "2026-09" }).json as { created: boolean; report: StaffClientReport });
    expect(seeded.created).toBe(false);
    expect(seeded.report.id).toBe("rep-8");
  });

  it("refuses, in the controller's order: read (403), the client (404), the draft action (403), THEN the body (400)", () => {
    expect(draftPost("cl-1", { period: "nonsense" }, STRANGER).status).toBe(403);
    expect(draftPost("nope", { period: "2026-08" }, STRANGER).status).toBe(403);   // read comes before the 404
    expect(draftPost("nope", { period: "2026-08" }).status).toBe(404);
    expect(draftPost("cl-1", { period: "nonsense" }, READER).status).toBe(403);    // may read, may not draft: the bad body is not looked at
    for (const bad of [{ period: "2026-13" }, { period: "2026-9" }, { period: "" }, {}, { period: 202609 }, "not json"]) {
      const r = draftPost("cl-1", bad);
      expect(r, JSON.stringify(bad)).toMatchObject({ status: 400, json: { error: "invalid_period" } });
    }
    expect(draftPost("cl-1", { period: "2099-01" })).toMatchObject({ status: 400, json: { error: "period_in_future" } });
    expect(draftPost("cl-1", { period: thisMonth() }).status).toBe(200); // this month is allowed (a part month)
  });

  it("a published summary blocks a re-draft of its month (409 summary_published) until it is withdrawn", () => {
    const id = (draftPost("cl-1", { period: "2026-07" }).json as { report: StaffClientReport }).report.id;
    expect(publish(id).status).toBe(200);
    expect(draftPost("cl-1", { period: "2026-07" })).toMatchObject({ status: 409, json: { error: "summary_published" } });
    expect(getDemoResponse("POST", `/api/${T}/client-reports/${id}/withdraw`, HANSEL, JSON.stringify({ reason: "Wrong" })).status).toBe(200);
    expect(draftPost("cl-1", { period: "2026-07" })).toMatchObject({ status: 200, json: { created: true } });
  });

  it("the snapshot carries none of the things the summary must never show: money, tasks, time, people, internal gates", () => {
    const r = (draftPost("cl-1", { period: "2026-08" }).json as { report: StaffClientReport }).report;
    const body = JSON.stringify(r.snapshot) + r.narrativeMd;
    expect(body).not.toMatch(/conversion_value|invoice|payment|amount|currency|IDR|USD|\$\d|task|minutes|hours|assignee|owner|gate/i);
  });
});

describe("demo: edit the narrative (§56.3)", () => {
  const draftId = () => (draftPost("cl-1", { period: "2026-06" }).json as { report: StaffClientReport }).report.id;

  it("a staff edit makes it human-written, trims it, and leaves the frozen snapshot alone", () => {
    const id = draftId();
    const before = staffReports().find((x) => x.id === id)!;
    const r = patch(id, { narrativeMd: "  Our own words.  " });
    expect(r.status).toBe(200);
    const report = (r.json as { report: StaffClientReport }).report;
    expect(report).toMatchObject({ id, narrativeMd: "Our own words.", narrativeSource: "human", status: "draft" });
    expect(report.snapshot).toEqual(before.snapshot);
  });

  it("refuses: read, the draft action, THEN the state and the body", () => {
    const id = draftId();
    expect(patch(id, {}, STRANGER).status).toBe(403);
    expect(patch(id, {}, READER).status).toBe(403);           // may read, may not draft: the empty body is not looked at
    expect(patch("nope", { narrativeMd: "x" }, READER).status).toBe(404);
    expect(patch("nope", { narrativeMd: "x" }).status).toBe(404);
    expect(patch("rep-1", { narrativeMd: "x" })).toMatchObject({ status: 409, json: { error: "not_an_account_summary" } });
    for (const bad of [{ narrativeMd: "   " }, { narrativeMd: 5 }, {}]) expect(patch(id, bad)).toMatchObject({ status: 400, json: { error: "narrative_required" } });
    expect(patch(id, { narrativeMd: "x".repeat(20_001) })).toMatchObject({ status: 400, json: { error: "narrative_too_long" } });
  });

  it("is refused once published (409 not_a_draft)", () => {
    const id = draftId();
    expect(publish(id).status).toBe(200);
    expect(patch(id, { narrativeMd: "late" })).toMatchObject({ status: 409, json: { error: "not_a_draft" } });
  });
});

describe("demo: publish a summary (§56.3)", () => {
  it("makes its own PDF file and publishes, with no file beforehand; the client-wide contact then sees it in the portal", () => {
    const id = (draftPost("cl-1", { period: "2026-05" }).json as { report: StaffClientReport }).report.id;
    expect(staffReports().find((x) => x.id === id)!.file).toBeNull();
    const before = portalReports(VIEWER).length;
    const r = publish(id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ id, status: "published" });
    const row = staffReports().find((x) => x.id === id)!;
    expect(row).toMatchObject({ status: "published", clientVisible: true, publishedByName: "Hansel Gaiada" });
    expect(row.file).toMatchObject({ contentType: "application/pdf", filename: "account-summary-2026-05.pdf" });
    const rows = portalReports(VIEWER);
    expect(rows).toHaveLength(before + 1);
    expect(rows.find((x) => x.id === id)).toMatchObject({ source: "account_summary", projectId: null, title: "Account summary, May 2026" });
    expect(publish(id)).toMatchObject({ status: 409, json: { error: "not_a_draft" } });
  });

  it("the seeded draft is not in front of the client until it is published", () => {
    expect(portalReports(VIEWER).some((x) => x.id === "rep-8")).toBe(false);
    expect(publish("rep-8").status).toBe(200);
    expect(portalReports(VIEWER).some((x) => x.id === "rep-8")).toBe(true);
  });
});
