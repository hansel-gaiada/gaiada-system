// SCP-Sf — the purge's rules, its report and its statements, proved WITHOUT a database (runs anywhere). The same rules against
// real rows (dry run, apply, a mixed company kept byte-identical, refusal, idempotence) are `social-simulation-purge.db.test.ts`.
//
// What this file pins:
//   (R1) the footprint: every variant on a simulated account and its dependent rows, the simulated daily rows, the best-time
//        cache, the simulated accounts, and the simulator's own orgs once empty; never a real account's row;
//   (R2) posts: back to `final` when their variants were all on simulated accounts and the status rested on them; kept as they
//        are before the client, when scheduled or posted BY HAND, when Composer, archived or deleted; repaired when live on
//        both kinds; never deleted;
//   (R3) every refusal code, each on the one shape it names, and a refused plan still says what it would have done;
//   (R4) the schema the purge knows equals the foreign keys the migrations declare (a new table fails here first);
//   (R5) the purge's own SQL: it deletes only with the kind restated in each statement, updates only approvals and posts,
//        inserts nothing, and never writes a social_accounts or social_post_variants row;
//   (R6) the report says what it did in words, ids and titles only.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SIMULATED_ORG_KEY_REF } from "../modules/social/simulated-accounts";
import {
  KNOWN_DEPENDENTS, REFUSAL_WORDS, RESTORE_ENGINE_STATUS, RESTORE_STATUS, SIMULATOR_ORG_KEY_REF, planIsEmpty, planPurge, renderPurgeReport,
  simulatorOrgId, unknownDependents,
  type CompanyFacts, type FootprintCounts, type PurgePlan, type PurgePost, type PurgeRefusalCode, type PurgeVariant,
} from "./social-simulation-purge-plan";

const T = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const CLIENT = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a60";
const ZERO: FootprintCounts = {
  simulatedAccounts: 0, variantsOnSimulatedAccounts: 0, simulatedVariants: 0, simulatedPosts: 0, simulatedPostMetrics: 0,
  simulatedDailyMetrics: 0, simulatorOrgs: 0,
};
const SIM_URL = "https://simulated.invalid/instagram/0190";

const facts = (over: Partial<CompanyFacts> = {}): CompanyFacts => ({
  tenantId: T, company: "Mock Agency", kindViolations: [], simulatedAccounts: [], variants: [], posts: [], postMetrics: [], dailyMetrics: [],
  reviews: [], pendingApprovals: [], bestTime: [], grants: [], oauthStates: [], inboxThreads: [], ledger: [], orgs: [], counts: ZERO, ...over,
});
const simAcct = (id: string, network = "instagram") => ({
  id, clientId: CLIENT, clientName: "Kopi Senja", network, handle: "@mock-kopi-senja", integrationId: `simulated:${network}`, deleted: false, orgId: "org-sim",
});
const variant = (id: string, postId: string, over: Partial<PurgeVariant> = {}): PurgeVariant => ({
  id, postId, accountId: "acct-sim-ig", network: "instagram", accountSimulated: true, simulated: false, status: "draft", nativeImport: false,
  providerPostId: null, publishedUrl: null, publishedAt: null, deleted: false, ...over,
});
const post = (id: string, over: Partial<PurgePost> = {}): PurgePost => ({
  id, title: `Post ${id}`, clientName: "Kopi Senja", engagementId: "eng-1", cycleId: "cyc-1", pipelineStatus: "approved", scheduleVia: null,
  liveUrl: null, wentLiveAt: null, simulated: false, archived: false, deleted: false, ...over,
});
const simLive = (id: string): { p: PurgePost; v: PurgeVariant } => ({
  p: post(id, { pipelineStatus: "live", scheduleVia: "publisher", liveUrl: SIM_URL, wentLiveAt: "2026-10-20T10:00:00.000Z", simulated: true }),
  v: variant(`v-${id}`, id, { simulated: true, status: "published", providerPostId: `simulated:instagram:1:${id}`, publishedUrl: SIM_URL, publishedAt: "2026-10-20T10:00:00.000Z" }),
});
const codes = (p: PurgePlan): PurgeRefusalCode[] => p.refusals.map((r) => r.code).sort();

