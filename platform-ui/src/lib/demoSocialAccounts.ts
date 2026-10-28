// SCP-Sb (plan §5, BFF §63.16) — the DEMO_MODE store of the social ACCOUNTS: the registry the Connections page lists, the pipeline's account guards read, and the
// "Seed simulated accounts" action writes. A LEAF module (it imports nothing from the other demo stores), so `demoSocial.ts`, `demoSocialPipeline.ts` and
// `demoSocialPipelineRun.ts` can all read the same array without a cycle.
//
// EVERY ACCOUNT HERE IS SIMULATED, AND SAYS SO. With the social simulator on, the server holds only simulated accounts (SCP-Sa's boot refuses anything else), and
// the demo is a mock world of invented clients: so the five accounts of the earlier SMM demo (Northwind Traders: three Instagram, a Facebook and an expired TikTok,
// kept for the quota and composer fixtures) are marked `simulated: true`, and the spa and the hotel get the three accounts the seed gives a real mock client:
// one connected Instagram, Facebook and TikTok account each, handle `@mock-<slug of the client name>`, integration id `simulated:<network>`.
//
// WHAT THE DEMO COPIES FROM THE SERVER (`platform-nest/src/modules/social/simulated-accounts.ts`): the seed writes at most one account per client and network
// (a re-run answers `created: false`), refuses `account_exists_not_simulated` beside a live real account (the demo has none), and the teardown only removes
// simulated accounts that no variant uses (`simulated_account_in_use`). What it does not copy: Northwind's SMM-era accounts include three on Instagram, which the
// server's `account_not_ambiguous` guard would refuse; the demo's runner keeps passing that guard (the demo had no account data when it was written).
//
// Pinned to globalThis like the other demo stores (see "WHY THESE STORES ARE PINNED" in demoSocial.ts).

export type DemoSocialNetwork =
  | "instagram" | "facebook" | "tiktok" | "linkedin" | "x"
  | "youtube" | "threads" | "pinterest" | "bluesky" | "mastodon";

export interface DemoAccountCapabilities {
  schedule: boolean; nativeSchedule: boolean; directPost: boolean; stories: boolean;
  comments: boolean; dm: boolean; analytics: boolean;
  unsupported: Partial<Record<"schedule" | "nativeSchedule" | "directPost" | "stories" | "comments" | "dm" | "analytics", "network" | "driver" | "unverified">>;
}
export const FULL_CAPS: DemoAccountCapabilities = {
  schedule: true, nativeSchedule: true, directPost: true, stories: true, comments: true, dm: true, analytics: true, unsupported: {},
};
/** What the simulator offers (the server resolves it from the driver's capability set): it schedules, and reads nothing back yet. */
const SIMULATED_CAPS: DemoAccountCapabilities = {
  schedule: true, nativeSchedule: true, directPost: true, stories: true, comments: false, dm: false, analytics: false,
  unsupported: { comments: "driver", dm: "driver", analytics: "driver" },
};

export interface DemoAccount {
  id: string; clientId: string; network: DemoSocialNetwork; handle: string; displayName: string | null;
  status: "connected" | "expiring" | "expired" | "error";
  quota: Record<string, unknown>;
  capabilities: DemoAccountCapabilities;
  lastError: string | null; healthCheckedAt: string | null; connectedAt: string | null;
  publisherOrgRef: string; driver: string;
  /** SCP-Sb: true on every demo account (see the header). */
  simulated: boolean;
}

/** The three networks the simulator seeds, in the server's order (`SIMULATED_ACCOUNT_NETWORKS`). */
export const DEMO_SIMULATED_NETWORKS = ["instagram", "facebook", "tiktok"] as const;
export type DemoSimulatedNetwork = (typeof DEMO_SIMULATED_NETWORKS)[number];

