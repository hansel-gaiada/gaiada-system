import { describe, it, expect } from "vitest";
import { encodePmScope, parsePmScope, PM_SCOPE_ALL, type PmScope } from "./pmScope";

describe("pmScope", () => {
  it("encodes each kind and round-trips through parse", () => {
    const cases: PmScope[] = [
      { kind: "all" },
      { kind: "department", id: "dept-1" },
      { kind: "project", id: "p-web-1" },
    ];
    for (const scope of cases) {
      expect(parsePmScope(encodePmScope(scope))).toEqual(scope);
    }
  });

  it("encodes 'all' as the literal string \"all\", never \"all:\"", () => {
    expect(encodePmScope(PM_SCOPE_ALL)).toBe("all");
  });

  it("department/project without an id encodes as 'all' (a malformed scope is never persisted as-is)", () => {
    expect(encodePmScope({ kind: "department" })).toBe("all");
    expect(encodePmScope({ kind: "project" })).toBe("all");
  });

  it("parse degrades anything unrecognised to @all rather than throwing", () => {
    expect(parsePmScope(undefined)).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope(null)).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope("")).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope("garbage")).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope("department:")).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope("project:")).toEqual(PM_SCOPE_ALL);
    expect(parsePmScope("company:foo")).toEqual(PM_SCOPE_ALL);
    // A stray colon inside an id must not truncate it (ids are opaque strings, not re-parsed).
    expect(parsePmScope("project:has:colons")).toEqual({ kind: "project", id: "has:colons" });
  });

  it("parses a plain 'all' the same as no cookie at all", () => {
    expect(parsePmScope("all")).toEqual(PM_SCOPE_ALL);
  });
});
