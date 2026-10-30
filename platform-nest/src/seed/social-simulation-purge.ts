// SCP-Sf — PURGE the social simulator's rows before the ERP holds real client data (plan §5 "Before real data"; runbook
// infra/runbooks/social-simulation.md, "Turn off and purge before real client data"). The rules are
// `social-simulation-purge-plan.ts` (pure; its header says exactly what is removed, what is kept, how posts are put back and
// what is refused). This file reads, plans and applies.
//   node dist/seed/social-simulation-purge.js            DRY RUN: reads only; prints, per company, the counts and every row it would touch
//   node dist/seed/social-simulation-purge.js --apply    removes them, ONE TRANSACTION PER COMPANY
// (dev checkout: npx tsx scripts/social-simulation-purge.ts <same arguments>)
//
// ── ORDER OF A RUN ─────────────────────────────────────────────────────────────────────────────────────────────────────
//   0. GLOBAL REFUSALS, before any company is read: the switch is ON (`SOCIAL_SIMULATION_ENABLED`: the purge is the step AFTER
//      switching off; with it on, the due job could publish a simulated variant mid-purge), or the catalogue shows a foreign
//      key into social_accounts, social_post_variants or social_publisher_orgs that the plan does not know
//      (`KNOWN_DEPENDENTS`): a new table must be classified before the purge may delete what it points at.
//   1. Per company (deleted companies too: their rows are rows), in one `withTenants([co], fn, {modules:['social']})`
//      transaction, so every read and write passes the third wall (an unset scope reads ZERO rows, which here would look
//      exactly like a clean database: the RLS zero-row trap):
//        a. lock the posts the purge looks at, `FOR UPDATE` in id order (the stage machine's own lock), then read the facts;
//        b. plan (pure). Any refusal: nothing is written for this company; the run goes on to the next and exits 2;
//        c. --apply only, in this ORDER (each child before its parent, so every foreign key holds at every step):
//             withdraw the undecided D14 publish approvals of the variants (status 'cancelled', the unschedule statement's)
//             -> social_post_metrics (simulated + manual, on those variants)   -> social_metrics_daily (simulated, on the accounts)
//             -> social_post_client_reviews (of those variants)                 -> social_best_time_suggestions (of the accounts)
//             -> social_boosts (simulated; hang off the posts, so they go BEFORE the posts are moved back: each is deleted while
//                its post still carries the simulated mark the statement restates. No foreign key points at a boost, and the
//                budgets, `social_boost_budgets`, are the client's agreements and stay)
//             -> social_posts: the restores and repairs (the variants are still there; the statements do not read them)
//             -> social_post_variants (on simulated accounts)                   -> social_accounts (simulated)
//             -> social_publisher_orgs (the simulator's, now empty)             -> the content-month progress of the cycles
//                                                                                   whose posts moved back (the pipeline's one writer)
//           Every statement names the exact ids of the plan AND restates the kind in its own WHERE (a simulated account, a
//           simulated source, a simulated boost on a simulated post, the simulator's key alias), so even a planner bug cannot reach a real row; every row count is
//           checked against the plan, and a mismatch throws, which rolls the whole company back;
//        d. the counts are read again inside the transaction (what the commit leaves).
//   2. After each company's commit: one activity row for the company and one per post moved back or repaired (never a caption
//      or a note; verb `simulated_variants_removed`, actor NULL), the way the prepare script logs its marking.
//
// It deletes and withdraws; it never INSERTs a social row, never UPDATEs a social_accounts or social_post_variants row (so it
// can never relabel a kind: trg_social_accounts_kind_guard), and never runs without --apply. It is idempotent: a second run
// finds nothing. It needs no switch to be on, and works with the simulator unregistered. The static pin in
// `social-simulation-purge.test.ts` holds this file to that list of statements.
import type { PoolClient } from "pg";
import { withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { writeActivity } from "../core/http";
import { ACCOUNT_KIND_VIOLATION_SQL, SOCIAL_SIMULATION_ENV, isSocialSimulationEnabled } from "../modules/social/publisher/simulation";
import { SOCIAL_PUBLISH_TOOL } from "../modules/social/publish-precondition";
import { syncContentMonthProgress } from "../modules/social/pipeline/content-month-progress";
import { syncCycleStepProgress } from "../modules/social/pipeline/cycle-steps";
import {
  RESTORE_ENGINE_STATUS, RESTORE_STATUS, SIMULATOR_ORG_KEY_REF, planIsEmpty, planPurge, renderPurgeReport, unknownDependents,
  type CompanyFacts, type CompanyOutcome, type FootprintCounts, type PurgePlan, type PurgeResult,
} from "./social-simulation-purge-plan";

const MODULES = { modules: ["social"] };
const SCRIPT = "social-simulation-purge";

/** The foreign keys into the three tables the purge deletes from, from the catalogue (readable by every role). */
async function readDependents(): Promise<Array<{ table: string; references: string }>> {
  const r = await withGlobal((c) => c.query<{ tbl: string; ref: string }>(
    `SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref
       FROM pg_constraint
      WHERE contype = 'f'
        AND confrelid IN (to_regclass('social_accounts'), to_regclass('social_post_variants'), to_regclass('social_publisher_orgs'))`,
  ));
  return r.rows.map((x) => ({ table: x.tbl, references: x.ref }));
}

/** The footprint counts of one company, in the caller's transaction. */
export async function countFootprint(c: PoolClient, tenantId: string): Promise<FootprintCounts> {
  const r = await c.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM social_accounts a WHERE a.tenant_id = $1 AND a.simulated) AS sa,
       (SELECT count(*) FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
         WHERE v.tenant_id = $1 AND a.simulated) AS vsa,
       (SELECT count(*) FROM social_post_variants v WHERE v.tenant_id = $1 AND v.simulated) AS sv,
       (SELECT count(*) FROM social_posts p WHERE p.tenant_id = $1 AND p.simulated) AS sp,
       (SELECT count(*) FROM social_post_metrics m WHERE m.tenant_id = $1 AND m.source = 'simulated') AS spm,
       (SELECT count(*) FROM social_metrics_daily m WHERE m.tenant_id = $1 AND m.source = 'simulated') AS sdm,
       (SELECT count(*) FROM social_publisher_orgs o WHERE o.tenant_id = $1 AND o.api_key_ref = $2) AS so,
       (SELECT count(*) FROM social_boosts b WHERE b.tenant_id = $1 AND b.simulated) AS sb`,
    [tenantId, SIMULATOR_ORG_KEY_REF],
  );
  const x = r.rows[0];
  return {
    simulatedAccounts: Number(x.sa), variantsOnSimulatedAccounts: Number(x.vsa), simulatedVariants: Number(x.sv), simulatedPosts: Number(x.sp),
    simulatedPostMetrics: Number(x.spm), simulatedDailyMetrics: Number(x.sdm), simulatorOrgs: Number(x.so),
    simulatedBoosts: Number(x.sb),
  };
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

/** Reads one company's facts, in the caller's transaction, after locking the posts it looks at. */
export async function readCompanyFacts(c: PoolClient, tenantId: string, company: string): Promise<CompanyFacts> {
  const counts = await countFootprint(c, tenantId);
  const touched = await c.query<{ id: string }>(
    `SELECT DISTINCT v.post_id AS id
       FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND (a.simulated OR v.simulated)
     UNION
     SELECT p.id FROM social_posts p WHERE p.tenant_id = $1 AND p.simulated
     UNION
     SELECT b.post_id FROM social_boosts b WHERE b.tenant_id = $1 AND b.simulated`,
    [tenantId],
  );
  const postIds = touched.rows.map((r) => r.id).sort();
  // The stage machine's own lock, in id order (no deadlock with a second purge, or with a stage action on one post).
  await c.query(`SELECT id FROM social_posts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE`, [tenantId, postIds]);

  const kind = await c.query<{ id: string }>(`SELECT a.id FROM social_accounts a WHERE a.tenant_id = $1 AND ${ACCOUNT_KIND_VIOLATION_SQL} ORDER BY a.id`, [tenantId]);
  const accounts = await c.query<{
    id: string; client_id: string; client_name: string | null; network: string; handle: string; integration_id: string | null; deleted: boolean; org_id: string;
  }>(
    `SELECT a.id, a.client_id, cl.name AS client_name, a.network, a.handle, a.postiz_integration_id AS integration_id,
            a.deleted_at IS NOT NULL AS deleted, a.publisher_org_id AS org_id
       FROM social_accounts a LEFT JOIN clients cl ON cl.id = a.client_id AND cl.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.simulated
      ORDER BY cl.name, a.network, a.handle, a.id`,
    [tenantId],
  );
  const variants = await c.query<{
    id: string; post_id: string; account_id: string; network: string; account_simulated: boolean; simulated: boolean; status: string;
    native_import: boolean; provider_post_id: string | null; published_url: string | null; published_at: Date | null; deleted: boolean;
  }>(
    `SELECT v.id, v.post_id, v.account_id, a.network, a.simulated AS account_simulated, v.simulated, v.status, v.native_import,
            v.provider_post_id, v.published_url, v.published_at, v.deleted_at IS NOT NULL AS deleted
       FROM social_post_variants v JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.post_id = ANY($2::uuid[])
      ORDER BY v.post_id, a.network, v.id`,
    [tenantId, postIds],
  );
  const posts = await c.query<{
    id: string; title: string; client_name: string | null; engagement_id: string; cycle_id: string | null; pipeline_status: string | null;
    schedule_via: string | null; live_url: string | null; went_live_at: Date | null; simulated: boolean; archived: boolean; deleted: boolean;
  }>(
    `SELECT p.id, p.title, cl.name AS client_name, p.engagement_id, p.cycle_id, p.pipeline_status, p.schedule_via, p.live_url,
            p.went_live_at, p.simulated, p.archived_at IS NOT NULL AS archived, p.deleted_at IS NOT NULL AS deleted
       FROM social_posts p
       LEFT JOIN social_engagements e ON e.id = p.engagement_id AND e.tenant_id = p.tenant_id
       LEFT JOIN clients cl ON cl.id = e.client_id AND cl.tenant_id = e.tenant_id
      WHERE p.tenant_id = $1 AND p.id = ANY($2::uuid[])
      ORDER BY p.id`,
    [tenantId, postIds],
  );
  // Every simulated boost, and every boost on a post above (so a REAL boost under a post the purge would move is seen and refused).
  // The boost row takes the PLAIN tenant wall (the portal writes it), so no module scope is needed to read it; the posts it names
  // are in `postIds` (locked above), and a boost request takes `FOR SHARE` on its post, so none can slip in under the lock.
  const boosts = await c.query<{ id: string; post_id: string; status: string; simulated: boolean }>(
    `SELECT b.id, b.post_id, b.status, b.simulated FROM social_boosts b
      WHERE b.tenant_id = $1 AND (b.simulated OR b.post_id = ANY($2::uuid[]))
      ORDER BY b.id`,
    [tenantId, postIds],
  );
  const postMetrics = await c.query<{ id: string; variant_id: string; source: string; account_simulated: boolean }>(
    `SELECT m.id, m.variant_id, m.source, a.simulated AS account_simulated
       FROM social_post_metrics m
       JOIN social_post_variants v ON v.id = m.variant_id AND v.tenant_id = m.tenant_id
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE m.tenant_id = $1 AND (a.simulated OR m.source = 'simulated')`,
    [tenantId],
  );
  const daily = await c.query<{ id: string; account_id: string; source: string; account_simulated: boolean }>(
    `SELECT m.id, m.account_id, m.source, a.simulated AS account_simulated
       FROM social_metrics_daily m JOIN social_accounts a ON a.id = m.account_id AND a.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND (a.simulated OR m.source = 'simulated')`,
    [tenantId],
  );
  const reviews = await c.query<{ id: string; variant_id: string }>(
    `SELECT r.id, r.variant_id
       FROM social_post_client_reviews r
       JOIN social_post_variants v ON v.id = r.variant_id AND v.tenant_id = r.tenant_id
       JOIN social_accounts a ON a.id = v.account_id AND a.tenant_id = v.tenant_id
      WHERE r.tenant_id = $1 AND a.simulated`,
    [tenantId],
  );
  const footprintIds = variants.rows.filter((v) => v.account_simulated).map((v) => v.id);
  const approvals = await c.query<{ id: string; variant_id: string }>(
    `SELECT ap.id, ap.tool_args->>'variantId' AS variant_id
       FROM automation_approvals ap
      WHERE ap.tenant_id = $1 AND ap.tool_name = $2 AND ap.status = 'pending' AND ap.deleted_at IS NULL
        AND ap.tool_args->>'variantId' = ANY($3::text[])`,
    [tenantId, SOCIAL_PUBLISH_TOOL, footprintIds],
  );
  const bestTime = await c.query<{ id: string; account_id: string }>(
    `SELECT b.id, b.account_id FROM social_best_time_suggestions b JOIN social_accounts a ON a.id = b.account_id AND a.tenant_id = b.tenant_id
      WHERE b.tenant_id = $1 AND a.simulated`,
    [tenantId],
  );
  // The rows only a real engine or a person's connect writes: ids only (never a token's ciphertext, never a message body).
  const ids = async (sql: string): Promise<string[]> => (await c.query<{ id: string }>(sql, [tenantId])).rows.map((r) => r.id).sort();
  const grants = await ids(
    `SELECT t.id FROM social_oauth_tokens t JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id WHERE t.tenant_id = $1 AND a.simulated`,
  );
  const oauthStates = await ids(
    `SELECT s.id FROM social_oauth_states s JOIN social_accounts a ON a.id = s.account_id AND a.tenant_id = s.tenant_id WHERE s.tenant_id = $1 AND a.simulated`,
  );
  const inboxThreads = await ids(
    `SELECT t.id FROM social_inbox_threads t
       JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
       LEFT JOIN social_post_variants v ON v.id = t.post_variant_id AND v.tenant_id = t.tenant_id
       LEFT JOIN social_accounts va ON va.id = v.account_id AND va.tenant_id = v.tenant_id
      WHERE t.tenant_id = $1 AND (a.simulated OR va.simulated IS TRUE)`,
  );
  const ledger = await ids(
    `SELECT l.id FROM social_usage_ledger l JOIN social_accounts a ON a.id = l.account_id AND a.tenant_id = l.tenant_id WHERE l.tenant_id = $1 AND a.simulated`,
  );
  const orgs = await c.query<{
    id: string; client_id: string; client_name: string | null; api_key_ref: string; postiz_org_id: string; real_accounts: number; simulated_accounts: number;
  }>(
    `SELECT o.id, o.client_id, cl.name AS client_name, o.api_key_ref, o.postiz_org_id,
            (SELECT count(*) FROM social_accounts x WHERE x.tenant_id = o.tenant_id AND x.publisher_org_id = o.id AND NOT x.simulated)::int AS real_accounts,
            (SELECT count(*) FROM social_accounts x WHERE x.tenant_id = o.tenant_id AND x.publisher_org_id = o.id AND x.simulated)::int AS simulated_accounts
       FROM social_publisher_orgs o LEFT JOIN clients cl ON cl.id = o.client_id AND cl.tenant_id = o.tenant_id
      WHERE o.tenant_id = $1
        AND (o.api_key_ref = $2
             OR EXISTS (SELECT 1 FROM social_accounts x WHERE x.tenant_id = o.tenant_id AND x.publisher_org_id = o.id AND x.simulated))
      ORDER BY cl.name, o.id`,
    [tenantId, SIMULATOR_ORG_KEY_REF],
  );

  return {
    tenantId, company, counts,
    kindViolations: kind.rows.map((r) => r.id),
    simulatedAccounts: accounts.rows.map((a) => ({
      id: a.id, clientId: a.client_id, clientName: a.client_name ?? "(unknown client)", network: a.network, handle: a.handle,
      integrationId: a.integration_id, deleted: a.deleted, orgId: a.org_id,
    })),
    variants: variants.rows.map((v) => ({
      id: v.id, postId: v.post_id, accountId: v.account_id, network: v.network, accountSimulated: v.account_simulated, simulated: v.simulated,
      status: v.status, nativeImport: v.native_import, providerPostId: v.provider_post_id, publishedUrl: v.published_url,
      publishedAt: iso(v.published_at), deleted: v.deleted,
    })),
    posts: posts.rows.map((p) => ({
      id: p.id, title: p.title, clientName: p.client_name ?? "(unknown client)", engagementId: p.engagement_id, cycleId: p.cycle_id,
      pipelineStatus: p.pipeline_status, scheduleVia: p.schedule_via, liveUrl: p.live_url, wentLiveAt: iso(p.went_live_at),
      simulated: p.simulated, archived: p.archived, deleted: p.deleted,
    })),
    boosts: boosts.rows.map((b) => ({ id: b.id, postId: b.post_id, status: b.status, simulated: b.simulated })),
    postMetrics: postMetrics.rows.map((m) => ({ id: m.id, variantId: m.variant_id, source: m.source, accountSimulated: m.account_simulated })),
    dailyMetrics: daily.rows.map((m) => ({ id: m.id, accountId: m.account_id, source: m.source, accountSimulated: m.account_simulated })),
    reviews: reviews.rows.map((r) => ({ id: r.id, variantId: r.variant_id })),
    pendingApprovals: approvals.rows.map((r) => ({ id: r.id, variantId: r.variant_id })),
    bestTime: bestTime.rows.map((b) => ({ id: b.id, accountId: b.account_id })),
    grants, oauthStates, inboxThreads, ledger,
    orgs: orgs.rows.map((o) => ({
      id: o.id, clientId: o.client_id, clientName: o.client_name ?? "(unknown client)", apiKeyRef: o.api_key_ref, postizOrgId: o.postiz_org_id,
      realAccounts: Number(o.real_accounts), simulatedAccounts: Number(o.simulated_accounts),
    })),
  };
}

/** One statement, its row count checked against the plan: a mismatch throws, rolling the whole company back. */
async function exact(c: PoolClient, what: string, expected: number, sql: string, params: unknown[]): Promise<void> {
  if (expected === 0) return;
  const r = await c.query(sql, params);
  if ((r.rowCount ?? 0) !== expected) {
    throw new Error(`${SCRIPT}: ${what}: planned ${expected} row(s) but ${r.rowCount ?? 0} matched. Rolled this company back; nothing changed in it.`);
  }
}

/** Applies a plan with no refusal, in the caller's transaction (header, step 1c). */
export async function applyPlan(c: PoolClient, p: PurgePlan): Promise<void> {
  const t = p.tenantId;
  await exact(c, "withdraw undecided publish approvals", p.withdrawApprovals.length,
    `UPDATE automation_approvals SET status = 'cancelled', updated_at = now()
      WHERE tenant_id = $1 AND tool_name = $2 AND status = 'pending' AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [t, SOCIAL_PUBLISH_TOOL, p.withdrawApprovals]);
  await exact(c, "social_post_metrics", p.deletePostMetrics.length,
    `DELETE FROM social_post_metrics m USING social_post_variants v, social_accounts a
      WHERE m.tenant_id = $1 AND m.id = ANY($2::uuid[]) AND m.source IN ('simulated', 'manual')
        AND v.id = m.variant_id AND v.tenant_id = m.tenant_id AND a.id = v.account_id AND a.tenant_id = v.tenant_id AND a.simulated = true`,
    [t, p.deletePostMetrics]);
  await exact(c, "social_metrics_daily", p.deleteDailyMetrics.length,
    `DELETE FROM social_metrics_daily m USING social_accounts a
      WHERE m.tenant_id = $1 AND m.id = ANY($2::uuid[]) AND m.source = 'simulated'
        AND a.id = m.account_id AND a.tenant_id = m.tenant_id AND a.simulated = true`,
    [t, p.deleteDailyMetrics]);
  await exact(c, "social_post_client_reviews", p.deleteReviews.length,
    `DELETE FROM social_post_client_reviews r USING social_post_variants v, social_accounts a
      WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])
        AND v.id = r.variant_id AND v.tenant_id = r.tenant_id AND a.id = v.account_id AND a.tenant_id = v.tenant_id AND a.simulated = true`,
    [t, p.deleteReviews]);
  await exact(c, "social_best_time_suggestions", p.deleteBestTime.length,
    `DELETE FROM social_best_time_suggestions b USING social_accounts a
      WHERE b.tenant_id = $1 AND b.id = ANY($2::uuid[]) AND a.id = b.account_id AND a.tenant_id = b.tenant_id AND a.simulated = true`,
    [t, p.deleteBestTime]);
  // Simulated boosts, before their posts are touched: the statement restates the boost's own mark AND its post's (both simulated).
  await exact(c, "social_boosts", p.deleteBoosts.length,
    `DELETE FROM social_boosts b USING social_posts sp
      WHERE b.tenant_id = $1 AND b.id = ANY($2::uuid[]) AND b.simulated = true
        AND sp.id = b.post_id AND sp.tenant_id = b.tenant_id AND sp.simulated = true`,
    [t, p.deleteBoosts.map((x) => x.id)]);
  // Posts moved back to the final check: only from a status the variants carried, never one scheduled or posted by hand.
  await exact(c, "social_posts moved back", p.restore.length,
    `UPDATE social_posts
        SET pipeline_status = '${RESTORE_STATUS}', status = $3, status_since = now(), schedule_via = NULL, live_url = NULL, went_live_at = NULL,
            simulated = false, last_action_id = NULL, last_action_at = now(), updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND pipeline_status IN ('client', 'approved', 'scheduled', 'live')
        AND schedule_via IS DISTINCT FROM 'manual' AND deleted_at IS NULL AND archived_at IS NULL`,
    [t, p.restore.map((x) => x.postId), RESTORE_ENGINE_STATUS]);
  for (const x of p.repair) {
    await exact(c, `social_posts repaired (${x.postId})`, 1,
      `UPDATE social_posts SET simulated = false, live_url = $3, went_live_at = $4, last_action_id = NULL, last_action_at = now(), updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND pipeline_status = 'live' AND deleted_at IS NULL AND archived_at IS NULL`,
      [t, x.postId, x.liveUrl, x.wentLiveAt]);
  }
  await exact(c, "social_post_variants", p.deleteVariants.length,
    `DELETE FROM social_post_variants v USING social_accounts a
      WHERE v.tenant_id = $1 AND v.id = ANY($2::uuid[]) AND a.id = v.account_id AND a.tenant_id = v.tenant_id AND a.simulated = true`,
    [t, p.deleteVariants]);
  await exact(c, "social_accounts", p.deleteAccounts.length,
    `DELETE FROM social_accounts WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND simulated = true`,
    [t, p.deleteAccounts]);
  await exact(c, "social_publisher_orgs", p.deleteOrgs.length,
    `DELETE FROM social_publisher_orgs o
      WHERE o.tenant_id = $1 AND o.id = ANY($2::uuid[]) AND o.api_key_ref = $3 AND o.postiz_org_id = 'simulated-' || o.client_id::text
        AND NOT EXISTS (SELECT 1 FROM social_accounts x WHERE x.tenant_id = o.tenant_id AND x.publisher_org_id = o.id)`,
    [t, p.deleteOrgs, SIMULATOR_ORG_KEY_REF]);
  // A post that left "past client approval" reopens its cycle's content-month task, through the pipeline's one writer of it, and then
  // its step tasks (SCP-5f), in the lock order.
  for (const cycleId of p.cycles) {
    await syncContentMonthProgress(c, t, cycleId, null);
    await syncCycleStepProgress(c, t, cycleId, null);
  }
}

