import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
    set: (k: string, v: string) => { store.set(k, v); },
  }),
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

// One extra workspace with eight tools, so the cap of six can be reached. Everything else is the real registry.
const BIG_TOOLS = ["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => ({ key, label: key, desc: "", url: "https://x.test", glyph: "x" }));
vi.mock("./workspaces", async (orig) => {
  const real = await orig<typeof import("./workspaces")>();
  return { ...real, workspaceBySlug: (slug: string) => (slug === "big" ? ({ key: "big", tools: BIG_TOOLS } as never) : real.workspaceBySlug(slug)) };
});

import { getPrefs } from "./prefs";
import { togglePinnedToolAction } from "./prefsActions";

const pins = async () => (await getPrefs()).pinnedTools;

beforeEach(() => { store.clear(); revalidatePath.mockClear(); });

describe("togglePinnedToolAction", () => {
  it("unpinning one of the default six stores the other five, in registry order", async () => {
    await togglePinnedToolAction("web-dev", "figma");
    expect((await pins())["web-dev"]).toEqual(["claude-code", "claude", "claude-design", "github", "vscode"]);
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("pins it back, in registry order", async () => {
    await togglePinnedToolAction("web-dev", "figma");
    await togglePinnedToolAction("web-dev", "figma");
    expect((await pins())["web-dev"]).toEqual(["claude-code", "claude", "claude-design", "github", "figma", "vscode"]);
  });

  it("can unpin everything, and that stays an explicit []", async () => {
    for (const k of ["claude-code", "claude", "claude-design", "github", "figma", "vscode"]) await togglePinnedToolAction("web-dev", k);
    expect((await pins())["web-dev"]).toEqual([]);
  });

  it("refuses silently, writing nothing, for an unknown workspace or a tool that is not in it", async () => {
    await togglePinnedToolAction("web-dev", "photopea");
    await togglePinnedToolAction("nope", "claude");
    await togglePinnedToolAction("web-dev", "__proto__");
    await togglePinnedToolAction(undefined as unknown as string, "claude");
    expect(store.size).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a seventh pin, with no write", async () => {
    // Eight tools, none stored: the first six read as pinned, so "g" is a seventh.
    await togglePinnedToolAction("big", "g");
    expect(store.size).toBe(0);
    // Unpin one of the six, and the freed place can take "g".
    await togglePinnedToolAction("big", "a");
    expect((await pins()).big).toEqual(["b", "c", "d", "e", "f"]);
    await togglePinnedToolAction("big", "g");
    expect((await pins()).big).toEqual(["b", "c", "d", "e", "f", "g"]);
    // Full again: "h" is refused and the stored list is unchanged.
    await togglePinnedToolAction("big", "h");
    expect((await pins()).big).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("writes nothing for the generic workspace, which has no tools to pin", async () => {
    await togglePinnedToolAction("generic", "claude");
    expect(store.size).toBe(0);
  });

  it("leaves the other prefs alone", async () => {
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark" }));
    await togglePinnedToolAction("seo", "gsc");
    const p = await getPrefs();
    expect(p.theme).toBe("dark");
    expect(p.pinnedTools.seo).toEqual(["ga4", "google-ads", "looker", "claude"]);
  });
});
