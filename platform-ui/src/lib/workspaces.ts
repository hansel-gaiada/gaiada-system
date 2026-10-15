// Department workspaces: THE registry (DW-1a, docs/plans/2026-10-13-department-workspaces.md).
//
// A workspace is a department's console grown into the employee's whole working surface. The sidebar
// becomes that department's menu (Overview and AI Assistant, Work, Performance, You), and its Overview
// is the all-seeing dashboard. This file describes every workspace in one place: the Work rows and
// their tabs (absolute hrefs), the shared Performance block, the Tools & connections sets, Overview
// widgets, pulse tiles, quick actions, KPI starting sets and the routes each workspace owns. It also
// holds the three areas that are not departments: You (personal), Company and Admin.
//
// Rules this file keeps (plan §2.6):
// - URLs never move. Every href here is an EXISTING route, and `{dept}` / `{company}` stand for the
//   department's org node id and the active company id (`hrefFor`). Anything not built yet carries
//   `ticket` (the DW ticket that builds it, with its planned path), and nothing with a ticket may be
//   rendered. `workspaces.test.ts` checks every other href against the page files.
// - Nothing loses its home. Every tab of today's toolkits and of the HR, Finance and IT consoles has a
//   place here (pinned by the test), even where the plan's table does not name it (HR's and Finance's
//   Settings).
// - Gates are DATA (`Gate`), copied from the surface each row comes from (nav.ts, the HR layout, the
//   toolkit's `requires`). They mirror the server; Cerbos and RLS stay the authority. The program's one
//   access change (DW-D15) arrives only through `unitCap`, answered by rbac.ts's `canInUnit`.
// - Keyed by (pack, department slug), never by a company (PV-D13). The bespoke workspaces are the
//   agency pack's, by the same rule as `toolkitFor` (PV-D15). HR, Finance and IT are functional and
//   exist in every vertical. Any other department gets the generic workspace.
// - Pure and client-safe. The sidebar picks its area on the client (Next layouts get no pathname, plan
//   §13 trap 2), so nothing server-only may be imported here.
//
// Nothing renders from this file yet: DW-1 makes no visible change, and DW-2 draws the shell from it.
import type { IconName } from "@/components/shell/icons";
import type { Capability } from "@/lib/rbac";
import { packFor, type AgencyRowKey, type PackKey } from "@/lib/packs";
import { bespokeToolkit, deptSlug, type DeptLauncher, type DeptTab } from "@/lib/deptToolkits";
import { PM_TERMS } from "@/lib/pmVocabulary";

// ── Types ─────────────────────────────────────────────────────────────────────────────────────────

/** Who may be offered a row, tab, widget or action. Evaluated by the shell against the active company. */
export type Gate =
  /** `can(me, cap, activeCompany)`. */
  | { kind: "cap"; cap: Capability }
  /** Company `can()`, or an `org_unit_lead` grant on the workspace's unit or an ancestor (`canInUnit`, DW-D15). */
  | { kind: "unitCap"; cap: Capability }
  /** nav.ts's agency-row rule: the active company's pack lists the row, and its module (if it has one) is on. */
  | { kind: "agencyRow"; row: AgencyRowKey }
  /** The active company's pack. For cross-department work only the agency pack has (campaigns, requests). */
  | { kind: "pack"; pack: PackKey }
  /** The active company has the module on (`moduleOn`: unknown hides nothing). */
  | { kind: "module"; module: string }
  /** The active company has a department whose workspace is this key (`workspaceKeysOf`, DW-5f): "Ask Creatives" only
   *  where there is a Creatives to ask. Unlike `module`, unknown hides. */
  | { kind: "hasWorkspace"; workspace: string }
  /** `isElevated(me)`: global `platform_admin`. */
  | { kind: "elevated" }
  /** `isPlatformOperator(me)` (PV-D18). */
  | { kind: "platformOperator" }
  /** The Group area: the root owner or `platform_admin`, while the active company is the root (PV-D11). */
  | { kind: "rootGroup" }
  /** Approvals "when it concerns you" (DW-D23, owner ruling 2026-10-14): something waits on this person's decision, or they
   *  hold any right to decide (`DECIDE_CAPABILITIES`, in any company they can reach: the inbox is cross-company). Deciding is
   *  split across several Cerbos rights and some are conditional, so a capability check alone could hide the row from a real
   *  decider; the pending count is the second arm. UNKNOWN NEVER HIDES: a caller that did not read the approvals (the palette,
   *  the classic shell) or whose read failed gets the row, so the page stays reachable for everyone and the server decides who
   *  may act (`GateContext.approvals`). */
  | { kind: "decider" }
  | { kind: "all"; gates: readonly Gate[] }
  | { kind: "any"; gates: readonly Gate[] };

export interface WorkspaceTab {
  key: string;
  label: string;
  /** Absolute. `{dept}` is the department's org node id and `{company}` the active company (`hrefFor`). */
  href: string;
  icon: IconName;
  blurb?: string;
  gate?: Gate;
  /** Not built yet: the ticket that builds it. Never rendered while set. */
  ticket?: string;
}

/** The counts a sidebar row can carry (DW-8m). A key, never a number: the shell reads the figure for the key when it builds
 *  the model (`concreteRows`), and a count of 0 or an unknown one draws nothing. Only "approvals" is built; My tasks and
 *  Inbox plug in by adding a key here and a case to `badgeCount` (`lib/workspaceAccess.ts`). */
export type RowBadge = "approvals";

/** A sidebar row. With one tab it is a plain link; with more, the shell draws one tab strip (DW-2b). */
export interface WorkspaceRow {
  key: string;
  label: string;
  icon: IconName;
  tabs: readonly WorkspaceTab[];
  gate?: Gate;
  ticket?: string;
  /** The count the sidebar draws after the label, when it is above 0 (DW-8m). */
  badge?: RowBadge;
}

/** The Overview's five bands, in their fixed order (plan §3.1). A widget never moves band. */
export const OVERVIEW_BANDS = ["now", "you", "department", "work", "growth"] as const;
export type OverviewBand = (typeof OVERVIEW_BANDS)[number];

export interface OverviewWidget {
  key: string;
  band: OverviewBand;
  label: string;
  gate?: Gate;
  ticket?: string;
}

/** A department tile on the Overview. A tile with no backend is hidden, and a failed read says
 *  "unavailable", never 0 (plan §3.3). */
export interface PulseTile {
  key: string;
  label: string;
  ticket?: string;
  /** A built tile names the honest reader that feeds it (`lib/overviewPulse.ts`) and the page that lists
   *  the items it counts (`{dept}` as in every href here). A tile with a `ticket` has neither (DW-3e). */
  source?: PulseSource;
  href?: string;
}

/** The readers a Pulse tile can draw from: one per tile, each with its own failure semantics. */
export type PulseSource =
  | "change-requests-new" | "pipeline-gates-pending" | "monitoring-problem-sites"
  | "social-posts-scheduled" | "social-posts-failed" | "it-account-requests"
  | "hr-leave-pending" | "hr-onboarding-open" | "hr-cases-open" | "hr-payroll-waiting" | "it-devices-offline"
  | "finance-payments-to-confirm" | "finance-overdue-receivables" | "finance-close-progress" | "finance-integrity-findings"
  | "it-security-alerts"
  | "automation-failures";

export interface QuickAction {
  key: string;
  label: string;
  href: string;
  gate?: Gate;
  ticket?: string;
}

/** A department KPI's starting definition (plan §5.5). Targets are data, set per company and period (DW-4e). */
export interface DeptKpi {
  key: string;
  label: string;
}

/** An account the department's work is linked to (the Connections half of Tools & connections, §4.1). */
export interface ConnectionKind {
  key: string;
  label: string;
  ticket?: string;
}

/** `department` = an agency craft department, `office` = the Office of the GM, `functional` = HR,
 *  Finance or IT (every vertical), `generic` = any other department. */
export type WorkspaceKind = "department" | "office" | "functional" | "generic";

