// Department toolkits — the per-department "interface" definition. Each company's
// departments get their own workspace (a console with the tools that department
// needs). This registry maps a department (by its NAME, normalised to a slug —
// robust to whatever id the org structure/backend assigns) to the set of tool
// TABS it exposes and the external tools it can LAUNCH.
//
// Pure + client-safe (no server-only imports) so the sidebar, the console layout,
// its tab pages, and tests can all share one source of truth. Departments without
// a bespoke toolkit fall back to the generic single-group workspace (Home only).
//
// IA is TWO-LEVEL (2026-07-23 redesign, docs/superpowers/plans/
// 2026-07-23-dept-console-ia-redesign.md). A department console is a small stable
// spine of GROUPS (primary strip); each group holds one or more related TABS
// (secondary sub-tab strip, shown only when a group has >1 tab). The universal
// spine every department inherits is Home · Work · <craft group> · Connections;
// only the craft group differs per department. Routes/paths are unchanged from the
// old flat model — only the grouping is new — so existing deep links keep working.
import type { IconName } from "@/components/shell/icons";

export interface DeptTab {
  key: string;
  label: string;
  /** Sub-path under /departments/[deptId]; "" is the console home (Home). */
  path: string;
  icon: IconName;
  blurb: string;
  /** Structurally wide surfaces (board/timeline/projects) render full-bleed —
   *  no `MyWorkRail`, independent of the user's global width pref. */
  fullBleed?: boolean;
}

/** A primary-strip group holding one or more related tabs. A single-tab group
 *  renders as a direct link (no secondary sub-tab strip). */
export interface DeptGroup {
  key: string;
  label: string;
  icon: IconName;
  tabs: DeptTab[];
}

export interface DeptLauncher {
  key: string;
  label: string;
  desc: string;
  /** Where the button opens (new tab). External tool / deep link. */
  url: string;
  /** Small brand glyph shown on the launcher card. */
  glyph: string;
}

export interface DeptToolkit {
  slug: string;
  /** Canonical display name for the department this toolkit serves. */
  label: string;
  /** One-line description of what the department does — shown in the console header. */
  mission: string;
  groups: DeptGroup[];
  launchers: DeptLauncher[];
}

// "Web Dev" -> "web-dev", "Social Media" -> "social-media". Stable slug from a name.
export function deptSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Universal spine — every department inherits these three groups ────────────
// Home (command center), Work (the execution views — generic `[deptId]` pages
// that render for any department), and Connections (integrations/settings).
// Build Tools folds into Home as a launcher row rather than its own tab, so Home
// is a single-tab group every toolkit gets.
const HOME: DeptTab = {
  key: "home",
  label: "Home",
  path: "",
  icon: "home",
  blurb: "Project health, recent activity, and where to go next.",
};

const HOME_GROUP: DeptGroup = { key: "home", label: "Home", icon: "home", tabs: [HOME] };

const WORK_GROUP: DeptGroup = {
  key: "work",
  label: "Work",
  icon: "projects",
  tabs: [
    { key: "projects", label: "Projects", path: "projects", icon: "projects", blurb: "Projects this department owns.", fullBleed: true },
    { key: "board", label: "Board", path: "board", icon: "box", blurb: "The department's working kanban board.", fullBleed: true },
    { key: "timeline", label: "Timeline", path: "timeline", icon: "clock", blurb: "Schedule and milestones across owned projects.", fullBleed: true },
    { key: "charts", label: "Charts", path: "charts", icon: "pulse", blurb: "Cumulative flow, burndown, and tag breakdown across owned projects.", fullBleed: true },
    { key: "activity", label: "Activity", path: "activity", icon: "pulse", blurb: "The full cross-source activity feed." },
  ],
};

const CONNECTIONS_GROUP: DeptGroup = {
  key: "connections",
  label: "Connections",
  icon: "hub",
  tabs: [{ key: "connections", label: "Connections", path: "connections", icon: "hub", blurb: "Connect GitHub, Google Drive, and Claude seats." }],
};