describe("SCP-Sf · the fingerprints the purge relies on", () => {
  it("the simulator's org key alias and org id are SCP-Sb's own", () => {
    expect(SIMULATOR_ORG_KEY_REF).toBe(SIMULATED_ORG_KEY_REF);
    expect(simulatorOrgId(CLIENT)).toBe(`simulated-${CLIENT}`);
  });
  it("a restored post goes to the final check with the fixture's engine status for it", () => {
    expect(RESTORE_STATUS).toBe("final");
    expect(RESTORE_ENGINE_STATUS).toBe("draft");
  });
});

describe("SCP-Sf (R1) · the footprint", () => {
  it("an empty company plans nothing", () => {
    const p = planPurge(facts());
    expect(planIsEmpty(p)).toBe(true);
    expect(p.refusals).toEqual([]);
  });

  it("removes every variant on a simulated account (published or not, soft-deleted too), its simulated and typed-in metrics, its reviews, and withdraws its undecided approvals", () => {
    const { p, v } = simLive("p1");
    const draft = variant("v-draft", "p2", { status: "approved" });
    const gone = variant("v-gone", "p2", { deleted: true });
    const plan = planPurge(facts({
      simulatedAccounts: [simAcct("acct-sim-ig")],
      variants: [v, draft, gone],
      posts: [p, post("p2", { pipelineStatus: "drafting" })],
      postMetrics: [
        { id: "m-sim", variantId: v.id, source: "simulated", accountSimulated: true },
        { id: "m-typed", variantId: v.id, source: "manual", accountSimulated: true },
      ],
      dailyMetrics: [{ id: "d-sim", accountId: "acct-sim-ig", source: "simulated", accountSimulated: true }],
      reviews: [{ id: "r1", variantId: v.id }, { id: "r2", variantId: draft.id }],
      pendingApprovals: [{ id: "ap1", variantId: draft.id }],
      bestTime: [{ id: "bt1", accountId: "acct-sim-ig" }],
    }));
    expect(plan.refusals).toEqual([]);
    expect(plan.deleteVariants.sort()).toEqual(["v-draft", "v-gone", "v-p1"]);
    expect(plan.deletePostMetrics.sort()).toEqual(["m-sim", "m-typed"]);
    expect(plan.manualPostMetrics).toBe(1);
    expect(plan.deleteDailyMetrics).toEqual(["d-sim"]);
    expect(plan.deleteReviews.sort()).toEqual(["r1", "r2"]);
    expect(plan.withdrawApprovals).toEqual(["ap1"]);
    expect(plan.deleteBestTime).toEqual(["bt1"]);
    expect(plan.deleteAccounts).toEqual(["acct-sim-ig"]);
  });

  it("never plans a row of a real account: its variants, reviews and approvals are not in the plan", () => {
    const real = variant("v-real", "p1", { accountId: "acct-real-li", network: "linkedin", accountSimulated: false, status: "published", publishedUrl: "https://www.linkedin.com/feed/update/1", publishedAt: "2026-10-20T09:00:00.000Z" });
    const { v } = simLive("p1");
    const plan = planPurge(facts({
      simulatedAccounts: [simAcct("acct-sim-ig")], variants: [v, real],
      posts: [post("p1", { pipelineStatus: "live", scheduleVia: "publisher", liveUrl: SIM_URL, wentLiveAt: "2026-10-20T10:00:00.000Z", simulated: true })],
      reviews: [{ id: "r-real", variantId: real.id }], pendingApprovals: [{ id: "ap-real", variantId: real.id }],
    }));
    expect(plan.deleteVariants).toEqual(["v-p1"]);
    expect(plan.deleteReviews).toEqual([]);
    expect(plan.withdrawApprovals).toEqual([]);
  });

  it("orgs: the simulator's own, empty, goes; one holding a real account, one with another id, and a non-simulator org are left with the reason", () => {
    const org = (id: string, over: Partial<CompanyFacts["orgs"][number]> = {}) => ({
      id, clientId: CLIENT, clientName: "Kopi Senja", apiKeyRef: SIMULATOR_ORG_KEY_REF, postizOrgId: simulatorOrgId(CLIENT), realAccounts: 0, simulatedAccounts: 2, ...over,
    });
    const plan = planPurge(facts({
      orgs: [
        org("o-sim"), org("o-real", { realAccounts: 1 }), org("o-odd", { postizOrgId: "simulated-elsewhere" }),
        org("o-cp21", { apiKeyRef: "seed:portal-demo-no-key", postizOrgId: `seed-${CLIENT}` }),
      ],
    }));
    expect(plan.deleteOrgs).toEqual(["o-sim"]);
    const left = Object.fromEntries(plan.leftOrgs.map((l) => [l.orgId, l.why]));
    expect(left["o-real"]).toMatch(/1 real account/);
    expect(left["o-odd"]).toMatch(/not its org id/);
    expect(left["o-cp21"]).toMatch(/not created by the simulator/);
  });
});