export interface Workspace {
  /** The department slug (`deptSlug` of its name), or "generic". */
  key: string;
  kind: WorkspaceKind;
  label: string;
  mission: string;
  /** The page that is this workspace's Overview today. DW-3a points `/` at it. */
  overviewHref: string;
  /** The department's own sections, in sidebar order. Tools & connections is appended by `sidebarRows`. */
  work: readonly WorkspaceRow[];
  /** Extra tabs of the shared Reports row (Finance's statements). */
  reports: readonly WorkspaceTab[];
  /** The department's own Analytics tabs, after the shared Work tab (plan §5.2). */
  analytics: readonly WorkspaceTab[];
  tools: readonly DeptLauncher[];
  connections: readonly ConnectionKind[];
  overview: readonly OverviewWidget[];
  pulse: readonly PulseTile[];
  quickActions: readonly QuickAction[];
  /** The keys of this workspace's own create actions, from its quickActions, in order. "+ New" lists them first (DW-2f). */
  creates: readonly string[];
  kpis: readonly DeptKpi[];
  /** Starter prompts the AI Assistant's empty state offers when opened from this workspace (DW-2h). 3 to 4; a suggestion only fills the composer. */
  assistantPrompts: readonly { label: string; prompt: string }[];
  /** Route prefixes OUTSIDE `/departments/{dept}` that belong to this workspace (`areaFor`, DW-1c). */
  ownedRoutes: readonly string[];
}

// ── Helpers for building the data ─────────────────────────────────────────────────────────────────

const deptPath = (path: string) => (path ? `/departments/{dept}/${path}` : "/departments/{dept}");

/** A tab copied from today's toolkit, so its path, icon, blurb and `requires` gate have one source.
 *  Throws on a missing key: the registry must never silently drop a tab (the test imports this file). */
function fromToolkit(slug: string, key: string, override: Partial<WorkspaceTab> = {}): WorkspaceTab {
  const tab: DeptTab | undefined = bespokeToolkit(slug)?.groups.flatMap((g) => g.tabs).find((t) => t.key === key);
  if (!tab) throw new Error(`workspaces: toolkit tab ${slug}/${key} does not exist`);
  return {
    key: tab.key,
    label: tab.label,
    href: deptPath(tab.path),
    icon: tab.icon,
    blurb: tab.blurb,
    ...(tab.requires ? { gate: { kind: "cap", cap: tab.requires } as Gate } : {}),
    ...override,
  };
}

function launchersOf(slug: string): readonly DeptLauncher[] {
  const tk = bespokeToolkit(slug);
  if (!tk) throw new Error(`workspaces: toolkit ${slug} does not exist`);
  return tk.launchers;
}

// Tools that the new sets add (§4.1, DW-Q5). Same shape as the toolkit launchers.
const CLAUDE: DeptLauncher = { key: "claude", label: "Claude", desc: "Chat, reason, and draft with Claude.", url: "https://claude.ai/new", glyph: "✳", icon: "claude" };
const DRIVE: DeptLauncher = { key: "drive", label: "Shared Drive", desc: "The department's shared files.", url: "https://drive.google.com", glyph: "▲" };

// Connections (§4.1). Figma is DW-6k (DW-Q6); bank feeds and the IT admin consoles are not built (DW-7i, plan §4.3).
const CONN = {
  github: { key: "github", label: "GitHub" },
  figma: { key: "figma", label: "Figma" },
  drive: { key: "drive", label: "Google Drive" },
  claudeSeats: { key: "claude-seats", label: "Claude seats" },
  googleAccounts: { key: "google-accounts", label: "Google accounts (Search Console, GA4, Ads)" },
  socialAccounts: { key: "social-accounts", label: "Social accounts" },
  bankFeeds: { key: "bank-feeds", label: "Bank feeds", ticket: "DW-7i" },
  networkController: { key: "network-controller", label: "Network controller", ticket: "DW-7i" },
  workspaceAdmin: { key: "workspace-admin", label: "Google Workspace admin", ticket: "DW-7i" },
} satisfies Record<string, ConnectionKind>;

// ── The Overview (plan §3) ────────────────────────────────────────────────────────────────────────

const AGENCY_ONLY: Gate = { kind: "pack", pack: "agency" };

/** Every department workspace's Overview: the five questions in their fixed order. Campaigns and
 *  Requests are the agency pack's cross-department work, so a generic company never sees them. */
const DEPARTMENT_OVERVIEW: readonly OverviewWidget[] = [
  { key: "needs-you", band: "now", label: "Needs you" },
  { key: "today", band: "now", label: "Today" },
  { key: "your-numbers", band: "you", label: "Your numbers" },
  { key: "my-activity", band: "you", label: "My activity" },
  { key: "condition", band: "department", label: "Department condition" },
  { key: "pulse", band: "department", label: "Pulse" },
  // The Work blocks (DW-3f) each read for the department's org node (`departmentId` / `unitId`). HR, Finance and IT are
  // functional workspaces with no node, so they have nothing to scope to and the frame does not place these blocks
  // there (`workWidgetPlaced`); the Work band then has nothing and is dropped.
  { key: "projects", band: "work", label: "Projects" },
  { key: "campaigns", band: "work", label: "Campaigns", gate: AGENCY_ONLY },
  { key: "requests", band: "work", label: "Requests", gate: AGENCY_ONLY },
  { key: "learning", band: "growth", label: "Learning" },
  { key: "appraisal", band: "growth", label: "Appraisal" },
];

// The cockpit's access tiers (`lib/gm.ts`: `gmAccessFor`, `canReadGmMoney`) as registry gates, so the Overview places a block for
// exactly the people the cockpit shows its figures to, and never for anyone else. `companyAccess` (lib/overviewCompany.ts) is the same
// rule in code, and a test pins the two together for every role.
const GM_CONSOLE: Gate = { kind: "any", gates: [{ kind: "cap", cap: "reports.company.view" }, { kind: "cap", cap: "reports.department.view" }] };
/** "full": company-grain figures, and the read of every department's standing (`dept-kpis/overview` is the company-wide tiers'). */
const GM_FULL: Gate = { kind: "cap", cap: "reports.company.view" };
/** Company money is its own boundary: a console reader who also holds the finance read capability. */
const GM_MONEY: Gate = { kind: "all", gates: [GM_CONSOLE, { kind: "cap", cap: "finance.statement.view" }] };

/** The Office of the GM's company Overview (§3.5), same band order. Every block carries the cockpit's own gate. */
export const COMPANY_OVERVIEW: readonly OverviewWidget[] = [
  { key: "decisions", band: "now", label: "Needs you: decisions", gate: GM_CONSOLE },
  { key: "today", band: "now", label: "Today" },
  // Revenue and overdue receivables need the money gate, milestones and utilization the full one; the block draws only the parts the
  // person may see (`companyAccess`).
  { key: "company", band: "department", label: "Company", gate: { kind: "any", gates: [GM_FULL, GM_MONEY] } },
  { key: "departments", band: "department", label: "Departments by condition", gate: GM_FULL },
  // The cockpit's Campaigns row gate. Not `campaigns`: that key is the department blocks' (shared campaigns with OUR part).
  { key: "company-campaigns", band: "work", label: "Campaigns", gate: { kind: "agencyRow", row: "agency" } },
  { key: "learning-compliance", band: "growth", label: "Learning compliance", gate: { kind: "all", gates: [GM_FULL, { kind: "cap", cap: "lms.progress.view" }] } },
  { key: "appraisal-cycle", band: "growth", label: "Appraisal cycle", gate: { kind: "all", gates: [GM_FULL, { kind: "cap", cap: "appraisal.read" }] } },
];

// ── Rows every department workspace shares ───────────────────────────────────────────────────────

/** Project Management: today's Work group tabs. Charts moves to Analytics › Work (§4 "What moves"). */
const PM_ROW: WorkspaceRow = {
  key: "pm",
  label: PM_TERMS.projectManagement,
  icon: "projects",
  tabs: ["projects", "board", "ball", "timeline", "activity"].map((k) => fromToolkit("web-dev", k)),
};

/** Shared campaigns the department has a part in (§7.1): campaign parts are built (DW-5a, DW-5b). */
const SHARED_CAMPAIGNS: WorkspaceTab = {
  key: "shared", label: "Shared", href: deptPath("campaigns"), icon: "sales",
  blurb: "Shared campaigns this department has a part in, with our part's status.",
};

/** The department's clients: the clients with a live project the department (or a unit under it) owns (§33, DW-6d). */
const CLIENTS_ROW: WorkspaceRow = {
  key: "clients",
  label: "Clients",
  icon: "finance",
  gate: { kind: "agencyRow", row: "clients" },
  tabs: [{ key: "clients", label: "Clients", href: deptPath("clients"), icon: "finance" }],
};

/** "Ask Creatives for assets" and "Ask Web Dev" (§7.2): every agency workspace, and only where the company HAS the
 *  receiving department (DW-5f): a company with no Creatives is not offered a link to a page that can only say so. */
