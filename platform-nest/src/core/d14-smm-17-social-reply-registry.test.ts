// SMM-17 — `social.sendReply`: the D14 registry entry for the reply gate, built by REUSING SMM-09's
// pattern (see `modules/social/reply-precondition.ts`'s header). Shape mirrors
// `d14-smm-09-social-publish-registry.test.ts` deliberately — no Nest app, no Cerbos: the registry
// and `executeApprovedAutomationWrite` are plain functions over Postgres + a stubbed `fetch`. The
// HTTP surface (`social.controller.ts`'s reply endpoints, the `message`-vs-`error` filter contract,
// the assign-vs-reply Cerbos split) is a SEPARATE file and is not duplicated here.
//
// What this file proves:
//   (A) doctrine   — the entry is real (not the D14-02 name-only fallback), `neverAutoRetry: true`.
//   (B) lockKey    — a pure function of the MESSAGE id that fails closed on malformed input without
//                    collapsing every bad call onto one shared lock.
//   (C) chain      — all four stages, called DIRECTLY under a live transaction (including the
//                    module-GUC regression, by construction — see (C0)), in the pinned order.
//   (D) executor   — a stale precondition driven through the REAL executor lands `failed` with
//                    `precondition_failed:*`, and the hub is ASSERTED (not inferred) called zero times.
//   (E) edit       — editing a draft invalidates its approval, because the hash moves.
//   (F) replay     — a consumed grant cannot execute twice, by two independent mechanisms.
//   (G) no retry   — an AMBIGUOUS failure is never auto-retried, even with tenant auto-retry on.
//   (H) retention  — THIS TICKET'S OWN NAMED DESIGN QUESTION: an approved-but-unsent reply whose
//                    thread has had its activity content purged refuses `source_content_purged`,
//                    hub called zero times.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import {
  resetExecutableApprovals, registerCoreExecutableApprovals, registerSocialExecutableApprovals,
  registerSocialReplyExecutableApprovals, getExecutable, registerExecutableApproval,
} from "./approval-executables";
import { executeApprovedAutomationWrite } from "./approval-execute";
import { replyDispatchArgs, replyArgsSha256 } from "../modules/social/canonical-args";
import {
  REPLY_REFUSAL, REPLY_REFUSAL_STAGE, REPLY_PRECONDITION_STAGES,
  SOCIAL_REPLY_TOOL, SOCIAL_REPLY_TOOL_CLASSIFICATION, evaluateReplyPrecondition,
} from "../modules/social/reply-precondition";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm17-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-17 registry: social.sendReply", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let orgId: string;
  let accountId: string;
  let engagementId: string;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    config.approvalGrantSecret = "smm-17-test-secret-not-a-real-one";
    config.services.hub = { url: "http://hub.smm17.test", token: "hub-token", assuranceToken: "" };
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "linkedin"])];
    resetExecutableApprovals();
    registerCoreExecutableApprovals();
    registerSocialExecutableApprovals();
    registerSocialReplyExecutableApprovals();

    co = await createCompany("SMM-17 Social Reply Co", ["social"]);
    await seedAutomationAccounts(co);
    const wf = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM identity_links WHERE provider = 'n8n' AND external_id = 'wf:delivery'`,
    );
    wfUser = wf.rows[0].user_id;

    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    orgId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId, co, clientId, uniq("org")]), MODULES);
    accountId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'linkedin',$5,$6,'connected','{}','central')`,
        [accountId, co, clientId, orgId, uniq("@brand"), uniq("integration")]), MODULES);
    engagementId = await makeEngagement();
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    await teardownTestDb();
  });

  async function makeEngagement(opts: { networks?: Record<string, boolean>; reply?: boolean; status?: string } = {}): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'SMM-17 engagement',$4,$5,10,'central')`,
        [id, co, clientId, opts.status ?? "active",
          JSON.stringify({ networks: opts.networks ?? { linkedin: true }, inbox: { reply: opts.reply ?? true } })],
      ), MODULES);
    return id;
  }

  interface ReplyFixture { messageId: string; threadId: string; args: Record<string, unknown> }

  async function makeReply(opts: {
    body?: string; status?: string; purged?: boolean; corruptStoredHash?: boolean;
  } = {}): Promise<ReplyFixture> {
    const threadId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_inbox_threads
           (id, tenant_id, account_id, network, kind, external_thread_id, status, last_message_at, origin_site,
            activity_content_purged_at)
         VALUES ($1,$2,$3,'linkedin','comment',$4,'open',now(),'central',$5)`,
        [threadId, co, accountId, uniq("thread"), opts.purged ? new Date() : null],
      ), MODULES);
    const messageId = newId();
    const body = opts.body ?? "Thanks for the kind words!";
    const hash = opts.corruptStoredHash
      ? replyArgsSha256({ tenantId: co, id: messageId, threadId, accountId, body: `${body} (edited elsewhere)` })
      : replyArgsSha256({ tenantId: co, id: messageId, threadId, accountId, body });
    // 0105's `sim_sent_reply_has_approval` CHECK requires a 'sent' outbound row to carry BOTH
    // `approval_id` (a REAL FK, not a bare uuid — `social_inbox_messages_approval_id_fkey`) and
    // `args_sha256` — a fixture reaching `sent` needs a real, spent `automation_approvals` row
    // behind it, the same as any real send would leave.
    const status = opts.status ?? "approved";
    let approvalIdForSent: string | null = null;
    if (status === "sent") {
      approvalIdForSent = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO automation_approvals
             (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
              origin, origin_site, execution_status)
           VALUES ($1,$2,'wf:delivery','social.sendReply','{}','high','approved',$3,$3,now(),'automation','central','executed')`,
          [approvalIdForSent, co, wfUser],
        ));
    }
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_inbox_messages
           (id, tenant_id, thread_id, direction, body, status, source, args_sha256, approval_id, origin_site)
         VALUES ($1,$2,$3,'out',$4,$5,'reply',$6,$7,'central')`,
        [messageId, co, threadId, body, status, hash, approvalIdForSent],
      ), MODULES);
    const args = replyDispatchArgs({ tenantId: co, id: messageId, threadId, accountId, body });
    return { messageId, threadId, args: args as unknown as Record<string, unknown> };
  }

  function runPrecondition(args: Record<string, unknown>) {
    // Deliberately WITHOUT `{modules:['social']}` — mirrors the executor's own module-less
    // transaction. This is (C0), the module-GUC regression: if `evaluateReplyPrecondition` ever
    // stopped declaring its own scope, every read below would return zero rows and every verdict
    // would be a false `message_not_found`.
    return withTenants([co], (c) => evaluateReplyPrecondition(c, args));
  }

  // ══ (A) registry doctrine ═══════════════════════════════════════════════════════════════════

  it("(A1) social.sendReply is registered with a REAL lockKey and precondition — not the D14-02 name-only fallback", () => {
    const entry = getExecutable(SOCIAL_REPLY_TOOL);
    expect(entry).toBeDefined();
    expect(entry!.toolName).toBe(SOCIAL_REPLY_TOOL);
    expect(entry!.lockKey({})).not.toBe(`executable-approval:${SOCIAL_REPLY_TOOL}`);
    expect(entry!.neverAutoRetry).toBe(true);
  });

  it("(A2) is not idempotent-by-overwrite: a second registration throws and the live entry survives", () => {
    expect(() => registerExecutableApproval({ toolName: SOCIAL_REPLY_TOOL })).toThrow(/already registered/i);
    expect(getExecutable(SOCIAL_REPLY_TOOL)!.neverAutoRetry).toBe(true);
  });

  it("(A3) the hub-side classification is SPREAD from publish's, never retyped: write + impact 'high'", () => {
    expect(SOCIAL_REPLY_TOOL_CLASSIFICATION).toEqual({ write: true, impact: "high" });
  });

  // ══ (B) lockKey ═════════════════════════════════════════════════════════════════════════════

  it("(B1) lockKey is the messageId, a pure function of toolArgs", () => {
    const entry = getExecutable(SOCIAL_REPLY_TOOL)!;
    const id = newId();
    expect(entry.lockKey({ messageId: id })).toBe(id);
    expect(entry.lockKey({ messageId: id })).toBe(entry.lockKey({ messageId: id }));
  });

  it("(B2) a missing/malformed messageId falls back to a tool-prefixed key over the raw args, never one shared constant", () => {
    const entry = getExecutable(SOCIAL_REPLY_TOOL)!;
    const k1 = entry.lockKey({});
    const k2 = entry.lockKey({ messageId: 123 });
    expect(k1).not.toBe(k2);
    expect(k1).toContain(SOCIAL_REPLY_TOOL);
  });

  // ══ (C) the chain, direct ═══════════════════════════════════════════════════════════════════

  it("(C1) scope: message_not_found for a nonexistent id", async () => {
    const verdict = await runPrecondition({ tenantId: co, messageId: newId(), threadId: newId(), accountId, body: "x" });
    expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: REPLY_REFUSAL.messageNotFound });
  });

  it("(C2) scope: network_not_in_scope when the engagement's tool_scope.networks omits the network", async () => {
    const eng = await makeEngagement({ networks: { instagram: true } });
    const r = await makeReply();
    // Point the resolvable engagement at one with the WRONG network scope by making it the ONLY
    // active engagement for this client (most-recently-created wins, per this file's own resolution).
    await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='closed' WHERE tenant_id=$1 AND id<>$2`, [co, eng]), MODULES);
    try {
      const verdict = await runPrecondition(r.args);
      expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: REPLY_REFUSAL.networkNotInScope });
    } finally {
      // Restore: close the temporary engagement (never leave it active for a later test to
      // accidentally resolve as "most recently created") and reopen the shared default.
      await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='closed' WHERE tenant_id=$1 AND id=$2`, [co, eng]), MODULES);
      await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='active' WHERE tenant_id=$1 AND id=$2`, [co, engagementId]), MODULES);
    }
  });

  it("(C3) scope: reply_not_in_scope when the engagement's tool_scope.inbox.reply is not true", async () => {
    const eng = await makeEngagement({ reply: false });
    const r = await makeReply();
    await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='closed' WHERE tenant_id=$1 AND id<>$2`, [co, eng]), MODULES);
    try {
      const verdict = await runPrecondition(r.args);
      expect(verdict).toMatchObject({ ok: false, stage: "scope", reason: REPLY_REFUSAL.replyNotInScope });
    } finally {
      await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='closed' WHERE tenant_id=$1 AND id=$2`, [co, eng]), MODULES);
      await withTenants([co], (c) => c.query(`UPDATE social_engagements SET status='active' WHERE tenant_id=$1 AND id=$2`, [co, engagementId]), MODULES);
    }
  });

  it("(C4) hash: args_hash_mismatch when the stored anchor disagrees with the live content", async () => {
    const r = await makeReply({ corruptStoredHash: true });
    const verdict = await runPrecondition(r.args);
    expect(verdict).toMatchObject({ ok: false, stage: "hash", reason: REPLY_REFUSAL.argsHashMismatch });
  });

  it("(C5) unconsumed: message_not_approved for a draft", async () => {
    const r = await makeReply({ status: "draft" });
    const verdict = await runPrecondition(r.args);
    expect(verdict).toMatchObject({ ok: false, stage: "unconsumed", reason: REPLY_REFUSAL.messageNotApproved });
  });

  it("(C6) unconsumed: already_sent for a message that already reached 'sent'", async () => {
    const r = await makeReply({ status: "sent" });
    await withTenants([co], (c) => c.query(`UPDATE social_inbox_messages SET external_id=$2 WHERE id=$1`, [r.messageId, "upstream-1"]), MODULES);
    const verdict = await runPrecondition(r.args);
    expect(verdict).toMatchObject({ ok: false, stage: "unconsumed", reason: REPLY_REFUSAL.alreadySent });
  });

  it("(C7) unconsumed: approval_already_consumed when a grant is already spent but not yet sent", async () => {
    const r = await makeReply();
    const approvalId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, origin, origin_site)
         VALUES ($1,$2,'wf:delivery','social.sendReply','{}','high','approved',$3,'automation','central')`,
        [approvalId, co, wfUser]));
    await withTenants([co], (c) => c.query(`UPDATE social_inbox_messages SET approval_id=$2 WHERE id=$1`, [r.messageId, approvalId]), MODULES);
    const verdict = await runPrecondition(r.args);
    expect(verdict).toMatchObject({ ok: false, stage: "unconsumed", reason: REPLY_REFUSAL.approvalAlreadyConsumed });
  });

  it("(C8) ⭐ retention: source_content_purged when the thread's activity content has been purged since approval — THE TICKET'S OWN NAMED QUESTION", async () => {
    const r = await makeReply({ purged: true });
    const verdict = await runPrecondition(r.args);
    expect(verdict).toMatchObject({ ok: false, stage: "retention", reason: REPLY_REFUSAL.sourceContentPurged });
  });

  it("(C9) ⭐ THE POSITIVE CONTROL: a healthy approved reply passes every stage", async () => {
    const r = await makeReply();
    const verdict = await runPrecondition(r.args);
    expect(verdict).toEqual({ ok: true });
  });

  it("(C10) every reason maps to exactly one of the four pinned stages, and the map is exhaustive", () => {
    const reasons = Object.values(REPLY_REFUSAL);
    for (const reason of reasons) {
      expect(REPLY_PRECONDITION_STAGES).toContain(REPLY_REFUSAL_STAGE[reason]);
    }
  });

  // ══ (D)–(H) through the REAL executor ═══════════════════════════════════════════════════════

  describe("through the executor (executeApprovedAutomationWrite)", () => {
    let hubCalls: Array<{ url: string; tool: string }> = [];
    const realFetch = globalThis.fetch;

    function installHubStub(fail = false): void {
      hubCalls = [];
      const stub = vi.fn(async (url: string, init: any) => {
        if (!String(url).startsWith("http://hub.smm17.test")) return realFetch(url as any, init);
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
          [id, co, SOCIAL_REPLY_TOOL, JSON.stringify(toolArgs), wfUser],
        ),
      );
      return id;
    }

    it("(D1) a stale precondition (draft, not approved) ends failed with precondition_failed:message_not_approved, hub called ZERO times", async () => {
      const r = await makeReply({ status: "draft" });
      const id = await fileDecided(r.args);
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${REPLY_REFUSAL.messageNotApproved}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(D2) ⭐ retention through the executor: a purged thread's approved reply ends failed with precondition_failed:source_content_purged, hub called ZERO times", async () => {
      const r = await makeReply({ purged: true });
      const id = await fileDecided(r.args);
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${REPLY_REFUSAL.sourceContentPurged}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(D3) ⭐ THE POSITIVE CONTROL, and the RLS proof: a healthy approved reply DOES call the hub exactly once", async () => {
      const r = await makeReply();
      const id = await fileDecided(r.args);
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
      expect(hubCalls[0].tool).toBe(SOCIAL_REPLY_TOOL);
    });

    it("(E1) ⭐ EDITING THE DRAFT INVALIDATES ITS APPROVAL: the hash moves, so the approved reply refuses and the hub is called ZERO times", async () => {
      const r = await makeReply();
      const id = await fileDecided(r.args);
      const editedBody = "a reply nobody approved";
      await withTenants([co], (c) =>
        c.query(
          `UPDATE social_inbox_messages
              SET body = $2, args_sha256 = $3, approval_id = NULL,
                  status = CASE WHEN status IN ('in_review','approved','failed') THEN 'draft' ELSE status END,
                  updated_at = now()
            WHERE id = $1`,
          [r.messageId, editedBody, replyArgsSha256({ tenantId: co, id: r.messageId, threadId: r.threadId, accountId, body: editedBody })],
        ), MODULES);
      const outcome = await executeApprovedAutomationWrite(co, id);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${REPLY_REFUSAL.argsHashMismatch}` });
      expect(hubCalls).toHaveLength(0);
    });

    it("(F1) ⭐ REPLAY REFUSED (approval side): the same approval executed twice calls the hub exactly ONCE", async () => {
      const r = await makeReply();
      const id = await fileDecided(r.args);
      expect(await executeApprovedAutomationWrite(co, id)).toMatchObject({ status: "executed" });
      expect(hubCalls).toHaveLength(1);
      expect(await executeApprovedAutomationWrite(co, id)).toEqual({ status: "skipped", reason: "not_pending" });
      expect(hubCalls).toHaveLength(1);
    });

    it("(F2) ⭐ REPLAY REFUSED (domain side): a SECOND approval filed for a message that already spent one refuses, hub called ZERO times", async () => {
      // `executeApprovedAutomationWrite`'s "executed" here means the OUTBOUND leg (executor -> hub)
      // succeeded against this file's stubbed fetch — the hub's own callback INTO platform-nest's
      // reply-send endpoint (reply-dispatch.ts's real transactional stamp) is a separate HTTP hop
      // this stubbed-hub unit test never exercises (mirrors the publish registry test's own (F2)).
      // So the stamp that a real send would leave is simulated explicitly, the same way SMM-10's
      // dispatch stamps `approval_id` + `external_id` together in ONE statement.
      const r = await makeReply();
      const first = await fileDecided(r.args);
      expect(await executeApprovedAutomationWrite(co, first)).toMatchObject({ status: "executed" });
      expect(hubCalls).toHaveLength(1);
      await withTenants([co], (c) =>
        c.query(
          `UPDATE social_inbox_messages SET approval_id = $2, external_id = $3, status = 'sent' WHERE id = $1`,
          [r.messageId, first, `upstream-${r.messageId.slice(0, 8)}`]), MODULES);

      const second = await fileDecided(r.args);
      const outcome = await executeApprovedAutomationWrite(co, second);
      expect(outcome).toMatchObject({ status: "failed", error: `precondition_failed: ${REPLY_REFUSAL.alreadySent}` });
      expect(hubCalls).toHaveLength(1);
    });

    describe("(G) an AMBIGUOUS failure is never auto-retried", () => {
      beforeEach(async () => {
        installHubStub(true);
        // The tenant has deliberately turned auto-retry ON, at the maximum the platform allows.
        await withTenants([co], (c) =>
          c.query(
            `UPDATE companies
                SET settings = jsonb_set(jsonb_set(coalesce(settings,'{}'::jsonb), '{automation}',
                      coalesce(settings->'automation','{}'::jsonb), true),
                      '{automation,approvalRetry}', '{"autoRetryCount": 3}'::jsonb, true)
              WHERE id = $1`, [co]));
      });
      afterEach(async () => {
        await withTenants([co], (c) =>
          c.query(`UPDATE companies SET settings = settings - 'automation' WHERE id = $1`, [co]));
      });

      it("(G1) ⭐ a reply whose outcome is UNKNOWN is tried exactly ONCE and surfaces for a human — even with autoRetryCount=3", async () => {
        // The reply may ALREADY be visible on the client's thread. An unattended second attempt is a
        // coin-flip on a duplicate public reply, and the platform cannot observe which way it landed
        // — so it stops, records the ambiguity, and notifies. D14-07's retry endpoint (a HUMAN
        // decision, re-taking the lock and re-running this precondition) is the only way forward.
        const r = await makeReply();
        const id = await fileDecided(r.args);
        const outcome = await executeApprovedAutomationWrite(co, id);
        expect(outcome.status).toBe("failed");
        expect(outcome).toMatchObject({ error: expect.stringContaining("hub_unreachable") });
        expect(hubCalls.filter((h) => h.tool === SOCIAL_REPLY_TOOL)).toHaveLength(1);
        const row = await adminPool().query(`SELECT execution_status, execution_attempts FROM automation_approvals WHERE id = $1`, [id]);
        expect(row.rows[0].execution_status).toBe("failed");
        expect(row.rows[0].execution_attempts).toBe(1);
      });
    });
  });
});
