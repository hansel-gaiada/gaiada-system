// SMM-36 — the per-network engagement-inbox retention purge.
//
// WHY THIS EXISTS: LinkedIn's Data Storage Requirements impose a MAXIMUM retention, checked at
// Standard Tier review and demonstrated at Technical Sign Off (addendum §A4e). `social_inbox_threads`
// / `social_inbox_messages` (0105) were designed to retain indefinitely — that is what an engagement
// inbox IS — so a per-network purge must exist before the first LinkedIn client connects. Owner
// decision D-20 (2026-08-18) then made this custody infrastructure rather than a compliance chore:
// SMM-38 moves OAuth token custody in-house for the networks its `direct` driver serves, and phase
// 38b's own exit criterion is "the retention/purge hooks SMM-36 defines" (addendum §PD) — 38c
// (LinkedIn) depends on this file existing first, not the other way round.
//
// SHAPE: mirrors `modules/pm/burndown-job.ts` deliberately — env-gated, dark by default, started
// from main.ts, `withGlobal` for the tenant list then a per-tenant transaction, per-tenant failures
// logged and swallowed rather than aborting the sweep. The one thing that file's tables never needed
// and this one's do: a module scope declaration (below).
//
// ── ⚠ THE TRAP THIS TICKET WAS BRIEFED AGAINST ────────────────────────────────────────────────────
// Every `social_*` table carries 0105's THIRD RLS wall: `app_module_allowed('social')`. SMM-09's
// `publish-precondition.ts` hit this first: a generic scheduled sweep's per-tenant transaction has no
// business knowing which module it is about to touch, so it opens with NO `{modules}` option, and
// with `app.scopes` unset every query below would read ZERO ROWS, SILENTLY. For THIS ticket that is
// the worst possible failure shape: a purge job that reads zero rows reports "0 purged, all clean"
// FOREVER while LinkedIn data accumulates past its 24h/48h window — fails CLOSED on visibility and
// OPEN on compliance, exactly the shape the ticket brief called out by name.
//
// The fix is the same one `evaluatePublishPrecondition` uses, reused rather than re-implemented:
// `purgeTenantInboxRetention` below calls the EXPORTED `declareSocialModuleScope` from
// `publish-precondition.ts` before touching a single social_* row.
// `inbox-retention-job.test.ts`'s "module GUC" test calls this function on a transaction the test
// itself opened with NO module scope and asserts a purge still happens — it FAILS if that one line
// is ever removed, which is the point: SMM-09's own regression test is the model for this one.
//
// ── THE SMM-38 PHASE 38b SEAM ─────────────────────────────────────────────────────────────────────
// `registerRetentionPurger` is a process-level registration slot, the same shape
// `publisher/registry.ts` and `publish-precondition.ts`'s `setCreatorInfoVerifier` use elsewhere in
// this module. It starts with exactly the built-in inbox purger registered (`resetRetentionPurgers`
// restores that baseline, never an empty registry). `runInboxRetentionPurge` calls every registered
// purger inside the SAME per-tenant transaction, with the SAME module scope already declared, under
// the SAME per-tenant error-swallow, and merges every purger's counts into one report.
//
// What SMM-38 phase 38b MUST implement against this seam — and must NOT do:
//   1. Its own encrypted-at-rest token table, on the tenant wall (schema is senior-db's call, not
//      this ticket's — SMM-36 does not create it).
//   2. Its own `RetentionPurger` function — same signature as `purgeInboxRetention` below — that
//      purges/revokes rows past THAT table's own documented retention/refresh-ahead window.
//   3. One call to `registerRetentionPurger('oauth_tokens', tokenPurger)` at module boot, alongside
//      wherever 38b registers its publisher driver.
//   4. It must NOT call `declareSocialModuleScope` a second time — `purgeTenantInboxRetention`
//      already has, before any purger runs. A second `set_config('app.scopes', ...)` on the same
//      transaction is harmless (the function is additive/idempotent) but redundant.
// 38b does not need a new job, a new schedule, a new transaction shape, or a new error-handling
// path — only a new registration call, which is the entire point of building the seam now rather
// than discovering the need for one when 38b starts.
import type { PoolClient } from "pg";
import { withGlobal, withTenants } from "../../db";
import { declareSocialModuleScope } from "./publish-precondition";
import { hasDocumentedRetentionCap, getRetentionPolicy, KNOWN_NETWORKS } from "./retention-policy";

/** One purge step's own counts, keyed however that purger chooses (the built-in inbox purger below
 *  uses `threadsProfile`/`threadsActivity`/`messagesProfile`/`messagesActivity`). */
