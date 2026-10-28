// AIP-09 — the pure scorer on hand-made good and bad outputs. No network, no gateway.
import { describe, expect, it } from "vitest";
import { COMPACTION_CASES, MEETING_CASES, SOCIAL_TRIAGE_CASES, AUDIT_TRIAGE_CASES } from "./cases";
import {
  CLASSIFY_MIN_ACCURACY, COMPACTION_SUMMARY_MAX_CHARS, ECHO_PREFIX, HUB_SUMMARY_MAX_CHARS, SUMMARISE_MIN_PASS_RATE, SUMMARY_MIN_CHARS,
  classVerdict, containsFact, normalise, scoreCase, scoreClassification, scoreSummary, type CaseResult,
} from "./score";

const rebrand = COMPACTION_CASES.find((c) => c.id === "compaction-rebrand")!;
const GOOD_REBRAND =
  "Arunika Studio is refreshing its brand: Dewi's shortlist was settled on option B (the filled sun with a wordmark), quoted at IDR 85 million, " +
  "to be signed off by Dewi on 14 March. Open question: whether the old logo stays on the van until the lease ends.";

describe("normalise / containsFact (number aware)", () => {
  it("drops thousands separators and ignores case", () => {
    expect(normalise("IDR 85,000,000 Total")).toBe("idr 85000000 total");
    expect(containsFact("The budget is 85,000,000 rupiah", "85000000")).toBe(true);
    expect(containsFact("DEWI signed", "dewi")).toBe(true);
  });
  it("does not match a number inside a longer number or a decimal", () => {
    expect(containsFact("it costs 380 million", "38 million")).toBe(false);
    expect(containsFact("ctr was 12.5 percent", "12")).toBe(false);
    expect(containsFact("opened in 2012", "12")).toBe(false);
    expect(containsFact("ctr was 2.4 percent", "2.4")).toBe(true);
    expect(containsFact("ctr was 12.4 percent", "2.4")).toBe(false);
  });
  it("does not match a name in the middle of a word", () => {
    expect(containsFact("a moment of admiration", "Mira")).toBe(false);
    expect(containsFact("Mira owns it", "Mira")).toBe(true);
    expect(containsFact("we paused ads", "pause")).toBe(true);
  });
});

describe("scoreSummary", () => {
  it("passes a summary that keeps the facts and invents nothing", () => {
    const r = scoreSummary(rebrand, GOOD_REBRAND);
    expect(r.status).toBe("pass");
    expect(r.score).toBe(1);
    expect(r.reasons).toEqual([]);
  });
  it("fails on low recall and lists exactly what is missing", () => {
    const r = scoreSummary(rebrand, "Arunika Studio is refreshing its brand and the team picked a logo direction after some discussion about the van and the lease.");
    expect(r.status).toBe("fail");
    expect(r.reasons.join("\n")).toMatch(/recall 0\.2\d? < 0\.8/);
    expect(r.reasons.join("\n")).toContain("85 million");
    expect(r.reasons.join("\n")).toContain("14 March");
  });
  it("fails on an INVENTED fact even when recall is perfect", () => {
    const r = scoreSummary(rebrand, `${GOOD_REBRAND} The studio also raised the total to IDR 95 million.`);
    expect(r.status).toBe("fail");
    expect(r.invented).toBe(true);
    expect(r.reasons.join("\n")).toContain("INVENTED");
    expect(r.reasons.join("\n")).toContain("95 million");
  });
  it("does not mistake 85 million for the invented 95 million probe", () => {
    expect(scoreSummary(rebrand, GOOD_REBRAND).invented).toBeUndefined();
  });
  it("fails empty and too-short output", () => {
    expect(scoreSummary(rebrand, "").reasons.join("\n")).toMatch(/too short.*\(empty\)/);
    expect(scoreSummary(rebrand, "ok").status).toBe("fail");
    expect(SUMMARY_MIN_CHARS).toBeGreaterThan(2);
  });
  it("fails a compaction summary over the budget bound, and applies the larger bound to hub summaries", () => {
    const long = `${GOOD_REBRAND} ${"Further detail that nobody asked for. ".repeat(60)}`;
    expect(long.length).toBeGreaterThan(COMPACTION_SUMMARY_MAX_CHARS);
    expect(scoreSummary(rebrand, long).reasons.join("\n")).toMatch(/too long/);
    const meeting = MEETING_CASES[0];
    const facts = "Decisions: 18 November launch owned by Rahmat; beta capped at 500 users, Sinta; IDR 240 million marketing, Mira; offline mode dropped, Bayu. ";
    const mid = facts + "x ".repeat(Math.ceil((COMPACTION_SUMMARY_MAX_CHARS + 200 - facts.length) / 2));
    expect(mid.length).toBeGreaterThan(COMPACTION_SUMMARY_MAX_CHARS);
    expect(mid.length).toBeLessThan(HUB_SUMMARY_MAX_CHARS);
    expect(scoreSummary(meeting, mid).status).toBe("pass");
  });
  it("marks the echo fallback INVALID, never a pass", () => {
    const r = scoreSummary(rebrand, `${ECHO_PREFIX} ${GOOD_REBRAND}`);
    expect(r.status).toBe("invalid");
    expect(r.reasons[0]).toMatch(/echo fallback/);
  });
});