describe("SCP-Sf (R2) · posts are put back to a state a person can act on, never deleted", () => {
  it.each(["client", "approved", "scheduled", "live"])("a %s post whose variants were all on simulated accounts goes back to the final check", (status) => {
    const p = status === "live" ? simLive("p1").p : post("p1", { pipelineStatus: status, scheduleVia: status === "scheduled" ? "publisher" : null });
    const v = status === "live" ? simLive("p1").v : variant("v1", "p1", { status: status === "scheduled" ? "queued" : "approved", providerPostId: status === "scheduled" ? "simulated:instagram:1:x" : null });
    const plan = planPurge(facts({ simulatedAccounts: [simAcct("acct-sim-ig")], variants: [v], posts: [p] }));
    expect(plan.refusals).toEqual([]);
    expect(plan.restore).toEqual([{ postId: "p1", title: "Post p1", clientName: "Kopi Senja", engagementId: "eng-1", cycleId: "cyc-1", from: status, removedVariantIds: [v.id] }]);
    expect(plan.cycles).toEqual(["cyc-1"]);
  });

  it.each(["planned", "drafting", "proofread", "hod", "design", "final", "changes", "blocked"])("a %s post keeps its status; only its variants go", (status) => {
    const plan = planPurge(facts({ variants: [variant("v1", "p1")], posts: [post("p1", { pipelineStatus: status })] }));
    expect(plan.restore).toEqual([]);
    expect(plan.kept).toMatchObject([{ postId: "p1", status, why: expect.stringMatching(/final_approve/) }]);
    expect(plan.deleteVariants).toEqual(["v1"]);
  });

  it("a post scheduled or marked live BY HAND is kept as it is (a person's record of the outside world)", () => {
    const hand = post("p1", { pipelineStatus: "live", scheduleVia: "manual", liveUrl: "https://www.instagram.com/p/MOCK1", wentLiveAt: "2026-10-20T10:00:00.000Z" });
    const v = variant("v1", "p1", { nativeImport: true, status: "published", publishedUrl: hand.liveUrl, publishedAt: hand.wentLiveAt });
    const plan = planPurge(facts({ variants: [v], posts: [hand, post("p2", { pipelineStatus: "scheduled", scheduleVia: "manual" })] }));
    expect(plan.refusals).toEqual([]); // a hand-posted link on a simulated account's variant is a native import, not a refusal
    expect(plan.restore).toEqual([]);
    expect(plan.kept.map((k) => k.postId)).toEqual(["p1"]);
    expect(plan.kept[0].why).toMatch(/BY HAND/);
    expect(plan.deleteVariants).toEqual(["v1"]);
  });

  it("a Composer, an archived and a deleted post are left exactly as they are", () => {
    const plan = planPurge(facts({
      variants: [variant("v1", "c1"), variant("v2", "a1"), variant("v3", "d1")],
      posts: [post("c1", { pipelineStatus: null, cycleId: null }), post("a1", { archived: true }), post("d1", { deleted: true })],
    }));
    expect(plan.restore).toEqual([]);
    expect(plan.kept.map((k) => k.postId).sort()).toEqual(["a1", "c1", "d1"]);
    expect(plan.deleteVariants.sort()).toEqual(["v1", "v2", "v3"]);
  });

  it("a post live on BOTH kinds keeps live, loses its simulated mark, and takes the first real link (network, id) and the latest real time", () => {
    const { p, v } = simLive("p1");
    const li = variant("v-li", "p1", { network: "linkedin", accountId: "acct-li", accountSimulated: false, status: "published", publishedUrl: "https://www.linkedin.com/feed/update/9", publishedAt: "2026-10-20T09:00:00.000Z" });
    const fb = variant("v-fb", "p1", { network: "facebook", accountId: "acct-fb", accountSimulated: false, status: "published", publishedUrl: "https://www.facebook.com/mock/posts/3", publishedAt: "2026-10-20T09:30:00.000Z" });
    const plan = planPurge(facts({ variants: [v, li, fb], posts: [p] }));
    expect(plan.refusals).toEqual([]);
    expect(plan.restore).toEqual([]);
    expect(plan.repair).toEqual([{ postId: "p1", title: "Post p1", liveUrl: "https://www.facebook.com/mock/posts/3", wentLiveAt: "2026-10-20T09:30:00.000Z", linkReplaced: true, removedVariantIds: ["v-p1"] }]);
  });

  it("a post on both kinds that is not live keeps its status (the real variants carry it)", () => {
    const real = variant("v-li", "p1", { network: "linkedin", accountId: "acct-li", accountSimulated: false, status: "queued" });
    const plan = planPurge(facts({ variants: [variant("v1", "p1", { status: "queued" }), real], posts: [post("p1", { pipelineStatus: "scheduled", scheduleVia: "publisher" })] }));
    expect(plan.repair).toEqual([]);
    expect(plan.restore).toEqual([]);
    expect(plan.kept).toMatchObject([{ postId: "p1", why: expect.stringMatching(/real accounts/) }]);
  });

  it("a soft-deleted real variant does not count as one that carries the status", () => {
    const realGone = variant("v-li", "p1", { network: "linkedin", accountId: "acct-li", accountSimulated: false, deleted: true });
    const plan = planPurge(facts({ variants: [variant("v1", "p1", { status: "approved" }), realGone], posts: [post("p1", { pipelineStatus: "approved" })] }));
    expect(plan.restore.map((r) => r.postId)).toEqual(["p1"]);
    expect(plan.deleteVariants).toEqual(["v1"]);
  });
});

