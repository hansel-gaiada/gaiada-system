import { describe, it, expect } from "vitest";

// SCP-5g (BFF §63.28): the audit's parsers, the words for scores, reasons and refusals, the form's own checks and the buttons' rules. A parsed answer that is the wrong shape throws; a score is always in
// words and numbers; every automatic dimension with no score says why; every refusal says who may.
import { REFUSAL_WORDS } from "./socialPipeline";
import {
  ATTACH_REASON, CLIENT_WRITE_REASON, NONE_REASON_WORDS, PROSPECT_WRITE_REASON, asAuditDetail, asAuditList, asAuditWrite, asSummaryProposal, auditHref, auditListHref, auditRefusalText,
  buildAuditPatch, buildProspectCreate, buildPublicNumbers, buttonsFor, draftedViaWords, emptyPublicNumbers, evidenceWords, formFromDetail, isHalfScore, isOverride, noneReasonWords,
  overallWords, parseAuditSubject, rowScoreWords, scoreBand, scoreText, scoreWords, scoredWords, statusWords, type AuditDetail, type AuditForm,
} from "./socialAudit";

const dim = (key: string, o: Record<string, unknown> = {}) => ({ key, label: key, kind: "automatic", weight: 1, advice: `Fix ${key}`, auto: null, typed: null, used: null, ...o });
const raw = (o: Record<string, unknown> = {}) => ({
  id: "a1", subject: "client", engagementId: "e1", name: "Northwind Traders", month: "2026-09", status: "draft", rulesRef: "default:x", summary: null, summaryVia: null, overall: 62, band: "fair",
  bandLabel: "Fair", scored: 2, total: 3, fixes: [{ key: "reels", label: "Reels", score: 1, advice: "Hook." }], simulated: false, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
  canWrite: true, canFinalize: true, publicNumbers: {},
  dimensions: [
    dim("consistency", { auto: { score: 2.5, reason: null, evidence: { actual: 6, expected: 12, unit: "posts" } }, used: 2.5 }),
    dim("boosting", { auto: { score: null, reason: "no_agreed_budget", evidence: { actual: 0, expected: 0, unit: "cycles" } } }),
    dim("profile", { kind: "typed", typed: { score: 4, note: "Clear." }, used: 4 }),
  ],
  ...o,
});
const detail = (o: Record<string, unknown> = {}): AuditDetail => asAuditDetail(raw(o));

describe("parsing", () => {
  it("parses the scorecard with its automatic part, its typed part and the flags", () => {
    const d = detail();
    expect(d).toMatchObject({ id: "a1", subject: "client", status: "draft", month: "2026-09", overall: 62, bandLabel: "Fair", scored: 2, total: 3, canWrite: true, canFinalize: true });
    expect(d.dimensions.map((x) => [x.key, x.kind, x.used])).toEqual([["consistency", "automatic", 2.5], ["boosting", "automatic", null], ["profile", "typed", 4]]);
    expect(d.dimensions[1].auto).toMatchObject({ score: null, reason: "no_agreed_budget" });
    expect(d.fixes).toEqual([{ key: "reels", label: "Reels", score: 1, advice: "Hook." }]);
  });
  it("a flag that is not exactly true is false, and a final audit is not a draft", () => {
    expect(detail({ canWrite: "yes", canFinalize: 1 })).toMatchObject({ canWrite: false, canFinalize: false });
    expect(detail({ status: "final", finalizedAt: "2026-10-05T00:00:00Z", finalizedBy: { id: "u", name: "Dewi" } })).toMatchObject({ status: "final", finalizedBy: { name: "Dewi" } });
  });
  it("throws for an answer that is not an audit, and never turns it into an empty scorecard", () => {
    expect(() => asAuditDetail({})).toThrow();
    expect(() => asAuditDetail(raw({ status: "open" }))).toThrow();
    expect(() => asAuditDetail(raw({ subject: "team" }))).toThrow();
    expect(() => asAuditDetail(raw({ dimensions: "none" }))).toThrow();
    expect(() => asAuditDetail(raw({ dimensions: [{ label: "x" }] }))).toThrow();
    expect(() => asAuditWrite({})).toThrow();
    expect(() => asSummaryProposal({})).toThrow();
    expect(() => asAuditList({ items: "x" })).toThrow();
  });
  it("parses the list, with a client that has no audit yet", () => {
    const l = asAuditList({ items: [{ auditId: null, subject: "client", engagementId: "e2", name: "Harborlight Hotel", status: null, total: 12 }, { auditId: "a1", subject: "prospect", engagementId: null, name: "Fernhill", status: "draft", overall: 40, band: "needs_work", bandLabel: "Needs work", scored: 4, total: 12, topFix: { key: "k", label: "Visual", score: 1, advice: "x" } }], canAddProspect: true });
    expect(l.canAddProspect).toBe(true);
    expect(l.items[0]).toMatchObject({ auditId: null, status: null, overall: null, scored: 0, total: 12 });
    expect(l.items[1]).toMatchObject({ subject: "prospect", overall: 40, topFix: { label: "Visual" } });
  });
  it("a write answers {audit, created} and a replay says alreadyApplied", () => {
    expect(asAuditWrite({ audit: raw(), created: true })).toMatchObject({ created: true, alreadyApplied: false });
    expect(asAuditWrite({ alreadyApplied: true, audit: raw() })).toMatchObject({ created: false, alreadyApplied: true });
    expect(asSummaryProposal({ summary: "S", draftedVia: "ai" })).toEqual({ summary: "S", draftedVia: "ai" });
    expect(asSummaryProposal({ summary: "S", draftedVia: "x" }).draftedVia).toBe("template");
  });
});

