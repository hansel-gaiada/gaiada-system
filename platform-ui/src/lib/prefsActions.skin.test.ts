// SCP-Kd (DW-D51): the personal choice of look, written through `setSkinChoiceAction` into the same prefs cookie as the theme.
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (store.has(k) ? { value: store.get(k) } : undefined),
    set: (k: string, v: string) => { store.set(k, v); },
  }),
}));
const revalidate = vi.hoisted(() => vi.fn());
vi.mock("next/cache", () => ({ revalidatePath: revalidate }));

import { getPrefs } from "./prefs";
import { setSkinChoiceAction } from "./prefsActions";
import type { SkinChoice } from "./skins";

beforeEach(() => { store.clear(); revalidate.mockClear(); });

describe("setSkinChoiceAction", () => {
  it("writes the skin choice into the prefs cookie, keeping the other prefs", async () => {
    store.set("gaiada_prefs", JSON.stringify({ theme: "dark", density: "compact" }));
    await setSkinChoiceAction("standard");
    expect(await getPrefs()).toMatchObject({ skin: "standard", theme: "dark", density: "compact" });
    await setSkinChoiceAction("workspace");
    expect((await getPrefs()).skin).toBe("workspace");
  });

  it("refreshes the layout, which builds the shell model from this cookie", async () => {
    await setSkinChoiceAction("standard");
    expect(revalidate).toHaveBeenCalledWith("/", "layout");
  });

  it("refuses a value that is not a choice, with no write", async () => {
    await setSkinChoiceAction("social" as unknown as SkinChoice);
    await setSkinChoiceAction(undefined as unknown as SkinChoice);
    expect(store.size).toBe(0);
    expect(revalidate).not.toHaveBeenCalled();
  });
});
