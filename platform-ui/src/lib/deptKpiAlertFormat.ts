// Department KPI alerts (DW-4j-2): the TYPES and PURE formatters, BFF contract §43.5 / §43.6a. No server-only import, so a client
// component (the Acknowledge controls) can use them; the readers that call the backend are in lib/deptKpiAlerts.ts.
//
// A value and a target are worded by `formatKpiValue` in deptKpiFormat.ts and by nothing else: there is ONE KPI formatter, so an alert
// reads "72% against 90%" exactly as the KPI tile and the banner do.
//
// DAYS. An alert's timestamps are instants (ISO, UTC). The day shown is the UTC calendar day: deterministic on the server and in the
// browser (no locale, no timezone, so no hydration mismatch), the same rule the page already uses for a proposal's date (`proposedAt.slice(0, 10)`).
import { formatKpiValue, type KpiCondition, type KpiUnit } from "./deptKpiFormat";

/** The longest note an acknowledgement takes (§43.5). */
export const ALERT_NOTE_MAX = 1000;

/** One row of `GET dept-kpis/alerts` (§43.5): an alert is a state, open until the scheduled run resolves it. */
export interface KpiAlert {
  id: string;
  unit: { id: string; name: string };
  kpiKey: string;
  /** The catalogue's label; the KPI key itself when the unit's workspace no longer has the KPI. */
  kpiLabel: string;
  /** Null when the unit's workspace no longer has the KPI: its value then has no scale to be worded in. */
  kpiUnit: KpiUnit | null;
  periodStart: string;
  openedAt: string;
  value: number | null;
  target: number | null;
  acknowledgedBy: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  ackNote: string | null;
  resolvedAt: string | null;
  resolvedCondition: KpiCondition | null;
}

export type AlertState = "open" | "acknowledged" | "resolved";

/** Resolved wins (a resolved alert may also have been acknowledged); then acknowledged; else it still waits on a head. */
export function alertState(a: Pick<KpiAlert, "resolvedAt" | "acknowledgedAt">): AlertState {
  if (a.resolvedAt) return "resolved";
  return a.acknowledgedAt ? "acknowledged" : "open";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct" for an ISO instant or date; with `refYear`, "3 Oct 2025" when the year is not that one. An unreadable value is "an unknown day". */
export function formatAlertDay(iso: string, refYear?: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  const mi = m ? Number(m[2]) - 1 : -1;
  if (!m || mi < 0 || mi > 11) return "an unknown day";
  const y = Number(m[1]);
  const base = `${Number(m[3])} ${MONTHS[mi]}`;
  return refYear !== undefined && y !== refYear ? `${base} ${y}` : base;
}

/** "Projects on time is off track · Web Dev": the Needs-you title. */
export function alertTitle(a: Pick<KpiAlert, "kpiLabel" | "unit">): string {
  return `${a.kpiLabel} is off track · ${a.unit.name}`;
}

/** "72% against 90%", or null when the KPI has left the unit's workspace (no scale to word it in). */
export function alertReading(a: Pick<KpiAlert, "value" | "target" | "kpiUnit">): string | null {
  if (a.kpiUnit === null) return null;
  return `${formatKpiValue(a.value, a.kpiUnit)} against ${formatKpiValue(a.target, a.kpiUnit)}`;
}

/** "Off track since 3 Oct". */
export function offTrackSince(a: Pick<KpiAlert, "openedAt">, refYear?: number): string {
  return `Off track since ${formatAlertDay(a.openedAt, refYear)}`;
}

/** "Acknowledged by Ayu on 4 Oct" ("Acknowledged on 4 Oct" when the name is not known), or null when nobody has. */
export function acknowledgedLine(a: Pick<KpiAlert, "acknowledgedAt" | "acknowledgedByName">, refYear?: number): string | null {
  if (!a.acknowledgedAt) return null;
  const by = a.acknowledgedByName ? ` by ${a.acknowledgedByName}` : "";
  return `Acknowledged${by} on ${formatAlertDay(a.acknowledgedAt, refYear)}`;
}

/** "Back on track on 9 Oct", "Improved to at risk on 9 Oct", "Resolved (unavailable) on 1 Nov", or null while the alert is open. */
export function resolvedLine(a: Pick<KpiAlert, "resolvedAt" | "resolvedCondition">, refYear?: number): string | null {
  if (!a.resolvedAt) return null;
  const day = formatAlertDay(a.resolvedAt, refYear);
  if (a.resolvedCondition === "on_track") return `Back on track on ${day}`;
  if (a.resolvedCondition === "at_risk") return `Improved to at risk on ${day}`;
  if (a.resolvedCondition === "unavailable") return `Resolved (unavailable) on ${day}`;
  return `Resolved on ${day}`;
}

/** The line on a KPI tile with an open alert: "Off track since 3 Oct", plus " · acknowledged by Ayu" once a head has. */
export function tileAlertLine(a: Pick<KpiAlert, "openedAt" | "acknowledgedAt" | "acknowledgedByName">, refYear?: number): string {
  const ack = a.acknowledgedAt ? ` · acknowledged${a.acknowledgedByName ? ` by ${a.acknowledgedByName}` : ""}` : "";
  return `${offTrackSince(a, refYear)}${ack}`;
}

/** The unit's open alerts by KPI key (one open alert per unit and KPI, §43.5). A resolved alert is history, never a tile line. */
export function openAlertsByKpi<T extends Pick<KpiAlert, "kpiKey" | "resolvedAt">>(alerts: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const a of alerts) if (!a.resolvedAt && !out.has(a.kpiKey)) out.set(a.kpiKey, a);
  return out;
}

