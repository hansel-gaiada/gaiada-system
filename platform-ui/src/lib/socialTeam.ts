// SCP-5d (BFF §63.19) — the Social Media Team dashboard's types and pure helpers (`GET team?month=YYYY-MM`). No server-only import, so a client
// component may import the values.
//
// The reader is `lib/socialTeam-data.ts` (server-only, `ReadResult`). The answer is parsed defensively (`asTeamDashboard`): a 200 with the wrong
// shape reads as "cannot tell", never as a plausible empty dashboard. The server decides who may read it (403 `not_a_social_approver`), what a head sees of
// a person (`personRowsLimited`) and what could not be worked out (`partial`); this file only draws what it answered.
import { HEALTH_LABEL, isMonthKey, asHealth, type Health, type HealthState } from "./socialCycles";

export type AttentionKind = "late" | "at_risk" | "blocked" | "failed_post" | "boost_waiting" | "cycle_step_late" | "report_due" | "report_to_check";
export type WorkRole = "officer" | "copywriter" | "designer" | "approver";
export type WaitRole = "officer" | "copywriter" | "approver" | "designer" | "client" | "external";

export interface AttentionItem {
  kind: AttentionKind;
  postId: string | null;
  reportId: string | null;
  boostId: string | null;
  engagementId: string;
  clientName: string;
  title: string | null;
  since: string;
  holder: { role: string; label: string } | null;
  /** `cycle_step_late` only (SCP-5f, BFF §63.27.4): the step's key in the company's rules and the day it was due. Team-level: no person. */
  step: string | null;
  dueDate: string | null;
}

export interface TeamClient {
  engagementId: string;
  clientName: string;
  officer: { id: string; name: string } | null;
  target: number | null;
  counted: number;
  approved: number;
  live: number;
  extra: number;
  stories: number;
  health: Health | null;
}

export interface WorkloadRow { userId: string; name: string; role: WorkRole; holding: number; late: number; oldestSince: string | null }
export interface WaitPerson { userId: string; name: string; posts: number; oldestSince: string | null }
export interface WaitRow { holderRole: WaitRole; posts: number; oldestSince: string | null; averageWorkingDays: number | null; people: WaitPerson[] }
export interface StepAverage { step: string; averageWorkingDays: number | null; samples: number }
export interface EstimateGap { engagementId: string; clientName: string }

