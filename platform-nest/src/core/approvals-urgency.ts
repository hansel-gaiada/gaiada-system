// WSUX-1 / D-UX-3 — the CANONICAL urgencyScore weighting for the unified approvals read
// (`GET /api/approvals`, contract §9a). Documented ONCE here (and mirrored in
// docs/FRONTEND-BFF-CONTRACT.md §9a) so the server's ranking and the UI's later
// `lib/queueUrgency.ts` (WSUX-5, ordering-parity fixture test) cite the same numbers instead of
// drifting. A one-file tuning knob per the binding spec §1.4/§7 Q13 — the owner may retune these
// constants; nothing else in the request path needs to change.
//
// None of the three unioned sources (agency_approvals, pipeline_gates, automation_approvals)
// carry a due date — unlike tasks, "urgency" here is origin tier (how blocking the ask
// structurally is) + impact (automation/agent only) + how long it has been waiting. Higher score
// = more urgent = sorted first.
// `search` added 2026-09-03 for probe-consent requests (modules/search/probe-consent.ts). Without
// it those rows are invisible in the unified inbox: `approvals.controller.ts` filters
// `origin = ANY($1)` from `ALL_ORIGINS`, so an unlisted origin files a request nobody can find.
// Caught by driving the flow, not by a type error — the origin is a plain string column.
export type ApprovalOrigin = "agency" | "pipeline" | "hr" | "automation" | "agent" | "search";

/** Base tier per origin. Pipeline gates (client/delivery-blocking sign-off) and agency
 *  creative-review sit above automation/agent write-suspensions, which sit above hr leave asks
 *  (spec §1.2's mock ranks a leave request "SOON" while approvals/gates are "NOW"). */
export const ORIGIN_BASE_WEIGHT: Record<ApprovalOrigin, number> = {
  pipeline: 100,
  agency: 90,
  automation: 80,
  agent: 80,
  // A probe-consent request blocks monitoring coverage for a client domain and nothing is failing
  // while it waits, so it does not outrank a suspended write or a stalled deploy. It sits with HR's
  // people-decisions: important, not urgent. It DOES carry an `impact` (filed 'high'), so the
  // IMPACT_BONUS still lifts it above a routine row of the same age.
  search: 70,
  hr: 70,
};

/** Automation/agent suspensions carry an `impact` classification (WS4 §3) — a high-impact
 *  suspended write should outrank a routine one at the same age. Not applicable to the other
 *  three origins (they have no impact concept), so callers pass `undefined` there. */
export const IMPACT_BONUS: Record<string, number> = {
  high: 15,
  medium: 5,
  unclassified: 0,
};

/** Age contributes up to +40, saturating around ~3.3 days (80h) pending so a very old item
 *  cannot silently outrank a same-day pipeline gate by age alone, but a same-origin item that has
 *  waited longer always outranks a fresher one of the same origin/impact. */
const AGE_SATURATION_HOURS = 80;
const AGE_MAX_BONUS = 40;

export function ageBonus(ageMs: number): number {
  const ageHours = Math.max(0, ageMs) / 3_600_000;
  return Math.min(ageHours, AGE_SATURATION_HOURS) * (AGE_MAX_BONUS / AGE_SATURATION_HOURS);
}

/** The one function every leg of `GET /api/approvals` calls to compute `urgencyScore`. */
export function urgencyScore(origin: ApprovalOrigin, ageMs: number, impact?: string): number {
  const base = ORIGIN_BASE_WEIGHT[origin];
  const impactPart = impact !== undefined ? (IMPACT_BONUS[impact] ?? 0) : 0;
  return base + impactPart + ageBonus(ageMs);
}
