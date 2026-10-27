import { describe, it, expect } from "vitest";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { areaFor } from "./areas";
import { gateAllows, resolveMyWorkspaces, workspaceUnitsOf, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, allRows } from "./shellModel";
import { lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

// SCP-1h (BFF §63.17): the Social Media workspace's `design-queue` row. No gate: the server narrows each row of the queue by the caller's two design
// facts, so a person with neither sees an honest empty list rather than a missing page, and a Creatives designer (who may hold no Social Media seat)
// can open it from the post links they are sent. The row key is unique in the workspace, and the page sits in one area, the department's own.

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-cre", "Creatives", "department", [person("p-cre-0", "u-2")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);

const ws = workspaceBySlug("social-media")!;
const row = ws.work.find((r) => r.key === "design-queue")!;
const ctxFor = (m: Me) => ({ me: m, tenantId: "co-a", unitPath: [], units: workspaceUnitsOf(resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree })) });

describe("the Social Media `design-queue` row", () => {
  it("is in the workspace with exactly the key `design-queue`, one tab at {dept}/design-queue, no gate and no ticket", () => {
    expect(row).toBeDefined();
    expect(row.gate).toBeUndefined();
    expect(row.ticket).toBeUndefined();
    expect(row.tabs).toHaveLength(1);
    expect(row.tabs[0]).toMatchObject({ key: "design-queue", href: "/departments/{dept}/design-queue" });
    expect(row.tabs[0].ticket).toBeUndefined();
  });

  it("is unique among the workspace's row keys, and in the sidebar", () => {
    const keys = ws.work.map((r) => r.key);
    expect(keys.filter((k) => k === "design-queue")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    const reg = sidebarRows(ws);
    const rowKeys = [...reg.top, ...reg.work, ...reg.performance, ...reg.you].map((r) => r.key);
    expect(rowKeys.filter((k) => k === "design-queue")).toHaveLength(1);
  });

  it("sits in the department's own area (one area, the workspace's)", () => {
    expect(areaFor("/departments/d-soc/design-queue")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });

  it("is shown to every member of the workspace, whatever they hold (the server narrows the rows)", () => {
    expect(gateAllows(row.gate, ctxFor(me([member()])))).toBe(true);
    expect(gateAllows(row.gate, ctxFor(me([member(), lead("d-cre")])))).toBe(true);
    expect(gateAllows(row.gate, ctxFor(me([member(), lead("d-soc")])))).toBe(true);
  });

  it("through the shell model: a Social Media member's rows hold it at {dept}/design-queue", () => {
    const m = me([member()]);
    const model = buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) });
    const social = model.workspaces.find((w) => w.key === "social-media")!;
    expect(allRows(social).find((r) => r.key === "design-queue")?.tabs[0].href).toBe("/departments/d-soc/design-queue");
  });
});
