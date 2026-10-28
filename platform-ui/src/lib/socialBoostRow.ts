// SCP-4b (BFF §63.11): the `BoostRow` of a boost, its words and the money display. No server-only import, so a client component may import the values, and no import of
// `socialPipeline.ts` (that file reads the post's `boost` through `asBoostRow` here, so the dependency runs one way).
//
// MONEY is integer minor units on the wire (`totalBudgetMinor`, `spendMinor`, ...). The answer carries its own `minorUnit` (the currency's decimals: IDR 0, USD 2); `formatBoostMoney`
// divides by it and never rounds a figure the server sent. A currency that is unknown reads as IDR, the department's currency.
import { fromMinor, minorUnitOf } from "./contracts";
import { scpBoostStatuses } from "./scpStageMachine";

/** The boost's statuses, as the fixture lists them (`boosts.statuses`). */
export const BOOST_STATUSES: readonly string[] = scpBoostStatuses();
export type BoostStatus = "requested" | "approved" | "running" | "stopped" | "completed" | "cancelled" | "declined";

export const BOOST_GOALS = ["profile_visits", "website", "messages"] as const;
export type BoostGoal = (typeof BOOST_GOALS)[number];
export const BOOST_GOAL_LABEL: Readonly<Record<BoostGoal, string>> = { profile_visits: "Profile visits", website: "Website visits", messages: "Messages" };

export const BOOST_AUDIENCES = ["automatic", "local", "custom"] as const;
export type BoostAudience = (typeof BOOST_AUDIENCES)[number];
export const BOOST_AUDIENCE_LABEL: Readonly<Record<BoostAudience, string>> = { automatic: "Automatic", local: "People nearby", custom: "A custom audience" };

export const BOOST_STATUS_LABEL: Readonly<Record<string, string>> = {
  requested: "Waiting for the client", approved: "Approved, not started", running: "Running", stopped: "Stopped", completed: "Completed", cancelled: "Cancelled", declined: "Declined",
};
export const boostStatusLabel = (s: string | null | undefined): string => (s ? BOOST_STATUS_LABEL[s] ?? s : "");

/** Where an approval came from. */
export const APPROVED_VIA_LABEL: Readonly<Record<string, string>> = { budget: "within the agreed monthly budget", portal: "by the client in the portal", recorded: "recorded by our team" };

export interface BoostRow {
  id: string; postId: string; postTitle: string; clientName: string; cycleId: string | null; status: string;
  goal: string; audience: string; audienceNote: string | null;
  dailyBudgetMinor: number; days: number; totalBudgetMinor: number; currency: string; minorUnit: number; startsOn: string;
  approvedVia: "budget" | "portal" | "recorded" | null; approvedAt: string | null; startedAt: string | null; endedAt: string | null;
  spendMinor: number | null; paidReach: number | null; clicks: number | null; reachEstimate: { low: number; high: number } | null; simulated: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A `BoostRow` from the wire. Throws on a body that is not one (the reader turns that into "cannot tell"). A missing optional part reads as null, never as 0. */
export function asBoostRow(raw: unknown): BoostRow {
  if (!isObj(raw) || typeof raw.id !== "string" || typeof raw.status !== "string" || typeof raw.postId !== "string") throw new Error("boost: not a BoostRow");
  const via = raw.approvedVia === "budget" || raw.approvedVia === "portal" || raw.approvedVia === "recorded" ? raw.approvedVia : null;
  const est = isObj(raw.reachEstimate) && int(raw.reachEstimate.low) !== null && int(raw.reachEstimate.high) !== null
    ? { low: raw.reachEstimate.low as number, high: raw.reachEstimate.high as number } : null;
  const currency = str(raw.currency) ?? "IDR";
  return {
    id: raw.id, postId: raw.postId, postTitle: str(raw.postTitle) ?? "", clientName: str(raw.clientName) ?? "", cycleId: str(raw.cycleId), status: raw.status,
    goal: str(raw.goal) ?? "", audience: str(raw.audience) ?? "", audienceNote: str(raw.audienceNote),
    dailyBudgetMinor: int(raw.dailyBudgetMinor) ?? 0, days: int(raw.days) ?? 0, totalBudgetMinor: int(raw.totalBudgetMinor) ?? 0, currency,
    minorUnit: int(raw.minorUnit) ?? minorUnitOf(currency), startsOn: str(raw.startsOn) ?? "",
    approvedVia: via, approvedAt: str(raw.approvedAt), startedAt: str(raw.startedAt), endedAt: str(raw.endedAt),
    spendMinor: int(raw.spendMinor), paidReach: int(raw.paidReach), clicks: int(raw.clicks), reachEstimate: est, simulated: raw.simulated === true,
  };
}

/** `asBoostRow` for an optional part: null stays null, anything that is not a boost is null too (the post page then offers a new boost, never a half-drawn card). */
export function asBoostRowOrNull(raw: unknown): BoostRow | null {
  if (raw === null || raw === undefined) return null;
  try { return asBoostRow(raw); } catch { return null; }
}

// ── money ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "IDR 1,000,000": minor units shown in the currency's own decimals (`minorUnit` from the answer; the currency's usual when the answer has none). */
export function formatBoostMoney(minor: number | null | undefined, currency: string | null | undefined, minorUnit?: number | null): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return "—";
  const cur = (currency ?? "IDR").trim().toUpperCase() || "IDR";
  const unit = typeof minorUnit === "number" && Number.isInteger(minorUnit) && minorUnit >= 0 && minorUnit <= 6 ? minorUnit : minorUnitOf(cur);
  const plain = fromMinor(BigInt(Math.trunc(minor)), unit);
  const neg = plain.startsWith("-");
  const [i, f] = plain.replace("-", "").split(".");
  return `${cur} ${neg ? "-" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${f ? `.${f}` : ""}`;
}

/** A whole count with thousands separators ("12,400"); a counter the server did not report is "Not reported", never 0. */
export const formatBoostCount = (n: number | null | undefined): string => (n === null || n === undefined ? "Not reported" : n.toLocaleString("en-GB"));

/** "5 days from 3 Nov 2026" pieces for a boost line: the days word. */
export const daysText = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/** "27 Oct 2026" from a plain `YYYY-MM-DD` (never through `Date`, so no time zone can move the day). Anything else is returned as it came. */
export function plainDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return iso ?? "—";
  return `${Number(m[3])} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m[2]) - 1]} ${m[1]}`;
}
