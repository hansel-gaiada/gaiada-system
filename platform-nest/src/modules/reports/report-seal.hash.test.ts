import { describe, it, expect } from "vitest";
import { computeSealHash, type SealedDocumentEntry } from "./report-seal";
import type { ReportDocument } from "./report-document";

// TR-15 seal_hash — pure unit tests, no DB. The DB-backed "seal_hash verifies" case in
// report-seal.db.test.ts caught the undefined-property bug but could not localise it; these pin the
// canonicalisation contract directly, so a regression fails here in milliseconds instead of behind a
// live-Postgres suite.
const entry = (grain: SealedDocumentEntry["grain"], scopeRef: string, document: unknown): SealedDocumentEntry =>
  ({ grain, scopeRef, document: document as ReportDocument });

describe("computeSealHash", () => {
  it("ignores key order — the JSONB round-trip does not preserve it", () => {
    const a = entry("person", "u1", { header: { sealed: true, revision: 0 }, kpis: [{ metricKey: "m", value: 1 }] });
    const b = entry("person", "u1", { kpis: [{ value: 1, metricKey: "m" }], header: { revision: 0, sealed: true } });
    expect(computeSealHash([a])).toBe(computeSealHash([b]));
  });

  it("ignores entry order — the fan-out that builds them is unordered", () => {
    const p = entry("person", "u1", { v: 1 });
    const c = entry("company", "co", { v: 2 });
    expect(computeSealHash([p, c])).toBe(computeSealHash([c, p]));
  });

  it("treats an undefined property as absent, exactly as the JSONB write does", () => {
    // THE BUG: JSON.stringify drops `delta` when writing the row, but canonicalStringify used to
    // interpolate the literal text "undefined" for it — so the hash taken at seal time could never
    // match a hash taken over the stored row, and seal_hash verified nothing.
    const built = entry("person", "u1", { value: 3, delta: undefined });
    const stored = entry("person", "u1", JSON.parse(JSON.stringify({ value: 3, delta: undefined })));
    expect(computeSealHash([built])).toBe(computeSealHash([stored]));
  });

  it("survives a full JSON round-trip of a nested document with optional fields left undefined", () => {
    const doc = {
      header: { grain: "person", sealed: true, customLabel: undefined },
      kpis: [
        { metricKey: "delivery.tasks_completed", value: 4, delta: undefined, unit: "count" },
        { metricKey: "quality.reopen_rate", value: 0, delta: -0.5, unit: undefined },
      ],
      narrative: { source: "model", text: "…", model: undefined },
    };
    const built = entry("person", "u1", doc);
    const stored = entry("person", "u1", JSON.parse(JSON.stringify(doc)));
    expect(computeSealHash([built])).toBe(computeSealHash([stored]));
  });

  it("keeps an undefined ARRAY element as null, since JSON has no holes", () => {
    const built = entry("person", "u1", { xs: [1, undefined, 3] });
    const stored = entry("person", "u1", JSON.parse(JSON.stringify({ xs: [1, undefined, 3] })));
    expect(computeSealHash([built])).toBe(computeSealHash([stored]));
  });

  it("still detects a real change — this is a tamper-evidence check, not a normaliser", () => {
    const a = entry("person", "u1", { value: 3 });
    const b = entry("person", "u1", { value: 4 });
    expect(computeSealHash([a])).not.toBe(computeSealHash([b]));
    // A value explicitly set to null is NOT the same as absent: null survives the write.
    expect(computeSealHash([entry("person", "u1", { v: null })])).not.toBe(computeSealHash([entry("person", "u1", {})]));
  });
});
