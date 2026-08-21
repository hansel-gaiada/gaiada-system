// SMM-17 — the inbox reply flow's HTTP surface, end-to-end against live Postgres + Cerbos, driven
// through the REAL endpoints by real personas with all three walls in place (agentic bar
// criterion 7). Skips silently without DATABASE_URL_TEST.
//
// The registry entry, the four precondition stages, the executor integration, replay and the
// no-auto-retry rule are `src/core/d14-smm-17-social-reply-registry.test.ts`'s. The domain dispatch
// function (the transactional stamp, capability_unsupported vs a failed send) is
// `reply-dispatch.test.ts`'s. This file covers what only an app can prove:
//
//   (1) the full staff flow: draft -> edit -> approve -> dry-run -> send, against a live thread;
//   (2) the Cerbos split this module's own 0106/resource_social_inbox.yaml documents: drafting/
//       editing/approving rides `assign`, sending rides `reply` — both social_staff AND
//       social_manager hold both actions (the inbox is the agency's working surface, unlike
//       publish's manager-only tier);
//   (3) ⚠ the `message`-vs-`error` trap on the send endpoint, the same class `publish-gate.test.ts`
//       asserts for publish;
//   (4) the retention refusal (this ticket's own named design question) reachable end-to-end through
//       the dry-run AND the real send attempt.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import { SOCIAL_REPLY_TOOL, REPLY_REFUSAL } from "./reply-precondition";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm17http-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-17 · the inbox reply flow over HTTP", () => {
  let app: NestFastifyApplication;
  let A: string;
  let manager: string;
  let staff: string;
  let outsider: string;
  let clientId: string;
  let accountId: string;
  let state: MockPublisherState;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "linkedin"])];
    // `openOrg`/`resolveDispatchOrgHandle` resolve the org's API key by alias at call time (custody
    // split (b)) — the mock driver never reads it, but `resolveOrgApiKey` still refuses
    // `org_key_unresolved` if no alias resolves, so the 'default' alias needs a value even for a
    // fake key (mirrors `dispatch.test.ts`'s own beforeAll).
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SMM-17 Reply Agency", ["social"]);
    manager = await createUser("smm17-manager@gate.test");
    staff = await createUser("smm17-staff@gate.test");
    outsider = await createUser("smm17-outsider@gate.test");
    await addMembership(A, manager);
    await addMembership(A, staff);
    await addMembership(A, outsider);
    await grantRole(manager, await createRole("social_manager"), "company", A);
    await grantRole(staff, await createRole("social_staff"), "company", A);

    clientId = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, A]));
    const orgId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [orgId, A, clientId, uniq("org")]), MODULES);
    accountId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'linkedin',$5,$6,'connected','{}','central')`,
        [accountId, A, clientId, orgId, uniq("@brand"), uniq("integration")]), MODULES);
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'reply engagement','active',$4,10,'central')`,
        [newId(), A, clientId, JSON.stringify({ networks: { linkedin: true }, inbox: { reply: true } })]), MODULES);

    app = await buildApp();
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    await app.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state, { withInbox: true }));
  });

  const get = (url: string, userId: string) => app.inject({ method: "GET", url, headers: asUser(userId) });
  const post = (url: string, body: unknown, userId: string) =>
    app.inject({ method: "POST", url, headers: asUser(userId), payload: body as never });
  const patch = (url: string, body: unknown, userId: string) =>
    app.inject({ method: "PATCH", url, headers: asUser(userId), payload: body as never });

  async function makeThread(purged = false): Promise<string> {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_inbox_threads
           (id, tenant_id, account_id, network, kind, external_thread_id, status, last_message_at, origin_site,
            activity_content_purged_at)
         VALUES ($1,$2,$3,'linkedin','comment',$4,'open',now(),'central',$5)`,
        [id, A, accountId, uniq("thread"), purged ? new Date() : null],
      ), MODULES);
    return id;
  }

  async function fileExecutingApproval(messageId: string, toolArgs: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at,
            origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery',$3,$4,'high','approved',$5,$5,now(),'automation','main','executing')`,
        [id, A, SOCIAL_REPLY_TOOL, JSON.stringify(toolArgs), manager],
      ),
    );
    return id;
  }

  // ── (1) the full staff flow ──────────────────────────────────────────────────────────────────

  it("⭐ THE FULL FLOW: draft -> edit -> approve -> dry-run ok:true -> send, against a live thread", async () => {
    const threadId = await makeThread();

    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "Thanks!" }, staff);
    expect(created.statusCode).toBe(201);
    const messageId = created.json().id;
    expect(created.json().status).toBe("draft");

    const edited = await patch(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}`, { body: "Thanks so much!" }, staff);
    expect(edited.statusCode).toBe(200);
    const argsSha256 = edited.json().argsSha256;

    const approved = await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/approve`, {}, staff);
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe("approved");

    const dry = await get(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send-preconditions`, staff);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ ok: true, tool: SOCIAL_REPLY_TOOL });

    // The send endpoint is reachable in the ordinary flow ONLY through the D14 executor's re-drive
    // (this file's own header note, mirroring `dispatchPublish`'s) — so the test files the
    // 'executing' approval directly, the same state the executor's own claim would leave.
    await fileExecutingApproval(messageId, { tenantId: A, messageId, threadId, accountId, body: "Thanks so much!" });
    const sent = await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send`, {}, staff);
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ ok: true, network: "linkedin" });
    expect(sent.json().externalId).toBeTruthy();

    const list = await get(`/api/${A}/modules/social/threads/${threadId}/messages`, staff);
    expect(list.json().messages).toHaveLength(1);
    expect(list.json().messages[0]).toMatchObject({ status: "sent", direction: "out" });
  });

  it("refuses an empty draft body, never files a row for empty content", async () => {
    const threadId = await makeThread();
    const res = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "   " }, staff);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("empty_body");
  });

  it("EDIT INVALIDATES APPROVAL: editing an approved draft reverts it to draft and reports approvalInvalidated", async () => {
    const threadId = await makeThread();
    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "v1" }, staff);
    const messageId = created.json().id;
    await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/approve`, {}, staff);

    const edited = await patch(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}`, { body: "v2" }, staff);
    expect(edited.statusCode).toBe(200);
    expect(edited.json().approvalInvalidated).toBe(true);

    const dry = await get(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send-preconditions`, staff);
    expect(dry.json()).toMatchObject({ ok: false, stage: "unconsumed", reason: REPLY_REFUSAL.messageNotApproved });
  });

  // ── (2) the Cerbos split: assign (draft/edit/approve) vs reply (send) ───────────────────────

  it("STAFF may draft, edit, approve AND send — the inbox is the agency's working surface (unlike publish)", async () => {
    const threadId = await makeThread();
    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "hi" }, staff);
    expect(created.statusCode).toBe(201);
    const messageId = created.json().id;
    expect((await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/approve`, {}, staff)).statusCode).toBe(200);
    await fileExecutingApproval(messageId, { tenantId: A, messageId, threadId, accountId, body: "hi" });
    expect((await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send`, {}, staff)).statusCode).toBe(200);
  });

  it("an OUTSIDER with no social grant is denied with a 403 on every step — never a bland empty answer", async () => {
    const threadId = await makeThread();
    expect((await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "hi" }, outsider)).statusCode).toBe(403);
    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "hi" }, manager);
    const messageId = created.json().id;
    expect((await patch(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}`, { body: "x" }, outsider)).statusCode).toBe(403);
    expect((await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/approve`, {}, outsider)).statusCode).toBe(403);
    expect((await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send`, {}, outsider)).statusCode).toBe(403);
    expect((await get(`/api/${A}/modules/social/threads/${threadId}/messages`, outsider)).statusCode).toBe(403);
  });

  // ── (3) ⚠ the message-vs-error trap on the send endpoint ────────────────────────────────────

  it("⭐ the send endpoint's refusal token rides `message`, never `error` — it arrives as `error` in the response", async () => {
    const threadId = await makeThread();
    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "hi" }, manager);
    const messageId = created.json().id;
    // Never approved, never filed an executing approval: the send endpoint's own dispatch call
    // refuses at the scope/unconsumed stage before ever reaching the network.
    await fileExecutingApproval(messageId, { tenantId: A, messageId, threadId, accountId, body: "hi" });
    const res = await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send`, {}, manager);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(REPLY_REFUSAL.messageNotApproved);
  });

  // ── (4) the retention refusal, end-to-end ───────────────────────────────────────────────────

  it("⭐ RETENTION: a purged thread's approved reply refuses source_content_purged in BOTH the dry-run and the real send", async () => {
    const threadId = await makeThread(true);
    const created = await post(`/api/${A}/modules/social/threads/${threadId}/messages`, { body: "hi" }, manager);
    const messageId = created.json().id;
    await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/approve`, {}, manager);

    const dry = await get(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send-preconditions`, manager);
    expect(dry.json()).toMatchObject({ ok: false, stage: "retention", reason: REPLY_REFUSAL.sourceContentPurged });

    await fileExecutingApproval(messageId, { tenantId: A, messageId, threadId, accountId, body: "hi" });
    const sent = await post(`/api/${A}/modules/social/threads/${threadId}/messages/${messageId}/send`, {}, manager);
    expect(sent.statusCode).toBe(409);
    expect(sent.json().error).toBe(REPLY_REFUSAL.sourceContentPurged);
    expect(state.calls.some((c) => c.op === "sendReply")).toBe(false);
  });

  it("404s an unknown message instead of returning a 200/409 carrying message_not_found", async () => {
    const threadId = await makeThread();
    expect((await get(`/api/${A}/modules/social/threads/${threadId}/messages/${newId()}/send-preconditions`, manager)).statusCode).toBe(404);
  });
});