describe("scores in words and numbers", () => {
  it("writes a half-step with no trailing zero, and says it out of five", () => {
    expect(scoreText(4)).toBe("4");
    expect(scoreText(3.5)).toBe("3.5");
    expect(scoreWords(3.5)).toBe("3.5 out of 5");
    expect(scoreWords(0)).toBe("0 out of 5");
    expect(scoreWords(null)).toBe("Not scored");
    expect(overallWords(62, "Fair")).toBe("62 out of 100, Fair");
    expect(overallWords(null, null)).toBe("No overall score yet");
    expect(scoredWords(7, 12)).toBe("7 of 12 dimensions scored");
    expect([5, 4, 3.5, 2, 1.5, 1, 0].map(scoreBand)).toEqual(["strong", "strong", "fair", "low", "low", "weak", "weak"]);
  });
  it("a score is a half-step from 0 to 5", () => {
    for (const n of [0, 0.5, 3, 5]) expect(isHalfScore(n)).toBe(true);
    for (const n of [-0.5, 5.5, 3.3, NaN, "3", null]) expect(isHalfScore(n)).toBe(false);
  });
  it("words the row of the list, and the state", () => {
    expect(rowScoreWords({ auditId: null, overall: null, bandLabel: null, scored: 0, total: 12 })).toBe("No audit yet");
    expect(rowScoreWords({ auditId: "a", overall: null, bandLabel: null, scored: 0, total: 12 })).toBe("Not scored yet · 0 of 12 scored");
    expect(rowScoreWords({ auditId: "a", overall: 62, bandLabel: "Fair", scored: 7, total: 12 })).toBe("62 out of 100, Fair · 7 of 12 scored");
    expect([statusWords("draft"), statusWords("final"), statusWords(null)]).toEqual(["Draft", "Final", "No audit yet"]);
  });
});

describe("why an automatic score is none, and what it was read from", () => {
  it("every reason of the server has its own sentence, never a bare code", () => {
    for (const code of ["no_target", "no_allocated_formats", "no_rate", "no_benchmark", "no_reels", "no_reel_rate", "no_feed_baseline", "no_agreed_budget"]) {
      expect(NONE_REASON_WORDS[code], code).toMatch(/\.$/);
      expect(noneReasonWords(code), code).not.toContain("_");
    }
    expect(noneReasonWords("something_new")).toMatch(/cannot be scored/);
    expect(noneReasonWords(null)).toMatch(/cannot be scored/);
  });
  it("writes the evidence by its unit", () => {
    expect(evidenceWords({ actual: 6, expected: 12, unit: "posts" })).toBe("6 posts against 12 posts");
    expect(evidenceWords({ actual: 1, expected: 3, unit: "weeks" })).toBe("1 week against 3 weeks");
    expect(evidenceWords({ actual: 0.032, expected: 0.0281, unit: "rate" })).toBe("Rate 3.2% against 2.81%");
    expect(evidenceWords({ actual: 2, expected: null, unit: "formats" })).toBe("2 formats against not known");
  });
});

