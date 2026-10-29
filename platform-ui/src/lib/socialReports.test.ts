import { describe, it, expect } from "vitest";
import {
  ACTION_MAX, ACTION_PLAN_MAX, CHECK_SEND_REASON, DRAFT_REASON, NOTE_MAX, REPORT_REFUSAL_WORDS, REPORT_STATES, REPORT_STATE_WORDS, WRITE_REASON,
  asCreatedReport, asProposal, asReportDetail, asReportList, buildReportBody, buttonsFor, draftedViaWords, dueReportPeriod, emptyAction, filtersHref, formFromDetail, formFromProposal,
  missingNoteLine, missingNotes, notesAreComplete, numbersDocument, parseReportFilters, periodWords, periodsOf, reportRefusalText, reportStateWords, rowStateLine, sortReports,
  type ReportForm, type SocialReportRow,
} from "./socialReports";

// SCP-5a (BFF §63.18): the report's types, its defensive parsing, its words and its form checks. The codes below are the contract's own list (the SMM-23 refusals that stay, and the new
// `notes_incomplete`), so a code added to the server without words here fails this suite.

const doc = (over: Record<string, unknown> = {}) => ({
  header: { tenantId: "co", grain: "company", scopeRef: "e1", scopeName: "Northwind Traders", periodKind: "month", periodStart: "2026-09-01", periodEnd: "2026-09-30", dayCount: 30, periodLabel: "September 2026", generatedAt: "2026-10-05T00:00:00Z", sealed: false },
  kpis: [], series: [], distributions: [], tables: [{ key: "top_posts", label: "Top posts", columns: [], rows: [] }, { key: "notes", label: "Insights and suggestions", columns: [], rows: [] }, { key: "action_plan", label: "Action plan", columns: [], rows: [] }],
  highlights: [], narrative: { source: "deterministic", text: "A summary." }, ...over,
});
const detail = (over: Record<string, unknown> = {}) => ({
  id: "r1", status: "draft", engagementId: "e1", kind: "monthly", period: "2026-09", notes: {}, actionPlan: [], simulated: false, notesComplete: false, canApprove: false, canDeliver: false, document: doc(), ...over,
});
const note = (i = "An insight.", s = "A suggestion.") => ({ insight: i, suggestion: s });
const fullNotes = { followers: note(), engagement: note(), audience: note() };

describe("the four states", () => {
  it("are the design's words, and an unknown state is shown as it came", () => {
    expect(REPORT_STATES.map(reportStateWords)).toEqual(["Draft", "HoD check", "Ready", "Sent"]);
    expect(REPORT_STATE_WORDS).toEqual({ draft: "Draft", in_review: "HoD check", approved: "Ready", delivered: "Sent" });
    expect(reportStateWords("archived")).toBe("archived");
  });
});

