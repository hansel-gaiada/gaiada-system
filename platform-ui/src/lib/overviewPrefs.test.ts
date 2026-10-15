import { describe, it, expect } from "vitest";
import {
  COMPANY_PREFS_KEY, MAX_OVERVIEW_KEYS, MAX_OVERVIEW_WORKSPACES, effectiveWidgets, overviewPrefsFor, overviewPrefsKey, overviewWidgetsForKey, parseOverviewPrefs, widgetIsOn,
} from "./overviewPrefs";
import { COMPANY_OVERVIEW, WORKSPACES, GENERIC_WORKSPACE, type OverviewWidget } from "./workspaces";
import { COMPANY_SUBJECT, subjectOfRef } from "./overview";
import { resolveMyWorkspaces } from "./workspaceAccess";
import { agencyTree, me, member } from "./workspaceFixtures";

// DW-10d (DW-D34): the rules of the person's own Overview. The prefs are a set of choices, never an order.

const W: OverviewWidget[] = [
  { key: "needs-you", band: "now", label: "Needs you", placement: "fixed" },
  { key: "today", band: "now", label: "Today" },
  { key: "my-activity", band: "you", label: "My activity", placement: "default" },
  { key: "client-health", band: "work", label: "Client health", placement: "optional" },
  { key: "learning", band: "growth", label: "Learning" },
];
const keys = (ws: OverviewWidget[]) => ws.map((w) => w.key);

describe("parseOverviewPrefs", () => {
  it("reads anything that is not an object of objects as {}", () => {
    for (const bad of [undefined, null, "x", 3, true, [], [{ hide: ["a"] }]]) expect(parseOverviewPrefs(bad)).toEqual({});
    expect(parseOverviewPrefs({ w: "x", v: 3, u: null, t: ["a"] })).toEqual({});
  });

  it("keeps well-formed entries, de-duplicated, and drops a workspace with nothing to say", () => {
    expect(parseOverviewPrefs({ "web-dev": { hide: ["my-activity", "my-activity", "learning"], show: ["client-health"] }, seo: { hide: [], show: [] }, hr: {} })).toEqual({
      "web-dev": { hide: ["my-activity", "learning"], show: ["client-health"] },
    });
  });

  it("drops keys that are not registry-shaped slugs, too long, or not strings", () => {
    const out = parseOverviewPrefs({ seo: { hide: ["My Activity", "my_activity", "", "x".repeat(65), 7, null, {}, "ok-key", "x".repeat(64)], show: "nope" } });
    expect(out).toEqual({ seo: { hide: ["ok-key", "x".repeat(64)], show: [] } });
  });

  it("drops prototype keys as workspaces and as widgets, and never pollutes Object.prototype", () => {
    const raw = JSON.parse(
      '{"__proto__":{"hide":["a"],"show":[]},"constructor":{"hide":["a"]},"prototype":{"show":["a"]},"seo":{"hide":["__proto__","constructor","prototype","a"],"show":[]}}',
    );
    const out = parseOverviewPrefs(raw);
    expect(Object.keys(out)).toEqual(["seo"]);
    expect(out.seo.hide).toEqual(["a"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).hide).toBeUndefined();
  });

  it("caps the workspaces at 20 and each list at 24 keys", () => {
    const raw: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) raw[`ws-${i}`] = { hide: Array.from({ length: 40 }, (_, j) => `k-${j}`), show: [] };
    const out = parseOverviewPrefs(raw);
    expect(Object.keys(out)).toHaveLength(MAX_OVERVIEW_WORKSPACES);
    expect(out["ws-0"].hide).toHaveLength(MAX_OVERVIEW_KEYS);
    expect(out["ws-29"]).toBeUndefined();
  });
});

describe("overviewPrefsFor", () => {
  it("reads an own entry, and an empty choice for a workspace with none, including a prototype key", () => {
    const p = parseOverviewPrefs({ seo: { hide: ["today"], show: [] } });
    expect(overviewPrefsFor(p, "seo")).toEqual({ hide: ["today"], show: [] });
    expect(overviewPrefsFor(p, "hr")).toEqual({ hide: [], show: [] });
    expect(overviewPrefsFor(p, "constructor")).toEqual({ hide: [], show: [] });
    expect(overviewPrefsFor(p, "__proto__")).toEqual({ hide: [], show: [] });
  });
});