describe("SCP-Sf (R3) · refusals: any shape it cannot classify changes nothing in the company", () => {
  const CASES: Array<[PurgeRefusalCode, Partial<CompanyFacts>]> = [
    ["kind_rule_broken", { kindViolations: ["acct-x"] }],
    ["simulated_variant_on_real_account", { variants: [variant("v1", "p1", { accountSimulated: false, simulated: true })], posts: [post("p1", { pipelineStatus: "drafting" })] }],
    ["engine_id_on_simulated_variant", { variants: [variant("v1", "p1", { providerPostId: "17890001" })], posts: [post("p1", { pipelineStatus: "drafting" })] }],
    ["real_link_on_simulated_variant", { variants: [variant("v1", "p1", { status: "published", publishedUrl: "https://www.instagram.com/p/X" })], posts: [post("p1", { pipelineStatus: "drafting" })] }],
    ["pulled_metric_on_simulated_variant", { postMetrics: [{ id: "m1", variantId: "v1", source: "pull", accountSimulated: true }] }],
    ["simulated_metric_on_real_variant", { postMetrics: [{ id: "m1", variantId: "v9", source: "simulated", accountSimulated: false }] }],
    ["pulled_daily_on_simulated_account", { dailyMetrics: [{ id: "d1", accountId: "a1", source: "pull", accountSimulated: true }] }],
    ["simulated_daily_on_real_account", { dailyMetrics: [{ id: "d1", accountId: "a9", source: "simulated", accountSimulated: false }] }],
    ["oauth_grant_on_simulated_account", { grants: ["g1"] }],
    ["oauth_state_on_simulated_account", { oauthStates: ["s1"] }],
    ["inbox_on_simulated", { inboxThreads: ["t1"] }],
    ["usage_ledger_on_simulated_account", { ledger: ["l1"] }],
    ["simulated_post_without_simulated_variant", { posts: [post("p1", { pipelineStatus: "live", simulated: true, scheduleVia: "publisher", liveUrl: SIM_URL })], variants: [variant("v1", "p1", { accountSimulated: false })] }],
    ["simulated_post_not_live", { posts: [post("p1", { pipelineStatus: "scheduled", scheduleVia: "publisher", simulated: true })], variants: [variant("v1", "p1")] }],
    ["simulated_post_not_live", { posts: [post("p1", { pipelineStatus: "drafting", simulated: true })], variants: [variant("v1", "p1")] }],
    ["simulated_post_unexpected", { posts: [post("p1", { pipelineStatus: null, simulated: true })], variants: [variant("v1", "p1")] }],
    ["hand_schedule_marked_simulated", { posts: [post("p1", { pipelineStatus: "live", scheduleVia: "manual", simulated: true, liveUrl: "https://www.instagram.com/p/X" })], variants: [variant("v1", "p1", { nativeImport: true, status: "published" })] }],
    ["live_link_not_simulated", { posts: [post("p1", { pipelineStatus: "live", scheduleVia: "publisher", liveUrl: "https://www.instagram.com/p/X" })], variants: [variant("v1", "p1", { status: "published", publishedUrl: SIM_URL })] }],
    ["mixed_live_post_without_real_link", {
      posts: [post("p1", { pipelineStatus: "live", scheduleVia: "publisher", liveUrl: SIM_URL, simulated: true })],
      variants: [variant("v1", "p1", { simulated: true, status: "published", publishedUrl: SIM_URL }), variant("v2", "p1", { accountSimulated: false, network: "linkedin", status: "published", publishedUrl: null })],
    }],
  ];
  for (const [code, over] of CASES) {
    it(`${code}: refused, in words, naming the rows`, () => {
      const plan = planPurge(facts(over));
      expect(codes(plan)).toContain(code);
      expect(REFUSAL_WORDS[code].length).toBeGreaterThan(20);
      expect(plan.refusals.find((r) => r.code === code)!.ids.length).toBeGreaterThan(0);
    });
  }

  it("every refusal code has its words, and every code is exercised above", () => {
    expect(new Set(CASES.map(([c]) => c))).toEqual(new Set(Object.keys(REFUSAL_WORDS)));
  });

  it("a refused plan still lists what it would have done, so the report can show both", () => {
    const { p, v } = simLive("p1");
    const plan = planPurge(facts({ variants: [v], posts: [p], grants: ["g1"] }));
    expect(codes(plan)).toEqual(["oauth_grant_on_simulated_account"]);
    expect(plan.restore.map((r) => r.postId)).toEqual(["p1"]);
  });
});