/** `onlyTenantIds` is a TEST seam (a shared test database holds other suites' companies); the CLI never passes it. */
export async function purge(opts: { apply: boolean; onlyTenantIds?: readonly string[] }): Promise<PurgeResult> {
  if (isSocialSimulationEnabled()) {
    return {
      apply: opts.apply, companies: [], refusedCompanies: 0,
      globalRefusal: `${SOCIAL_SIMULATION_ENV} is on. Switch the simulator off and recreate the platform first (runbook step 5); the purge is the step after.`,
    };
  }
  const unknown = unknownDependents(await readDependents());
  if (unknown.length > 0) {
    return {
      apply: opts.apply, companies: [], refusedCompanies: 0,
      globalRefusal: `foreign keys the purge does not know point at a table it deletes from: ${unknown.join(", ")}. Classify them in `
        + "seed/social-simulation-purge-plan.ts (KNOWN_DEPENDENTS and the plan) before running it.",
    };
  }
  const all = await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM companies ORDER BY name, id`));
  const companies = opts.onlyTenantIds ? all.rows.filter((r) => opts.onlyTenantIds!.includes(r.id)) : all.rows;
  if (companies.length === 0) throw new Error(`${SCRIPT}: no companies. Refusing to report a clean database on no data.`);

  const outcomes: CompanyOutcome[] = [];
  for (const co of companies) {
    const outcome = await withTenants([co.id], async (c): Promise<CompanyOutcome> => {
      const facts = await readCompanyFacts(c, co.id, co.name);
      const plan = planPurge(facts);
      if (!opts.apply || plan.refusals.length > 0 || planIsEmpty(plan)) {
        return { plan, before: facts.counts, after: null, applied: false };
      }
      await applyPlan(c, plan);
      return { plan, before: facts.counts, after: await countFootprint(c, co.id), applied: true };
    }, MODULES);
    if (outcome.applied) await logOutcome(outcome.plan);
    outcomes.push(outcome);
  }
  return { apply: opts.apply, globalRefusal: null, companies: outcomes, refusedCompanies: outcomes.filter((o) => o.plan.refusals.length > 0).length };
}

/** After the commit: one activity row for the company, one per post moved back or repaired. Ids and counts only. */
async function logOutcome(p: PurgePlan): Promise<void> {
  await writeActivity(p.tenantId, null, "simulation_purged", "social_account", null, {
    script: SCRIPT, accountIds: p.deleteAccounts, variants: p.deleteVariants.length, reviews: p.deleteReviews.length,
    postMetrics: p.deletePostMetrics.length, manualPostMetrics: p.manualPostMetrics, dailyMetrics: p.deleteDailyMetrics.length,
    bestTime: p.deleteBestTime.length, boosts: p.deleteBoosts.length, boostIds: p.deleteBoosts.map((x) => x.id), orgIds: p.deleteOrgs, withdrawnApprovalIds: p.withdrawApprovals,
    movedBack: p.restore.map((x) => x.postId), repaired: p.repair.map((x) => x.postId),
  });
  for (const x of p.restore) {
    await writeActivity(p.tenantId, null, "simulated_variants_removed", "social_post", x.postId, {
      script: SCRIPT, from: x.from, to: RESTORE_STATUS, engagementId: x.engagementId, cycleId: x.cycleId, variantIds: x.removedVariantIds,
    });
  }
  for (const x of p.repair) {
    await writeActivity(p.tenantId, null, "simulated_variants_removed", "social_post", x.postId, {
      script: SCRIPT, from: "live", to: "live", variantIds: x.removedVariantIds, liveUrlReplaced: x.linkReplaced,
    });
  }
}

/** 0: every company purged (or had nothing). 2: a refusal anywhere, or an error. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const unknownArgs = argv.filter((a) => a !== "--apply");
    if (unknownArgs.length > 0) {
      console.error(`unknown argument(s): ${unknownArgs.join(" ")}. Usage: ${SCRIPT} [--apply]`);
      return 2;
    }
    const r = await purge({ apply: argv.includes("--apply") });
    for (const l of renderPurgeReport(r)) console.log(l);
    return r.globalRefusal !== null || r.refusedCompanies > 0 ? 2 : 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  // The switch is read from the container's environment by config.ts; say which value this run saw.
  console.log(`[${SCRIPT}] ${SOCIAL_SIMULATION_ENV}=${config.socialSimulationEnabled ? "on" : "off"}`);
  void main().then((code) => process.exit(code));
}
