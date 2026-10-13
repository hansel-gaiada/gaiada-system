import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Me } from "./platform";
import { WORKSPACES, isPlanned, workspaceBySlug, type Gate } from "./workspaces";
import {
  departmentForWorkspace, gateAllows, resolveMyWorkspaces, workspaceKeysOf, type OrgTreeNode,
} from "./workspaceAccess";
import { buildShellModel, allRows, type ShellModel } from "./shellModel";
import { selectQuickActions, subjectOfRef } from "./overview";
import { areaFor } from "./areas";
import { AGENCY, HOTEL, me, member, node, person } from "./workspaceFixtures";

// DW-5c UI / DW-5f / DW-5h: the Sent tab in every agency workspace, "Ask ..." only where the company HAS the receiving
// department (the `hasWorkspace` gate), and the area of the new pages.

/** An agency with every department the Ask links and the Sent tabs concern. */
function fullTree(placements: { web?: string[]; seo?: string[] } = {}): OrgTreeNode {
  return node("root", "Agency", "company", [
    node("d-web", "Web Dev", "department", (placements.web ?? []).map((u, i) => person(`p-w-${i}`, u))),
    node("d-seo", "SEO", "department", (placements.seo ?? []).map((u, i) => person(`p-s-${i}`, u))),
    node("d-soc", "Social Media", "department"),
    node("d-cre", "Creatives", "department"),
    node("d-gm", "GM", "department"),
  ]);
}
const noCreatives = (): OrgTreeNode => node("root", "Agency", "company", [node("d-web", "Web Dev", "department", [person("p", "u-1")]), node("d-seo", "SEO", "department")]);

const employee = me([member()]);
const ctx = (m: Me, tenantId: string, workspaces?: readonly string[]) => ({ me: m, tenantId, unitPath: [] as string[], workspaces });

describe("the hasWorkspace gate (DW-5f)", () => {
  const gate: Gate = { kind: "hasWorkspace", workspace: "creatives" };

  it("allows exactly when the company has a department for that workspace", () => {
    expect(gateAllows(gate, ctx(employee, "co-a", ["web-dev", "creatives"]))).toBe(true);
    expect(gateAllows(gate, ctx(employee, "co-a", ["web-dev", "seo"]))).toBe(false);
    expect(gateAllows(gate, ctx(employee, "co-a", []))).toBe(false);
  });

  it("hides when the caller does not know which departments exist, rather than offering a link that may lead nowhere", () => {
    expect(gateAllows(gate, ctx(employee, "co-a"))).toBe(false);
  });

  it("composes with the pack gate through `all`", () => {
    const both: Gate = { kind: "all", gates: [{ kind: "pack", pack: "agency" }, gate] };
    expect(gateAllows(both, ctx(employee, "co-a", ["creatives"]))).toBe(true);
    expect(gateAllows(both, ctx(me([member("co-h")], [HOTEL]), "co-h", ["creatives"]))).toBe(false);
  });
});

describe("which departments a company has", () => {
  it("lists the workspace keys of the departments in the org tree, not the functional ones the tree lacks", () => {
    const ws = resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: fullTree() });
    expect(workspaceKeysOf(ws).sort()).toEqual(["creatives", "gm", "seo", "social-media", "web-dev"]);
    // HR, IT and Finance are listed in the switcher without an org node, and are nobody to send a request to.
    expect(ws.all.some((r) => r.workspace.key === "hr" && r.deptId === null)).toBe(true);
    expect(workspaceKeysOf(ws)).not.toContain("hr");
  });

  it("finds the receiving department by the shell's own name match", () => {
    expect(departmentForWorkspace(fullTree(), "agency", "creatives")).toEqual({ id: "d-cre", name: "Creatives" });
    expect(departmentForWorkspace(fullTree(), "agency", "web-dev")).toEqual({ id: "d-web", name: "Web Dev" });
    // The name match is slug-based, so it survives spelling and case.
    const spelled = node("root", "A", "company", [node("d-x", "  creatives ", "department")]);
    expect(departmentForWorkspace(spelled, "agency", "creatives")?.id).toBe("d-x");
  });

  it("finds nothing where there is no such department, in a tree that is not read, or in another vertical", () => {
    expect(departmentForWorkspace(noCreatives(), "agency", "creatives")).toBeNull();
    expect(departmentForWorkspace(null, "agency", "creatives")).toBeNull();
    // A hotel's "Creatives" department is the generic workspace: the bespoke one is the agency pack's (PV-D15).
    expect(departmentForWorkspace(fullTree(), "hospitality", "creatives")).toBeNull();
  });

  it("ignores a division or a person that happens to carry the name", () => {
    const tree = node("root", "A", "company", [node("d-web", "Web Dev", "department", [node("dv", "Creatives", "division")])]);
    expect(departmentForWorkspace(tree, "agency", "creatives")).toBeNull();
  });
});

