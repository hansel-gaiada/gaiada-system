// SMM-17 — `reply-dispatch.ts` against a live Postgres + a mock publisher driver. No Nest app, no
// hub, no Cerbos: this file proves the DOMAIN function's own contract (the transactional stamp, the
// module-GUC regression, replay/double-send safety, the unsupported-vs-failed distinction), exactly
// the split `dispatch.test.ts` established for SMM-10, applied to a reply instead of a publish.
// The HTTP wrapper (`social.controller.ts#sendReply`) is a thin authz+shape wrapper over this
// function and is not re-tested here.
//
// ── ⚠ THE MODULE-GUC REGRESSION, PROVEN BY CONSTRUCTION ─────────────────────────────────────────────
// `reply-dispatch.ts` never opens a `withTenants(..., {modules:['social']})` transaction — every one
// of its transactions relies on `declareSocialModuleScope` being called explicitly (mirroring the
// D14 executor's own module-less transaction). So EVERY test below that reaches a real row through
// `dispatchApprovedReply` is already the regression test: remove that call and (T1) fails with
// `message_not_found` instead of sending, because 0105's third RLS wall would make the query return
// zero rows, silently.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { seedAutomationAccounts } from "../../seed/automation";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SocialPublisherError } from "./publisher/types";
import { replyDispatchArgs, replyArgsSha256 } from "./canonical-args";
import { SOCIAL_REPLY_TOOL } from "./reply-precondition";
import { dispatchApprovedReply, REPLY_DISPATCH_REFUSAL } from "./reply-dispatch";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm17-dispatch-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-17 · dispatchApprovedReply — the transactional stamp", () => {
  let co: string;
  let wfUser: string;
  let clientId: string;
  let orgId: string;
  let accountId: string;
  let threadId: string;
  let state: MockPublisherState;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "linkedin"])];
    config.social.publisher.defaultOrgApiKey = "test-org-key";

    co = await createCompany("SMM-17 Reply Dispatch Co", ["social"]);
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
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'reply engagement','active',$4,10,'central')`,
        [newId(), co, clientId, JSON.stringify({ networks: { linkedin: true }, inbox: { reply: true } })]), MODULES);
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
  });

  async function makeThread(purged = false): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_inbox_threads
           (id, tenant_id, account_id, network, kind, external_thread_id, status, last_message_at, origin_site,
            activity_content_purged_at)
         VALUES ($1,$2,$3,'linkedin','comment',$4,'open',now(),'central',$5)`,
        [id, co, accountId, uniq("thread"), purged ? new Date() : null],
      ), MODULES);
    return id;
  }

  async function makeApprovedReply(tid: string, body = "Thanks for the comment!"): Promise<string> {
    const id = newId();
    const hash = replyArgsSha256({ tenantId: co, id, threadId: tid, accountId, body });
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_inbox_messages (id, tenant_id, thread_id, direction, body, status, source, args_sha256, origin_site)
         VALUES ($1,$2,$3,'out',$4,'approved','reply',$5,'central')`,
        [id, co, tid, body, hash]), MODULES);
    return id;
  }

  /** File the `automation_approvals` row in the state `resolveExecutingApprovalId` looks for. */
  async function fileExecutingApproval(messageId: string, threadId: string, body: string): Promise<string> {
    const id = newId();
    const args = replyDispatchArgs({ tenantId: co, id: messageId, threadId, accountId, body });
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main','executing')`,
        [id, co, SOCIAL_REPLY_TOOL, JSON.stringify(args), wfUser],
      ),
    );
    return id;
  }

  async function messageRow(id: string) {
    const { rows } = await withTenants([co], (c) =>
      c.query(
        `SELECT status, approval_id AS "approvalId", external_id AS "externalId", last_error AS "lastError"
           FROM social_inbox_messages WHERE id = $1`,
        [id],
      ), MODULES);
    return rows[0];
  }

  async function outboxEvents(messageId: string): Promise<Array<{ event_type: string }>> {
    const { rows } = await adminPool().query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 ORDER BY created_at`,
      [messageId],
    );
    return rows;
  }

  it("(T1) ⭐ THE HAPPY PATH: a supported driver sends, and the SAME statement stamps approval_id + external_id + status='sent'", async () => {
    registerPublisher(createMockPublisher(state, { withInbox: true }));
    const threadId = await makeThread();
    const messageId = await makeApprovedReply(threadId, "Glad you liked it!");
    const approvalId = await fileExecutingApproval(messageId, threadId, "Glad you liked it!");

    const verdict = await dispatchApprovedReply(co, messageId, wfUser);

    expect(verdict).toMatchObject({ ok: true, network: "linkedin" });
    expect(verdict.ok && verdict.externalId).toBeTruthy();
    const row = await messageRow(messageId);
    expect(row.status).toBe("sent");
    expect(row.approvalId).toBe(approvalId);
    expect(row.externalId).toBeTruthy();
    expect(state.calls.some((c) => c.op === "sendReply")).toBe(true);
    expect(await outboxEvents(messageId)).toEqual([{ event_type: "social.post.dispatched" }]);
  });

  it("(T2) ⭐ UNSUPPORTED vs FAILED: a driver with no inbox_reply capability refuses capability_unsupported — BEFORE any call, and the approval is STILL consumed", async () => {
    registerPublisher(createMockPublisher(state)); // no withInbox: sendReply/inbox_reply absent
    const threadId = await makeThread();
    const messageId = await makeApprovedReply(threadId);
    await fileExecutingApproval(messageId, threadId, "Thanks for the comment!");

    const verdict = await dispatchApprovedReply(co, messageId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: REPLY_DISPATCH_REFUSAL.capabilityUnsupported });
    const row = await messageRow(messageId);
    // Consumed, not landed — 0105's own state law (mirrors dispatch.ts's "on failure, the approval
    // is still consumed" for the SAME `neverAutoRetry` reason).
    expect(row.status).toBe("failed");
    expect(row.approvalId).toBeTruthy();
    expect(row.externalId).toBeNull();
    expect(state.calls.some((c) => c.op === "sendReply")).toBe(false);
  });

  it("(T3) a driver whose sendReply throws ends failed with reply_send_failed, and the approval is still consumed", async () => {
    registerPublisher(createMockPublisher(state, { withInbox: true }));
    state.failWith = new SocialPublisherError("publisher_http_error", "mock refused the reply");
    const threadId = await makeThread();
    const messageId = await makeApprovedReply(threadId);
    await fileExecutingApproval(messageId, threadId, "Thanks for the comment!");

    const verdict = await dispatchApprovedReply(co, messageId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: REPLY_DISPATCH_REFUSAL.sendFailed });
    const row = await messageRow(messageId);
    expect(row.status).toBe("failed");
    expect(row.approvalId).toBeTruthy();
    expect(row.lastError).toContain("publisher_http_error");
    expect(await outboxEvents(messageId)).toEqual([{ event_type: "social.post.failed" }]);
  });

  it("(T4) approval_not_resolvable: no 'executing' row names this message, no network call is ever attempted", async () => {
    registerPublisher(createMockPublisher(state, { withInbox: true }));
    const threadId = await makeThread();
    const messageId = await makeApprovedReply(threadId);
    // No fileExecutingApproval call at all.

    const verdict = await dispatchApprovedReply(co, messageId, wfUser);

    expect(verdict).toMatchObject({ ok: false, stage: "dispatch", reason: REPLY_DISPATCH_REFUSAL.approvalNotResolvable });
    expect(state.calls).toHaveLength(0);
    const row = await messageRow(messageId);
    expect(row.status).toBe("approved"); // untouched — no ambiguity was ever created
  });

  it("(T5) ⭐ RETENTION, at dispatch: a thread purged AFTER approval but BEFORE the executor runs refuses source_content_purged, no network call", async () => {
    registerPublisher(createMockPublisher(state, { withInbox: true }));
    const threadId = await makeThread(false);
    const messageId = await makeApprovedReply(threadId);
    await fileExecutingApproval(messageId, threadId, "Thanks for the comment!");
    // The purge sweep runs on its OWN clock, independent of this approval — simulated here exactly
    // as `inbox-retention-job.ts#purgeInboxRetention` would set it.
    await withTenants([co], (c) => c.query(`UPDATE social_inbox_threads SET activity_content_purged_at = now() WHERE id = $1`, [threadId]), MODULES);

    const verdict = await dispatchApprovedReply(co, messageId, wfUser);

    expect(verdict).toMatchObject({ stage: "retention", reason: "source_content_purged" });
    expect(state.calls).toHaveLength(0);
  });

  it("(T6) ⭐ REPLAY REFUSED: a message that already reached 'sent' cannot be dispatched a second time", async () => {
    registerPublisher(createMockPublisher(state, { withInbox: true }));
    const threadId = await makeThread();
    const messageId = await makeApprovedReply(threadId);
    await fileExecutingApproval(messageId, threadId, "Thanks for the comment!");
    const first = await dispatchApprovedReply(co, messageId, wfUser);
    expect(first.ok).toBe(true);

    // A second, independently-filed 'executing' approval for the SAME already-sent message.
    await fileExecutingApproval(messageId, threadId, "Thanks for the comment!");
    const second = await dispatchApprovedReply(co, messageId, wfUser);
    expect(second).toMatchObject({ ok: false, stage: "unconsumed", reason: "already_sent" });
    expect(state.calls.filter((c) => c.op === "sendReply")).toHaveLength(1);
  });
});