export type PurgerCounts = Record<string, number>;

/** A registered purge step. Runs on an ALREADY-tenant-scoped, ALREADY-module-scoped transaction —
 *  see `purgeTenantInboxRetention`. Must not perform network I/O (same discipline as
 *  `CreatorInfoVerifier`): this runs inside a scheduled sweep's own transaction per tenant, and a
 *  slow or failing outbound call there would turn one tenant's purge into every tenant's timeout. */
export type RetentionPurger = (c: PoolClient, tenantId: string, now: Date) => Promise<PurgerCounts>;

/** The built-in purger this ticket ships. Scrubs (never deletes) rows past a DOCUMENTED network's
 *  retention window, preserving the thread/message SHELL — id, external id, status, timestamps —
 *  so the inbox UI can still render "a comment existed here" without content that has expired
 *  (addendum §A4e: "the IDs/URNs deliberately preserved so the thread survives as a shell after its
 *  content is purged"). Idempotent by construction: each purge marker is only ever set once
 *  (`WHERE ... IS NULL` in every UPDATE below), so re-running finds nothing left to do for an
 *  already-purged row and reports zero for it, never an error — the SAME idempotency shape 0105's
 *  own inbox-sync tables were designed around.
 *
 * Only acts on a network `hasDocumentedRetentionCap()` — see `retention-policy.ts`'s header for why
 * "unverified" must never become "purge on a guessed number". */
async function purgeInboxRetention(c: PoolClient, tenantId: string, now: Date): Promise<PurgerCounts> {
  const counts: PurgerCounts = {
    threadsProfile: 0, threadsActivity: 0, messagesProfile: 0, messagesActivity: 0,
  };

  for (const network of KNOWN_NETWORKS) {
    if (!hasDocumentedRetentionCap(network)) continue;
    const policy = getRetentionPolicy(network);

    if (policy.profileDataMaxHours !== null) {
      const threads = await c.query(
        `UPDATE social_inbox_threads
            SET author_handle = NULL, author_name = NULL, profile_data_purged_at = $3
          WHERE tenant_id = $1 AND network = $2 AND profile_data_purged_at IS NULL
            AND deleted_at IS NULL AND created_at < $3::timestamptz - make_interval(hours => $4::int)`,
        [tenantId, network, now, policy.profileDataMaxHours],
      );
      counts.threadsProfile += threads.rowCount ?? 0;

      // SMM-17's own finding: this UPDATE matched ANY message row past the age threshold, with no
      // `direction` filter — correct while every row was inbound (all SMM-15/16 ever wrote), but
      // wrong the instant an OUTBOUND reply row exists on the same table (0105's own design,
      // "outbound replies are one-shot-gated exactly like publishes"). `m.direction = 'in'` fixes it
      // at the source: our own authored reply text is not a member's social-activity content
      // LinkedIn's cap is about, and wiping it — including on an ALREADY-SENT reply, which is our
      // own historical record — would be an over-broad application of a rule about someone else's
      // data. See `reply-precondition.ts`'s header for the retention question this ticket actually
      // needed to answer (a thread-level check, unaffected by this fix either way).
      const messages = await c.query(
        `UPDATE social_inbox_messages m
            SET author_handle = NULL, profile_data_purged_at = $3
           FROM social_inbox_threads t
          WHERE m.thread_id = t.id AND t.tenant_id = $1 AND t.network = $2
            AND m.tenant_id = $1 AND m.direction = 'in' AND m.profile_data_purged_at IS NULL
            AND m.created_at < $3::timestamptz - make_interval(hours => $4::int)`,
        [tenantId, network, now, policy.profileDataMaxHours],
      );
      counts.messagesProfile += messages.rowCount ?? 0;
    }

    if (policy.activityContentMaxHours !== null) {
      // SMM-16's own migration header answers a question this ticket asked by name: a
      // sentiment/category/urgency classification is DISTILLED FROM the comment text this purge is
      // about to scrub, so it inherits the SAME retention cap, on the SAME clock, rather than a
      // second one that could drift from it. `ai_triage_status` moves 'classified' -> 'purged' (the
      // migration's own fourth, honest state: "was classified, then scrubbed", distinct from
      // 'unclassified'/'never touched') — `sit_activity_purge_scrubs_triage`'s CHECK makes this the
      // ONLY way a 'classified' row can coexist with a set `activity_content_purged_at` at all, so
      // this UPDATE is not a policy choice this file could silently skip; the constraint requires it.
      const threads = await c.query(
        `UPDATE social_inbox_threads
            SET excerpt = NULL, activity_content_purged_at = $3,
                sentiment = NULL, category = NULL, urgency = NULL,
                ai_triage_status = CASE WHEN ai_triage_status = 'classified' THEN 'purged' ELSE ai_triage_status END
          WHERE tenant_id = $1 AND network = $2 AND activity_content_purged_at IS NULL
            AND deleted_at IS NULL AND created_at < $3::timestamptz - make_interval(hours => $4::int)`,
        [tenantId, network, now, policy.activityContentMaxHours],
      );
      counts.threadsActivity += threads.rowCount ?? 0;

      // SMM-17's own finding — see the profile-purge UPDATE just above for the full explanation.
      // `m.direction = 'in'` here as well: an outbound reply's own body is never subject to
      // LinkedIn's activity-content cap, and an ALREADY-SENT reply is our own historical record of
      // what we said, never eligible for this purge either way.
      const messages = await c.query(
        `UPDATE social_inbox_messages m
            SET body = '', activity_content_purged_at = $3
           FROM social_inbox_threads t
          WHERE m.thread_id = t.id AND t.tenant_id = $1 AND t.network = $2
            AND m.tenant_id = $1 AND m.direction = 'in' AND m.activity_content_purged_at IS NULL
            AND m.created_at < $3::timestamptz - make_interval(hours => $4::int)`,
        [tenantId, network, now, policy.activityContentMaxHours],
      );
      counts.messagesActivity += messages.rowCount ?? 0;
    }
  }

  return counts;
}

