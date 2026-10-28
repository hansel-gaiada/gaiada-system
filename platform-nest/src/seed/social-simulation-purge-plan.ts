// SCP-Sf — the social simulator's PURGE, its rules as PURE functions: what one company's rows are, what the purge would do to
// them, and what it refuses. No I/O here: `social-simulation-purge.ts` reads the rows (under the module's RLS scope, one company
// per transaction), hands them to `planPurge`, and applies the plan statement by statement with a row-count check on each. The
// rules are pinned by `social-simulation-purge.test.ts` (pure) and proved on real Postgres by `social-simulation-purge.db.test.ts`.
//
// ── WHAT THE SIMULATOR'S FOOTPRINT IS ──────────────────────────────────────────────────────────────────────────────────
// The purge's unit is the SIMULATED ACCOUNT (`social_accounts.simulated = true`, which by `social_accounts_kind_ck` always
// carries a `simulated:<network>` integration id and was never connected by a person). Everything the purge deletes is either
// that account or hangs off it, and nothing else:
//   1. every `social_post_variants` row ON a simulated account, live or soft-deleted, whatever its status. The variant's own
//      `simulated` mark only records that the simulator PUBLISHED it (dispatch.ts's stamp); an unpublished variant on a
//      simulated account is footprint all the same, because no real path will ever serve it (publisher/simulation.ts fence
//      4: every real engine refuses a simulated account) and the account cannot be removed while it is there;
//   2. the variant's dependent rows: its `social_post_metrics` (`simulated`, and `manual` numbers a person typed about a
//      publication on a simulated account), its `social_post_client_reviews` (the review of content placed on a simulated
//      account; the decision itself stays in `activities`), and the undecided D14 publish approvals filed for it, which are
//      WITHDRAWN (`cancelled`, exactly as the stage machine's unschedule withdraws them), never deleted;
//   3. the account's `simulated` daily metrics (`social_metrics_daily.source = 'simulated'`) and its best-time suggestion
//      (`social_best_time_suggestions`, a cache derived only from that account's simulated numbers);
//   4. the publisher orgs SCP-Sb created for the simulator (fingerprint: `api_key_ref = 'simulated:no-key'` AND
//      `postiz_org_id = 'simulated-<client id>'`), once no account (of either kind) names them.
//
// ── WHAT IT NEVER TOUCHES ──────────────────────────────────────────────────────────────────────────────────────────────
// A real account, a variant on a real account, a `pull` metric row, a `pull` daily row, an OAuth grant or state, an inbox
// thread, a usage-ledger row, a post's CONTENT (title, brief, caption, hashtags, designs, files, comments: nothing of the post
// row but the fields listed under "posts" below), a cycle, a PM task's content, and every history row (`activities`,
// `work_activity`, notifications, outbox events, decided D14 approvals). It never deletes a post. It never turns a simulated
// row real (trg_social_accounts_kind_guard would refuse it anyway): a purge DELETES simulated rows, it never relabels them.
//
// ── POSTS: PUT BACK TO A STATE A PERSON CAN ACT ON ─────────────────────────────────────────────────────────────────────
// A post loses only its variants on simulated accounts. What happens to the post row is decided by its status:
//   * planned, drafting, proofread, hod, design, final, changes, blocked: nothing. The variants are a copy the next
//     `final_approve` makes afresh from the master post on the client's accounts as they are then (`syncVariants` "full");
//     with no account on a placed network it refuses `no_account_for_network`, which is the honest answer.
//   * client, approved, scheduled or live, through the publisher (or not yet scheduled), with NO variant left on a real
//     account: back to `final` (the approver's final check), `status` from the fixture's engine-status table ('draft'),
//     `schedule_via`, `live_url` and `went_live_at` cleared, `simulated = false`. Not `approved`: with no variant, the
//     approved step is a trap (`schedule_publisher` would file zero approvals and park the post `scheduled` for ever,
//     `reschedule` needs a changed date or placement). From `final` the approver's `final_approve` re-creates the variants on
//     the client's real accounts and asks the client again, which is right: the client's approval was of content on a
//     simulated account, and its review rows are gone with the variants. A simulated go-live is not a go-live: a post that
//     stayed `live` with a `simulated.invalid` link would be exactly the hazard SCP-D3 names.
//   * scheduled or live BY HAND (`schedule_via = 'manual'`): kept as it is. "Schedule in Meta" and "Mark live" are a
//     person's record of something done OUTSIDE the ERP, not the simulator's output; the purge cannot know whether it
//     happened, so it never erases it. Only the per-network bookkeeping variants on simulated accounts go.
//   * client, approved, scheduled or live WITH variants left on real accounts (a post placed on both kinds, SCP-D9): the
//     status stays (the real variants carry it); on a live post `simulated` is cleared and, when its `live_url` is the
//     simulator's, it is replaced by the first real published link (the publisher-result rule's order: network, id) and
//     `went_live_at` by the latest real `published_at`.
//   * a Composer post (no pipeline status), an archived or a deleted post: the row is left exactly as it is.
//
// ── REFUSALS: ANY SHAPE IT CANNOT CLASSIFY (exit 2, nothing changes in that company) ───────────────────────────────────
// Each is either impossible by the simulator's fences (so it means a bug a person must look at) or would make the purge
// guess between "simulated" and "real". See `PurgeRefusalCode`.
import { SIMULATED_URL_ORIGIN, isSimulatedId } from "../modules/social/publisher/simulation";
import { engineStatusOf } from "../modules/social/pipeline/machine";

