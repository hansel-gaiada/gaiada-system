// Department toolkits — the per-department "interface" definition. Each company's
// departments get their own workspace (a console with tools that department needs).
// This registry maps a department (by its NAME, normalised to a slug — robust to
// whatever id the org structure/backend assigns) to the set of tool TABS it exposes
// and the external tools it can LAUNCH.
//
// Pure + client-safe (no server-only imports) so the sidebar, the console layout,
// its tab pages, and tests can all share one source of truth. Departments without a
// bespoke toolkit fall back to the generic single-tab workspace (Home only).
//
// Tab IA is LOCKED (web-dev-phase1-tickets.md decision #10): Home · Projects · Board ·
// Timeline · Activity · PRD Studio · Repositories · Deliverables · Connections. The
// generic toolkit's Home is the SAME shell every department gets (decision #11 —
// props-only components, zero department-name branching); Web Dev additionally gets
// the full tab set below. First department built out: Web Dev (the template). Others
// (Creatives, SEO, Social Media, GM) inherit the generic Home-only shell until their
// toolkits are built out the same way.
import type { IconName } from "@/components/shell/icons";

export interface DeptTab {
  key: string;
  label: string;
  /** Sub-path under /departments/[deptId]; "" is the console home (Home). */
  path: string;
  icon: IconName;
  blurb: string;
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
  tabs: DeptTab[];
  launchers: DeptLauncher[];
}

// "Web Dev" -> "web-dev", "Social Media" -> "social-media". Stable slug from a name.
export function deptSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The Home tab every department gets — the console's command center. Build
// Tools folds into Home as a launcher row (decision #10/Q4) rather than its
// own tab, so Home is the one tab every toolkit (bespoke or generic) has.
const HOME: DeptTab = {
  key: "home",
  label: "Home",
  path: "",
  icon: "home",
  blurb: "Project health, recent activity, and where to go next.",
};

// ── Web Dev — the template department ────────────────────────────────────────
// Handles web development: project ownership + the working board, a schedule
// view, a cross-source activity feed, requirements capture (audio → PRD via
// the WS11 pipeline), and the connection-backed tabs (repos/deliverables/
// connections) that light up once F1 (P1-08) lands.
const WEB_DEV: DeptToolkit = {
  slug: "web-dev",
  label: "Web Dev",
  mission: "Web development — from client requirements to a shipped build.",
  tabs: [
    HOME,
    { key: "projects", label: "Projects", path: "projects", icon: "projects", blurb: "Projects this department owns." },
    { key: "board", label: "Board", path: "board", icon: "box", blurb: "The department's working kanban board." },
    { key: "timeline", label: "Timeline", path: "timeline", icon: "clock", blurb: "Schedule and milestones across owned projects." },
    { key: "activity", label: "Activity", path: "activity", icon: "pulse", blurb: "The full cross-source activity feed." },
    { key: "prd", label: "PRD Studio", path: "prd", icon: "pulse", blurb: "Record a requirements briefing; turn it into a PRD." },
    { key: "repositories", label: "Repositories", path: "repositories", icon: "gateway", blurb: "Linked code repositories." },
    { key: "deliverables", label: "Deliverables", path: "deliverables", icon: "box", blurb: "Files and docs this department's work has produced." },
    { key: "connections", label: "Connections", path: "connections", icon: "hub", blurb: "Connect GitHub, Google Drive, and Claude seats." },
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
// Handles creative assets: product media and marketing imagery. Its bespoke tool
// is the Image Studio — client-side auto-correction, presets and manual colour
// grading (see components/creative). Backed by the imaging engine (lib/imaging).
const CREATIVES: DeptToolkit = {
  slug: "creatives",
  label: "Creatives",
  mission: "Creative production — from raw capture to on-brand, export-ready assets.",
  tabs: [
    OVERVIEW,
    { key: "studio", label: "Image Studio", path: "studio", icon: "box", blurb: "Auto-correct, grade and batch-export product & creative imagery." },
    { key: "tools", label: "Build Tools", path: "tools", icon: "gateway", blurb: "Launch into the tools the team creates with." },
  ],
  launchers: [
    { key: "figma", label: "Figma", desc: "Design files and prototypes.", url: "https://www.figma.com", glyph: "△" },
    { key: "photopea", label: "Photopea", desc: "In-browser pixel editing.", url: "https://www.photopea.com", glyph: "◨" },
    { key: "claude-design", label: "Claude Design", desc: "Generate mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆" },
    { key: "drive", label: "Shared Drive", desc: "Brand assets and deliverables.", url: "https://drive.google.com", glyph: "▲" },
  ],
};

const TOOLKITS: DeptToolkit[] = [WEB_DEV, CREATIVES];

// The generic toolkit for departments without a bespoke build-out yet. Renders
// the exact same Home shell as Web Dev's Home tab (decision #11 template
// proof) — just without the additional bespoke tabs.
function genericToolkit(name: string): DeptToolkit {
  return { slug: deptSlug(name), label: name, mission: `${name} — team workspace.`, tabs: [HOME], launchers: [] };
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

/** Absolute href for a tab within a department console. */
export function tabHref(deptId: string, tab: DeptTab): string {
  return tab.path ? `/departments/${deptId}/${tab.path}` : `/departments/${deptId}`;
}
