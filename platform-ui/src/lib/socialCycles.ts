// SCP-1c — the Social Media Settings page's types and pure helpers (BFF §63.4 `GET settings` / `PUT settings`, §63.5 `GET cycles` /
// `PUT cycles` / `GET cycles/:cycleId/health`). No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialCycles-data.ts` (server-only, `ReadResult`), the writes in `lib/socialCyclesActions.ts` ("use server").
// The answers are parsed defensively (`asSocialSettings`, `asCycleTable`): a 200 with the wrong shape must read as "cannot tell", not
// crash the page or draw a plausible-looking empty table.
//
// THE MATHS ARE THE SERVER'S. Pre-fill, ready-by, spare days and the five states are computed by platform-nest
// (`modules/social/pipeline/schedule-health.ts`, pinned by its golden table); this file only draws what the server answered.

export type HealthState = "on_track" | "tight" | "at_risk" | "late" | "done";
export type HolderRole = "officer" | "copywriter" | "approver" | "designer" | "client" | "publisher" | "external";

/** BFF §63.5's Health. */
export interface Health {
  state: HealthState;
  spareDays: number | null;
  lateDays: number | null;
  lateWith: HolderRole | null;
  latestSafeHandoff: string | null;
  readyBy: string;
}

export interface SocialSettings {
  bufferWorkingDays: number;
  boostCandidateFactor: number;
  holidayCalendar: { known: boolean; name: string | null };
  canPlan: boolean;
}

export interface CycleCounts {
  counted: number; planned: number; inProduction: number; withClient: number; clientChanges: number;
  approved: number; scheduled: number; live: number; extra: number; stories: number;
}

export interface CycleRow {
  engagementId: string;
  clientName: string;
  officer: { id: string; name: string } | null;
  deliveryBatch: "A" | "B" | null;
  cycleId: string | null;
  deadline: string | null;
  readyBy: string | null;
  prefill: { deadline: string | null; batch: "A" | "B" | null };
  target: number | null;
  counts: CycleCounts;
  health: Health | null;
}

export interface CycleTable {
  month: string;
  bufferWorkingDays: number;
  holidaysKnown: boolean;
  canPlan: boolean;
  rows: CycleRow[];
}

// ── The words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The reason a control is disabled for a person who may read the page but not plan (PERMISSION §53.6; `not_a_social_approver`). */
export const PLAN_REFUSAL_REASON = "Only the Social Media head, the GM, the owner and the superadmin can change this.";

export const HEALTH_LABEL: Readonly<Record<HealthState, string>> = {
  on_track: "On track", tight: "Tight", at_risk: "At risk", late: "Late", done: "Done",
};

const HOLDER_LABEL: Readonly<Record<HolderRole, string>> = {
  officer: "the officer", copywriter: "the copywriter", approver: "the approvers", designer: "the designer",
  client: "the client", publisher: "the publisher", external: "an outside party",
};

const plural = (n: number, one: string, many: string): string => `${n} ${Math.abs(n) === 1 ? one : many}`;

/** "On track · 3 spare days", "Tight", "At risk", "Late · 2 days · with the designer", "Done": the chip's text (the state is never colour alone). */
export function healthText(h: Health): string {
  const head = HEALTH_LABEL[h.state];
  switch (h.state) {
    case "on_track":
      return h.spareDays !== null ? `${head} · ${plural(h.spareDays, "spare day", "spare days")}` : head;
    case "late": {
      const parts = [head];
      if (h.lateDays !== null) parts.push(plural(h.lateDays, "day", "days"));
      if (h.lateWith) parts.push(`with ${HOLDER_LABEL[h.lateWith] ?? h.lateWith}`);
      return parts.join(" · ");
    }
    default:
      return head;
  }
}

/** The design tokens a state is drawn with (text and dot; the label always carries the meaning too). */
export const HEALTH_TOKEN: Readonly<Record<HealthState, string>> = {
  on_track: "var(--status-ok-fg)", tight: "var(--status-warning-fg)", at_risk: "var(--status-critical-fg)",
  late: "var(--status-danger-fg)", done: "var(--status-idle-fg)",
};

// ── Dates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonthKey = (s: unknown): s is string => typeof s === "string" && MONTH_RE.test(s);

const pad = (n: number): string => String(n).padStart(2, "0");

