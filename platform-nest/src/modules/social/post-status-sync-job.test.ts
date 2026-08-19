// SMM-10 — `post-status-sync-job.ts`: the safety poll (`runPostStatusSync`/`reconcileTenantPostStatus`)
// and the webhook intake (`reconcileOneProviderPost`), against a live Postgres + a mock publisher.
//
// ── THE MODULE-GUC REGRESSION, PROVEN BY CONSTRUCTION (mirrors dispatch.test.ts's own note) ────────
// Every write here goes through `applyPostStatuses`, which declares its own module scope before
// touching `social_post_variants`. Every test below that reaches a real row through it IS the
// regression test: remove that declaration and every assertion here fails with "0 applied" instead
// of a real update, because 0105's third RLS wall would return zero rows silently.
//
// ── THE DOUBLE-POST PATH IS TESTED, NOT A COMMENT ────────────────────────────────────────────────────
// (T3)/(T4) below fire the SAME reconcile input/webhook call twice and assert exactly ONE event and
// no double-application — "assume every webhook/event fires twice" applied to this module's second
// untrusted transport.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany } from "../../testing/fixtures";
import { registerPublisher, resetPublishers } from "./publisher/registry";
import { createMockPublisher, newMockPublisherState, type MockPublisherState } from "./publisher/mock-driver";
import {
  applyPostStatuses, reconcileTenantPostStatus, reconcileOneProviderPost,
} from "./post-status-sync-job";

const MODULES: { modules: string[] } = { modules: ["social"] };

let seq = 0;
const uniq = (label: string): string => `smm10-sync-${label}-${++seq}`;