describe("the Ask actions", () => {
  const social = WORKSPACES.find((w) => w.key === "social-media")!;
  const seo = WORKSPACES.find((w) => w.key === "seo")!;
  const web = WORKSPACES.find((w) => w.key === "web-dev")!;
  const creatives = WORKSPACES.find((w) => w.key === "creatives")!;
  const q = (ws: (typeof WORKSPACES)[number], workspaces?: readonly string[], m: Me = employee, tenant = "co-a") =>
    selectQuickActions(ws.quickActions, { ...ctx(m, tenant, workspaces), deptId: "d-1" }).map((a) => a.key);

  it("are built: neither carries a ticket any more", () => {
    for (const ws of WORKSPACES) {
      for (const a of ws.quickActions.filter((x) => x.key.startsWith("ask-"))) expect(isPlanned(a), `${ws.key}/${a.key}`).toBe(false);
    }
  });

  it("show only where the company has the receiving department", () => {
    expect(q(social, ["social-media", "creatives", "web-dev"])).toEqual(["compose-post", "ask-creatives", "ask-web-dev"]);
    expect(q(social, ["social-media", "web-dev"])).toEqual(["compose-post", "ask-web-dev"]);
    expect(q(social, ["social-media", "creatives"])).toEqual(["compose-post", "ask-creatives"]);
    expect(q(social, ["social-media"])).toEqual(["compose-post"]);
    expect(q(social)).toEqual(["compose-post"]);
  });

  it("link to the form for the right target", () => {
    const actions = selectQuickActions(social.quickActions, { ...ctx(employee, "co-a", ["creatives", "web-dev"]), deptId: "d-soc" });
    expect(actions.map((a) => a.href)).toEqual(["/departments/d-soc/composer", "/requests/new?to=creatives", "/requests/new?to=web-dev"]);
  });

  it("never offer Web Dev to ask itself, nor Creatives to ask itself", () => {
    expect(q(web, ["web-dev", "creatives"])).toContain("ask-creatives");
    expect(q(web, ["web-dev", "creatives"])).not.toContain("ask-web-dev");
    expect(q(creatives, ["web-dev", "creatives"])).toContain("ask-web-dev");
    expect(q(creatives, ["web-dev", "creatives"])).not.toContain("ask-creatives");
  });

  it("stay within the header's three, SEO's own two first", () => {
    expect(q(seo, ["seo", "creatives", "web-dev"])).toEqual(["run-site-audit", "new-content-brief", "ask-creatives"]);
  });

  it("are the agency pack's only", () => {
    const hotel = me([member("co-h")], [HOTEL]);
    expect(q(social, ["social-media", "creatives", "web-dev"], hotel, "co-h")).toEqual(["compose-post"]);
  });

  it("reach the Overview through the workspaces the page read", () => {
    const ws = resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: fullTree({ seo: ["u-1"] }) });
    const subject = subjectOfRef(ws.mine[0], ws);
    expect([...(subject.workspaces ?? [])].sort()).toEqual(["creatives", "gm", "seo", "social-media", "web-dev"]);
    const without = resolveMyWorkspaces({ me: employee, tenantId: "co-a", root: noCreatives() });
    expect(subjectOfRef(without.mine[0], without).workspaces).not.toContain("creatives");
    // A caller that does not pass the workspaces gets no Ask action, never a wrong one.
    expect(subjectOfRef(ws.mine[0]).workspaces).toBeUndefined();
  });
});

