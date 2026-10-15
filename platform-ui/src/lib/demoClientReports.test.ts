import { beforeEach, describe, expect, it } from "vitest";
import { getDemoResponse } from "./demoFixtures";
import { resetDemoClientReports } from "./demoClientReports";
import type { PortalReport } from "./portal";
import type { StaffClientReport } from "./clientReports";

// PV7-04b — the demo twins of BFF §55: field names exactly as the contract, the controllers' refusals, the per-identity reach,
// and one store shared by both sides (publishing on the staff tab shows in the portal; withdrawing takes it away).

const T = "co-agency";
const HANSEL = "demo-hansel";
const CLIENT = "demo-client";          // Northwind client-wide AND Demo Harbour Hotel through ONE project
const VIEWER = "demo-client-viewer";   // Northwind client-wide only

const staffList = (cid = "cl-1", user = HANSEL) => getDemoResponse("GET", `/api/${T}/clients/${cid}/reports`, user);
const staffReports = (cid = "cl-1") => (staffList(cid).json as { reports: StaffClientReport[] }).reports;
const publish = (id: string, user = HANSEL) => getDemoResponse("POST", `/api/${T}/client-reports/${id}/publish`, user);
const withdraw = (id: string, reason: unknown, user = HANSEL) =>
  getDemoResponse("POST", `/api/${T}/client-reports/${id}/withdraw`, user, JSON.stringify({ reason }));
const portalList = (user: string) => getDemoResponse("GET", `/api/${T}/portal/reports`, user);
const portalReports = (user: string) => portalList(user).json as PortalReport[];
const overview = (user: string) => getDemoResponse("GET", `/api/${T}/portal/overview`, user).json as { newReports: number };
const deliverables = (user: string) => getDemoResponse("GET", `/api/${T}/portal/deliverables`, user).json as Array<{ id: string; reportId: string | null }>;

beforeEach(() => { resetDemoClientReports(); });

describe("demo staff reports · GET :t/clients/:clientId/reports (§55.3)", () => {
  it("has exactly the contract's fields, every status, and a draft, a published and a withdrawn report", () => {
    const r = staffList();
    expect(r.status).toBe(200);
    const rows = (r.json as { reports: StaffClientReport[] }).reports;
    expect(new Set(rows.map((x) => x.status))).toEqual(new Set(["draft", "published", "withdrawn"]));
    for (const x of rows) {
      const base = [
        "clientId", "clientVisible", "createdAt", "deliverableId", "file", "id", "periodEnd", "periodStart", "projectId", "projectName",
        "publishedAt", "publishedByName", "readCount", "source", "sourceId", "status", "title", "withdrawnAt", "withdrawnByName", "withdrawnReason",
      ];
      // PV7-07 (BFF §56.3): an account summary alone carries the month, the narrative, who wrote it, when it was read and the snapshot.
      const summary = ["generatedAt", "narrativeMd", "narrativeSource", "period", "snapshot"];
      expect(Object.keys(x).sort()).toEqual((x.source === "account_summary" ? [...base, ...summary] : base).sort());
      expect(x.periodStart <= x.periodEnd).toBe(true);
      // The stamp rules of the table: published and withdrawn carry who and when; a draft carries neither; a reason only when withdrawn.
      expect(x.publishedAt === null).toBe(x.status === "draft");
      expect(x.publishedByName === null).toBe(x.status === "draft");
      expect(x.withdrawnReason !== null).toBe(x.status === "withdrawn");
    }
    // clientVisible is the backend's answer: only a published report is in front of the client.
    expect(rows.filter((x) => x.clientVisible).every((x) => x.status === "published")).toBe(true);
  });

  it("carries the file's content type: search is Markdown, social is PDF", () => {
    const rows = staffReports();
    expect(rows.find((x) => x.source === "search_report" && x.file)!.file!.contentType).toBe("text/markdown");
    expect(rows.find((x) => x.source === "social_report" && x.file)!.file!.contentType).toBe("application/pdf");
  });

  it("refuses a caller who may not read client reports (403), and answers a client with none as an empty list", () => {
    expect(staffList("cl-1", "demo-client").status).toBe(403);
    expect((staffList("cl-2").json as { reports: unknown[] }).reports).toEqual([]);
  });
});

