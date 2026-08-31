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
// spine every department inherits is Home · Project Management · <craft group> ·
// Connections; only the craft group differs per department. Routes/paths are unchanged
// from the old flat model — only the grouping is new — so existing deep links keep working.
//
// 2026-08-10 owner decision: this group's label was "Work" (a vague word, per the same
// complaint that renamed the sidebar's "PM" row) — it is now PM_TERMS.projectManagement,
// the SAME string the sidebar and Business surface use, so the surface reads identically
// everywhere it appears. The group's `key` ("work") and every tab's `path` are unchanged —
// only the label moved, see PM_RENAMES in pmVocabulary.ts.
import type { IconName } from "@/components/shell/icons";
import type { ToolIconName } from "@/components/departments/toolIcons";
import { PM_TERMS } from "@/lib/pmVocabulary";

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
  /** Small brand glyph — the fallback, and still what a tool with no vendored mark renders. */
  glyph: string;
  /** Vendored brand SVG (`components/departments/toolIcons.tsx`). Omit when the icon set has no
   *  mark for this tool: it then renders `glyph`, which is honest, rather than a near-miss logo.
   *  Two launchers MAY share a mark (owner decision 2026-08-19: the Claude products all wear the
   *  sunburst, as they do everywhere else) — the tooltip is then the only thing that separates
   *  them, which is accepted for products of one family. */
  icon?: ToolIconName;
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
  label: PM_TERMS.projectManagement,
  icon: "projects",
  tabs: [
    { key: "projects", label: "Projects", path: "projects", icon: "projects", blurb: "Projects this department owns.", fullBleed: true },
    { key: "board", label: PM_TERMS.board, path: "board", icon: "box", blurb: "The department's working kanban board.", fullBleed: true },
    // Ball — its own tab (owner decision: it must stop polluting the Board view on EVERY
    // PM surface, not just /pm). Same precedent as pm/page-helpers.ts's `BALL_GATE_CAPABILITY`
    // note: this used to be a "Group by" swimlane option on the Board tab above.
    { key: "ball", label: PM_TERMS.ball, path: "ball", icon: "box", blurb: "Who's holding the ball on this department's work.", fullBleed: true },
    { key: "timeline", label: PM_TERMS.gantt, path: "timeline", icon: "clock", blurb: "Schedule and milestones across owned projects.", fullBleed: true },
    { key: "charts", label: PM_TERMS.charts, path: "charts", icon: "pulse", blurb: "Cumulative flow, burndown, and tag breakdown across owned projects.", fullBleed: true },
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
        { key: "prd", label: "PRD Studio", path: "prd", icon: "pulse", blurb: "Create a briefing, record it, convert it to a PRD run, get it approved." },
        // MI-05 — maintenance intake triage queue over the MI-03 endpoints (webdev_change_requests):
        // decline, or convert into a mini pipeline run or a PM task.
        { key: "requests", label: "Requests", path: "requests", icon: "bell", blurb: "Triage client and internal maintenance requests." },
        { key: "repositories", label: "Repositories", path: "repositories", icon: "gateway", blurb: "Every repository the pipeline has provisioned for this department — status, staging, lineage.", fullBleed: true },
        { key: "deliverables", label: "Deliverables", path: "deliverables", icon: "box", blurb: "Files and docs this department's work has produced." },
        // WSK-24 — the WebDesk console: site registry, contract pin status, submissions, and
        // WS4-gated release actions. Reads only (webdesk-design.md §08); every read here degrades
        // honestly rather than pretending Zone B is live (WSK-21 ships no live status/release/
        // submission endpoint yet — see components/webdesk/DegradeBanner.tsx).
        { key: "sites", label: "Sites", path: "sites", icon: "server", blurb: "Provisioned WebDesk sites, contract pins, submissions, and releases." },
        // The ESTATE portfolio, distinct from "Sites" above and listed after it on purpose. "Sites"
        // is the Zone B registry — only what WebDesk itself provisioned, which is legitimately
        // empty today. This is every site we build or operate, including the ones hosted elsewhere
        // that we only track. Shipping the page without this entry left it reachable only by typing
        // the URL, which is the same as not shipping it.
        { key: "portfolio", label: "Portfolio", path: "sites/portfolio", icon: "server", blurb: "Every site we build or operate, by client and project - including ones we only track." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  launchers: [
    // Claude Code wears the Anthropic mark; Claude and Claude Design both wear the sunburst (owner
    // decision — it is the mark those products actually carry, and the tooltip separates them).
    { key: "claude-code", label: "Claude Code", desc: "Agentic coding in the terminal / IDE.", url: "https://claude.ai/code", glyph: "⌘", icon: "anthropic" },
    { key: "claude", label: "Claude", desc: "Chat, reason, and draft with Claude.", url: "https://claude.ai/new", glyph: "✳", icon: "claude" },
    { key: "claude-design", label: "Claude Design", desc: "Generate UI mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆", icon: "claude" },
    { key: "github", label: "GitHub", desc: "Repositories, PRs, and CI.", url: "https://github.com", glyph: "⎇", icon: "github" },
    { key: "figma", label: "Figma", desc: "Design files and prototypes.", url: "https://www.figma.com", glyph: "△", icon: "figma" },
    { key: "vscode", label: "VS Code", desc: "Open the editor on this machine.", url: "vscode://", glyph: "‹›", icon: "vscode" },
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
    { key: "figma", label: "Figma", desc: "Design files and prototypes.", url: "https://www.figma.com", glyph: "△", icon: "figma" },
    { key: "photopea", label: "Photopea", desc: "In-browser pixel editing.", url: "https://www.photopea.com", glyph: "◨" },
    { key: "claude-design", label: "Claude Design", desc: "Generate mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆", icon: "claude" },
    { key: "drive", label: "Shared Drive", desc: "Brand assets and deliverables.", url: "https://drive.google.com", glyph: "▲" },
  ],
};

// ── SEO — search marketing (SEO · SEM · GEO) ─────────────────────────────────
// SM-11. Three craft groups rather than one, ratified by the owner as D-10
// (seo-sem-design.md §08): SEM genuinely cannot fit inside four SEO sub-tabs, so
// Accounts / Optimize / Campaigns each get their own primary-strip division. The
// universal Home · Work · Connections spine is inherited unchanged.
//
// Tabs whose backend has not landed render the BackendPending banner rather than
// an empty table — see lib/searchMarketing.ts for exactly which endpoints exist
// today (properties, engagements + scope + cost-projection + ledger, kpi-targets)
// and which tickets own the rest. "Cost Ledger" (SM-17) IS built — the first UI
// onto the money ledger; see components/search/CostLedgerPanel.tsx for the
// binding "cost to serve (standard rates)" language.
const SEO: DeptToolkit = {
  slug: "seo",
  label: "SEO",
  mission: "Search marketing — organic (SEO), AI answers (GEO), and paid search (SEM).",
  groups: [
    HOME_GROUP,
    WORK_GROUP,
    {
      key: "accounts",
      label: "Accounts",
      icon: "wallet",
      tabs: [
        { key: "engagements", label: "Engagements", path: "engagements", icon: "wallet", blurb: "Client engagements, their tool scope, and provider budgets." },
        { key: "ledger", label: "Cost Ledger", path: "ledger", icon: "wallet", blurb: "Cost-to-serve at standard rates, per provider call." },
        { key: "reports", label: "Reports", path: "reports", icon: "box", blurb: "Monthly client reports — draft, approve, deliver." },
      ],
    },
    {
      key: "optimize",
      label: "Optimize",
      icon: "pulse",
      tabs: [
        { key: "audit", label: "Site Audit", path: "audit", icon: "pulse", blurb: "Crawl a property and triage technical findings." },
        { key: "keywords", label: "Keywords", path: "keywords", icon: "search", blurb: "Import, cluster and tag keywords by intent." },
        { key: "rankings", label: "Rankings", path: "rankings", icon: "pulse", blurb: "Tracked positions over time, drops, and SERP features." },
        { key: "gsc-ga4", label: "Search Console & GA4", path: "gsc-ga4", icon: "search", blurb: "Clicks, impressions, sessions, and conversions pulled from the client's own Google account — $0 to the shared deposit." },
        { key: "briefs", label: "Content Briefs", path: "briefs", icon: "box", blurb: "AI-drafted briefs grounded in your own crawl + keyword data." },
        { key: "ai-visibility", label: "AI Visibility", path: "ai-visibility", icon: "agents", blurb: "How often AI answers cite this brand (GEO/AEO)." },
      ],
    },
    {
      key: "campaigns",
      label: "Campaigns",
      icon: "finance",
      tabs: [
        { key: "planner", label: "Planner", path: "planner", icon: "finance", blurb: "Turn keyword clusters into a campaign plan." },
        { key: "ads", label: "Ads Studio", path: "ads", icon: "box", blurb: "Draft responsive search ads and review change proposals." },
        { key: "search-terms", label: "Search Terms", path: "search-terms", icon: "search", blurb: "Search-term sweeps and negative-keyword proposals." },
        { key: "pacing", label: "Pacing", path: "pacing", icon: "wallet", blurb: "Budget pacing against month-to-date ad spend." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  launchers: [
    // Four Google properties, one Google mark in the set: Search Console takes it (it is the one
    // whose subject IS Google search), Analytics has its own, and Ads/Looker keep their glyphs —
    // four identical G's would be four launchers a reader cannot tell apart.
    { key: "gsc", label: "Search Console", desc: "Impressions, clicks, and indexing.", url: "https://search.google.com/search-console", glyph: "◎", icon: "google" },
    { key: "ga4", label: "Analytics (GA4)", desc: "Traffic and conversions.", url: "https://analytics.google.com", glyph: "▨", icon: "analytics" },
    { key: "google-ads", label: "Google Ads", desc: "Campaigns, budgets, and search terms.", url: "https://ads.google.com", glyph: "◈" },
    { key: "looker", label: "Looker Studio", desc: "Client-facing dashboards.", url: "https://lookerstudio.google.com", glyph: "▤" },
    { key: "claude", label: "Claude", desc: "Draft copy, briefs, and narratives.", url: "https://claude.ai/new", glyph: "✳", icon: "claude" },
  ],
};

// ── Social Media — organic publishing (SMM-11) ───────────────────────────────
// D-18/Δ12 (smm-design-addendum-2026-08-12.md): the department is named "Social Media" (NOT
// "SMM" — the base design's dept name and slug `smm` were both wrong; `deptSlug("Social Media")`
// derives `social-media`, matching `src/seed/roster.ts`'s `d-social` roster entry). Reuses the
// Home / Work / Connections spine unchanged (Δ11); the only NEW group is the reserved craft group
// "Publish": Calendar · Composer · Inbox · Analytics. The module key stays `social` (Cerbos roles
// `social_staff`/`social_manager`, table prefix `social_*`) — only the department's display name
// and console slug changed, never the module.
//
// Registered here ONLY because all four tab routes now exist:
//   Calendar / Composer are REAL — backed by SMM-01/02/08 (engagements, posts, per-network
//   variants, the media-rule/quota validation engine; see lib/social.ts for the exact BFF surface
//   and its documented gaps — most notably no account-listing endpoint yet, SMM-05/07).
//   Inbox / Analytics render the BackendPending shell — their backends are SMM-15 (inbox sync) and
//   SMM-21 (metrics), both still 0.0.0. Per this file's own standing rule ("do NOT add a toolkit to
//   TOOLKITS until its craft-group routes exist, or the toolkit points at 404s"), the ROUTES exist
//   (so the toolkit does not 404) even though two of the four are honest stubs, not live data.
const SOCIAL_MEDIA: DeptToolkit = {
  slug: "social-media",
  label: "Social Media",
  mission: "Social media — organic publishing across every connected network, one master post at a time.",
  groups: [
    HOME_GROUP,
    WORK_GROUP,
    {
      key: "publish",
      label: "Publish",
      icon: "gateway",
      tabs: [
        { key: "calendar", label: "Calendar", path: "calendar", icon: "clock", blurb: "Every post and its per-network variants, by scheduled date.", fullBleed: true },
        { key: "composer", label: "Composer", path: "composer", icon: "pulse", blurb: "Draft a master post and its per-network content." },
        { key: "inbox", label: "Inbox", path: "inbox", icon: "bell", blurb: "Comments and DMs across every connected account." },
        { key: "analytics", label: "Analytics", path: "analytics", icon: "pulse", blurb: "Reach, engagement and delivery metrics per network." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  launchers: [
    { key: "claude", label: "Claude", desc: "Draft captions, hashtags, and reply copy.", url: "https://claude.ai/new", glyph: "✳", icon: "claude" },
    { key: "claude-design", label: "Claude Design", desc: "Generate creative mockups & artifacts.", url: "https://claude.ai/new", glyph: "◆", icon: "claude" },
    { key: "drive", label: "Shared Drive", desc: "Brand assets and approved creative.", url: "https://drive.google.com", glyph: "▲" },
  ],
};

// ── GM — the Office of the GM (GM-01, design `blueprints/gm-console-foundation.md`) ──────────────
// `d-gm` is the ROOT of the department spine (`DEPT_PARENT["d-gm"] = null` in platform-nest's
// `seed/roster.ts`) and is seeded with OVERSIGHT projects rather than client delivery — "which is
// what its people actually own" (`seed/departments.ts`). So GM's craft is reading and deciding, not
// producing: the two craft groups below are `Command` ("what needs me") and `Oversight` ("how are we
// doing"), and there is no Build/Studio/Publish equivalent because the GM ships nothing.
//
// Two craft groups rather than one follows the SEO precedent (D-10): five tabs in one group puts a
// five-wide secondary strip under a two-wide primary, which reads as a flat list with extra steps.
//
// ⚠ THIS IS THE ONLY TOOLKIT WHOSE HOME IS NOT SAFE FOR EVERY MEMBER. Every other department Home
// shows that department's own projects; GM's shows the whole company, and Departments rows are
// ungated on purpose (they come from the org structure). The gate lives in `lib/gm.ts` +
// `GmAccessDenied` and is applied by each tab page — see that file for why the capability is the
// existing `reports.company.view` rather than a new `gm.view` (and why it is NOT `rollups.view`,
// which no role bundle holds except `platform_admin`'s wholesale `ALL`).
//
// The GM console COMPOSES existing surfaces and drills INTO them; it never relocates a route
// (foundation doc §0). `/rollups`, `/reports/company` and the per-department consoles keep their
// URLs and their sidebar rows — this is a second door, not a move.
const GM: DeptToolkit = {
  slug: "gm",
  label: "GM",
  mission: "Office of the GM — the whole business, one altitude up.",
  groups: [
    HOME_GROUP,
    WORK_GROUP,
    {
      key: "command",
      label: "Command",
      icon: "chart",
      tabs: [
        { key: "review", label: "Business Review", path: "review", icon: "chart", blurb: "The recurring review: inputs, then outputs, then money — same shape every period." },
        { key: "decisions", label: "Decisions", path: "decisions", icon: "check", blurb: "What is waiting on the GM, and what has been waiting too long." },
      ],
    },
    {
      key: "oversight",
      label: "Oversight",
      icon: "sitemap",
      tabs: [
        { key: "depts", label: "Departments", path: "depts", icon: "hr", blurb: "Every department's headline figures, side by side." },
        { key: "money", label: "Clients & Money", path: "money", icon: "wallet", blurb: "Client portfolio and what the work costs to serve." },
        { key: "people", label: "People", path: "people", icon: "user", blurb: "Headcount against seats, appraisal cycles, and check-in compliance." },
      ],
    },
    CONNECTIONS_GROUP,
  ],
  // No GitHub, no Figma, no VS Code: the GM does not produce. Claude drafts the narrative that goes
  // around the numbers, Drive holds the artifacts, Looker is where a client-facing cut gets built.
  launchers: [
    { key: "claude", label: "Claude", desc: "Draft the narrative around the numbers.", url: "https://claude.ai/new", glyph: "✳", icon: "claude" },
    { key: "drive", label: "Shared Drive", desc: "Board packs, contracts, and signed documents.", url: "https://drive.google.com", glyph: "▲" },
    { key: "looker", label: "Looker Studio", desc: "Build a shareable cut of a report.", url: "https://lookerstudio.google.com", glyph: "▤" },
  ],
};

const TOOLKITS: DeptToolkit[] = [WEB_DEV, CREATIVES, SEO, SOCIAL_MEDIA, GM];

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