const ASK_ACTIONS: readonly QuickAction[] = [
  {
    key: "ask-creatives", label: "Ask Creatives for assets", href: "/requests/new?to=creatives",
    gate: { kind: "all", gates: [AGENCY_ONLY, { kind: "hasWorkspace", workspace: "creatives" }] },
  },
  {
    key: "ask-web-dev", label: "Ask Web Dev", href: "/requests/new?to=web-dev",
    gate: { kind: "all", gates: [AGENCY_ONLY, { kind: "hasWorkspace", workspace: "web-dev" }] },
  },
];

/** Requests › Sent: what this department's people have asked of others, with its status (DW-5h). Every agency
 *  workspace has it, not only Web Dev (§7.3), so the requester tracks the ask where they work. */
const SENT_REQUESTS: WorkspaceTab = {
  key: "sent", label: "Sent", href: deptPath("requests/sent"), icon: "bell",
  blurb: "Requests this department has sent to other departments, and where each one stands.",
};

// ── The agency pack's workspaces (plan §4) ────────────────────────────────────────────────────────

const WEB_DEV: Workspace = {
  key: "web-dev",
  kind: "department",
  label: "Web Dev",
  mission: bespokeToolkit("web-dev")?.mission ?? "",
  overviewHref: deptPath(""),
  work: [
    PM_ROW,
    {
      key: "build", label: "Build", icon: "gateway",
      tabs: [
        fromToolkit("web-dev", "prd"),
        { key: "pipeline", label: "Pipeline", href: "/pipeline", icon: "pulse", gate: { kind: "agencyRow", row: "pipeline" },
          blurb: "Delivery pipeline runs: from an approved PRD to a provisioned, deployed build." },
        fromToolkit("web-dev", "repositories"),
        fromToolkit("web-dev", "deliverables"),
      ],
    },
    {
      key: "run", label: "Run", icon: "server",
      tabs: [
        fromToolkit("web-dev", "portfolio"),
        { key: "monitoring", label: "Monitoring", href: "/monitoring", icon: "pulse", gate: { kind: "agencyRow", row: "monitoring" },
          blurb: "Live health of the client sites and services we operate." },
      ],
    },
    {
      key: "website", label: "Website", icon: "sitemap",
      // Website › Analytics moves to the Analytics row (§4). Visitors keeps its `requires` gate.
      tabs: ["content", "media", "leads", "writers", "visitors"].map((k) => fromToolkit("web-dev", k)),
    },
    {
      key: "requests", label: "Requests", icon: "bell",
      tabs: [
        // Today's MI-05 triage (client maintenance). Internal engineering requests join it in DW-5e.
        fromToolkit("web-dev", "requests", { key: "incoming", label: "Incoming" }),
        SENT_REQUESTS,
      ],
    },
    { key: "campaigns", label: "Campaigns", icon: "sales", gate: AGENCY_ONLY, tabs: [SHARED_CAMPAIGNS] },
    CLIENTS_ROW,
  ],
  reports: [],
  analytics: [
    // DW-4c: no "Sites" analytics page exists; site health lives in Run › Portfolio and Monitoring
    // (`/sites` redirects to the Portfolio), so Analytics holds only the website's own analytics.
    fromToolkit("web-dev", "analytics", { key: "website", label: "Website" }),
  ],
  tools: launchersOf("web-dev"),
  connections: [CONN.github, CONN.figma, CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    { key: "requests-waiting", label: "Requests waiting", source: "change-requests-new", href: deptPath("requests") },
    { key: "sites-with-a-problem", label: "Sites with a problem", source: "monitoring-problem-sites", href: "/monitoring" },
    { key: "runs-waiting-approval", label: "Runs waiting approval", source: "pipeline-gates-pending", href: "/pipeline" },
    // No honest reader yet: a deliverable has no due date to count against.
    { key: "deliverables-due", label: "Deliverables due", ticket: "DW-3e" },
  ],
  creates: ["new-briefing"],
  quickActions: [
    { key: "new-briefing", label: "New briefing", href: deptPath("prd") },
    { key: "triage-requests", label: "Triage requests", href: deptPath("requests") },
    ...ASK_ACTIONS.filter((a) => a.key !== "ask-web-dev"),
  ],
  kpis: [
    { key: "projects-on-time", label: "Projects on time" },
    { key: "requests-within-sla", label: "Requests delivered by the date needed" },
    { key: "client-site-uptime", label: "Client site uptime" },
    { key: "reopened-work-rate", label: "Reopened work rate" },
  ],
  assistantPrompts: [
    { label: "Summarise this week's requests", prompt: "Summarise this week's requests to the Web Dev team and what is still open." },
    { label: "What is blocked on the board?", prompt: "Which tasks on the Web Dev board are blocked, and what are they waiting for?" },
    { label: "Which client sites had downtime?", prompt: "Which client sites had downtime this week, and for how long?" },
    { label: "Draft a client update", prompt: "Draft a short update for the client about " },
  ],
  ownedRoutes: ["/pipeline", "/monitoring"],
};

const SEO: Workspace = {
  key: "seo",
  kind: "department",
  label: "SEO",
  mission: bespokeToolkit("seo")?.mission ?? "",
  overviewHref: deptPath(""),
  work: [
    PM_ROW,
    {
      key: "accounts", label: "Accounts", icon: "wallet",
      // "Reports" becomes "Client reports" so it is never confused with the Reports row (§4). Route unchanged.
      tabs: [fromToolkit("seo", "engagements"), fromToolkit("seo", "ledger"), fromToolkit("seo", "reports", { label: "Client reports" })],
    },
    {
      key: "optimize", label: "Optimize", icon: "pulse",
      // Search Console & GA4 moves to the Analytics row (§4).
      tabs: ["audit", "keywords", "rankings", "briefs", "ai-visibility"].map((k) => fromToolkit("seo", k)),
    },
    { key: "requests", label: "Requests", icon: "bell", gate: AGENCY_ONLY, tabs: [SENT_REQUESTS] },
    {
      key: "campaigns", label: "Campaigns", icon: "finance",
      tabs: [SHARED_CAMPAIGNS, ...["planner", "ads", "search-terms", "pacing"].map((k) => fromToolkit("seo", k))],
    },
    CLIENTS_ROW,
  ],
  reports: [],
  analytics: [
    // DW-4c: the rank tracker and its trend are one page, Optimize › Rankings; one page, one row.
    fromToolkit("seo", "gsc-ga4"),
  ],
  tools: launchersOf("seo"),
  connections: [CONN.googleAccounts, CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    // None built: the SEO readers degrade a refusal to an empty list, so a number from them could read 0 for "denied".
    { key: "ranking-drops", label: "Ranking drops", ticket: "DW-3e" },
    { key: "critical-audit-findings", label: "Critical audit findings", ticket: "DW-3e" },
    { key: "client-reports-waiting", label: "Client reports waiting", ticket: "DW-3e" },
    { key: "budgets-off-pace", label: "Budgets off pace", ticket: "DW-3e" },
  ],
  creates: ["new-content-brief"],
  quickActions: [
    { key: "run-site-audit", label: "Run a site audit", href: deptPath("audit") },
    { key: "new-content-brief", label: "New content brief", href: deptPath("briefs") },
    ...ASK_ACTIONS,
  ],
  kpis: [
    { key: "clients-ranking-growth", label: "Clients with ranking growth" },
    { key: "client-reports-on-time", label: "Client reports delivered on time" },
    { key: "ad-budgets-on-pace", label: "Ad budgets on pace" },
    { key: "client-retention", label: "Client retention" },
  ],
  assistantPrompts: [
    { label: "Which keywords dropped?", prompt: "Which tracked keywords dropped this week, and by how much?" },
    { label: "Which pages lost traffic?", prompt: "Which pages lost the most search traffic this month?" },
    { label: "Draft an article brief", prompt: "Draft a content brief for an article about " },
    { label: "What technical issues are open?", prompt: "Which technical SEO issues are still open across our sites?" },
  ],
  ownedRoutes: [],
};

