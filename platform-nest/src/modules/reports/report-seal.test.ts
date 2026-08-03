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

  // ─────────────────────── the round-trip invariant (regression, 2026-08-03) ───────────────────
  // THE contract this hash exists to serve: seal time hashes freshly-BUILT JS objects, verification
  // hashes those same documents read back out of a `jsonb` column. If those two can disagree, the
  // tamper check reports tampering that never happened — and reads exactly like a real detection.
  //
  // It DID disagree, for the commonest case there is. `computeHeaderWarnings` returns `undefined`
  // whenever a period has no warnings, so `header.warnings` is a present key with an undefined
  // value. `Object.keys()` lists it and `JSON.stringify(undefined)` returns the VALUE `undefined`,
  // which interpolated as the literal text `undefined` — while the jsonb write (a plain
  // `JSON.stringify`) omitted the key entirely. Sorting keys, which the original implementation did
  // do, cannot help with a key that only exists on ONE side.
  //
  // Asserted as an invariant over the round trip rather than against a frozen digest, so it keeps
  // holding if the canonical form is ever legitimately changed. report-seal.db.test.ts proves the
  // same thing through real Postgres; this proves it in 1ms with no services, which is what makes
  // it a gate rather than something only a full DB run can catch.
  const roundTrip = (e: SealedDocumentEntry[]): SealedDocumentEntry[] => JSON.parse(JSON.stringify(e));

  it("survives a JSON round-trip when a document carries an undefined-valued key (header.warnings)", () => {
    const doc = fakeDoc(3);
    const entries: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: { ...doc, header: { ...doc.header, warnings: undefined } } }];
    expect(computeSealHash(roundTrip(entries))).toBe(computeSealHash(entries));
  });

  it("hashes an explicitly-undefined optional key identically to that key being absent", () => {
    // The jsonb column cannot represent the difference, so neither may the hash — otherwise which
    // of the two shapes the builder happened to emit would decide whether a seal verifies.
    const doc = fakeDoc(3);
    const absent: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: doc }];
    const explicit: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: { ...doc, header: { ...doc.header, warnings: undefined } } }];
    expect(computeSealHash(explicit)).toBe(computeSealHash(absent));
  });

  it("still notices a warnings block that is actually PRESENT (the fix must not blanket-ignore the key)", () => {
    const doc = fakeDoc(3);
    const none: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: { ...doc, header: { ...doc.header, warnings: undefined } } }];
    const some: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: { ...doc, header: { ...doc.header, warnings: { adHoc: true } } } }];
    expect(computeSealHash(none)).not.toBe(computeSealHash(some));
  });

  it("survives a round-trip for a value carrying toJSON (a Date), rather than hashing it as {}", () => {
    // Not reachable through ReportDocument today (generatedAt is already an ISO string) but it is
    // the identical failure mode one field away: the object branch would find no own enumerable
    // keys on a Date and emit `{}`, while the jsonb write stores the ISO string.
    const doc = fakeDoc(3);
    const withDate = { ...doc, header: { ...doc.header, generatedAt: new Date("2026-08-01T00:00:00.000Z") as unknown as string } };
    const entries: SealedDocumentEntry[] = [{ grain: "person", scopeRef: "u1", document: withDate }];
    expect(computeSealHash(roundTrip(entries))).toBe(computeSealHash(entries));
  });
});
