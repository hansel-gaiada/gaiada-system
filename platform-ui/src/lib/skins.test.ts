import { describe, it, expect } from "vitest";
import { SKINS, SKINS_ON, activePinKey, effectiveSkin, phoneBarFor, phoneMenuFor, phoneTopFor, pinnedFor, skinsOn, unpinnedTopTabs, type ConcretePinned, type PinnedItem } from "./skins";
import type { ConcreteRow } from "./workspaceAccess";
import { WORKSPACES, GENERIC_WORKSPACE, sidebarRows, workspaceBySlug } from "./workspaces";
import { buildShellModel, allRows, type ShellModel } from "./shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import { agencyTree, lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";
import { bespokeToolkit } from "./deptToolkits";

// SCP-Ka (DW-D51, plan §6.1): the skin seam. What a skin may change, what it never changes, and that Social stays off until Kg.

/** An agency company with a Social Media department (u-1 placed in it) and Web Dev. */
const socialTree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
]);

function model(m: Me, root: OrgTreeNode, skins?: Parameters<typeof buildShellModel>[0]["skins"]): ShellModel {
  return buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root }), ...(skins ? { skins } : {}) });
}
const wsByKey = (mod: ShellModel, key: string) => mod.workspaces.find((w) => w.key === key)!;

describe("skins: switched on", () => {
  it("draws Standard and, since SCP-Kg (owner, 2026-10-27), Social for everyone", () => {
    expect(SKINS_ON).toEqual(["standard", "social"]);
    expect(skinsOn(undefined)).toEqual(["standard", "social"]);
  });

  it("the preview adds nothing new now that Social is on, and ignores keys it does not know", () => {
    expect(skinsOn("social")).toEqual(["standard", "social"]);
    expect(skinsOn(" social , nope,,standard")).toEqual(["standard", "social"]);
    expect(skinsOn("")).toEqual(["standard", "social"]);
  });

  it("Social is on, and no pinned entry points at a page that does not exist: every entry's page is built, so none is ticketed", () => {
    // Settings (SCP-1c), Messages (SCP-1j), Profile (SCP-1k) and, last, the Dashboard (SCP-5d) are built, so their pins lost their tickets.
    expect(SKINS.social.pinned!.filter((p) => p.ticket).map((p) => p.key)).toEqual([]);
  });
});

describe("skins: which skin a workspace wears", () => {
  it("is its own skin only when that skin is on and the person kept it", () => {
    expect(effectiveSkin("social", ["standard", "social"])).toBe("social");
    expect(effectiveSkin("social", ["standard", "social"], "workspace")).toBe("social");
    expect(effectiveSkin("social", ["standard"])).toBe("standard");
    expect(effectiveSkin("social", ["standard", "social"], "standard")).toBe("standard");
    expect(effectiveSkin(undefined, ["standard", "social"])).toBe("standard");
  });

  it("follows the workspace: only Social Media carries a skin in the registry", () => {
    const skinned = [...WORKSPACES, GENERIC_WORKSPACE].filter((w) => w.skin && w.skin !== "standard").map((w) => [w.key, w.skin]);
    expect(skinned).toEqual([["social-media", "social"]]);
  });
});

