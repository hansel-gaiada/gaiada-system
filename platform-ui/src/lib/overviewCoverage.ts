// DW-3z: what stays under the Overview, as data (docs/plans/2026-10-13-department-workspaces.md §3.8, rule §2.6.1: nothing is removed).
//
// Five pages draw today's body under the workspace Overview as "More from <workspace>": the department Home, the Office of the GM's
// cockpit, HR, Finance and IT. A section of that body may go from under the Overview only when the plan can say where its information
// lives now:
//   - "covered":   an Overview block shows the same information honestly (`widget` names it, by registry key);
//   - "reachable": the information has its own home one click away: a workspace row or tab, which `hrefs` names by its registry href;
//   - "stays":     neither. It stays under "More from <workspace>" until a block or a tab takes it.
// A section that shows MORE than its block (more rows, other columns, actions) is "covered" only where the block links to the rest,
// and says so in `by`.
//
// Everything is for a person on the pilot (`framed`). A classic page never passes through here, so it keeps today's body exactly, and
// a section that is not in this table is KEPT (the safe default: nothing leaves without a verdict).
//
// Pure and client-safe: the vitest pins every claim to the registry (`overviewCoverage.test.ts`).

export type LegacyPage = "department-home" | "gm-cockpit" | "hr" | "finance" | "it";
export type Verdict = "covered" | "reachable" | "stays";

/** `numbers` / `money`: the verdict holds only for a person the Overview block is placed for (the company Overview's `companyAccess`).
 *  For anyone else the block is not drawn, so the section it would have replaced stays. */
export type CoverageCondition = "numbers" | "money";

export interface CoverageEntry {
  page: LegacyPage;
  section: string;
  /** The section as today's page words it. */
  label: string;
  verdict: Verdict;
  /** Why, in words: the block that shows it, the row or tab it lives at, or what only this section shows. */
  by: string;
  /** The Overview block's registry key (`covered`; a `reachable` section may name the block that gives the glance). */
  widget?: string;
  /** The registry tabs (by href) where the information lives: `reachable`, and the rest a `covered` block links to. Each must be a tab of
   *  every workspace the page renders for. A link only the block carries (the Company report, Finance) is said in `by` and pinned in the test. */
  hrefs?: readonly string[];
  when?: CoverageCondition;
}

