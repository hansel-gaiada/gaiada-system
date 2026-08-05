// D14-03 — the executor's adversarial suite. Every test here maps to one of the four invariants in
// core/approval-execute.ts's header (authority / single-use / TOCTOU / loudness) or to the grant
// contract in docs/superpowers/plans/2026-08-05-d14-and-assistant-tickets.md §1.
//
// THE FALSIFIABILITY ANCHOR is "approving a registered automation write calls the hub EXACTLY once"
// (below): it fails against the pre-ticket code, where main.ts registered an inert stub for
// `automation_approval.decided` and an approved row executed nothing at all.
//
// The hub is a STUBBED fetch, not a live mcp-hub, and that is deliberate for two reasons: (1) these
// tests pin the platform's half of the contract — the canonical digest, the canonical claim
// spellings, the OBO envelope, the single-use claim — which is exactly what a live hub would hide
// behind a 200; (2) with Cerbos ON an `origin='automation'` re-drive is currently DENIED by
// `cerbos/policies/resource_mcp_tool.yaml`, whose `call` clause independently encodes the impact gate
// until D14-13 lands (ticket doc §0.8/§5.9). That deny is asserted here as a `failed` row carrying the
// hub's typed reason — the KNOWN-EXPECTED window, never diagnosed as an executor bug.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PoolClient } from "pg";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import {
  registerExecutableApproval,
  resetExecutableApprovals,
  type PreconditionVerdict,
} from "./approval-executables";
import {
  canonicalJson,
  computeArgsSha256,
  mintExecutionGrant,
  ApprovalGrantNotConfiguredError,
  APPROVAL_GRANT_HEADER,
  GRANT_WINDOW_MS,
} from "./hub-client";
import {
  automationApprovalExecutorHandler,
  executeApprovedAutomationWrite,
  isExecutionWedged,
  EXECUTING_STALE_MS,
  APPROVAL_EXEC_LOCK_NS,
  redactForAudit,
} from "./approval-execute";
import type { OutboxEvent } from "../events/types";

const GRANT_SECRET = "d14-03-test-secret-not-a-real-one";

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// PART 1 — the cross-service contract (no database needed).
// ══════════════════════════════════════════════════════════════════════════════════════════════════

describe("D14-03 canonical JSON + argsSha256 (contract §1, must match mcp-hub byte for byte)", () => {
  // THE THREE PINNED VECTORS, copied verbatim from mcp-hub/src/approval-grant.ts's header (which
  // asserts the same three in its own suite). If these ever disagree, EVERY grant is rejected as
  // `args_mismatch` and every approved automation write silently keeps failing — a deny-everything
  // bug that no happy-path test on either side would catch alone.
  it("vector 1: {} → \"{}\" → 44136fa3…", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(computeArgsSha256({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });

  it("vector 2: nested + unsorted keys → recursively key-sorted, array order preserved → f2b017ad…", () => {
    const args = { b: 1, a: { d: 1, c: [3, { y: 2, x: 1 }] } };
    expect(canonicalJson(args)).toBe('{"a":{"c":[3,{"x":1,"y":2}],"d":1},"b":1}');
    expect(computeArgsSha256(args)).toBe("f2b017ad2046767a1fb4a845843b145aef66713aa8adef3952e980dc15f44ce4");
  });

  it("vector 3: real-shaped deploy args → 756a6e9a…", () => {
    const args = { runId: "r1", repo: "acme/site" };
    expect(canonicalJson(args)).toBe('{"repo":"acme/site","runId":"r1"}');
    expect(computeArgsSha256(args)).toBe("756a6e9ac2f5873539d73f9a95008a46ed673573ade26e86ff42a6b27b1f9dad");
  });

  it("sorts keys by UTF-16 code unit, NOT numerically — the exact engine quirk a rebuilt-object serializer would bake in", () => {
    // JSON.stringify over a rebuilt object would emit 2 before 10 (integer-like keys come first, in
    // ascending NUMERIC order, regardless of insertion order). The contract's sort is lexicographic.
    expect(canonicalJson({ "10": "a", "2": "b" })).toBe('{"10":"a","2":"b"}');
    expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}'); // uppercase sorts first
  });

  it("array order is data (never sorted); an undefined element becomes null", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
  });

  it("omits undefined-valued keys, emits non-ASCII literally, and does NOT unicode-normalize", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    // Emitted LITERALLY as UTF-8, never \uXXXX-escaped. Written with explicit escapes so an editor
    // that normalizes this source file cannot silently change what is being asserted.
    expect(canonicalJson({ k: "\u00e9" })).toBe('{"k":"\u00e9"}');
    // Precomposed U+00E9 vs decomposed e + U+0301 are DIFFERENT arguments and must hash differently:
    // neither side of the contract applies NFC/NFKC.
    expect(computeArgsSha256({ k: "\u00e9" })).not.toBe(computeArgsSha256({ k: "e\u0301" }));
  });

  it("non-finite numbers become null, matching JSON.stringify (and the hub)", () => {
    expect(canonicalJson({ a: NaN, b: Infinity, c: -0 })).toBe('{"a":null,"b":null,"c":0}');
  });
});

