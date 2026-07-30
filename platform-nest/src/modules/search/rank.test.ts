// SM-14 — pure unit tests for rank.ts: domain matching (findPropertyPosition) and drop detection
// (isRankDrop). No DB, no HTTP — mirrors sem-plan.test.ts / clustering.test.ts's split between pure-
// function tests and the controller-level integration file (search-rank.test.ts).
import { describe, it, expect } from "vitest";
import { findPropertyPosition, hostnameOf, isRankDrop, normalizeDomain } from "./rank";
import type { SerpResult } from "./providers/types";

describe("normalizeDomain / hostnameOf", () => {
  it("strips protocol, www, and any path/query", () => {
    expect(normalizeDomain("https://www.Example.com/foo?x=1")).toBe("example.com");
    expect(normalizeDomain("Example.com")).toBe("example.com");
    expect(normalizeDomain("www.example.com")).toBe("example.com");
    expect(normalizeDomain("HTTPS://WWW.EXAMPLE.COM")).toBe("example.com");
  });

  it("hostnameOf extracts + normalizes a URL's host, or null for garbage", () => {
    expect(hostnameOf("https://www.example.com/page")).toBe("example.com");
    expect(hostnameOf("https://blog.example.com/page")).toBe("blog.example.com");
    expect(hostnameOf("not a url")).toBeNull();
  });
});

describe("findPropertyPosition (SM-14 — domain matching into a dispatched SERP)", () => {
  const items = (...pairs: Array<[number, string]>): SerpResult["items"] =>
    pairs.map(([position, url]) => ({ position, url }));

  it("finds an exact-host match and reports its position + url", () => {
    const res = findPropertyPosition(
      items([1, "https://competitor.example.com/"], [2, "https://www.balibeach.test/rooms"], [3, "https://another.example.com/"]),
      "balibeach.test",
    );
    expect(res).toEqual({ position: 2, rankedUrl: "https://www.balibeach.test/rooms" });
  });

  it("matches a subdomain of the tracked property's domain", () => {
    const res = findPropertyPosition(items([4, "https://blog.balibeach.test/post"]), "balibeach.test");
    expect(res.position).toBe(4);
  });

  it("does NOT match a domain that merely CONTAINS the property's domain as a substring (e.g. evilbalibeach.test)", () => {
    const res = findPropertyPosition(items([1, "https://evilbalibeach.test/"]), "balibeach.test");
    expect(res).toEqual({ position: null, rankedUrl: null });
  });

  it("returns null/null — the honest 'not found' state — when the domain never appears", () => {
    const res = findPropertyPosition(items([1, "https://a.example.com/"], [2, "https://b.example.com/"]), "balibeach.test");
    expect(res).toEqual({ position: null, rankedUrl: null });
  });

  it("returns the BEST (lowest) position when the domain appears more than once", () => {
    const res = findPropertyPosition(
      items([5, "https://balibeach.test/a"], [1, "https://balibeach.test/b"], [3, "https://balibeach.test/c"]),
      "balibeach.test",
    );
    expect(res.position).toBe(1);
    expect(res.rankedUrl).toBe("https://balibeach.test/b");
  });

  it("ignores malformed URLs in the item list rather than throwing", () => {
    const res = findPropertyPosition(items([1, "not a url"], [2, "https://balibeach.test/"]), "balibeach.test");
    expect(res.position).toBe(2);
  });

  it("empty item list -> not found", () => {
    expect(findPropertyPosition([], "balibeach.test")).toEqual({ position: null, rankedUrl: null });
  });
});

describe("isRankDrop (design §12 SM-14 AC: 'drop emits event')", () => {
  it("no prior snapshot -> never a drop, regardless of the new position", () => {
    expect(isRankDrop(null, 5)).toBe(false);
    expect(isRankDrop(null, null)).toBe(false);
  });

  it("found -> not found is a drop", () => {
    expect(isRankDrop(3, null)).toBe(true);
  });

  it("found -> worse (numerically higher) position is a drop", () => {
    expect(isRankDrop(3, 8)).toBe(true);
  });

  it("found -> better (numerically lower) position is NOT a drop", () => {
    expect(isRankDrop(8, 3)).toBe(false);
  });

  it("found -> same position is NOT a drop", () => {
    expect(isRankDrop(5, 5)).toBe(false);
  });

  it("not found -> still not found is NOT a drop (nothing to regress from)", () => {
    expect(isRankDrop(null, null)).toBe(false);
  });

  it("not found -> newly found is NOT a drop (a gain, not a regression)", () => {
    // previousPosition null means "no snapshot" OR "was not found" — either way there is nothing to
    // regress FROM, so a newly-found position is excluded by the same null check.
    expect(isRankDrop(null, 1)).toBe(false);
  });
});
