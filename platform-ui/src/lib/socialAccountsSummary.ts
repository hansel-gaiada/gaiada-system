// SCP-Sg (BFF §63.10 `GET engagements/:engagementId/accounts-summary`; plan §5): the client's accounts read back, as types, a parser and WORDS. No server-only
// import, so a client component, the header (a server component) and the DEMO_MODE handlers may all import it. The server decides every number (it reads
// `social_metrics_daily`, a real account's pulled rows or a simulated account's simulated ones, never both); this file parses what it answered and says it.
//
// THE RULES THE WORDS KEEP: "not reported" is never drawn as 0 (a null count is "not reported yet", and a client that has not synced says "Not synced yet"); a
// failed or refused read is said as a failed or refused read, never as "0 followers"; and anything the simulator wrote carries the SIMULATED mark.
import { formatDateTime } from "./format";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export type SummarySource = "pull" | "simulated";

export interface AccountSummaryView {
  accountId: string;
  network: string;
  handle: string;
  simulated: boolean;
  followers: number | null;
  followersDelta30d: number | null;
  reach30d: number | null;
  impressions30d: number | null;
  lastSyncedAt: string | null;
  source: SummarySource | null;
}

export interface AccountsSummaryView {
  accounts: AccountSummaryView[];
  totals: { followers: number | null; reach30d: number | null };
  /** True when any number came from the simulator: the page marks the totals SIMULATED. */
  simulated: boolean;
  lastSyncedAt: string | null;
}

/** What the client page draws from the read: the answer, a refusal, or "could not read" (never an empty answer in their place). */
export type AccountsSummaryRead = { kind: "ok"; data: AccountsSummaryView } | { kind: "forbidden" } | { kind: "unavailable" };

/** `GET engagements/:engagementId/accounts-summary`. Throws on a body that is not one (a wrong shape reads as "cannot tell", never as a client with no followers). */
export function asAccountsSummary(raw: unknown): AccountsSummaryView {
  if (!isObj(raw) || !Array.isArray(raw.accounts) || !isObj(raw.totals)) throw new Error("accounts summary: not an answer");
  const accounts = raw.accounts.map((a): AccountSummaryView => {
    if (!isObj(a) || typeof a.accountId !== "string" || typeof a.network !== "string" || typeof a.handle !== "string") throw new Error("accounts summary: not an account");
    const source = a.source === "pull" || a.source === "simulated" ? a.source : null;
    return {
      accountId: a.accountId, network: a.network, handle: a.handle, simulated: a.simulated === true || source === "simulated",
      followers: int(a.followers), followersDelta30d: int(a.followersDelta30d), reach30d: int(a.reach30d), impressions30d: int(a.impressions30d),
      lastSyncedAt: str(a.lastSyncedAt), source,
    };
  });
  return {
    accounts,
    totals: { followers: int(raw.totals.followers), reach30d: int(raw.totals.reach30d) },
    simulated: raw.simulated === true || accounts.some((a) => a.source === "simulated"),
    lastSyncedAt: str(raw.lastSyncedAt),
  };
}

/** A whole number with thousands separators, in the one locale every number on screen uses. */
export const countText = (n: number): string => n.toLocaleString("en-GB");

/** "+250" / "-40" / "no change": the 30-day change of the followers. */
export function deltaText(n: number): string {
  if (n === 0) return "no change in 30 days";
  return `${n > 0 ? "+" : "-"}${countText(Math.abs(n))} in 30 days`;
}

/** "Last synced 28 Oct, 10:00" or, for a client no sweep has reached, "Not synced yet". */
export const lastSyncedText = (iso: string | null | undefined): string => (iso ? `Last synced ${formatDateTime(iso)}` : "Not synced yet");

/** The words of the header's line for a read that did not answer. */
export const SUMMARY_FORBIDDEN_TEXT = "Followers and reach need a Social Media read tier.";
export const SUMMARY_UNAVAILABLE_TEXT = "Followers and reach could not be read just now.";
/** The sentence beside the SIMULATED chip on the totals. */
export const SUMMARY_SIMULATED_NOTE = "Simulated numbers: invented by the dev review's simulator, not read from a network.";

/** One account's numbers in words, for its line on the accounts strip: "12,400 followers · Last synced …", "Not synced yet" when it has no row. */
export function accountStatText(a: Pick<AccountSummaryView, "followers" | "lastSyncedAt">): string {
  if (a.followers === null && a.lastSyncedAt === null) return "Not synced yet";
  const followers = a.followers === null ? "Followers not reported" : `${countText(a.followers)} followers`;
  return `${followers} · ${lastSyncedText(a.lastSyncedAt)}`;
}
