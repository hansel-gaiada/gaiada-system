import { describe, it, expect } from "vitest";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { SKINS } from "./skins";
import { areaFor } from "./areas";
import { resolveMyWorkspaces, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, allRows } from "./shellModel";
import { lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

// SCP-1a (BFF §63.17): the Social Media workspace's `allocation` row. A list the whole team reads, so the row has no gate; the server decides who edits
// (`social_engagement` · `plan`, the four approvers) and the page shows everyone else the same list with disabled controls and the reason.

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);

const ws = workspaceBySlug("social-media")!;
const row = ws.work.find((r) => r.key === "allocation")!;
const company = (role: string) => ({ role, scopeType: "company", scopeId: "co-a" });

describe("the Social Media `allocation` row", () => {
  it("is in the workspace with exactly the key `allocation`, one tab at {dept}/allocation, and no gate or ticket", () => {
    expect(row).toBeDefined();
    expect(row.gate).toBeUndefined();
    expect(row.ticket).toBeUndefined();
    expect(row.tabs).toHaveLength(1);
    expect(row.tabs[0]).toMatchObject({ key: "allocation", href: "/departments/{dept}/allocation" });
    expect(row.tabs[0].ticket).toBeUndefined();
  });

  it("is unique among the workspace's row keys", () => {
    const keys = ws.work.map((r) => r.key);
    expect(keys.filter((k) => k === "allocation")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    const reg = sidebarRows(ws);
    const rowKeys = [...reg.top, ...reg.work, ...reg.performance, ...reg.you].map((r) => r.key);
    expect(rowKeys.filter((k) => k === "allocation")).toHaveLength(1);
  });

  it("sits in the department's own area (one area, the workspace's)", () => {
    expect(areaFor("/departments/d-soc/allocation")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });

  it("is not pinned by the Social skin (it lives in More), so no pin names a ticket for it", () => {
    expect(SKINS.social.pinned!.some((p) => p.kind === "row" && p.row === "allocation")).toBe(false);
  });

  it("through the shell model every team member's rows hold Allocation at {dept}/allocation, whatever their role", () => {
    const model = (m: Me) => buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) });
    const social = (m: Me) => model(m).workspaces.find((w) => w.key === "social-media")!;
    for (const m of [me([member()]), me([member(), lead("d-soc")]), me([member(), company("company_admin")]), me([member(), company("social_manager")])]) {
      expect(allRows(social(m)).find((r) => r.key === "allocation")?.tabs[0].href).toBe("/departments/d-soc/allocation");
    }
  });
});
