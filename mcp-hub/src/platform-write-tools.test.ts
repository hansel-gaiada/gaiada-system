import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPlatformWriteTools } from "./platform-write-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";

const principal = mintPrincipal({ provider: "whatsapp", externalId: "628110@c.us" });

function mockFetch(status: number, json: unknown) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
  })) as unknown as typeof fetch;
}

describe("platform write-tools", () => {
  beforeEach(() => {
    resetRegistry();
    registerPlatformWriteTools();
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers the write + authz tools", () => {
    for (const n of ["authz.check", "projects.create", "tasks.create", "tasks.update", "approvals.request"]) {
      expect(getTool(n)).toBeDefined();
    }
  });

  it("approvals.request is a LOW write and posts a suspension to the platform inbox", () => {
    const t = getTool("approvals.request")!;
    expect(t.write).toBe(true);
    expect(t.impact).toBe("low"); // it records an intent only — never the gated write itself
  });

  it("approvals.request forwards the OBO envelope + suspension body to automation-approvals", async () => {
    const spy = mockFetch(201, { id: "ap-1", status: "pending" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("approvals.request")!.handler(
      { tenantId: "co-1", workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 100 }, impact: "medium", reason: "suspend: medium-impact write" },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "ap-1", status: "pending" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/automation-approvals");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ workflowId: "wf:new-client-seed", toolName: "money.transfer", impact: "medium" });
    expect(body.origin).toBe("automation"); // defaults to automation when unspecified
  });

  it("approvals.request forwards an agent-origin suspension (WS8 Step B)", async () => {
    const spy = mockFetch(201, { id: "ap-2", status: "pending" });
    vi.stubGlobal("fetch", spy);
    await getTool("approvals.request")!.handler(
      { tenantId: "co-1", workflowId: "task-triager", toolName: "tasks.update", toolArgs: { taskId: "t1" }, impact: "high", origin: "agent", agentName: "task-triager" },
      principal,
    );
    const body = JSON.parse((spy as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ origin: "agent", agentName: "task-triager", toolName: "tasks.update" });
  });

  it("forwards the OBO envelope on a create and returns the platform result", async () => {
    const spy = mockFetch(201, { id: "task-1" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("tasks.create")!.handler(
      { tenantId: "co-1", projectId: "proj-1", title: "Pour slab" },
      principal,
    );
    expect(JSON.parse(out)).toEqual({ id: "task-1" });
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/projects/proj-1/tasks");
    expect((init.headers as Record<string, string>)["x-obo-external-id"]).toBe("628110@c.us");
    expect(init.method).toBe("POST");
  });

  it("tasks.update issues a PATCH with the changed fields", async () => {
    const spy = mockFetch(200, { id: "task-1" });
    vi.stubGlobal("fetch", spy);
    await getTool("tasks.update")!.handler({ tenantId: "co-1", taskId: "task-1", status: "done" }, principal);
    const [url, init] = (spy as any).mock.calls[0];
    expect(url).toContain("/api/co-1/tasks/task-1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body).status).toBe("done");
  });

  it("maps a platform 403 to a thrown denial (so the surface shows step-up/deny)", async () => {
    vi.stubGlobal("fetch", mockFetch(403, { error: "not authorized: cerbos denied" }));
    await expect(
      getTool("projects.create")!.handler({ tenantId: "co-1", name: "X" }, principal),
    ).rejects.toThrow(/not authorized/);
  });

  it("authz.check posts to the probe endpoint", async () => {
    const spy = mockFetch(200, { decision: "allow" });
    vi.stubGlobal("fetch", spy);
    const out = await getTool("authz.check")!.handler({ tenantId: "co-1", resource: "task", action: "create" }, principal);
    expect(JSON.parse(out)).toEqual({ decision: "allow" });
    expect((spy as any).mock.calls[0][0]).toContain("/api/co-1/authz/check");
  });
});
