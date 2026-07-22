import { describe, it, expect } from "vitest";
import { normalizeEnvelope, isFullyIncluded, mergeLegs } from "./envelope";

describe("normalizeEnvelope", () => {
  it("passes the canonical shape through, defaulting a missing reason on excluded rows", () => {
    const env = normalizeEnvelope<{ id: string }>({
      items: [{ id: "x" }],
      companies: [
        { id: "co-a", name: "A", included: true },
        { id: "co-b", name: "B", included: false }, // no reason given
      ],
    });
    expect(env.items).toEqual([{ id: "x" }]);
    expect(env.companies).toEqual([
      { id: "co-a", name: "A", included: true, reason: undefined },
      { id: "co-b", name: "B", included: false, reason: "no_access" },
    ]);
  });

  it("never overwrites an explicit reason", () => {
    const env = normalizeEnvelope<unknown>({ items: [], companies: [{ id: "co-a", name: "A", included: false, reason: "suspended" }] });
    expect(env.companies[0].reason).toBe("suspended");
  });

  it("treats a bare array as fully-included with no company breakdown", () => {
    const env = normalizeEnvelope<number>([1, 2, 3]);
    expect(env).toEqual({ items: [1, 2, 3], companies: [] });
  });

  it("falls back on anything else instead of throwing", () => {
    expect(normalizeEnvelope(null)).toEqual({ items: [], companies: [] });
    expect(normalizeEnvelope(undefined, { items: ["x"], companies: [] })).toEqual({ items: ["x"], companies: [] });
  });
});

describe("isFullyIncluded", () => {
  it("true when every company is included, false otherwise", () => {
    expect(isFullyIncluded([{ id: "a", name: "A", included: true }])).toBe(true);
    expect(isFullyIncluded([{ id: "a", name: "A", included: true }, { id: "b", name: "B", included: false }])).toBe(false);
    expect(isFullyIncluded([])).toBe(true); // vacuously true — no banner for zero companies
  });
});

describe("mergeLegs", () => {
  it("flattens ok legs' rows into items and tags every leg in companies", () => {
    const env = mergeLegs<{ id: string }>([
      { company: { id: "co-a", name: "A" }, ok: true, rows: [{ id: "1" }] },
      { company: { id: "co-b", name: "B" }, ok: false, rows: [], reason: "no_access" },
    ]);
    expect(env.items).toEqual([{ id: "1" }]);
    expect(env.companies).toEqual([
      { id: "co-a", name: "A", included: true, reason: undefined },
      { id: "co-b", name: "B", included: false, reason: "no_access" },
    ]);
  });

  it("defaults a failing leg's reason to error when none given", () => {
    const env = mergeLegs<never>([{ company: { id: "co-a", name: "A" }, ok: false, rows: [] }]);
    expect(env.companies[0].reason).toBe("error");
  });
});