describe("D14-03 grant minting (contract §1 canonical spellings: ms + lowercase hex + base64url)", () => {
  beforeEach(() => {
    config.approvalGrantSecret = GRANT_SECRET;
  });

  it("emits base64url(payload).base64url(hmac) and the signature verifies over the exact payload part", () => {
    const { header, payload } = mintExecutionGrant({
      approvalId: "a-1",
      tenantId: "t-1",
      toolName: "deploy.staging",
      args: { runId: "r1", repo: "acme/site" },
    });
    const [payloadPart, signaturePart] = header.split(".");
    expect(header.split(".")).toHaveLength(2);
    // base64url alphabet only — no '+', '/' or '=' padding.
    expect(payloadPart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signaturePart).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"))).toEqual(payload);
    const expected = createHmac("sha256", GRANT_SECRET).update(payloadPart, "utf8").digest("base64url");
    expect(signaturePart).toBe(expected);
  });

  it("claims are canonical: v=1, iat/exp in MILLISECONDS, window ≤ 120s, argsSha256 lowercase hex", () => {
    const before = Date.now();
    const { payload } = mintExecutionGrant({ approvalId: "a-1", tenantId: "t-1", toolName: "deploy.staging", args: { runId: "r1" } });
    const after = Date.now();
    expect(payload.v).toBe(1);
    // Milliseconds, not seconds: the verifier reads anything < 1e11 as seconds, so a seconds-valued
    // iat would be normalized to 1970 and every grant would read as long-expired.
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.iat).toBeGreaterThan(1e11);
    expect(payload.exp - payload.iat).toBe(GRANT_WINDOW_MS);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(120_000);
    expect(payload.argsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.argsSha256).toBe(createHash("sha256").update('{"runId":"r1"}', "utf8").digest("hex"));
  });

  it("mints a FRESH nonce per call — a reused nonce would be rejected as replayed_nonce on the first retry", () => {
    const a = mintExecutionGrant({ approvalId: "a-1", tenantId: "t-1", toolName: "x", args: {} });
    const b = mintExecutionGrant({ approvalId: "a-1", tenantId: "t-1", toolName: "x", args: {} });
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
    expect(a.payload.nonce.length).toBeGreaterThanOrEqual(16);
  });

  it("throws (fail CLOSED) when APPROVAL_GRANT_SECRET is unset instead of signing with an empty key", () => {
    config.approvalGrantSecret = "";
    expect(() => mintExecutionGrant({ approvalId: "a-1", tenantId: "t-1", toolName: "x", args: {} })).toThrow(
      ApprovalGrantNotConfiguredError,
    );
  });
});