describe("scoreClassification (uses the REAL parsers)", () => {
  const praise = SOCIAL_TRIAGE_CASES.find((c) => c.id === "triage-praise")!;
  const spam = SOCIAL_TRIAGE_CASES.find((c) => c.id === "triage-spam-link")!;
  const audit = AUDIT_TRIAGE_CASES[0];

  it("passes the right labels, including fenced or prefixed JSON the real parser accepts", () => {
    expect(scoreClassification(praise, '{"sentiment":"positive","category":"praise","urgency":"low"}').status).toBe("pass");
    expect(scoreClassification(praise, 'Sure:\n```json\n{"sentiment":"Positive","category":"praise","urgency":"low"}\n```').status).toBe("pass");
  });
  it("fails a wrong label with expected vs got per axis", () => {
    const r = scoreClassification(spam, '{"sentiment":"negative","category":"spam","urgency":"normal"}');
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toBe("wrong label: sentiment: expected neutral, got negative; urgency: expected low, got normal");
  });
  it("fails a label outside the set the real parser accepts", () => {
    const r = scoreClassification(praise, '{"sentiment":"happy","category":"praise","urgency":"low"}');
    expect(r.status).toBe("fail");
    expect(r.reasons[0]).toMatch(/real parser rejected/);
    expect(scoreClassification(praise, "this is praise").status).toBe("fail");
  });
  it("audit triage: needs every expected fix code and the priority code in the summary", () => {
    const good = JSON.stringify({
      summary: "Fix BROKEN_LINKS first, then titles, then alt text.",
      fixes: [{ code: "BROKEN_LINKS", suggestion: "redirect" }, { code: "MISSING_TITLE", suggestion: "add" }, { code: "LONG_ALT", suggestion: "shorten" }],
    });
    expect(scoreClassification(audit, good).status).toBe("pass");
    const partial = JSON.stringify({ summary: "Start with titles.", fixes: [{ code: "MISSING_TITLE", suggestion: "add" }, { code: "MADE_UP", suggestion: "x" }] });
    const r = scoreClassification(audit, partial);
    expect(r.status).toBe("fail");
    expect(r.reasons.join("\n")).toContain("fixes missing for: BROKEN_LINKS, LONG_ALT");
    expect(r.reasons.join("\n")).toContain("does not name the first priority BROKEN_LINKS");
    expect(scoreClassification(audit, "nope").reasons[0]).toMatch(/real parser rejected/);
  });
  it("marks the echo fallback INVALID", () => {
    expect(scoreClassification(praise, `${ECHO_PREFIX} anything`).status).toBe("invalid");
  });
  it("scoreCase dispatches on the task", () => {
    expect(scoreCase(rebrand, GOOD_REBRAND).status).toBe("pass");
    expect(scoreCase(praise, "{}").status).toBe("fail");
  });
});

describe("classVerdict", () => {
  const r = (id: string, status: CaseResult["status"], extra: Partial<CaseResult> = {}): CaseResult => ({ id, task: "summarise", status, reasons: [], score: 1, ...extra });
  const nine = (failing: number): CaseResult[] => Array.from({ length: 9 }, (_, i) => r(`c${i}`, i < failing ? "fail" : "pass"));

  it("summarise: 8 of 9 passes, 7 of 9 fails (threshold named)", () => {
    expect(8 / 9).toBeGreaterThanOrEqual(SUMMARISE_MIN_PASS_RATE);
    expect(7 / 9).toBeLessThan(SUMMARISE_MIN_PASS_RATE);
    expect(classVerdict("summarise", nine(1)).verdict).toBe("PASS");
    expect(classVerdict("summarise", nine(2)).verdict).toBe("FAIL");
  });
  it("summarise: one invented fact fails the class even at a passing rate", () => {
    const results = nine(0);
    results[3] = r("c3", "fail", { invented: true });
    const v = classVerdict("summarise", results);
    expect(v.verdict).toBe("FAIL");
    expect(v.reason).toContain("invented fact in c3");
  });
  it("classify: accuracy threshold", () => {
    const ten = (wrong: number): CaseResult[] => Array.from({ length: 10 }, (_, i) => r(`k${i}`, i < wrong ? "fail" : "pass", { task: "classify" }));
    expect(CLASSIFY_MIN_ACCURACY).toBe(0.8);
    expect(classVerdict("classify", ten(2)).verdict).toBe("PASS");
    expect(classVerdict("classify", ten(3)).verdict).toBe("FAIL");
  });
  it("any invalid case, or no case, makes the class INVALID", () => {
    expect(classVerdict("summarise", [...nine(0).slice(1), r("x", "invalid")]).verdict).toBe("INVALID");
    expect(classVerdict("classify", []).verdict).toBe("INVALID");
  });
});