// ── (R4) the schema the purge knows ──────────────────────────────────────────────────────────────────────────────────

const MIGRATIONS = join(__dirname, "..", "..", "migrations");
/** Every `<table> -> <referenced>` pair the migrations declare into the three tables the purge deletes from. */
function declaredDependents(): Array<{ table: string; references: string }> {
  const out: Array<{ table: string; references: string }> = [];
  for (const name of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    let current: string | null = null;
    for (const raw of readFileSync(join(MIGRATIONS, name), "utf8").split(/\r?\n/)) {
      const line = raw.replace(/--.*$/, "");
      const t = /\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+(\w+)/i.exec(line);
      if (t) current = t[1];
      for (const m of line.matchAll(/\bREFERENCES\s+(social_accounts|social_post_variants|social_publisher_orgs)\b/gi)) {
        if (current) out.push({ table: current, references: m[1] });
      }
    }
  }
  return out;
}

describe("SCP-Sf (R4) · the purge knows every table that points at what it deletes", () => {
  it("KNOWN_DEPENDENTS is exactly what the migrations declare (a new foreign key fails here until the purge classifies it)", () => {
    const declared = declaredDependents();
    expect(declared.length).toBeGreaterThan(10);
    expect(unknownDependents(declared)).toEqual([]);
    expect([...new Set(declared.map((d) => `${d.table} -> ${d.references}`))].sort()).toEqual([...KNOWN_DEPENDENTS].sort());
  });
  it("an unknown table is named", () => {
    expect(unknownDependents([{ table: "social_boosts", references: "social_post_variants" }])).toEqual(["social_boosts -> social_post_variants"]);
  });
});