describe("demo publish and withdraw (§55.3), with the controllers' own refusals", () => {
  it("publish: a draft with a file goes out; a repeat is 409 not_a_draft; a draft with no file is 409 report_has_no_file", () => {
    const draft = staffReports().find((x) => x.status === "draft" && x.file)!;
    // An account summary has no file until Publish renders one (§56.3), so the "no file" draft is a module-source one.
    const noFile = staffReports().find((x) => x.status === "draft" && !x.file && x.source !== "account_summary")!;
    const ok = publish(draft.id);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ id: draft.id, status: "published" });
    expect(staffReports().find((x) => x.id === draft.id)).toMatchObject({ status: "published", publishedByName: "Hansel Gaiada", clientVisible: true });
    expect(publish(draft.id)).toMatchObject({ status: 409, json: { error: "not_a_draft" } });
    expect(publish(noFile.id)).toMatchObject({ status: 409, json: { error: "report_has_no_file" } });
    expect(publish("nope").status).toBe(404);
  });

  it("withdraw: needs a reason (400 reason_required, 400 reason_too_long), a published report (409 not_published), then keeps the reason", () => {
    const pub = staffReports().find((x) => x.status === "published")!;
    expect(withdraw(pub.id, "")).toMatchObject({ status: 400, json: { error: "reason_required" } });
    expect(withdraw(pub.id, "   ")).toMatchObject({ status: 400, json: { error: "reason_required" } });
    expect(withdraw(pub.id, undefined)).toMatchObject({ status: 400, json: { error: "reason_required" } });
    expect(withdraw(pub.id, "x".repeat(2001))).toMatchObject({ status: 400, json: { error: "reason_too_long" } });
    const ok = withdraw(pub.id, "  Wrong figures  ");
    expect(ok.status).toBe(200);
    expect(staffReports().find((x) => x.id === pub.id)).toMatchObject({ status: "withdrawn", withdrawnReason: "Wrong figures", clientVisible: false });
    expect(withdraw(pub.id, "again")).toMatchObject({ status: 409, json: { error: "not_published" } });
    const draft = staffReports().find((x) => x.status === "draft")!;
    expect(withdraw(draft.id, "x")).toMatchObject({ status: 409, json: { error: "not_published" } });
  });

  it("authorizes first: a caller who may read but not write is 403 even with an empty body, and a stranger is 403 before the 404", () => {
    const draft = staffReports().find((x) => x.status === "draft" && x.file)!;
    expect(publish(draft.id, "dept-manager").status).toBe(403);
    expect(withdraw(draft.id, "", "dept-manager").status).toBe(403);
    expect(publish("nope", "demo-client").status).toBe(403);
  });
});