// ── Web Dev — the template department ────────────────────────────────────────
// Craft group "Build": the client-requirements → shipped-build pipeline — audio
// briefing → PRD (WS11), linked repositories, and the deliverables it produces.
const WEB_DEV: DeptToolkit = {
  slug: "web-dev",
  label: "Web Dev",
  mission: "Web development — from client requirements to a shipped build.",
  groups: [
    HOME_GROUP,
    WORK_GROUP,
    {
      key: "build",
      label: "Build",
      icon: "gateway",
      tabs: [
        { key: "prd", label: "PRD Studio", path: "prd", icon: "pulse", blurb: "Record a requirements briefing; turn it into a PRD." },
        { key: "repositories", label: "Repositories", path: "repositories", icon: "gateway", blurb: "Linked code repositories." },
        { key: "deliverables", label: "Deliverables", path: "deliverables", icon: "box", blurb: "Files and docs this department's work has produced." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  launchers: [
    { key: "claude-code", label: "Claude Code", desc: "Agentic coding in the terminal / IDE.", url: "https://claude.ai/code", glyph: "⌘" },
    { key: "claude", label: "Claude", desc: "Chat, reason, and draft with Claude.", url: "https://claude.ai/new", glyph: "✳" },
    { key: "claude-design", label: "Claude Design", desc: "Generate UI mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆" },
    { key: "github", label: "GitHub", desc: "Repositories, PRs, and CI.", url: "https://github.com", glyph: "⎇" },
    { key: "figma", label: "Figma", desc: "Design files and prototypes.", url: "https://www.figma.com", glyph: "△" },
    { key: "vscode", label: "VS Code", desc: "Open the editor on this machine.", url: "vscode://", glyph: "‹›" },
  ],
};

// ── Creatives — image production & grading ───────────────────────────────────
// Craft group "Studio": the client-side Image Studio (auto-correction, presets,
// manual colour grading — see components/creative, backed by lib/imaging) plus
// the saved-asset library (originals + grade params, which doubles as the
// phase-2 AI training set). Split into two sub-tabs so each has room.
const CREATIVES: DeptToolkit = {
  slug: "creatives",
  label: "Creatives",
  mission: "Creative production — from raw capture to on-brand, export-ready assets.",
  groups: [
    HOME_GROUP,
    WORK_GROUP,
    {
      key: "studio",
      label: "Studio",
      icon: "box",
      tabs: [
        { key: "studio", label: "Image Studio", path: "studio", icon: "box", blurb: "Auto-correct, grade and batch-export product & creative imagery." },
        { key: "assets", label: "Asset Library", path: "assets", icon: "hub", blurb: "Saved originals & grade params — the curated AI training set." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  launchers: [
    { key: "figma", label: "Figma", desc: "Design files and prototypes.", url: "https://www.figma.com", glyph: "△" },
    { key: "photopea", label: "Photopea", desc: "In-browser pixel editing.", url: "https://www.photopea.com", glyph: "◨" },
    { key: "claude-design", label: "Claude Design", desc: "Generate mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆" },
    { key: "drive", label: "Shared Drive", desc: "Brand assets and deliverables.", url: "https://drive.google.com", glyph: "▲" },
  ],
};

// ── SEO & SMM — DESIGNED, NOT YET BUILT (Phase B) ────────────────────────────
// The template intentionally leaves room for these. They reuse the Home / Work /
// Connections spine unchanged; only their craft group is new. Do NOT add them to
// TOOLKITS until their craft-group pages exist (a toolkit pointing at missing
// routes would 404). Planned craft groups:
//   SEO  → "Optimize": Site Audit · Keywords · Rankings · Content Briefs
//   SMM  → "Publish":  Calendar · Composer · Inbox · Analytics
// See docs/superpowers/plans/2026-07-23-dept-console-ia-redesign.md §2 & §6.

const TOOLKITS: DeptToolkit[] = [WEB_DEV, CREATIVES];

// The generic toolkit for departments without a bespoke build-out yet. Renders
// the exact same Home shell as a bespoke department's Home group — just without
// the additional Work / craft / Connections groups.
function genericToolkit(name: string): DeptToolkit {
  return { slug: deptSlug(name), label: name, mission: `${name} — team workspace.`, groups: [HOME_GROUP], launchers: [] };
}

/** Resolve a department's toolkit by name. Always returns a toolkit (generic fallback). */
export function toolkitFor(deptName: string): DeptToolkit {
  const slug = deptSlug(deptName);
  return TOOLKITS.find((t) => t.slug === slug) ?? genericToolkit(deptName);
}

/** True when a department has a bespoke toolkit (vs. the generic Home-only shell). */
export function hasBespokeToolkit(deptName: string): boolean {
  return TOOLKITS.some((t) => t.slug === deptSlug(deptName));
}

/** Every tab across all of a toolkit's groups, flattened (order preserved). */
export function deptTabs(toolkit: DeptToolkit): DeptTab[] {
  return toolkit.groups.flatMap((g) => g.tabs);
}

/** Absolute href for a tab within a department console. */
export function tabHref(deptId: string, tab: DeptTab): string {
  return tab.path ? `/departments/${deptId}/${tab.path}` : `/departments/${deptId}`;
}
