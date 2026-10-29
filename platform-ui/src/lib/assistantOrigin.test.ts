import { describe, it, expect } from "vitest";
import { originContext, originLabel, resolveAssistantOrigin } from "./assistantOrigin";
import { resolveMyWorkspaces } from "./workspaceAccess";
import { GENERIC_WORKSPACE, WORKSPACES, workspaceBySlug, workspaceFor } from "./workspaces";
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
    expect(o.departmentId).toBe("d-web");
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
    expect(o!.departmentId).toBeNull(); // no ref to take an id from
    // with the company's department list it takes the matching ref's id
    expect(resolveAssistantOrigin("/pipeline", refs)!.departmentId).toBe("d-web");
  });

  it("names a department with no bespoke workspace by its own name (the generic workspace carries it)", () => {
    const generic = workspaceFor("agency", "Brand Studio");
    const o = resolveAssistantOrigin("/departments/d-x", [{ deptId: "d-x", workspace: generic }])!;
    expect(o.department).toBe("Brand Studio");
    expect(o.departmentId).toBe("d-x");
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
      expect(o.departmentId).toBeNull();
      expect(o.page).toBeNull();
      expect(o.prompts).toBeNull();
      expect(originLabel(o)).toBeNull();
    }
  });

  it("shows no department for a department the person's company does not have", () => {
    expect(resolveAssistantOrigin("/departments/d-gone/board", refs)!.department).toBeNull();
    expect(resolveAssistantOrigin("/departments/d-gone/board", refs)!.departmentId).toBeNull();
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

// AIP-10 — what a message sent from this origin carries to the server.
describe("originContext", () => {
  it("is the department id and the page name", () => {
    expect(originContext(resolveAssistantOrigin("/departments/d-web/board", refs))).toEqual({ departmentId: "d-web", page: boardLabel });
  });
  it("is the department id alone when the page has no registry name", () => {
    expect(originContext({ departmentId: "d-web", page: null })).toEqual({ departmentId: "d-web" });
  });
  it("is null (the body is today's) with no origin, or an origin with no department", () => {
    expect(originContext(null)).toBeNull();
    expect(originContext(undefined)).toBeNull();
    expect(originContext(resolveAssistantOrigin("/projects/p-web-1", refs))).toBeNull();
    expect(originContext(resolveAssistantOrigin("/departments/d-gone/board", refs))).toBeNull(); // a department the company does not have
    expect(originContext(resolveAssistantOrigin("/pipeline", []))).toBeNull(); // a workspace page with no department list to take an id from
  });
  it("every page name the registry can produce is a label the server accepts (platform-nest `sanitizePage`)", () => {
    // Letters, digits, spaces and & · - / ' ( ) , (the comma for Finance's "Revenue, AR and cash"), 1 to 60 characters. A name
    // outside it would be dropped server-side, silently, so a NEW label outside the alphabet fails here until it is dealt with.
    const SERVER_LABEL = /^[A-Za-z0-9 &·\-/'(),]{1,60}$/;
    const labels = new Set<string>(["Overview"]);
    for (const ws of WORKSPACES) {
      for (const row of ws.work) for (const t of row.tabs) labels.add(t.label);
      for (const t of [...ws.reports, ...ws.analytics]) labels.add(t.label);
    }
    const bad = [...labels].filter((l) => !SERVER_LABEL.test(l));
    expect(bad).toEqual([]);
  });
});