export interface TeamDashboard {
  month: string;
  needsAttention: AttentionItem[];
  clients: TeamClient[];
  workload: WorkloadRow[];
  waits: WaitRow[];
  stepAverages: StepAverage[];
  estimatesNotSet: EstimateGap[];
  /** Some people's rows were left out for this caller (DW-4's person-axis gate): say so, quietly. */
  personRowsLimited: boolean;
  /** The parts the server could not work out this time (it names them). A part named here is NOT empty, it is unknown. */
  partial: string[];
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ATTENTION_ORDER: readonly AttentionKind[] = ["late", "at_risk", "blocked", "failed_post", "boost_waiting", "cycle_step_late", "report_due", "report_to_check"];

export const ATTENTION_LABEL: Readonly<Record<AttentionKind, string>> = {
  late: "Late",
  at_risk: "At risk",
  blocked: "Blocked",
  failed_post: "Failed to post",
  boost_waiting: "Boost waiting",
  cycle_step_late: "Cycle step late",
  report_due: "Report due",
  report_to_check: "Report to check",
};

/** One plain sentence per kind: what it means. The kind's label is never the only signal. */
export const ATTENTION_WORDS: Readonly<Record<AttentionKind, string>> = {
  late: "Past its ready-by date",
  at_risk: "Will be late unless it moves soon",
  blocked: "Stopped until something outside the post changes",
  failed_post: "The network refused it; it did not go live",
  boost_waiting: "A boost was requested and is waiting for the client, or was approved and has not started",
  cycle_step_late: "A step of the client’s monthly cycle is past its due date and still open",
  report_due: "Due on the client’s report day and not yet sent",
  report_to_check: "A drafted report is waiting for its check",
};

export const WORK_ROLE_LABEL: Readonly<Record<WorkRole, string>> = { officer: "Officer", copywriter: "Copywriter", designer: "Designer", approver: "Approver" };
export const WAIT_ROLE_LABEL: Readonly<Record<WaitRole, string>> = {
  officer: "Officers", copywriter: "Copywriters", approver: "Approvers", designer: "Designers", client: "Clients", external: "Outside parties",
};

/** Said once on the page where the per-holder numbers are drawn (BFF §63.19: counted against the holder, never the officer). */
export const HOLDER_NOTE = "Waiting time is counted against whoever holds the post, not the client's officer.";
export const LIMITED_NOTE = "Some people's rows are not shown to you.";

/** Step keys the server may name, in words; an unknown key is shown as the server sent it. */
const STEP_LABEL: Readonly<Record<string, string>> = {
  proofread: "Proofread", hod: "HoD approval", design: "Design", final: "Final check", client: "Client approval", schedule: "Scheduling",
  brief: "Brief", copy: "Copy",
};
export const stepLabel = (step: string): string => STEP_LABEL[step] ?? step;

/** The row's second line: when it has been waiting, and with whom. A late cycle step says the day it was due, in words ("Was due 12 Oct"), never a bare date. */
export function attentionMeta(it: AttentionItem): string {
  if (it.kind === "cycle_step_late") {
    const day = it.dueDate ?? it.since;
    return `Was due ${sinceText(day).replace(/^Since /, "")}`;
  }
  const holder = holderText(it.holder);
  return `${sinceText(it.since)}${holder ? ` · With ${holder}` : ""}`;
}

/** What `partial` names, in words. An unknown name is shown as sent: a part we cannot name is still a part that is missing. */
const PART_LABEL: Readonly<Record<string, string>> = {
  needsAttention: "needs attention", clients: "clients", workload: "workload", waits: "where work waits", stepAverages: "step averages",
  estimatesNotSet: "estimates not set", reports: "reports", boosts: "boosts",
};
export const partialText = (partial: readonly string[]): string | null =>
  partial.length === 0 ? null : `Not worked out this time: ${partial.map((p) => PART_LABEL[p] ?? p).join(", ")}. What is missing is unknown, not empty.`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2.5 working days", "1 working day", or "No data yet" for null. */
export function workingDaysText(n: number | null): string {
  if (n === null) return "No data yet";
  const r = Math.round(n * 10) / 10;
  return `${r} ${r === 1 ? "working day" : "working days"}`;
}

/** "1 post" / "3 posts". */
export const postsCount = (n: number): string => plural(n, "post", "posts");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Since 12 Oct"; no (or an unreadable) date reads "No date". `iso` is a day or a timestamp. */
export function sinceText(iso: string | null): string {
  if (!iso) return "No date";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return "No date";
  return `Since ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The holder in words, to follow "With": the server's label, which names a role and never a person ("The designer", "The HoD or the
 *  GM": BFF §63.19's needs attention is team-level and the same for every reader), with its first letter lowered ("With the designer").
 *  A label the server left empty falls back to the role key. */
export function holderText(h: AttentionItem["holder"]): string | null {
  if (!h) return null;
  const words = h.label || h.role;
  return words ? words.charAt(0).toLowerCase() + words.slice(1) : null;
}

// ── Links ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const e = encodeURIComponent;

/** Where an attention row opens. A report opens its own page, or the reports list when it is not drafted yet (an overdue report has no id), and never the client's
 *  profile; a boost opens the Boosting page; a post opens its post page. A row that names none of them falls back to the client's profile. */
export function attentionHref(deptId: string, it: AttentionItem): string {
  const base = `/departments/${e(deptId)}`;
  if (it.kind === "report_due" || it.kind === "report_to_check") {
    return it.reportId ? `${base}/social-reports/${e(it.reportId)}` : `${base}/social-reports`;
  }
  if (it.kind === "boost_waiting") return `${base}/boosts`;
  // A late cycle step opens the client's Plan tab, where the six steps are drawn (BFF §63.27.4).
  if (it.kind === "cycle_step_late") return `${base}/profile/${e(it.engagementId)}?tab=plan`;
  if (it.postId) return `${base}/posts/${e(it.postId)}`;
  return `${base}/profile/${e(it.engagementId)}`;
}
export const clientHref = (deptId: string, engagementId: string): string => `/departments/${e(deptId)}/profile/${e(engagementId)}`;
export const dashboardHref = (deptId: string, month: string, today: string): string => {
  const base = `/departments/${e(deptId)}/dashboard`;
  return month === today.slice(0, 7) ? base : `${base}?month=${month}`;
};
export const settingsHref = (deptId: string): string => `/departments/${e(deptId)}/settings`;

// ── Derived numbers (the reports block and the sections) ───────────────────────────────────────────────────────────────────

/** How many attention rows are late or at risk (the Reports › Team block's second number). */
export const lateOrAtRiskCount = (d: Pick<TeamDashboard, "needsAttention">): number =>
  d.needsAttention.filter((i) => i.kind === "late" || i.kind === "at_risk").length;

/** Attention rows grouped by kind in the contract's order, oldest first inside a kind; a kind with no row is left out. */
export function attentionGroups(items: readonly AttentionItem[]): Array<{ kind: AttentionKind; items: AttentionItem[] }> {
  return ATTENTION_ORDER
    .map((kind) => ({ kind, items: items.filter((i) => i.kind === kind).sort((a, b) => a.since.localeCompare(b.since)) }))
    .filter((g) => g.items.length > 0);
}

const HEALTH_RANK: Readonly<Record<HealthState, number>> = { late: 0, at_risk: 1, tight: 2, on_track: 3, done: 4 };
/** Clients worst-health first, then by name; a client with no health (no cycle) goes last. */
export function clientsByHealth(clients: readonly TeamClient[]): TeamClient[] {
  const rank = (c: TeamClient): number => (c.health ? HEALTH_RANK[c.health.state] : 5);
  return [...clients].sort((a, b) => rank(a) - rank(b) || a.clientName.localeCompare(b.clientName));
}

/** "8 of 12", or "8" with no target; extras and stories beside it. Same words as the deadline table. */
export function postsText(c: Pick<TeamClient, "target" | "counted" | "extra" | "stories">): { main: string; beside: string | null } {
  const main = c.target !== null ? `${c.counted} of ${c.target}` : String(c.counted);
  const beside = [c.extra > 0 ? `${c.extra} extra` : null, c.stories > 0 ? `${c.stories} ${c.stories === 1 ? "story" : "stories"}` : null].filter(Boolean).join(" · ");
  return { main, beside: beside || null };
}

/** Workload, most posts held first, then most late, then name. */
export const workloadSorted = (rows: readonly WorkloadRow[]): WorkloadRow[] =>
  [...rows].sort((a, b) => b.holding - a.holding || b.late - a.late || a.name.localeCompare(b.name));

/** Waits, the longest wait first (oldest `oldestSince`; a role with no date goes last). */
export const waitsSorted = (rows: readonly WaitRow[]): WaitRow[] =>
  [...rows].sort((a, b) => (a.oldestSince ?? "9999").localeCompare(b.oldestSince ?? "9999") || b.posts - a.posts);

export { HEALTH_LABEL };

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const WORK_ROLES: readonly WorkRole[] = ["officer", "copywriter", "designer", "approver"];
const WAIT_ROLES: readonly WaitRole[] = ["officer", "copywriter", "approver", "designer", "client", "external"];

/** The team dashboard answer. Throws on a body that is not one (the reader turns that into "cannot tell"); a row that is not a row is dropped. */
export function asTeamDashboard(raw: unknown): TeamDashboard {
  if (!isObj(raw) || !isMonthKey(raw.month)) throw new Error("team: not a team dashboard");
  for (const k of ["needsAttention", "clients", "workload", "waits", "stepAverages", "estimatesNotSet"] as const) {
    if (!Array.isArray(raw[k])) throw new Error(`team: ${k} is not a list`);
  }
  const needsAttention: AttentionItem[] = [];
  for (const r of list(raw.needsAttention)) {
    const kind = isObj(r) ? oneOf(r.kind, ATTENTION_ORDER) : null;
    if (!isObj(r) || !kind || typeof r.engagementId !== "string" || typeof r.clientName !== "string") continue;
    const h = isObj(r.holder) && typeof r.holder.role === "string" ? { role: r.holder.role, label: str(r.holder.label) ?? "" } : null;
    needsAttention.push({
      kind, postId: str(r.postId), reportId: str(r.reportId), boostId: str(r.boostId), engagementId: r.engagementId, clientName: r.clientName,
      title: str(r.title), since: str(r.since) ?? "", holder: h, step: str(r.step), dueDate: str(r.dueDate),
    });
  }
  const clients: TeamClient[] = [];
  for (const r of list(raw.clients)) {
    if (!isObj(r) || typeof r.engagementId !== "string" || typeof r.clientName !== "string") continue;
    clients.push({
      engagementId: r.engagementId, clientName: r.clientName,
      officer: isObj(r.officer) && typeof r.officer.id === "string" ? { id: r.officer.id, name: str(r.officer.name) ?? "" } : null,
      target: num(r.target), counted: count(r.counted), approved: count(r.approved), live: count(r.live), extra: count(r.extra), stories: count(r.stories),
      health: asHealth(r.health),
    });
  }
  const workload: WorkloadRow[] = [];
  for (const r of list(raw.workload)) {
    const role = isObj(r) ? oneOf(r.role, WORK_ROLES) : null;
    if (!isObj(r) || !role || typeof r.userId !== "string") continue;
    workload.push({ userId: r.userId, name: str(r.name) ?? "", role, holding: count(r.holding), late: count(r.late), oldestSince: str(r.oldestSince) });
  }
  const waits: WaitRow[] = [];
  for (const r of list(raw.waits)) {
    const holderRole = isObj(r) ? oneOf(r.holderRole, WAIT_ROLES) : null;
    if (!isObj(r) || !holderRole) continue;
    const people: WaitPerson[] = [];
    for (const p of list(r.people)) {
      if (isObj(p) && typeof p.userId === "string") people.push({ userId: p.userId, name: str(p.name) ?? "", posts: count(p.posts), oldestSince: str(p.oldestSince) });
    }
    waits.push({ holderRole, posts: count(r.posts), oldestSince: str(r.oldestSince), averageWorkingDays: num(r.averageWorkingDays), people });
  }
  const stepAverages: StepAverage[] = [];
  for (const r of list(raw.stepAverages)) {
    if (isObj(r) && typeof r.step === "string") stepAverages.push({ step: r.step, averageWorkingDays: num(r.averageWorkingDays), samples: count(r.samples) });
  }
  const estimatesNotSet: EstimateGap[] = [];
  for (const r of list(raw.estimatesNotSet)) {
    if (isObj(r) && typeof r.engagementId === "string" && typeof r.clientName === "string") estimatesNotSet.push({ engagementId: r.engagementId, clientName: r.clientName });
  }
  return {
    month: raw.month, needsAttention, clients, workload, waits, stepAverages, estimatesNotSet,
    personRowsLimited: raw.personRowsLimited === true,
    partial: list(raw.partial).filter((x): x is string => typeof x === "string"),
  };
}
