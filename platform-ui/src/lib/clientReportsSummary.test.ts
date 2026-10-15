import { describe, it, expect } from "vitest";
import {
  NARRATIVE_SOURCE_LABEL, SUMMARY_NARRATIVE_MAX, draftSummaryErrorText, lastMonth, narrativeState, publishErrorText, reportActions,
  saveNarrativeErrorText, summaryPeriodLabel, thisMonth, validSummaryMonth,
} from "./clientReports";

// PV7-07 — the account summary's pure rules (BFF §56): the month picker's default and bounds, the narrative bounds, and the
// refusals in words. The wire shapes are pinned by the demo suite and the page tests.

describe("the month picker", () => {
  it("defaults to the month before now (UTC), across a year boundary", () => {
    expect(lastMonth(new Date("2026-10-15T09:00:00Z"))).toBe("2026-09");
    expect(lastMonth(new Date("2026-01-01T00:00:00Z"))).toBe("2025-12");
    expect(lastMonth(new Date("2026-03-31T23:59:59Z"))).toBe("2026-02");
    expect(thisMonth(new Date("2026-10-15T09:00:00Z"))).toBe("2026-10");
  });
  it("accepts this month and earlier, refuses a future month and anything that is not YYYY-MM", () => {
    const now = new Date("2026-10-15T09:00:00Z");
    for (const ok of ["2026-10", "2026-09", "2024-02", "2000-01"]) expect(validSummaryMonth(ok, now), ok).toBe(true);
    for (const bad of ["2026-11", "2027-01", "2026-13", "2026-00", "2026-9", "26-09", "", "2026-10-01", "1999-12", " 2026-09"]) {
      expect(validSummaryMonth(bad, now), bad).toBe(false);
    }
  });
  it("labels a month in words and leaves anything else alone", () => {
    expect(summaryPeriodLabel("2026-09")).toBe("September 2026");
    expect(summaryPeriodLabel("2026-12")).toBe("December 2026");
    expect(summaryPeriodLabel("2026-13")).toBe("2026-13");
    expect(summaryPeriodLabel("nonsense")).toBe("nonsense");
  });
});

describe("the narrative", () => {
  it("is required and bounded at the backend's length", () => {
    expect(narrativeState("")).toMatchObject({ canSave: false });
    expect(narrativeState("   \n ")).toMatchObject({ canSave: false });
    expect(narrativeState("A month of progress.")).toEqual({ canSave: true, hint: null });
    expect(narrativeState("x".repeat(SUMMARY_NARRATIVE_MAX))).toEqual({ canSave: true, hint: null });
    const over = narrativeState("x".repeat(SUMMARY_NARRATIVE_MAX + 1));
    expect(over.canSave).toBe(false);
    expect(over.hint).toContain("20000");
  });
  it("says who wrote it in words, never a code", () => {
    expect(NARRATIVE_SOURCE_LABEL.human).toBe("Written by staff");
    for (const label of Object.values(NARRATIVE_SOURCE_LABEL)) expect(label).not.toMatch(/^(ai|human|deterministic)$/);
  });
});

describe("Publish for an account summary", () => {
  const file = { id: "f", filename: "a.pdf", contentType: "application/pdf", byteSize: 1 };
  it("needs no file beforehand (the platform renders it); every other draft still does", () => {
    expect(reportActions({ status: "draft", file: null, source: "account_summary" })).toEqual({ canPublish: true, canWithdraw: false, publishBlockedReason: null });
    expect(reportActions({ status: "draft", file: null, source: "social_report" }).publishBlockedReason).toMatch(/no file yet/);
    expect(reportActions({ status: "draft", file: null }).publishBlockedReason).toMatch(/no file yet/);
    expect(reportActions({ status: "draft", file, source: "account_summary" }).publishBlockedReason).toBeNull();
    expect(reportActions({ status: "published", file, source: "account_summary" })).toMatchObject({ canPublish: false, canWithdraw: true });
  });
  it("says a render failure, an unconfigured renderer and a racing edit in words", () => {
    expect(publishErrorText(503, "pdf_render_failed")).toMatch(/PDF could not be made/);
    expect(publishErrorText(503, "pdf_render_failed")).toMatch(/stays a draft/);
    expect(publishErrorText(503, "pdf_render_not_configured")).toMatch(/renderer is not set up/);
    expect(publishErrorText(409, "draft_changed")).toMatch(/edited while the PDF was being made/);
    for (const code of ["pdf_render_failed", "pdf_render_not_configured", "draft_changed"]) expect(publishErrorText(503, code)).not.toContain(code);
  });
});

describe("the refusals, in words", () => {
  it("drafting", () => {
    expect(draftSummaryErrorText(403, "")).toMatch(/can't draft/);
    expect(draftSummaryErrorText(404, "")).toMatch(/no longer exists/);
    expect(draftSummaryErrorText(400, "invalid_period")).toBe("Pick a month.");
    expect(draftSummaryErrorText(400, "period_in_future")).toMatch(/hasn't started/);
    expect(draftSummaryErrorText(400, "internal_client")).toMatch(/internal client/);
    expect(draftSummaryErrorText(409, "summary_published")).toMatch(/Withdraw it first/);
    expect(draftSummaryErrorText(500, "")).toMatch(/Try again/);
  });
  it("saving the narrative", () => {
    expect(saveNarrativeErrorText(403, "")).toMatch(/can't edit/);
    expect(saveNarrativeErrorText(409, "not_a_draft")).toMatch(/no longer a draft/);
    expect(saveNarrativeErrorText(409, "not_an_account_summary")).toMatch(/Only an account summary/);
    expect(saveNarrativeErrorText(400, "narrative_required")).toMatch(/can't be empty/);
    expect(saveNarrativeErrorText(400, "narrative_too_long")).toMatch(/too long/);
    expect(saveNarrativeErrorText(404, "")).toMatch(/no longer exists/);
  });
});
