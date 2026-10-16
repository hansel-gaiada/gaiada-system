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
    await writePrefs({ ...DEFAULT_PREFS, pinnedTools: { "web-dev": ["claude", "figma"], seo: [] } });
    const back = await getPrefs();
    expect(back.pinnedTools).toEqual({ "web-dev": ["claude", "figma"], seo: [] });
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

describe("prefs: overview (DW-10d)", () => {
  it("defaults to {} with no cookie, and an old cookie without the field reads {}", async () => {
    expect((await getPrefs()).overview).toEqual({});
    expect(DEFAULT_PREFS.overview).toEqual({});
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", pinnedTools: { seo: ["ga4"] } }));
    const p = await getPrefs();
    expect(p.overview).toEqual({});
    expect(p.pinnedTools).toEqual({ seo: ["ga4"] });
  });

  it("round-trips through the cookie, next to the pins", async () => {
    await writePrefs({ ...DEFAULT_PREFS, pinnedTools: { seo: ["ga4"] }, overview: { "web-dev": { hide: ["my-activity"], show: ["client-health"] } } });
    const back = await getPrefs();
    expect(back.overview).toEqual({ "web-dev": { hide: ["my-activity"], show: ["client-health"] } });
    expect(back.pinnedTools).toEqual({ seo: ["ga4"] });
  });

  it("reads a forged or malformed value as {} and keeps the other prefs", async () => {
    for (const bad of ["x", 3, [1], { w: "my-activity" }, { w: ["a"] }, { w: { hide: "a" } }, null]) {
      store.set("gaiada_prefs", JSON.stringify({ theme: "dark", overview: bad }));
      const p = await getPrefs();
      expect(p.overview).toEqual({});
      expect(p.theme).toBe("dark");
    }
  });

  it("drops forged keys and caps the lists on read", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `w-${i}`);
    store.set("gaiada_prefs", JSON.stringify({ overview: { seo: { hide: ["A b", "x".repeat(65), "my-activity", "my-activity", ...many], show: [] } } }));
    const hide = (await getPrefs()).overview.seo.hide;
    expect(hide).toHaveLength(24);
    expect(hide.slice(0, 3)).toEqual(["my-activity", "w-0", "w-1"]);
  });
});