const SOCIAL_MEDIA: Workspace = {
  key: "social-media",
  kind: "department",
  label: "Social Media",
  mission: bespokeToolkit("social-media")?.mission ?? "",
  overviewHref: deptPath(""),
  work: [
    PM_ROW,
    // Publish › Analytics moves to the Analytics row (§4).
    { key: "publish", label: "Publish", icon: "gateway", tabs: ["calendar", "composer", "inbox"].map((k) => fromToolkit("social-media", k)) },
    { key: "requests", label: "Requests", icon: "bell", gate: AGENCY_ONLY, tabs: [SENT_REQUESTS] },
    {
      key: "campaigns", label: "Campaigns", icon: "sales", gate: AGENCY_ONLY,
      tabs: [
        SHARED_CAMPAIGNS,
        { key: "social", label: "Social campaigns", href: deptPath("campaigns/social"), icon: "sales" },
      ],
    },
    CLIENTS_ROW,
  ],
  reports: [],
  analytics: [fromToolkit("social-media", "analytics", { key: "reach", label: "Reach and engagement" })],
  tools: launchersOf("social-media"),
  connections: [CONN.socialAccounts, CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    { key: "posts-scheduled", label: "Posts scheduled", source: "social-posts-scheduled", href: deptPath("calendar") },
    // No honest reader yet: client review is read one variant at a time, not as a list.
    { key: "waiting-client-review", label: "Waiting client review", ticket: "DW-3e" },
    { key: "failed-posts", label: "Failed posts", source: "social-posts-failed", href: deptPath("calendar") },
    // Needs the inbox sync backend first (SMM-15).
    { key: "unanswered-inbox", label: "Unanswered inbox", ticket: "DW-3e after SMM-15" },
  ],
  creates: ["compose-post"],
  quickActions: [
    { key: "compose-post", label: "Compose a post", href: deptPath("composer") },
    ...ASK_ACTIONS,
  ],
  kpis: [
    { key: "posts-on-schedule", label: "Posts published on schedule" },
    { key: "client-approval-turnaround", label: "Client approval turnaround" },
    { key: "engagement-growth", label: "Engagement growth across clients" },
  ],
  assistantPrompts: [
    { label: "What posts go out this week?", prompt: "What is scheduled to post this week, and on which accounts?" },
    { label: "Which posts did best?", prompt: "Which posts performed best last month, and why?" },
    { label: "Draft caption ideas", prompt: "Draft three caption ideas for a post about " },
    { label: "What is waiting for approval?", prompt: "Which posts are waiting for approval right now?" },
  ],
  ownedRoutes: [],
};

const CREATIVES: Workspace = {
  key: "creatives",
  kind: "department",
  label: "Creatives",
  mission: bespokeToolkit("creatives")?.mission ?? "",
  overviewHref: deptPath(""),
  work: [
    PM_ROW,
    {
      key: "requests", label: "Requests", icon: "bell",
      tabs: [
        { key: "incoming", label: "Incoming", href: deptPath("requests"), icon: "bell", blurb: "Asset requests from every department." },
        { key: "delivered", label: "Delivered", href: deptPath("requests/delivered"), icon: "check" },
        SENT_REQUESTS,
      ],
    },
    { key: "studio", label: "Studio", icon: "box", tabs: [fromToolkit("creatives", "studio"), fromToolkit("creatives", "assets")] },
    { key: "campaigns", label: "Campaigns", icon: "sales", gate: AGENCY_ONLY, tabs: [SHARED_CAMPAIGNS] },
    CLIENTS_ROW,
  ],
  reports: [],
  analytics: [],
  tools: launchersOf("creatives"),
  connections: [CONN.figma, CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    // None built: no honest reader yet (the Creatives readers degrade a refusal to an empty list).
    { key: "asset-requests-waiting", label: "Asset requests waiting", ticket: "DW-3e" },
    { key: "in-review", label: "In review", ticket: "DW-3e" },
    { key: "due-this-week", label: "Due this week", ticket: "DW-3e" },
    { key: "delivered-this-period", label: "Delivered this period", ticket: "DW-3e" },
  ],
  creates: ["upload-to-library"],
  quickActions: [
    { key: "open-image-studio", label: "Open Image Studio", href: deptPath("studio") },
    { key: "upload-to-library", label: "Upload to library", href: deptPath("assets") },
    ...ASK_ACTIONS.filter((a) => a.key !== "ask-creatives"),
  ],
  kpis: [
    { key: "asset-requests-on-time", label: "Asset requests delivered on time" },
    { key: "revision-rounds", label: "Revision rounds per asset" },
    { key: "assets-delivered", label: "Assets delivered" },
  ],
  assistantPrompts: [
    { label: "What is due this week?", prompt: "Which design requests are due this week?" },
    { label: "Which files await review?", prompt: "Which creative files are waiting for review?" },
    { label: "Draft a creative brief", prompt: "Draft a creative brief for " },
    { label: "Which requests lack a brief?", prompt: "Which creative requests still have no brief?" },
  ],
  ownedRoutes: [],
};

// The GM console composes and drills into existing surfaces; it never relocates a route (GM-01). Its
// tabs gate their own CONTENT through `lib/gm.ts`, so the rows stay ungated, as they are today.
const OFFICE_OF_THE_GM: Workspace = {
  key: "gm",
  kind: "office",
  label: "Office of the GM",
  mission: bespokeToolkit("gm")?.mission ?? "",
  overviewHref: deptPath(""),
  work: [
    PM_ROW,
    { key: "command", label: "Command", icon: "chart", tabs: [fromToolkit("gm", "review"), fromToolkit("gm", "decisions"), fromToolkit("gm", "revenue-plan")] },
    { key: "oversight", label: "Oversight", icon: "sitemap", tabs: ["depts", "money", "people"].map((k) => fromToolkit("gm", k)) },
    { key: "requests", label: "Requests", icon: "bell", gate: AGENCY_ONLY, tabs: [SENT_REQUESTS] },
    {
      key: "campaigns", label: "Campaigns", icon: "sales", gate: { kind: "agencyRow", row: "agency" },
      tabs: [{ key: "all", label: "All campaigns", href: "/agency", icon: "sales", blurb: "Every campaign across the departments." }],
    },
    {
      key: "clients", label: "Clients & sales", icon: "finance",
      tabs: [
        { key: "clients", label: "Clients", href: "/clients", icon: "finance", gate: { kind: "agencyRow", row: "clients" } },
        // PV7-05: the health board, one click from the list; a deeper href than /clients, so it is the active tab on its own page.
        { key: "health", label: "Health", href: "/clients/health", icon: "pulse", gate: { kind: "agencyRow", row: "clients" } },
        { key: "leads", label: "Leads", href: "/agency/leads", icon: "user", gate: { kind: "agencyRow", row: "agency" } },
      ],
    },
  ],
  reports: [],
  analytics: [],
  tools: launchersOf("gm"),
  connections: [CONN.drive, CONN.claudeSeats],
  overview: COMPANY_OVERVIEW,
  // These four are the numbers the Company block already shows (DW-3i): the company Overview has no Pulse, so they stay planned
  // rather than draw the same figure twice. Project health has no honest company reader.
  pulse: [
    { key: "revenue", label: "Revenue", ticket: "DW-3i" },
    { key: "overdue-receivables", label: "Overdue receivables", ticket: "DW-3i" },
    { key: "project-health", label: "Project health", ticket: "DW-3i" },
    { key: "utilization", label: "Utilization", ticket: "DW-3i" },
  ],
  creates: [],
  quickActions: [
    { key: "business-review", label: "Business review", href: deptPath("review") },
    { key: "decisions", label: "Decisions", href: deptPath("decisions") },
  ],
  kpis: [
    { key: "revenue-vs-plan", label: "Revenue against plan" },
    { key: "margin", label: "Margin" },
    { key: "utilization", label: "Utilization" },
    { key: "departments-in-good-condition", label: "Departments in good condition" },
  ],
  assistantPrompts: [
    { label: "Summarise this week", prompt: "Give me a summary of what happened across the company this week." },
    { label: "What needs my approval?", prompt: "What approvals are waiting on me?" },
    { label: "Which projects are at risk?", prompt: "Which projects are at risk of missing their dates?" },
    { label: "What changed since Friday?", prompt: "What changed across departments since last Friday?" },
  ],
  // The company-grain report is the Office of the GM's (§5.1).
  ownedRoutes: ["/reports/company"],
};

// ── Functional workspaces: every vertical (plan §4, DW-7) ─────────────────────────────────────────
// They keep their route trees (/hr, /finance, /it). Once a company's org tree holds them (DW-7d puts an
// "HR", "Finance" and "IT" node in every company's tree) they have a department id, so their `{dept}`
// tabs (Project Management, Analytics › Work, Tools & connections) are offered. A company whose tree
// lacks one still gets the workspace, with no department id: those tabs resolve to nothing and are not
// offered.

