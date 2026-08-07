// Pure helpers for the `/pm` page (P4-A5), split out of `page.tsx` so they're unit-testable in
// isolation — a `page.tsx` module may only export `default`/the other Next.js-reserved names
// (anything else fails the build with TS2344), same reasoning as the sibling
// `departments/[deptId]/projects/page-helpers.ts`.
import { PM_TERMS } from "@/lib/pmVocabulary";
import type { Tag } from "@/lib/pm";

export type PmSwimlane = "status" | "assignee" | "ball" | "priority";
export const PM_SWIMLANES: { value: PmSwimlane; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "assignee", label: PM_TERMS.responsible },
  { value: "ball", label: PM_TERMS.ball },
  { value: "priority", label: "Priority" },
];

export function isSwimlane(v: string | undefined): v is PmSwimlane {
  return v === "status" || v === "assignee" || v === "ball" || v === "priority";
}

export type PmView = "board" | "gantt" | "charts";
export function isView(v: string | undefined): v is PmView {
  return v === "board" || v === "gantt" || v === "charts";
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
