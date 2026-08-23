// SMM-35 — `social.createReplyDraft`: the D14 registry entry for the assistant's first social write
// proposal, closing this ticket's remaining half (a "social summary" read landed a pass ago; this
// entry is what makes ONE social write reachable from `/assistant`, through the SAME
// propose -> confirm -> approve -> D14 chain ASST-23 already built). Shape mirrors
// `d14-smm-17-social-reply-registry.test.ts` deliberately — no Nest app, no Cerbos: the registry and
// `executeApprovedAutomationWrite` are plain functions over Postgres + a stubbed `fetch`. The HTTP
// surface (`social.controller.ts#createReplyDraft`, its `assign` Cerbos action) is a separate,
// pre-existing file (SMM-17) and is not duplicated here.
//
// What this file proves:
//   (A) doctrine      — the entry is real (not the D14-02 name-only fallback), `neverAutoRetry: true`.
//   (B) lockKey       — a pure function of the THREAD id (there is no message id yet at create time).
//   (C) precondition  — thread missing / soft-deleted / empty-body refusals, and (C0) the
//                        module-GUC regression: calling the precondition on a transaction with NO
//                        `{modules:['social']}` option still gets the REAL, correct verdict, because
//                        the precondition self-declares its own scope.
//   (D) executor      — a real approved-and-decided row DOES call the hub exactly once with the
//                        exact tool name (the RLS proof too — this only works if the executor's own
//                        transaction can see the row); a missing thread ends `failed` with
//                        `precondition_failed:reply_thread_not_found`, hub called ZERO times; a
//                        redelivered/already-executed row is a no-op (single-use); an ambiguous hub
//                        failure never auto-retries, even with tenant auto-retry configured on.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  resetExecutableApprovals, registerCoreExecutableApprovals, registerSocialExecutableApprovals,
  registerSocialReplyExecutableApprovals, registerSocialReplyDraftExecutableApproval, getExecutable,
  registerExecutableApproval,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";

const MODULES: { modules: string[] } = { modules: ["social"] };
const TOOL = "social.createReplyDraft";

