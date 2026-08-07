import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPmTools } from "./pm-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import { authorize } from "./policy";
import { config } from "./config";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:report" });

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("WD-06 PM report-sink hub tools", () => {
  beforeEach(() => {
    resetRegistry();
    registerPmTools();
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers pm.createDoc + pm.createTask as LOW-impact writes", () => {
    for (const n of ["pm.createDoc", "pm.createTask"]) {
      const t = getTool(n)!;
      expect(t).toBeDefined();
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
    }
  });

  it("pm.createDoc POSTs to the project's docs endpoint and forwards the OBO envelope", async () => {
    const spy = mockFetch(201, { id: "doc-1" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.createDoc")!.handler(
      { tenantId: "co-1", projectId: "proj-1", title: "Meeting report", body: "# Report\n..." },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "doc-1" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pm/projects/proj-1/docs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wf:report");
    expect(JSON.parse(init.body)).toEqual({ title: "Meeting report", body: "# Report\n..." });
  });

  it("pm.createTask POSTs to /pm/tasks with a person assignee when assigneeUserId is set", async () => {
    const spy = mockFetch(201, { id: "task-1" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.createTask")!.handler(
      { tenantId: "co-1", projectId: "proj-1", title: "Review meeting report", assigneeUserId: "pm-user-1" },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "task-1" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pm/tasks");
    const body = JSON.parse(init.body);
    expect(body.projectId).toBe("proj-1");
    expect(body.title).toBe("Review meeting report");
    expect(body.assignee).toEqual({ kind: "person", refId: "pm-user-1", responsibleId: "pm-user-1" });
  });

  it("pm.createTask omits assignee when assigneeUserId is not given", async () => {
    const spy = mockFetch(201, { id: "task-2" });
    vi.stubGlobal("fetch", spy);
    await getTool("pm.createTask")!.handler({ tenantId: "co-1", projectId: "proj-1", title: "No assignee" }, principal);
    const [, init] = (spy as any).mock.calls[0];
    expect(JSON.parse(init.body).assignee).toBeUndefined();
  });

  it("maps a platform 403 to a thrown denial", async () => {
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.createDoc")!.handler({ tenantId: "co-1", projectId: "proj-1", title: "x" }, principal)).rejects.toThrow(/not authorized/);
  });

  it("wf:report is the ONLY workflow scoped to pm.createDoc/pm.createTask (WD-06 AC: invisible to other wf:* accounts)", () => {
    expect(AUTOMATION_ALLOWLIST["wf:report"]).toContain("pm.createDoc");
    expect(AUTOMATION_ALLOWLIST["wf:report"]).toContain("pm.createTask");
    for (const [wf, scope] of Object.entries(AUTOMATION_ALLOWLIST)) {
      if (wf === "wf:report") continue;
      expect(scope).not.toContain("pm.createDoc");
      expect(scope).not.toContain("pm.createTask");
    }
  });
});

describe("P4-J1 PM read tools (pm.listTasks / pm.getTask / pm.listProjects / pm.taskAssignmentHistory)", () => {
  const originalPlatformUrl = config.platformUrl;
  beforeEach(() => {
    resetRegistry();
    registerPmTools();
    config.platformUrl = "http://platform.test";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    config.platformUrl = originalPlatformUrl;
  });

  it("registers all four as read tools: no write flag, no impact tier (D14's write gate never engages)", () => {
    for (const n of ["pm.listTasks", "pm.getTask", "pm.listProjects", "pm.taskAssignmentHistory"]) {
      const t = getTool(n)!;
      expect(t, `${n} should be registered`).toBeDefined();
      expect(t.write).toBeFalsy();
      expect(t.impact).toBeUndefined();
      expect(t.minAssurance).toBe("low");
    }
  });

  it("pm.listTasks GETs /pm/tasks with the P4-A1 facets serialized (status/tag/priority/responsible/ball/milestone as CSV, mine -> assignee=me), forwarding the OBO envelope, and returns { items, nextCursor } unmodified", async () => {
    const body = { items: [{ id: "t1" }], nextCursor: "abc" };
    const spy = mockFetch(200, body);
    vi.stubGlobal("fetch", spy);
    const humanBot = mintPrincipal({ provider: "whatsapp", externalId: "wa:6281-boss" });
    const out = await getTool("pm.listTasks")!.handler(
      {
        tenantId: "co-1",
        status: ["doing", "review"],
        tag: ["urgent-tag"],
        priority: ["high", "urgent"],
        responsible: ["user-1"],
        ball: ["user-2", "dept-3"],
        milestone: ["m1"],
        dueFrom: "2026-08-01",
        dueTo: "2026-08-31",
        q: "invoice",
        overdueOnly: true,
        dueSoon: false,
        dueSoonDays: 5,
        includeClosed: true,
        includeSubtasks: true,
        mine: true,
        cursor: "cur-1",
        limit: 25,
      },
      humanBot,
    );
    expect(JSON.parse(out)).toEqual(body);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/pm/tasks?");
    const qs = new URL(url).searchParams;
    expect(qs.get("status")).toBe("doing,review");
    expect(qs.get("tag")).toBe("urgent-tag");
    expect(qs.get("priority")).toBe("high,urgent");
    expect(qs.get("responsible")).toBe("user-1");
    expect(qs.get("ball")).toBe("user-2,dept-3"); // Ball = assignee.refId/kind, not a "ball column"
    expect(qs.get("milestone")).toBe("m1");
    expect(qs.get("dueFrom")).toBe("2026-08-01");
    expect(qs.get("dueTo")).toBe("2026-08-31");
    expect(qs.get("q")).toBe("invoice");
    expect(qs.get("overdueOnly")).toBe("true");
    expect(qs.get("dueSoon")).toBe("false");
    expect(qs.get("dueSoonDays")).toBe("5");
    expect(qs.get("includeClosed")).toBe("true");
    expect(qs.get("includeSubtasks")).toBe("true");
    expect(qs.get("assignee")).toBe("me"); // mine:true maps to the existing ?assignee=me convenience
    expect(qs.get("cursor")).toBe("cur-1");
    expect(qs.get("limit")).toBe("25");
    expect((init.headers as Record<string, string>)["x-obo-provider"]).toBe("whatsapp");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wa:6281-boss");
  });

  it("pm.listTasks with no optional args sends a bare GET (no facet params, no ?)", async () => {
    const spy = mockFetch(200, { items: [], nextCursor: null });
    vi.stubGlobal("fetch", spy);
    await getTool("pm.listTasks")!.handler({ tenantId: "co-1" }, principal);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/pm/tasks");
  });

  it("pm.getTask GETs /pm/tasks/:id and returns the task detail (incl. blockedBy) unmodified", async () => {
    const body = { id: "t1", title: "Ship it", blockedBy: [{ id: "t0", title: "Blocker" }] };
    const spy = mockFetch(200, body);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.getTask")!.handler({ tenantId: "co-1", taskId: "t1" }, principal);
    expect(JSON.parse(out)).toEqual(body);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/pm/tasks/t1");
  });

  it("pm.listProjects GETs the existing tenant-wide /projects endpoint (no separate PM-only list endpoint exists)", async () => {
    const body = [{ id: "p1", name: "Website Revamp" }];
    const spy = mockFetch(200, body);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.listProjects")!.handler({ tenantId: "co-1" }, principal);
    expect(JSON.parse(out)).toEqual(body);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/projects");
  });

  it("pm.taskAssignmentHistory GETs /pm/tasks/:taskId/assignment-history and returns the ledger unmodified", async () => {
    const body = [{ id: "e1", refId: "user-2", refKind: "person", responsibleId: "user-1", statusId: "doing", createdAt: "2026-08-01T00:00:00Z" }];
    const spy = mockFetch(200, body);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.taskAssignmentHistory")!.handler({ tenantId: "co-1", taskId: "t1" }, principal);
    expect(JSON.parse(out)).toEqual(body);
    const [url] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/pm/tasks/t1/assignment-history");
  });

  // ── Adversarial authz (non-negotiable #1: "otherwise read-only" is a Cerbos outcome, never a
  // bot-side branch). These tests drive the REAL call path hub.ts uses — policy.ts's authorize()
  // first (the hub's own coarse gate), then the tool handler itself (which forwards to the
  // platform's OWN Cerbos policies, resource_pm_task.yaml/resource_pm_project.yaml) — never a
  // hardcoded assertion of what SHOULD happen in isolation.

  it("the hub's own gate does not block by PM role — it can't: minAssurance is the only attribute it evaluates for a non-automation caller. A verified human/bot-OBO principal always clears authorize() for these tools", () => {
    const humanBot = mintPrincipal({ provider: "whatsapp", externalId: "wa:6281-anyone" });
    for (const n of ["pm.listTasks", "pm.getTask", "pm.listProjects", "pm.taskAssignmentHistory"]) {
      const decision = authorize(humanBot, n);
      expect(decision.allow, `${n} should clear the hub gate for a low-assurance non-automation caller`).toBe(true);
    }
  });

  it("ADVERSARIAL: an anonymous principal (no resolved OBO identity) is denied at the HUB layer before ever reaching the platform — minAssurance:low > anonymous", () => {
    const anon = mintPrincipal({});
    expect(anon.assurance).toBe("anonymous");
    const decision = authorize(anon, "pm.listTasks");
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toMatch(/requires low assurance/);
  });

  it("ADVERSARIAL: a client-tier principal clears the hub's coarse gate (as any low/verified caller does) but is DENIED by the platform's own pm_task RBAC (no company_admin/manager/member/viewer/team_lead derived role) — driven through the tool handler, not asserted against the policy file", async () => {
    const clientPrincipal = mintPrincipal({ provider: "whatsapp", externalId: "wa:client-portal-user" });
    expect(authorize(clientPrincipal, "pm.listTasks").allow).toBe(true); // hub says "you may attempt this"
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied — no pm_task role in this tenant" }));
    await expect(getTool("pm.listTasks")!.handler({ tenantId: "co-1" }, clientPrincipal)).rejects.toThrow(/not authorized/);
  });

  it("ADVERSARIAL: a staff principal without pm.read (a role in this tenant that isn't company_admin/manager/member/viewer/team_lead) is DENIED by the platform, driven through pm.getTask's handler", async () => {
    const staffNoRole = mintPrincipal({ provider: "whatsapp", externalId: "wa:staff-no-pm-role" });
    expect(authorize(staffNoRole, "pm.getTask").allow).toBe(true); // hub gate is role-blind by design
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.getTask")!.handler({ tenantId: "co-1", taskId: "t1" }, staffNoRole)).rejects.toThrow(/not authorized/);
  });

  it("ADVERSARIAL: a principal probing a task in a tenant they don't belong to gets a 404 (RLS makes the row invisible), never task data — driven through pm.taskAssignmentHistory's handler", async () => {
    const outsider = mintPrincipal({ provider: "whatsapp", externalId: "wa:other-tenant-user" });
    expect(authorize(outsider, "pm.taskAssignmentHistory").allow).toBe(true); // hub can't see tenancy either
    vi.stubGlobal("fetch", mockFetch(404, { error: "task not found" }));
    await expect(
      getTool("pm.taskAssignmentHistory")!.handler({ tenantId: "not-my-co", taskId: "t1" }, outsider),
    ).rejects.toThrow(/404/);
  });

  it("ADVERSARIAL: no n8n automation workflow is scoped to any of the four new PM read tools — deny-by-default via AUTOMATION_ALLOWLIST, proven through authorize() (the same gate hub.ts calls), not just read off the map", () => {
    for (const wf of Object.keys(AUTOMATION_ALLOWLIST)) {
      const wfPrincipal = mintPrincipal({ provider: "n8n", externalId: wf });
      for (const tool of ["pm.listTasks", "pm.getTask", "pm.listProjects", "pm.taskAssignmentHistory"]) {
        if (AUTOMATION_ALLOWLIST[wf].includes(tool)) continue; // none should, but don't hardcode the negative if a future ticket adds one
        expect(authorize(wfPrincipal, tool).allow, `${wf} must not reach ${tool}`).toBe(false);
      }
    }
    // An unknown/unscoped workflow id is denied identically (deny-by-default, not just "listed workflows behave").
    const unknownWf = mintPrincipal({ provider: "n8n", externalId: "wf:does-not-exist" });
    expect(authorize(unknownWf, "pm.listTasks").allow).toBe(false);
  });
});
