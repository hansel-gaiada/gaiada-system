// Department toolkits — the per-department "interface" definition. Each company's
// departments get their own workspace (a console with tools that department needs).
// This registry maps a department (by its NAME, normalised to a slug — robust to
// whatever id the org structure/backend assigns) to the set of tool TABS it exposes
// and the external tools it can LAUNCH.
//
// Pure + client-safe (no server-only imports) so the sidebar, the console layout,
// its tab pages, and tests can all share one source of truth. Departments without a
// bespoke toolkit fall back to the generic single-tab workspace (Overview only).
//
// First department built out: Web Dev (the template). Others (Creatives, SEO, Social
// Media, GM) inherit the generic shell until we build their toolkits the same way.
import type { IconName } from "@/components/shell/icons";

export interface DeptTab {
  key: string;
  label: string;
  /** Sub-path under /departments/[deptId]; "" is the console home (Overview). */
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

// The Overview tab every department gets — the console home.
const OVERVIEW: DeptTab = {
  key: "overview",
  label: "Overview",
  path: "",
  icon: "home",
  blurb: "The team, its live work, and where it stands.",
};

// ── Web Dev — the template department ────────────────────────────────────────
// Handles web development: project + workflow, requirements capture (audio → PRD
// via the WS11 pipeline), and the build tools the developers launch into.
const WEB_DEV: DeptToolkit = {
  slug: "web-dev",
  label: "Web Dev",
  mission: "Web development — from client requirements to a shipped build.",
  tabs: [
    OVERVIEW,
    { key: "workflow", label: "Projects & Workflow", path: "workflow", icon: "projects", blurb: "The department's projects and the working board." },
    { key: "prd", label: "PRD Studio", path: "prd", icon: "pulse", blurb: "Record a requirements briefing; turn it into a PRD." },
    { key: "tools", label: "Build Tools", path: "tools", icon: "gateway", blurb: "Launch into the tools the team builds with." },
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

const TOOLKITS: DeptToolkit[] = [WEB_DEV];

// The generic toolkit for departments without a bespoke build-out yet.
function genericToolkit(name: string): DeptToolkit {
  return { slug: deptSlug(name), label: name, mission: `${name} — team workspace.`, tabs: [OVERVIEW], launchers: [] };
}

/** Resolve a department's toolkit by name. Always returns a toolkit (generic fallback). */
export function toolkitFor(deptName: string): DeptToolkit {
  const slug = deptSlug(deptName);
  return TOOLKITS.find((t) => t.slug === slug) ?? genericToolkit(deptName);
}

/** True when a department has a bespoke toolkit (vs. the generic Overview-only shell). */
export function hasBespokeToolkit(deptName: string): boolean {
  return TOOLKITS.some((t) => t.slug === deptSlug(deptName));
}

/** Absolute href for a tab within a department console. */
export function tabHref(deptId: string, tab: DeptTab): string {
  return tab.path ? `/departments/${deptId}/${tab.path}` : `/departments/${deptId}`;
}
