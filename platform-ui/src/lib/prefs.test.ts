import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
    set: (k: string, v: string) => { store.set(k, v); },
  }),
}));

import { DEFAULT_PREFS, getPrefs, writePrefs } from "./prefs";

beforeEach(() => store.clear());

describe("prefs: pinnedTools (DW-6c)", () => {
  it("defaults to {} with no cookie", async () => {
    expect((await getPrefs()).pinnedTools).toEqual({});
    expect(DEFAULT_PREFS.pinnedTools).toEqual({});
  });

  it("round-trips through the cookie", async () => {
    await writePrefs({ ...DEFAULT_PREFS, shell: "workspaces", pinnedTools: { "web-dev": ["claude", "figma"], seo: [] } });
    const back = await getPrefs();
    expect(back.pinnedTools).toEqual({ "web-dev": ["claude", "figma"], seo: [] });
    expect(back.shell).toBe("workspaces");
  });

  it("reads a forged or malformed value as {} and keeps the other prefs", async () => {
    for (const bad of ["x", 3, [1], { w: "claude" }, null]) {
      store.set("gaiada_prefs", JSON.stringify({ theme: "dark", pinnedTools: bad }));
      const p = await getPrefs();
      expect(p.pinnedTools).toEqual({});
      expect(p.theme).toBe("dark");
    }
  });

  it("caps a forged list on read", async () => {
    store.set("gaiada_prefs", JSON.stringify({ pinnedTools: { w: ["a", "a", "b", "c", "d", "e", "f", "g"] } }));
    expect((await getPrefs()).pinnedTools).toEqual({ w: ["a", "b", "c", "d", "e", "f"] });
  });
});
