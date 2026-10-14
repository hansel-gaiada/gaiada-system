// The company Overview (DW-3i, docs/plans/2026-10-13-department-workspaces.md §3.5, §3.7), as pure rules: who may see which
// block, and each block as data. The Office of the GM's Overview keeps the GM cockpit's numbers in the cockpit's own order:
// decisions, the company, the departments by condition, campaigns across departments, then growth.
//
// ── ACCESS: THE COCKPIT'S GATES, EXACTLY, AND NEVER LOOSER ───────────────────────────────────────
// `lib/gm.ts` decides who sees what of the cockpit, and this file asks it, so the Overview and the cockpit cannot disagree:
//   console  = `gmAccessFor !== "none"`                          (decisions)
//   numbers  = `gmAccessFor === "full"`                          (company report figures; departments by condition; the
//                                                                company-wide learning and appraisal progress)
//   money    = console AND `canReadGmMoney`                      (revenue, overdue receivables)
// Money is its own boundary: a narrowed department lead holds the reporting capability and not the finance one. A block that
// the person may not see is NOT PLACED (the registry's gates, `COMPANY_OVERVIEW`, which a test pins to these three); inside the
// Company block a part that is not theirs is not read and not drawn, never shown as "No access".
// Two blocks are stricter than the cockpit on purpose: "Departments by condition" reads `dept-kpis/overview`, which only the
// company-wide tiers may read (§40.3a), so a narrowed lead would only ever meet a 403 there.
//
// Nothing here is a security boundary. The server narrows every read; a refusal that still arrives says "No access".
import type { Me } from "./platform";
import { canReadGmMoney, gmAccessFor } from "./gm";
import type { ReadResult } from "./readResult";
import type { ReportDocument, ReportKpi } from "./reports";
import type { StatementRow, ArAgingRow } from "./finance";
import { formatMoneyShort, formatRate, summarizeArAging, summarizePnl } from "./gmMoney";
import { NO_DATA, formatDay, formatHours } from "./overviewNumbers";
import { isOpenProject, refusalText } from "./overviewWork";
import { teamAppraisalsView, type TeamAppraisalsView } from "./overviewTeam";
import { formatDate } from "./format";
import type { AppraisalStatus } from "./appraisals";
import type { ComplianceRow } from "./lms";
import type { DeptCampaignRow } from "./campaigns";
import type { NowQueue } from "./overviewQueue";

// ── Access ───────────────────────────────────────────────────────────────────────────────────────

export interface CompanyAccess {
  /** May open the GM console at all (full or narrowed). */
  console: boolean;
  /** Company-grain figures: the cockpit's "full" access. */
  numbers: boolean;
  /** Company money: a console reader who also holds the finance read capability. */
  money: boolean;
}

export function companyAccess(me: Me, tenantId: string | null | undefined): CompanyAccess {
  const access = gmAccessFor(me, tenantId);
  return {
    console: access !== "none",
    numbers: access === "full",
    money: access !== "none" && canReadGmMoney(me, tenantId),
  };
}

// ── Needs you: decisions ─────────────────────────────────────────────────────────────────────────

export const DECISIONS_SHOWN = 5;
/** The cockpit's Decisions tab marks "sitting" at five days. */
export const STALE_DAYS = 5;

const KIND_TEXT: Readonly<Record<string, string>> = { approval: "Approval", gate: "Pipeline gate" };

export interface DecisionRow {
  id: string;
  title: string;
  kind: string;
  context: string | null;
  /** "today", "3d", or null when the item carries no usable date. */
  waiting: string | null;
  href: string | null;
  /** The person may act on it; a row that is not theirs is still listed, because a stuck decision is information. */
  decidable: boolean;
}

export type DecisionsView =
  | {
    kind: "ok";
    total: number;
    /** Waiting five days or more. */
    stale: number;
    /** Listed but not the person's to decide. */
    notYours: number;
    rows: DecisionRow[];
    /** Sources of this company's queue that failed: the list is short, and an empty one is not settled. */
    incomplete: string[];
  }
  | { kind: "unavailable" };

