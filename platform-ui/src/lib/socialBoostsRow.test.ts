import { describe, it, expect } from "vitest";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { AREA_RULES, areaFor } from "./areas";
import { SKINS, pinnedFor } from "./skins";
import { gateAllows, resolveMyWorkspaces, workspaceUnitsOf, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, allRows } from "./shellModel";
import { lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

// SCP-4b (BFF §63.17): the Social Media workspace's `boosts` row, "Boosting". No gate: the whole team reads it and the server refuses a write to anyone who may not run a boost. The row
// key is unique in the workspace, the page sits in one area (the department's own, with its own AREA_RULES entry), and the Social skin does NOT pin it: it is reachable from the More
// panel, which lists the model's Work rows as they are.

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-cre", "Creatives", "department", [person("p-cre-0", "u-2")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);

const ws = workspaceBySlug("social-media")!;
const row = ws.work.find((r) => r.key === "boosts")!;
const ctxFor = (m: Me) => ({ me: m, tenantId: "co-a", unitPath: [], units: workspaceUnitsOf(resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree })) });

describe("the Social Media `boosts` row", () => {
  it("is in the workspace with exactly the key `boosts`, one tab at {dept}/boosts labelled Boosting, no gate and no ticket", () => {
    expect(row).toBeDefined();
    expect(row.label).toBe("Boosting");
    expect(row.gate).toBeUndefined();
    expect(row.ticket).toBeUndefined();
    expect(row.tabs).toHaveLength(1);
    expect(row.tabs[0]).toMatchObject({ key: "boosts", label: "Boosting", href: "/departments/{dept}/boosts" });
    expect(row.tabs[0].ticket).toBeUndefined();
  });

  it("is unique among the workspace's row keys, and in the sidebar", () => {
    const keys = ws.work.map((r) => r.key);
    expect(keys.filter((k) => k === "boosts")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    const reg = sidebarRows(ws);
    const rowKeys = [...reg.top, ...reg.work, ...reg.performance, ...reg.you].map((r) => r.key);
    expect(rowKeys.filter((k) => k === "boosts")).toHaveLength(1);
  });

  it("has its own AREA_RULES entry, and the page sits in the department's own area", () => {
    const rules = AREA_RULES.filter((r) => r.path === "/departments/[deptId]/boosts");
    expect(rules).toHaveLength(1);
    expect(rules[0].kind).toBe("workspace");
    expect(rules[0].subtree).toBeFalsy();
    expect(areaFor("/departments/d-soc/boosts")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });

  it("is shown to every member of the workspace, whatever they hold (the server refuses a write to a person who may not run a boost)", () => {
    expect(gateAllows(row.gate, ctxFor(me([member()])))).toBe(true);
    expect(gateAllows(row.gate, ctxFor(me([member(), lead("d-soc")])))).toBe(true);
  });

  it("through the shell model: a Social Media member's rows hold it at {dept}/boosts", () => {
    const m = me([member()]);
    const model = buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) });
    const social = model.workspaces.find((w) => w.key === "social-media")!;
    expect(allRows(social).find((r) => r.key === "boosts")?.tabs[0].href).toBe("/departments/d-soc/boosts");
  });

  it("is NOT pinned by the Social skin, so it is reachable from the More panel as an unpinned row", () => {
    expect(SKINS.social.pinned!.some((p) => p.kind === "row" && p.row === "boosts")).toBe(false);
    const m = me([member()]);
    const model = buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) });
    const social = model.workspaces.find((w) => w.key === "social-media")!;
    const rows = allRows(social);
    const pins = pinnedFor("social", rows)!;
    expect(pins.some((p) => p.kind === "link" && p.row === "boosts")).toBe(false);
    expect(rows.some((r) => r.key === "boosts")).toBe(true);
  });
});