/** The days a cycle's deadline may take (the `social_cycles` check, BFF §63.1): from the first of the month three months before to the month's last day. */
export function deadlineRange(month: string): { min: string; max: string } {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const t = y * 12 + (m - 1) - 3;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { min: `${Math.floor(t / 12)}-${pad((t % 12) + 1)}-01`, max: `${y}-${pad(m)}-${pad(lastDay)}` };
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const STATES: readonly string[] = ["on_track", "tight", "at_risk", "late", "done"];
const HOLDERS: readonly string[] = ["officer", "copywriter", "approver", "designer", "client", "publisher", "external"];

function asHealth(raw: unknown): Health | null {
  if (!isObj(raw) || typeof raw.state !== "string" || !STATES.includes(raw.state)) return null;
  return {
    state: raw.state as HealthState,
    spareDays: num(raw.spareDays),
    lateDays: num(raw.lateDays),
    lateWith: typeof raw.lateWith === "string" && HOLDERS.includes(raw.lateWith) ? (raw.lateWith as HolderRole) : null,
    latestSafeHandoff: str(raw.latestSafeHandoff),
    readyBy: str(raw.readyBy) ?? "",
  };
}

const COUNT_KEYS = ["counted", "planned", "inProduction", "withClient", "clientChanges", "approved", "scheduled", "live", "extra", "stories"] as const;
function asCounts(raw: unknown): CycleCounts {
  const o = isObj(raw) ? raw : {};
  const out = {} as CycleCounts;
  for (const k of COUNT_KEYS) out[k] = num(o[k]) ?? 0;
  return out;
}

/** The settings answer. Throws on a body that is not one (the reader turns that into "cannot tell"). */
export function asSocialSettings(raw: unknown): SocialSettings {
  if (!isObj(raw)) throw new Error("settings: not an object");
  const buffer = num(raw.bufferWorkingDays);
  const factor = num(raw.boostCandidateFactor);
  if (buffer === null || factor === null) throw new Error("settings: missing buffer or factor");
  const cal = isObj(raw.holidayCalendar) ? raw.holidayCalendar : {};
  return {
    bufferWorkingDays: buffer, boostCandidateFactor: factor,
    holidayCalendar: { known: cal.known === true, name: str(cal.name) },
    canPlan: raw.canPlan === true,
  };
}

/** The deadline table. Throws on a body that is not one. */
export function asCycleTable(raw: unknown): CycleTable {
  if (!isObj(raw) || !isMonthKey(raw.month) || !Array.isArray(raw.rows)) throw new Error("cycles: not a deadline table");
  const rows: CycleRow[] = [];
  for (const r of raw.rows) {
    if (!isObj(r) || typeof r.engagementId !== "string" || typeof r.clientName !== "string") continue;
    const batch = (v: unknown): "A" | "B" | null => (v === "A" || v === "B" ? v : null);
    const prefill = isObj(r.prefill) ? r.prefill : {};
    const officer = isObj(r.officer) && typeof r.officer.id === "string" ? { id: r.officer.id, name: str(r.officer.name) ?? "" } : null;
    rows.push({
      engagementId: r.engagementId, clientName: r.clientName, officer, deliveryBatch: batch(r.deliveryBatch),
      cycleId: str(r.cycleId), deadline: str(r.deadline), readyBy: str(r.readyBy),
      prefill: { deadline: str(prefill.deadline), batch: batch(prefill.batch) },
      target: num(r.target), counts: asCounts(r.counts), health: asHealth(r.health),
    });
  }
  return {
    month: raw.month, bufferWorkingDays: num(raw.bufferWorkingDays) ?? 0, holidaysKnown: raw.holidaysKnown === true,
    canPlan: raw.canPlan === true, rows,
  };
}

// ── Messages for the refusals of the writes ────────────────────────────────────────────────────────────────────────────────

/** The sentence for a refusal code of the settings and cycles writes (the token itself stays the contract; this is only the words). */
export function writeRefusalText(code: string, field?: string): string {
  switch (code) {
    case "not_a_social_approver": return PLAN_REFUSAL_REASON;
    case "engagement_not_found": return "One of these clients is no longer in the table. Reload the page and try again.";
    case "too_many_rows": return "Too many rows in one save (100 at most).";
    case "unknown_field": return `The server did not recognise ${field ?? "a field"}.`;
    case "duplicate_row": return "A client appears twice in one save.";
    case "invalid_field": {
      if (field === "bufferWorkingDays") return "The buffer is a whole number of working days from 0 to 10.";
      if (field === "boostCandidateFactor") return "The boost-candidate factor is a number from 1 to 10, with at most two decimals.";
      if (field && /^rows\[\d+\]\.deadline$/.test(field)) return "A deadline must be a real date from three months before the month to its last day.";
      return field ? `${field} is not valid.` : "A value is not valid.";
    }
    default: return code;
  }
}