const HR_ON: Gate = { kind: "module", module: "hr" };
// Each gated tab mirrors the read its page makes (DW-7a), through an existing capability: `hr.view` is `hr_record`/`hr_case`
// read and the HR people file (`employee` read), `hr.recruitment.view` is `hr_recruitment` read. What a plain member may read
// stays ungated (Leave and Attendance, their own cases, Reviews and Settings read `hr_policy`, open to every member).
const HR_VIEW: Gate = { kind: "cap", cap: "hr.view" };
// The directory page's own gate (nav.ts's Organization gate, as `DIRECTORY` below), repeated here: that constant is declared later.
const HR_DIRECTORY: Gate = { kind: "any", gates: [{ kind: "cap", cap: "people.directory" }, { kind: "elevated" }] };

const HR: Workspace = {
  key: "hr",
  kind: "functional",
  label: "HR",
  mission: "People: hiring, time, pay, growth and the cases in between.",
  overviewHref: "/hr",
  work: [
    PM_ROW,
    {
      key: "people", label: "People", icon: "hr", gate: HR_ON,
      tabs: [
        { key: "directory", label: "Directory", href: "/hr/people", icon: "hr", gate: HR_DIRECTORY },
        // The checklist board lists every company's cases (`hr_case` read); without `hr.view` the page only says so.
        { key: "onboarding", label: "Onboarding", href: "/hr/onboarding", icon: "box", gate: HR_VIEW },
        // Edited on the company org builder; HR is its main consumer (as the HR console links it today).
        { key: "org", label: "Org structure", href: "/companies/{company}/org", icon: "inventory" },
      ],
    },
    {
      key: "time", label: "Time", icon: "clock", gate: HR_ON,
      tabs: [
        { key: "leave", label: "Leave", href: "/hr/leave", icon: "clock" },
        { key: "attendance", label: "Attendance", href: "/hr/attendance", icon: "check" },
      ],
    },
    {
      // `hr.payroll.view`, which hr_staff deliberately does not hold (the HR layout's own gate).
      key: "pay", label: "Pay", icon: "wallet", gate: { kind: "all", gates: [HR_ON, { kind: "cap", cap: "hr.payroll.view" }] },
      tabs: [
        { key: "compensation", label: "Compensation", href: "/hr/compensation", icon: "wallet" },
        { key: "payroll", label: "Payroll", href: "/hr/payroll", icon: "finance" },
      ],
    },
    {
      key: "talent", label: "Talent", icon: "award", gate: HR_ON,
      tabs: [
        { key: "recruitment", label: "Recruitment", href: "/hr/recruitment", icon: "hr", gate: { kind: "cap", cap: "hr.recruitment.view" } },
        { key: "reviews", label: "Reviews", href: "/hr/reviews", icon: "check" },
        { key: "cycles", label: "Appraisal cycles", href: "/appraisals/cycles", icon: "award", gate: { kind: "cap", cap: "appraisal.cycle.admin" } },
      ],
    },
    {
      // The plan's table does not place Settings (statutory parameters, holidays, leave policies);
      // it sits with compliance so the page keeps a home. DW-7a may move it.
      key: "cases", label: "Cases & compliance", icon: "inventory", gate: HR_ON,
      tabs: [
        { key: "cases", label: "Cases", href: "/hr/cases", icon: "inventory" },
        { key: "compliance", label: "Compliance", href: "/hr/compliance", icon: "inventory", gate: HR_VIEW },
        { key: "settings", label: "Settings", href: "/hr/settings", icon: "settings" },
      ],
    },
  ],
  reports: [],
  analytics: [{ key: "people", label: "People analytics", href: "/hr/analytics", icon: "pulse", gate: { kind: "all", gates: [HR_ON, HR_VIEW] } }],
  tools: [DRIVE, CLAUDE],
  connections: [CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    { key: "leave-pending", label: "Leave pending", source: "hr-leave-pending", href: "/hr/leave" },
    { key: "onboarding", label: "Onboarding", source: "hr-onboarding-open", href: "/hr/onboarding" },
    { key: "open-cases", label: "Open cases", source: "hr-cases-open", href: "/hr/cases" },
    { key: "payroll-status", label: "Payroll runs waiting", source: "hr-payroll-waiting", href: "/hr/payroll" },
  ],
  creates: ["new-hire"],
  quickActions: [
    { key: "approve-leave", label: "Approve leave", href: "/hr/leave", gate: HR_ON },
    { key: "new-hire", label: "New hire", href: "/hr/onboarding", gate: HR_ON },
    ...ASK_ACTIONS,
  ],
  kpis: [
    { key: "leave-decided-2d", label: "Leave decided within 2 days" },
    { key: "payroll-on-time", label: "Payroll published on time" },
    { key: "time-to-hire", label: "Time to hire" },
    { key: "mandatory-learning", label: "Mandatory learning complete" },
  ],
  assistantPrompts: [
    { label: "Who is away this week?", prompt: "Who is on leave this week?" },
    { label: "Which appraisals are open?", prompt: "Which appraisals are still open, and who owns them?" },
    { label: "Which onboarding tasks are late?", prompt: "Which onboarding tasks are overdue?" },
    { label: "Draft a staff reminder", prompt: "Draft a short reminder to staff about " },
  ],
  // Appraisal cycle administration lives in HR › Talent (§5.3), so its pages are HR's.
  ownedRoutes: ["/hr", "/appraisals/cycles"],
};

// Finance's tabs were ungated in the UI (`FinanceTabs`); the server gates each read. DW-7b gates a tab only where an existing
// capability is the page's own read: `finance.ar.view` (`finance_ar` read) and `finance.statement.view` (`finance_statement`
// read). The pages that read `finance_ledger`, `finance_ap`, `finance_tax`, `finance_config`, `finance_period`,
// `finance_bank`, `finance_ownership` have no capability, so they stay ungated until one is added.
const FIN_AR: Gate = { kind: "cap", cap: "finance.ar.view" };
const FIN_STATEMENT: Gate = { kind: "cap", cap: "finance.statement.view" };