describe("asReportList", () => {
  const row = { id: "r1", engagementId: "e1", clientName: "Northwind Traders", period: "2026-09", kind: "monthly", status: "draft", createdAt: "2026-10-01T00:00:00Z", approvedAt: null, deliveredAt: null, notesComplete: false, simulated: true };
  it("reads the contract's rows, with the notes flag and the simulated flag", () => {
    const [r] = asReportList({ reports: [row] });
    expect(r).toMatchObject({ id: "r1", clientName: "Northwind Traders", period: "2026-09", status: "draft", notesComplete: false, simulated: true, approvedAt: null });
  });
  it("throws on a body that is not a list, and on a row that is not a report (the reader turns that into cannot tell)", () => {
    expect(() => asReportList([])).toThrow();
    expect(() => asReportList({ reports: "x" })).toThrow();
    expect(() => asReportList({ reports: [{ id: "r1" }] })).toThrow();
    expect(() => asReportList(null)).toThrow();
  });
  it("sorts newest month first, then by client, and offers the months the rows carry", () => {
    const rows = asReportList({ reports: [{ ...row, id: "a", period: "2026-08", clientName: "Zed" }, { ...row, id: "b", period: "2026-09", clientName: "Zed" }, { ...row, id: "c", period: "2026-09", clientName: "Alpha" }] });
    expect(sortReports(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
    expect(periodsOf(rows)).toEqual(["2026-09", "2026-08"]);
  });
  it("says a state in the row's words, with 'notes incomplete' only where it can still matter", () => {
    const r = (status: string, notesComplete: boolean, kind = "monthly"): Pick<SocialReportRow, "status" | "notesComplete" | "kind"> => ({ status, notesComplete, kind });
    expect(rowStateLine(r("draft", false))).toBe("Draft · notes incomplete");
    expect(rowStateLine(r("in_review", false))).toBe("HoD check · notes incomplete");
    expect(rowStateLine(r("in_review", true))).toBe("HoD check");
    expect(rowStateLine(r("delivered", false))).toBe("Sent");
    expect(rowStateLine(r("draft", true, "campaign"))).toBe("Draft");
  });
});

describe("asReportDetail", () => {
  it("reads the report: its notes, its plan, the flags and the document", () => {
    const d = asReportDetail(detail({ notes: fullNotes, actionPlan: [{ action: "Do it", owner: "client", due: "2026-10-20" }, { action: "Then this", owner: "agency" }], simulated: true, notesComplete: true, canApprove: true }));
    expect(d.notes.followers).toEqual(note());
    expect(d.actionPlan).toEqual([{ action: "Do it", owner: "client", due: "2026-10-20" }, { action: "Then this", owner: "agency" }]);
    expect(d).toMatchObject({ simulated: true, notesComplete: true, canApprove: true, canDeliver: false, kind: "monthly", period: "2026-09" });
    expect(d.document.header.scopeName).toBe("Northwind Traders");
  });
  it("reads a missing area as nothing written, never as invented text", () => {
    expect(asReportDetail(detail({ notes: { followers: note() } })).notes).toEqual({ followers: note() });
  });
  it("throws on a body that is not a report, or whose document is not a document", () => {
    expect(() => asReportDetail({ id: "r1" })).toThrow();
    expect(() => asReportDetail(detail({ document: { header: {} } }))).toThrow();
    expect(() => asReportDetail(detail({ document: null }))).toThrow();
  });
  it("a campaign report with notesComplete true is normal: the notes rule is the monthly report's", () => {
    expect(asReportDetail(detail({ kind: "campaign", notesComplete: true })).notesComplete).toBe(true);
  });
  it("the numbers the page draws leave out the two form tables, so nothing shows twice; the document itself is whole", () => {
    const d = asReportDetail(detail());
    expect(numbersDocument(d.document).tables.map((t) => t.key)).toEqual(["top_posts"]);
    expect(d.document.tables.map((t) => t.key)).toEqual(["top_posts", "notes", "action_plan"]);
  });
});

describe("the proposal and the created report", () => {
  it("answers `ai` or `template` for an ai-draft; any other value is the plain template", () => {
    const raw = { narrativeMd: "N", notes: fullNotes, actionPlan: [{ action: "A", owner: "agency" }] };
    expect(asProposal({ ...raw, draftedVia: "ai" }).draftedVia).toBe("ai");
    expect(asProposal({ ...raw, draftedVia: "template" }).draftedVia).toBe("template");
    expect(asProposal({ ...raw, draftedVia: "fallback" }).draftedVia).toBe("template");
    expect(() => asProposal({ narrativeMd: 1 })).toThrow();
  });
  it("a create answers `ai`, `fallback` or `existing`, and every one has words", () => {
    for (const via of ["ai", "fallback", "existing"]) expect(asCreatedReport({ id: "r1", status: "draft", draftedVia: via }).draftedVia).toBe(via);
    expect(draftedViaWords("ai")).toMatch(/Drafted with AI/);
    for (const via of ["template", "fallback"]) expect(draftedViaWords(via)).toMatch(/plain template/);
    expect(draftedViaWords("existing")).toMatch(/already has a report/);
    expect(() => asCreatedReport({ status: "draft" })).toThrow();
  });
  it("a proposal fills the form and keeps the report's own saved state apart", () => {
    const proposal = asProposal({ narrativeMd: "New", notes: fullNotes, actionPlan: [{ action: "A", owner: "client", due: "2026-10-02" }], draftedVia: "ai" });
    const f = formFromProposal(proposal);
    expect(f.narrative).toBe("New");
    expect(f.actions).toEqual([{ action: "A", owner: "client", due: "2026-10-02" }]);
    const base = formFromDetail(asReportDetail(detail()));
    expect(base.notes.followers).toEqual({ insight: "", suggestion: "" });
  });
});

describe("the notes rule", () => {
  it("is complete only when every area has an insight and a suggestion that are not blank", () => {
    expect(notesAreComplete(fullNotes)).toBe(true);
    expect(notesAreComplete({ ...fullNotes, audience: note("   ", "x") })).toBe(false);
    expect(notesAreComplete({ followers: note() })).toBe(false);
  });
  it("says what is missing, area by area", () => {
    const m = missingNotes({ followers: note(), engagement: note("", "ok"), audience: note("ok", "") });
    expect(m.map(missingNoteLine)).toEqual(["Engagement: the insight is missing.", "Audience: the suggestion is missing."]);
    expect(missingNotes({}).map(missingNoteLine)).toEqual([
      "Followers: the insight and the suggestion are missing.", "Engagement: the insight and the suggestion are missing.", "Audience: the insight and the suggestion are missing.",
    ]);
  });
});

describe("the form's checks (the server's own shapes)", () => {
  const form = (over: Partial<ReportForm> = {}): ReportForm => ({ narrative: "N", notes: { followers: note(), engagement: note(), audience: note() }, actions: [], ...over });
  it("builds the PATCH body from what was typed, dropping a blank due date", () => {
    const r = buildReportBody(form({ actions: [{ action: "Do it", owner: "client", due: "2026-10-20" }, { action: "Then this", owner: "agency", due: "" }] }));
    expect(r).toEqual({ ok: true, body: { narrativeMd: "N", notes: fullNotes, actionPlan: [{ action: "Do it", owner: "client", due: "2026-10-20" }, { action: "Then this", owner: "agency" }] } });
  });
  it(`refuses a note over ${NOTE_MAX} characters, naming the area and the field`, () => {
    const f = form();
    f.notes.audience.suggestion = "x".repeat(NOTE_MAX + 1);
    expect(buildReportBody(f)).toEqual({ ok: false, field: "notes.audience.suggestion", message: `Audience: the suggestion is over ${NOTE_MAX} characters.` });
    f.notes.audience.suggestion = "x".repeat(NOTE_MAX);
    expect(buildReportBody(f).ok).toBe(true);
  });
  it(`refuses more than ${ACTION_PLAN_MAX} actions, a blank or over-long action, and a due date that is not a date`, () => {
    const rows = Array.from({ length: ACTION_PLAN_MAX + 1 }, () => ({ ...emptyAction(), action: "x" }));
    expect(buildReportBody(form({ actions: rows }))).toMatchObject({ ok: false, field: "actionPlan" });
    expect(buildReportBody(form({ actions: rows.slice(0, ACTION_PLAN_MAX) })).ok).toBe(true);
    expect(buildReportBody(form({ actions: [{ ...emptyAction(), action: "  " }] }))).toMatchObject({ ok: false, field: "actionPlan.0.action", message: "Action 1: write the action, or remove the row." });
    expect(buildReportBody(form({ actions: [{ ...emptyAction(), action: "x".repeat(ACTION_MAX + 1) }] }))).toMatchObject({ ok: false, field: "actionPlan.0.action" });
    expect(buildReportBody(form({ actions: [{ ...emptyAction(), action: "x".repeat(ACTION_MAX) }] })).ok).toBe(true);
    expect(buildReportBody(form({ actions: [{ ...emptyAction(), action: "x", due: "2026-02-30" }] }))).toMatchObject({ ok: false, field: "actionPlan.0.due" });
  });
});

describe("the refusals, in words", () => {
  const CODES = [
    "invalid_kind", "internal_client_no_reports", "cannot_submit_from_this_status", "cannot_send_back_from_this_status", "invalid_status_transition", "report_not_editable",
    "status_changed_concurrently", "cannot_approve_from_this_status", "internal_client_not_deliverable", "cannot_deliver_from_this_status", "pdf_render_not_configured", "pdf_render_failed",
    "notes_incomplete",
  ];
  it("has a sentence for every code of BFF §63.18, never the bare code", () => {
    for (const code of CODES) {
      const words = reportRefusalText({ status: code.startsWith("pdf_") ? 503 : 400, error: code });
      expect(words, code).toBe(REPORT_REFUSAL_WORDS[code]);
      expect(words, code).not.toBe(code);
      expect(words, code).toMatch(/\s/);
    }
  });
  it("a 403 says who may do what was asked (SCP-Q20): the four check and send; the officer writes and submits", () => {
    const f = { status: 403, error: "not authorized: cerbos denied approve on social_report" };
    for (const kind of ["approve", "send_back", "deliver"] as const) expect(reportRefusalText(f, kind)).toBe(`You cannot do this. ${CHECK_SEND_REASON}`);
    expect(reportRefusalText(f, "create")).toBe(`You cannot do this. ${DRAFT_REASON}`);
    for (const kind of ["save", "submit", "ai_draft"] as const) expect(reportRefusalText(f, kind)).toBe(`You cannot do this. ${WRITE_REASON}`);
    expect(CHECK_SEND_REASON).toMatch(/Social Media head, the GM, the owner and the superadmin/);
    expect(CHECK_SEND_REASON).toMatch(/officer writes it and submits it/);
  });
  it("a 400 that names the field says what that field wants, and a 404 says the report or client is gone", () => {
    expect(reportRefusalText({ status: 400, error: "invalid_field", field: "notes" })).toMatch(/Each area has an insight and a suggestion of at most 500 characters/);
    expect(reportRefusalText({ status: 400, error: "invalid_field", field: "actionPlan" })).toMatch(/at most 10 actions/);
    expect(reportRefusalText({ status: 404, error: "report not found" })).toMatch(/report was not found/);
    expect(reportRefusalText({ status: 404, error: "engagement not found" }, "create")).toMatch(/client was not found/);
  });
  it("a refusal for a stronger sign-in keeps its own sentence", () => {
    expect(reportRefusalText({ status: 403, error: "not authorized", reason: "assurance_required" }, "approve")).toMatch(/second factor/);
  });
});

describe("the buttons by state and by the server's two flags", () => {
  const b = (status: string, flags: Partial<{ canApprove: boolean; canDeliver: boolean; notesComplete: boolean }> = {}, dirty = false) =>
    buttonsFor({ status, canApprove: false, canDeliver: false, notesComplete: true, ...flags }, { dirty });

  it("Draft: edit, save, Draft with AI and submit; nothing of the check or of sending", () => {
    const x = b("draft");
    expect(x).toMatchObject({ editable: true, save: true, aiDraft: true, submit: true });
    expect(x.approve.shown || x.sendBack.shown || x.deliver.shown).toBe(false);
  });
  it("HoD check: still editable, and the four approve or send back; the officer sees both disabled with the reason", () => {
    const four = b("in_review", { canApprove: true });
    expect(four).toMatchObject({ editable: true, submit: false });
    expect(four.approve).toEqual({ shown: true, allowed: true, reason: null });
    expect(four.sendBack).toEqual({ shown: true, allowed: true, reason: null });
    const officer = b("in_review", { canApprove: false });
    expect(officer.approve).toEqual({ shown: true, allowed: false, reason: CHECK_SEND_REASON });
    expect(officer.sendBack).toEqual({ shown: true, allowed: false, reason: CHECK_SEND_REASON });
  });
  it("Approve waits, with the reason, while the notes are incomplete or while the form has unsaved changes", () => {
    expect(b("in_review", { canApprove: true, notesComplete: false }).approve).toMatchObject({ allowed: false, reason: expect.stringMatching(/insight and a suggestion/) });
    expect(b("in_review", { canApprove: true }, true).approve).toMatchObject({ allowed: false, reason: expect.stringMatching(/Save your changes first/) });
  });
  it("Ready: read-only, and only the four send; Sent: read-only with nothing to press", () => {
    expect(b("approved", { canDeliver: true })).toMatchObject({ editable: false, save: false, aiDraft: false, submit: false, deliver: { shown: true, allowed: true, reason: null } });
    expect(b("approved", { canDeliver: false }).deliver).toEqual({ shown: true, allowed: false, reason: CHECK_SEND_REASON });
    const sent = b("delivered", { canApprove: true, canDeliver: true });
    expect(sent).toMatchObject({ editable: false, save: false, submit: false });
    expect(sent.approve.shown || sent.sendBack.shown || sent.deliver.shown).toBe(false);
  });
});

describe("periods and filters", () => {
  it("names a month, and the month a report is due for (the month before today's)", () => {
    expect(periodWords("2026-09")).toBe("September 2026");
    expect(periodWords(null)).toBe("No period");
    expect(dueReportPeriod("2026-10-16")).toBe("2026-09");
    expect(dueReportPeriod("2026-01-02")).toBe("2025-12");
  });
  it("reads the list's filters from the query, ignoring a value that is not one", () => {
    expect(parseReportFilters({ status: "in_review", period: "2026-09" })).toEqual({ status: "in_review", period: "2026-09" });
    expect(parseReportFilters({ status: "bogus", period: "2026-13" })).toEqual({ status: null, period: null });
    expect(parseReportFilters({ status: ["draft", "approved"] })).toEqual({ status: "draft", period: null });
    expect(filtersHref("d-soc", { status: "approved", period: null })).toBe("/departments/d-soc/social-reports?status=approved");
    expect(filtersHref("d-soc", { status: null, period: null })).toBe("/departments/d-soc/social-reports");
  });
});
