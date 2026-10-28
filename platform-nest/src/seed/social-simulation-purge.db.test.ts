// SCP-Sf — the purge against REAL Postgres (needs DATABASE_URL_TEST: NOT run on the dev laptop, runs on the Linux CI gate; a skip
// is not a pass). The rules themselves are `social-simulation-purge.test.ts`.
//
// One mock agency holds the simulator's whole footprint BESIDE real rows (owner ruling SCP-D9: side by side, even for one client):
//   * "Brand Beta" (mock): only simulated accounts, under the org SCP-Sb creates (`simulated:no-key`, `simulated-<client id>`);
//     a pipeline post live through the simulator (simulated + typed-in metrics, a review, daily rows, a best-time row), one
//     scheduled through it (queued, an UNDECIDED publish approval), one at the final check with a variant, and a Composer post
//     (the CP-21 portal-demo shape) with a variant and a review;
//   * "Kopi Senja" (mock): a REAL LinkedIn account and simulated Instagram beside it, under ONE real-looking org (UNIQUE per
//     client); a post live on both kinds (its link the simulator's), and a post marked live BY HAND on the simulated account;
//   * "Real Co" (mock): a real Instagram account, a live real post, `pull` metrics and `pull` daily rows.
// Proves:
//   (P1) the DRY RUN plans exactly the footprint, reads the same counts the superuser sees (the third wall, the RLS zero-row trap),
//        and writes nothing;
//   (P2) `--apply` removes exactly the footprint, in one transaction; every real row is BYTE-IDENTICAL afterwards; posts are put
//        back as the plan says (final, kept, repaired), never deleted, their content untouched; the undecided approval is
//        withdrawn, not deleted; activity rows are written; the counts afterwards are zero;
//   (P3) a second run finds nothing and changes nothing (idempotent);
//   (P4) a company holding a shape it cannot classify (a PULLED metric row on a simulated account's variant) is REFUSED and
//        changes not at all;
//   (P5) the switch ON refuses the whole run before any company is read; an unknown table pointing at social_accounts does too.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../config";
import { newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createClient, createUser } from "../testing/fixtures";
import { SOCIAL_PUBLISH_TOOL } from "../modules/social/publish-precondition";
import { purge } from "./social-simulation-purge";
import { RESTORE_ENGINE_STATUS, renderPurgeReport } from "./social-simulation-purge-plan";

const SIM = "https://simulated.invalid";

