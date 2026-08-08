import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPmTools } from "./pm-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal, type Principal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";
import { authorize } from "./policy";
import { config } from "./config";

const principal = mintPrincipal({ provider: "n8n", externalId: "wf:report" });

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

/** Sequential responses for handlers that make more than one fetch call (pm.passBall: GET then
 *  PATCH). The last entry repeats if more calls happen than responses provided. */
function mockFetchSeq(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
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

describe("P4-J2 PM write tools (pm.setStatus / pm.passBall / pm.setDueDate / pm.comment)", () => {
  const originalPlatformUrl = config.platformUrl;
  beforeEach(() => {
    resetRegistry();
    registerPmTools();
    config.platformUrl = "http://platform.test";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals(); // undo every vi.stubGlobal("fetch", ...) in this block — restoreAllMocks alone does NOT, and the LIVE Cerbos block right after this one needs the REAL fetch
    config.platformUrl = originalPlatformUrl;
  });

  it("registers all four as write:true, impact:\"low\" (decision 16) — never suspends, no approval-executables entry implied", () => {
    for (const n of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
      const t = getTool(n)!;
      expect(t, `${n} should be registered`).toBeDefined();
      expect(t.write).toBe(true);
      expect(t.impact).toBe("low");
      expect(t.minAssurance).toBe("low");
    }
  });

  it("pm.setStatus PATCHes {status} and forwards the OBO envelope", async () => {
    const spy = mockFetch(200, { ok: true, spawned: null });
    vi.stubGlobal("fetch", spy);
    const humanBot = mintPrincipal({ provider: "whatsapp", externalId: "wa:6281-boss" });
    const out = await getTool("pm.setStatus")!.handler({ tenantId: "co-1", taskId: "t1", status: "doing" }, humanBot);
    expect(JSON.parse(out)).toEqual({ ok: true, spawned: null });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/pm/tasks/t1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ status: "doing" });
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("wa:6281-boss");
  });

  it("pm.setStatus includes blockReason only when supplied (the backend ignores it unless the target status isBlocked with no open deps)", async () => {
    const spy = mockFetch(200, { ok: true, spawned: null });
    vi.stubGlobal("fetch", spy);
    await getTool("pm.setStatus")!.handler({ tenantId: "co-1", taskId: "t1", status: "blocked", blockReason: "waiting on the client" }, principal);
    expect(JSON.parse((spy as any).mock.calls[0][1].body)).toEqual({ status: "blocked", blockReason: "waiting on the client" });
  });

  it("ADVERSARIAL/D14-relevant: pm.setStatus surfaces a chain-blocked 409's EXACT message naming the blocker, never a bare status code — an agent must see WHICH task blocks it, not retry blindly forever", async () => {
    const msg = 'cannot move to "doing": blocked by 1 open dependency (Design mockup)';
    vi.stubGlobal("fetch", mockFetch(409, { error: msg }));
    await expect(
      getTool("pm.setStatus")!.handler({ tenantId: "co-1", taskId: "t1", status: "doing" }, principal),
    ).rejects.toThrow(msg);
  });

  it("pm.setDueDate PATCHes {dueDate} with a YYYY-MM-DD string", async () => {
    const spy = mockFetch(200, { ok: true, spawned: null });
    vi.stubGlobal("fetch", spy);
    await getTool("pm.setDueDate")!.handler({ tenantId: "co-1", taskId: "t1", dueDate: "2026-09-01" }, principal);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/pm/tasks/t1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ dueDate: "2026-09-01" });
  });

  it("pm.setDueDate with dueDate:null clears it (never touches startDate/status/assignee)", async () => {
    const spy = mockFetch(200, { ok: true, spawned: null });
    vi.stubGlobal("fetch", spy);
    await getTool("pm.setDueDate")!.handler({ tenantId: "co-1", taskId: "t1", dueDate: null }, principal);
    expect(JSON.parse((spy as any).mock.calls[0][1].body)).toEqual({ dueDate: null });
  });

  it("pm.passBall reads the CURRENT assignee first (GET) and preserves Responsible unchanged in the PATCH — mirrors platform-ui's own reassignBall()", async () => {
    const spy = mockFetchSeq([
      { status: 200, body: { id: "t1", assignee: { kind: "person", refId: "alice", refName: "Alice", responsibleId: "carol", responsibleName: "Carol" } } },
      { status: 200, body: { ok: true, spawned: null } },
    ]);
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.passBall")!.handler({ tenantId: "co-1", taskId: "t1", refId: "bob", refName: "Bob" }, principal);
    expect(JSON.parse(out)).toEqual({ ok: true, spawned: null });
    expect((spy as any).mock.calls).toHaveLength(2); // proves BOTH legs actually ran, not a short-circuit
    const [getUrl] = (spy as any).mock.calls[0];
    expect(getUrl).toBe("http://platform.test/api/co-1/pm/tasks/t1");
    const [patchUrl, patchInit] = (spy as any).mock.calls[1];
    expect(patchUrl).toBe("http://platform.test/api/co-1/pm/tasks/t1");
    expect(patchInit.method).toBe("PATCH");
    // The Ball (kind/refId/refName) moved to bob; Responsible (carol) is untouched — the two axes
    // are independent, exactly what makes Repsona's Responsible and Ball boards show different tasks.
    expect(JSON.parse(patchInit.body)).toEqual({
      assignee: { kind: "person", refId: "bob", refName: "Bob", responsibleId: "carol", responsibleName: "Carol" },
    });
  });

  it("pm.passBall bootstraps BOTH Ball and Responsible onto the new holder when the task has no prior assignee", async () => {
    const spy = mockFetchSeq([
      { status: 200, body: { id: "t2", assignee: null } },
      { status: 200, body: { ok: true, spawned: null } },
    ]);
    vi.stubGlobal("fetch", spy);
    await getTool("pm.passBall")!.handler({ tenantId: "co-1", taskId: "t2", refId: "dave" }, principal);
    const [, patchInit] = (spy as any).mock.calls[1];
    expect(JSON.parse(patchInit.body)).toEqual({
      assignee: { kind: "person", refId: "dave", refName: "dave", responsibleId: "dave", responsibleName: "dave" },
    });
  });

  it("pm.passBall forwards an optional assignmentNote (the ledger row's human-given reason)", async () => {
    const spy = mockFetchSeq([
      { status: 200, body: { id: "t1", assignee: null } },
      { status: 200, body: { ok: true, spawned: null } },
    ]);
    vi.stubGlobal("fetch", spy);
    await getTool("pm.passBall")!.handler({ tenantId: "co-1", taskId: "t1", refId: "bob", assignmentNote: "handing off to Bob" }, principal);
    const [, patchInit] = (spy as any).mock.calls[1];
    expect(JSON.parse(patchInit.body).assignmentNote).toBe("handing off to Bob");
  });

  it("pm.comment POSTs to /comments with entityType 'task' and forwards mentions/parentCommentId", async () => {
    const spy = mockFetch(201, { id: "cm-1" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("pm.comment")!.handler(
      { tenantId: "co-1", taskId: "t1", body: "looks good", mentions: ["u1", "u2"], parentCommentId: "cm-0" },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "cm-1" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toBe("http://platform.test/api/co-1/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ entityType: "task", entityId: "t1", body: "looks good", parentCommentId: "cm-0", mentions: ["u1", "u2"] });
  });

  // ── Adversarial authz (non-negotiable #1: never a bot/hub-side branch — same discipline as P4-J1) ──

  it("the hub's own gate does not block by PM role for any of the four write tools — a verified human/bot-OBO principal always clears authorize()", () => {
    const humanBot = mintPrincipal({ provider: "whatsapp", externalId: "wa:6281-anyone" });
    for (const n of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
      expect(authorize(humanBot, n).allow, n).toBe(true);
    }
  });

  it("ADVERSARIAL: an anonymous principal is denied at the HUB layer before ever reaching the platform, for all four write tools", () => {
    const anon = mintPrincipal({});
    expect(anon.assurance).toBe("anonymous");
    for (const n of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
      const d = authorize(anon, n);
      expect(d.allow, n).toBe(false);
      if (!d.allow) expect(d.reason).toMatch(/requires low assurance/);
    }
  });

  it("ADVERSARIAL: a client-tier principal clears the hub's coarse gate but is DENIED by the platform's own RBAC on every write tool — driven through each handler, not asserted against the policy file", async () => {
    const clientPrincipal = mintPrincipal({ provider: "whatsapp", externalId: "wa:client-portal-user" });
    for (const n of ["pm.setStatus", "pm.setDueDate", "pm.comment", "pm.passBall"]) {
      expect(authorize(clientPrincipal, n).allow, n).toBe(true); // hub says "you may attempt this"
    }
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied — no pm_task role in this tenant" }));
    await expect(getTool("pm.setStatus")!.handler({ tenantId: "co-1", taskId: "t1", status: "doing" }, clientPrincipal)).rejects.toThrow(/not authorized/);
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.setDueDate")!.handler({ tenantId: "co-1", taskId: "t1", dueDate: "2026-09-01" }, clientPrincipal)).rejects.toThrow(/not authorized/);
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.comment")!.handler({ tenantId: "co-1", taskId: "t1", body: "hi" }, clientPrincipal)).rejects.toThrow(/not authorized/);
    // pm.passBall is denied on its READ leg already — same platform gate, same handler, no special-casing.
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.passBall")!.handler({ tenantId: "co-1", taskId: "t1", refId: "bob" }, clientPrincipal)).rejects.toThrow(/not authorized/);
  });

  it("ADVERSARIAL: a staff principal without ANY pm_task role in this tenant is DENIED on setStatus/setDueDate/comment, driven through each handler", async () => {
    const staffNoRole = mintPrincipal({ provider: "whatsapp", externalId: "wa:staff-no-pm-role" });
    for (const n of ["pm.setStatus", "pm.setDueDate", "pm.comment"]) {
      expect(authorize(staffNoRole, n).allow, n).toBe(true); // hub gate is role-blind by design
    }
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.setStatus")!.handler({ tenantId: "co-1", taskId: "t1", status: "doing" }, staffNoRole)).rejects.toThrow(/not authorized/);
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.setDueDate")!.handler({ tenantId: "co-1", taskId: "t1", dueDate: "2026-09-01" }, staffNoRole)).rejects.toThrow(/not authorized/);
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(getTool("pm.comment")!.handler({ tenantId: "co-1", taskId: "t1", body: "hi" }, staffNoRole)).rejects.toThrow(/not authorized/);
  });

  it("ADVERSARIAL: a plain-member-tier staff principal can update status/due-date/comment but is DENIED passing the Ball — 'manage' requires company_admin/manager/team_lead, driven through pm.passBall's real GET-then-PATCH handler (proves the READ leg is member-reachable but the WRITE leg is not, exactly the vocabulary rule that Ball-reassignment is the privileged action)", async () => {
    const memberOnly = mintPrincipal({ provider: "whatsapp", externalId: "wa:staff-member-role" });
    const spy = mockFetchSeq([
      { status: 200, body: { id: "t1", assignee: { kind: "person", refId: "alice", refName: "Alice", responsibleId: "alice", responsibleName: "Alice" } } }, // GET succeeds — member-level 'update'/'read' access
      { status: 403, body: { error: "not authorized: cerbos denied — manage requires company_admin/manager/team_lead" } }, // PATCH's privileged 'manage' action is refused
    ]);
    vi.stubGlobal("fetch", spy);
    await expect(getTool("pm.passBall")!.handler({ tenantId: "co-1", taskId: "t1", refId: "bob" }, memberOnly)).rejects.toThrow(/not authorized/);
    expect((spy as any).mock.calls).toHaveLength(2); // both legs were actually driven — not a false pass from a short-circuit
  });

  it("ADVERSARIAL: a principal probing a task in a tenant they don't belong to gets a 404 (RLS makes the row invisible), never task data — driven through pm.setStatus and pm.passBall's handlers", async () => {
    const outsider = mintPrincipal({ provider: "whatsapp", externalId: "wa:other-tenant-user" });
    expect(authorize(outsider, "pm.setStatus").allow).toBe(true); // hub can't see tenancy either
    vi.stubGlobal("fetch", mockFetch(404, { error: "task not found" }));
    await expect(
      getTool("pm.setStatus")!.handler({ tenantId: "not-my-co", taskId: "t1", status: "doing" }, outsider),
    ).rejects.toThrow(/task not found/);
    // pm.passBall's FIRST leg is the GET (platformGetPm, unchanged by this ticket) — its error
    // shape is still the pre-existing "platform <path> <status>" (no body-message extraction),
    // same as pm.taskAssignmentHistory's own cross-tenant test above; only platformSend (the
    // WRITE path) was changed to surface {error} verbatim.
    vi.stubGlobal("fetch", mockFetch(404, { error: "task not found" }));
    await expect(
      getTool("pm.passBall")!.handler({ tenantId: "not-my-co", taskId: "t1", refId: "bob" }, outsider),
    ).rejects.toThrow(/404/);
  });

  it("ADVERSARIAL: no n8n automation workflow is scoped to any of the four new PM write tools — deny-by-default via AUTOMATION_ALLOWLIST, proven through authorize() (the same gate hub.ts calls)", () => {
    for (const wf of Object.keys(AUTOMATION_ALLOWLIST)) {
      const wfPrincipal = mintPrincipal({ provider: "n8n", externalId: wf });
      for (const tool of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
        if (AUTOMATION_ALLOWLIST[wf].includes(tool)) continue; // none should, but don't hardcode the negative if a future ticket adds one
        expect(authorize(wfPrincipal, tool).allow, `${wf} must not reach ${tool}`).toBe(false);
      }
    }
    const unknownWf = mintPrincipal({ provider: "n8n", externalId: "wf:does-not-exist" });
    expect(authorize(unknownWf, "pm.setStatus").allow).toBe(false);
  });

  it("none of the four new PM write tools appears in ANY workflow's AUTOMATION_ALLOWLIST entry today", () => {
    for (const [wf, scope] of Object.entries(AUTOMATION_ALLOWLIST)) {
      for (const t of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
        expect(scope, `${wf} should not include ${t}`).not.toContain(t);
      }
    }
  });

  it("decision 16 mechanic, pinned: IF a workflow were ever scoped to a PM write tool, the D14 gate would NOT suspend it — impact:\"low\" short-circuits the `tool.write && tool.impact !== \"low\"` suspend branch in policy.ts. This is the deliberate mechanism, not an oversight", () => {
    AUTOMATION_ALLOWLIST["wf:test-j2-hypothetical"] = ["pm.setStatus"];
    try {
      const wfPrincipal = mintPrincipal({ provider: "n8n", externalId: "wf:test-j2-hypothetical" });
      const d = authorize(wfPrincipal, "pm.setStatus");
      expect(d.allow).toBe(true);
    } finally {
      delete AUTOMATION_ALLOWLIST["wf:test-j2-hypothetical"];
    }
  });
});

// ───────────────────────────── LIVE resource_mcp_tool.yaml — P4-J2 ─────────────────────────────
//
// This ticket verified rather than assumed: the existing rule matches tool ATTRIBUTES
// (write/impact/minAssurance), not tool NAMES, so a write:true+impact:"low" tool is already
// authorized by the SAME generic disjunct that covers pm.createTask/pm.createDoc
// (`request.resource.attr.impact == "low"` inside resource_mcp_tool.yaml's automation conjunct).
// No edit was made to that policy file for this ticket, so — unlike a real policy change — there is
// NOTHING to restart; these calls hit whatever Cerbos snapshot is already running.
//
// Same self-skip convention as cerbos.test.ts's own live block: requires a Cerbos serving
// platform-nest/cerbos/policies (the local stack publishes 3592); skipped when unreachable so CI
// (which runs mcp-hub standalone) stays green.
const realFetchJ2 = globalThis.fetch;
const LIVE_CERBOS_J2 = process.env.CERBOS_TEST_URL ?? "http://localhost:3592";
const liveReachableJ2 = await (async () => {
  try {
    const res = await realFetchJ2(`${LIVE_CERBOS_J2}/_cerbos/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
})();
if (!liveReachableJ2) {
  console.warn(`[pm-tools.test] SKIPPING live resource_mcp_tool checks for P4-J2 — no Cerbos at ${LIVE_CERBOS_J2}`);
}

describe.skipIf(!liveReachableJ2)("P4-J2 — LIVE resource_mcp_tool.yaml: the four new PM write tools need NO new rule", () => {
  const originalCerbosUrl = config.cerbosUrl;
  beforeEach(() => {
    resetRegistry();
    registerPmTools();
    config.cerbosUrl = LIVE_CERBOS_J2;
  });
  afterEach(() => {
    config.cerbosUrl = originalCerbosUrl;
  });

  it("ALLOW: a verified non-automation principal (human/bot session) may call each of the four — the automation conjunct doesn't apply to a non-automation caller at all", async () => {
    const { cerbosAllowsTool } = await import("./cerbos");
    const human: Principal = { provider: "platform", externalId: "u-1", assurance: "verified" };
    for (const name of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
      await expect(cerbosAllowsTool(human, getTool(name)!)).resolves.toBe(true);
    }
  });

  it("DENY: an automation workflow NOT scoped for the tool is denied by the live policy (deny-by-default persists even for a write:true/impact:\"low\" tool)", async () => {
    const { cerbosAllowsTool } = await import("./cerbos");
    const unscoped = mintPrincipal({ provider: "n8n", externalId: "wf:j2-live-unscoped-probe" });
    for (const name of ["pm.setStatus", "pm.passBall", "pm.setDueDate", "pm.comment"]) {
      await expect(cerbosAllowsTool(unscoped, getTool(name)!)).resolves.toBe(false);
    }
  });

  it("ALLOW: an automation workflow explicitly IN-SCOPE for pm.setStatus is allowed by the LIVE policy with NO grant at all — proving impact:\"low\" alone clears the automation conjunct's write disjunct, exactly like pm.createTask/pm.createDoc already do", async () => {
    const { cerbosAllowsTool } = await import("./cerbos");
    AUTOMATION_ALLOWLIST["wf:j2-live-scoped-probe"] = ["pm.setStatus"];
    try {
      const wf = mintPrincipal({ provider: "n8n", externalId: "wf:j2-live-scoped-probe" });
      await expect(cerbosAllowsTool(wf, getTool("pm.setStatus")!)).resolves.toBe(true);
    } finally {
      delete AUTOMATION_ALLOWLIST["wf:j2-live-scoped-probe"];
    }
  });

  it("ALLOW: pm.passBall behaves identically to the other three under this policy (write:true/impact:\"low\" is uniform across all four — Ball's extra 'manage' privilege is a PLATFORM-side Cerbos distinction, not a hub-level one)", async () => {
    const { cerbosAllowsTool } = await import("./cerbos");
    AUTOMATION_ALLOWLIST["wf:j2-live-ball-probe"] = ["pm.passBall"];
    try {
      const wf = mintPrincipal({ provider: "n8n", externalId: "wf:j2-live-ball-probe" });
      await expect(cerbosAllowsTool(wf, getTool("pm.passBall")!)).resolves.toBe(true);
    } finally {
      delete AUTOMATION_ALLOWLIST["wf:j2-live-ball-probe"];
    }
  });
});