const FINANCE: Workspace = {
  key: "finance",
  kind: "functional",
  label: "Finance",
  mission: "Money: the ledger, what we are owed and owe, cash, tax and the close.",
  overviewHref: "/finance",
  work: [
    PM_ROW,
    {
      key: "ledger", label: "Ledger", icon: "finance",
      tabs: [
        { key: "journals", label: "Journals", href: "/finance/journals", icon: "finance" },
        { key: "ledger", label: "General ledger", href: "/finance/ledger", icon: "finance" },
        { key: "accounts", label: "Chart of accounts", href: "/finance/accounts", icon: "inventory" },
      ],
    },
    {
      key: "receivables", label: "Receivables", icon: "wallet",
      tabs: [
        { key: "receivables", label: "Receivables", href: "/finance/receivables", icon: "wallet", gate: FIN_AR },
        // nav.ts's Business › Invoices gate, unchanged.
        { key: "invoices", label: "Invoices", href: "/invoices", icon: "wallet",
          gate: { kind: "all", gates: [{ kind: "agencyRow", row: "invoices" }, { kind: "cap", cap: "company.manage" }] } },
      ],
    },
    { key: "payables", label: "Payables", icon: "wallet", tabs: [{ key: "payables", label: "Payables", href: "/finance/payables", icon: "wallet" }] },
    {
      key: "treasury", label: "Treasury & assets", icon: "finance",
      tabs: [
        { key: "treasury", label: "Treasury", href: "/finance/treasury", icon: "finance" },
        { key: "assets", label: "Fixed assets", href: "/finance/assets", icon: "box" },
      ],
    },
    { key: "tax", label: "Tax", icon: "inventory", tabs: [{ key: "tax", label: "Tax", href: "/finance/tax", icon: "inventory" }] },
    {
      // Settings (tax identity, what is fixed for this company) is not placed by the plan's table; it
      // sits with the close so the page keeps a home. DW-7b may move it. The billing profile (PV5-09: the
      // issuer on every invoice and the account clients pay into) is a page under Settings today.
      key: "close", label: "Close", icon: "check",
      tabs: [
        { key: "close", label: "Period close", href: "/finance/close", icon: "check" },
        { key: "consolidation", label: "Consolidation", href: "/finance/consolidation", icon: "manufacturing", gate: FIN_STATEMENT },
        { key: "ownership", label: "Ownership", href: "/finance/ownership", icon: "sitemap" },
        { key: "cutover", label: "Cutover", href: "/finance/cutover", icon: "clock" },
        { key: "settings", label: "Settings", href: "/finance/settings", icon: "settings" },
        { key: "billing-profile", label: "Billing profile", href: "/finance/settings/billing-profile", icon: "wallet" },
      ],
    },
  ],
  // Finance's own Reports tab (the financial statements) joins the Reports row (§4).
  reports: [{ key: "statements", label: "Financial statements", href: "/finance/reports", icon: "chart", gate: FIN_STATEMENT }],
  // Revenue, AR and cash (DW-7b-2): the page's first read is the profit and loss (`finance_statement` read), so the tab takes
  // the same gate as the statements. Its Receivables and Cash sections read for themselves and say so when refused.
  analytics: [{ key: "money", label: "Revenue, AR and cash", href: "/finance/analytics", icon: "pulse", gate: FIN_STATEMENT }],
  // A bank portal is per company, so it is configured with the company (DW-7i), never written here.
  tools: [DRIVE, CLAUDE],
  connections: [CONN.bankFeeds, CONN.drive, CONN.claudeSeats],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    { key: "payments-to-confirm", label: "Client payments to confirm", source: "finance-payments-to-confirm", href: "/finance/receivables#payments-to-confirm" },
    { key: "overdue-receivables", label: "Overdue receivables", source: "finance-overdue-receivables", href: "/finance/receivables" },
    { key: "close-progress", label: "Close progress", source: "finance-close-progress", href: "/finance/close" },
    { key: "integrity-findings", label: "Integrity findings", source: "finance-integrity-findings", href: "/finance" },
  ],
  creates: ["record-journal"],
  quickActions: [
    { key: "confirm-payments", label: "Confirm payments", href: "/finance/receivables#payments-to-confirm" },
    { key: "record-journal", label: "Record a journal", href: "/finance/journals" },
    ...ASK_ACTIONS,
  ],
  kpis: [
    { key: "close-on-time", label: "Period closed on time" },
    { key: "overdue-receivables-share", label: "Overdue receivables share" },
    { key: "payments-confirmed-1d", label: "Client payments confirmed within 1 day" },
  ],
  assistantPrompts: [
    { label: "Which invoices are overdue?", prompt: "Which invoices are overdue, and for how long?" },
    { label: "What is waiting for approval?", prompt: "Which bills or expenses are waiting for approval?" },
    { label: "Summarise this month's spend", prompt: "Summarise this month's spending by category." },
    { label: "Which clients owe us?", prompt: "Which clients have unpaid balances?" },
  ],
  // `/billing` is the old path of `/invoices` and redirects there.
  ownedRoutes: ["/finance", "/invoices", "/billing"],
};

const IT_ON: Gate = { kind: "module", module: "it" };
// Devices and Topology read `device`, open to members and viewers. Accounts (`it_account` read: company_admin, it_admin, it_manager)
// and Workflows (`isItOrPlatformOperator`: the IT roles or a platform operator) are narrower, so `it.manage` stands in, a superset
// that hides nobody the server admits. The four security tabs of Network (DW-7h, BFF §52) read and write `it_account` too, so they
// carry the same gate.
const IT_MANAGE: Gate = { kind: "cap", cap: "it.manage" };

const IT: Workspace = {
  key: "it",
  kind: "functional",
  label: "IT",
  mission: "Devices, the network, staff accounts and the workflows that run them.",
  overviewHref: "/it",
  work: [
    PM_ROW,
    { key: "devices", label: "Devices", icon: "inventory", gate: IT_ON, tabs: [{ key: "devices", label: "Devices", href: "/it/devices", icon: "inventory" }] },
    {
      // The row has no gate of its own: Topology keeps the `it` module's, and the four ERP-side security tabs are NOT module-gated
      // (`/api/:t/it/security/*` works with the module off, like IT accounts), so a row gate would hide them with it.
      key: "network", label: "Network", icon: "gateway",
      tabs: [
        { key: "topology", label: "Topology", href: "/it/topology", icon: "hub", gate: IT_ON },
        { key: "connected", label: "Connected", href: "/it/network/presence", icon: "user", gate: IT_MANAGE },
        { key: "sign-ins", label: "Sign-ins", href: "/it/network", icon: "pulse", gate: IT_MANAGE },
        { key: "alerts", label: "Alerts", href: "/it/network/threats", icon: "bell", gate: IT_MANAGE },
        { key: "blocks", label: "Blocks", href: "/it/network/rules", icon: "settings", gate: IT_MANAGE },
      ],
    },
    // NOT module-gated: `/api/:t/it/accounts` works with the `it` module off (P2-14, ITModuleGate), so leavers' logins stay
    // manageable; a module gate here would also withhold the IT strip's one working tab.
    { key: "accounts", label: "IT accounts", icon: "hr", gate: IT_MANAGE, tabs: [{ key: "accounts", label: "IT accounts", href: "/it/accounts", icon: "hr" }] },
    { key: "workflows", label: "Workflows", icon: "automation",
      gate: { kind: "all", gates: [IT_ON, { kind: "any", gates: [IT_MANAGE, { kind: "platformOperator" }] }] }, tabs: [{ key: "workflows", label: "Workflows", href: "/it/workflows", icon: "automation" }] },
  ],
  reports: [],
  analytics: [],
  tools: [
    { key: "unifi", label: "UniFi", desc: "The network controller.", url: "https://unifi.ui.com", glyph: "◉" },
    { key: "google-admin", label: "Google Admin", desc: "Workspace accounts and devices.", url: "https://admin.google.com", glyph: "◎", icon: "google" },
    { key: "n8n", label: "n8n", desc: "The automation workflows.", url: "/n8n/", glyph: "∞" },
  ],
  connections: [CONN.networkController, CONN.workspaceAdmin],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    { key: "devices-offline", label: "Devices offline", source: "it-devices-offline", href: "/it/devices" },
    { key: "threat-alerts", label: "Threat alerts", source: "it-security-alerts", href: "/it/network/threats" },
    { key: "account-requests", label: "Account requests", source: "it-account-requests", href: "/it/accounts" },
    // DW-7i-1 (DW-D37): the shared n8n's failures are for the owner, the GM, the PM and the platform operator, so for anyone
    // else the reader's 403 HIDES this tile (overviewPulse `PULSE_HIDDEN_WHEN_FORBIDDEN`) rather than saying "No access".
    { key: "failing-workflows", label: "Failing workflows", source: "automation-failures", href: "/workflows/failures" },
  ],
  creates: ["register-device"],
  quickActions: [{ key: "register-device", label: "Register a device", href: "/it/devices", gate: IT_ON }, ...ASK_ACTIONS],
  kpis: [
    { key: "uptime", label: "Device and network uptime" },
    { key: "requests-within-sla", label: "Account and device requests resolved within the SLA" },
    { key: "open-threat-alerts", label: "Open threat alerts" },
  ],
  assistantPrompts: [
    { label: "Which access requests are open?", prompt: "Which access requests are waiting for a decision?" },
    { label: "Which systems had problems?", prompt: "Which systems had problems this week?" },
    { label: "Draft a maintenance notice", prompt: "Draft a notice to staff about planned maintenance on " },
    { label: "Which devices need replacing?", prompt: "Which devices are due for replacement?" },
  ],
  ownedRoutes: ["/it"],
};

// ── Generic: any other department, any vertical (DW-6e gives it the full skeleton) ───────────────

const GENERIC: Workspace = {
  key: "generic",
  kind: "generic",
  label: "Department",
  mission: "Team workspace.",
  overviewHref: deptPath(""),
  work: [PM_ROW],
  reports: [],
  analytics: [],
  tools: [],
  connections: [CONN.drive],
  overview: DEPARTMENT_OVERVIEW,
  pulse: [
    // None built: the generic tiles read through degrading project readers, so they stay hidden.
    { key: "active-projects", label: "Active projects", ticket: "DW-3e" },
    { key: "due-soon", label: "Due soon", ticket: "DW-3e" },
    { key: "blocked", label: "Blocked", ticket: "DW-3e" },
  ],
  creates: ["new-task"],
  quickActions: [{ key: "new-task", label: "New task", href: "/tasks/new" }],
  kpis: [
    { key: "projects-on-time", label: "Projects on time" },
    { key: "overdue-tasks", label: "Overdue tasks" },
    { key: "check-in-compliance", label: "Check-in compliance" },
  ],
  assistantPrompts: [
    { label: "Summarise this week's tasks", prompt: "Summarise this week's tasks for my team." },
    { label: "What is overdue or blocked?", prompt: "Which tasks are overdue or blocked right now?" },
    { label: "Draft a task", prompt: "Draft a task for my team about " },
    { label: "Who has capacity?", prompt: "Who on my team has capacity this week?" },
  ],
  ownedRoutes: [],
};