let seq = 0;
const uniq = (label: string): string => `smm35-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-35 registry: social.createReplyDraft", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let orgId: string;
  let accountId: string;

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = "smm-35-test-secret-not-a-real-one";
    config.services.hub = { url: "http://hub.smm35.test", token: "hub-token", assuranceToken: "" };
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerSocialExecutableApprovals();
    registerSocialReplyExecutableApprovals();
    registerSocialReplyDraftExecutableApproval();

    co = await createCompany("SMM-35 Social Reply Draft Co", ["social"]);
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;

    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    orgId = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
           VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
          [orgId, co, clientId, uniq("org")],
        ),
      MODULES,
    );
    accountId = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO social_accounts
             (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
           VALUES ($1,$2,$3,$4,'linkedin',$5,$6,'connected','{}','central')`,
          [accountId, co, clientId, orgId, uniq("@brand"), uniq("integration")],
        ),
      MODULES,
    );
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  async function makeThread(opts: { deleted?: boolean } = {}): Promise<string> {
    const threadId = newId();
    await withTenants(
      [co],
      (c) =>
        c.query(
          `INSERT INTO social_inbox_threads
             (id, tenant_id, account_id, network, kind, external_thread_id, status, last_message_at, origin_site, deleted_at)
           VALUES ($1,$2,$3,'linkedin','comment',$4,'open',now(),'central',$5)`,
          [threadId, co, accountId, uniq("thread"), opts.deleted ? new Date() : null],
        ),
      MODULES,
    );
    return threadId;
  }

  // Deliberately WITHOUT `{modules:['social']}` — this IS (C0), the module-GUC regression: if the
  // precondition ever stopped self-declaring its own scope, every read below would return zero rows
  // and every verdict would be a false `reply_thread_not_found`, even for a thread that exists.
  function runPrecondition(args: Record<string, unknown>) {
    return withTenants([co], (c) => getExecutable(TOOL)!.precondition(c, args));
  }

  // ══ (A) registry doctrine ═══════════════════════════════════════════════════════════════════

  it("(A1) social.createReplyDraft is registered with a REAL lockKey and precondition — not the D14-02 name-only fallback", () => {
    const entry = getExecutable(TOOL);
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe(TOOL);
    expect(entry!.lockKey({})).not.toBe(`executable-approval:${TOOL}`);
    expect(entry!.neverAutoRetry).toBe(true);
  });

  it("(A2) is not idempotent-by-overwrite: a second registration throws and the live entry survives", () => {
    expect(() => registerExecutableApproval({ toolName: TOOL })).toThrow(/already registered/i);
    expect(getExecutable(TOOL)!.neverAutoRetry).toBe(true);
  });

  // ══ (B) lockKey ═════════════════════════════════════════════════════════════════════════════

  it("(B1) lockKey is the threadId, a pure function of toolArgs", () => {
    const entry = getExecutable(TOOL)!;
    const id = newId();
    expect(entry.lockKey({ threadId: id })).toBe(`social.createReplyDraft:${id}`);
    expect(entry.lockKey({ threadId: id })).toBe(entry.lockKey({ threadId: id }));
  });

  it("(B2) a missing/malformed threadId falls back to a tool-prefixed key, distinct from any real call", () => {
    const entry = getExecutable(TOOL)!;
    const k1 = entry.lockKey({});
    const k2 = entry.lockKey({ threadId: newId() });
    expect(k1).not.toBe(k2);
    expect(k1).toContain(TOOL);
  });

  // ══ (C) the precondition, direct ════════════════════════════════════════════════════════════

  it("(C0) ⭐ THE MODULE-GUC REGRESSION: a real thread is still found under a modules-less transaction, because the precondition self-declares its own scope", async () => {
    const threadId = await makeThread();
    const verdict = await runPrecondition({ threadId, body: "Thanks for reaching out!" });
    expect(verdict).toEqual({ ok: true });
  });

  it("(C1) reply_thread_missing when threadId is absent/malformed", async () => {
    expect(await runPrecondition({ body: "hi" })).toMatchObject({ ok: false, reason: "reply_thread_missing" });
    expect(await runPrecondition({ threadId: "  ", body: "hi" })).toMatchObject({ ok: false, reason: "reply_thread_missing" });
  });

  it("(C2) empty_body when body is absent, empty, or whitespace-only", async () => {
    const threadId = await makeThread();
    expect(await runPrecondition({ threadId })).toMatchObject({ ok: false, reason: "empty_body" });
    expect(await runPrecondition({ threadId, body: "" })).toMatchObject({ ok: false, reason: "empty_body" });
    expect(await runPrecondition({ threadId, body: "   " })).toMatchObject({ ok: false, reason: "empty_body" });
  });

  it("(C3) reply_thread_not_found for a nonexistent thread", async () => {
    const verdict = await runPrecondition({ threadId: newId(), body: "hi" });
    expect(verdict).toMatchObject({ ok: false, reason: "reply_thread_not_found" });
  });

  it("(C4) reply_thread_not_found for a soft-deleted thread — a create must not resurrect a deleted thread's conversation", async () => {
    const threadId = await makeThread({ deleted: true });
    const verdict = await runPrecondition({ threadId, body: "hi" });
    expect(verdict).toMatchObject({ ok: false, reason: "reply_thread_not_found" });
  });

  it("(C5) ⭐ THE POSITIVE CONTROL: a healthy thread + a real body passes every check", async () => {
    const threadId = await makeThread();
    expect(await runPrecondition({ threadId, body: "Thanks for reaching out!" })).toEqual({ ok: true });
  });

  // ══ (D) through the REAL executor ═══════════════════════════════════════════════════════════

  describe("through the executor (executeApprovedAutomationWrite)", () => {
    let hubCalls: Array<{ url: string; tool: string }> = [];
    const realFetch = globalThis.fetch;

    function installHubStub(fail = false): void {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.smm35.test")) return realFetch(url as any, init);
        const tool = JSON.parse(String(init?.body ?? "{}"))?.params?.name ?? "";
        hubCalls.push({ url: String(url), tool });
        if (fail) throw new Error("connection reset");
        return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {}\n\n" };
      });
      vi.stubGlobal("fetch", stub as unknown as typeof fetch);
    }

    beforeEach(() => installHubStub());
    afterEach(() => vi.restoreAllMocks());

    async function fileDecided(toolArgs: Record<string, unknown>): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main','pending')`,
          [id, co, TOOL, JSON.stringify(toolArgs), wfUser],
        ),
      );
      return id;
    }

    it("(D1) a nonexistent thread ends failed with precondition_failed:reply_thread_not_found, hub called ZERO times", async () => {
      const id = await fileDecided({ threadId: newId(), body: "hi" });
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: "precondition_failed: reply_thread_not_found" });
      expect(hubCalls).toHaveLength(0);
    });

    it("(D2) ⭐ THE POSITIVE CONTROL, and the RLS proof: a healthy proposal DOES call the hub exactly once", async () => {
      const threadId = await makeThread();
      const id = await fileDecided({ threadId, body: "Thanks for reaching out!" });
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
      expect(hubCalls[0].tool).toBe(TOOL);
    });

    it("(D3) SINGLE USE: a redelivered/already-executed row is a no-op, hub called ZERO more times", async () => {
      const threadId = await makeThread();
      const id = await fileDecided({ threadId, body: "Thanks for reaching out!" });
      expect(await executeApprovedAutomationWrite(co, id)).toMatchObject({ status: "executed" });
      expect(hubCalls).toHaveLength(1);
      expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);
    });

    it("(D4) an ambiguous hub failure never auto-retries — ends failed after exactly ONE hub call, even with tenant auto-retry configured on", async () => {
      installHubStub(true);
      await withTenants([co], (c) =>
        c.query(
          `UPDATE companies SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{automation,approvalRetry,autoRetryCount}', '3')
             WHERE id = $1`,
          [co],
        ));
      const threadId = await makeThread();
      const id = await fileDecided({ threadId, body: "Thanks for reaching out!" });
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("failed");
      expect(hubCalls).toHaveLength(1);
    });
  });
});
