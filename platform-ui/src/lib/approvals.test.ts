import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getApprovalDetailAcrossTenants } from "./approvals";
import { PlatformError } from "./platform";

// MAIL-34 defect 2 — pins the cross-tenant approval-deep-link fix. Mirrors
// `reports-print-data.test.ts`'s convention of stubbing `global.fetch` directly rather than
// mocking `lib/platform`, since `platformFetch`'s own dev-auth fallback (bearer + x-user-id) works
// fine outside a real request context.
const AUTOMATION_ROW = {
  id: "appr-1", workflowId: "wf-1", toolName: "tool", toolArgs: null, impact: "low", reason: null,
  status: "pending", origin: "automation", agentName: null, requestedBy: "u-req", requestedByName: "Requester",
  decidedBy: null, decidedByName: null, decidedAt: null, createdAt: "2026-08-01T00:00:00.000Z",
  executionStatus: null, executedAt: null, executedBy: null, executionError: null, executionResult: null,
  executionAttempts: null,
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("getApprovalDetailAcrossTenants", () => {
  const originalFetch = global.fetch;
  const originalPlatformUrl = process.env.PLATFORM_URL;

  beforeEach(() => {
    process.env.PLATFORM_URL = "http://platform-nest.internal:3004";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalPlatformUrl === undefined) delete process.env.PLATFORM_URL; else process.env.PLATFORM_URL = originalPlatformUrl;
    vi.restoreAllMocks();
  });

  it("skips a candidate tenant that 404s (the row is invisible under that tenant's RLS scope) and resolves against the one that has it", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/co-right/automation-approvals/appr-1")) return jsonResponse(AUTOMATION_ROW, 200);
      return jsonResponse({ error: "approval not found" }, 404);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const result = await getApprovalDetailAcrossTenants("user-1", ["co-wrong", "co-right"], "appr-1");
    expect(result?.tenantId).toBe("co-right");
    expect(result?.detail.kind).toBe("automation_approval");
  });

  it("a REAL 403 on the tenant that has the row propagates immediately — never swallowed into a false not-found, and never tries another candidate", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes("/api/co-right/automation-approvals/appr-1")) return jsonResponse({ error: "forbidden" }, 403);
      throw new Error(`must not query another tenant after a real 403 — got ${url}`);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    await expect(
      getApprovalDetailAcrossTenants("user-1", ["co-right", "co-other"], "appr-1"),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("propagates that 403 as a real PlatformError instance, not a generic Error", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403)) as unknown as typeof fetch;
    await expect(getApprovalDetailAcrossTenants("user-1", ["co-right"], "appr-1")).rejects.toBeInstanceOf(PlatformError);
  });

  it("no candidate tenant has the row -> resolves null (the caller has no membership anywhere the row is visible — honest 'not found', not a leak)", async () => {
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404)) as unknown as typeof fetch;
    const result = await getApprovalDetailAcrossTenants("user-1", ["co-a", "co-b"], "appr-1");
    expect(result).toBeNull();
  });

  it("dedupes candidate tenant ids and skips empty entries, without extra requests", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    global.fetch = fetchSpy as unknown as typeof fetch;
    await getApprovalDetailAcrossTenants("user-1", ["co-a", "co-a", "", "co-a"], "appr-1");
    // one unique tenant -> automation lookup (404) then agency lookup (404) = 2 calls, not 6.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("an empty candidate list resolves null without calling fetch at all", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const result = await getApprovalDetailAcrossTenants("user-1", [], "appr-1");
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