// ── accounts (SMM-05 registry) — a deliberate mix per the ticket's own requirement: at least one
// connected instagram account with a LIVE known quota, at least one connected account with NO live
// counter (renders "unknown", never "0 used" — QUOTA_UNKNOWN_RULE/describeQuota's own contract),
// one account whose quota is simply not modeled for its network (facebook), and one disconnected
// (expired) account so the registry's non-happy path is drivable too. ───────────────────────────
const NORTHWIND_SEED: DemoAccount[] = [
  {
    id: "soc-acc-ig-1", clientId: "cl-1", network: "instagram", handle: "northwindtraders",
    displayName: "Northwind Traders", status: "connected",
    quota: { igPosts24h: { used: 8, cap: 25 } },
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T06:00:00Z", connectedAt: "2026-07-01T09:10:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph", simulated: true,
  },
  {
    // Deliberately NO `igPosts24h` bucket — the registry has simply never synced this account's
    // quota. `describeQuota` must render "Unknown — registry not synced (never zero)", the exact
    // gap this ticket exists to make drivable.
    id: "soc-acc-ig-2", clientId: "cl-1", network: "instagram", handle: "northwind.behindthescenes",
    displayName: "Northwind BTS", status: "connected",
    quota: {},
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: null, connectedAt: "2026-07-15T11:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph", simulated: true,
  },
  {
    // Quota AT cap — drives the `quota_exhausted` publish-precondition refusal (soc-var-4 below
    // targets this account) and the QuotaStrip's "critical" (100%) styling.
    id: "soc-acc-ig-3", clientId: "cl-1", network: "instagram", handle: "northwind.promo",
    displayName: "Northwind Promo", status: "connected",
    quota: { igPosts24h: { used: 25, cap: 25 } },
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T05:30:00Z", connectedAt: "2026-07-01T09:15:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph", simulated: true,
  },
  {
    // facebook has no live-counter model at all in `describeQuota` — always "not_modeled",
    // regardless of what `quota` carries. A different fact from "unsynced" (soc-acc-ig-2 above).
    id: "soc-acc-fb-1", clientId: "cl-1", network: "facebook", handle: "NorthwindTraders",
    displayName: "Northwind Traders (Facebook)", status: "connected",
    quota: {},
    capabilities: FULL_CAPS, lastError: null,
    healthCheckedAt: "2026-08-19T06:00:00Z", connectedAt: "2026-07-02T09:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "meta-graph", simulated: true,
  },
  {
    // Disconnected — exercises the registry's non-happy status and a capability actually blocked
    // for a real reason ("network": TikTok's API never exposed DM to third-party publishers).
    id: "soc-acc-tiktok-1", clientId: "cl-1", network: "tiktok", handle: "northwindtraders",
    displayName: "Northwind Traders (TikTok)", status: "expired",
    quota: {},
    capabilities: { ...FULL_CAPS, dm: false, unsupported: { dm: "network" } },
    lastError: "OAuth token expired — reconnect required.",
    healthCheckedAt: "2026-08-10T08:00:00Z", connectedAt: "2026-06-20T09:00:00Z",
    publisherOrgRef: "pub-org-northwind", driver: "tiktok-api", simulated: true,
  },
];

/** The clients the simulated seed knows by name (the demo's two other invented clients; Northwind's accounts are above). */
export const DEMO_SIM_CLIENTS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "cl-soc-spa", name: "Saltmarsh Day Spa" },
  { id: "cl-soc-hotel", name: "Harborlight Hotel" },
];

/** PURE. The server's `simulatedHandleFor`: `@mock-<slug of the client name>`, at most 40 characters of slug, never empty. */
export function demoSimulatedHandle(clientName: string, clientId: string): string {
  const slug = clientName.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return `@mock-${slug || clientId.replace(/-/g, "").slice(0, 8)}`;
}

const simulatedAccount = (clientId: string, clientName: string, network: DemoSimulatedNetwork, at: string): DemoAccount => ({
  id: `soc-sim-${clientId}-${network}`, clientId, network, handle: demoSimulatedHandle(clientName, clientId),
  displayName: `${clientName} (simulated ${network})`, status: "connected", quota: {}, capabilities: SIMULATED_CAPS, lastError: null,
  healthCheckedAt: at, connectedAt: at, publisherOrgRef: `simulated-${clientId}`, driver: "postiz", simulated: true,
});

const SEED_AT = "2026-08-19T06:00:00Z";
const STORE = Symbol.for("gaiada.demoSocialAccounts.store");
interface AccountsStore { accounts: DemoAccount[]; removed: DemoAccount[] }
const store: AccountsStore = ((globalThis as Record<symbol, unknown>)[STORE] ??= {
  accounts: [
    ...NORTHWIND_SEED,
    ...DEMO_SIM_CLIENTS.flatMap((c) => DEMO_SIMULATED_NETWORKS.map((n) => simulatedAccount(c.id, c.name, n, SEED_AT))),
  ],
  removed: [],
}) as AccountsStore;

/** The live array: every read and write goes through it, so the registry and the pipeline's guards look at the same accounts. */
export const demoAccounts: DemoAccount[] = store.accounts;

