import { describe, it, expect } from "vitest";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { SKINS } from "./skins";
import { areaFor } from "./areas";
import { gateAllows, resolveMyWorkspaces, workspaceUnitsOf, type OrgTreeNode } from "./workspaceAccess";
import { lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

// SCP-1j (BFF §63.17): the Social Media workspace's `messages` row. No gate: anyone offered the workspace opens it (a person who is nobody's officer reads an
// empty state), and its FIRST tab is `{dept}/messages`, because the Social skin's Messages pin opens the row's first tab.

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);
const ws = workspaceBySlug("social-media")!;
const row = ws.work.find((r) => r.key === "messages")!;
const ctxFor = (m: Me) => ({ me: m, tenantId: "co-a", unitPath: [], units: workspaceUnitsOf(resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree })) });

describe("the Social Media `messages` row", () => {
  it("is in the workspace with exactly the key `messages`, one ungated tab at {dept}/messages, and no ticket", () => {
    expect(row).toBeDefined();
    expect(row.gate).toBeUndefined();
    expect(row.ticket).toBeUndefined();
    expect(row.tabs).toHaveLength(1);
    expect(row.tabs[0]).toMatchObject({ key: "messages", href: "/departments/{dept}/messages" });
    expect(row.tabs[0].ticket).toBeUndefined();
  });

  it("is unique among the workspace's row keys", () => {
    const reg = sidebarRows(ws);
    const keys = [...reg.top, ...reg.work, ...reg.performance, ...reg.you].map((r) => r.key);
    expect(keys.filter((k) => k === "messages")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("is the page the Social skin's Messages pin opens: the pin names no ticket any more, and the row's first tab is the page", () => {
    expect(SKINS.social.pinned!.find((p) => p.key === "messages")).toEqual({ kind: "row", key: "messages", row: "messages", label: "Messages", icon: "messages" });
    expect(SKINS.social.phoneTop).toContain("messages");
    expect(row.tabs[0].href).toBe("/departments/{dept}/messages");
  });

  it("sits in the department's own area (one area, the workspace's)", () => {
    expect(areaFor("/departments/d-soc/messages")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });

  it("is shown to an officer and to a head alike (the gate hides nothing here)", () => {
    for (const who of [me([member()]), me([member(), lead("d-soc")])]) expect(gateAllows(row.gate, ctxFor(who))).toBe(true);
  });
});