/** SCP-Sb's org fingerprint (`modules/social/simulated-accounts.ts#ensurePublisherOrg`). Restated here, not imported, so this pure
 *  file pulls in no Nest code; `social-simulation-purge.test.ts` pins that the two never drift. */
export const SIMULATOR_ORG_KEY_REF = "simulated:no-key";
export const simulatorOrgId = (clientId: string): string => `simulated-${clientId}`;

/** The statuses whose meaning rests on the variants: the client reviews them, the approval covers them, the publish sends them. */
export const VARIANT_BACKED_STATUSES: ReadonlySet<string> = new Set(["client", "approved", "scheduled", "live"]);
/** Where a post whose variants were all on simulated accounts goes back to (header, "POSTS"). */
export const RESTORE_STATUS = "final";
/** `social_posts.status` of a restored post, from the fixture's engine-status table (a `final` post with no variant). */
export const RESTORE_ENGINE_STATUS = engineStatusOf({ pipelineStatus: RESTORE_STATUS }, [], false) as string;

/** Is this link the simulator's? Its URLs live under `https://simulated.invalid/` (RFC 2606: never resolves). */
export const isSimulatedUrl = (url: string | null | undefined): boolean =>
  typeof url === "string" && url.startsWith(`${SIMULATED_URL_ORIGIN}/`);

// ── The rows one company holds (read by social-simulation-purge.ts) ──────────────────────────────────────────────────

export interface PurgeAccount {
  id: string; clientId: string; clientName: string; network: string; handle: string; integrationId: string | null;
  deleted: boolean; orgId: string;
}
/** Every variant of every post the purge looks at (a post holding a variant on a simulated account, or a `simulated` post). */
export interface PurgeVariant {
  id: string; postId: string; accountId: string; network: string; accountSimulated: boolean; simulated: boolean;
  status: string; nativeImport: boolean; providerPostId: string | null; publishedUrl: string | null; publishedAt: string | null;
  deleted: boolean;
}
export interface PurgePost {
  id: string; title: string; clientName: string; engagementId: string; cycleId: string | null; pipelineStatus: string | null;
  scheduleVia: string | null; liveUrl: string | null; wentLiveAt: string | null; simulated: boolean; archived: boolean; deleted: boolean;
}
export interface PurgePostMetric { id: string; variantId: string; source: string; accountSimulated: boolean }
export interface PurgeDailyMetric { id: string; accountId: string; source: string; accountSimulated: boolean }
export interface PurgeOrg {
  id: string; clientId: string; clientName: string; apiKeyRef: string; postizOrgId: string;
  /** Accounts naming this org, by kind (soft-deleted included: the FK counts them). */
  realAccounts: number; simulatedAccounts: number;
}
/** The counts a person reads before and after: one per table the footprint lives in. */
export interface FootprintCounts {
  simulatedAccounts: number; variantsOnSimulatedAccounts: number; simulatedVariants: number; simulatedPosts: number;
  simulatedPostMetrics: number; simulatedDailyMetrics: number; simulatorOrgs: number;
}
export const FOOTPRINT_LABELS: Readonly<Record<keyof FootprintCounts, string>> = {
  simulatedAccounts: "social_accounts (simulated)",
  variantsOnSimulatedAccounts: "social_post_variants (on a simulated account)",
  simulatedVariants: "social_post_variants (simulated mark)",
  simulatedPosts: "social_posts (simulated mark)",
  simulatedPostMetrics: "social_post_metrics (source simulated)",
  simulatedDailyMetrics: "social_metrics_daily (source simulated)",
  simulatorOrgs: "social_publisher_orgs (the simulator's, api_key_ref simulated:no-key)",
};

