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
    for (const n of ["authz.check", "projects.create", "tasks.create", "tasks.update"]) {
      expect(getTool(n)).toBeDefined();
    }
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
