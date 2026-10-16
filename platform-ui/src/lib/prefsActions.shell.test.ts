// DW-9d-2 (DW-D38): the layout switch is gone. A cookie written while the switch existed may still carry `shell` and
// `shellChosen`; neither is read any more, and both drop out of the cookie the next time anything writes the prefs.
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
    set: (k: string, v: string) => { store.set(k, v); },
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getPrefs } from "./prefs";
import * as prefsActions from "./prefsActions";
import { setAssistantRailCollapsedAction, setOfficeZoomAction, setThemeAction, togglePinnedToolAction } from "./prefsActions";

beforeEach(() => store.clear());

const stored = () => JSON.parse(store.get("gaiada_prefs") ?? "{}") as Record<string, unknown>;

describe("the retired layout switch (DW-D38)", () => {
  it("has no action to switch the layout", () => {
    expect(Object.keys(prefsActions)).not.toContain("setShellLayoutAction");
  });

  it("a cookie still holding shell classic and shellChosen true changes nothing in the prefs read", async () => {
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", shell: "classic", shellChosen: true }));
    const p = await getPrefs();
    expect(p.theme).toBe("dark");
    expect(p).not.toHaveProperty("shell");
    expect(p).not.toHaveProperty("shellChosen");
  });

  it("drops both retired keys from the cookie on the next write, and keeps the rest", async () => {
    for (const write of [
      () => setThemeAction("light"),
      () => setOfficeZoomAction(2),
      () => setAssistantRailCollapsedAction(true),
      () => togglePinnedToolAction("web-dev", "figma"),
    ]) {
      store.set("gaiada_prefs", JSON.stringify({ theme: "dark", shell: "classic", shellChosen: true }));
      await write();
      const raw = stored();
      expect(raw, String(write)).not.toHaveProperty("shell");
      expect(raw, String(write)).not.toHaveProperty("shellChosen");
    }
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", shell: "classic", shellChosen: true }));
    await setOfficeZoomAction(3);
    expect(stored()).toMatchObject({ theme: "dark", officeZoom: 3 });
  });
});