/** Every named workspace. The generic one is separate: it takes the department's own name. */
export const WORKSPACES: readonly Workspace[] = [WEB_DEV, SEO, SOCIAL_MEDIA, CREATIVES, OFFICE_OF_THE_GM, HR, FINANCE, IT];
export const GENERIC_WORKSPACE: Workspace = GENERIC;

/** Functional departments exist in every vertical. */
export const FUNCTIONAL_SLUGS: readonly string[] = ["hr", "finance", "it"];

// ── Shared blocks ─────────────────────────────────────────────────────────────────────────────────

export const ASSISTANT_ROW: WorkspaceRow = {
  key: "assistant",
  label: "AI Assistant",
  icon: "assistant",
  tabs: [{ key: "assistant", label: "AI Assistant", href: "/assistant", icon: "assistant" }],
};

/** Tools & connections (§4.1): today's Connections page. For the pilot the combined page, with the tools and pinning, is built (DW-6c). */
export const TOOLS_ROW: WorkspaceRow = {
  key: "tools",
  label: "Tools & connections",
  icon: "hub",
  tabs: [{ key: "tools", label: "Tools & connections", href: deptPath("connections"), icon: "hub" }],
};

/** Report periods (§5.1). All six exist in the backend since DW-4a (`ReportPeriodKind`): calendar
 *  quarters and semesters (DW-Q3), and the year. `ticket` stays on the type for a future period that
 *  is not built yet, which is shown disabled, never faked (§13 trap 4). */
export const REPORT_PERIODS: readonly { key: string; label: string; ticket?: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
  { key: "quarter", label: "Quarterly" },
  { key: "semester", label: "Semester" },
  { key: "year", label: "Yearly" },
];

// Learning and the team views use `unitCap`: today a head holds `manager`, which has no `lms.*` right,
// and a company-wide `can()` refuses their unit grant (§5.4). `unitCap` keeps every company-wide holder
// and adds the head of the unit once DW-4g grants `org_unit_lead`.
/** The Performance block, the same in every workspace (§5, DW-D10). `sidebarRows` adds each workspace's
 *  own analytics and report tabs. */
export const PERFORMANCE_ROWS: readonly WorkspaceRow[] = [
  // PV7-06: the person's own picture, first in the block; it links to the full pages below and copies none of them. Ungated:
  // each section is withheld by its own module on the page.
  { key: "performance", label: "My performance", icon: "pulse", tabs: [{ key: "mine", label: "My performance", href: "/me/performance", icon: "pulse" }] },
  {
    key: "reports", label: "Reports", icon: "chart",
    tabs: [
      { key: "mine", label: "Mine", href: "/reports/person", icon: "pulse", blurb: "Your own report for the period." },
      { key: "team", label: "Team", href: "/reports/team?unit={dept}", icon: "pulse", gate: { kind: "unitCap", cap: "reports.department.view" },
        blurb: "Your people's reports for the period." },
      { key: "department", label: "Department", href: "/reports/department", icon: "pulse", gate: { kind: "unitCap", cap: "reports.department.view" },
        blurb: "The department's report for the period. The server narrows it to the units you may read." },
      // PV7-05: a client's delivery report. The same read tiers as the project report (`read_client`), and only where the company has clients.
      { key: "client", label: "Client", href: "/reports/client", icon: "pulse",
        gate: { kind: "all", gates: [{ kind: "cap", cap: "reports.project.view" }, { kind: "agencyRow", row: "clients" }] },
        blurb: "A client's delivery report: every project of the client, together." },
    ],
  },
  {
    key: "analytics", label: "Analytics", icon: "pulse",
    // Project Management's Charts: flow, burndown and tag breakdown across the department's projects.
    tabs: [
      fromToolkit("web-dev", "charts", { key: "work", label: "Work" }),
      // DW-4i (BFF section 44.9): the year map of ALL the person's work, by kind, and a day's detail. Ungated: self is always
      // allowed. Project Management > Productivity stays, with the PM-only components this series does not carry.
      { key: "activity", label: "My activity", href: "/analytics/activity", icon: "pulse", blurb: "Everything you did, by day and by kind." },
      // DW-4i: a head's Team activity for THIS department (the same gate as the Team report); the server gates every person.
      { key: "team-activity", label: "Team activity", href: "/analytics/activity/team?unit={dept}", icon: "pulse", gate: { kind: "unitCap", cap: "reports.department.view" },
        blurb: "What each person on your team did, by kind." },
    ],
  },
  {
    key: "appraisals", label: "Appraisals", icon: "award",
    tabs: [
      { key: "mine", label: "Mine", href: "/appraisals/mine", icon: "check" },
      // nav.ts's Team Appraisals gate (`appraisal.score` or `appraisal.read`), plus the head of the unit.
      { key: "team", label: "Team", href: "/appraisals", icon: "check",
        gate: { kind: "any", gates: [{ kind: "cap", cap: "appraisal.score" }, { kind: "unitCap", cap: "appraisal.read" }] } },
      // DW-4e-2: the department's KPI tiles, condition and targets screen, opened for THIS department (BFF §40).
      { key: "department", label: "Department", href: "/appraisals/department?unit={dept}", icon: "award", gate: { kind: "unitCap", cap: "reports.department.view" } },
    ],
  },
  {
    key: "learning", label: "Learning", icon: "learning",
    tabs: [
      // Ungated: mandatory training is owed by everyone, so the page that says what you owe never is.
      { key: "mine", label: "My learning", href: "/me/learning", icon: "learning" },
      // Opens the catalogue on this department's subtree (DW-4f). The catalogue is ungated (`member` holds
      // `lms.catalogue.view`). A workspace with no department node (HR, Finance, IT until DW-7d; Company)
      // is not offered the tab (the `{dept}` rule, `hrefFor`); the whole catalogue stays in the Company
      // area's "Learning catalogue" row.
      { key: "courses", label: "Department courses", href: "/learning/catalogue?unit={dept}", icon: "box" },
      // DW-4g: the page opens for a head through `canInUnit` on `?unit=` and offers only the units they lead.
      { key: "add", label: "Add material", href: "/learning/authoring?unit={dept}", icon: "projects", gate: { kind: "unitCap", cap: "lms.authoring" } },
      // DW-4g: this department's roster only, read through GET lms/compliance?unit= (BFF §38).
      { key: "team", label: "Team progress", href: "/learning/compliance?unit={dept}", icon: "check", gate: { kind: "unitCap", cap: "lms.progress.view" } },
    ],
  },
];

const DECIDER: Gate = { kind: "decider" };

/** The You block (plan §8). Personal pages keep the current workspace's sidebar. */
export const YOU_ROWS: readonly WorkspaceRow[] = [
  { key: "tasks", label: "My tasks", icon: "check", tabs: [{ key: "tasks", label: "My tasks", href: "/me/tasks", icon: "check" }] },
  // DW-8j: the row stays "Inbox"; its two tabs are the bell's Notifications and your own Gmail (BFF section 48).
  {
    key: "inbox", label: "Inbox", icon: "bell",
    tabs: [
      { key: "inbox", label: "Notifications", href: "/me/inbox", icon: "bell" },
      { key: "mail", label: "Mail", href: "/me/mail", icon: "mail" },
    ],
  },
  {
    key: "calendar", label: "Calendar", icon: "clock",
    tabs: [
      { key: "calendar", label: "Calendar", href: "/calendar", icon: "clock" },
      { key: "meetings", label: "Meetings", href: "/meetings", icon: "clock", gate: { kind: "agencyRow", row: "meetings" } },
    ],
  },
  // DW-D23 (owner, 2026-10-14): shown when it concerns you, i.e. something waits on your decision or you hold any right to
  // decide (the `decider` gate), with the pending count as its badge. The page stays reachable for everyone by URL and
  // ⌘K, and the server decides who may act.
  {
    key: "approvals", label: "Approvals", icon: "check", gate: DECIDER, badge: "approvals",
    tabs: [{ key: "approvals", label: "Approvals", href: "/approvals", icon: "check", gate: DECIDER }],
  },
  {
    key: "me", label: "Me", icon: "user",
    tabs: [
      { key: "summary", label: "Summary", href: "/me", icon: "home" },
      { key: "leave", label: "Leave", href: "/me/leave", icon: "clock" },
      { key: "loans", label: "Loans", href: "/me/loans", icon: "wallet" },
      { key: "pay", label: "Pay", href: "/me/pay", icon: "wallet" },
      { key: "timesheet", label: "Timesheet", href: "/timesheets", icon: "clock", gate: { kind: "agencyRow", row: "timesheets" } },
      { key: "account", label: "Account", href: "/account", icon: "settings" },
    ],
  },
];

