// SM-61 (tracker §6au Ruling 1, clause 5 — binding) — the ONE place "cadence" turns into a number.
//
// WHY THIS FILE EXISTS: `providers/dispatch.ts`'s cost projection and `pull-scheduler.ts`'s
// due-ness derivation used to each parse `tool_scope.<tool>.cadence` independently, and they
// silently disagreed about what an ABSENT cadence means — the projection priced it as one
// on-demand refresh/month, the scheduler ran it as if it were weekly (~4.3x more often than the
// panel showed). That is SM-61: two normalizations of the same input, agreeing to disagree (§6ab's
// lesson, repeated). The fix is not a better default; it is removing the idea of a default.
//
// THE LOAD-BEARING PROPERTY: `parseCadence` has NO DEFAULT PATH. Absent, `null`, wrong case,
// whitespace, or outright junk — every non-enum input — returns `null`, never a guessed schedule.
// The return type `Cadence | null` forces every caller to open an `if (cadence === null)` branch
// and decide, for ITS OWN purpose, what "no cadence" means:
//   - the scheduler (`pull-scheduler.ts`): never select — an enabled tool with no cadence is
//     `on_demand`, not a fallback schedule (§6au Ruling 1 clause 1);
//   - the projection (`providers/dispatch.ts`): price it as the on-demand USAGE ESTIMATE
//     (`ON_DEMAND_ESTIMATE_RUNS_PER_MONTH`), which is also the only correct reading for
//     `suggestions` — a toggle with no scheduled flow at all (clause 3).
// The architect's ruling (§6au): the scope editor's cadence <select> already renders an empty
// value as "on-demand" (ScopeEditor.tsx's CADENCE_OPTIONS) — so `null` here is not an omission the
// platform failed to fill in, it is the configuration the UI has been naming all along.
//
// LEAF MODULE, ON PURPOSE: this file imports nothing from `pull-scheduler.ts` or
// `providers/dispatch.ts`, and must never be given a reason to. Both of those import ONLY this
// module for cadence semantics — a third normalization anywhere is exactly the class of drift SM-61
// exists to foreclose structurally rather than by review discipline.
//
// `platform-ui` cannot import this (separate project, no shared package — see CLAUDE.md's "not a
// monorepo" rule). Its mirrors (`searchMarketingShared.ts` preset seeds, `demoFixtures.ts`'s own
// tiny cadence table) stay mirrors, held in step by cross-repo pin tests, same pattern as the
// existing scope-preset mirror.

/** The three schedulable windows. Deliberately NOT `"absent"` or `""` as a member — those are
 *  represented by the ABSENCE of a `Cadence`, i.e. by `null`, never by a fourth enum value, so a
 *  caller can never accidentally treat "no cadence" as one case among four interchangeable strings. */
export type Cadence = "daily" | "weekly" | "monthly";

const CADENCE_VALUES: readonly Cadence[] = ["daily", "weekly", "monthly"];

/** Exact-match only — no trim, no case-fold. A hand-edited `tool_scope` blob containing `"Daily"`
 *  or `" daily "` is JUNK, not a typo to be forgiving about: forgiving it would silently turn a
 *  malformed write into a real schedule, which is precisely the "junk parses to a guessed schedule"
 *  failure §6au forecloses. Junk parses to on-demand instead — inert, not a schedule. */
export function isCadence(v: unknown): v is Cadence {
  return typeof v === "string" && (CADENCE_VALUES as readonly string[]).includes(v);
}

/** `null` = on-demand. See the file header: there is no default branch, by design. */
export function parseCadence(v: unknown): Cadence | null {
  return isCadence(v) ? v : null;
}

/** `sm-rank-pull.json`'s windows, ported verbatim (originally landed in the now-deleted
 *  `pull-scheduler.ts` constant `CADENCE_DAYS`). Takes a real `Cadence` only — a caller holding a
 *  `null` has no window to ask for; that caller's job is to recognize on-demand BEFORE reaching
 *  here, not to feed this function a default to plug the gap. */
export function cadenceDays(cadence: Cadence): number {
  switch (cadence) {
    case "daily": return 1;
    case "weekly": return 7;
    case "monthly": return 30;
  }
}

/** Runs/month for a REAL, SCHEDULED cadence — `providers/dispatch.ts`'s pricing arithmetic for a
 *  tool that actually has a cadence. Same shape restriction as `cadenceDays`: no `null` branch, so
 *  "on-demand" can never be fed through this function and come out looking like a schedule. */
export function scheduledRunsPerMonth(cadence: Cadence): number {
  switch (cadence) {
    case "daily": return 30;
    case "weekly": return 30 / 7; // ~4.29
    case "monthly": return 1;
  }
}

/** The on-demand USAGE ESTIMATE (§6au Ruling 1 clause 3): one refresh/month, for a tool that is
 *  enabled but carries no cadence — exactly the figure `providers/dispatch.ts`'s pre-SM-61
 *  absent-cadence default always displayed (`runsPerMonth()`'s old `default: 1` branch), and the
 *  ONLY possible reading for `suggestions`, which has no scheduled flow at all (SM-54 never
 *  reassigned it — see `SCHEDULED_TOOLS` below). This is a PRICING number, never a SCHEDULING one:
 *  nothing dispatches because of it, it only prices a human's assumed manual-pull cadence so the
 *  scope panel never shows a blank for an enabled, on-demand-only capability. */
export const ON_DEMAND_ESTIMATE_RUNS_PER_MONTH = 1;

/** The `tool_scope` keys SM-54 actually reassigns from n8n (design §10's `sm-rank-pull`,
 *  `sm-keyword-refresh`, `sm-backlink-snapshot`, `sm-ai-visibility` rows) — i.e. the values of
 *  `providers/types.ts`'s `OP_SCOPE_TOGGLE` for serp/volume/backlinks/ai_visibility.
 *  `suggestions` is deliberately absent: no cadence-driven flow was ever specced for it, so a
 *  `suggestions` toggle is ALWAYS the on-demand estimate, never `scheduled: true`, regardless of
 *  whether a cadence happens to be present on it.
 *
 *  Lives in this leaf module — not duplicated once in `pull-scheduler.ts` and once in
 *  `providers/dispatch.ts` — for the same reason `parseCadence` does: two independent copies of
 *  "which tools are actually scheduled" is exactly the kind of fact that silently drifts, and
 *  `ProjectedToolCost.scheduled`'s derivation (enabled ∧ cadence present ∧ tool ∈ SCHEDULED_TOOLS,
 *  §6au Ruling 1 clause 3) needs the SAME list `pull-scheduler.ts` sweeps. `pull-scheduler.ts`
 *  re-exports both names so its own existing callers/tests need not reach into a second file. */
export const SCHEDULED_TOOLS = ["rank", "volume", "backlinks", "ai_visibility"] as const;
export type ScheduledTool = (typeof SCHEDULED_TOOLS)[number];
