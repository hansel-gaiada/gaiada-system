// TR-27 — pure tests for narrative.ts. No database, no network: every function here is
// prompt-build/parse only (file header's "ZERO I/O of its own"). The gateway-integration half
// (the ONE completeViaGateway call report-seal.ts makes, and its fail-soft wiring) is covered
// against live Postgres in report-seal.db.test.ts.
import { describe, it, expect } from "vitest";
import {
  MAX_NARRATIVE_CHARS,
  buildGroundingFacts,
  buildNarrativePrompt,
  groundingHash,
  parseNarrative,
  passesNumeralGuard,
  type NarrativeGroundingFacts,
} from "./narrative";
import type { ReportDocument, ReportNarrative } from "./report-document";

function fakeDoc(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    header: {
      tenantId: "t1",
      grain: "person",
      scopeRef: "u1",
      scopeName: "Alice Tan",
      periodKind: "month",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      dayCount: 31,
      periodLabel: "July 2026",
      generatedAt: "2026-08-01T00:00:00.000Z",
      sealed: false,
    },
    kpis: [
      { metricKey: "delivery.tasks_completed", label: "Tasks Completed", unit: "count", value: 12, appraisalSafe: true, delta: 2 },
      { metricKey: "delivery.on_time_rate", label: "On-Time Rate", unit: "percent", value: 80, numerator: 8, denominator: 10, appraisalSafe: true },
    ],
    series: [
      {
        key: "delivery.tasks_completed_daily",
        label: "Tasks Completed (daily)",
        unit: "count",
        kind: "line",
        points: [
          { t: "2026-07-01", v: 1 },
          { t: "2026-07-15", v: null },
          { t: "2026-07-31", v: 5 },
        ],
      },
    ],
    distributions: [],
    tables: [],
    highlights: [{ kind: "achievement", text: "Completed 12 tasks (8 of 10 on time)." }],
    narrative: { source: "deterministic", text: "Completed 12 tasks, 8 of 10 on time." },
    ...overrides,
  };
}

const FALLBACK: ReportNarrative = { source: "deterministic", text: "Completed 12 tasks, 8 of 10 on time." };

describe("buildGroundingFacts (pure extraction)", () => {
  it("carries scopeName/periodLabel from the header verbatim", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(facts.scopeName).toBe("Alice Tan");
    expect(facts.periodLabel).toBe("July 2026");
  });

  it("carries every kpi's value/numerator/denominator/delta, dropping fields the kpi didn't have", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(facts.kpis).toEqual([
      { metricKey: "delivery.tasks_completed", label: "Tasks Completed", value: 12, delta: 2 },
      { metricKey: "delivery.on_time_rate", label: "On-Time Rate", value: 80, numerator: 8, denominator: 10 },
    ]);
  });

  it("computes a series delta from its first-to-last NON-NULL points, skipping nulls", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(facts.topSeriesDeltas).toEqual([{ label: "Tasks Completed (daily)", delta: 4 }]);
  });

  it("omits a series with fewer than two non-null points (no delta computable)", () => {
    const doc = fakeDoc({
      series: [{ key: "s", label: "Single point", unit: "count", kind: "line", points: [{ t: "2026-07-01", v: 3 }] }],
    });
    expect(buildGroundingFacts(doc).topSeriesDeltas).toEqual([]);
  });

  it("never includes raw series points, table rows, or ids — only the shapes §9.1 names", () => {
    const facts = buildGroundingFacts(fakeDoc());
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toContain("2026-07-15"); // a raw point date never leaks into the facts
  });

  it("carries the highlights' own already-deterministic text", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(facts.highlights).toEqual(["Completed 12 tasks (8 of 10 on time)."]);
  });
});

describe("groundingHash", () => {
  it("is deterministic and a 64-char lowercase hex sha256 digest", () => {
    const facts = buildGroundingFacts(fakeDoc());
    const hash = groundingHash(facts);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(groundingHash(facts)).toBe(hash);
  });

  it("changes if any grounding fact changes", () => {
    const a = buildGroundingFacts(fakeDoc());
    const b = buildGroundingFacts(fakeDoc({ kpis: [{ metricKey: "delivery.tasks_completed", label: "Tasks Completed", unit: "count", value: 99, appraisalSafe: true }] }));
    expect(groundingHash(a)).not.toBe(groundingHash(b));
  });
});