// nav.ts's Organization gate for Positions and Access, reused for People.
const DIRECTORY: Gate = { kind: "any", gates: [{ kind: "cap", cap: "people.directory" }, { kind: "elevated" }] };

/** The Company area (plan §9.2): one door to what people need only occasionally. Each row keeps its
 *  gate, and a generic-pack company has no Clients or Campaigns row. */
export const COMPANY_ROWS: readonly WorkspaceRow[] = [
  { key: "departments", label: "Departments", icon: "hr", tabs: [{ key: "departments", label: "Departments", href: "/departments", icon: "hr" }] },
  { key: "people", label: "People", icon: "user", gate: DIRECTORY, tabs: [{ key: "people", label: "People", href: "/people", icon: "user" }] },
  {
    key: "organization", label: "Organization", icon: "sitemap",
    tabs: [
      { key: "overview", label: "Overview", href: "/organization", icon: "inventory" },
      { key: "positions", label: "Positions", href: "/organization/positions", icon: "sitemap", gate: DIRECTORY },
      { key: "access", label: "Access", href: "/organization/access", icon: "user", gate: DIRECTORY },
    ],
  },
  {
    key: "projects", label: "Projects", icon: "projects",
    tabs: [
      { key: "all", label: PM_TERMS.projectManagement, href: "/project-management", icon: "projects" },
      { key: "cross", label: PM_TERMS.crossProject, href: "/pm", icon: "projects" },
      { key: "deliverables", label: "Deliverables", href: "/deliverables", icon: "box", gate: { kind: "agencyRow", row: "deliverables" } },
    ],
  },
  { key: "clients", label: "Clients", icon: "finance", gate: { kind: "agencyRow", row: "clients" }, tabs: [
    { key: "clients", label: "Clients", href: "/clients", icon: "finance" },
    // PV7-05: the health board (same gate as the row).
    { key: "health", label: "Health", href: "/clients/health", icon: "pulse" },
  ] },
  {
    key: "campaigns", label: "Campaigns", icon: "sales", gate: { kind: "agencyRow", row: "agency" },
    tabs: [
      { key: "campaigns", label: "Campaigns", href: "/agency", icon: "sales" },
      { key: "leads", label: "Leads", href: "/agency/leads", icon: "user" },
    ],
  },
  { key: "knowledge", label: "Knowledge", icon: "box", tabs: [{ key: "knowledge", label: "Knowledge", href: "/knowledge", icon: "box" }] },
  { key: "agents", label: "AI Agents", icon: "agents", tabs: [{ key: "agents", label: "AI Agents", href: "/agents", icon: "agents" }] },
  { key: "learning", label: "Learning catalogue", icon: "learning", tabs: [{ key: "catalogue", label: "Learning catalogue", href: "/learning/catalogue", icon: "learning" }] },
  { key: "office", label: "The Office", icon: "pulse", tabs: [{ key: "office", label: "The Office", href: "/office", icon: "pulse" }] },
];

/** The Admin area (plan §9.1): Settings, Group and Platform, each with its gate unchanged from nav.ts. */
export const ADMIN_ROWS: readonly WorkspaceRow[] = [
  { key: "settings", label: "Settings", icon: "settings", gate: { kind: "cap", cap: "admin.access" }, tabs: [{ key: "settings", label: "Settings", href: "/admin", icon: "settings" }] },
  {
    key: "group", label: "Group", icon: "manufacturing", gate: { kind: "rootGroup" },
    tabs: [
      { key: "report", label: "Group report", href: "/group", icon: "chart" },
      { key: "rollups", label: "Rollups", href: "/rollups", icon: "pulse" },
      { key: "reports", label: "Company reports", href: "/group/reports", icon: "inventory" },
    ],
  },
  {
    key: "platform", label: "Platform", icon: "server", gate: { kind: "platformOperator" },
    tabs: [
      { key: "bot", label: "WA/TG Bot", href: "/systems/bot", icon: "bot" },
      { key: "gateway", label: "AI Gateway", href: "/systems/gateway", icon: "gateway" },
      { key: "hub", label: "MCP Hub", href: "/systems/hub", icon: "hub" },
      { key: "automation", label: "Automation", href: "/systems/automation", icon: "automation" },
      { key: "observability", label: "Observability", href: "/systems/observability", icon: "pulse" },
    ],
  },
];

// ── Lookups ───────────────────────────────────────────────────────────────────────────────────────

export function workspaceBySlug(slug: string): Workspace | undefined {
  return WORKSPACES.find((w) => w.key === slug);
}

/** The workspace for a department of a company of this vertical. Bespoke only when the vertical's pack
 *  lists the slug (PV-D15, the same rule as `toolkitFor`); HR, Finance and IT in any vertical; anything
 *  else is the generic workspace under the department's own name. */
export function workspaceFor(vertical: string | null | undefined, deptName: string): Workspace {
  const slug = deptSlug(deptName);
  if (FUNCTIONAL_SLUGS.includes(slug)) return workspaceBySlug(slug)!;
  if (packFor(vertical).toolkitDepartments.includes(slug)) {
    const ws = workspaceBySlug(slug);
    if (ws) return ws;
  }
  return { ...GENERIC, label: deptName, mission: `${deptName}: team workspace.` };
}

/** A registry href made concrete. `null` when it needs an id the caller does not have (a functional
 *  workspace has no department id until DW-7d), so the caller does not offer that link. */
export function hrefFor(href: string, ids: { deptId?: string | null; companyId?: string | null }): string | null {
  let out = href;
  if (out.includes("{dept}")) {
    if (!ids.deptId) return null;
    out = out.replaceAll("{dept}", encodeURIComponent(ids.deptId));
  }
  if (out.includes("{company}")) {
    if (!ids.companyId) return null;
    out = out.replaceAll("{company}", encodeURIComponent(ids.companyId));
  }
  return out;
}

/** Where a department of the active company opens: its workspace's Overview (DW-8e). HR, Finance and IT open their own
 *  consoles (`/hr`, `/finance`, `/it`), every other department its `/departments/{id}` Overview. Falls back to
 *  `/departments/{id}` when the registry href cannot be made concrete, so a card never links nowhere. */
export function departmentOverviewHref(vertical: string | null | undefined, dept: { id: string; name: string }, companyId: string | null): string {
  return hrefFor(workspaceFor(vertical, dept.name).overviewHref, { deptId: dept.id, companyId }) ?? `/departments/${encodeURIComponent(dept.id)}`;
}

/** True when the item is not built yet and must not be rendered. */
export function isPlanned(item: { ticket?: string }): boolean {
  return item.ticket !== undefined;
}

export interface SidebarModel {
  /** Overview and AI Assistant. */
  top: readonly WorkspaceRow[];
  /** The department's own sections, then Tools & connections. */
  work: readonly WorkspaceRow[];
  /** Reports, Analytics, Appraisals and Learning, with this workspace's own tabs added. */
  performance: readonly WorkspaceRow[];
  you: readonly WorkspaceRow[];
}

/** The rows of one workspace's sidebar, in order (plan §2.2), before gates and planned items are applied. */
export function sidebarRows(ws: Workspace): SidebarModel {
  const overview: WorkspaceRow = {
    key: "overview",
    label: "Overview",
    icon: "home",
    tabs: [{ key: "overview", label: "Overview", href: ws.overviewHref, icon: "home" }],
  };
  const performance = PERFORMANCE_ROWS.map((row) => {
    if (row.key === "reports") return { ...row, tabs: [...row.tabs, ...ws.reports] };
    if (row.key === "analytics") return { ...row, tabs: [...row.tabs, ...ws.analytics] };
    return row;
  });
  return { top: [overview, ASSISTANT_ROW], work: [...ws.work, TOOLS_ROW], performance, you: YOU_ROWS };
}
