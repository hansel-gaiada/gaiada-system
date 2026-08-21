// SMM-15 — `inbox-sync-job.ts` (`pullInbox`) against a live Postgres. No Nest app, no hub, no
// Cerbos — mirrors `metrics-job.test.ts`'s/`inbox-retention-job.test.ts`'s own split.
//
// ── ⚠ THE MODULE-GUC REGRESSION TEST, THE TICKET DEMANDED BY NAME ─────────────────────────────────
// (T1) calls `upsertInboxItems` exactly as written — no `{modules:['social']}` passed at the call
// site, because the FUNCTION is what declares its own scope internally (`declareSocialModuleScope`)
// — and asserts a REAL row exists afterward. Delete that declaration and this assertion fails with
// "threadsWritten: 0" instead of a real write — the exact "0 new comments, looks perfectly healthy"
// failure shape the ticket brief named.
//
// ── A LOCALLY-SCOPED TEST DRIVER, NOT `mock-driver.ts` ────────────────────────────────────────────
// `publisher/mock-driver.ts` is off-limits to this ticket (read-only), and its own `listComments`
// stub always returns `[]` regardless of args — no per-post-configurable map exists there. This file
// builds its OWN small `SocialPublisher` shape locally, scoped to this describe block, so no shared
// module-level mock state can leak between `it()`s in file-declaration order (this module's own
// recurring defect class #7).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { storeOAuthGrant } from "./publisher/oauth-tokens";
import {
  SocialPublisherError,
  type InboxItem, type OrgHandle, type PublisherCapability, type SocialPublisher,
} from "./publisher/types";
import { pullTenantInbox, upsertInboxItems } from "./inbox-sync-job";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm15-inbox-${label}-${++seq}`;

async function makeTenant(name: string): Promise<string> {
  return createCompany(name, ["social"]);
}

async function makeAccount(
  tenant: string, network: string, opts: { driver?: string; postizIntegrationId?: string } = {},
): Promise<{ accountId: string; orgId: string; clientId: string }> {
  const clientId = newId();
  await withTenants([tenant], (c) =>
    c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'inbox client','central')`, [clientId, tenant]));
  const orgId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
       VALUES ($1,$2,$3,$4,$5,'default','active','central')`,
      [orgId, tenant, clientId, opts.driver ?? "postiz", uniq("org")]), MODULES);
  const accountId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_accounts
         (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'connected','{}','central')`,
      [accountId, tenant, clientId, orgId, network, uniq("@brand"), opts.postizIntegrationId ?? uniq("integration")]), MODULES);
  return { accountId, orgId, clientId };
}

async function makePublishedVariant(
  tenant: string, clientId: string, accountId: string, providerPostId: string, publishedDaysAgo = 1,
): Promise<string> {
  const engagementId = newId();
  await withTenants([tenant], (c) =>
    c.query(
      `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
       VALUES ($1,$2,$3,'inbox engagement','active','{}',10,'central')`,
      [engagementId, tenant, clientId]), MODULES);
  const postId = newId();
  const variantId = newId();
  const approvalId = newId();
  await withTenants([tenant], async (c) => {
    await c.query(`INSERT INTO automation_approvals
         (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
       VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
      [approvalId, tenant]);
    await c.query(
      `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
       VALUES ($1,$2,$3,'inbox post','publishing','central')`, [postId, tenant, engagementId]);
    await c.query(
      `INSERT INTO social_post_variants
         (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id,
          provider_post_id, status, published_at, origin_site)
       VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'published',
               now() - make_interval(days => $7),'central')`,
      [variantId, tenant, postId, accountId, approvalId, providerPostId, publishedDaysAgo],
    );
  }, MODULES);
  return variantId;
}

async function readThread(tenant: string, accountId: string, externalThreadId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT id, author_handle AS "authorHandle", author_name AS "authorName", excerpt,
              last_message_at AS "lastMessageAt", profile_data_purged_at AS "profileDataPurgedAt",
              activity_content_purged_at AS "activityContentPurgedAt"
         FROM social_inbox_threads WHERE account_id = $1 AND external_thread_id = $2`,
      [accountId, externalThreadId],
    ), MODULES);
  return rows;
}

async function readMessages(tenant: string, threadId: string) {
  const { rows } = await withTenants([tenant], (c) =>
    c.query(
      `SELECT external_id AS "externalId", body, author_handle AS "authorHandle", posted_at AS "postedAt", source
         FROM social_inbox_messages WHERE thread_id = $1 ORDER BY posted_at`,
      [threadId],
    ), MODULES);
  return rows;
}

