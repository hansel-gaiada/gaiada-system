// SCP-Sg (BFF §63.10, §63.16; plan §5) — what DEMO_MODE answers for the client's accounts read back, `GET engagements/:engagementId/accounts-summary`, from the demo's
// accounts (`demoSocialAccounts.ts`): the followers, the 30-day change and reach, and "Last synced" of each, all SIMULATED (every demo account is).
//
// THE NUMBERS ARE INVENTED AND DETERMINISTIC. Each is a pure function of the account's id and network (an FNV hash picks a position inside an invented per-network
// range), so a reload shows the same numbers and a test can pin them; nothing is stored. The sync time is the top of the current hour minus one hour, as an hourly
// sweep would have left it. One demo account is deliberately never synced: Northwind's expired TikTok (the registry's non-happy path), so "Not synced yet" and the
// nulls are drivable in the demo, as they are on a client no sweep has reached.
//
// The server's order of checks: the caller's `social_post` read first (a client contact is refused, 403, the Cerbos words), then the engagement (404
// `engagement_not_found`). Nothing here is a real client, person or number.
import { demoAccounts, type DemoAccount } from "./demoSocialAccounts";
import { PIPE_ENGAGEMENTS, isClientContact, type DemoResult } from "./demoSocialPipeline";

const HOUR_MS = 3_600_000;
const NOT_AUTHORIZED = "not authorized: cerbos denied read on social_post";

/** FNV-1a of a string, as an unsigned 32-bit integer. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
/** A deterministic position in [lo, hi) for `(key, salt)`. */
const between = (key: string, salt: string, lo: number, hi: number): number => lo + (fnv(`${key}|${salt}`) / 0x1_0000_0000) * (hi - lo);

/** The invented follower range by network (the simulator's own scale, restated for the demo: a figure is not a contract). */
const FOLLOWER_RANGE: Record<string, [number, number]> = { instagram: [8_000, 26_000], facebook: [3_000, 15_000], tiktok: [1_500, 9_000] };

/** The newest sync the demo shows: the top of the current hour, one hour back. */
export const demoLastSyncedAt = (now: number = Date.now()): string => new Date(Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS).toISOString();

/** Whether the demo's sweep has ever reached this account: every connected or expiring one, never an expired or errored one. */
const hasSynced = (a: DemoAccount): boolean => a.status === "connected" || a.status === "expiring";

/** One account's invented numbers. */
function summaryOf(a: DemoAccount, now: number) {
  const synced = hasSynced(a);
  const [lo, hi] = FOLLOWER_RANGE[a.network] ?? [1_000, 6_000];
  const followers = Math.round(between(a.id, "followers", lo, hi));
  const reach30d = Math.round(followers * between(a.id, "reach", 0.9, 2.4));
  return {
    accountId: a.id, network: a.network, handle: a.handle, simulated: a.simulated,
    followers: synced ? followers : null,
    followersDelta30d: synced ? Math.round(followers * between(a.id, "delta", 0.006, 0.04)) : null,
    reach30d: synced ? reach30d : null,
    impressions30d: synced ? Math.round(reach30d * between(a.id, "impressions", 1.25, 1.6)) : null,
    lastSyncedAt: synced ? demoLastSyncedAt(now) : null,
    source: synced ? (a.simulated ? "simulated" : "pull") : null,
  };
}

/** The newest sync of a client's accounts (the Feed preview's "Last synced"); null for a client none of whose accounts has synced. */
export const demoClientLastSyncedAt = (clientId: string, now: number = Date.now()): string | null =>
  demoAccounts.some((a) => a.clientId === clientId && hasSynced(a)) ? demoLastSyncedAt(now) : null;

/** `GET engagements/:engagementId/accounts-summary`. */
export function demoAccountsSummary(engagementId: string, userId: string, now: number = Date.now()): DemoResult {
  if (isClientContact(userId)) return { status: 403, json: { error: NOT_AUTHORIZED } };
  const eng = PIPE_ENGAGEMENTS.find((e) => e.id === engagementId);
  if (!eng) return { status: 404, json: { error: "engagement_not_found" } };
  const accounts = demoAccounts.filter((a) => a.clientId === eng.clientId)
    .sort((x, y) => (x.network < y.network ? -1 : x.network > y.network ? 1 : x.handle < y.handle ? -1 : x.handle > y.handle ? 1 : 0))
    .map((a) => summaryOf(a, now));
  const sum = (pick: (a: (typeof accounts)[number]) => number | null): number | null => {
    let total: number | null = null;
    for (const a of accounts) { const v = pick(a); if (v !== null) total = (total ?? 0) + v; }
    return total;
  };
  const lastSyncedAt = accounts.reduce<string | null>((best, a) => (a.lastSyncedAt !== null && (best === null || a.lastSyncedAt > best) ? a.lastSyncedAt : best), null);
  return {
    status: 200,
    json: { accounts, totals: { followers: sum((a) => a.followers), reach30d: sum((a) => a.reach30d) }, simulated: accounts.some((a) => a.source === "simulated"), lastSyncedAt },
  };
}

/** `/accounts-summary` by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
export function demoAccountsSummaryRoute(method: string, tail: string, userId: string): DemoResult | null {
  const m = /^engagements\/([^/]+)\/accounts-summary$/.exec(tail);
  return m && method === "GET" ? demoAccountsSummary(decodeURIComponent(m[1]), userId) : null;
}
