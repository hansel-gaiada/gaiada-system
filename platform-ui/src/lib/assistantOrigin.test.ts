import { describe, it, expect } from "vitest";
import { originLabel, resolveAssistantOrigin } from "./assistantOrigin";
import { resolveMyWorkspaces } from "./workspaceAccess";
import { GENERIC_WORKSPACE, workspaceBySlug, workspaceFor } from "./workspaces";
import { agencyTree, me, member } from "./workspaceFixtures";

// DW-2h — the department the assistant was opened from. The refs are the real `resolveMyWorkspaces(...).all`,
// the same list the server route hands in, so a `deptId` area gets its department the way production does.
const refs = resolveMyWorkspaces({ me: me([member()]), tenantId: "co-a", root: agencyTree() }).all;
const webDev = workspaceBySlug("web-dev")!;
const boardLabel = webDev.work.flatMap((r) => r.tabs).find((t) => t.key === "board")!.label;

describe("resolveAssistantOrigin", () => {
  it("names the department and the page for a /departments/[deptId] page", () => {
    const o = resolveAssistantOrigin("/departments/d-web/board", refs)!;
    expect(o.path).toBe("/departments/d-web/board");
    expect(o.department).toBe("Web Dev");
    expect(o.page).toBe(boardLabel);
    expect(originLabel(o)).toBe(`Web Dev · ${boardLabel}`);
    expect(o.prompts).toEqual(webDev.assistantPrompts);
  });

  it("reads a page below a tab as that tab, and the department root as the Overview", () => {
    expect(resolveAssistantOrigin("/departments/d-web/board/some-card", refs)!.page).toBe(boardLabel);
    expect(resolveAssistantOrigin("/departments/d-web", refs)!.page).toBe("Overview");
  });

  it("uses the workspace's label for a slug area, with no department id needed", () => {
    const o = resolveAssistantOrigin("/pipeline", []);
    expect(o!.department).toBe("Web Dev");
    expect(o!.page).toBe("Pipeline");
    expect(o!.prompts).toEqual(webDev.assistantPrompts);
  });

  it("names a department with no bespoke workspace by its own name (the generic workspace carries it)", () => {
    const generic = workspaceFor("agency", "Brand Studio");
    const o = resolveAssistantOrigin("/departments/d-x", [{ deptId: "d-x", workspace: generic }])!;
    expect(o.department).toBe("Brand Studio");
    expect(o.prompts).toEqual(GENERIC_WORKSPACE.assistantPrompts);
  });

  it("names the department that owns a route outside /departments", () => {
    // The registry's ownedRoutes: the company report belongs to the Office of the GM.
    expect(resolveAssistantOrigin("/reports/company", refs)!.department).toBe(workspaceBySlug("gm")!.label);
  });

  it("keeps the way back but shows no department for a page that belongs to none", () => {
    for (const path of ["/projects/p-web-1", "/tasks/t-4", "/"]) {
      const o = resolveAssistantOrigin(path, refs)!;
      expect(o.path).toBe(path);
      expect(o.department).toBeNull();
      expect(o.page).toBeNull();
      expect(o.prompts).toBeNull();
      expect(originLabel(o)).toBeNull();
    }
  });

  it("shows no department for a department the person's company does not have", () => {
    expect(resolveAssistantOrigin("/departments/d-gone/board", refs)!.department).toBeNull();
  });

  it("is null without an origin, and for a path it will not send anyone back to", () => {
    expect(resolveAssistantOrigin(undefined, refs)).toBeNull();
    expect(resolveAssistantOrigin("", refs)).toBeNull();
    expect(resolveAssistantOrigin("https://evil.example/", refs)).toBeNull();
    expect(resolveAssistantOrigin("/assistant", refs)).toBeNull();
  });
});

describe("originLabel", () => {
  it("is the department alone when the page has no registry name", () => {
    expect(originLabel({ department: "SEO", page: null })).toBe("SEO");
  });
});
