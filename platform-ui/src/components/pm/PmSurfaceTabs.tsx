// The ONE PM tab row, shared between `/project-management` (Business) and the Business-owned
// `/projects`/`/tasks` list pages — owner directive 2026-08-10: Business must read as one surface,
// not a sidebar row that lands on a page with no relation to the other two. Overview/Ball/Timeline/
// Charts/Productivity are `?view=` on `/project-management` itself (same idiom `/pm` uses);
// Projects/Tasks are real, separately-bookmarked routes (`/projects`, `/tasks` — see the hard
// constraint in the 2026-08-10 rename plan: deep links must not break), so their tabs are plain
// links to those routes rather than another `?view=` value. Pure/no imports beyond vocabulary —
// safe to mount from any server page.
import { PM_TERMS } from "@/lib/pmVocabulary";
import "./pm.css";

export type PmSurfaceTab = "board" | "ball" | "gantt" | "charts" | "productivity" | "projects" | "tasks";

export function PmSurfaceTabs({ active }: { active: PmSurfaceTab }) {
  const tab = (key: PmSurfaceTab, label: string, href: string) => (
    <a href={href} className={`pm-tab${active === key ? " pm-tab--active" : ""}`} aria-current={active === key ? "page" : undefined}>{label}</a>
  );
  return (
    <div className="pm-tabsrow">
      <div className="pm-tabs">
        {tab("board", PM_TERMS.board, "/project-management?view=board")}
        {tab("ball", PM_TERMS.ball, "/project-management?view=ball")}
        {tab("gantt", PM_TERMS.gantt, "/project-management?view=gantt")}
        {tab("charts", PM_TERMS.charts, "/project-management?view=charts")}
        {tab("productivity", PM_TERMS.productivity, "/project-management?view=productivity")}
        {tab("projects", "Projects", "/projects")}
        {tab("tasks", "Tasks", "/tasks")}
      </div>
    </div>
  );
}