describe("buildNarrativePrompt (pure)", () => {
  it("embeds scopeName, periodLabel, every kpi's numbers, and the highlight text", () => {
    const facts = buildGroundingFacts(fakeDoc());
    const prompt = buildNarrativePrompt(facts);
    expect(prompt).toContain("Alice Tan");
    expect(prompt).toContain("July 2026");
    expect(prompt).toContain("Tasks Completed: 12");
    expect(prompt).toContain("On-Time Rate: 80 (8 of 10)");
    expect(prompt).toContain("Completed 12 tasks (8 of 10 on time).");
  });

  it("states the length cap and forbids inventing numbers, in-prompt (house tone rules)", () => {
    const prompt = buildNarrativePrompt(buildGroundingFacts(fakeDoc()));
    expect(prompt).toContain(String(MAX_NARRATIVE_CHARS));
    expect(prompt.toLowerCase()).toContain("do not invent");
  });
});

describe("passesNumeralGuard (the hallucinated-numeral guard)", () => {
  it("passes text whose numerals are all already grounding facts", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(passesNumeralGuard("Completed 12 tasks, 8 of 10 on time.", facts)).toBe(true);
  });

  it("passes text with NO numerals at all (cannot misquote a number it never states)", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(passesNumeralGuard("A steady period with no notable change.", facts)).toBe(true);
  });

  it("REJECTS a fabricated numeral not present anywhere in the grounding facts", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(passesNumeralGuard("Throughput rose 40% this period.", facts)).toBe(false);
  });

  it("accepts the absolute value of a negative kpi delta (declined-by phrasing)", () => {
    const facts: NarrativeGroundingFacts = {
      scopeName: "Bob", periodLabel: "July 2026",
      kpis: [{ metricKey: "discipline.overdue_open", label: "Overdue", value: 3, delta: -12 }],
      topSeriesDeltas: [], highlights: [],
    };
    expect(passesNumeralGuard("Overdue count declined by 12 this period.", facts)).toBe(true);
  });

  it("accepts a numeral already present in the period label or scope name (repeated, not invented)", () => {
    const facts = buildGroundingFacts(fakeDoc());
    expect(passesNumeralGuard("July 2026 was a typical month.", facts)).toBe(true);
  });
});

describe("parseNarrative (never throws; the fail-soft contract)", () => {
  const facts = buildGroundingFacts(fakeDoc());

  it("raw=null (gateway unconfigured/down/timeout) -> the caller's deterministic fallback, source relabelled honestly, groundingHash stamped", () => {
    const result = parseNarrative(null, null, facts, FALLBACK);
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe(FALLBACK.text);
    expect(result.model).toBeUndefined();
    expect(result.groundingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a clean completion with only grounded numerals -> source 'ai', model recorded, groundingHash stamped", () => {
    const result = parseNarrative("Completed 12 tasks this period, 8 of 10 on time.", "hermes-local", facts, FALLBACK);
    expect(result.source).toBe("ai");
    expect(result.text).toBe("Completed 12 tasks this period, 8 of 10 on time.");
    expect(result.model).toBe("hermes-local");
    expect(result.groundingHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("THE PINNED CASE: a completion with a fabricated/hallucinated numeral downgrades to the deterministic fallback, never partially trusted", () => {
    const result = parseNarrative("Throughput rose 40% this period, well above target.", "hermes-local", facts, FALLBACK);
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe(FALLBACK.text); // the exact TR-13 wording, not a mangled AI edit
    expect(result.model).toBeUndefined(); // never labelled "ai" with a rejected completion's model tag
  });

  it("an empty/whitespace-only completion -> deterministic fallback", () => {
    expect(parseNarrative("   ", "hermes-local", facts, FALLBACK).source).toBe("deterministic");
  });

  it("a completion longer than MAX_NARRATIVE_CHARS -> deterministic fallback, even with all-legitimate numerals", () => {
    const long = "Completed 12 tasks, 8 of 10 on time. ".repeat(40); // > 900 chars, every numeral grounded
    expect(long.length).toBeGreaterThan(MAX_NARRATIVE_CHARS);
    const result = parseNarrative(long, "hermes-local", facts, FALLBACK);
    expect(result.source).toBe("deterministic");
    expect(result.text).toBe(FALLBACK.text);
  });

  it("never throws on adversarial/garbage input", () => {
    expect(() => parseNarrative("{{{not json or anything sensible ((( 999999", "?", facts, FALLBACK)).not.toThrow();
    expect(() => parseNarrative(undefined as unknown as string, null, facts, FALLBACK)).not.toThrow();
  });

  it("the returned narrative never lets the model choose an id/status/metricKey/scope — the type has no such field", () => {
    const result = parseNarrative("Completed 12 tasks.", "hermes-local", facts, FALLBACK);
    expect(Object.keys(result).sort()).toEqual(["groundingHash", "model", "source", "text"].sort());
  });
});
