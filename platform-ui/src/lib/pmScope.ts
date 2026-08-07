// PM scope — the axis Repsona's project dropdown switches (plan
// `2026-08-04-pm-repsona-parity-phase4-plan.md` §1.1, workstream A). One shape, three kinds,
// threaded through every `/pm` reader (P4-A3) so Board/Gantt/Charts render off the SAME data
// contract whichever scope is active — only which tasks/projects feed them changes.
//
// Client-safe (no imports, no `server-only`) — `ScopeSwitcher` (a client component) needs the type
// and the encode/decode helpers, and the server-side readers (`lib/pmScope-data.ts`) need the exact
// SAME parse, so a cookie value and a freshly-built scope object can never disagree about the
// string shape. Same split rationale as `pmVocabulary.ts`/`pmUrgency.ts` — see their headers.

export type PmScopeKind = "all" | "department" | "project";

export interface PmScope {
  kind: PmScopeKind;
  /** Present for "department"/"project"; ignored (should be absent) for "all". */
  id?: string;
}

export const PM_SCOPE_ALL: PmScope = { kind: "all" };

/**
 * "all" | "department:<id>" | "project:<id>" — the ONE string encoding used as both the persisted
 * cookie value and the `<select>` option value in `ScopeSwitcher`, so the switcher's own submitted
 * field and the cookie it gets written to never need a second translation step.
 */
export function encodePmScope(scope: PmScope): string {
  if (scope.kind === "department" && scope.id) return `department:${scope.id}`;
  if (scope.kind === "project" && scope.id) return `project:${scope.id}`;
  return "all";
}

/** Inverse of `encodePmScope`. Anything unrecognised (empty, malformed, a stale/foreign kind)
 *  degrades to `@all` rather than throwing — a corrupted cookie must never brick the PM surface. */
export function parsePmScope(raw: string | undefined | null): PmScope {
  if (!raw || raw === "all") return PM_SCOPE_ALL;
  const sep = raw.indexOf(":");
  if (sep < 0) return PM_SCOPE_ALL;
  const kind = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if ((kind === "department" || kind === "project") && id) return { kind, id };
  return PM_SCOPE_ALL;
}

/** Cookie name for the persisted scope (P4-A4 — "persist like the company switcher does",
 *  `lib/tenant.ts`'s `gaiada_tenant` is the model). Lives here (not in the "use server" actions
 *  file) so a client component could read/compare it without importing a server-actions module. */
export const PM_SCOPE_COOKIE = "gaiada_pm_scope";