describe("skins: the pinned menu", () => {
  it("Standard has no pinned menu: every row stays in its group", () => {
    expect(SKINS.standard.pinned).toBeNull();
    expect(pinnedFor("standard", [])).toBeNull();
  });

  it("every skin with a pinned menu keeps search, notifications, create and the AI Assistant", () => {
    for (const skin of Object.values(SKINS)) {
      if (!skin.pinned) continue;
      const live = skin.pinned.filter((p) => !p.ticket);
      expect(live.filter((p) => p.kind === "shell").map((p) => (p as Extract<PinnedItem, { kind: "shell" }>).item).sort(), skin.key)
        .toEqual(["create", "notifications", "search"]);
      expect(live.some((p) => p.kind === "row" && p.row === "assistant"), skin.key).toBe(true);
    }
  });

  it("every built Social entry opens a row and tab the Social Media workspace already has; the rest name the ticket that builds them", () => {
    const reg = sidebarRows(workspaceBySlug("social-media")!);
    const rows = [...reg.top, ...reg.work, ...reg.performance, ...reg.you];
    for (const p of SKINS.social.pinned!) {
      if (p.ticket) {
        expect(p.ticket, p.key).toMatch(/^SCP-/);
        continue;
      }
      if (p.kind === "shell") continue;
      const row = rows.find((r) => r.key === p.row);
      expect(row, `${p.key} -> ${p.row}`).toBeDefined();
      // A tab a later ticket builds may be missing while the entry falls back to the row's first tab (Reports, until SCP-5a).
      const fallsBack = p.kind === "row" && p.tabFallback === true;
      if (p.tab && !fallsBack) expect(row!.tabs.some((t) => t.key === p.tab), `${p.key} -> ${p.row}/${p.tab}`).toBe(true);
    }
    expect(new Set(SKINS.social.pinned!.map((p) => p.key)).size).toBe(SKINS.social.pinned!.length);
  });

  it("resolves only to pages the person's model offers, in order, and never a planned one", () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    const pinned = pinnedFor(soc.skin, allRows(soc))!;
    expect(pinned.map((p) => p.key)).toEqual(["home", "search", "messages", "notifications", "tasks", "create", "calendar", "reports", "saved", "profile", "assistant"]);
    const offered = new Set(allRows(soc).flatMap((r) => r.tabs.map((t) => t.href)));
    for (const p of pinned) if (p.kind === "link") expect(offered.has(p.href), p.key).toBe(true);
    expect(pinned.find((p) => p.key === "home")).toMatchObject({ kind: "link", label: "Home", href: "/departments/d-soc" });
  });

  const pinsOf = (m: Me) => {
    const soc = wsByKey(model(m, socialTree, { on: ["standard", "social"] }), "social-media");
    return pinnedFor(soc.skin, allRows(soc))!.map((p) => p.key);
  };

  it("the Dashboard (SCP-5d) is built and shows to the Social head only, never to an officer or an ancestor's head; Messages (SCP-1j) opens the registry's `messages` row and its first tab is `{dept}/messages`; Settings (SCP-1c) is built and shows to the Social head only, never to an officer or an ancestor's head", () => {
    expect(SKINS.social.pinned!.find((p) => p.key === "dashboard")).toEqual({ kind: "row", key: "dashboard", row: "dashboard", label: "Dashboard", icon: "dashboard" });
    // Settings is built: its pin names no ticket and opens the registry's `settings` row (the four approvers' page, `canLeadSocial`).
    expect(SKINS.social.pinned!.find((p) => p.key === "settings")).toEqual({ kind: "row", key: "settings", row: "settings", label: "Settings", icon: "settings" });
    const officer = pinsOf(me([member()]));
    expect(officer).not.toContain("dashboard");
    expect(officer).not.toContain("settings");
    // Messages is built: its pin names no ticket, every person offered the Social workspace gets it, and it opens the row's first tab, `{dept}/messages`.
    expect(SKINS.social.pinned!.find((p) => p.key === "messages")).toEqual({ kind: "row", key: "messages", row: "messages", label: "Messages", icon: "messages" });
    expect(officer).toContain("messages");
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    expect(pinnedFor("social", allRows(soc))!.find((p) => p.key === "messages")).toMatchObject({ kind: "link", label: "Messages", href: "/departments/d-soc/messages", row: "messages" });
    expect(pinsOf(me([member(), lead("d-soc")]))).toEqual([...officer, "dashboard", "settings"]);
    expect(pinsOf(me([member(), lead("root")]))).toEqual(officer);
    expect(pinsOf(me([member(), lead("d-web")]))).toEqual(officer);
  });

  it("the Reports pin opens the Social reports tab SCP-5a adds to the shared Reports row, and falls back to the row's first tab when that tab is not offered", () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    const reportsRow = allRows(soc).find((r) => r.key === "reports")!;
    const tab = reportsRow.tabs.find((t) => t.key === "social");
    expect(tab).toMatchObject({ label: "Social reports", href: "/departments/d-soc/social-reports" });
    expect(reportsRow.tabs.map((t) => t.key)).toEqual([...reportsRow.tabs.map((t) => t.key).filter((k) => k !== "social"), "social"]);
    const now = pinnedFor("social", allRows(soc))!.find((p) => p.key === "reports");
    expect(now).toMatchObject({ kind: "link", label: "Reports", href: "/departments/d-soc/social-reports", tab: "social" });
    // Without the tab (a synthetic row), the pin still opens the row's first tab.
    const without: ConcreteRow = { ...reportsRow, tabs: reportsRow.tabs.filter((t) => t.key !== "social") };
    const fallback = pinnedFor("social", [without])!.find((p) => p.key === "reports");
    expect(fallback).toMatchObject({ kind: "link", href: without.tabs[0].href, tab: without.tabs[0].key, wholeRow: true });
  });

  it("does not fall back for an entry that did not ask to: Calendar is dropped when its tab is not offered", () => {
    const rows: ConcreteRow[] = [{ key: "publish", label: "Publish", icon: "gateway", tabs: [{ key: "composer", label: "Composer", href: "/departments/d-soc/composer", icon: "pulse" }] }];
    expect(pinnedFor("social", rows)!.some((p) => p.key === "calendar")).toBe(false);
  });

  it("Saved opens the content bank (publish › saved, SCP-5e), and the Asset Library tab and the Social Media toolkit's declaration of it stay", () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    expect(SKINS.social.pinned!.find((p) => p.key === "saved")).toEqual({ kind: "row", key: "saved", row: "publish", tab: "saved", label: "Saved", icon: "bookmark" });
    expect(pinnedFor("social", allRows(soc))!.find((p) => p.key === "saved")).toMatchObject({ kind: "link", label: "Saved", href: "/departments/d-soc/saved", row: "publish", tab: "saved" });
    expect(bespokeToolkit("social-media")!.groups.flatMap((g) => g.tabs).some((t) => t.key === "assets" && t.path === "assets")).toBe(true);
    expect(allRows(soc).find((r) => r.key === "publish")!.tabs.map((t) => t.key)).toEqual(["calendar", "composer", "inbox", "assets", "saved"]);
  });

  it("carries a row's count on the entry that opens the row's first tab", () => {
    const rows = [{ key: "assistant", label: "AI Assistant", icon: "assistant" as const, count: 3, tabs: [{ key: "assistant", label: "AI Assistant", href: "/assistant", icon: "assistant" as const }] }];
    expect(pinnedFor("social", rows)!.find((p) => p.key === "assistant")).toMatchObject({ count: 3 });
  });
});