export interface CompanyFacts {
  tenantId: string;
  company: string;
  /** Rows breaking the account-kind rule (`simulation.ts#ACCOUNT_KIND_VIOLATION_SQL`): the purge relies on the rule. */
  kindViolations: string[];
  simulatedAccounts: PurgeAccount[];
  variants: PurgeVariant[];
  posts: PurgePost[];
  /** Post metric rows on a variant of a simulated account, plus every `simulated` row wherever it sits. */
  postMetrics: PurgePostMetric[];
  /** Daily rows on a simulated account, plus every `simulated` row wherever it sits. */
  dailyMetrics: PurgeDailyMetric[];
  /** Client reviews of variants on simulated accounts. */
  reviews: Array<{ id: string; variantId: string }>;
  /** UNDECIDED (`pending`) D14 publish approvals filed for a variant on a simulated account. */
  pendingApprovals: Array<{ id: string; variantId: string }>;
  bestTime: Array<{ id: string; accountId: string }>;
  /** Rows only a REAL engine or a person's connect writes, found on a simulated account (or its variant): ids only. */
  grants: string[];
  oauthStates: string[];
  inboxThreads: string[];
  ledger: string[];
  /** Orgs carrying the simulator's key alias, and orgs holding a simulated account. */
  orgs: PurgeOrg[];
  counts: FootprintCounts;
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PurgeRefusalCode =
  | "kind_rule_broken" // an account is neither kind: the purge's unit is undefined
  | "simulated_variant_on_real_account" // a `simulated` variant whose account is real: dispatch stamps only what the simulator served
  | "engine_id_on_simulated_variant" // a variant on a simulated account carries a provider post id a real engine minted
  | "real_link_on_simulated_variant" // a variant on a simulated account was published (not by hand) to a non-simulated link
  | "pulled_metric_on_simulated_variant" // a `pull` post-metric row on a simulated account's variant: never touched, so it blocks
  | "simulated_metric_on_real_variant" // a `simulated` post-metric row on a real account's variant
  | "pulled_daily_on_simulated_account" // a `pull` daily row on a simulated account
  | "simulated_daily_on_real_account" // a `simulated` daily row on a real account
  | "oauth_grant_on_simulated_account" | "oauth_state_on_simulated_account" | "inbox_on_simulated" | "usage_ledger_on_simulated_account"
  | "simulated_post_without_simulated_variant" // a `simulated` post with no variant on a simulated account
  | "simulated_post_not_live" // a `simulated` post that is not live (the mark is set only by mark_live)
  | "simulated_post_unexpected" // a `simulated` Composer, archived or deleted post
  | "hand_schedule_marked_simulated" // scheduled or live by hand, yet marked simulated
  | "live_link_not_simulated" // live through the publisher on simulated accounts only, with a link that is not the simulator's
  | "mixed_live_post_without_real_link"; // live on both kinds, its link the simulator's, and no real variant has a link

export const REFUSAL_WORDS: Readonly<Record<PurgeRefusalCode, string>> = {
  kind_rule_broken: "accounts break the account-kind rule (neither simulated nor real); run social-simulation-prepare.js and decide each first",
  simulated_variant_on_real_account: "variants are marked simulated but sit on a REAL account; the simulator only ever serves a simulated account",
  engine_id_on_simulated_variant: "variants on a simulated account carry a provider post id that is not the simulator's (a real engine was reached)",
  real_link_on_simulated_variant: "variants on a simulated account were published, not by hand, to a link that is not under https://simulated.invalid/",
  pulled_metric_on_simulated_variant: "pulled (real) metric rows sit on a simulated account's variants; a pulled row is never deleted",
  simulated_metric_on_real_variant: "simulated metric rows sit on a REAL account's variants",
  pulled_daily_on_simulated_account: "pulled (real) daily metric rows sit on a simulated account; a pulled row is never deleted",
  simulated_daily_on_real_account: "simulated daily metric rows sit on a REAL account",
  oauth_grant_on_simulated_account: "OAuth grants name a simulated account (trg_social_oauth_tokens_real_account_only forbids it); never touched",
  oauth_state_on_simulated_account: "OAuth connect states name a simulated account; wait until they expire (the oauth-state sweep deletes them) and run again",
  inbox_on_simulated: "inbox threads sit on a simulated account or its variant (only the real inbox sync writes threads); never touched",
  usage_ledger_on_simulated_account: "usage-ledger rows name a simulated account; the ledger is append-only and never touched",
  simulated_post_without_simulated_variant: "posts are marked simulated but have no variant on a simulated account",
  simulated_post_not_live: "posts are marked simulated but are not live (only a simulated go-live sets the mark)",
  simulated_post_unexpected: "posts marked simulated are Composer posts, archived or deleted",
  hand_schedule_marked_simulated: "posts scheduled or marked live BY HAND are also marked simulated",
  live_link_not_simulated: "posts live through the publisher on simulated accounts only have a live link that is not the simulator's",
  mixed_live_post_without_real_link: "posts live on both kinds show the simulator's link, and no real variant has a link to put in its place",
};

export interface PurgeRefusal { code: PurgeRefusalCode; ids: string[] }

/** A post the purge moves back to `final`. */
export interface PostRestore {
  postId: string; title: string; clientName: string; engagementId: string; cycleId: string | null; from: string; removedVariantIds: string[];
}
/** A post live on both kinds: its simulated mark cleared and, when its link was the simulator's, the first real link put in. */
export interface PostRepair {
  postId: string; title: string; liveUrl: string | null; wentLiveAt: string | null; linkReplaced: boolean; removedVariantIds: string[];
}
export interface PostKept { postId: string; title: string; status: string | null; why: string }

export interface PurgePlan {
  tenantId: string;
  company: string;
  refusals: PurgeRefusal[];
  withdrawApprovals: string[];
  deletePostMetrics: string[];
  /** Of `deletePostMetrics`, how many are `manual` (typed by a person): said in the report, so nobody is surprised. */
  manualPostMetrics: number;
  deleteDailyMetrics: string[];
  deleteReviews: string[];
  deleteBestTime: string[];
  deleteVariants: string[];
  deleteAccounts: string[];
  deleteOrgs: string[];
  restore: PostRestore[];
  repair: PostRepair[];
  kept: PostKept[];
  leftOrgs: Array<{ orgId: string; clientName: string; why: string }>;
  /** Cycles whose content-month progress is recomputed (a restored post left "past client approval"). */
  cycles: string[];
}

const uniq = (xs: Iterable<string>): string[] => [...new Set(xs)];

/** PURE. One company's plan. A plan with any refusal is applied NOT AT ALL (the caller writes nothing for that company). */
export function planPurge(f: CompanyFacts): PurgePlan {
  const refusals = new Map<PurgeRefusalCode, Set<string>>();
  const refuse = (code: PurgeRefusalCode, id: string) => {
    const s = refusals.get(code) ?? new Set<string>();
    s.add(id);
    refusals.set(code, s);
  };

  for (const id of f.kindViolations) refuse("kind_rule_broken", id);
  for (const id of f.grants) refuse("oauth_grant_on_simulated_account", id);
  for (const id of f.oauthStates) refuse("oauth_state_on_simulated_account", id);
  for (const id of f.inboxThreads) refuse("inbox_on_simulated", id);
  for (const id of f.ledger) refuse("usage_ledger_on_simulated_account", id);

  // Variants: the footprint is every variant on a simulated account (header 1).
  const footprint = new Map<string, PurgeVariant>();
  for (const v of f.variants) {
    if (v.accountSimulated) footprint.set(v.id, v);
    else if (v.simulated) refuse("simulated_variant_on_real_account", v.id);
  }
  for (const v of footprint.values()) {
    if (v.providerPostId !== null && !isSimulatedId(v.providerPostId)) refuse("engine_id_on_simulated_variant", v.id);
    if (v.publishedUrl !== null && v.publishedUrl !== "" && !v.nativeImport && !isSimulatedUrl(v.publishedUrl)) {
      refuse("real_link_on_simulated_variant", v.id);
    }
  }

  // Metrics.
  const deletePostMetrics: string[] = [];
  let manualPostMetrics = 0;
  for (const m of f.postMetrics) {
    if (m.accountSimulated) {
      if (m.source === "pull") refuse("pulled_metric_on_simulated_variant", m.id);
      else {
        deletePostMetrics.push(m.id);
        if (m.source === "manual") manualPostMetrics += 1;
      }
    } else if (m.source === "simulated") refuse("simulated_metric_on_real_variant", m.id);
  }
  const deleteDailyMetrics: string[] = [];
  for (const m of f.dailyMetrics) {
    if (m.accountSimulated) {
      if (m.source === "simulated") deleteDailyMetrics.push(m.id);
      else refuse("pulled_daily_on_simulated_account", m.id);
    } else if (m.source === "simulated") refuse("simulated_daily_on_real_account", m.id);
  }

  // Posts (header, "POSTS").
  const byPost = new Map<string, PurgeVariant[]>();
  for (const v of f.variants) byPost.set(v.postId, [...(byPost.get(v.postId) ?? []), v]);
  const restore: PostRestore[] = [];
  const repair: PostRepair[] = [];
  const kept: PostKept[] = [];
  for (const p of f.posts) {
    const all = byPost.get(p.id) ?? [];
    const removed = all.filter((v) => footprint.has(v.id)).map((v) => v.id);
    const realLeft = all.filter((v) => !footprint.has(v.id) && !v.deleted);
    if (removed.length === 0) {
      if (p.simulated) refuse("simulated_post_without_simulated_variant", p.id);
      continue;
    }
    if (p.pipelineStatus === null || p.archived || p.deleted) {
      if (p.simulated) refuse("simulated_post_unexpected", p.id);
      else kept.push({ postId: p.id, title: p.title, status: p.pipelineStatus, why: p.pipelineStatus === null ? "a Composer post: the row is left as it is" : p.deleted ? "deleted: left as it is" : "archived: left as it is" });
      continue;
    }
    if (!VARIANT_BACKED_STATUSES.has(p.pipelineStatus)) {
      if (p.simulated) refuse("simulated_post_not_live", p.id);
      else kept.push({ postId: p.id, title: p.title, status: p.pipelineStatus, why: "before the client: the next final_approve makes its variants afresh" });
      continue;
    }
    if (p.simulated && p.pipelineStatus !== "live") { refuse("simulated_post_not_live", p.id); continue; }
    if (realLeft.length > 0) {
      if (p.pipelineStatus === "live" && (p.simulated || isSimulatedUrl(p.liveUrl))) {
        const linkReplaced = isSimulatedUrl(p.liveUrl);
        let liveUrl = p.liveUrl;
        let wentLiveAt = p.wentLiveAt;
        if (linkReplaced) {
          const linked = realLeft
            .filter((v) => v.status === "published" && typeof v.publishedUrl === "string" && v.publishedUrl !== "" && !isSimulatedUrl(v.publishedUrl))
            .sort((a, b) => (a.network === b.network ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.network < b.network ? -1 : 1));
          if (linked.length === 0) { refuse("mixed_live_post_without_real_link", p.id); continue; }
          liveUrl = linked[0].publishedUrl;
          const times = realLeft.map((v) => (v.publishedAt ? Date.parse(v.publishedAt) : NaN)).filter((t) => Number.isFinite(t));
          wentLiveAt = times.length ? new Date(Math.max(...times)).toISOString() : p.wentLiveAt;
        }
        repair.push({ postId: p.id, title: p.title, liveUrl, wentLiveAt, linkReplaced, removedVariantIds: removed });
      } else {
        kept.push({ postId: p.id, title: p.title, status: p.pipelineStatus, why: "its variants on real accounts carry the status" });
      }
      continue;
    }
    if (p.scheduleVia === "manual") {
      if (p.simulated) refuse("hand_schedule_marked_simulated", p.id);
      else kept.push({ postId: p.id, title: p.title, status: p.pipelineStatus, why: "scheduled or marked live BY HAND: a person's record, kept" });
      continue;
    }
    if (p.pipelineStatus === "live" && !isSimulatedUrl(p.liveUrl)) { refuse("live_link_not_simulated", p.id); continue; }
    restore.push({
      postId: p.id, title: p.title, clientName: p.clientName, engagementId: p.engagementId, cycleId: p.cycleId, from: p.pipelineStatus,
      removedVariantIds: removed,
    });
  }

  // Orgs (header 4).
  const deleteOrgs: string[] = [];
  const leftOrgs: PurgePlan["leftOrgs"] = [];
  for (const o of f.orgs) {
    const seeds = o.apiKeyRef === SIMULATOR_ORG_KEY_REF;
    if (!seeds) {
      leftOrgs.push({ orgId: o.id, clientName: o.clientName, why: `not created by the simulator (api_key_ref '${o.apiKeyRef}'); only its simulated accounts are removed` });
    } else if (o.postizOrgId !== simulatorOrgId(o.clientId)) {
      leftOrgs.push({ orgId: o.id, clientName: o.clientName, why: `carries the simulator's key alias but not its org id ('${o.postizOrgId}'); left for a person` });
    } else if (o.realAccounts > 0) {
      leftOrgs.push({ orgId: o.id, clientName: o.clientName, why: `still holds ${o.realAccounts} real account(s)` });
    } else {
      deleteOrgs.push(o.id);
    }
  }

  const refusalList: PurgeRefusal[] = [...refusals.entries()].map(([code, ids]) => ({ code, ids: [...ids].sort() }));
  return {
    tenantId: f.tenantId,
    company: f.company,
    refusals: refusalList,
    withdrawApprovals: uniq(f.pendingApprovals.filter((a) => footprint.has(a.variantId)).map((a) => a.id)),
    deletePostMetrics,
    manualPostMetrics,
    deleteDailyMetrics,
    deleteReviews: uniq(f.reviews.filter((r) => footprint.has(r.variantId)).map((r) => r.id)),
    deleteBestTime: uniq(f.bestTime.map((b) => b.id)),
    deleteVariants: [...footprint.keys()],
    deleteAccounts: f.simulatedAccounts.map((a) => a.id),
    deleteOrgs,
    restore,
    repair,
    kept,
    leftOrgs,
    cycles: uniq(restore.map((r) => r.cycleId).filter((c): c is string => c !== null)),
  };
}

/** Does the plan change anything? */
export const planIsEmpty = (p: PurgePlan): boolean =>
  p.withdrawApprovals.length + p.deletePostMetrics.length + p.deleteDailyMetrics.length + p.deleteReviews.length + p.deleteBestTime.length
  + p.deleteVariants.length + p.deleteAccounts.length + p.deleteOrgs.length + p.restore.length + p.repair.length === 0;

// ── The schema the purge knows (a NEW dependent table must be classified here before the purge runs) ─────────────────

/** Every foreign key that points at a table the purge deletes from, as `<referencing table> -> <referenced table>`. The purge
 *  reads the catalogue at start and REFUSES the whole run when it finds one that is not here: a table it does not know may
 *  hold rows it would orphan (the FK would make the delete fail anyway; this says which table, before anything is read). */
export const KNOWN_DEPENDENTS: readonly string[] = [
  "social_accounts -> social_publisher_orgs",
  "social_post_variants -> social_accounts",
  "social_inbox_threads -> social_accounts",
  "social_metrics_daily -> social_accounts",
  "social_usage_ledger -> social_accounts",
  "social_oauth_tokens -> social_accounts",
  "social_best_time_suggestions -> social_accounts",
  "social_oauth_states -> social_accounts",
  "social_post_client_reviews -> social_post_variants",
  "social_post_metrics -> social_post_variants",
  "social_inbox_threads -> social_post_variants",
];

/** PURE. The referencing pairs the purge does not know (empty when it knows them all). */
export function unknownDependents(found: ReadonlyArray<{ table: string; references: string }>): string[] {
  const known = new Set(KNOWN_DEPENDENTS);
  return uniq(found.map((f) => `${f.table} -> ${f.references}`).filter((k) => !known.has(k))).sort();
}

// ── The report ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CompanyOutcome {
  plan: PurgePlan;
  before: FootprintCounts;
  /** Read again after the apply, inside its transaction (null in a dry run or when refused). */
  after: FootprintCounts | null;
  applied: boolean;
}