describe.skipIf(!TEST_URL)("SCP-Sf · social-simulation-purge on real rows", () => {
  let co: string; // the mixed mock agency
  let bad: string; // the company holding an unclassifiable shape
  const id: Record<string, string> = {};
  const q = (sql: string, params: unknown[] = []) => adminPool().query(sql, params);

  async function org(t: string, clientId: string, keyRef: string, orgId: string): Promise<string> {
    const oid = newId();
    await q(`INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
             VALUES ($1,$2,$3,'postiz',$4,$5,'active','central')`, [oid, t, clientId, orgId, keyRef]);
    return oid;
  }
  async function account(t: string, clientId: string, orgId: string, network: string, handle: string, simulated: boolean): Promise<string> {
    const aid = newId();
    await q(`INSERT INTO social_accounts (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, connected_at, simulated, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'connected',now(),$8,'central')`,
    [aid, t, clientId, orgId, network, handle, simulated ? `simulated:${network}` : `int-${network}-${aid.slice(0, 8)}`, simulated]);
    return aid;
  }
  async function engagementAndCycle(t: string, clientId: string, name: string): Promise<{ engagementId: string; cycleId: string }> {
    const engagementId = newId();
    const cycleId = newId();
    await q(`INSERT INTO social_engagements (id, tenant_id, client_id, name, status) VALUES ($1,$2,$3,$4,'active')`, [engagementId, t, clientId, name]);
    await q(`INSERT INTO social_cycles (id, tenant_id, engagement_id, month, deadline, ready_by, origin_site)
             VALUES ($1,$2,$3,'2026-11-01','2026-10-28','2026-10-26','central')`, [cycleId, t, engagementId]);
    return { engagementId, cycleId };
  }
  async function pipelinePost(t: string, e: { engagementId: string; cycleId: string }, title: string, o: {
    status: string; via?: string | null; liveUrl?: string | null; wentLive?: Date | null; simulated?: boolean; status0105: string;
  }): Promise<string> {
    const pid = newId();
    await q(`INSERT INTO social_posts (id, tenant_id, engagement_id, cycle_id, title, brief, caption, hashtags, placement, format, status,
                                       pipeline_status, status_since, schedule_via, live_url, went_live_at, simulated, scheduled_at, origin_site)
             VALUES ($1,$2,$3,$4,$5,'A mock brief.','A mock caption.',ARRAY['mockbrand'],ARRAY['instagram'],'feed',$6,$7,now(),$8,$9,$10,$11,
                     '2026-11-10T09:30:00Z','central')`,
    [pid, t, e.engagementId, e.cycleId, title, o.status0105, o.status, o.via ?? null, o.liveUrl ?? null, o.wentLive ?? null, o.simulated ?? false]);
    return pid;
  }
  async function decidedApproval(t: string): Promise<string> {
    const aid = newId();
    await q(`INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, decided_at, origin, origin_site, execution_status)
             VALUES ($1,$2,'social:publish-variant',$3,'{}','high','approved',now(),'agent','main','executed')`, [aid, t, SOCIAL_PUBLISH_TOOL]);
    return aid;
  }
  async function variant(t: string, postId: string, accountId: string, o: {
    status: string; simulated?: boolean; approvalId?: string | null; providerPostId?: string | null; url?: string | null; at?: Date | null; nativeImport?: boolean;
  }): Promise<string> {
    const vid = newId();
    await q(`INSERT INTO social_post_variants (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, approval_id, provider_post_id,
                                               status, published_url, published_at, simulated, native_import, origin_site)
             VALUES ($1,$2,$3,$4,'A mock caption.','[]','{}','deadbeef',$5,$6,$7,$8,$9,$10,$11,'central')`,
    [vid, t, postId, accountId, o.approvalId ?? null, o.providerPostId ?? null, o.status, o.url ?? null, o.at ?? null, o.simulated ?? false, o.nativeImport ?? false]);
    return vid;
  }
  const metric = (t: string, variantId: string, source: string, enteredBy: string | null = null) =>
    q(`INSERT INTO social_post_metrics (id, tenant_id, variant_id, reach, likes, source, entered_by, fetched_at) VALUES ($1,$2,$3,100,10,$4,$5,now())`,
      [newId(), t, variantId, source, enteredBy]);
  const daily = (t: string, accountId: string, day: string, source: string) =>
    q(`INSERT INTO social_metrics_daily (id, tenant_id, account_id, date, followers, reach, source) VALUES ($1,$2,$3,$4,500,900,$5)`,
      [newId(), t, accountId, day, source]);
  const review = (t: string, variantId: string, clientId: string) =>
    q(`INSERT INTO social_post_client_reviews (id, tenant_id, variant_id, client_id, status, decided_at) VALUES ($1,$2,$3,$4,'approved',now())`,
      [newId(), t, variantId, clientId]);

  /** Every row of every social table of a company, as JSON, by table: the "byte-identical" yardstick. */
  async function everything(t: string): Promise<Record<string, Record<string, unknown>>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (const table of [
      "social_publisher_orgs", "social_accounts", "social_posts", "social_post_variants", "social_post_metrics", "social_metrics_daily",
      "social_post_client_reviews", "social_best_time_suggestions", "automation_approvals",
    ]) {
      const r = await q(`SELECT id, row_to_json(x)::text AS j FROM ${table} x WHERE tenant_id = $1`, [t]);
      out[table] = Object.fromEntries(r.rows.map((row: { id: string; j: string }) => [row.id, row.j]));
    }
    return out;
  }

  let user: string;
  beforeAll(async () => {
    await initTestDb();
    config.socialSimulationEnabled = false;
    co = await createCompany("SCP-Sf Mock Agency", ["social"]);
    bad = await createCompany("SCP-Sf Unclassifiable Mock", ["social"]);
    user = await createUser("officer@scp-sf.test", "Mock Officer");
    const wentLive = new Date("2026-10-20T10:00:00Z");

    // Brand Beta: the simulator's own org and accounts only.
    const beta = await createClient(co, "Brand Beta");
    id.betaOrg = await org(co, beta, "simulated:no-key", `simulated-${beta}`);
    id.betaIg = await account(co, beta, id.betaOrg, "instagram", "@mock-brand-beta", true);
    id.betaFb = await account(co, beta, id.betaOrg, "facebook", "@mock-brand-beta", true);
    const be = await engagementAndCycle(co, beta, "Brand Beta social");
    id.betaCycle = be.cycleId;
    id.pLive = await pipelinePost(co, be, "Beta live", { status: "live", via: "publisher", liveUrl: `${SIM}/instagram/1`, wentLive, simulated: true, status0105: "published" });
    id.vLive = await variant(co, id.pLive, id.betaIg, { status: "published", simulated: true, approvalId: await decidedApproval(co), providerPostId: `simulated:instagram:1:${newId()}`, url: `${SIM}/instagram/1`, at: wentLive });
    await metric(co, id.vLive, "simulated");
    await metric(co, id.vLive, "manual", user);
    await review(co, id.vLive, beta);
    await daily(co, id.betaIg, "2026-10-21", "simulated");
    await daily(co, id.betaIg, "2026-10-22", "simulated");
    await q(`INSERT INTO social_best_time_suggestions (tenant_id, account_id, status, min_measured_posts_threshold, min_bucket_posts_threshold, lookback_days, raw)
             VALUES ($1,$2,'insufficient_evidence',5,2,90,'{}')`, [co, id.betaIg]);
    id.pSched = await pipelinePost(co, be, "Beta scheduled", { status: "scheduled", via: "publisher", status0105: "scheduled" });
    id.vSched = await variant(co, id.pSched, id.betaFb, { status: "approved" });
    id.pending = newId();
    await q(`INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, status, origin, origin_site)
             VALUES ($1,$2,'social:publish-variant',$3,$4,'high','pending','agent','main')`, [id.pending, co, SOCIAL_PUBLISH_TOOL, JSON.stringify({ variantId: id.vSched })]);
    id.pFinal = await pipelinePost(co, be, "Beta at the final check", { status: "final", status0105: "draft" });
    id.vFinal = await variant(co, id.pFinal, id.betaIg, { status: "draft" });
    id.pComposer = newId();
    await q(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, status, origin_site) VALUES ($1,$2,$3,'Beta portal demo','in_review','central')`, [id.pComposer, co, be.engagementId]);
    id.vComposer = await variant(co, id.pComposer, id.betaIg, { status: "in_review" });
    await review(co, id.vComposer, beta);

    // Kopi Senja: one real-looking org, a REAL LinkedIn and a simulated Instagram.
    const kopi = await createClient(co, "Kopi Senja");
    id.kopiOrg = await org(co, kopi, "default", `org-${kopi}`);
    id.kopiLi = await account(co, kopi, id.kopiOrg, "linkedin", "@kopisenja", false);
    id.kopiIg = await account(co, kopi, id.kopiOrg, "instagram", "@mock-kopi-senja", true);
    const ke = await engagementAndCycle(co, kopi, "Kopi Senja social");
    id.pBoth = await pipelinePost(co, ke, "Kopi on both kinds", { status: "live", via: "publisher", liveUrl: `${SIM}/instagram/2`, wentLive, simulated: true, status0105: "published" });
    id.vBothSim = await variant(co, id.pBoth, id.kopiIg, { status: "published", simulated: true, approvalId: await decidedApproval(co), providerPostId: `simulated:instagram:2:${newId()}`, url: `${SIM}/instagram/2`, at: wentLive });
    id.vBothReal = await variant(co, id.pBoth, id.kopiLi, { status: "published", approvalId: await decidedApproval(co), providerPostId: "li-urn-1", url: "https://www.linkedin.com/feed/update/mock-1", at: new Date("2026-10-20T09:00:00Z") });
    await metric(co, id.vBothReal, "pull");
    id.pHand = await pipelinePost(co, ke, "Kopi posted by hand", { status: "live", via: "manual", liveUrl: "https://www.instagram.com/p/MOCKHAND", wentLive, status0105: "published" });
    id.vHand = await variant(co, id.pHand, id.kopiIg, { status: "published", nativeImport: true, url: "https://www.instagram.com/p/MOCKHAND", at: wentLive });
    await metric(co, id.vHand, "manual", user);

    // Real Co: real rows only.
    const real = await createClient(co, "Real Co");
    id.realOrg = await org(co, real, "default", `org-${real}`);
    id.realIg = await account(co, real, id.realOrg, "instagram", "@realco", false);
    const re = await engagementAndCycle(co, real, "Real Co social");
    id.pReal = await pipelinePost(co, re, "Real live", { status: "live", via: "publisher", liveUrl: "https://www.instagram.com/p/REAL1", wentLive, status0105: "published" });
    id.vReal = await variant(co, id.pReal, id.realIg, { status: "published", approvalId: await decidedApproval(co), providerPostId: "ig-real-1", url: "https://www.instagram.com/p/REAL1", at: wentLive });
    await metric(co, id.vReal, "pull");
    await daily(co, id.realIg, "2026-10-21", "pull");

    // The unclassifiable company: a PULLED metric row on a simulated account's variant (only a real engine writes `pull`).
    const odd = await createClient(bad, "Odd Mock");
    const oddOrg = await org(bad, odd, "simulated:no-key", `simulated-${odd}`);
    const oddIg = await account(bad, odd, oddOrg, "instagram", "@mock-odd", true);
    const oe = await engagementAndCycle(bad, odd, "Odd social");
    const oddPost = await pipelinePost(bad, oe, "Odd post", { status: "final", status0105: "draft" });
    id.oddVariant = await variant(bad, oddPost, oddIg, { status: "draft" });
    await metric(bad, id.oddVariant, "pull");
  }, 120_000);
  afterAll(async () => {
    config.socialSimulationEnabled = false;
    await teardownTestDb();
  });

  const realRows = async () => {
    const all = await everything(co);
    const keep = (table: string, ids: string[]) => ids.map((x) => all[table][x]);
    const metricsOf = async (variantIds: string[]) =>
      (await q(`SELECT row_to_json(m)::text AS j FROM social_post_metrics m WHERE variant_id = ANY($1::uuid[]) ORDER BY id`, [variantIds])).rows.map((r: { j: string }) => r.j);
    return {
      orgs: keep("social_publisher_orgs", [id.kopiOrg, id.realOrg]),
      accounts: keep("social_accounts", [id.kopiLi, id.realIg]),
      variants: keep("social_post_variants", [id.vBothReal, id.vReal]),
      posts: keep("social_posts", [id.pReal]),
      metrics: await metricsOf([id.vBothReal, id.vReal]),
      daily: (await q(`SELECT row_to_json(m)::text AS j FROM social_metrics_daily m WHERE account_id = $1 ORDER BY id`, [id.realIg])).rows.map((r: { j: string }) => r.j),
    };
  };

  it("(P1) the dry run plans exactly the footprint, sees what the superuser sees, and writes nothing", async () => {
    const before = await everything(co);
    const r = await purge({ apply: false, onlyTenantIds: [co] });
    expect(await everything(co)).toEqual(before);
    expect(r.globalRefusal).toBeNull();
    const o = r.companies[0];
    expect(o.applied).toBe(false);
    expect(o.plan.refusals).toEqual([]);
    expect(o.plan.deleteAccounts.sort()).toEqual([id.betaIg, id.betaFb, id.kopiIg].sort());
    expect(o.plan.deleteVariants.sort()).toEqual([id.vLive, id.vSched, id.vFinal, id.vComposer, id.vBothSim, id.vHand].sort());
    expect(o.plan.deletePostMetrics).toHaveLength(3); // simulated + typed-in on the live one, typed-in on the hand-posted one
    expect(o.plan.manualPostMetrics).toBe(2);
    expect(o.plan.deleteDailyMetrics).toHaveLength(2);
    expect(o.plan.deleteReviews).toHaveLength(2);
    expect(o.plan.deleteBestTime).toHaveLength(1);
    expect(o.plan.withdrawApprovals).toEqual([id.pending]);
    expect(o.plan.deleteOrgs).toEqual([id.betaOrg]);
    expect(o.plan.leftOrgs.map((l) => l.orgId)).toEqual([id.kopiOrg]);
    expect(o.plan.restore.map((x) => x.postId).sort()).toEqual([id.pLive, id.pSched].sort());
    expect(o.plan.repair.map((x) => x.postId)).toEqual([id.pBoth]);
    expect(o.plan.kept.map((x) => x.postId).sort()).toEqual([id.pFinal, id.pComposer, id.pHand].sort());
    // The third wall: the counts read through RLS equal the superuser's.
    const su = (await q(
      `SELECT (SELECT count(*) FROM social_accounts WHERE tenant_id = $1 AND simulated)::int AS sa,
              (SELECT count(*) FROM social_post_variants WHERE tenant_id = $1 AND simulated)::int AS sv,
              (SELECT count(*) FROM social_metrics_daily WHERE tenant_id = $1 AND source = 'simulated')::int AS sdm`, [co])).rows[0];
    expect(o.before).toMatchObject({ simulatedAccounts: su.sa, simulatedVariants: su.sv, simulatedDailyMetrics: su.sdm });
    expect(o.before.simulatedAccounts).toBe(3);
    const text = renderPurgeReport(r).join("\n");
    expect(text).toMatch(/^DRY RUN/);
    expect(text).not.toContain("A mock caption.");
  });

  it("(P2) --apply removes exactly the footprint; real rows are byte-identical; posts are put back, never deleted", async () => {
    const realBefore = await realRows();
    const postsBefore = (await q(`SELECT id, title, brief, caption, hashtags, placement, scheduled_at, cycle_id FROM social_posts WHERE tenant_id = $1 ORDER BY id`, [co])).rows;
    const r = await purge({ apply: true, onlyTenantIds: [co] });
    const o = r.companies[0];
    expect(o.applied).toBe(true);
    expect(r.refusedCompanies).toBe(0);
    expect(o.after).toEqual({
      simulatedAccounts: 0, variantsOnSimulatedAccounts: 0, simulatedVariants: 0, simulatedPosts: 0, simulatedPostMetrics: 0,
      simulatedDailyMetrics: 0, simulatorOrgs: 0,
    });
    expect(await realRows()).toEqual(realBefore);
    // No post was deleted, and no post's content or date moved.
    expect((await q(`SELECT id, title, brief, caption, hashtags, placement, scheduled_at, cycle_id FROM social_posts WHERE tenant_id = $1 ORDER BY id`, [co])).rows).toEqual(postsBefore);

    const post = async (pid: string) => (await q(`SELECT pipeline_status, status, schedule_via, live_url, went_live_at, simulated, deleted_at FROM social_posts WHERE id = $1`, [pid])).rows[0];
    for (const pid of [id.pLive, id.pSched]) {
      expect(await post(pid)).toMatchObject({ pipeline_status: "final", status: RESTORE_ENGINE_STATUS, schedule_via: null, live_url: null, went_live_at: null, simulated: false, deleted_at: null });
    }
    expect(await post(id.pFinal)).toMatchObject({ pipeline_status: "final", simulated: false });
    expect(await post(id.pHand)).toMatchObject({ pipeline_status: "live", schedule_via: "manual", live_url: "https://www.instagram.com/p/MOCKHAND" });
    expect(await post(id.pBoth)).toMatchObject({ pipeline_status: "live", schedule_via: "publisher", live_url: "https://www.linkedin.com/feed/update/mock-1", simulated: false });
    expect(new Date((await post(id.pBoth)).went_live_at).toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(await post(id.pComposer)).toMatchObject({ pipeline_status: null, status: "in_review" });

    // The undecided approval is withdrawn, not deleted; decided ones are history and stay.
    expect((await q(`SELECT status FROM automation_approvals WHERE id = $1`, [id.pending])).rows[0].status).toBe("cancelled");
    expect(Number((await q(`SELECT count(*) FROM automation_approvals WHERE tenant_id = $1 AND status = 'approved'`, [co])).rows[0].count)).toBe(4);
    // The simulator's org is gone; Kopi Senja's org (it holds the real LinkedIn) stays.
    expect((await q(`SELECT id FROM social_publisher_orgs WHERE tenant_id = $1 ORDER BY id`, [co])).rows.map((x: { id: string }) => x.id).sort()).toEqual([id.kopiOrg, id.realOrg].sort());
    expect(Number((await q(`SELECT count(*) FROM social_post_client_reviews WHERE tenant_id = $1`, [co])).rows[0].count)).toBe(0);
    expect(Number((await q(`SELECT count(*) FROM social_best_time_suggestions WHERE tenant_id = $1`, [co])).rows[0].count)).toBe(0);
    // History: one company row and one row per post moved back or repaired, actor NULL, no caption anywhere.
    const acts = (await q(`SELECT verb, target_entity_id, metadata::text AS m FROM activities WHERE tenant_id = $1 AND verb IN ('simulation_purged','simulated_variants_removed')`, [co])).rows;
    expect(acts.filter((a: { verb: string }) => a.verb === "simulation_purged")).toHaveLength(1);
    expect(acts.filter((a: { verb: string }) => a.verb === "simulated_variants_removed").map((a: { target_entity_id: string }) => a.target_entity_id).sort())
      .toEqual([id.pLive, id.pSched, id.pBoth].sort());
    expect(acts.some((a: { m: string }) => a.m.includes("A mock caption."))).toBe(false);
  });

  it("(P3) a second run finds nothing and changes nothing", async () => {
    const before = await everything(co);
    const r = await purge({ apply: true, onlyTenantIds: [co] });
    expect(await everything(co)).toEqual(before);
    expect(r.companies[0].applied).toBe(false);
    expect(r.companies[0].plan.refusals).toEqual([]);
    expect(r.companies[0].plan.deleteVariants).toEqual([]);
    expect(r.companies[0].plan.restore).toEqual([]);
  });

  it("(P4) a company with a pulled metric row on a simulated account's variant is refused and changes not at all", async () => {
    const before = await everything(bad);
    const r = await purge({ apply: true, onlyTenantIds: [bad] });
    expect(await everything(bad)).toEqual(before);
    expect(r.refusedCompanies).toBe(1);
    expect(r.companies[0].plan.refusals.map((x) => x.code)).toEqual(["pulled_metric_on_simulated_variant"]);
    expect(renderPurgeReport(r).join("\n")).toMatch(/REFUSED: nothing changed in this company/);
  });

  it("(P5) the switch ON, or an unknown table pointing at social_accounts, refuses the run before any company is read", async () => {
    const before = await everything(bad);
    config.socialSimulationEnabled = true;
    try {
      const r = await purge({ apply: true, onlyTenantIds: [bad] });
      expect(r.globalRefusal).toMatch(/SOCIAL_SIMULATION_ENABLED is on/);
      expect(r.companies).toEqual([]);
    } finally {
      config.socialSimulationEnabled = false;
    }
    await q(`CREATE TABLE scp_sf_probe (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, account_id uuid NOT NULL,
             CONSTRAINT fk_scp_sf_probe FOREIGN KEY (account_id, tenant_id) REFERENCES social_accounts (id, tenant_id))`);
    try {
      const r = await purge({ apply: true, onlyTenantIds: [bad] });
      expect(r.globalRefusal).toMatch(/scp_sf_probe -> social_accounts/);
    } finally {
      await q(`DROP TABLE scp_sf_probe`);
    }
    expect(await everything(bad)).toEqual(before);
  });
});