// ── (R5) the purge's own statements ──────────────────────────────────────────────────────────────────────────────────

const PURGE_SRC = readFileSync(join(__dirname, "social-simulation-purge.ts"), "utf8");
const PLAN_SRC = readFileSync(join(__dirname, "social-simulation-purge-plan.ts"), "utf8");
/** Each SQL statement that starts with `re`, read to the closing backtick of its template literal. */
const statementsAt = (src: string, re: RegExp): string[] =>
  [...src.matchAll(new RegExp(re.source, "g"))].map((m) => src.slice(m.index ?? 0, src.indexOf("`", m.index ?? 0)));

describe("SCP-Sf (R5) · the purge deletes only what it names, with the kind restated in every statement", () => {
  it("the plan file runs no SQL at all", () => {
    expect(PLAN_SRC).not.toMatch(/\b(?:SELECT|DELETE\s+FROM|INSERT\s+INTO|UPDATE)\s+[a-z_]+\s+(?:SET|WHERE|USING)\b/);
  });

  it("it never inserts a social row and never updates an account or a variant (a purge never relabels a kind)", () => {
    expect(PURGE_SRC).not.toMatch(/\bINSERT\s+INTO\s+social_/);
    expect(PURGE_SRC).not.toMatch(/\bUPDATE\s+social_(accounts|post_variants)\b/);
    const updates = statementsAt(PURGE_SRC, /\bUPDATE\s+\w+/).map((s) => /^UPDATE\s+(\w+)/.exec(s)![1]);
    expect([...new Set(updates)].sort()).toEqual(["automation_approvals", "social_posts"]);
  });

  it("each DELETE names the plan's ids AND restates the simulated kind in its own WHERE", () => {
    const deletes = statementsAt(PURGE_SRC, /\bDELETE\s+FROM\s+\w+/);
    const tables = deletes.map((s) => /^DELETE\s+FROM\s+(\w+)/.exec(s)![1]).sort();
    expect(tables).toEqual([
      "social_accounts", "social_best_time_suggestions", "social_metrics_daily", "social_post_client_reviews", "social_post_metrics",
      "social_post_variants", "social_publisher_orgs",
    ]);
    for (const s of deletes) {
      expect(s, s.slice(0, 50)).toMatch(/\bid = ANY\(\$2::uuid\[\]\)/);
      expect(s, s.slice(0, 50)).toMatch(/simulated = true|api_key_ref = \$3/);
    }
    const byTable = Object.fromEntries(deletes.map((s) => [/^DELETE\s+FROM\s+(\w+)/.exec(s)![1], s]));
    expect(byTable.social_post_metrics).toMatch(/source IN \('simulated', 'manual'\)/); // never a pulled row
    expect(byTable.social_metrics_daily).toMatch(/source = 'simulated'/);
    expect(byTable.social_publisher_orgs).toMatch(/postiz_org_id = 'simulated-' \|\| o\.client_id::text/);
    expect(byTable.social_publisher_orgs).toMatch(/NOT EXISTS \(SELECT 1 FROM social_accounts/);
  });

  it("it is the ONLY source file that hard-deletes an account, a variant, an org or a metric row (the module otherwise never hard-deletes)", () => {
    const SRC = join(__dirname, "..");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? (d.name === "node_modules" ? [] : walk(join(dir, d.name)))
        : d.name.endsWith(".ts") && !d.name.endsWith(".test.ts") && !d.name.endsWith(".d.ts") ? [join(dir, d.name)] : []);
    const deleters = walk(SRC)
      .filter((f) => /\bDELETE\s+FROM\s+social_(accounts|post_variants|publisher_orgs|post_metrics|metrics_daily|post_client_reviews)\b/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1).split("\\").join("/"));
    expect(deleters).toEqual(["seed/social-simulation-purge.ts"]);
  });

  it("the post statements only move posts the variants carried (never a hand schedule) and only repair a live one", () => {
    const posts = statementsAt(PURGE_SRC, /\bUPDATE\s+social_posts\b/);
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatch(/pipeline_status IN \('client', 'approved', 'scheduled', 'live'\)/);
    expect(posts[0]).toMatch(/schedule_via IS DISTINCT FROM 'manual'/);
    expect(posts[0]).not.toMatch(/\b(title|brief|caption|hashtags|placement|scheduled_at)\s*=/); // never the content, never the date
    expect(posts[1]).toMatch(/pipeline_status = 'live'/);
    const approvals = statementsAt(PURGE_SRC, /\bUPDATE\s+automation_approvals\b/);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatch(/SET status = 'cancelled'.*status = 'pending'/s); // only undecided rows, and never deleted
  });

  it("it is read and written under the social module's scope, one company per transaction, and refuses with the switch on", () => {
    expect(PURGE_SRC).toMatch(/withTenants\(\[co\.id\], async \(c\): Promise<CompanyOutcome> =>/);
    expect(PURGE_SRC).toMatch(/const MODULES = \{ modules: \["social"\] \}/);
    const body = PURGE_SRC.slice(PURGE_SRC.indexOf("export async function purge("));
    expect(body.indexOf("isSocialSimulationEnabled()")).toBeGreaterThan(-1);
    expect(body.indexOf("isSocialSimulationEnabled()")).toBeLessThan(body.indexOf("readDependents()"));
    expect(body.indexOf("readDependents()")).toBeLessThan(body.indexOf("FROM companies"));
  });
});