/** Whole days since the item was raised, floored: something raised 30 hours ago has waited "1d", never "2d" (the cockpit's rule). */
export function waitingDays(createdAt: string, now: Date): number | null {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

const waitingText = (days: number | null): string | null => (days === null ? null : days === 0 ? "today" : `${days}d`);

/** The approvals and gates of the ACTIVE company, in the queue's own rank (the cockpit's Decisions tab projects the same spine).
 *  A company whose leg of the queue was not read is "unavailable": an empty list there would read as "nothing is waiting". */
export function decisionsView(queue: NowQueue, tenantId: string, now: Date): DecisionsView {
  const leg = queue.companies.find((c) => c.id === tenantId);
  if (!leg || !leg.included) return { kind: "unavailable" };
  const items = queue.items.filter((i) => i.companyId === tenantId && (i.type === "approval" || i.type === "gate"));
  const aged = items.map((item) => ({ item, days: waitingDays(item.createdAt, now) }));
  return {
    kind: "ok",
    total: items.length,
    stale: aged.filter((r) => r.days !== null && r.days >= STALE_DAYS).length,
    notYours: items.filter((i) => !i.decidable).length,
    incomplete: leg.partialSources,
    rows: aged.slice(0, DECISIONS_SHOWN).map(({ item, days }) => ({
      id: item.id,
      title: item.title,
      kind: KIND_TEXT[item.type] ?? item.type,
      context: item.meta ?? null,
      waiting: waitingText(days),
      href: item.href ?? null,
      decidable: item.decidable,
    })),
  };
}

// ── Company: revenue, net margin, overdue receivables, milestones, utilization ───────────────────────────────

export type CompanyTileKey = "revenue" | "margin" | "overdue" | "milestones" | "utilization";
export type CompanyTileState = "ok" | "no-data" | "forbidden" | "unavailable";

export interface CompanyTile {
  key: CompanyTileKey;
  label: string;
  state: CompanyTileState;
  /** The figure, "No data", "No access" or "Unavailable". Never a 0 the source did not state. */
  value: string;
  detail: string | null;
}

const LABEL: Readonly<Record<CompanyTileKey, string>> = {
  revenue: "Revenue",
  margin: "Net margin",
  overdue: "Overdue receivables",
  milestones: "Milestones hit",
  utilization: "Utilization",
};

const refused = (key: CompanyTileKey, kind: "forbidden" | "unavailable"): CompanyTile =>
  ({ key, label: LABEL[key], state: kind, value: refusalText(kind), detail: null });
const noData = (key: CompanyTileKey, detail: string | null = null): CompanyTile =>
  ({ key, label: LABEL[key], state: "no-data", value: NO_DATA, detail });

const percent = (v: number) => `${Math.round(v * 100)}%`;
const fmt = (n: number) => n.toLocaleString("en-US");

/** A ratio KPI states its figure only with both parts and a non-zero denominator, like every Overview ratio. */
function ratio(kpi: ReportKpi | undefined): { value: number; numerator: number; denominator: number } | null {
  if (!kpi || !Number.isFinite(kpi.value)) return null;
  if (kpi.numerator === undefined || kpi.denominator === undefined || kpi.denominator === 0) return null;
  return { value: kpi.value, numerator: kpi.numerator, denominator: kpi.denominator };
}

/** The two company-grain figures from the company report document (`GET reports/document?grain=company`). Each key is the
 *  registry's own metric key (platform-nest `reports/metrics.ts`).
 *
 *  "Milestones hit" is `delivery.milestone_hit_rate`: milestones due in the period that are done, over those due. It is the
 *  company's honest reading of "projects on track" today: a per-project health over every project would be one read per project
 *  on every render, and the registry has no company figure for it. The label says what it measures. */
export function numberTiles(document: ReadResult<ReportDocument>): CompanyTile[] {
  if (document.kind !== "ok") return [refused("milestones", document.kind), refused("utilization", document.kind)];
  const kpi = (metricKey: string) => document.data.kpis.find((k) => k.metricKey === metricKey);
  const hit = ratio(kpi("delivery.milestone_hit_rate"));
  const capacity = ratio(kpi("effort.capacity_utilization"));
  return [
    hit
      ? { key: "milestones", label: LABEL.milestones, state: "ok", value: percent(hit.value), detail: `${fmt(hit.numerator)} of ${fmt(hit.denominator)} milestones due` }
      : noData("milestones"),
    capacity
      ? { key: "utilization", label: LABEL.utilization, state: "ok", value: percent(capacity.value), detail: `${formatHours(capacity.numerator)} of ${formatHours(capacity.denominator)} expected` }
      : noData("utilization"),
  ];
}

/** What the money reads said. `pnl` and `ar` are null when they were not read (the gate read said no books). */
export interface MoneyReads {
  periods: ReadResult<readonly unknown[]>;
  pnl: ReadResult<StatementRow[]> | null;
  ar: ReadResult<ArAgingRow[]> | null;
}

export type MoneyPart =
  | { kind: "tiles"; tiles: CompanyTile[] }
  /** The finance gate read refused: the cockpit draws nothing, and so does this. */
  | { kind: "hidden" }
  /** Reachable, but no fiscal calendar exists (or the finance module is off): a setup state, never a zero. */
  | { kind: "no-books" };

/** Revenue and overdue receivables for the period, the cockpit's `GmMoneyCard` rules: the fiscal-periods read is the GATE (the
 *  only finance reader that tells a refusal from absence), the P&L totals are read by code and never re-summed, and the
 *  receivable is the server's own outstanding less current. */
export function moneyPart(reads: MoneyReads): MoneyPart {
  const { periods, pnl, ar } = reads;
  if (periods.kind === "forbidden") return { kind: "hidden" };
  if (periods.kind === "unavailable") return { kind: "tiles", tiles: [refused("revenue", "unavailable"), refused("margin", "unavailable"), refused("overdue", "unavailable")] };
  if (periods.data.length === 0) return { kind: "no-books" };

  let revenue: CompanyTile;
  let margin: CompanyTile;
  if (!pnl) { revenue = refused("revenue", "unavailable"); margin = refused("margin", "unavailable"); }
  else if (pnl.kind !== "ok") { revenue = refused("revenue", pnl.kind); margin = refused("margin", pnl.kind); }
  else {
    const s = summarizePnl(pnl.data);
    // A statement with no total rows is a reporting gap, not a period in which nothing was earned.
    revenue = s.revenue === null
      ? noData("revenue", "The statement carried no totals")
      : { key: "revenue", label: LABEL.revenue, state: "ok", value: formatMoneyShort(s.revenue), detail: null };
    // The cockpit's "Net margin" (DW-D22): net over revenue from the same summary. A margin on no revenue (or with no net) is
    // undefined, never "0%".
    if (s.revenue === null) margin = noData("margin", "The statement carried no totals");
    else if (s.marginRate === null) margin = noData("margin", "A margin on no revenue is undefined");
    else margin = { key: "margin", label: LABEL.margin, state: "ok", value: formatRate(s.marginRate), detail: `${formatMoneyShort(s.net)} net on ${formatMoneyShort(s.revenue)}` };
  }

  let overdue: CompanyTile;
  if (!ar) overdue = refused("overdue", "unavailable");
  else if (ar.kind !== "ok") overdue = refused("overdue", ar.kind);
  else {
    const s = summarizeArAging(ar.data);
    overdue = {
      key: "overdue", label: LABEL.overdue, state: "ok", value: formatMoneyShort(s.overdue),
      detail: s.over90 > 0 ? `${formatMoneyShort(s.over90)} past 90 days` : "nothing past 90 days",
    };
  }
  return { kind: "tiles", tiles: [revenue, margin, overdue] };
}

export interface CompanyModel {
  /** Money first, then the report figures: the spec's order (revenue, overdue receivables, then projects and utilization). */
  tiles: CompanyTile[];
  periodLabel: string | null;
  /** The money window, in words; null when no money tile is drawn. */
  moneyWindow: string | null;
  /** The cockpit's setup state, in words, when there are no books. */
  noBooks: boolean;
  note: string | null;
  /** Which links to draw: only to a page the person may open. */
  links: { report: boolean; finance: boolean };
}

/** The Company block from what each allowed part read. A part the person may not see has no input here (it was not read) and
 *  contributes nothing. `null` when nothing at all is left to draw, so the widget places no block. */
export function buildCompany(input: {
  access: CompanyAccess;
  document: ReadResult<ReportDocument> | null;
  money: MoneyReads | null;
  from: string;
  to: string;
}): CompanyModel | null {
  const { access, document, money, from, to } = input;
  const tiles: CompanyTile[] = [];
  let noBooks = false;
  let showMoney = false;
  if (access.money && money) {
    const part = moneyPart(money);
    if (part.kind === "tiles") {
      tiles.push(...part.tiles);
      showMoney = true;
    } else if (part.kind === "no-books") {
      noBooks = true;
    }
  }
  let showReport = false;
  if (access.numbers && document) {
    tiles.push(...numberTiles(document));
    showReport = true;
  }
  if (tiles.length === 0 && !noBooks) return null;
  const history = document?.kind === "ok" ? document.data.header.warnings?.precedesFactHistory : undefined;
  return {
    tiles,
    periodLabel: document?.kind === "ok" ? document.data.header.periodLabel : null,
    moneyWindow: showMoney ? `${formatDate(from)} to ${formatDate(to)}` : null,
    noBooks,
    note: history ? `These numbers cover only part of this period: records begin on ${formatDay(history.firstFactDate)}.` : null,
    links: { report: showReport, finance: showMoney || noBooks },
  };
}

// ── Campaigns across departments ─────────────────────────────────────────────────────────────────

export const COMPANY_CAMPAIGNS_SHOWN = 5;

export interface CompanyCampaignRow {
  id: string;
  name: string;
  status: string;
  /** Departments with a live part in it. */
  parts: number;
  startsOn: string | null;
  endsOn: string | null;
}

export type CompanyCampaignsView =
  | { kind: "ok"; rows: CompanyCampaignRow[]; total: number }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** The open campaigns, the soonest ending first and the undated last, then by name. A finished or cancelled campaign is not
 *  work left to watch. `total` counts every open campaign so "5 of 8" can say what was cut; an empty `ok` is a real "none". */
export function companyCampaignsView(result: ReadResult<DeptCampaignRow[]>): CompanyCampaignsView {
  if (result.kind !== "ok") return { kind: result.kind };
  const open = result.data.filter(isOpenProject).sort((a, b) => {
    if (a.endsOn !== b.endsOn) return a.endsOn === null ? 1 : b.endsOn === null ? -1 : a.endsOn.localeCompare(b.endsOn);
    return a.name.localeCompare(b.name);
  });
  return {
    kind: "ok",
    total: open.length,
    rows: open.slice(0, COMPANY_CAMPAIGNS_SHOWN).map((r) => ({
      id: r.id, name: r.name, status: r.status, parts: r.partCount, startsOn: r.startsOn, endsOn: r.endsOn,
    })),
  };
}

export const partsText = (parts: number): string => (parts === 0 ? "No department part yet" : `${parts} ${parts === 1 ? "department" : "departments"}`);

// ── Growth: learning compliance and the appraisal cycle ──────────────────────────────────────────

export type CompanyLearningView =
  | {
    kind: "ok";
    /** Mandatory paths only, like the Team progress page. */
    paths: number;
    assigned: number;
    completed: number;
    outstanding: number;
    overdue: number;
    /** Completed over assigned, in whole percent; null when nothing mandatory is assigned (not "100%", not "0%"). */
    coverage: number | null;
    /** The mandatory path with the lowest coverage, named only when more than one path has people assigned. */
    lowest: { title: string; coverage: number } | null;
  }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

/** `GET lms/compliance` (the company-wide grid) as a view. Waived is not a completion: it counts toward neither side. */
export function companyLearningView(result: ReadResult<ComplianceRow[]>): CompanyLearningView {
  if (result.kind !== "ok") return { kind: result.kind };
  const mandatory = result.data.filter((r) => r.isMandatory);
  const sum = (pick: (r: ComplianceRow) => number) => mandatory.reduce((n, r) => n + pick(r), 0);
  const assigned = sum((r) => r.assigned);
  const completed = sum((r) => r.completed);
  const rated = mandatory
    .filter((r) => r.assigned > 0)
    .map((r) => ({ title: r.title, coverage: Math.round((r.completed / r.assigned) * 100) }))
    .sort((a, b) => a.coverage - b.coverage || a.title.localeCompare(b.title));
  return {
    kind: "ok",
    paths: mandatory.length,
    assigned,
    completed,
    outstanding: sum((r) => r.outstanding),
    overdue: sum((r) => r.overdue),
    coverage: assigned > 0 ? Math.round((completed / assigned) * 100) : null,
    lowest: rated.length > 1 ? rated[0] : null,
  };
}

export type CompanyAppraisalsView = TeamAppraisalsView;

/** `GET appraisals` for the company-wide tier: every appraisal of the company, counted by stage (the same counts the head's Team
 *  block uses). The cycles are only counted: a cycle's name needs the HR-only cycle read. An empty `ok` is a real "none yet". */
export function companyAppraisalsView(
  result: ReadResult<{ appraisals: readonly { cycleId: string; status: AppraisalStatus }[] }>,
): CompanyAppraisalsView {
  return teamAppraisalsView(result);
}

/** "3 of 5 finalized": progress is what is finished, over every appraisal in the company's cycles. */
export function appraisalProgressText(c: { total: number; finalized: number }): string {
  return `${c.finalized} of ${c.total} finalized`;
}
