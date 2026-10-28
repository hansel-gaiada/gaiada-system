// AIP-09 — the cases and prompts are what they claim: synthetic, well formed, and the hub prompt copy has not drifted from mcp-hub.
import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { AUDIT_TRIAGE_CASES, CLASSIFY_CASES, COMPACTION_CASES, MEETING_CASES, SOCIAL_TRIAGE_CASES, SUMMARISE_CASES } from "./cases";
import { buildHubSummarizePrompt, HUB_SUMMARIZE_PREFIX, promptFor } from "./prompts";
import { buildCompactionPrompt } from "../../assistant/context";
import { hasFact } from "./score";

// Real group, client and system names that appear in the repo's seed files and docs. A case containing one is not mock text.
const REAL_NAME_DENYLIST = [
  "gaiada", "gaia digital agency", "gaia nexus", "nusa coffee", "apéritif", "aperitif", "cascades restaurant", "pinstripe bar", "akoya spa",
  "interlace", "cosmedic", "bimc", "aivory", "hansel",
];

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;

describe("case set shape", () => {
  it("has the planned counts and stays within the call budget", () => {
    expect(COMPACTION_CASES).toHaveLength(6);
    expect(MEETING_CASES).toHaveLength(3);
    expect(SUMMARISE_CASES).toHaveLength(9);
    expect(SOCIAL_TRIAGE_CASES).toHaveLength(7);
    expect(AUDIT_TRIAGE_CASES).toHaveLength(3);
    expect(CLASSIFY_CASES).toHaveLength(10);
    expect((SUMMARISE_CASES.length + CLASSIFY_CASES.length) * 2).toBeLessThan(60);
  });
  it("has unique ids, each summary case has facts and at least one probe", () => {
    const ids = [...SUMMARISE_CASES, ...CLASSIFY_CASES].map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of SUMMARISE_CASES) {
      expect(c.mustKeep.length).toBeGreaterThanOrEqual(5);
      expect(c.mustNotAppear.length).toBeGreaterThanOrEqual(1);
      expect(c.mustNotAppear.length).toBeLessThanOrEqual(3);
    }
  });
  it("meeting transcripts are 2,000-4,000 words", () => {
    for (const c of MEETING_CASES) {
      const n = words(c.source);
      expect(n, c.id).toBeGreaterThanOrEqual(2_000);
      expect(n, c.id).toBeLessThanOrEqual(4_000);
    }
  });
  it("every must-keep fact is in the source, and no probe is (a probe that is in the source would punish a correct summary)", () => {
    for (const c of SUMMARISE_CASES) {
      const source = c.kind === "compaction" ? `${(c as { existingSummary?: string }).existingSummary ?? ""}\n${c.source}` : c.source;
      for (const f of c.mustKeep) expect(hasFact(source, f), `${c.id} must-keep ${JSON.stringify(f)} missing from source`).toBe(true);
      for (const f of c.mustNotAppear) expect(hasFact(source, f), `${c.id} probe ${JSON.stringify(f)} is present in the source`).toBe(false);
    }
  });
  it("classification labels come from the label sets the real parsers accept", () => {
    const sentiments = ["positive", "neutral", "negative"];
    const categories = ["question", "complaint", "praise", "spam", "other"];
    const urgencies = ["low", "normal", "high"];
    for (const c of SOCIAL_TRIAGE_CASES) {
      if (c.kind !== "social") throw new Error("expected a social case");
      expect(sentiments).toContain(c.expected.sentiment);
      expect(categories).toContain(c.expected.category);
      expect(urgencies).toContain(c.expected.urgency);
    }
    for (const c of AUDIT_TRIAGE_CASES) {
      if (c.kind !== "audit") throw new Error("expected an audit case");
      const codes = c.findings.map((f) => f.code);
      for (const code of c.expectedFixCodes) expect(codes).toContain(code);
      expect(codes).toContain(c.priorityCode);
    }
  });
});

describe("mock data only", () => {
  it("contains none of the real group or client names from the seed", () => {
    const blob = JSON.stringify([...SUMMARISE_CASES, ...CLASSIFY_CASES]).toLowerCase();
    for (const name of REAL_NAME_DENYLIST) expect(blob.includes(name), `case text contains real name "${name}"`).toBe(false);
  });
  it("the denylist is anchored: the seed really does use these names", () => {
    const seed = readFileSync(path.resolve(__dirname, "../../../seed/agency.ts"), "utf8").toLowerCase();
    expect(seed).toContain("gaia digital agency");
  });
});

describe("prompts are the production ones", () => {
  it("compaction cases go through the exported production builder, with and without an existing summary", () => {
    const plain = COMPACTION_CASES[0];
    expect(promptFor(plain)).toBe(buildCompactionPrompt(plain.source, null));
    expect(promptFor(plain)).toContain("Summarize the following excerpt from a conversation in a few dense sentences");
    const merge = COMPACTION_CASES.find((c) => c.existingSummary)!;
    expect(promptFor(merge)).toContain(`EXISTING SUMMARY:\n${merge.existingSummary}`);
  });
  it("classification cases use the two real triage builders", () => {
    expect(promptFor(SOCIAL_TRIAGE_CASES[0])).toContain("engagement-inbox thread");
    expect(promptFor(AUDIT_TRIAGE_CASES[0])).toContain("triaging technical SEO audit findings");
  });
  it("the hub summarize copy has not drifted from mcp-hub/src/tools.ts", () => {
    const tools = readFileSync(path.resolve(__dirname, "../../../../../mcp-hub/src/tools.ts"), "utf8");
    // The template as written in the source file: the prefix with its escapes, then ${text}, passed to gatewayComplete with the task class.
    const sourceForm = `${JSON.stringify(HUB_SUMMARIZE_PREFIX).slice(1, -1)}\${text}`;
    expect(tools, "mcp-hub llm.summarize template changed: update HUB_SUMMARIZE_PREFIX in prompts.ts and re-run the eval").toContain(`gatewayComplete(\`${sourceForm}\`, "summarise")`);
    expect(buildHubSummarizePrompt("X")).toBe("Summarize the following concisely for a work context:\n\nX");
  });
});
