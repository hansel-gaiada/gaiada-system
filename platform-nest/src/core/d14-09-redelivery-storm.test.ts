// D14-09 — QA adversarial addition: a TRUE CONCURRENT redelivery storm of the decided-event
// handler, plus a direct check of the crash-wedge staleness boundary (off-by-one).
//
// WHY THIS FILE EXISTS ALONGSIDE approval-execute.test.ts's own "(a) redelivering the same
// decided event twice" case: that test awaits each call SEQUENTIALLY (call 1 fully resolves —
// including committing `executed` — before call 2 even starts its claim). That proves the claim's
// WHERE clause rejects a claim attempted AFTER a prior one committed, but it can never exercise
// the harder race: several redeliveries reaching their `UPDATE ... WHERE execution_status =
// 'pending'` at nearly the same instant, before any of them has committed. Postgres row-level
// locking is what has to resolve that, not application logic — so this test fires 5 handlers
// with Promise.all (genuine interleaving) rather than 2 sequential awaits, which is the redelivery
// shape Redis consumer-group redelivery + XCLAIM + a retry click can actually produce together.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { registerExecutableApproval, resetExecutableApprovals, registerCoreExecutableApprovals } from "./approval-executables";
import { automationApprovalExecutorHandler, isExecutionWedged, EXECUTING_STALE_MS } from "./approval-execute";
import type { OutboxEvent } from "../events/types";

const GRANT_SECRET = "d14-09-storm-test-secret";

let hubCalls: Array<{ body: unknown }> = [];
const realFetch = globalThis.fetch;

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

function installHubStub(delayMs = 15): void {
  hubCalls = [];
  const stub = vi.fn(async (url: string, init: any) => {
    if (!String(url).startsWith("http://hub.storm.test")) return realFetch(url as any, init);
    // A small delay widens the window in which concurrent claims would race, if the claim were
    // not already atomic — a zero-delay stub could accidentally "pass" by luck of scheduling.
    await new Promise((r) => setTimeout(r, delayMs));
    hubCalls.push({ body: JSON.parse(init.body) });
    const rpc = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "deployed" }] } };
    return { ok: true, status: 200, text: async () => sse(rpc) };
  });
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
}

describe.skipIf(!TEST_URL)("D14-09 adversarial: concurrent redelivery storm + crash-wedge boundary", () => {
  let co: string;
  let wfUser: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.storm.test", token: "hub-token", assuranceToken: "" };
    resetModules();
    resetCoreRollupProviders();
    resetExecutableApprovals();
    registerExecutableApproval({
      toolName: "test.d1409-storm",
      lockKey: (a) => `storm:${String(a.runId ?? "none")}`,
      precondition: async () => ({ ok: true }),
    });
    co = await createCompany("D14-09 Storm Co");
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;
    await buildApp(); // ensure app boot path (module registration) doesn't clobber the registry
    registerCoreExecutableApprovals; // no-op reference; deploy.* registration is irrelevant here
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(() => installHubStub());
  afterEach(() => vi.restoreAllMocks());

  async function fileDecided(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1, $2, 'wf:delivery', $3, $4, 'high', 'approved', $5, $5, now(), 'automation', 'main', 'pending')`,
        [id, co, toolName, JSON.stringify(args), wfUser],
      ),
    );
    return id;
  }

  const decidedEvent = (approvalId: string): OutboxEvent => ({
    id: newId(),
    tenantId: co,
    entityType: "automation_approval",
    entityId: approvalId,
    eventType: "automation_approval.decided",
    payload: { decision: "approved", origin: "automation" },
    originSite: "main",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  });

  async function rowOf(id: string) {
    const r = await adminPool().query<{ execution_status: string; execution_attempts: number }>(
      `SELECT execution_status, execution_attempts FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  it("5 CONCURRENT redeliveries of the same decided event ⇒ exactly ONE hub call, one execution, no wedge", async () => {
    const id = await fileDecided("test.d1409-storm", { runId: "storm-1" });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => automationApprovalExecutorHandler(decidedEvent(id))),
    );
    // The handler never throws for this shape — every one of the 5 calls should resolve cleanly.
    expect(results).toHaveLength(5);
    expect(hubCalls).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1);
  });

  it("10 CONCURRENT redeliveries across TWO different approvals never cross-contaminate (each executes exactly once)", async () => {
    const idA = await fileDecided("test.d1409-storm", { runId: "storm-a" });
    const idB = await fileDecided("test.d1409-storm", { runId: "storm-b" });
    await Promise.all([
      ...Array.from({ length: 5 }, () => automationApprovalExecutorHandler(decidedEvent(idA))),
      ...Array.from({ length: 5 }, () => automationApprovalExecutorHandler(decidedEvent(idB))),
    ]);
    expect(hubCalls).toHaveLength(2);
    const [rowA, rowB] = await Promise.all([rowOf(idA), rowOf(idB)]);
    expect(rowA.execution_status).toBe("executed");
    expect(rowA.execution_attempts).toBe(1);
    expect(rowB.execution_status).toBe("executed");
    expect(rowB.execution_attempts).toBe(1);
  });

  it("crash-wedge boundary: exactly at EXECUTING_STALE_MS is NOT yet wedged (off-by-one guard), one ms past IS", async () => {
    const now = Date.now();
    // isExecutionWedged uses strict `>`, so age === threshold must be false and threshold+1 must be true.
    const exactlyAtThreshold = new Date(now - EXECUTING_STALE_MS);
    const onePastThreshold = new Date(now - EXECUTING_STALE_MS - 1);
    expect(isExecutionWedged("executing", exactlyAtThreshold, now)).toBe(false);
    expect(isExecutionWedged("executing", onePastThreshold, now)).toBe(true);
  });
});