/** The history, newest opened first (the server sends it so; this keeps the page right if it ever did not). Ties keep the sent order. */
export function newestFirst<T extends Pick<KpiAlert, "openedAt">>(alerts: readonly T[]): T[] {
  return alerts
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (x.a.openedAt < y.a.openedAt ? 1 : x.a.openedAt > y.a.openedAt ? -1 : x.i - y.i))
    .map((x) => x.a);
}

/** The two 409 machine codes an acknowledge can meet, as sentences. Anything else (403, 404, 400) is the server's own words. */
export function explainAckError(message: string): string {
  if (message === "already_acknowledged") return "This alert was already acknowledged. Refresh to see by whom.";
  if (message === "resolved") return "This alert is resolved: the KPI is no longer off track. Refresh to see where it stands.";
  return message;
}

const CONDITIONS: readonly string[] = ["on_track", "at_risk", "off_track", "unavailable"];
const KPI_UNITS: readonly string[] = ["percent", "count", "minutes"];
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const numOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v));

/** Whether a wire row has the shape §43.5 documents. The readers refuse an answer with a row that fails, rather than render half of it. */
export function isKpiAlert(v: unknown): v is KpiAlert {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  const unit = a.unit as Record<string, unknown> | null | undefined;
  return (
    typeof a.id === "string" &&
    !!unit && typeof unit === "object" && typeof unit.id === "string" && typeof unit.name === "string" &&
    typeof a.kpiKey === "string" && typeof a.kpiLabel === "string" &&
    (a.kpiUnit === null || (typeof a.kpiUnit === "string" && KPI_UNITS.includes(a.kpiUnit))) &&
    typeof a.periodStart === "string" && typeof a.openedAt === "string" &&
    numOrNull(a.value) && numOrNull(a.target) &&
    strOrNull(a.acknowledgedBy) && strOrNull(a.acknowledgedByName) && strOrNull(a.acknowledgedAt) && strOrNull(a.ackNote) &&
    strOrNull(a.resolvedAt) &&
    (a.resolvedCondition === null || (typeof a.resolvedCondition === "string" && CONDITIONS.includes(a.resolvedCondition)))
  );
}
