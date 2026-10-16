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

// One extra workspace with a ticketed (not built) widget and a long list, so the refusals and the cap can be reached.
// Everything else is the real registry.
const MANY = Array.from({ length: 26 }, (_, i) => ({ key: `w-${i}`, band: "work", label: `W ${i}` }));
const TESTING = {
  key: "testing",
  overview: [{ key: "planned", band: "now", label: "Planned", ticket: "DW-9" }, { key: "today", band: "now", label: "Today" }, ...MANY],
};
vi.mock("./workspaces", async (orig) => {
  const real = await orig<typeof import("./workspaces")>();
  return { ...real, workspaceBySlug: (slug: string) => (slug === "testing" ? (TESTING as never) : real.workspaceBySlug(slug)) };
});

import { getPrefs } from "./prefs";
import { setOverviewWidgetAction } from "./prefsActions";

const overview = async () => (await getPrefs()).overview;

beforeEach(() => { store.clear(); revalidatePath.mockClear(); });

describe("setOverviewWidgetAction: a default widget", () => {
  it("hides it, and the Overview redraws", async () => {
    await setOverviewWidgetAction("web-dev", "my-activity", false);
    expect(await overview()).toEqual({ "web-dev": { hide: ["my-activity"], show: [] } });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("shows it again, and a workspace left with no choice leaves no entry", async () => {
    await setOverviewWidgetAction("web-dev", "my-activity", false);
    await setOverviewWidgetAction("web-dev", "my-activity", true);
    expect(await overview()).toEqual({});
  });

  it("stores the hidden ones in registry order, whatever order they were hidden in", async () => {
    await setOverviewWidgetAction("web-dev", "learning", false);
    await setOverviewWidgetAction("web-dev", "today", false);
    await setOverviewWidgetAction("web-dev", "my-activity", false);
    expect((await overview())["web-dev"].hide).toEqual(["today", "my-activity", "learning"]);
  });

  it("hiding twice is the same as hiding once", async () => {
    await setOverviewWidgetAction("web-dev", "pulse", false);
    await setOverviewWidgetAction("web-dev", "pulse", false);
    expect((await overview())["web-dev"].hide).toEqual(["pulse"]);
  });
});

describe("setOverviewWidgetAction: an optional widget", () => {
  it("switches Client health on and off, and a workspace left with no choice leaves no entry", async () => {
    await setOverviewWidgetAction("web-dev", "client-health", true);
    expect(await overview()).toEqual({ "web-dev": { hide: [], show: ["client-health"] } });
    await setOverviewWidgetAction("web-dev", "client-health", false);
    expect(await overview()).toEqual({});
  });

  it("is per workspace: switching it on in Web Dev leaves SEO as it was, and 'company' is its own list", async () => {
    await setOverviewWidgetAction("web-dev", "client-health", true);
    await setOverviewWidgetAction("company", "company-client-health", true);
    await setOverviewWidgetAction("web-dev", "pulse", false);
    expect(await overview()).toEqual({
      "web-dev": { hide: ["pulse"], show: ["client-health"] },
      company: { hide: [], show: ["company-client-health"] },
    });
  });

  it("switching it 'off' when it was never on writes nothing new", async () => {
    await setOverviewWidgetAction("web-dev", "client-health", false);
    expect(await overview()).toEqual({});
  });
});

describe("setOverviewWidgetAction: refusals write nothing", () => {
  it("refuses a fixed widget: Needs you, a head's condition banner and the company's decisions cannot be hidden", async () => {
    await setOverviewWidgetAction("web-dev", "needs-you", false);
    await setOverviewWidgetAction("web-dev", "condition", false);
    await setOverviewWidgetAction("company", "decisions", false);
    await setOverviewWidgetAction("web-dev", "needs-you", true);
    expect(store.size).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a widget that is still ticketed", async () => {
    await setOverviewWidgetAction("testing", "planned", false);
    await setOverviewWidgetAction("testing", "planned", true);
    expect(store.size).toBe(0);
  });

  it("refuses an unknown workspace, an unknown widget, and a prototype key", async () => {
    await setOverviewWidgetAction("nope", "today", false);
    await setOverviewWidgetAction("web-dev", "nope", false);
    await setOverviewWidgetAction("web-dev", "__proto__", false);
    await setOverviewWidgetAction("__proto__", "today", false);
    await setOverviewWidgetAction("constructor", "today", false);
    await setOverviewWidgetAction("", "", false);
    expect(store.size).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("refuses a widget that belongs to another workspace's overview", async () => {
    // `decisions` is the company list's; `condition`-less lists do not carry `company-campaigns`.
    await setOverviewWidgetAction("web-dev", "decisions", false);
    await setOverviewWidgetAction("web-dev", "company-campaigns", false);
    await setOverviewWidgetAction("company", "my-activity", false);
    await setOverviewWidgetAction("company", "pulse", false);
    expect(store.size).toBe(0);
  });

  it("refuses the Office of the GM's own slug: its choices are the company's", async () => {
    await setOverviewWidgetAction("gm", "today", false);
    expect(store.size).toBe(0);
  });

  it("refuses arguments of the wrong type", async () => {
    await setOverviewWidgetAction(undefined as unknown as string, "today", false);
    await setOverviewWidgetAction("web-dev", 3 as unknown as string, false);
    await setOverviewWidgetAction("web-dev", "today", "yes" as unknown as boolean);
    await setOverviewWidgetAction("web-dev", "today", undefined as unknown as boolean);
    expect(store.size).toBe(0);
  });

  it("refuses a 25th hidden widget", async () => {
    for (let i = 0; i < 24; i++) await setOverviewWidgetAction("testing", `w-${i}`, false);
    expect((await overview()).testing.hide).toHaveLength(24);
    await setOverviewWidgetAction("testing", "w-24", false);
    expect((await overview()).testing.hide).toHaveLength(24);
  });
});

describe("setOverviewWidgetAction: the rest of the prefs", () => {
  it("leaves the other prefs and the pins alone", async () => {
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", pinnedTools: { seo: ["ga4"] } }));
    await setOverviewWidgetAction("seo", "my-activity", false);
    const p = await getPrefs();
    expect(p.theme).toBe("dark");
    expect(p.pinnedTools).toEqual({ seo: ["ga4"] });
    expect(p.overview).toEqual({ seo: { hide: ["my-activity"], show: [] } });
  });

  it("keeps the other list when it changes one, and drops a stored key the registry no longer knows from the list it edits", async () => {
    store.set("gaiada_prefs", JSON.stringify({ overview: { "web-dev": { hide: ["gone", "learning"], show: ["client-health"] } } }));
    await setOverviewWidgetAction("web-dev", "my-activity", false);
    expect((await overview())["web-dev"]).toEqual({ hide: ["my-activity", "learning"], show: ["client-health"] });
  });

  it("starts from a forged cookie's safe reading, never from its raw value", async () => {
    store.set("gaiada_prefs", JSON.stringify({ overview: { "web-dev": { hide: "everything", show: [1, 2] }, __proto__: { hide: ["x"] } } }));
    await setOverviewWidgetAction("web-dev", "today", false);
    expect(await overview()).toEqual({ "web-dev": { hide: ["today"], show: [] } });
  });
});