describe("effectiveWidgets", () => {
  it("with no choice made: every fixed and default widget, no optional one (today's Overview)", () => {
    expect(keys(effectiveWidgets(W, undefined))).toEqual(["needs-you", "today", "my-activity", "learning"]);
    expect(keys(effectiveWidgets(W, { hide: [], show: [] }))).toEqual(["needs-you", "today", "my-activity", "learning"]);
  });

  it("a fixed widget is never hidden, whatever the prefs say, even when listed in hide or show", () => {
    expect(keys(effectiveWidgets(W, { hide: ["needs-you", "today"], show: ["needs-you"] }))).toEqual(["needs-you", "my-activity", "learning"]);
  });

  it("a default widget is hidden only by hide; being listed in show changes nothing", () => {
    expect(keys(effectiveWidgets(W, { hide: ["my-activity"], show: [] }))).toEqual(["needs-you", "today", "learning"]);
    expect(keys(effectiveWidgets(W, { hide: [], show: ["my-activity"] }))).toEqual(["needs-you", "today", "my-activity", "learning"]);
  });

  it("an optional widget is on only when listed in show; hide does not switch it on", () => {
    expect(keys(effectiveWidgets(W, { hide: [], show: ["client-health"] }))).toEqual(["needs-you", "today", "my-activity", "client-health", "learning"]);
    expect(keys(effectiveWidgets(W, { hide: ["client-health"], show: [] }))).not.toContain("client-health");
  });

  it("the order is ALWAYS the registry's, even when the prefs list their keys reversed", () => {
    const out = effectiveWidgets(W, { hide: ["learning", "today"].reverse(), show: ["client-health"] });
    expect(keys(out)).toEqual(["needs-you", "my-activity", "client-health"]);
    const all = effectiveWidgets(W, { hide: [], show: ["client-health", "learning", "today", "needs-you"] });
    expect(keys(all)).toEqual(["needs-you", "today", "my-activity", "client-health", "learning"]);
  });

  it("ignores keys the registry does not know, and never mutates its input", () => {
    const before = JSON.stringify(W);
    expect(keys(effectiveWidgets(W, { hide: ["gone"], show: ["also-gone"] }))).toEqual(["needs-you", "today", "my-activity", "learning"]);
    expect(JSON.stringify(W)).toBe(before);
  });

  it("widgetIsOn is the same answer per widget", () => {
    expect(widgetIsOn(W[3], undefined)).toBe(false);
    expect(widgetIsOn(W[3], { hide: [], show: ["client-health"] })).toBe(true);
    expect(widgetIsOn(W[1], { hide: ["today"], show: [] })).toBe(false);
    expect(widgetIsOn(W[0], { hide: ["needs-you"], show: [] })).toBe(true);
  });
});

describe("which workspace a choice belongs to", () => {
  it("is the workspace key, and 'company' for the company list (the Company frame and the Office of the GM share it)", () => {
    const placed = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree({ frontend: ["u-1"] }) });
    expect(overviewPrefsKey(subjectOfRef(placed.mine[0]))).toBe("web-dev");
    expect(overviewPrefsKey(COMPANY_SUBJECT)).toBe(COMPANY_PREFS_KEY);
    const gm = WORKSPACES.find((w) => w.key === "gm")!;
    expect(overviewPrefsKey({ workspaceKey: gm.key, widgets: gm.overview })).toBe(COMPANY_PREFS_KEY);
  });

  it("resolves a stored key back to ITS overview list, and refuses a key that is no workspace's", () => {
    expect(overviewWidgetsForKey("web-dev")).toBe(WORKSPACES.find((w) => w.key === "web-dev")!.overview);
    expect(overviewWidgetsForKey("generic")).toBe(GENERIC_WORKSPACE.overview);
    expect(overviewWidgetsForKey(COMPANY_PREFS_KEY)).toBe(COMPANY_OVERVIEW);
    for (const bad of ["gm", "nope", "", "__proto__", "constructor", undefined as unknown as string, 3 as unknown as string]) expect(overviewWidgetsForKey(bad)).toBeNull();
  });
});