/** A minimal, LOCALLY-scoped `SocialPublisher` — every non-inbox member refuses
 *  `capability_unsupported` (this ticket's own scope is inbox pull only), and `listComments` reads
 *  from a per-post map the test controls directly, filtering by `since` the same way the REAL
 *  LinkedIn/YouTube normalizers do client-side. `key` defaults to `"postiz"` (the org's default
 *  driver) so a test can prove the DEFAULT, no-override path reaches this driver at all; pass
 *  `"direct"` to prove the (network, capability) override path instead. */
function makeInboxTestDriver(opts: {
  key?: "postiz" | "direct";
  capabilities?: PublisherCapability[];
  itemsByPost?: Map<string, InboxItem[]>;
  calls?: Array<{ op: string; integrationId: string; sinceIso: string }>;
}): SocialPublisher {
  const caps = new Set<PublisherCapability>(opts.capabilities ?? ["inbox_read"]);
  const refuse = (op: string): never => {
    throw new SocialPublisherError("capability_unsupported", `test driver does not implement '${op}'`);
  };
  const driver: SocialPublisher = {
    key: opts.key ?? "postiz",
    capabilities: caps,
    async createOrg() { return refuse("createOrg"); },
    async verifyOrg() { return refuse("verifyOrg"); },
    async connectUrl() { return refuse("connectUrl"); },
    async listIntegrations() { return refuse("listIntegrations"); },
    async getQuota() { return undefined; },
    async schedulePost() { return refuse("schedulePost"); },
    async cancelPost() { return refuse("cancelPost"); },
    async getPostStatus() { return refuse("getPostStatus"); },
    async uploadMedia() { return refuse("uploadMedia"); },
    async getAccountMetrics() { return []; },
    async getPostMetrics() { return []; },
    estimateCostUsd() { return 0; },
  };
  if (caps.has("inbox_read")) {
    driver.listComments = async (_org: OrgHandle, integrationId: string, since: Date): Promise<InboxItem[]> => {
      opts.calls?.push({ op: "listComments", integrationId, sinceIso: since.toISOString() });
      const all = opts.itemsByPost?.get(integrationId) ?? [];
      return all.filter((i) => new Date(i.postedAt) >= since);
    };
  }
  return driver;
}

function item(externalId: string, body: string, postedAt: string, authorHandle = "@commenter"): InboxItem {
  return { externalId, externalThreadId: "unused-by-driver", kind: "comment", authorHandle, body, postedAt };
}

/** Seeds a real, resolvable OAuth grant for an account — the same seam `dispatch.test.ts`'s
 *  (D1)-(D4) block uses to prove `resolveDispatchOrgHandle`'s `direct` path against a REAL
 *  `social_oauth_tokens` row, never a mock of the resolver itself. */
async function seedOAuthGrant(tenant: string, accountId: string, network: "linkedin" | "youtube"): Promise<void> {
  await withTenants([tenant], (c) =>
    storeOAuthGrant(c, {
      tenantId: tenant, accountId, network, accessToken: `test-bearer-${accountId}`,
      expiresAt: new Date(Date.now() + 3600_000),
    }), MODULES);
}