describe("skins: which pinned entry the page belongs to", () => {
  const link = (key: string, row: string, tab: string, over: Partial<Extract<ConcretePinned, { kind: "link" }>> = {}): ConcretePinned =>
    ({ kind: "link", key, label: key, icon: "home", href: `/${key}`, row, tab, wholeRow: false, ...over });
  const pins: ConcretePinned[] = [
    link("home", "overview", "overview"),
    link("calendar", "publish", "calendar"),
    link("reports", "reports", "mine", { wholeRow: true }),
    { kind: "shell", key: "search", item: "search", label: "Search", icon: "search" },
  ];

  it("is the entry that opens the active row and tab", () => {
    expect(activePinKey(pins, { rowKey: "overview", tabKey: "overview" })).toBe("home");
    expect(activePinKey(pins, { rowKey: "publish", tabKey: "calendar" })).toBe("calendar");
  });

  it("is none for a page the menu does not pin, instead of lighting Home for being a prefix", () => {
    expect(activePinKey(pins, { rowKey: "publish", tabKey: "composer" })).toBeNull();
    expect(activePinKey(pins, { rowKey: "overview", tabKey: "notices" })).toBeNull();
    expect(activePinKey(pins, null)).toBeNull();
  });

  it("lights an entry that stands for its whole row on any tab of the row", () => {
    expect(activePinKey(pins, { rowKey: "reports", tabKey: "team" })).toBe("reports");
  });
});

describe("skins: the shell model", () => {
  it("draws every workspace Standard when no skin is on, Social Media included", () => {
    for (const mod of [model(me([member()]), socialTree), model(me([member()]), socialTree, { on: ["standard"] })]) {
      expect(mod.workspaces.map((w) => w.skin)).toEqual(mod.workspaces.map(() => "standard"));
    }
  });

  it("gives Social Media its skin once Social is on, and every other workspace stays Standard", () => {
    const mod = model(me([member()]), socialTree, { on: ["standard", "social"] });
    expect(wsByKey(mod, "social-media").skin).toBe("social");
    expect(mod.workspaces.filter((w) => w.key !== "social-media").every((w) => w.skin === "standard")).toBe(true);
  });

  it("lets a person choose Standard for themselves", () => {
    const mod = model(me([member()]), socialTree, { on: ["standard", "social"], choice: "standard" });
    expect(mod.workspaces.every((w) => w.skin === "standard")).toBe(true);
  });

  it("changes nothing but the skin: the rows, creates and gates are the same in every skin", () => {
    const off = model(me([member()]), socialTree);
    const on = model(me([member()]), socialTree, { on: ["standard", "social"] });
    const strip = (mod: ShellModel) => ({ ...mod, workspaces: mod.workspaces.map(({ skin: _s, skinOffered: _o, ...w }) => w) });
    expect(strip(on)).toEqual(strip(off));
  });

  it("leaves a company with no Social Media department exactly as it was", () => {
    const m = me([member()]);
    expect(model(m, agencyTree({ web: ["u-1"] }), { on: ["standard", "social"] })).toEqual(model(m, agencyTree({ web: ["u-1"] })));
  });
});

