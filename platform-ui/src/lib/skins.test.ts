import { describe, it, expect } from "vitest";
import { SKINS, SKINS_ON, effectiveSkin, pinnedFor, skinsOn, type PinnedItem } from "./skins";
import { WORKSPACES, GENERIC_WORKSPACE, sidebarRows, workspaceBySlug } from "./workspaces";
import { buildShellModel, allRows, type ShellModel } from "./shellModel";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import { agencyTree, lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

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
  it("draws only Standard for everyone until Kg switches Social on", () => {
    expect(SKINS_ON).toEqual(["standard"]);
    expect(skinsOn(undefined)).toEqual(["standard"]);
  });

  it("adds the preview's skins on a dev or test box, and ignores keys it does not know", () => {
    expect(skinsOn("social")).toEqual(["standard", "social"]);
    expect(skinsOn(" social , nope,,standard")).toEqual(["standard", "social"]);
    expect(skinsOn("")).toEqual(["standard"]);
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
      if (p.kind !== "row") continue;
      const row = rows.find((r) => r.key === p.row);
      expect(row, `${p.key} -> ${p.row}`).toBeDefined();
      if (p.tab) expect(row!.tabs.some((t) => t.key === p.tab), `${p.key} -> ${p.row}/${p.tab}`).toBe(true);
    }
    expect(new Set(SKINS.social.pinned!.map((p) => p.key)).size).toBe(SKINS.social.pinned!.length);
  });

  it("resolves only to pages the person's model offers, in order, and never a planned one", () => {
    const soc = wsByKey(model(me([member()]), socialTree, { on: ["standard", "social"] }), "social-media");
    const pinned = pinnedFor(soc.skin, allRows(soc))!;
    expect(pinned.map((p) => p.key)).toEqual(["home", "search", "notifications", "tasks", "create", "calendar", "reports", "assistant"]);
    const offered = new Set(allRows(soc).flatMap((r) => r.tabs.map((t) => t.href)));
    for (const p of pinned) if (p.kind === "link") expect(offered.has(p.href), p.key).toBe(true);
    expect(pinned.find((p) => p.key === "home")).toMatchObject({ kind: "link", label: "Home", href: "/departments/d-soc" });
  });

  it("shows the Dashboard to the unit's head by the Team view's own gate, not by the skin", () => {
    const head = wsByKey(model(me([member(), lead("d-soc")]), socialTree, { on: ["standard", "social"] }), "social-media");
    const dash = pinnedFor(head.skin, allRows(head))!.find((p) => p.key === "dashboard");
    expect(dash).toMatchObject({ kind: "link", label: "Dashboard" });
    expect(dash && dash.kind === "link" ? dash.href : "").toMatch(/^\/reports\/team\?unit=d-soc/);
  });

  it("carries a row's count on the entry that opens the row's first tab", () => {
    const rows = [{ key: "assistant", label: "AI Assistant", icon: "assistant" as const, count: 3, tabs: [{ key: "assistant", label: "AI Assistant", href: "/assistant", icon: "assistant" as const }] }];
    expect(pinnedFor("social", rows)!.find((p) => p.key === "assistant")).toMatchObject({ count: 3 });
  });
});

describe("skins: the shell model", () => {
  it("draws every workspace Standard when no skin is on, Social Media included", () => {
    for (const mod of [model(me([member()]), socialTree), model(me([member()]), socialTree, { on: skinsOn(undefined) })]) {
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
    const strip = (mod: ShellModel) => ({ ...mod, workspaces: mod.workspaces.map(({ skin: _s, ...w }) => w) });
    expect(strip(on)).toEqual(strip(off));
  });

  it("leaves a company with no Social Media department exactly as it was", () => {
    const m = me([member()]);
    expect(model(m, agencyTree({ web: ["u-1"] }), { on: ["standard", "social"] })).toEqual(model(m, agencyTree({ web: ["u-1"] })));
  });
});