const purgers = new Map<string, RetentionPurger>([["inbox", purgeInboxRetention]]);

/** Register (or replace) a named purge step. Exported for SMM-38 phase 38b — see the header. */
export function registerRetentionPurger(key: string, purger: RetentionPurger): void {
  purgers.set(key, purger);
}

/** Test/boot seam, matching `resetPublishers()`/`resetCreatorInfoVerifier()`. Restores exactly the
 *  built-in inbox purger — never an empty registry — so a test that forgets to call this still runs
 *  against the real purge rather than a silently-empty one. */
export function resetRetentionPurgers(): void {
  purgers.clear();
  purgers.set("inbox", purgeInboxRetention);
}

/** One tenant's transaction. Declares its own module scope (see the header's ⚠) before running
 *  every registered purger and merging their counts under their own key. */
export async function purgeTenantInboxRetention(
  c: PoolClient, tenantId: string, now: Date,
): Promise<Record<string, PurgerCounts>> {
  await declareSocialModuleScope(c);
  const out: Record<string, PurgerCounts> = {};
  for (const [key, purger] of purgers) {
    out[key] = await purger(c, tenantId, now);
  }
  return out;
}

/** Sweep every tenant. Mirrors `runDailyBurndownSnapshot`'s shape: `withGlobal` for the company
 *  list (companies carry no tenant_id — they ARE the tenants), then each company's own
 *  `withTenants([tenantId], ...)` transaction, per-tenant failures logged and swallowed so one
 *  tenant's bad row can never abort the sweep for every other tenant. */
export async function runInboxRetentionPurge(now: Date = new Date()): Promise<{
  tenants: number;
  errors: number;
  totals: PurgerCounts;
}> {
  const { rows: tenants } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`),
  );
  let errors = 0;
  const totals: PurgerCounts = {};
  for (const { id: tenantId } of tenants) {
    try {
      // Deliberately NO `{modules:['social']}` here — see the header. The module scope is declared
      // INSIDE purgeTenantInboxRetention, not by this call site, so this loop cannot silently start
      // "working" again just because a caller happened to pass the option back in.
      const perPurger = await withTenants([tenantId], (c) => purgeTenantInboxRetention(c, tenantId, now));
      for (const counts of Object.values(perPurger)) {
        for (const [key, value] of Object.entries(counts)) {
          totals[key] = (totals[key] ?? 0) + value;
        }
      }
    } catch (err) {
      errors += 1;
      // eslint-disable-next-line no-console
      console.error(`[SOCIAL-INBOX-RETENTION] tenant ${tenantId} failed:`, (err as Error).message);
    }
  }
  return { tenants: tenants.length, errors, totals };
}

/** Daily loop. Only started by main.ts when config.social.inboxRetention.purgeEnabled is set. */
export function startInboxRetentionPurgeLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const result = await runInboxRetentionPurge();
      // eslint-disable-next-line no-console
      console.log("[SOCIAL-INBOX-RETENTION] purge run:", result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SOCIAL-INBOX-RETENTION] tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