/** How many accounts each network has for this client, counted the way the server counts them (`loadClientAccounts`: not deleted, not disconnected). */
export function demoClientAccountCounts(clientId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of store.accounts) if (a.clientId === clientId) out[a.network] = (out[a.network] ?? 0) + 1;
  return out;
}

/** Which of a client's networks an account guard would refuse for want of an account (`no_account_for_network`). */
export const demoNetworksWithoutAccount = (clientId: string, networks: readonly string[]): string[] => {
  const have = demoClientAccountCounts(clientId);
  return networks.filter((n) => (have[n] ?? 0) === 0);
};

/** SCP-Sa3 (SCP-D9, "a post is wholly simulated or wholly real"): the networks among `networks` that this client holds a SIMULATED account on, and those it holds
 *  a REAL one on, as the server's `account_kinds_not_mixed` reads them (`loadClientAccounts`: not deleted, not disconnected). A network with accounts of both kinds
 *  is listed under both, so it reads as mixed. Every seeded demo account is simulated, so this answers `real: []` until a test (or a later demo feature) adds a real one. */
export function demoAccountKinds(clientId: string, networks: readonly string[]): { simulated: string[]; real: string[] } {
  const simulated = new Set<string>();
  const real = new Set<string>();
  for (const a of store.accounts) if (a.clientId === clientId && networks.includes(a.network)) (a.simulated ? simulated : real).add(a.network);
  return { simulated: [...simulated].sort(), real: [...real].sort() };
}

export interface DemoSeededAccount {
  id: string; network: DemoSimulatedNetwork; handle: string; simulated: true; created: boolean; networkEnabled: boolean;
}

/** The demo's `SOCIAL_NETWORKS_ENABLED`: the server's default (instagram, facebook, linkedin) plus nothing, so TikTok shows as not enabled, as it does live. */
const DEMO_ENABLED_NETWORKS: readonly string[] = ["instagram", "facebook", "linkedin"];

/** Idempotent, as the server's seed: one account per requested network for the client, `created` only when the demo gained it (a removed one comes back as
 *  the same row). A client that already has an account on the network (simulated, as every demo account is) is answered as it is. */
export function demoSeedSimulatedAccounts(
  client: { id: string; name: string }, networks: readonly DemoSimulatedNetwork[], now: Date = new Date(),
): DemoSeededAccount[] {
  const at = now.toISOString();
  return DEMO_SIMULATED_NETWORKS.filter((n) => networks.includes(n)).map((network) => {
    const live = store.accounts.find((a) => a.clientId === client.id && a.network === network);
    const enabled = DEMO_ENABLED_NETWORKS.includes(network);
    if (live) return { id: live.id, network, handle: live.handle, simulated: true as const, created: false, networkEnabled: enabled };
    const back = store.removed.findIndex((a) => a.clientId === client.id && a.network === network);
    const account = back >= 0 ? { ...store.removed.splice(back, 1)[0], status: "connected" as const, healthCheckedAt: at, connectedAt: at } : simulatedAccount(client.id, client.name, network, at);
    store.accounts.push(account);
    return { id: account.id, network, handle: account.handle, simulated: true as const, created: true, networkEnabled: enabled };
  });
}

/** The teardown: removes the client's simulated accounts on `networks`. `inUse` is the caller's answer to "does a variant reference this account" (the demo's
 *  posts and variants live in `demoSocial.ts`): any in use refuses the whole call, as the server does. */
export function demoRemoveSimulatedAccounts(
  clientId: string, networks: readonly DemoSimulatedNetwork[], inUse: (accountId: string) => boolean,
): { ok: true; removed: Array<{ id: string; network: string; handle: string }> } | { ok: false; accountIds: string[] } {
  const hit = store.accounts.filter((a) => a.clientId === clientId && a.simulated && (networks as readonly string[]).includes(a.network))
    .sort((x, y) => (x.network < y.network ? -1 : x.network > y.network ? 1 : x.id < y.id ? -1 : 1));
  const used = hit.filter((a) => inUse(a.id));
  if (used.length > 0) return { ok: false, accountIds: used.map((a) => a.id) };
  for (const a of hit) {
    store.accounts.splice(store.accounts.indexOf(a), 1);
    store.removed.push(a);
  }
  return { ok: true, removed: hit.map((a) => ({ id: a.id, network: a.network, handle: a.handle })) };
}
