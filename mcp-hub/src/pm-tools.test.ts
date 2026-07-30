import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerPmTools } from "./pm-tools";
import { getTool, resetRegistry } from "./registry";
import { mintPrincipal } from "./principal";
import { AUTOMATION_ALLOWLIST } from "./automation-policy";

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
