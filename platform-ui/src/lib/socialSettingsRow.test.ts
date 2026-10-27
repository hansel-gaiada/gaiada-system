import { describe, it, expect } from "vitest";
import { sidebarRows, workspaceBySlug } from "./workspaces";
import { SKINS } from "./skins";
import { areaFor } from "./areas";
import { gateAllows, resolveMyWorkspaces, workspaceUnitsOf, type OrgTreeNode } from "./workspaceAccess";
import { buildShellModel, allRows } from "./shellModel";
import { lead, me, member, node, person } from "./workspaceFixtures";
import type { Me } from "./platform";

// SCP-1c (BFF §63.17, PERMISSION §53.4): the Social Media workspace's `settings` row. Shown to the four Social approvers only (`canLeadSocial`):
// the Social Media head, the GM, the owner and platform_admin; never to a company admin, a manager, another unit's head or an officer. The
// gate hides the row; the page itself is readable by the team and the server decides everything.

const tree: OrgTreeNode = node("root", "Agency", "company", [
  node("d-soc", "Social Media", "department", [person("p-soc-0", "u-1")]),
  node("d-web", "Web Dev", "department"),
  node("d-gm", "GM", "department"),
]);

const ws = workspaceBySlug("social-media")!;
const settingsRow = ws.work.find((r) => r.key === "settings")!;

const ctxFor = (m: Me) => ({ me: m, tenantId: "co-a", unitPath: [], units: workspaceUnitsOf(resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree })) });
const global = (role: string) => ({ role, scopeType: "global", scopeId: null as unknown as string });
const company = (role: string) => ({ role, scopeType: "company", scopeId: "co-a" });

describe("the Social Media `settings` row", () => {
  it("is in the workspace with exactly the key `settings`, one tab at {dept}/settings, gated by leadSocial", () => {
    expect(settingsRow).toBeDefined();
    expect(settingsRow.gate).toEqual({ kind: "leadSocial" });
    expect(settingsRow.ticket).toBeUndefined();
    expect(settingsRow.tabs).toHaveLength(1);
    expect(settingsRow.tabs[0]).toMatchObject({ key: "settings", href: "/departments/{dept}/settings" });
    expect(settingsRow.tabs[0].ticket).toBeUndefined();
  });

  it("is unique among the workspace's row keys, and is not Admin's `settings` row (a separate list)", () => {
    const keys = [...ws.work.map((r) => r.key)];
    expect(keys.filter((k) => k === "settings")).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    const reg = sidebarRows(ws);
    const rowKeys = [...reg.top, ...reg.work, ...reg.performance, ...reg.you].map((r) => r.key);
    expect(rowKeys.filter((k) => k === "settings")).toHaveLength(1);
  });

  it("is the page the Social skin's Settings pin opens: the pin names no ticket any more", () => {
    const pin = SKINS.social.pinned!.find((p) => p.key === "settings");
    expect(pin).toEqual({ kind: "row", key: "settings", row: "settings", label: "Settings", icon: "settings" });
  });

  it("sits in the department's own area (one area, the workspace's)", () => {
    expect(areaFor("/departments/d-soc/settings")).toEqual({ kind: "workspace", deptId: "d-soc" });
  });
});

describe("who is shown the row: the four, and nobody else", () => {
  const shown = (m: Me) => gateAllows(settingsRow.gate, ctxFor(m));

  it("shows it to the Social Media head, the GM, the owner and platform_admin", () => {
    expect(shown(me([member(), lead("d-soc")]))).toBe(true);
    expect(shown(me([member(), lead("d-gm")]))).toBe(true);
    expect(shown(me([company("owner")]))).toBe(true);
    expect(shown(me([global("owner")]))).toBe(true);
    expect(shown(me([global("platform_admin")]))).toBe(true);
  });

  it("hides it from a company admin, a manager, a social_manager holder, another unit's head and an officer", () => {
    expect(shown(me([member(), company("company_admin")]))).toBe(false);
    expect(shown(me([member(), company("manager")]))).toBe(false);
    expect(shown(me([member(), company("social_manager")]))).toBe(false);
    expect(shown(me([member(), lead("d-web")]))).toBe(false);
    expect(shown(me([member()]))).toBe(false);
  });

  it("hides it from a head of another company's same-id unit, and from an owner of another company", () => {
    const other = { id: "co-b", name: "Other", type: null, vertical: "agency", rootCompanyId: "co-root" };
    const agency = { id: "co-a", name: "Agency", type: null, vertical: "agency", rootCompanyId: "co-root" };
    expect(shown(me([member(), lead("d-soc", ["co-b"])], [agency, other]))).toBe(false);
    expect(shown(me([{ role: "owner", scopeType: "company", scopeId: "co-b" }], [agency, other]))).toBe(false);
  });

  it("through the shell model: the head's rows hold Settings at {dept}/settings, an officer's do not", () => {
    const model = (m: Me) => buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root: tree }) });
    const social = (m: Me) => model(m).workspaces.find((w) => w.key === "social-media")!;
    const headRows = allRows(social(me([member(), lead("d-soc")])));
    expect(headRows.find((r) => r.key === "settings")?.tabs[0].href).toBe("/departments/d-soc/settings");
    expect(allRows(social(me([member()]))).some((r) => r.key === "settings")).toBe(false);
    expect(allRows(social(me([member(), company("company_admin")]))).some((r) => r.key === "settings")).toBe(false);
  });
});