describe("demo portal reports · GET :t/portal/reports (§55.4)", () => {
  it("has exactly the contract's fields and never a status, source id, publisher or reason", () => {
    const rows = portalReports(VIEWER);
    expect(rows.length).toBeGreaterThan(0);
    for (const x of rows) {
      expect(Object.keys(x).sort()).toEqual([
        "clientId", "clientName", "file", "id", "periodEnd", "periodStart", "projectId", "projectName", "publishedAt", "readAt", "source", "title",
      ]);
      expect(Object.keys(x.file).sort()).toEqual(["byteSize", "contentType", "filename", "id"]);
    }
    expect(JSON.stringify(rows)).not.toMatch(/withdrawn|publishedBy|sourceId|Ad spend/i);
  });

  it("a Northwind client-wide contact sees the client-wide report and the project report, newest first; no draft, no withdrawn", () => {
    const rows = portalReports(VIEWER);
    expect(rows.map((x) => x.id)).toEqual(["rep-1", "rep-2"]);
    expect(rows[0]).toMatchObject({ projectId: null, projectName: null });
    expect(rows[1]).toMatchObject({ projectId: "proj-nw-site", projectName: "Website relaunch" });
    expect(rows.some((x) => x.clientId !== "cl-1")).toBe(false);
  });

  it("the project-scoped Harbour contact sees only its project's report there, never Harbour's client-wide one", () => {
    const rows = portalReports(CLIENT);
    const harbour = rows.filter((x) => x.clientId === "cl-harbour");
    expect(harbour.map((x) => x.id)).toEqual(["rep-5"]);
    expect(harbour[0].projectId).toBe("proj-hb-spa");
    expect(rows.map((x) => x.id)).not.toContain("rep-6");
    // ...and still sees Northwind's two.
    expect(rows.filter((x) => x.clientId === "cl-1").map((x) => x.id).sort()).toEqual(["rep-1", "rep-2"]);
  });

  it("refuses a caller who is not a portal client (403)", () => {
    expect(portalList(HANSEL).status).toBe(403);
  });

  it("the read marker: New until opened, the first read is kept, and a report out of reach or unpublished is 404", () => {
    expect(portalReports(VIEWER).find((x) => x.id === "rep-1")!.readAt).toBeNull();
    const first = getDemoResponse("POST", `/api/${T}/portal/reports/rep-1/read`, VIEWER);
    expect(first.status).toBe(200);
    const at = (first.json as { readAt: string }).readAt;
    expect(portalReports(VIEWER).find((x) => x.id === "rep-1")!.readAt).toBe(at);
    expect(((getDemoResponse("POST", `/api/${T}/portal/reports/rep-1/read`, VIEWER)).json as { readAt: string }).readAt).toBe(at);
    // Per user: another contact still sees it as New.
    expect(portalReports("demo-client-admin").find((x) => x.id === "rep-1")!.readAt).toBeNull();
    for (const id of ["rep-3", "rep-4", "nope"]) expect(getDemoResponse("POST", `/api/${T}/portal/reports/${id}/read`, VIEWER).status).toBe(404);
    // rep-6 is Harbour's client-wide report: out of reach for the project-scoped contact.
    expect(getDemoResponse("POST", `/api/${T}/portal/reports/rep-6/read`, CLIENT).status).toBe(404);
  });
});

describe("demo portal Overview and Deliverables additions (§55.4)", () => {
  it("newReports counts the published, in-reach, unread reports of this user, and drops as they are opened", () => {
    // VIEWER: rep-1 and rep-2 unread. demo-client already opened rep-2, and also reaches Harbour's rep-5.
    expect(overview(VIEWER).newReports).toBe(2);
    expect(overview(CLIENT).newReports).toBe(2);
    getDemoResponse("POST", `/api/${T}/portal/reports/rep-1/read`, VIEWER);
    expect(overview(VIEWER).newReports).toBe(1);
  });

  it("a deliverable gains reportId only while a published in-reach report links it", () => {
    expect(deliverables(VIEWER).find((d) => d.id === "del-2")!.reportId).toBe("rep-2");
    expect(deliverables(VIEWER).filter((d) => d.reportId !== null)).toHaveLength(1);
    withdraw("rep-2", "Wrong period");
    expect(deliverables(VIEWER).find((d) => d.id === "del-2")!.reportId).toBeNull();
  });

  it("one store for both sides: publishing a draft shows it to the portal and counts as new; withdrawing removes it", () => {
    const before = portalReports(VIEWER).length;
    publish("rep-3");
    expect(portalReports(VIEWER)).toHaveLength(before + 1);
    expect(overview(VIEWER).newReports).toBe(3);
    withdraw("rep-3", "Published by mistake");
    expect(portalReports(VIEWER)).toHaveLength(before);
    expect(overview(VIEWER).newReports).toBe(2);
  });

  it("a report file in the portal answers with a labelled placeholder, and is a 404 once withdrawn", () => {
    const f = getDemoResponse("GET", `/api/${T}/portal/files/file-report-1`, VIEWER);
    expect(f.status).toBe(200);
    expect(JSON.stringify(f.json)).toMatch(/DEMO MODE: placeholder/);
    withdraw("rep-1", "x");
    expect(getDemoResponse("GET", `/api/${T}/portal/files/file-report-1`, VIEWER).status).toBe(404);
  });
});