describe("skins: the skin a workspace offers (SCP-Kd)", () => {
  it("is null for every workspace while Social is off, so the Standard menu offers nothing", () => {
    for (const mod of [model(me([member()]), socialTree), model(me([member()]), socialTree, { on: ["standard"] })]) {
      expect(mod.workspaces.map((w) => w.skinOffered)).toEqual(mod.workspaces.map(() => null));
    }
  });

  it("is 'social' on Social Media once Social is on, and null on every other workspace", () => {
    const mod = model(me([member()]), socialTree, { on: ["standard", "social"] });
    expect(wsByKey(mod, "social-media").skinOffered).toBe("social");
    expect(mod.workspaces.filter((w) => w.key !== "social-media").every((w) => w.skinOffered === null)).toBe(true);
  });

  it("stays 'social' when the person chose Standard, while the skin drawn is Standard: the way back", () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"], choice: "standard" }), "social-media");
    expect(soc.skin).toBe("standard");
    expect(soc.skinOffered).toBe("social");
  });
});

describe("skins: the phone (SCP-Ke)", () => {
  const socialPins = () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    return pinnedFor(soc.skin, allRows(soc))!;
  };

  it("Standard has no phone bar and no top entries", () => {
    expect(SKINS.standard.phoneBar).toEqual([]);
    expect(SKINS.standard.phoneTop).toEqual([]);
  });

  it("every phone entry names a pin of the skin, and no pin is in both places", () => {
    const keys = new Set(SKINS.social.pinned!.map((p) => p.key));
    for (const k of [...SKINS.social.phoneBar, ...SKINS.social.phoneTop]) expect(keys.has(k), k).toBe(true);
    expect(SKINS.social.phoneBar.filter((k) => SKINS.social.phoneTop.includes(k))).toEqual([]);
    // The design: Home, Search, Create, Tasks, Profile at the bottom; Notifications and Messages at the top.
    expect(SKINS.social.phoneBar).toEqual(["home", "search", "create", "tasks", "profile"]);
    expect(SKINS.social.phoneTop).toEqual(["notifications", "messages"]);
  });

  it("the bar holds the entries the person is offered, in the skin's order; Profile (SCP-1k) fills the fifth slot by itself", () => {
    expect(phoneBarFor("social", socialPins()).map((p) => p.key)).toEqual(["home", "search", "create", "tasks", "profile"]);
  });

  it("the top holds Notifications and Messages (SCP-1j built its page), in the skin's order", () => {
    expect(phoneTopFor("social", socialPins()).map((p) => p.key)).toEqual(["notifications", "messages"]);
  });

  it("the sheet's Menu section is every pinned link the bar and the top do not hold, in the menu's order", () => {
    expect(phoneMenuFor("social", socialPins()).map((p) => p.key)).toEqual(["calendar", "reports", "saved", "assistant"]);
  });

  it("an entry that arrives with its ticket (Dashboard, Settings) lands in the Menu section by itself", () => {
    const link = (key: string): ConcretePinned => ({ kind: "link", key, label: key, icon: "home", href: `/${key}`, row: key, tab: key, wholeRow: true });
    const pins = ["home", "tasks", "dashboard", "settings", "profile"].map(link);
    expect(phoneMenuFor("social", pins).map((p) => p.key)).toEqual(["dashboard", "settings"]);
    expect(phoneBarFor("social", pins).map((p) => p.key)).toEqual(["home", "tasks", "profile"]);
  });
});