export interface PurgeResult {
  apply: boolean;
  /** Set when the run refused before reading any company (the switch is on, or an unknown dependent table). */
  globalRefusal: string | null;
  companies: CompanyOutcome[];
  refusedCompanies: number;
}

const countLine = (label: string, before: number, after: number | null, planned: number | null): string =>
  `    ${label}: ${before}${after !== null ? ` -> ${after}` : planned !== null ? ` (would remove ${planned})` : ""}`;

/** PURE. The report, one line per fact. Ids, client names, handles and titles only: never a caption, a note or a token. */
export function renderPurgeReport(r: PurgeResult): string[] {
  const out: string[] = [];
  out.push(r.apply ? "APPLY: removing the social simulator's rows" : "DRY RUN: nothing is written (add --apply to remove the rows listed)");
  if (r.globalRefusal) {
    out.push("", `REFUSED, nothing was read or written: ${r.globalRefusal}`);
    return out;
  }
  for (const o of r.companies) {
    const p = o.plan;
    const anything = !planIsEmpty(p) || p.refusals.length > 0 || Object.values(o.before).some((n) => n > 0);
    if (!anything) continue;
    out.push("", `COMPANY ${p.company} (${p.tenantId})${p.refusals.length ? "  REFUSED: nothing changed in this company" : o.applied ? "  PURGED" : ""}`);
    for (const x of p.refusals) {
      out.push(`  REFUSED ${x.code}: ${x.ids.length} ${REFUSAL_WORDS[x.code]}`);
      for (const id of x.ids) out.push(`      - ${id}`);
    }
    out.push("  counts (before" + (o.after ? " -> after" : "") + "):");
    const planned: Partial<Record<keyof FootprintCounts, number>> = o.after ? {} : {
      simulatedAccounts: p.deleteAccounts.length, variantsOnSimulatedAccounts: p.deleteVariants.length,
      simulatedPostMetrics: p.deletePostMetrics.length - p.manualPostMetrics, simulatedDailyMetrics: p.deleteDailyMetrics.length,
      simulatorOrgs: p.deleteOrgs.length,
    };
    for (const k of Object.keys(FOOTPRINT_LABELS) as Array<keyof FootprintCounts>) {
      out.push(countLine(FOOTPRINT_LABELS[k], o.before[k], o.after ? o.after[k] : null, planned[k] ?? null));
    }
    const verb = o.applied ? "removed" : "would remove";
    out.push(
      `  ${verb}: ${p.deleteVariants.length} variant(s), ${p.deleteReviews.length} client review(s), ${p.deletePostMetrics.length} post metric row(s)`
      + ` (${p.manualPostMetrics} of them typed in by a person), ${p.deleteDailyMetrics.length} daily row(s), ${p.deleteBestTime.length} best-time`
      + ` suggestion(s), ${p.deleteAccounts.length} account(s), ${p.deleteOrgs.length} simulator org(s);`
      + ` ${o.applied ? "withdrew" : "would withdraw"} ${p.withdrawApprovals.length} undecided publish approval(s)`,
    );
    for (const x of p.restore) out.push(`  ${o.applied ? "MOVED BACK" : "WOULD MOVE BACK"}  ${x.postId}  ${x.clientName}  "${x.title}"  ${x.from} -> ${RESTORE_STATUS}`);
    for (const x of p.repair) {
      out.push(`  ${o.applied ? "REPAIRED" : "WOULD REPAIR"}  ${x.postId}  "${x.title}"  live on real accounts too: simulated mark cleared${x.linkReplaced ? `, live link now ${x.liveUrl}` : ""}`);
    }
    for (const x of p.kept) out.push(`  KEPT  ${x.postId}  "${x.title}"  ${x.status ?? "composer"}: ${x.why}`);
    for (const x of p.leftOrgs) out.push(`  LEFT ORG  ${x.orgId}  ${x.clientName}: ${x.why}`);
  }
  const totalAfter = r.companies.reduce((n, o) => n + (o.after ? o.after.simulatedAccounts + o.after.variantsOnSimulatedAccounts + o.after.simulatedVariants + o.after.simulatedPosts + o.after.simulatedPostMetrics + o.after.simulatedDailyMetrics : 0), 0);
  out.push("");
  if (r.refusedCompanies > 0) {
    out.push(`${r.refusedCompanies} company(ies) REFUSED: nothing changed in them. Each refusal above names the rows; a person decides them (infra/runbooks/social-simulation.md, "Turn off and purge").`);
  } else if (r.apply) {
    out.push(totalAfter === 0 ? "Done: no simulated account, variant, post or metric row is left." : `Done, but ${totalAfter} simulated row(s) are still counted above: look before going on.`);
  } else {
    out.push("Nothing refused. Re-run with --apply to remove the rows listed.");
  }
  return out;
}