describe.skipIf(!TEST_URL)("SMM-15 · inbox-sync-job — pullInbox into social_inbox_threads / social_inbox_messages", () => {
  let A: string;
  let defaultOrgApiKeyBefore: string;
  let integrationTokenKeyBefore: string;

  beforeAll(async () => {
    await initTestDb();
    A = await makeTenant("SMM-15 Inbox Agency");
    // `openOrg`'s Postiz-shaped handle (the default, no-override path) resolves `apiKeyRef: 'default'`
    // via `config.social.publisher.defaultOrgApiKey` — unset, it throws before the test driver is
    // ever reached (mirrors `metrics-job.test.ts`'s/`dispatch.test.ts`'s own beforeAll).
    defaultOrgApiKeyBefore = config.social.publisher.defaultOrgApiKey;
    config.social.publisher.defaultOrgApiKey = "test-org-key";
    // `storeOAuthGrant`/`resolveActiveAccessToken` seal through secret-box.ts, which fails closed
    // without a real key — set one for real, the same seam `dispatch.test.ts`/`oauth-tokens.test.ts` use.
    integrationTokenKeyBefore = config.integrationTokenKey;
    config.integrationTokenKey = randomBytes(32).toString("base64");
  });

  afterAll(async () => {
    config.social.publisher.defaultOrgApiKey = defaultOrgApiKeyBefore;
    config.integrationTokenKey = integrationTokenKeyBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    resetPublishers();
  });

  // ══ (T1) ⭐ upsertInboxItems — direct call, THIS IS THE MODULE-GUC REGRESSION TEST ══════════════

  it("(T1) ⭐ writes a real thread + message row through a caller-side transaction with NO module scope declared — fails if declareSocialModuleScope is ever removed", async () => {
    const { accountId, clientId } = await makeAccount(A, "linkedin");
    const providerPostId = uniq("urn:li:share");
    const variantId = await makePublishedVariant(A, clientId, accountId, providerPostId);

    const result = await upsertInboxItems(A, {
      accountId, network: "linkedin", providerPostId, postVariantId: variantId,
      items: [item("c1", "nice post!", "2026-08-20T10:00:00.000Z")],
    });

    expect(result).toEqual({ threadsWritten: 1, messagesWritten: 1 });
    const threads = await readThread(A, accountId, providerPostId);
    expect(threads).toHaveLength(1);
    expect(threads[0].excerpt).toBe("nice post!");
    const messages = await readMessages(A, threads[0].id);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("nice post!");
    expect(messages[0].source).toBe("direct_sync");
  });

  // ══ (T2) IDEMPOTENT — run the SAME pull twice, prove exactly ONE thread / ONE message row ══════

  it("(T2) re-running the same pull produces ZERO duplicate rows — one thread, one message", async () => {
    const { accountId, clientId } = await makeAccount(A, "linkedin");
    const providerPostId = uniq("urn:li:share");
    const variantId = await makePublishedVariant(A, clientId, accountId, providerPostId);
    const items = [item(uniq("c"), "first comment", "2026-08-20T10:00:00.000Z")];

    const first = await upsertInboxItems(A, { accountId, network: "linkedin", providerPostId, postVariantId: variantId, items });
    const second = await upsertInboxItems(A, { accountId, network: "linkedin", providerPostId, postVariantId: variantId, items });

    expect(first).toEqual({ threadsWritten: 1, messagesWritten: 1 });
    expect(second).toEqual({ threadsWritten: 1, messagesWritten: 0 }); // the message already existed; DO NOTHING
    const threads = await readThread(A, accountId, providerPostId);
    expect(threads).toHaveLength(1);
    const messages = await readMessages(A, threads[0].id);
    expect(messages).toHaveLength(1);
  });

  // ── Tests below call `pullTenantInbox`, a TENANT-WIDE sweep. Each gets its OWN fresh tenant
  // (never the shared `A` above) — a sweep's own counts (`posts`/`unsupported`/...) are over EVERY
  // eligible post for that tenant, and reusing `A` would silently accumulate rows across `it()`s in
  // file-declaration order, exactly this module's own recurring defect class #7 (a shared, stateful
  // fixture polluting a later assertion), just at the fixture layer instead of a `vi.fn()`.

  // ══ (T3) SUPPORTED, via `direct` override — a real end-to-end pullTenantInbox sweep ═════════════

  it("(T3) an override to `direct` + inbox_read pulls real comments into a real thread/message row", async () => {
    const T = await makeTenant("SMM-15 Inbox T3");
    const { accountId, clientId } = await makeAccount(T, "linkedin", { driver: "postiz" });
    const providerPostId = uniq("urn:li:share");
    await makePublishedVariant(T, clientId, accountId, providerPostId, 5);
    await seedOAuthGrant(T, accountId, "linkedin");

    // Comfortably AFTER the post's own `published_at` (5 days ago) regardless of time-of-day, so the
    // cursor (`since` = `published_at` on a first pull) never filters it out on a slow test run.
    const itemsByPost = new Map<string, InboxItem[]>([
      [providerPostId, [item(uniq("c1"), "great content", new Date(Date.now() - 3600_000).toISOString())]],
    ]);
    const postizDriver = makeInboxTestDriver({ key: "postiz", capabilities: [] }); // Postiz: ZERO inbound surface, honestly
    const directDriver = makeInboxTestDriver({ key: "direct", itemsByPost });
    registerPublisher(postizDriver);
    registerPublisher(directDriver);

    const capabilityDriversBefore = config.social.publisher.capabilityDrivers;
    config.social.publisher.capabilityDrivers = { "linkedin:inbox_read": "direct" };
    try {
      const result = await pullTenantInbox(T);
      expect(result.posts).toBe(1);
      expect(result.threadsWritten).toBe(1);
      expect(result.messagesWritten).toBe(1);
      expect(result.unsupported).toBe(0);

      const threads = await readThread(T, accountId, providerPostId);
      expect(threads).toHaveLength(1);
      expect(threads[0].excerpt).toBe("great content");
    } finally {
      config.social.publisher.capabilityDrivers = capabilityDriversBefore;
    }
  });

  // ══ (T4) UNSUPPORTED ≠ EMPTY — the ticket's own named distinction ═══════════════════════════════

  it("(T4) an account whose resolved driver does not advertise inbox_read is UNSUPPORTED, never counted as an empty pull", async () => {
    const T = await makeTenant("SMM-15 Inbox T4");
    const { accountId, clientId } = await makeAccount(T, "instagram", { driver: "postiz" });
    const providerPostId = uniq("ig-post");
    await makePublishedVariant(T, clientId, accountId, providerPostId, 1);

    // Postiz's own real shape: no `inbox_read` capability at all (spike §8b's ZERO-inbound finding).
    registerPublisher(makeInboxTestDriver({ key: "postiz", capabilities: [] }));

    const result = await pullTenantInbox(T);
    expect(result.posts).toBe(1); // examined
    expect(result.unsupported).toBe(1); // refused honestly
    expect(result.threadsWritten).toBe(0);
    expect(result.messagesWritten).toBe(0);
    const threads = await readThread(T, accountId, providerPostId);
    expect(threads).toHaveLength(0); // no phantom thread for an unsupported pull
  });

  it("(T4b) a SUPPORTED account with genuinely zero new comments is an EMPTY pull, distinct from unsupported", async () => {
    const T = await makeTenant("SMM-15 Inbox T4b");
    const { accountId, clientId } = await makeAccount(T, "linkedin", { driver: "postiz" });
    const providerPostId = uniq("urn:li:share");
    await makePublishedVariant(T, clientId, accountId, providerPostId, 1);
    await seedOAuthGrant(T, accountId, "linkedin");

    registerPublisher(makeInboxTestDriver({ key: "postiz", capabilities: [] }));
    registerPublisher(makeInboxTestDriver({ key: "direct", itemsByPost: new Map() })); // no items for this post

    const capabilityDriversBefore = config.social.publisher.capabilityDrivers;
    config.social.publisher.capabilityDrivers = { "linkedin:inbox_read": "direct" };
    try {
      const result = await pullTenantInbox(T);
      expect(result.posts).toBe(1); // examined, unlike (T4)
      expect(result.unsupported).toBe(0); // genuinely supported, just nothing new
      expect(result.threadsWritten).toBe(0);
      expect(result.messagesWritten).toBe(0);
    } finally {
      config.social.publisher.capabilityDrivers = capabilityDriversBefore;
    }
  });

  // ══ (T5) THE CURSOR ADVANCES — a second sweep only asks for comments AFTER the first's watermark ═

  it("(T5) the per-post cursor advances: a second sweep passes `since` = the first sweep's own last_message_at, and only NEW comments land", async () => {
    const T = await makeTenant("SMM-15 Inbox T5");
    const { accountId, clientId } = await makeAccount(T, "linkedin", { driver: "postiz" });
    const providerPostId = uniq("urn:li:share");
    await makePublishedVariant(T, clientId, accountId, providerPostId, 10);
    await seedOAuthGrant(T, accountId, "linkedin");

    // Relative to `Date.now()`, never a fixed literal — a fixed literal near "days ago" is fragile
    // against the test's own time-of-day (a post "published_at = now() - 5 days" at 11:00 UTC makes
    // a fixed "...T00:00:00Z" comment on that same day read as BEFORE `since`, filtering it out).
    const oldCommentAt = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const newCommentAt = new Date(Date.now() - 3600 * 1000).toISOString();

    const calls: Array<{ op: string; integrationId: string; sinceIso: string }> = [];
    const itemsByPost = new Map<string, InboxItem[]>([
      [providerPostId, [item(uniq("c-old"), "older comment", oldCommentAt)]],
    ]);
    registerPublisher(makeInboxTestDriver({ key: "postiz", capabilities: [] }));
    registerPublisher(makeInboxTestDriver({ key: "direct", itemsByPost, calls }));

    const capabilityDriversBefore = config.social.publisher.capabilityDrivers;
    config.social.publisher.capabilityDrivers = { "linkedin:inbox_read": "direct" };
    try {
      const first = await pullTenantInbox(T);
      expect(first.messagesWritten).toBe(1);

      // A second sweep: the driver now also has a NEWER comment. Only the new one should land, and
      // the `since` this sweep passes must be >= the first sweep's own watermark, not the post's
      // original `published_at` again (that would re-scan the same window forever).
      itemsByPost.set(providerPostId, [
        ...itemsByPost.get(providerPostId)!,
        item(uniq("c-new"), "newer comment", newCommentAt),
      ]);
      const second = await pullTenantInbox(T);
      expect(second.messagesWritten).toBe(1); // only the new one, the old one is DO-NOTHING'd

      const secondCallSince = new Date(calls[calls.length - 1].sinceIso);
      expect(secondCallSince.toISOString()).toBe(new Date(oldCommentAt).toISOString()); // the first sweep's watermark

      const threads = await readThread(T, accountId, providerPostId);
      const messages = await readMessages(T, threads[0].id);
      expect(messages).toHaveLength(2);
    } finally {
      config.social.publisher.capabilityDrivers = capabilityDriversBefore;
    }
  });

  // ══ (T6) QUOTA-AWARE CAP — a self-imposed safety valve, never a claimed vendor limit ════════════

  it("(T6) an account with more eligible posts than the configured cap is truncated to the cap, newest first", async () => {
    const T = await makeTenant("SMM-15 Inbox T6");
    const { accountId, clientId } = await makeAccount(T, "linkedin", { driver: "postiz" });
    const postIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const pid = uniq(`urn:li:share:${i}`);
      postIds.push(pid);
      // Oldest published first in the loop, so index 0 is the OLDEST and 4 is the NEWEST.
      await makePublishedVariant(T, clientId, accountId, pid, 5 - i);
    }
    await seedOAuthGrant(T, accountId, "linkedin");
    registerPublisher(makeInboxTestDriver({ key: "postiz", capabilities: [] }));
    registerPublisher(makeInboxTestDriver({ key: "direct", itemsByPost: new Map() }));

    const capabilityDriversBefore = config.social.publisher.capabilityDrivers;
    const capBefore = config.social.inboxPull.maxPostsPerAccountPerRun;
    config.social.publisher.capabilityDrivers = { "linkedin:inbox_read": "direct" };
    config.social.inboxPull.maxPostsPerAccountPerRun = 2;
    try {
      const result = await pullTenantInbox(T);
      expect(result.posts).toBe(2); // capped from 5 down to 2, never all 5
    } finally {
      config.social.publisher.capabilityDrivers = capabilityDriversBefore;
      config.social.inboxPull.maxPostsPerAccountPerRun = capBefore;
    }
  });

  // ══ (T7) RETENTION INTERPLAY — a thread whose activity window already closed keeps excerpt NULL ═
  // Uses `upsertInboxItems` directly (not the sweep), so the shared tenant `A` is safe here too.

  it("(T7) a thread whose activity_content_purged_at is already set never receives a fresh excerpt (0113's own state-law CHECK), but its message rows still land with real bodies", async () => {
    const { accountId, clientId } = await makeAccount(A, "linkedin", { driver: "postiz" });
    const providerPostId = uniq("urn:li:share");
    const variantId = await makePublishedVariant(A, clientId, accountId, providerPostId, 10);

    // Seed an already-purged thread by hand, mirroring the shape `inbox-retention-job.ts` leaves
    // behind: the marker set, excerpt/author already NULL.
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_inbox_threads
           (tenant_id, account_id, network, kind, external_thread_id, post_variant_id, status,
            last_message_at, activity_content_purged_at, origin_site)
         VALUES ($1,$2,'linkedin','comment',$3,$4,'open', now() - interval '10 days',
                 now() - interval '1 day','central')`,
        [A, accountId, providerPostId, variantId],
      ), MODULES);

    const result = await upsertInboxItems(A, {
      accountId, network: "linkedin", providerPostId, postVariantId: variantId,
      items: [item(uniq("c-fresh"), "a brand new comment", new Date().toISOString())],
    });
    expect(result.messagesWritten).toBe(1);

    const threads = await readThread(A, accountId, providerPostId);
    expect(threads).toHaveLength(1);
    expect(threads[0].excerpt).toBeNull(); // stays purged — never re-populated
    expect(threads[0].activityContentPurgedAt).not.toBeNull();

    const messages = await readMessages(A, threads[0].id);
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("a brand new comment"); // the FRESH row is unaffected — its own clock
  });
});
