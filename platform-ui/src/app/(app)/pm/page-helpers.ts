// Pure helpers for the `/pm` page (P4-A5), split out of `page.tsx` so they're unit-testable in
// isolation — a `page.tsx` module may only export `default`/the other Next.js-reserved names
// (anything else fails the build with TS2344), same reasoning as the sibling
// `departments/[deptId]/projects/page-helpers.ts`.
import { PM_TERMS } from "@/lib/pmVocabulary";
import type { Tag, AxisColumn } from "@/lib/pm";
import type { Capability } from "@/lib/rbac";

// The Ball tab's OWN affordance gate — P4-B6 / owner decision 2026-08-06 ("anyone can pass the
// ball"). `reassignBall` (lib/pmActions.ts) submits its PATCH gated on exactly this capability,
// which mirrors Cerbos's `pm_task:update` grant (member/viewer/team_lead/manager/company_admin —
// see `pm.contribute`'s doc comment in lib/rbac.ts and "pm.contribute mirrors Cerbos
// pm_task:update" in rbac.test.ts). `page.tsx`'s Board/Gantt tabs stay on `pm.manage` — their own
// writes (moveTask/setTaskPriority/reassignResponsible/rescheduleTask) genuinely ARE manage-gated.
// Only the Ball tab must use THIS constant for its own `canPassBall`, not the Board/Gantt `canEdit`
// — a prior version of this page passed the manage-tier flag into the Ball tab too, which silently
// undid "anyone can pass the ball" at the rendering layer even though the write path underneath was
// already correct (a `member` who reads the resulting empty-state note has no reason to try the
// drag that would in fact succeed). `ball-gate.test.ts` pins this against drifting back.
export const BALL_GATE_CAPABILITY: Capability = "pm.contribute";

// `ball` used to be a fourth "Group by" axis here — owner decision 2026-08-09: it cluttered the
// board view (switching the whole board layout just to see who's holding the ball), so it moved
// out to its own top-level tab (`PmView`'s "ball", page.tsx's `BallSection`) and is no longer a
// Board grouping option. A bookmarked `?swimlane=ball` link degrades gracefully — `isSwimlane`
// below no longer accepts it, so `page.tsx` falls back to its `"status"` default rather than
// throwing or rendering something that no longer exists.
export type PmSwimlane = "status" | "assignee" | "priority";
export const PM_SWIMLANES: { value: PmSwimlane; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "assignee", label: PM_TERMS.responsible },
  { value: "priority", label: "Priority" },
];

export function isSwimlane(v: string | undefined): v is PmSwimlane {
  return v === "status" || v === "assignee" || v === "priority";
}

// "ball" (P4-B6/owner decision 2026-08-09) is a peer tab now, not a Board swimlane — see the note
// above `PmSwimlane`.
export type PmView = "board" | "ball" | "gantt" | "charts" | "productivity";
export function isView(v: string | undefined): v is PmView {
  return v === "board" || v === "ball" || v === "gantt" || v === "charts" || v === "productivity";
}

// Same "first registry that carries this label" display-colour rule the department board's tag
// filter uses (`representativeTag` there) — matching a task to a tag never depends on this, it
// only decides which project's hex a filter checkbox renders.
export function representativeTag(label: string, registriesByProject: Record<string, Tag[]>): Tag | undefined {
  for (const reg of Object.values(registriesByProject)) {
    const hit = reg.find((t) => t.label === label);
    if (hit) return hit;
  }
  return undefined;
}

// P4-A6 — Repsona's Responsible/Ball boards both lead with a "no user" column (plan §1.4/§1.5)
// rather than sorting it in alphabetically. `ballColumns` (lib/departments.ts, owned by the
// department surface, imported not edited here) already returns that shape unprompted.
// `assigneeColumns` does not — it sorts "Unassigned" alphabetically (pinned by its own test,
// `departments.test.ts`) and still carries the pre-rename literal label (`PM_RENAMES` in
// `pmVocabulary.ts` records `Unassigned -> PM_TERMS.unassigned` as an open rename). Rather than
// edit a file this page doesn't own, normalise its OUTPUT here at the render boundary: relabel the
// sentinel column and float it to the front, so both boards match the reference at every scope.
// Idempotent on `ballColumns`' own output (the sentinel is already first and already labelled
// `PM_TERMS.unassigned`), so it is safe to apply to both axes uniformly.
//
// `sentinelKey` is the literal each column-builder falls back to when a task has no assignee at
// all — `"__unassigned"` for `assigneeColumns`/`responsibleKey`, `"__no_ball"` for
// `ballColumns`/`ballKey` (lib/departments.ts). Not re-derived from those functions (they take a
// whole `PmTask`, not a bare sentinel) — if departments.ts ever renames its sentinel, this simply
// stops finding a match and falls back to the untouched column order rather than throwing.
export function leadWithUnassigned<K extends string>(columns: AxisColumn<K>[], sentinelKey: K): AxisColumn<K>[] {
  const idx = columns.findIndex((c) => c.key === sentinelKey);
  if (idx === -1) return columns;
  const relabelled: AxisColumn<K> = { ...columns[idx], label: PM_TERMS.unassigned };
  const rest = columns.filter((_, i) => i !== idx);
  return [relabelled, ...rest];
}