describe("refusals in words", () => {
  it("a 403 says who may, by the write", () => {
    expect(auditRefusalText({ status: 403, error: "not_officer_or_approver" })).toBe(REFUSAL_WORDS.not_officer_or_approver);
    expect(auditRefusalText({ status: 403, error: "not_a_social_approver" })).toBe(REFUSAL_WORDS.not_a_social_approver);
    expect(auditRefusalText({ status: 403, error: "forbidden" }, "attach")).toContain(ATTACH_REASON);
    expect(auditRefusalText({ status: 403, error: "forbidden" }, "start_prospect")).toContain(PROSPECT_WRITE_REASON);
    expect(auditRefusalText({ status: 403, error: "automation_cannot_act" })).toBe(REFUSAL_WORDS.automation_cannot_act);
    expect(CLIENT_WRITE_REASON).toMatch(/officer/);
  });
  it("the four new codes and the 409s are worded, with no bare code", () => {
    for (const code of ["audit_not_found", "audit_final", "audit_attached", "not_a_prospect_audit"]) {
      expect(REFUSAL_WORDS[code], code).toMatch(/\.$/);
      expect(REFUSAL_WORDS[code], code).not.toContain("_");
    }
    expect(auditRefusalText({ status: 409, error: "audit_final" })).toBe(REFUSAL_WORDS.audit_final);
    expect(auditRefusalText({ status: 409, error: "audit_attached" })).toBe(REFUSAL_WORDS.audit_attached);
    expect(auditRefusalText({ status: 404, error: "audit_not_found" })).toBe(REFUSAL_WORDS.audit_not_found);
  });
  it("a 400 field says what is wrong with it, down to the dimension", () => {
    expect(auditRefusalText({ status: 400, error: "invalid_field", field: "scores.caption_cta.score" })).toMatch(/caption cta must be from 0 to 5 in steps of a half/);
    expect(auditRefusalText({ status: 400, error: "missing_field", field: "scores.stories.note" })).toMatch(/needs a note saying why/);
    expect(auditRefusalText({ status: 400, error: "invalid_field", field: "scores.bogus" })).toMatch(/not one of this audit's dimensions/);
    expect(auditRefusalText({ status: 400, error: "invalid_field", field: "publicNumbers.followers" })).toMatch(/Followers.*not valid/);
    expect(auditRefusalText({ status: 400, error: "invalid_field", field: "month" })).toMatch(/month/);
    expect(auditRefusalText({ status: 400, error: "missing_field", field: "prospectName" })).toMatch(/name/);
  });
  it("says where a proposal came from", () => {
    expect(draftedViaWords("ai")).toMatch(/nothing is saved until you do/);
    expect(draftedViaWords("template")).toMatch(/plain summary/);
  });
});

describe("the form's own checks before a save", () => {
  const d = detail();
  const form = (f: (x: AuditForm) => void): AuditForm => { const x = formFromDetail(d); f(x); return x; };
  it("sends nothing when nothing changed", () => {
    expect(buildAuditPatch(d, formFromDetail(d))).toEqual({ ok: false, field: "", message: "Nothing has changed." });
  });
  it("a typed score is a half-step, an override needs its note, and a typed dimension may have none", () => {
    expect(buildAuditPatch(d, form((f) => { f.scores.profile.score = "3.3"; }))).toMatchObject({ ok: false, field: "scores.profile.score" });
    expect(buildAuditPatch(d, form((f) => { f.scores.consistency.score = "3"; }))).toMatchObject({ ok: false, field: "scores.consistency.note" });
    expect(buildAuditPatch(d, form((f) => { f.scores.consistency.score = "3"; f.scores.consistency.note = " We also posted on the second account. "; })))
      .toEqual({ ok: true, body: { scores: { consistency: { score: 3, note: "We also posted on the second account." } } } });
    expect(buildAuditPatch(d, form((f) => { f.scores.profile.score = "5"; f.scores.profile.note = ""; }))).toEqual({ ok: true, body: { scores: { profile: { score: 5, note: "" } } } });
    expect(buildAuditPatch(d, form((f) => { f.scores.profile.note = "x".repeat(501); }))).toMatchObject({ ok: false, field: "scores.profile.note" });
  });
  it("Use automatic drops the typed entry (a null), and keeps only a note when a note is left", () => {
    const d2 = detail({ dimensions: [dim("stories", { auto: { score: 1, reason: null, evidence: { actual: 1, expected: 5, unit: "weeks" } }, typed: { score: 4, note: "Daily in highlights." }, used: 4 })] });
    const f = formFromDetail(d2);
    f.scores.stories = { score: "", note: "" };
    expect(buildAuditPatch(d2, f)).toEqual({ ok: true, body: { scores: { stories: null } } });
    f.scores.stories = { score: "", note: "Still daily." };
    expect(buildAuditPatch(d2, f)).toEqual({ ok: true, body: { scores: { stories: { score: null, note: "Still daily." } } } });
  });
  it("the summary is trimmed and says typed, or where a kept proposal came from; blank clears; over 3,000 is refused", () => {
    expect(buildAuditPatch(d, form((f) => { f.summary = " Good. "; }))).toEqual({ ok: true, body: { summary: "Good.", summaryVia: "typed" } });
    expect(buildAuditPatch(d, form((f) => { f.summary = "Good."; }), { summaryVia: "ai" })).toEqual({ ok: true, body: { summary: "Good.", summaryVia: "ai" } });
    const withSummary = detail({ summary: "Old", summaryVia: "typed" });
    expect(buildAuditPatch(withSummary, { ...formFromDetail(withSummary), summary: "" })).toEqual({ ok: true, body: { summary: null } });
    expect(buildAuditPatch(d, form((f) => { f.summary = "x".repeat(3001); }))).toMatchObject({ ok: false, field: "summary" });
  });
  it("a client's month, and only a client's; a prospect's own fields and public numbers", () => {
    expect(buildAuditPatch(d, form((f) => { f.month = "2026-08"; }))).toEqual({ ok: true, body: { month: "2026-08" } });
    expect(buildAuditPatch(d, form((f) => { f.month = ""; }))).toMatchObject({ ok: false, field: "month" });
    const p = detail({ subject: "prospect", engagementId: null, name: "Fernhill", prospectName: "Fernhill", businessType: "Bakery", month: null, publicNumbers: { followers: 3100 }, dimensions: [dim("profile", { kind: "typed" })] });
    const pf = formFromDetail(p);
    expect(pf).toMatchObject({ prospectName: "Fernhill", businessType: "Bakery", publicNumbers: { followers: "3100", avgLikes: "" } });
    expect(buildAuditPatch(p, { ...pf, prospectName: "" })).toMatchObject({ ok: false, field: "prospectName" });
    expect(buildAuditPatch(p, { ...pf, businessType: "" })).toEqual({ ok: true, body: { businessType: null } });
    expect(buildAuditPatch(p, { ...pf, publicNumbers: { ...pf.publicNumbers, followers: "3300", avgLikes: "54.5" } })).toEqual({ ok: true, body: { publicNumbers: { followers: 3300, avgLikes: 54.5 } } });
    expect(buildAuditPatch(p, { ...pf, publicNumbers: { ...pf.publicNumbers, followers: "-1" } })).toMatchObject({ ok: false, field: "publicNumbers.followers" });
    // A prospect's typed score on any dimension is NOT an override and needs no note.
    expect(isOverride("prospect", { kind: "automatic", auto: null })).toBe(false);
    expect(buildAuditPatch(p, { ...pf, scores: { profile: { score: "3", note: "" } } })).toEqual({ ok: true, body: { scores: { profile: { score: 3, note: "" } } } });
  });
  it("public numbers: counts are whole, averages have at most two decimals, the date is real, blank drops", () => {
    expect(buildPublicNumbers(emptyPublicNumbers())).toEqual({ ok: true, body: {} });
    expect(buildPublicNumbers({ ...emptyPublicNumbers(), followers: "1.5" })).toMatchObject({ ok: false, field: "publicNumbers.followers" });
    expect(buildPublicNumbers({ ...emptyPublicNumbers(), avgComments: "1.234" })).toMatchObject({ ok: false, field: "publicNumbers.avgComments" });
    expect(buildPublicNumbers({ ...emptyPublicNumbers(), lastPostOn: "2026-02-30" })).toMatchObject({ ok: false, field: "publicNumbers.lastPostOn" });
    expect(buildPublicNumbers({ ...emptyPublicNumbers(), lastPostOn: "2026-02-28", postsLast30Days: "6" })).toEqual({ ok: true, body: { postsLast30Days: 6, lastPostOn: "2026-02-28" } });
  });
  it("a new prospect needs a name; the optional parts are sent only when given", () => {
    const e = emptyPublicNumbers();
    expect(buildProspectCreate({ prospectName: " ", businessType: "", publicNumbers: e }, "i")).toMatchObject({ ok: false, field: "prospectName" });
    expect(buildProspectCreate({ prospectName: "x".repeat(201), businessType: "", publicNumbers: e }, "i")).toMatchObject({ ok: false });
    expect(buildProspectCreate({ prospectName: " Quay Coffee ", businessType: "", publicNumbers: e }, "i")).toEqual({ ok: true, body: { id: "i", subject: "prospect", prospectName: "Quay Coffee" } });
    expect(buildProspectCreate({ prospectName: "Quay", businessType: "Cafe", publicNumbers: { ...e, followers: "900" } }, "i"))
      .toEqual({ ok: true, body: { id: "i", subject: "prospect", prospectName: "Quay", businessType: "Cafe", publicNumbers: { followers: 900 } } });
  });
});

describe("the buttons follow the server's flags and the state", () => {
  it("a draft the person may write is editable; Finalize waits for a save; the reasons say who may", () => {
    expect(buttonsFor(detail())).toMatchObject({ editable: true, save: true, aiSummary: true, finalize: { shown: true, allowed: true, reason: null }, remove: { shown: true, allowed: true }, attach: { shown: false } });
    expect(buttonsFor(detail(), { dirty: true }).finalize).toMatchObject({ allowed: false, reason: expect.stringMatching(/Save your changes first/) });
    const ro = buttonsFor(detail({ canWrite: false, canFinalize: false }));
    expect(ro).toMatchObject({ editable: false, save: false, aiSummary: false, finalize: { shown: true, allowed: false, reason: CLIENT_WRITE_REASON }, remove: { allowed: false } });
    expect(buttonsFor(detail({ subject: "prospect", canWrite: false, canFinalize: false, engagementId: null })).finalize.reason).toBe(PROSPECT_WRITE_REASON);
  });
  it("a final audit is read-only: nothing is editable, finalized or deleted", () => {
    expect(buttonsFor(detail({ status: "final" }))).toMatchObject({ editable: false, save: false, aiSummary: false, finalize: { shown: false }, remove: { shown: false } });
  });
  it("attaching is shown for a prospect not yet attached, and says who may", () => {
    const p = detail({ subject: "prospect", engagementId: null });
    expect(buttonsFor(p).attach).toEqual({ shown: true, allowed: true, reason: null });
    expect(buttonsFor(detail({ subject: "prospect", engagementId: null, canWrite: false })).attach).toEqual({ shown: true, allowed: false, reason: ATTACH_REASON });
    expect(buttonsFor(detail({ subject: "prospect", engagementId: "e2" })).attach.shown).toBe(false);
  });
});

describe("the page's links", () => {
  it("builds the list and one audit's address, never /audit", () => {
    expect(auditHref("d 1", "a/1")).toBe("/departments/d%201/social-audit/a%2F1");
    expect(auditListHref("d1", null)).toBe("/departments/d1/social-audit");
    expect(auditListHref("d1", "prospect")).toBe("/departments/d1/social-audit?subject=prospect");
    expect(parseAuditSubject({ subject: "client" })).toBe("client");
    expect(parseAuditSubject({ subject: "team" })).toBeNull();
    expect(parseAuditSubject({ subject: ["prospect", "client"] })).toBe("prospect");
    expect(parseAuditSubject({})).toBeNull();
  });
});