describe("Requests › Sent in the shell (DW-5h)", () => {
  const model = (m: Me, root: OrgTreeNode): ShellModel => buildShellModel({ me: m, tenantId: "co-a", workspaces: resolveMyWorkspaces({ me: m, tenantId: "co-a", root }) });
  const mod = model(employee, fullTree({ web: ["u-1"] }));
  const ws = (id: string) => mod.workspaces.find((w) => w.id === id)!;
  const requests = (id: string) => allRows(ws(id)).find((r) => r.key === "requests");

  it("gives SEO, Social Media and the Office of the GM a Requests row with one tab, Sent", () => {
    for (const [id, dept] of [["d-seo", "d-seo"], ["d-soc", "d-soc"], ["d-gm", "d-gm"]] as const) {
      const row = requests(id);
      expect(row?.tabs, id).toEqual([{ key: "sent", label: "Sent", href: `/departments/${dept}/requests/sent`, icon: "bell" }]);
    }
  });

  it("keeps Web Dev's Incoming (today's MI-05 page) and adds Sent beside it", () => {
    expect(requests("d-web")?.tabs.map((t) => [t.key, t.href])).toEqual([
      ["incoming", "/departments/d-web/requests"],
      ["sent", "/departments/d-web/requests/sent"],
    ]);
  });

  it("gives Creatives a Requests row of Incoming, Delivered and Sent (DW-5d built)", () => {
    expect(requests("d-cre")?.tabs.map((t) => [t.key, t.href])).toEqual([
      ["incoming", "/departments/d-cre/requests"],
      ["delivered", "/departments/d-cre/requests/delivered"],
      ["sent", "/departments/d-cre/requests/sent"],
    ]);
    const reg = workspaceBySlug("creatives")!;
    const row = reg.work.find((r) => r.key === "requests")!;
    expect(isPlanned(row)).toBe(false);
    expect(row.tabs.filter(isPlanned)).toEqual([]);
  });

  it("gives HR, Finance and IT no Requests row: they are not agency craft departments", () => {
    for (const id of ["slug:hr", "slug:finance", "slug:it"]) expect(requests(id), id).toBeUndefined();
  });

  it("is the agency pack's: a hotel's departments do not get it", () => {
    const hotelTree = node("root", "Hotel", "company", [node("d-seo", "SEO", "department", [person("p", "u-1")])]);
    const hotelMe = me([member("co-h")], [HOTEL]);
    const hotel = buildShellModel({ me: hotelMe, tenantId: "co-h", workspaces: resolveMyWorkspaces({ me: hotelMe, tenantId: "co-h", root: hotelTree }) });
    for (const w of hotel.workspaces) expect(allRows(w).find((r) => r.key === "requests"), w.id).toBeUndefined();
    expect(AGENCY.vertical).toBe("agency");
  });

  it("points every built Sent tab at a page that exists and is the department's own", () => {
    const page = resolve(__dirname, "../app/(app)/departments/[deptId]/requests/sent/page.tsx");
    expect(existsSync(page)).toBe(true);
    for (const w of WORKSPACES) {
      for (const row of w.work.filter((r) => r.key === "requests")) {
        for (const t of row.tabs.filter((x) => x.key === "sent")) {
          expect(isPlanned(t), `${w.key}`).toBe(false);
          expect(t.href).toBe("/departments/{dept}/requests/sent");
        }
      }
    }
    expect(areaFor("/departments/d-seo/requests/sent")).toMatchObject({ kind: "workspace", deptId: "d-seo" });
  });
});

describe("the areas of the request pages (plan §2.3)", () => {
  it("keeps the area you came from on every /requests page", () => {
    for (const path of ["/requests", "/requests/new", "/requests/new?to=creatives", "/requests/3f2a7c1e-0000-4000-8000-000000000001"]) {
      expect(areaFor(path).kind, path).toBe("shared");
    }
  });
});
