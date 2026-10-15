// DW-9d-1: the workspace shell is the default for everyone, and only a person who CHOSE classic keeps
// it. Every prefs writer spreads the whole cookie, so a stored `shell: "classic"` without `shellChosen`
// is a leftover default (classic was the default until DW-9d-1), never a choice.
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
import { setAssistantRailCollapsedAction, setOfficeZoomAction, setShellLayoutAction, setThemeAction, togglePinnedToolAction } from "./prefsActions";

beforeEach(() => store.clear());

describe("shell default and shellChosen (DW-9d-1)", () => {
  it("no cookie reads as the workspace shell", async () => {
    const p = await getPrefs();
    expect(p.shell).toBe("workspaces");
    expect(p.shellChosen).toBe(false);
  });

  it("a stored classic WITHOUT the flag is ignored", async () => {
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", shell: "classic" }));
    const p = await getPrefs();
    expect(p.shell).toBe("workspaces");
    expect(p.theme).toBe("dark");
  });

  it("a stored classic WITH the flag is kept", async () => {
    store.set("gaiada_prefs", JSON.stringify({ shell: "classic", shellChosen: true }));
    const p = await getPrefs();
    expect(p.shell).toBe("classic");
    expect(p.shellChosen).toBe(true);
  });

  it("a non-boolean flag does not count", async () => {
    store.set("gaiada_prefs", JSON.stringify({ shell: "classic", shellChosen: "true" }));
    expect((await getPrefs()).shell).toBe("workspaces");
  });

  it("setThemeAction on a fresh cookie does not make anyone classic", async () => {
    await setThemeAction("dark");
    const p = await getPrefs();
    expect(p.theme).toBe("dark");
    expect(p.shell).toBe("workspaces");
    expect(p.shellChosen).toBe(false);
  });

  it("a legacy cookie with shell classic and no flag stays on workspaces after another writer runs", async () => {
    store.set("gaiada_prefs", JSON.stringify({ shell: "classic", theme: "light" }));
    await setOfficeZoomAction(2);
    await setAssistantRailCollapsedAction(true);
    await togglePinnedToolAction("web-dev", "figma");
    expect((await getPrefs()).shell).toBe("workspaces");
  });

  it("setShellLayoutAction('classic') is a choice, and later writers keep it", async () => {
    await setShellLayoutAction("classic");
    expect((await getPrefs()).shell).toBe("classic");
    await setThemeAction("dark");
    await setOfficeZoomAction(3);
    await setAssistantRailCollapsedAction(true);
    await togglePinnedToolAction("web-dev", "figma");
    const p = await getPrefs();
    expect(p.shell).toBe("classic");
    expect(p.shellChosen).toBe(true);
    expect(p.theme).toBe("dark");
  });

  it("switching back to workspaces is also a choice", async () => {
    await setShellLayoutAction("classic");
    await setShellLayoutAction("workspaces");
    const p = await getPrefs();
    expect(p.shell).toBe("workspaces");
    expect(p.shellChosen).toBe(true);
  });
});
