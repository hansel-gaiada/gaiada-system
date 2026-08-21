// SMM-36 — the inbox retention purge, against live Postgres (skips without DATABASE_URL_TEST).
//
// What each block proves, and why it earns a test rather than a comment:
//   (1) ⚠ THE MODULE-GUC REGRESSION TEST — the one the ticket brief demanded by name, modeled on
//       `publish-precondition.ts`'s own `runPrecondition` helper in
//       `d14-smm-09-social-publish-registry.test.ts`: it calls `purgeTenantInboxRetention` on a
//       transaction the TEST itself opened with NO `{modules:['social']}` option, and asserts a
//       purge still happens. If `declareSocialModuleScope(c)` were ever deleted from that function,
//       every query inside it would read ZERO ROWS through 0105's third RLS wall, this assertion
//       would fail, and the failure would look exactly like "0 purged, all clean" — the worst shape
//       for THIS ticket, named in the brief.
//   (2) LinkedIn's two DOCUMENTED windows (24h profile / 48h activity) fire independently, and only
//       on rows actually old enough — a fresh row survives untouched.
//   (3) a network with no documented cap (instagram) is NEVER purged, however old its rows are —
//       the guard against inventing a retention number nobody researched.
//   (4) idempotent: running the sweep twice purges the same rows once, reports zero the second time,
//       and never errors on an already-purged row.
//   (5) per-tenant isolation: one tenant's purger throwing does not stop another tenant's purge, and
//       the failure is counted rather than silently swallowed into a false "clean" report.
//   (6) the SMM-38 phase 38b seam: a second registered purger's counts are aggregated alongside the
//       built-in one, proving the registration slot actually composes rather than only existing in
//       prose.
//   (7) the migration's state-law CHECKs actually refuse a marker set without its scrub — exercised
//       here against real FK parents (0113's own header defers this from the migration for exactly
//       this reason).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { withTenants, newId } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import {
  purgeTenantInboxRetention, runInboxRetentionPurge,
  registerRetentionPurger, resetRetentionPurgers,
} from "./inbox-retention-job";

const MODULES = { modules: ["social"] };

async function makeAccount(tenant: string, network: string): Promise<string> {
  const accId = newId();
  const clientId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'inbox client','central')`, [clientId, tenant]);
    const orgId = newId();
    await c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, postiz_org_id, api_key_ref, origin_site)
       VALUES ($1,$2,$3,$4,'env:KEY','central')`,
      [orgId, tenant, clientId, `org-${accId}`],
    );
    await c.query(
      `INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, status, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,'connected','central')`,
      [accId, tenant, clientId, orgId, network, `@h-${accId}`],
    );
  }, MODULES);
  return accId;
}

/** Insert a thread + one inbound message, with `created_at` back-dated by `ageHours` — the clock
 *  the purge job measures against. */
async function makeThreadWithMessage(
  tenant: string, accountId: string, network: string, ageHours: number,
): Promise<{ threadId: string; messageId: string }> {
  const threadId = newId();
  const messageId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(
      `INSERT INTO social_inbox_threads
         (id, tenant_id, account_id, network, kind, external_thread_id, author_handle, author_name,
          excerpt, status, created_at, origin_site)
       VALUES ($1,$2,$3,$4,'comment',$5,'@commenter','A Commenter','nice post!','open',
               now() - make_interval(hours => $6),'central')`,
      [threadId, tenant, accountId, network, `ext-${threadId}`, ageHours],
    );
    await c.query(
      `INSERT INTO social_inbox_messages
         (id, tenant_id, thread_id, direction, external_id, body, author_handle, posted_at,
          source, created_at, origin_site)
       VALUES ($1,$2,$3,'in',$4,'nice post indeed!','@commenter', now() - make_interval(hours => $5),
               'postiz_sync', now() - make_interval(hours => $5),'central')`,
      [messageId, tenant, threadId, `ext-msg-${messageId}`, ageHours],
    );
  }, MODULES);
  return { threadId, messageId };
}

async function readThread(tenant: string, threadId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT author_handle, author_name, excerpt, profile_data_purged_at, activity_content_purged_at
         FROM social_inbox_threads WHERE id = $1`,
      [threadId],
    ), MODULES);
  return rows[0];
}

async function readMessage(tenant: string, messageId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT author_handle, body, profile_data_purged_at, activity_content_purged_at
         FROM social_inbox_messages WHERE id = $1`,
      [messageId],
    ), MODULES);
  return rows[0];
}

