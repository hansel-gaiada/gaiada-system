// SM-10 — pure prompt/parse unit tests (no DB, no network; mirrors search-audit.test.ts /
// clustering.test.ts's split of pure logic from I/O). The fail-soft parsing contract (never
// throws, never lets AI output pick an id/status) is the load-bearing property under test here.
import { describe, it, expect } from "vitest";
import {
  buildBriefPrompt, buildBriefPolishPrompt, buildReportNarrativePrompt, buildTriagePrompt,
  parseBriefDraft, parseReportNarrative, parseTriageDraft,
  type BriefGroundingFacts, type ReportMetricsFacts, type TriageFindingFact,
} from "./ai-drafts";

const emptyFacts: BriefGroundingFacts = { propertyDomain: "example.com", findings: [], keywords: [], knowledgeHits: [] };

describe("parseBriefDraft", () => {
  it("parses strict JSON from the completion, tolerating surrounding prose", () => {
    const raw = 'Sure, here you go:\n{"outline": ["Intro", "Body"], "body": "some body text", "geoNotes": "structure with FAQ"}\nHope this helps!';
    const { draft, draftedVia } = parseBriefDraft(raw, "running shoes", emptyFacts);
    expect(draftedVia).toBe("ai");
    expect(draft).toEqual({ outline: ["Intro", "Body"], body: "some body text", geoNotes: "structure with FAQ" });
  });

  it("falls back to a deterministic template on malformed JSON, never throwing", () => {
    const { draft, draftedVia } = parseBriefDraft("not json at all", "running shoes", emptyFacts);
    expect(draftedVia).toBe("fallback");
    expect(draft.body).toContain("running shoes");
    expect(draft.outline.length).toBeGreaterThan(0);
  });

  it("falls back when the gateway never responded (raw = null)", () => {
    const { draft, draftedVia } = parseBriefDraft(null, "topic", emptyFacts);
    expect(draftedVia).toBe("fallback");
    expect(draft.body).toContain("topic");
  });

  it("fallback body cites the grounding facts (findings + keywords) when present", () => {
    const facts: BriefGroundingFacts = {
      propertyDomain: "example.com",
      findings: [{ code: "missing_title", severity: "medium", category: "content", message: "Page has no <title>" }],
      keywords: [{ keyword: "running shoes", intent: "commercial", clusterLabel: "footwear" }],
      knowledgeHits: [],
    };
    const { draft } = parseBriefDraft(null, "topic", facts);
    expect(draft.body).toContain("missing_title");
    expect(draft.body).toContain("running shoes");
  });

  it("includes findings/keywords/knowledge hits in the prompt", () => {
    const facts: BriefGroundingFacts = {
      propertyDomain: "example.com",
      findings: [{ code: "missing_title", severity: "medium", category: "content", message: "Page has no <title>" }],
      keywords: [{ keyword: "running shoes", intent: "commercial", clusterLabel: "footwear" }],
      knowledgeHits: [{ sourceRef: "search-property:p1:grounding", text: "some crawled excerpt", score: 0.9 }],
    };
    const prompt = buildBriefPrompt("running shoes buying guide", facts);
    expect(prompt).toContain("running shoes buying guide");
    expect(prompt).toContain("missing_title");
    expect(prompt).toContain("running shoes [commercial] (footwear)");
    expect(prompt).toContain("some crawled excerpt");
    expect(prompt).toContain("STRICT JSON");
  });

  it("buildBriefPolishPrompt embeds the current draft and asks for the same strict-JSON shape", () => {
    const prompt = buildBriefPolishPrompt({ outline: ["A"], body: "body text", geoNotes: "notes" });
    expect(prompt).toContain("body text");
    expect(prompt).toContain("STRICT JSON");
  });
});

describe("parseTriageDraft", () => {
  const findings: TriageFindingFact[] = [
    { code: "missing_title", severity: "medium", category: "content", message: "Page has no <title>", urlCount: 3 },
    { code: "server_error", severity: "critical", category: "availability", message: "Server error (500)", urlCount: 1 },
  ];

  it("parses strict JSON and keeps only fixes whose code is a known finding", () => {
    const raw = JSON.stringify({
      summary: "Fix the server error first.",
      fixes: [
        { code: "server_error", suggestion: "Investigate the origin 500s." },
        { code: "missing_title", suggestion: "Add a descriptive <title> tag." },
        { code: "hallucinated_code_not_in_this_audit", suggestion: "should be dropped" },
      ],
    });
    const { draft, draftedVia } = parseTriageDraft(raw, findings);
    expect(draftedVia).toBe("ai");
    expect(draft.summary).toBe("Fix the server error first.");
    expect(draft.fixes.map((f) => f.code).sort()).toEqual(["missing_title", "server_error"]);
  });

  it("falls back to a deterministic severity-ordered summary on malformed JSON", () => {
    const { draft, draftedVia } = parseTriageDraft("garbage", findings);
    expect(draftedVia).toBe("fallback");
    expect(draft.fixes).toHaveLength(2);
    // critical must be prioritized first in the fallback summary/fix ordering.
    expect(draft.fixes[0].code).toBe("server_error");
  });

  it("falls back when raw is null (gateway threw)", () => {
    const { draftedVia } = parseTriageDraft(null, findings);
    expect(draftedVia).toBe("fallback");
  });

  it("prompt lists every finding code and asks for strict JSON", () => {
    const prompt = buildTriagePrompt(findings);
    expect(prompt).toContain("missing_title");
    expect(prompt).toContain("server_error");
    expect(prompt).toContain("STRICT JSON");
  });
});

describe("parseReportNarrative", () => {
  const facts: ReportMetricsFacts = { period: "2026-08", rankTop10: 5, criticalFindingsOpen: 2, kpiTargets: [] };

  it("takes the completion's raw text as the narrative", () => {
    const { narrative, draftedVia } = parseReportNarrative("## Great progress this month", facts);
    expect(draftedVia).toBe("ai");
    expect(narrative).toBe("## Great progress this month");
  });

  it("falls back to a deterministic templated summary on empty/null completion", () => {
    const empty = parseReportNarrative("   ", facts);
    expect(empty.draftedVia).toBe("fallback");
    expect(empty.narrative).toContain("2026-08");
    expect(empty.narrative).toContain("5");

    const nullRaw = parseReportNarrative(null, facts);
    expect(nullRaw.draftedVia).toBe("fallback");
  });

  it("prompt includes the engagement name + metrics", () => {
    const prompt = buildReportNarrativePrompt("Acme SEO Engagement", facts);
    expect(prompt).toContain("Acme SEO Engagement");
    expect(prompt).toContain("2026-08");
    expect(prompt).toContain("5");
  });
});