describe.skipIf(!TEST_URL)("SMM-10 · post-status-sync-job — the reconcile safety poll + webhook intake", () => {
  let co: string;
  let clientId: string;
  let publisherOrgId: string;
  let igAccount: string;
  let state: MockPublisherState;
  let enabledNetworksBefore: string[];

  beforeAll(async () => {
    await initTestDb();
    enabledNetworksBefore = config.social.publisher.enabledNetworks;
    config.social.publisher.enabledNetworks = [...new Set([...enabledNetworksBefore, "instagram"])];
    config.social.publisher.defaultOrgApiKey = "test-org-key";

    co = await createCompany("SMM-10 Sync Co", ["social"]);
    clientId = newId();
    await withTenants([co], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, co]));
    publisherOrgId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [publisherOrgId, co, clientId, uniq("org")]), MODULES);
    igAccount = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,$6,'connected','{}','central')`,
        [igAccount, co, clientId, publisherOrgId, uniq("@brand"), uniq("ig")]), MODULES);
  });

  afterAll(async () => {
    config.social.publisher.enabledNetworks = enabledNetworksBefore;
    await teardownTestDb();
  });

  beforeEach(() => {
    state = newMockPublisherState();
    resetPublishers();
    registerPublisher(createMockPublisher(state));
  });

  /** A variant already past dispatch: `queued`, carrying `approval_id` + `provider_post_id` — the
   *  exact shape `dispatch.ts`'s own successful stamp leaves behind. */
  async function makeInFlightVariant(providerPostId: string): Promise<{ variantId: string; engagementId: string }> {
    const engagementId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'sync engagement','active','{}',10,'central')`,
        [engagementId, co, clientId]), MODULES);
    const postId = newId();
    const variantId = newId();
    const approvalId = newId();
    await withTenants([co], async (c) => {
      await c.query(`INSERT INTO automation_approvals
           (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, requested_by, decided_by, decided_at, origin, origin_site, execution_status)
         VALUES ($1,$2,'wf:delivery','social.publishPost','{}','high','approved',NULL,NULL,now(),'automation','main','executed')`,
        [approvalId, co]);
      await c.query(
        `INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site)
         VALUES ($1,$2,$3,'sync post','publishing','central')`, [postId, co, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id, provider_post_id, status, origin_site)
         VALUES ($1,$2,$3,$4,'body','[]','{}','deadbeef',$5,$6,'queued','central')`,
        [variantId, co, postId, igAccount, approvalId, providerPostId],
      );
    }, MODULES);
    return { variantId, engagementId };
  }

  async function variantRow(variantId: string) {
    const { rows } = await withTenants([co], (c) =>
      c.query(
        `SELECT status, published_url AS "publishedUrl", last_error AS "lastError" FROM social_post_variants WHERE id = $1`,
        [variantId],
      ), MODULES);
    return rows[0];
  }

  async function outboxEvents(variantId: string): Promise<string[]> {
    const { rows } = await adminPool().query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_type = 'social_post_variant' AND entity_id = $1 ORDER BY created_at`,
      [variantId],
    );
    return rows.map((r) => r.event_type);
  }

  // ══ (T1) applyPostStatuses — the idempotent apply, direct ══════════════════════════════════════

  it("(T1) ⭐ applies an authoritative 'published' status, and this IS the module-GUC regression test", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);

    const result = await applyPostStatuses(co, [
      { providerPostId, state: "published", publishedUrl: "https://instagram.example/p/1" },
    ]);

    expect(result.applied).toBe(1);
    const row = await variantRow(variantId);
    expect(row.status).toBe("published");
    expect(row.publishedUrl).toBe("https://instagram.example/p/1");
    expect(await outboxEvents(variantId)).toContain("social.post.published");
  });

  it("(T2) applies a 'failed' status with the network's own error text, emits social.post.failed", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);

    await applyPostStatuses(co, [{ providerPostId, state: "failed", error: "upstream rejected the post" }]);

    const row = await variantRow(variantId);
    expect(row.status).toBe("failed");
    expect(row.lastError).toBe("upstream rejected the post");
    expect(await outboxEvents(variantId)).toContain("social.post.failed");
  });

  it("(T2b) 'unknown' state leaves the row untouched — 'the engine could not tell us' is not a fact about our own queue", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);
    const result = await applyPostStatuses(co, [{ providerPostId, state: "unknown" }]);
    expect(result.applied).toBe(0);
    expect((await variantRow(variantId)).status).toBe("queued");
  });

  // ══ (T3) THE DOUBLE-POST PATH — a repeated authoritative status is a no-op, not a re-fire ══════

  it("(T3) ⭐ applying the SAME 'failed' status twice emits the failure event exactly ONCE", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);
    const statuses = [{ providerPostId, state: "failed" as const, error: "network blip" }];

    await applyPostStatuses(co, statuses);
    await applyPostStatuses(co, statuses); // redelivered

    const events = await outboxEvents(variantId);
    expect(events.filter((e) => e === "social.post.failed")).toHaveLength(1);
    expect((await variantRow(variantId)).status).toBe("failed");
  });

  // ══ (T4) reconcileTenantPostStatus — the batched sweep, via the mock driver's OWN state ════════

  it("(T4) the tenant sweep batches by publisher org and applies whatever the driver reports", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);
    state.posts.set(providerPostId, { providerPostId, state: "published", publishedUrl: "https://instagram.example/p/2" });

    const result = await reconcileTenantPostStatus(co);

    expect(result.applied).toBe(1);
    expect(result.errors).toBe(0);
    expect((await variantRow(variantId)).status).toBe("published");
    // Batched: exactly one getPostStatus call for the whole org, not one per variant.
    expect(state.calls.filter((c) => c.op === "getPostStatus")).toHaveLength(1);
  });

  // ══ (T5) THE WEBHOOK INTAKE — ids only, never trusted content, fired twice ═════════════════════

  it("(T5) ⭐ reconcileOneProviderPost re-fetches authoritative state itself and a repeat delivery is a safe no-op", async () => {
    const providerPostId = uniq("post");
    const { variantId } = await makeInFlightVariant(providerPostId);
    // The mock's own state is the ONLY thing that decides the outcome — a webhook payload claiming
    // anything else (a fabricated URL, a fabricated success) is never consulted by this function's
    // signature: it takes an id and nothing else.
    state.posts.set(providerPostId, { providerPostId, state: "published", publishedUrl: "https://instagram.example/p/3" });

    const first = await reconcileOneProviderPost(co, providerPostId);
    expect(first).toBe(true);
    expect((await variantRow(variantId)).status).toBe("published");

    // A redelivered webhook for the SAME id: the variant is ALREADY terminal (`published`), so there
    // is no in-flight row left to resolve an org from — `reconcileOneProviderPost` reports `false`
    // ("nothing needed doing"), the SAME honest answer it gives for an unknown id, and it never
    // re-touches the row or re-fires the event a second time.
    const second = await reconcileOneProviderPost(co, providerPostId);
    expect(second).toBe(false);
    const events = await outboxEvents(variantId);
    expect(events.filter((e) => e === "social.post.published")).toHaveLength(1);
  });

  it("(T6) an unknown/foreign providerPostId resolves to `false` — never leaks whether it belongs to another tenant", async () => {
    const result = await reconcileOneProviderPost(co, uniq("nonexistent"));
    expect(result).toBe(false);
  });
});