describe.skipIf(!TEST_URL)("SMM-36 · inbox retention purge (module GUC, per-network, idempotent)", () => {
  let A: string; // LinkedIn client tenant
  let liAccount: string;
  let igAccount: string;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("SMM-36 Retention Agency", ["social"]);
    liAccount = await makeAccount(A, "linkedin");
    igAccount = await makeAccount(A, "instagram");
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  afterEach(() => {
    resetRetentionPurgers();
  });

  // ══ (1) THE MODULE-GUC REGRESSION TEST ═══════════════════════════════════════════════════════
  it("purges through a transaction with NO module scope declared by the caller — fails if declareSocialModuleScope is ever removed", async () => {
    // 50h: past BOTH LinkedIn windows (24h profile, 48h activity), so all four counts below fire.
    const { threadId, messageId } = await makeThreadWithMessage(A, liAccount, "linkedin", 50);
    const now = new Date();

    // Deliberately WITHOUT `{modules:['social']}` — mirrors publish-precondition.test's own
    // `runPrecondition` helper. If `purgeTenantInboxRetention` did not declare its own module
    // scope, 0105's third RLS wall would make every query inside it read ZERO ROWS, and the
    // assertions below would fail exactly the way an accidental deletion of that line would.
    const result = await withTenants([A], (c) => purgeTenantInboxRetention(c, A, now));

    expect(result.inbox.threadsProfile).toBe(1);
    expect(result.inbox.threadsActivity).toBe(1);
    expect(result.inbox.messagesProfile).toBe(1);
    expect(result.inbox.messagesActivity).toBe(1);

    const thread = await readThread(A, threadId);
    expect(thread.author_handle).toBeNull();
    expect(thread.author_name).toBeNull();
    expect(thread.excerpt).toBeNull();
    expect(thread.profile_data_purged_at).not.toBeNull();
    expect(thread.activity_content_purged_at).not.toBeNull();

    const message = await readMessage(A, messageId);
    expect(message.author_handle).toBeNull();
    expect(message.body).toBe("");
    expect(message.profile_data_purged_at).not.toBeNull();
    expect(message.activity_content_purged_at).not.toBeNull();
  });

  // ══ (2) the two windows fire independently, and only when actually due ══════════════════════
  it("a fresh LinkedIn thread (under both windows) is left completely untouched", async () => {
    const { threadId, messageId } = await makeThreadWithMessage(A, liAccount, "linkedin", 1);
    await withTenants([A], (c) => purgeTenantInboxRetention(c, A, new Date()));

    const thread = await readThread(A, threadId);
    expect(thread.author_handle).toBe("@commenter");
    expect(thread.excerpt).toBe("nice post!");
    expect(thread.profile_data_purged_at).toBeNull();
    expect(thread.activity_content_purged_at).toBeNull();

    const message = await readMessage(A, messageId);
    expect(message.body).toBe("nice post indeed!");
  });

  it("a thread past the 24h profile window but under the 48h activity window loses ONLY the profile fields", async () => {
    const { threadId } = await makeThreadWithMessage(A, liAccount, "linkedin", 30);
    await withTenants([A], (c) => purgeTenantInboxRetention(c, A, new Date()));

    const thread = await readThread(A, threadId);
    expect(thread.author_handle).toBeNull();
    expect(thread.profile_data_purged_at).not.toBeNull();
    // 30h < 48h — the comment text survives this run.
    expect(thread.excerpt).toBe("nice post!");
    expect(thread.activity_content_purged_at).toBeNull();
  });

  // ══ (2b) SMM-17's own finding — an OUTBOUND reply's own text is never subject to this purge ════
  it("SMM-17 fix: an OUTBOUND (direction='out') reply, however old, keeps its own body and author_handle — only INBOUND rows are in scope", async () => {
    const { threadId } = await makeThreadWithMessage(A, liAccount, "linkedin", 60); // past BOTH windows
    const replyId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_inbox_messages
           (id, tenant_id, thread_id, direction, external_id, body, author_handle, posted_at,
            source, created_at, origin_site)
         VALUES ($1,$2,$3,'out',$4,'thanks for the comment!','@our-handle', now() - make_interval(hours => 60),
                 'reply', now() - make_interval(hours => 60),'central')`,
        [replyId, A, threadId, `ext-outreply-${replyId}`],
      ), MODULES);

    await withTenants([A], (c) => purgeTenantInboxRetention(c, A, new Date()));

    // The THREAD's own activity content still purges on schedule (unaffected by this fix — a
    // thread-level fact, not a per-message one).
    const thread = await readThread(A, threadId);
    expect(thread.activity_content_purged_at).not.toBeNull();

    // But the OUTBOUND message — our own authored reply, never a member's social-activity content
    // LinkedIn's cap is about — survives completely untouched.
    const reply = await readMessage(A, replyId);
    expect(reply.body).toBe("thanks for the comment!");
    expect(reply.author_handle).toBe("@our-handle");
    expect(reply.profile_data_purged_at).toBeNull();
    expect(reply.activity_content_purged_at).toBeNull();
  });

  // ══ (3) no documented cap — never purged, however old ═══════════════════════════════════════
  it("an Instagram thread is NEVER purged, even at 10 years old — no documented retention cap exists", async () => {
    const { threadId, messageId } = await makeThreadWithMessage(A, igAccount, "instagram", 24 * 365 * 10);
    const result = await withTenants([A], (c) => purgeTenantInboxRetention(c, A, new Date()));

    // The built-in purger only iterates networks `hasDocumentedRetentionCap()` allows — instagram
    // contributes nothing to any count.
    expect(result.inbox.threadsProfile).toBe(0);
    expect(result.inbox.threadsActivity).toBe(0);

    const thread = await readThread(A, threadId);
    expect(thread.author_handle).toBe("@commenter");
    expect(thread.excerpt).toBe("nice post!");
    const message = await readMessage(A, messageId);
    expect(message.body).toBe("nice post indeed!");
  });

  // ══ (4) idempotent ═══════════════════════════════════════════════════════════════════════════
  it("running the sweep twice purges the same row ONCE and reports zero the second time, never an error", async () => {
    await makeThreadWithMessage(A, liAccount, "linkedin", 60);
    const now = new Date();

    const first = await withTenants([A], (c) => purgeTenantInboxRetention(c, A, now));
    expect(first.inbox.threadsProfile).toBeGreaterThan(0);

    const second = await withTenants([A], (c) => purgeTenantInboxRetention(c, A, now));
    expect(second.inbox.threadsProfile).toBe(0);
    expect(second.inbox.threadsActivity).toBe(0);
    expect(second.inbox.messagesProfile).toBe(0);
    expect(second.inbox.messagesActivity).toBe(0);
  });

  // ══ (5) per-tenant isolation: the sweep-level entry point ═══════════════════════════════════
  it("runInboxRetentionPurge swallows one tenant's failure and still purges every other tenant", async () => {
    const B = await createCompany("SMM-36 Retention Agency B", ["social"]);
    const bAccount = await makeAccount(B, "linkedin");
    await makeThreadWithMessage(A, liAccount, "linkedin", 40);
    const { threadId: bThreadId } = await makeThreadWithMessage(B, bAccount, "linkedin", 40);

    registerRetentionPurger("boom", async (_c, tenantId) => {
      if (tenantId === A) throw new Error("simulated purger failure for tenant A");
      return { fake: 1 };
    });

    const result = await runInboxRetentionPurge();
    expect(result.errors).toBeGreaterThanOrEqual(1);
    // Tenant B's own sweep must have completed despite A's registered purger throwing — one
    // tenant's bad transaction rolls back only that tenant's transaction (`withTenants` scopes one
    // transaction per tenant), and the per-tenant try/catch in `runInboxRetentionPurge` must not
    // abort the loop for the tenants after it.
    const bThread = await readThread(B, bThreadId);
    expect(bThread.profile_data_purged_at).not.toBeNull();
  });

  // ══ (6) the SMM-38 seam actually composes ════════════════════════════════════════════════════
  it("a second registered purger's counts are aggregated alongside the built-in inbox purger — the 38b seam", async () => {
    let calledWithTenant: string | undefined;
    registerRetentionPurger("oauth_tokens_stub", async (_c, tenantId) => {
      calledWithTenant = tenantId;
      return { tokensRevoked: 3 };
    });

    const result = await withTenants([A], (c) => purgeTenantInboxRetention(c, A, new Date()));
    expect(calledWithTenant).toBe(A);
    expect(result.oauth_tokens_stub).toEqual({ tokensRevoked: 3 });
    // The built-in purger still ran in the SAME transaction, under the SAME module scope.
    expect(result.inbox).toBeDefined();
  });

  // ══ (7) the migration's state-law CHECKs ═════════════════════════════════════════════════════
  it("the DB refuses a profile purge marker set while author_handle survives (sit_profile_purge_scrubs_author)", async () => {
    const { threadId } = await makeThreadWithMessage(A, liAccount, "linkedin", 1);
    const attempt = withTenants(
      [A],
      (c) => c.query(`UPDATE social_inbox_threads SET profile_data_purged_at = now() WHERE id = $1`, [threadId]),
      MODULES,
    );
    await expect(attempt).rejects.toThrow(/sit_profile_purge_scrubs_author/);
  });

  it("the DB refuses an activity purge marker set while a message body survives (sim_activity_purge_scrubs_body)", async () => {
    const { messageId } = await makeThreadWithMessage(A, liAccount, "linkedin", 1);
    const attempt = withTenants(
      [A],
      (c) => c.query(`UPDATE social_inbox_messages SET activity_content_purged_at = now() WHERE id = $1`, [messageId]),
      MODULES,
    );
    await expect(attempt).rejects.toThrow(/sim_activity_purge_scrubs_body/);
  });
});
