// DW-6f (docs/FRONTEND-BFF-CONTRACT.md §34.5, §34.4) — the PURE halves of the pull-request feature, no database:
// the task-key extraction behind the link rule, and the CI summary. The database half of the link (a key that names no
// project, a deleted task) and the whole webhook-to-read path are in github-pull-requests.db.test.ts.
import { describe, it, expect } from "vitest";
import { extractTaskKeys, candidateTaskKeys, summarizeCi, type CiRun } from "./github-pull-requests";

const codes = (text: string) => extractTaskKeys(text).map((k) => `${k.code}-${k.seq}`);
const pair = (title: string, ref: string) => candidateTaskKeys(title, ref).map((k) => `${k.code}-${k.seq}`);

describe("extractTaskKeys (§34.5 candidate keys)", () => {
  it("finds a key in a title", () => {
    expect(codes("WEB-12 fix the nav")).toEqual(["WEB-12"]);
    expect(codes("fix the nav (WEB-12)")).toEqual(["WEB-12"]);
    expect(codes("[WEB-12] fix the nav")).toEqual(["WEB-12"]);
  });

  it("is case-insensitive and compares upper-cased, keeping the key as written", () => {
    const [k] = extractTaskKeys("feature/web-12-nav");
    expect(k).toEqual({ raw: "web-12", code: "WEB", seq: 12 });
  });

  it("finds a lowercase key in a branch name", () => {
    expect(codes("feature/web-12-nav")).toEqual(["WEB-12"]);
    expect(codes("web-12")).toEqual(["WEB-12"]);
    expect(codes("fix_web-12_nav")).toEqual(["WEB-12"]); // an underscore is not a letter or digit
  });

  it("returns several keys left to right, a repeat once", () => {
    expect(codes("WEB-2 and API-10, then WEB-2 again, and Ops-7")).toEqual(["WEB-2", "API-10", "OPS-7"]);
    expect(codes("WEB-2 web-2")).toEqual(["WEB-2"]);
  });

  it("returns nothing when there is no key", () => {
    expect(codes("fix the nav")).toEqual([]);
    expect(codes("")).toEqual([]);
    expect(extractTaskKeys(null)).toEqual([]);
    expect(extractTaskKeys(undefined)).toEqual([]);
    expect(codes("2026-10-13 release")).toEqual([]); // a key starts with a letter
    expect(codes("A-1")).toEqual([]); // the code is a letter plus at least one more
    expect(codes("WEB-")).toEqual([]);
    expect(codes("WEB 12")).toEqual([]);
  });

  it("does not match a key glued to a letter or digit on either side", () => {
    expect(codes("WEB-12x")).toEqual([]);
    expect(codes("WEB-12abc")).toEqual([]);
    expect(codes("WEB-1234567")).toEqual([]); // seven digits
    expect(codes("1WEB-12")).toEqual([]);
    expect(codes("fooWEB-12")).toEqual(["FOOWEB-12"]); // a different (longer) code, never WEB-12
    expect(codes("fooWEB-12")).not.toContain("WEB-12");
    expect(codes("ABCDEFGHIJK-1")).toEqual([]); // eleven characters in the code
  });

  it("accepts the bounds: 2 to 10 characters in the code, 1 to 6 digits", () => {
    expect(codes("AB-1")).toEqual(["AB-1"]);
    expect(codes("ABCDEFGHIJ-123456")).toEqual(["ABCDEFGHIJ-123456"]);
    expect(codes("W3-5")).toEqual(["W3-5"]); // letters and digits after the first letter
  });

  it("sits between non-alphanumerics: slashes, hyphens, dots, brackets and the ends all bound a key", () => {
    expect(codes("feature/WEB-12-nav")).toEqual(["WEB-12"]);
    expect(codes("WEB-12.")).toEqual(["WEB-12"]);
    expect(codes("(WEB-12)")).toEqual(["WEB-12"]);
    expect(codes("fix/api-3")).toEqual(["API-3"]);
  });

  it("reads the sequence number as an integer", () => {
    expect(extractTaskKeys("WEB-0012")[0]).toMatchObject({ code: "WEB", seq: 12 });
  });
});

describe("candidateTaskKeys (title first, then branch)", () => {
  it("puts the title's keys before the branch's", () => {
    expect(pair("API-1 something", "feature/web-12-nav")).toEqual(["API-1", "WEB-12"]);
  });

  it("uses the branch alone when the title has no key", () => {
    expect(pair("add the nav", "feature/web-12-nav")).toEqual(["WEB-12"]);
  });

  it("keeps several keys, each side left to right, a key named in both once", () => {
    expect(pair("WEB-3 and WEB-1", "web-3-and-api-2")).toEqual(["WEB-3", "WEB-1", "API-2"]);
  });

  it("is empty with nothing in either", () => {
    expect(pair("add the nav", "feature/nav")).toEqual([]);
    expect(candidateTaskKeys(null, undefined)).toEqual([]);
  });

  it("caps the candidates it will send to the database", () => {
    const many = Array.from({ length: 50 }, (_, i) => `WEB-${i + 1}`).join(" ");
    expect(candidateTaskKeys(many, "").length).toBe(20);
  });
});

describe("summarizeCi (§34.4, computed on read)", () => {
  const run = (status: string, conclusion: string | null): CiRun => ({ runId: 1, status, conclusion, url: null, at: null });
  const one = (status: string, conclusion: string | null) => summarizeCi({ CI: run(status, conclusion) });

  it("is none with no entries", () => {
    expect(summarizeCi({})).toBe("none");
    expect(summarizeCi(null)).toBe("none");
    expect(summarizeCi(undefined)).toBe("none");
  });

  it.each(["success", "skipped", "neutral"])("a completed %s is passing", (conclusion) => {
    expect(one("completed", conclusion)).toBe("passing");
  });

  it.each(["failure", "timed_out", "cancelled", "action_required"])("a completed %s is failing", (conclusion) => {
    expect(one("completed", conclusion)).toBe("failing");
  });

  it.each(["startup_failure", "stale"])("a completed %s is failing too (not a pass)", (conclusion) => {
    expect(one("completed", conclusion)).toBe("failing");
  });

  it("a completed run with no conclusion is failing, never passing", () => {
    expect(one("completed", null)).toBe("failing");
  });

  it.each(["queued", "in_progress", "waiting", "requested", "pending"])("a %s run is running", (status) => {
    expect(one(status, null)).toBe("running");
  });

  it("failing outranks running, running outranks passing", () => {
    expect(summarizeCi({ A: run("completed", "failure"), B: run("in_progress", null), C: run("completed", "success") })).toBe("failing");
    expect(summarizeCi({ A: run("completed", "success"), B: run("in_progress", null) })).toBe("running");
    expect(summarizeCi({ A: run("completed", "success"), B: run("completed", "skipped"), C: run("completed", "neutral") })).toBe("passing");
  });
});