describe("D14-03 crash-wedge predicate + audit redaction (pure)", () => {
  it("only an `executing` row older than the staleness threshold is wedged", () => {
    const now = Date.now();
    expect(isExecutionWedged("executing", new Date(now - 1000), now)).toBe(false);
    expect(isExecutionWedged("executing", new Date(now - EXECUTING_STALE_MS - 1000), now)).toBe(true);
    // A terminal row is never "wedged" — retrying a failed row is a different, always-allowed case.
    expect(isExecutionWedged("failed", new Date(now - 86_400_000), now)).toBe(false);
    expect(isExecutionWedged("pending", new Date(now - 86_400_000), now)).toBe(false);
  });

  it("redacts credential-shaped substrings before a tool payload is persisted", () => {
    expect(redactForAudit("Authorization: Bearer abcdef1234567890")).toContain("[redacted]");
    expect(redactForAudit('{"token":"sk-live-abcdef"}')).not.toContain("sk-live-abcdef");
    expect(redactForAudit("deployed run r1 to staging")).toBe("deployed run r1 to staging");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// PART 2 — the executor, against live Postgres + RLS (+ Cerbos for the decide-endpoint anchor).
// ══════════════════════════════════════════════════════════════════════════════════════════════════

/** One stubbed hub response. */
type HubReply =
  | { kind: "ok"; text: string }
  | { kind: "isError"; text: string }
  | { kind: "http"; status: number }
  | { kind: "throw"; message: string };

let hubReplies: HubReply[] = [];
let hubCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

function sse(payload: unknown): string {
  return `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** The REAL fetch, captured once. Everything that is not a hub tool call (chiefly Cerbos, which the
 *  decide endpoint hits through this same global) must still go out for real — a blanket stub made the
 *  authorization layer return an object with no `.json()` and turned an authz call into a 500. */
const realFetch = globalThis.fetch;

function installHubStub(): void {
  hubCalls = [];
  const stub = vi.fn(async (url: string, init: any) => {
    if (!String(url).startsWith("http://hub.test")) return realFetch(url as any, init);
    hubCalls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(init.body) });
    const reply = hubReplies.length > 1 ? hubReplies.shift()! : (hubReplies[0] ?? { kind: "ok", text: "ok" });
    if (reply.kind === "throw") throw new Error(reply.message);
    if (reply.kind === "http") return { ok: false, status: reply.status, text: async () => "" };
    const rpc =
      reply.kind === "ok"
        ? { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }] } }
        : { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: reply.text }], isError: true } };
    return { ok: true, status: 200, text: async () => sse(rpc) };
  });
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
}

describe.skipIf(!TEST_URL)("D14-03 executor — claim, precondition, re-drive, record, notify", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // the APPROVER (company_admin) — must never be the executing principal
  let wfUser: string; // wf:delivery's automation service account = the original filing principal
  let agentUser: string; // an agent-origin requester WITH a verified identity link
  let linklessUser: string; // an agent-origin requester with NO verified link

  /** Observations recorded from inside a precondition, to prove it runs in the CLAIMING transaction
   *  while the advisory lock is held. */
  let observed: { executionStatus?: string; attempts?: number; advisoryLocks?: number; lockKeys: string[] };
  /** Flips the shared "flaky" fixture's verdict between attempts (the retry-safety test). */
  let flakyVerdicts: PreconditionVerdict[] = [];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.test", token: "hub-token" };
    resetModules();
    resetCoreRollupProviders();
    resetExecutableApprovals();

    // The happy-path fixture. Its precondition doubles as the TOCTOU probe: it asserts (from inside
    // the transaction) that the claim is already applied and that the advisory lock is held.
    registerExecutableApproval({
      toolName: "test.exec-ok",
      lockKey: (a) => `pipeline_run:${String(a.runId ?? "none")}`,
      precondition: async (c: PoolClient, a) => {
        observed.lockKeys.push(`pipeline_run:${String(a.runId ?? "none")}`);
        const row = await c.query<{ execution_status: string; execution_attempts: number }>(
          `SELECT execution_status, execution_attempts FROM automation_approvals WHERE tool_name = 'test.exec-ok' ORDER BY updated_at DESC LIMIT 1`,
        );
        observed.executionStatus = row.rows[0]?.execution_status;
        observed.attempts = row.rows[0]?.execution_attempts;
        const locks = await c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND classid = $1`,
          [APPROVAL_EXEC_LOCK_NS],
        );
        observed.advisoryLocks = locks.rows[0]?.n ?? 0;
        return { ok: true };
      },
    });
    registerExecutableApproval({
      toolName: "test.exec-stale",
      lockKey: (a) => `pipeline_run:${String(a.runId ?? "none")}`,
      precondition: async () => ({ ok: false, reason: "run_blocked" }),
    });
    registerExecutableApproval({
      toolName: "test.exec-throws",
      lockKey: () => "throwing",
      precondition: async () => {
        throw new Error("precondition blew up");
      },
    });
    registerExecutableApproval({
      toolName: "test.exec-flaky",
      lockKey: () => "flaky",
      precondition: async () => flakyVerdicts.shift() ?? { ok: true },
    });
    // Registered by NAME ONLY — the D14-02-era shape. Must be inert, not unguarded.
    registerExecutableApproval({ toolName: "test.exec-nameonly" });

    co = await createCompany("D14-03 Executor Co");
    await seedAutomationAccounts(co);
    admin = await createUser("d1403-admin@a.test");
    agentUser = await createUser("d1403-agent@a.test");
    linklessUser = await createUser("d1403-linkless@a.test");
    await addMembership(co, admin);
    await addMembership(co, agentUser);
    await addMembership(co, linklessUser);
    const companyAdminRole = await createRole("company_admin");
    await grantRole(admin, companyAdminRole, "company", co);
    await linkIdentity(agentUser, "telegram", "tg:d1403-agent", true);

    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    observed = { lockKeys: [] };
    flakyVerdicts = [];
    hubReplies = [{ kind: "ok", text: "deployed" }];
    installHubStub();
  });
  afterEach(() => vi.restoreAllMocks());

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────

  /** Insert an already-decided row straight into the state the decide endpoints produce. Used by the
   *  focused executor tests; the decide endpoint itself is exercised by the anchor test below. */
  async function fileDecided(opts: {
    toolName: string;
    args?: Record<string, unknown>;
    origin?: string;
    requestedBy?: string | null;
    executionStatus?: string;
    workflowId?: string;
  }): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1, $2, $3, $4, $5, 'high', 'approved', $6, $7, now(), $8, 'main', $9)`,
        [
          id,
          co,
          opts.workflowId ?? "wf:delivery",
          opts.toolName,
          JSON.stringify(opts.args ?? {}),
          opts.requestedBy === undefined ? wfUser : opts.requestedBy,
          admin,
          opts.origin ?? "automation",
          opts.executionStatus ?? "pending",
        ],
      ),
    );
    return id;
  }

  const decidedEvent = (approvalId: string, origin = "automation"): OutboxEvent => ({
    id: newId(),
    tenantId: co,
    entityType: "automation_approval",
    entityId: approvalId,
    eventType: "automation_approval.decided",
    payload: { decision: "approved", origin },
    originSite: "main",
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
  });

  async function rowOf(id: string) {
    const r = await adminPool().query(
      `SELECT execution_status, execution_attempts, executed_by, decided_by, execution_error, execution_result, executed_at
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return r.rows[0];
  }

  /** Only this ticket's EXECUTION notifications — the `approval.requested` fan-out the create endpoint
   *  sends to every decider carries the same `entityId` and would otherwise be counted here. */
  async function notificationsFor(id: string) {
    const r = await adminPool().query<{ user_id: string; type: string; payload: any }>(
      `SELECT user_id, type, payload FROM notifications
        WHERE payload->>'entityId' = $1
          AND type IN ('automation_approval.executed', 'automation_approval.execution_failed')
        ORDER BY created_at`,
      [id],
    );
    return r.rows;
  }

  // ── (g) THE FALSIFIABILITY ANCHOR + (e) authority ───────────────────────────────────────────────

  it("ANCHOR: approving a registered automation write calls the hub EXACTLY once, as the ORIGINAL principal (fails against the pre-ticket stub)", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals`,
      headers: { authorization: "Bearer svc-token", "x-obo-provider": "n8n", "x-obo-external-id": "wf:delivery" },
      payload: {
        workflowId: "wf:delivery",
        toolName: "test.exec-ok",
        toolArgs: { runId: "run-anchor", repo: "acme/site" },
        impact: "high",
        reason: "d14-03 anchor",
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const decide = await app.inject({
      method: "POST",
      url: `/api/${co}/automation-approvals/${id}/decide`,
      headers: { authorization: "Bearer svc-token", "x-user-id": admin },
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    expect((await rowOf(id)).execution_status).toBe("pending");

    // The core event handler is what main.ts registers for `automation_approval.decided`.
    await automationApprovalExecutorHandler(decidedEvent(id));

    // 1. the hub was called, exactly once, at the tool-call endpoint
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].url).toBe("http://hub.test/mcp");
    expect(hubCalls[0].body).toMatchObject({
      method: "tools/call",
      params: { name: "test.exec-ok", arguments: { runId: "run-anchor", repo: "acme/site" } },
    });
    // 2. INVARIANT 1 — as the original filing principal (the workflow), never as the approver
    expect(hubCalls[0].headers["x-obo-provider"]).toBe("n8n");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("wf:delivery");
    // 3. the grant is present, canonical, and binds THESE args
    const grant = hubCalls[0].headers[APPROVAL_GRANT_HEADER];
    expect(grant).toBeTruthy();
    const [payloadPart, sig] = grant.split(".");
    expect(createHmac("sha256", GRANT_SECRET).update(payloadPart, "utf8").digest("base64url")).toBe(sig);
    const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    expect(claims).toMatchObject({ v: 1, approvalId: id, tenantId: co, toolName: "test.exec-ok" });
    expect(claims.argsSha256).toBe(computeArgsSha256(hubCalls[0].body.params.arguments));
    // 4. terminal state: executed, by the FILER, not the DECIDER
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.executed_at).not.toBeNull();
    expect(row.executed_by).toBe(wfUser);
    expect(row.decided_by).toBe(admin);
    expect(row.executed_by).not.toBe(row.decided_by);
    expect(row.execution_error).toBeNull();
    expect(row.execution_result).toMatchObject({ outcome: "ok", text: "deployed", truncated: false });
    // 5. INVARIANT 4 — both sides told
    const notes = await notificationsFor(id);
    expect(notes.map((n) => n.user_id).sort()).toEqual([admin, wfUser].sort());
    expect(notes.every((n) => n.type === "automation_approval.executed")).toBe(true);
    expect(notes[0].payload.severity).toBe("info");
    expect(notes[0].payload.href).toBe(`/approvals/${id}`);
  });

  it("TOCTOU: the precondition runs INSIDE the claiming transaction, with the advisory lock held on the entry's key", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-lock" } });
    await executeApprovedAutomationWrite(co, id);
    // Visible only from inside the claiming transaction — proof it is the same one.
    expect(observed.executionStatus).toBe("executing");
    expect(observed.attempts).toBe(1);
    expect(observed.advisoryLocks).toBe(1);
    expect(observed.lockKeys).toEqual(["pipeline_run:run-lock"]);
  });

  // ── (a) single use ──────────────────────────────────────────────────────────────────────────────

  it("(a) redelivering the same decided event twice calls the hub exactly ONCE", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-dup" } });
    await automationApprovalExecutorHandler(decidedEvent(id));
    await automationApprovalExecutorHandler(decidedEvent(id));
    expect(hubCalls).toHaveLength(1);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.execution_attempts).toBe(1);
  });

  it("a row that is not `pending` is skipped silently — no hub call, no row mutation", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", executionStatus: "not_applicable" });
    expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("not_applicable");
  });

  it("the handler ignores every event that is not an approved automation/agent decision", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok" });
    await automationApprovalExecutorHandler({ ...decidedEvent(id), eventType: "automation_approval.created" });
    await automationApprovalExecutorHandler({ ...decidedEvent(id), payload: { decision: "rejected", origin: "automation" } });
    await automationApprovalExecutorHandler({ ...decidedEvent(id), payload: { decision: "approved", origin: "hr" } });
    expect(hubCalls).toHaveLength(0);
    expect((await rowOf(id)).execution_status).toBe("pending");
  });

  // ── (b) stale precondition ──────────────────────────────────────────────────────────────────────

  it("(b) a stale precondition lands `failed` with the typed reason, notifies at warning, and NEVER calls the hub", async () => {
    const id = await fileDecided({ toolName: "test.exec-stale", args: { runId: "run-stale" } });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out).toEqual({ status: "failed", error: "precondition_failed: run_blocked" });
    expect(hubCalls).toHaveLength(0);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("failed");
    expect(row.execution_error).toBe("precondition_failed: run_blocked");
    expect(row.execution_attempts).toBe(1);
    const notes = await notificationsFor(id);
    expect(notes.map((n) => n.user_id).sort()).toEqual([admin, wfUser].sort());
    expect(notes.every((n) => n.type === "automation_approval.execution_failed")).toBe(true);
    expect(notes.every((n) => n.payload.severity === "warning")).toBe(true);
  });

  it("a THROWING precondition is not a pass: `precondition_error`, no hub call", async () => {
    const id = await fileDecided({ toolName: "test.exec-throws" });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out.status).toBe("failed");
    expect(hubCalls).toHaveLength(0);
    const row = await rowOf(id);
    expect(row.execution_status).toBe("failed");
    expect(row.execution_error).toContain("precondition_error: precondition blew up");
  });

  it("a NAME-ONLY registry entry is inert, not unguarded: refuses with no_precondition_registered", async () => {
    const id = await fileDecided({ toolName: "test.exec-nameonly" });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out).toEqual({ status: "failed", error: "precondition_failed: no_precondition_registered" });
    expect(hubCalls).toHaveLength(0);
  });

  it("an unregistered tool_name on a claimed row fails closed (`not_executable`) rather than calling the hub anyway", async () => {
    const id = await fileDecided({ toolName: "search.setBudget" }); // permanently barred from the registry
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out.status).toBe("failed");
    expect((await rowOf(id)).execution_error).toContain("not_executable");
    expect(hubCalls).toHaveLength(0);
  });

  it("an origin outside {automation, agent} can never auto-execute, even if its tool is registered (HR double-apply guard)", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", origin: "hr" });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out.status).toBe("failed");
    expect((await rowOf(id)).execution_error).toContain("not_executable: origin 'hr'");
    expect(hubCalls).toHaveLength(0);
  });

  // ── (c)/(d) hub outcomes ────────────────────────────────────────────────────────────────────────

  it("(c) a workflow de-scoped between decide and execute: the hub denies, the row records the hub's own reason", async () => {
    hubReplies = [{ kind: "isError", text: "denied: workflow wf:delivery is not scoped for test.exec-ok" }];
    const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-descoped" } });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out.status).toBe("failed");
    const row = await rowOf(id);
    expect(row.execution_status).toBe("failed");
    expect(row.execution_error).toBe("hub_denied: denied: workflow wf:delivery is not scoped for test.exec-ok");
    expect((await notificationsFor(id)).every((n) => n.payload.severity === "warning")).toBe(true);
  });

  it("KNOWN-EXPECTED WINDOW (D14-13): a Cerbos policy deny lands `failed` with the policy's typed reason, not a crash", async () => {
    // This is the exact shape mcp-hub returns when `resource_mcp_tool.yaml` denies a granted
    // automation re-drive (its `call` clause independently encodes the impact gate until D14-13).
    hubReplies = [{ kind: "isError", text: "denied by policy: test.exec-ok" }];
    const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-cerbos" } });
    expect(await executeApprovedAutomationWrite(co, id)).toEqual({
      status: "failed",
      error: "hub_denied: denied by policy: test.exec-ok",
    });
    expect(hubCalls).toHaveLength(1); // the grant WAS presented; the policy refused it anyway
  });

  it("(d) a tool failure and a transport failure are recorded as distinct typed classes, both loud", async () => {
    hubReplies = [{ kind: "isError", text: "tool failed: dispatch webhook returned 500" }];
    const failedTool = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-toolerr" } });
    await executeApprovedAutomationWrite(co, failedTool);
    expect((await rowOf(failedTool)).execution_error).toBe("tool_error: tool failed: dispatch webhook returned 500");

    installHubStub();
    hubReplies = [{ kind: "http", status: 502 }];
    const unreachable = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-502" } });
    await executeApprovedAutomationWrite(co, unreachable);
    expect((await rowOf(unreachable)).execution_error).toBe("hub_unreachable: hub HTTP 502");
    expect((await notificationsFor(unreachable)).every((n) => n.payload.severity === "warning")).toBe(true);

    installHubStub();
    hubReplies = [{ kind: "throw", message: "ECONNREFUSED" }];
    const refused = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-refused" } });
    await executeApprovedAutomationWrite(co, refused);
    expect((await rowOf(refused)).execution_error).toContain("hub_unreachable: hub unreachable: ECONNREFUSED");
  });

  it("an unreachable-by-configuration hub is recorded as `not_configured`, not as a hub outage", async () => {
    const saved = { ...config.services.hub };
    config.services.hub = { url: "", token: "" };
    try {
      const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-nohub" } });
      const out = await executeApprovedAutomationWrite(co, id);
      expect(out.status).toBe("failed");
      expect((await rowOf(id)).execution_error).toBe("not_configured: HUB_URL / HUB_SERVICE_TOKEN unset");
      expect(hubCalls).toHaveLength(0);
    } finally {
      config.services.hub = saved;
    }
  });

  it("an unset APPROVAL_GRANT_SECRET fails as a CONFIGURATION error and never calls the hub", async () => {
    config.approvalGrantSecret = "";
    try {
      const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-nosecret" } });
      const out = await executeApprovedAutomationWrite(co, id);
      expect(out.status).toBe("failed");
      expect((await rowOf(id)).execution_error).toContain("not_configured: APPROVAL_GRANT_SECRET is unset");
      expect(hubCalls).toHaveLength(0);
    } finally {
      config.approvalGrantSecret = GRANT_SECRET;
    }
  });

  // ── (e) authority for origin='agent' ────────────────────────────────────────────────────────────

  it("(e) an agent-origin row re-drives under the ORIGINAL requester's verified identity link", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-agent" }, origin: "agent", requestedBy: agentUser });
    await automationApprovalExecutorHandler(decidedEvent(id, "agent"));
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0].headers["x-obo-provider"]).toBe("telegram");
    expect(hubCalls[0].headers["x-obo-external-id"]).toBe("tg:d1403-agent");
    const row = await rowOf(id);
    expect(row.execution_status).toBe("executed");
    expect(row.executed_by).toBe(agentUser);
    expect(row.executed_by).not.toBe(row.decided_by);
  });

  it("an agent-origin requester with NO verified identity link is refused — never re-driven as the approver or a service token", async () => {
    const id = await fileDecided({ toolName: "test.exec-ok", origin: "agent", requestedBy: linklessUser });
    const out = await executeApprovedAutomationWrite(co, id);
    expect(out.status).toBe("failed");
    expect((await rowOf(id)).execution_error).toContain("principal_unresolvable");
    expect(hubCalls).toHaveLength(0);
  });

  // ── (f) retry policy read at EXECUTION time ─────────────────────────────────────────────────────

  async function setAutoRetryCount(n: number | null): Promise<void> {
    await withTenants([co], (c) =>
      n === null
        ? c.query(`UPDATE companies SET settings = settings - 'automation' WHERE id = $1`, [co])
        : c.query(
            `UPDATE companies SET settings = jsonb_set(settings, '{automation}', jsonb_build_object('approvalRetry', jsonb_build_object('autoRetryCount', $2::int)), true) WHERE id = $1`,
            [co, n],
          ),
    );
  }

  it("(f) autoRetryCount is read fresh on every execution — changing companies.settings changes behaviour with no restart", async () => {
    // Default (absent setting) => 0 => exactly one attempt.
    await setAutoRetryCount(null);
    hubReplies = [{ kind: "http", status: 503 }];
    const once = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-retry-0" } });
    await executeApprovedAutomationWrite(co, once);
    expect(hubCalls).toHaveLength(1);
    expect((await rowOf(once)).execution_attempts).toBe(1);

    // Same process, no restart: 2 retries => 3 attempts.
    await setAutoRetryCount(2);
    installHubStub();
    hubReplies = [{ kind: "http", status: 503 }];
    const thrice = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-retry-2" } });
    await executeApprovedAutomationWrite(co, thrice);
    expect(hubCalls).toHaveLength(3);
    const row = await rowOf(thrice);
    expect(row.execution_attempts).toBe(3);
    expect(row.execution_status).toBe("failed");

    // A retry that SUCCEEDS lands `executed` after exactly two calls.
    installHubStub();
    hubReplies = [{ kind: "http", status: 503 }, { kind: "ok", text: "deployed on retry" }];
    const recovered = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-retry-ok" } });
    await executeApprovedAutomationWrite(co, recovered);
    expect(hubCalls).toHaveLength(2);
    expect((await rowOf(recovered)).execution_status).toBe("executed");
    expect((await rowOf(recovered)).execution_attempts).toBe(2);

    // The clamp: a value above the ceiling cannot turn one approval into an unbounded call storm.
    await setAutoRetryCount(99);
    installHubStub();
    hubReplies = [{ kind: "http", status: 503 }];
    const clamped = await fileDecided({ toolName: "test.exec-ok", args: { runId: "run-retry-clamp" } });
    await executeApprovedAutomationWrite(co, clamped);
    expect(hubCalls).toHaveLength(4); // 1 + MAX_AUTO_RETRY_COUNT
    await setAutoRetryCount(null);
  });

  it("a retry re-earns the right: if the precondition went stale after the first attempt, the retry is REFUSED (no double-apply)", async () => {
    await setAutoRetryCount(2);
    try {
      // First attempt: precondition passes, hub call is lost (transport) — the call may actually have
      // landed. Second: precondition now refuses, so we must NOT re-send.
      flakyVerdicts = [{ ok: true }, { ok: false, reason: "stage_already_deployed" }];
      hubReplies = [{ kind: "throw", message: "socket hang up" }];
      const id = await fileDecided({ toolName: "test.exec-flaky" });
      const out = await executeApprovedAutomationWrite(co, id);
      expect(hubCalls).toHaveLength(1);
      expect(out.status).toBe("failed");
      const row = await rowOf(id);
      expect(row.execution_error).toContain("precondition_failed: stage_already_deployed");
      // The original failure is preserved alongside the refusal — half the story is not enough.
      expect(row.execution_error).toContain("after hub_unreachable");
      expect(row.execution_attempts).toBe(1);
    } finally {
      await setAutoRetryCount(null);
    }
  });
});
