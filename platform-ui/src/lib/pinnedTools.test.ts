import { describe, it, expect } from "vitest";
import { MAX_PINNED_TOOLS, parsePinnedTools, pinnedToolsFor } from "./pinnedTools";
import { workspaceFor } from "./workspaces";

const tool = (key: string) => ({ key, label: key, desc: "", url: "https://x.test", glyph: "x" });
const ws = (keys: string[]) => ({ key: "w", tools: keys.map(tool) });
const keysOf = (l: { key: string }[]) => l.map((t) => t.key);

describe("parsePinnedTools", () => {
  it("reads anything that is not a plain object as {}", () => {
    for (const raw of [undefined, null, "x", 3, true, [], [["a"]]]) expect(parsePinnedTools(raw)).toEqual({});
  });

  it("drops lists that are not arrays and values that are not strings", () => {
    expect(parsePinnedTools({ a: "claude", b: { 0: "x" }, c: [1, null, {}, "ok", ""] })).toEqual({ c: ["ok"] });
  });

  it("deduplicates and caps each list at 6, keeping the first ones", () => {
    expect(parsePinnedTools({ w: ["a", "b", "a", "c", "d", "e", "f", "g", "h"] })).toEqual({ w: ["a", "b", "c", "d", "e", "f"] });
    expect(MAX_PINNED_TOOLS).toBe(6);
  });

  it("drops keys and values longer than 64 characters", () => {
    const long = "x".repeat(65);
    expect(parsePinnedTools({ [long]: ["a"], w: [long, "x".repeat(64)] })).toEqual({ w: ["x".repeat(64)] });
  });

  it("keeps at most 20 workspace keys", () => {
    const raw = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`w${i}`, ["a"]]));
    expect(Object.keys(parsePinnedTools(raw))).toHaveLength(20);
  });

  it("keeps an explicit empty list", () => {
    expect(parsePinnedTools({ w: [] })).toEqual({ w: [] });
  });
});

describe("pinnedToolsFor", () => {
  const eight = ws(["a", "b", "c", "d", "e", "f", "g", "h"]);

  it("defaults to the first six of the workspace's tools when it has no entry", () => {
    expect(keysOf(pinnedToolsFor({}, eight))).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(keysOf(pinnedToolsFor({ other: ["g"] }, eight))).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(keysOf(pinnedToolsFor({}, ws(["a", "b"])))).toEqual(["a", "b"]);
  });

  it("treats an explicit [] as 'pin nothing', not as the default", () => {
    expect(pinnedToolsFor({ w: [] }, eight)).toEqual([]);
  });

  it("returns the chosen tools in REGISTRY order, whatever order they were stored in", () => {
    expect(keysOf(pinnedToolsFor({ w: ["h", "b", "d"] }, eight))).toEqual(["b", "d", "h"]);
  });

  it("ignores keys the workspace does not have", () => {
    expect(keysOf(pinnedToolsFor({ w: ["nope", "c", "zzz"] }, eight))).toEqual(["c"]);
  });

  it("does not read inherited object keys as an entry", () => {
    expect(keysOf(pinnedToolsFor({}, { key: "constructor", tools: eight.tools }))).toHaveLength(6);
  });

  it("works on the real registry: Web Dev's six tools are all pinned by default", () => {
    const web = workspaceFor("agency", "Web Dev");
    expect(keysOf(pinnedToolsFor({}, web))).toEqual(["claude-code", "claude", "claude-design", "github", "figma", "vscode"]);
  });
});
