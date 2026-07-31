// TR-15 — pure tests for report-seal.ts's `computeSealHash` (no database). The full seal/amend/
// pin flow (the I/O half — recompute, build, write, upsert, emit) is covered end-to-end against
// live Postgres + Cerbos in report-seal.db.test.ts; this file pins only the hash's own contract:
// order-independence and change-sensitivity.
import { describe, it, expect } from "vitest";
import { computeSealHash, type SealedDocumentEntry } from "./report-seal";
import type { ReportDocument } from "./report-document";

function fakeDoc(v: number): ReportDocument {
  return {
    header: {
      tenantId: "t1",
      grain: "person",
      scopeRef: "u1",
      scopeName: "Alice",
      periodKind: "month",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      dayCount: 31,
      periodLabel: "July 2026",
      generatedAt: "2026-08-01T00:00:00.000Z",
      sealed: true,
    },
    kpis: [{ metricKey: "delivery.tasks_completed", label: "Tasks Completed", unit: "count", value: v, appraisalSafe: false }],
    series: [],
    distributions: [],
    tables: [],
    highlights: [],
    narrative: { source: "deterministic", text: `Completed ${v} tasks.` },
  };
}

describe("TR-15 computeSealHash (pure)", () => {
  it("is deterministic: hashing the same entry set twice yields the same hash", () => {
    const entries: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: fakeDoc(3) }];
    expect(computeSealHash(entries)).toBe(computeSealHash(entries));
  });

  it("is ORDER-INDEPENDENT: the same set of documents hashes identically regardless of array order", () => {
    const a: SealedDocumentEntry = { grain: "person", scopeRef: "u1", document: fakeDoc(3) };
    const b: SealedDocumentEntry = { grain: "project", scopeRef: "p1", document: fakeDoc(5) };
    const c: SealedDocumentEntry = { grain: "company", scopeRef: "t1", document: fakeDoc(8) };
    expect(computeSealHash([a, b, c])).toBe(computeSealHash([c, a, b]));
    expect(computeSealHash([a, b, c])).toBe(computeSealHash([b, c, a]));
  });

  it("changes if ANY document in the set changes (tamper sensitivity)", () => {
    const before: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: fakeDoc(3) }];
    const after: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: fakeDoc(4) }];
    expect(computeSealHash(before)).not.toBe(computeSealHash(after));
  });

  it("changes if the SET changes (a scope added/removed) even if every other document is identical", () => {
    const set1: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: fakeDoc(3) }];
    const set2: SealedDocumentEntry[] = [
      { grain: "person", scopeRef: "u1", document: fakeDoc(3) },
      { grain: "person", scopeRef: "u2", document: fakeDoc(3) },
    ];
    expect(computeSealHash(set1)).not.toBe(computeSealHash(set2));
  });

  it("is a 64-char lowercase hex sha256 digest", () => {
    const hash = computeSealHash([{ grain: "company", scopeRef: "t1", document: fakeDoc(0) }]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