describe("SCP-Sf (R6) · the report", () => {
  it("a dry run says what it would do, in words, and names posts by id and title", () => {
    const { p, v } = simLive("p1");
    const plan = planPurge(facts({ simulatedAccounts: [simAcct("acct-sim-ig")], variants: [v], posts: [p] }));
    const text = renderPurgeReport({
      apply: false, globalRefusal: null, refusedCompanies: 0,
      companies: [{ plan, before: { ...ZERO, simulatedAccounts: 1, variantsOnSimulatedAccounts: 1, simulatedVariants: 1, simulatedPosts: 1 }, after: null, applied: false }],
    }).join("\n");
    expect(text).toMatch(/^DRY RUN/);
    expect(text).toContain("COMPANY Mock Agency");
    expect(text).toMatch(/social_accounts \(simulated\): 1 \(would remove 1\)/);
    expect(text).toMatch(/WOULD MOVE BACK {2}p1 {2}Kopi Senja {2}"Post p1" {2}live -> final/);
    expect(text).toMatch(/Re-run with --apply/);
  });

  it("an apply prints before -> after, and a refusal says nothing changed in that company", () => {
    const { p, v } = simLive("p1");
    const done = planPurge(facts({ variants: [v], posts: [p] }));
    const refused = planPurge(facts({ company: "Other Mock", tenantId: "t2", grants: ["g1"] }));
    const text = renderPurgeReport({
      apply: true, globalRefusal: null, refusedCompanies: 1,
      companies: [
        { plan: done, before: { ...ZERO, simulatedPosts: 1 }, after: ZERO, applied: true },
        { plan: refused, before: ZERO, after: null, applied: false },
      ],
    }).join("\n");
    expect(text).toMatch(/social_posts \(simulated mark\): 1 -> 0/);
    expect(text).toMatch(/MOVED BACK {2}p1/);
    expect(text).toMatch(/COMPANY Other Mock \(t2\) {2}REFUSED: nothing changed in this company/);
    expect(text).toMatch(/REFUSED oauth_grant_on_simulated_account: 1/);
    expect(text).toMatch(/1 company\(ies\) REFUSED/);
  });

  it("a global refusal reads nothing and says why", () => {
    const text = renderPurgeReport({ apply: true, globalRefusal: "SOCIAL_SIMULATION_ENABLED is on.", companies: [], refusedCompanies: 0 }).join("\n");
    expect(text).toMatch(/REFUSED, nothing was read or written: SOCIAL_SIMULATION_ENABLED is on\./);
  });
});