// SCP-5d (BFF §63.17, §63.21; SCP-Q19, PERMISSION §53.4): the Dashboard pin and the registry's `dashboard` row show in the Social menu under `canLeadSocial` EXACTLY: to
// each of the four approvers (the Social Media lead seat, the GM's lead seat, the owner, the superadmin) and not to a company admin, a Web Dev head or an officer. The gate
// hides, it grants nothing: the page's read (`GET team`, `plan`) is what refuses.
describe("skins: the Dashboard shows to the four approvers only (SCP-5d)", () => {
  const tree: OrgTreeNode = node("root", "Agency", "company", [
    node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
    node("d-web", "Web Dev", "department"),
    node("d-gm", "GM", "department"),
  ]);
  const global = (role: string) => ({ role, scopeType: "global", scopeId: null as unknown as string });
  const personas: Array<[string, Me["roles"], boolean]> = [
    ["a Social Media lead seat", [member(), lead("d-soc")], true],
    ["a GM lead seat", [member(), lead("d-gm")], true],
    ["the owner", [member(), { role: "owner", scopeType: "company", scopeId: "co-a" }], true],
    ["the superadmin", [member(), global("platform_admin")], true],
    ["a company admin", [member(), { role: "company_admin", scopeType: "company", scopeId: "co-a" }], false],
    ["a Web Dev head", [member(), lead("d-web")], false],
    ["an officer", [member()], false],
  ];
  const social = (roles: Me["roles"]) => {
    const m = me(roles);
    return wsByKey(buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }), skins: { on: ["standard", "social"] } }), "social-media");
  };

  for (const [who, roles, sees] of personas) {
    it(`${sees ? "shows" : "hides"} the Dashboard row and its pin for ${who}`, () => {
      const ws = social(roles);
      const row = allRows(ws).find((r) => r.key === "dashboard");
      const pin = pinnedFor(ws.skin, allRows(ws))!.find((p) => p.key === "dashboard");
      if (sees) {
        expect(row?.tabs.map((t) => t.href)).toEqual(["/departments/d-soc/dashboard"]);
        expect(pin).toMatchObject({ kind: "link", label: "Dashboard", href: "/departments/d-soc/dashboard", row: "dashboard" });
      } else {
        expect(row).toBeUndefined();
        expect(pin).toBeUndefined();
      }
    });
  }

  it("the Standard menu lists the row under the same gate (it is a registry row, not a skin one)", () => {
    const std = (roles: Me["roles"]) => {
      const m = me(roles);
      const ws = wsByKey(buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) }), "social-media");
      return allRows(ws).some((r) => r.key === "dashboard");
    };
    expect(personas.map(([, roles]) => std(roles))).toEqual(personas.map(([, , sees]) => sees));
  });
});

describe("skins: the top row's tabs no pin opens (SCP-Kj, SCP-Q24)", () => {
  const soc = () => wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");

  it("Standard has none: its tab strip holds them", () => {
    const ws = soc();
    expect(unpinnedTopTabs("standard", ws.rows.top, [])).toBeNull();
  });

  it("the Social skin leaves the Overview row's Notices and Department calendar, as single-tab rows keyed row/tab", () => {
    const ws = soc();
    const rows = unpinnedTopTabs("social", ws.rows.top, pinnedFor("social", allRows(ws))!)!;
    expect(rows.map((r) => [r.key, r.label])).toEqual([["overview/notices", "Notices"], ["overview/schedule", "Department calendar"]]);
    expect(rows.map((r) => r.tabs.map((t) => t.href))).toEqual([["/departments/d-soc/notices"], ["/departments/d-soc/schedule"]]);
    expect(rows.every((r) => r.tabs.length === 1)).toBe(true);
  });

  it("a tab a pin names, or a row a pin stands for as a whole (the AI Assistant), is not repeated", () => {
    const ws = soc();
    const rows = unpinnedTopTabs("social", ws.rows.top, pinnedFor("social", allRows(ws))!)!;
    expect(rows.map((r) => r.key)).not.toContain("overview/overview");
    expect(rows.map((r) => r.key).filter((k) => k.startsWith("assistant"))).toEqual([]);
  });

  it("with no pins at all, every tab of the top rows is left", () => {
    const ws = soc();
    expect(unpinnedTopTabs("social", ws.rows.top, [])!.length).toBe(ws.rows.top.reduce((n, r) => n + r.tabs.length, 0));
  });
});