export const COVERAGE: readonly CoverageEntry[] = [
  // ── Department Home (`/departments/{dept}`) ────────────────────────────────────────────────────
  {
    page: "department-home", section: "kpis", label: "Active, Due soon, Blocked, Progress", verdict: "stays",
    by: "No block counts the department's tasks: Pulse has no generic tile built, Condition is the target-based KPIs, and Team mode is a head's alone.",
  },
  {
    page: "department-home", section: "project-health", label: "Project health", verdict: "covered", widget: "projects",
    hrefs: ["/departments/{dept}/projects"],
    by: "Projects (the department's open projects, most at risk first, with health and next due date), which links to All projects: the Projects tab, the ownership rollup with urgency, counts and range.",
  },
  {
    page: "department-home", section: "recent-activity", label: "Recent activity", verdict: "reachable", hrefs: ["/departments/{dept}/activity"],
    by: "Project Management > Activity is the full feed, filterable by project and person; the Home card was its first eight rows.",
  },
  {
    page: "department-home", section: "build-tools", label: "Build tools", verdict: "reachable", widget: "today", hrefs: ["/departments/{dept}/connections"],
    by: "Today shows the pinned tools (the first six by default); Tools & connections > Tools lists every tool with the person's own seat line and the pin buttons.",
  },
  {
    page: "department-home", section: "team", label: "Team", verdict: "stays",
    by: "The roster with each person's open and blocked work has no home on the Overview (Team mode shows numbers, and only for a head) and no tab.",
  },
  {
    page: "department-home", section: "serviced", label: "Serviced companies", verdict: "stays",
    by: "The companies this department serves (service assignments) are not the Clients row's list (clients with a live project) and no block shows them.",
  },

  // ── Office of the GM (`/departments/{gm}`): today's cockpit ────────────────────────────────────
  {
    page: "gm-cockpit", section: "narrowed-notice", label: "Scoped to the departments you lead", verdict: "stays",
    by: "It qualifies the figures that stay for a department lead, and a lead's Overview has no company blocks.",
  },
  {
    page: "gm-cockpit", section: "provenance", label: "Period and range line", verdict: "covered", widget: "company", when: "numbers",
    by: "It captions the two cards below it. The Company block names the period and links the company report (the sealed record); for a department lead the strip stays, so the line does too.",
  },
  {
    page: "gm-cockpit", section: "business", label: "The business", verdict: "covered", widget: "company", when: "numbers",
    by: "Company (milestones hit and utilization from the company report document), which links to the Company report, where the cockpit itself says the further metrics sit.",
  },
  {
    page: "gm-cockpit", section: "departments", label: "Departments", verdict: "covered", widget: "departments", when: "numbers",
    hrefs: ["/departments/{dept}/depts"],
    by: "Departments by condition is plan §3.5 item 3: every department, worst first, with the KPI driving it; Oversight > Departments holds the report metrics the strip drew (All metrics).",
  },
  {
    page: "gm-cockpit", section: "monitoring", label: "Client monitoring", verdict: "stays",
    by: "No Overview block shows the monitoring summary (the GM's Pulse tiles stay planned) and the Office of the GM has no Monitoring tab: it is Web Dev's Run row.",
  },
  {
    page: "gm-cockpit", section: "money", label: "Money", verdict: "covered", widget: "company", when: "money",
    by: "Company's money part has the card's own gate and rules: revenue with its net amount, overdue receivables with the 90+ days line, and the no-books note. The net margin rate (net over revenue) is not drawn; the statements are one link away (the block's Finance link, Financial statements).",
  },

  // ── HR (`/hr`) ─────────────────────────────────────────────────────────────────────────────────
  {
    page: "hr", section: "scope-note", label: "You serve HR for N companies", verdict: "stays",
    by: "Which companies the person serves for HR is information no block or tab shows.",
  },
  {
    page: "hr", section: "kpis", label: "People, Departments, Leave pending, Open cases", verdict: "stays",
    by: "HR's Pulse tiles (leave pending, open cases) are DW-7e and not built, so no block shows these counts.",
  },
  { page: "hr", section: "card-leave", label: "Leave card", verdict: "reachable", hrefs: ["/hr/leave"], by: "Time > Leave. The card is a link and one line of words." },
  { page: "hr", section: "card-attendance", label: "Attendance card", verdict: "reachable", hrefs: ["/hr/attendance"], by: "Time > Attendance. The card is a link and one line of words." },
  { page: "hr", section: "card-onboarding", label: "Onboarding card", verdict: "reachable", hrefs: ["/hr/onboarding"], by: "People > Onboarding. The card is a link and one line of words." },
  { page: "hr", section: "card-cases", label: "Cases card", verdict: "reachable", hrefs: ["/hr/cases"], by: "Cases & compliance > Cases. The card is a link and one line of words." },
  {
    page: "hr", section: "people-directory", label: "People directory", verdict: "reachable", hrefs: ["/hr/people", "/companies/{company}/org"],
    by: "People > Directory, and People > Org structure for placement. The card is two links and a paragraph.",
  },

  // ── Finance (`/finance`) ───────────────────────────────────────────────────────────────────────
  {
    page: "finance", section: "kpis", label: "Total assets, Receivables, Payables, Trial balance", verdict: "stays",
    by: "Finance's Pulse tiles (overdue receivables, close progress, integrity findings) are DW-7e and not built, so no block shows these totals.",
  },
  {
    page: "finance", section: "integrity", label: "Integrity", verdict: "stays",
    by: "The ledger-chain check has no other page, and the verdict rows are the landing page's design rule (never an unearned green); the Pulse tile for it is DW-7e.",
  },
  {
    page: "finance", section: "close-readiness", label: "Can this period close?", verdict: "stays",
    by: "Close > Period close answers the same question, but for the latest OPEN period, not the current one, so it is not the same reading; the Pulse tile is DW-7e.",
  },
  {
    page: "finance", section: "ar-aging", label: "Receivables aging", verdict: "reachable", hrefs: ["/finance/receivables"],
    by: "Receivables > Aging is the same table as at the same default date, with its tie-out verdict above it. The total stays in the KPI tile.",
  },
  {
    page: "finance", section: "ap-aging", label: "Payables aging", verdict: "reachable", hrefs: ["/finance/payables"],
    by: "Payables > Aging is the same table as at the same default date, with its tie-out verdict above it. The total stays in the KPI tile.",
  },
  {
    page: "finance", section: "configuration", label: "Configuration", verdict: "reachable", hrefs: ["/finance/ownership", "/finance/settings"],
    by: "Close > Ownership and Close > Settings. The card is two links.",
  },
  {
    page: "finance", section: "fiscal-periods", label: "Fiscal periods", verdict: "reachable", hrefs: ["/finance/close"],
    by: "Close > Period close has the Periods table with the same columns (and the check link for each).",
  },

  // ── IT (`/it`) ─────────────────────────────────────────────────────────────────────────────────
  {
    page: "it", section: "kpis", label: "Devices, Online, Degraded, Offline, Open alerts", verdict: "stays",
    by: "IT's devices-offline and threat-alert tiles are DW-7e and not built; the Account requests tile is a different count.",
  },
  {
    page: "it", section: "device-events", label: "Recent device events", verdict: "stays",
    by: "The device events feed is read only here: Devices lists devices, and a device page lists its own events.",
  },
];

export interface CoverageContext {
  /** The page is drawn inside the Overview (the person is on the pilot). False: today's page, whole. */
  framed: boolean;
  /** The company Overview's `companyAccess`, for the entries that hold only where its block is placed. */
  access?: { numbers: boolean; money: boolean };
}

/** Does the page keep this section under the Overview? Yes unless it is framed AND the inventory says its information is covered or
 *  reachable (for the conditions it names). An uninventoried section is kept. */
export function keepsSection(page: LegacyPage, section: string, ctx: CoverageContext): boolean {
  if (!ctx.framed) return true;
  const entry = COVERAGE.find((e) => e.page === page && e.section === section);
  if (!entry || entry.verdict === "stays") return true;
  if (entry.when && !ctx.access?.[entry.when]) return true;
  return false;
}

/** The cockpit's sections that leave the pilot's page for this person. */
export type GmSection = "provenance" | "business" | "departments" | "money";
const GM_SECTIONS: readonly GmSection[] = ["provenance", "business", "departments", "money"];

export function gmHiddenSections(access: { numbers: boolean; money: boolean }): GmSection[] {
  return GM_SECTIONS.filter((s) => !keepsSection("gm-cockpit", s, { framed: true, access }));
}
