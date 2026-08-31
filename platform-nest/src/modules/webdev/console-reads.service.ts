// WSK-23 — the ERP console's read model over WebDesk (design docs/blueprints/webdesk-design.md
// §08 "Console UX" / §09 "ERP integration points"). NEW FILE under `src/modules/webdev/` (the
// ticket's hard constraint forbids editing any EXISTING file here except `index.ts`, additively —
// this file is not that, it is new).
//
// ── WHAT THIS FILE DOES NOT DO, AND WHY (read before extending it) ────────────────────────────
// It does NOT perform its own outbound HTTP call. It reuses WSK-19's already-approved egress
// driver (`../webdev-contracts/contract-fetch-http.ts`'s `createWebdevControlHttpDriver` +
// `WebdevControlProvider.getContractBundle`) exactly as built — no new egress file, no new
// `fetch`-shaped identifier anywhere in this file (verified against BOTH egress-inventory
// scanners: `modules/webdev/egress-inventory.test.ts`, which enumerates this directory and would
// flag a new outbound call here, and `modules/webdev-contracts/egress-inventory.test.ts`, which
// this file never touches). This is the literal "reuse that client" instruction the ticket gave.
//
// ── THE REAL GAP THIS TICKET FOUND, STATED HONESTLY (see the ticket's own final report) ───────
// Zone B's control plane (WSK-21, `webdesk/api/src/control/**`) ships exactly THREE `GET` routes:
// `.../contract`, `.../jobs`, `.../jobs/:jobId`. There is NO live read endpoint for site/environment
// status, release history, or form submissions — every other control-plane route is a write
// command. So three of this file's four reads (site registry, releases, submissions) have no live
// upstream to proxy at all today; they are built directly over Zone A's own already-landed facts
// (`webdev_provisioned_sites` + `webdev_zoneb_event_log`, the WSK-12 bridge's idempotency ledger)
// and are HONESTLY marked `source: "facts"` / `stale: true` always, never dressed up as live. The
// ONE read with a genuine live upstream — the contract pin-vs-latest view, because WSK-19 already
// built `getContractBundle` — gets the full three-tier degrade (live -> short in-process cache ->
// last-known fact), which is what `getContractPinStatus` below implements and what this ticket's
// "kill the upstream" test exercises end-to-end.
//
// ── THE ENVELOPE EVERY READ SHARES (`DegradeMeta`) ──────────────────────────────────────────────
// `stale: false` happens exactly once in this whole file: a same-call-cycle successful live read.
// Everything else — cache, facts, or genuinely nothing on file — is `stale: true` with a `source`
// and `reason` a console can render honestly ("last known N minutes/hours ago", "WebDesk hasn't
// told us about this site yet") instead of the recurring bug class this program keeps naming:
// rendering an empty/default state with the same confidence as a real answer (see root CLAUDE.md /
// MEMORY.md "An empty list is a CLAIM").
//
// ── PAYLOAD FIELD-MATCHING IS BEST-EFFORT, FLAGGED, NOT FROZEN ──────────────────────────────────
// `webdev_zoneb_event_log.kind` is CHECK-enumerated (202608261440's own header) but only
// `form.received`'s `data` shape has a real validator (`zoneb-event-schema.ts`) — WSK-10 is the
// only DEV-VERIFIED emitter. `deploy.done` / `promote.done` / `rollback.done` / `contract.published`
// have NO emitter yet (WSK-25/26/29/WSK-15+contract-publish are the future writers) and therefore
// no frozen field-name contract for their `data` object. `factSiteSlug`/`factContractVersion` below
// try several plausible key names defensively and are explicitly NOT asserted against a real
// emitter in this ticket's tests (there is nothing real to assert against yet) — only against
// synthetic rows this ticket inserts itself. Flagged as a follow-up: pin the real field names the
// day the first real emitter for each of those four kinds lands, the same way `form.received`'s
// shape got pinned.
import type { PoolClient } from "pg";
import { withTenants } from "../../db";
import { listProvisionedSites, type SiteDto } from "./provisioning.service";
import {
  listContractSnapshots,
  type SnapshotDto,
} from "../webdev-contracts/contract-snapshot.service";
import { createWebdevControlHttpDriver } from "../webdev-contracts/contract-fetch-http";
import {
  ContractControlNotConfiguredError,
  type ContractBundleMeta,
  type WebdevControlProvider,
} from "../webdev-contracts/contract-fetch-provider";

/** Every access to `webdev_zoneb_event_log`/`webdev_provisioned_sites` declares
 *  `{modules:['webdev']}` — both tables carry the THIRD WALL (their own migration headers); a plain
 *  `withTenants()` call would read ZERO ROWS silently, the WD-23A-1 regression class every sibling
 *  service in this module family guards against identically. */
function withWebdev<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTenants([tenantId], fn, { modules: ["webdev"] });
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : String(v));

// ── Shared degrade envelope ─────────────────────────────────────────────────────────────────────

export type DegradeSource = "live" | "cache" | "facts" | "unavailable";

export interface DegradeMeta {
  /** false exactly once: a live read that succeeded in THIS call. Everything else is true. */
  stale: boolean;
  source: DegradeSource;
  /** ISO timestamp the DATA is current as of — a live read's "now", a cache entry's fetch time, or
   *  a fact row's `received_at`. `null` only when `source` is "unavailable" (nothing on file at all
   *  — an honest "we don't know", never rendered the same as an empty confirmed list). */
  asOf: string | null;
  reason: string;
}

// ── Facts helper (shared by every fact-derived read below) ─────────────────────────────────────

interface FactRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  received_at: Date | string;
}

async function recentFacts(tenantId: string, kinds: readonly string[], limit = 500): Promise<FactRow[]> {
  return withWebdev(tenantId, async (c) => {
    const r = await c.query<FactRow>(
      `SELECT id, kind, payload, received_at FROM webdev_zoneb_event_log
        WHERE kind = ANY($1) ORDER BY received_at DESC LIMIT $2`,
      [kinds as string[], limit],
    );
    return r.rows;
  });
}

function factSiteSlug(payload: Record<string, unknown>): string | null {
  const v = payload.siteSlug ?? payload.slug ?? payload.webdeskTenantSlug ?? payload.tenantSlug;
  return typeof v === "string" && v.length > 0 ? v : null;
}

// ── Site registry (design §08 "Registry: per-tenant site list") ────────────────────────────────

const RELEASE_KINDS = ["deploy.done", "promote.done", "rollback.done"] as const;
type ReleaseKind = (typeof RELEASE_KINDS)[number];

export interface SiteFactSummary {
  kind: ReleaseKind;
  receivedAt: string;
  data: Record<string, unknown>;
}

export interface SiteConsoleRow extends SiteDto {
  lastKnownDeployment: SiteFactSummary | null;
  lastKnownPromotion: SiteFactSummary | null;
  lastKnownRollback: SiteFactSummary | null;
}

export interface SiteRegistryResult {
  sites: SiteConsoleRow[];
  meta: DegradeMeta;
}

/** §08's registry row, reusing `listProvisionedSites` verbatim (no duplicated SQL) and attaching
 *  each site's latest known deploy/promote/rollback FACT. Always `source: "facts"` (or
 *  "unavailable" for a brand-new tenant with none) — see this file's header: Zone B has no live
 *  environment-status read endpoint to proxy yet, so there is nothing to attempt and degrade FROM.
 *  Marking this "live" would be the fabrication the ticket exists to prevent. */
export async function getSiteRegistry(tenantId: string): Promise<SiteRegistryResult> {
  const [sites, facts] = await Promise.all([
    listProvisionedSites(tenantId),
    recentFacts(tenantId, RELEASE_KINDS, 500),
  ]);

  const bySlug = new Map<string, FactRow[]>();
  for (const f of facts) {
    const slug = factSiteSlug(f.payload);
    if (!slug) continue;
    const list = bySlug.get(slug);
    if (list) list.push(f);
    else bySlug.set(slug, [f]);
  }
  // `facts` arrives newest-first (the query's own ORDER BY); each per-slug list preserves that
  // relative order, so `.find` below returns the LATEST row of a given kind, not an arbitrary one.
  const latestOfKind = (list: FactRow[] | undefined, kind: ReleaseKind): SiteFactSummary | null => {
    const row = list?.find((f) => f.kind === kind);
    return row ? { kind, receivedAt: iso(row.received_at), data: row.payload } : null;
  };

  const rows: SiteConsoleRow[] = sites.map((s) => {
    const list = bySlug.get(s.slug);
    return {
      ...s,
      lastKnownDeployment: latestOfKind(list, "deploy.done"),
      lastKnownPromotion: latestOfKind(list, "promote.done"),
      lastKnownRollback: latestOfKind(list, "rollback.done"),
    };
  });

  const mostRecent = facts[0] ? iso(facts[0].received_at) : null;
  return {
    sites: rows,
    meta: {
      stale: true,
      source: mostRecent ? "facts" : "unavailable",
      asOf: mostRecent,
      reason: "zone_b_has_no_live_environment_status_read_endpoint_yet",
    },
  };
}

// ── Release history (design §08 "Releases: version history per env") ───────────────────────────

export interface ReleaseFact {
  kind: ReleaseKind;
  receivedAt: string;
  data: Record<string, unknown>;
}

export interface ReleaseHistoryResult {
  releases: ReleaseFact[];
  meta: DegradeMeta;
}

export async function getReleaseHistory(tenantId: string, slug: string): Promise<ReleaseHistoryResult> {
  const facts = await recentFacts(tenantId, RELEASE_KINDS, 500);
  const releases: ReleaseFact[] = facts
    .filter((f) => factSiteSlug(f.payload) === slug)
    .map((f) => ({ kind: f.kind as ReleaseKind, receivedAt: iso(f.received_at), data: f.payload }));

  return {
    releases,
    meta: {
      stale: true,
      source: releases.length ? "facts" : "unavailable",
      asOf: releases[0]?.receivedAt ?? null,
      reason: "zone_b_has_no_live_release_read_endpoint_yet",
    },
  };
}

// ── Submissions (design §08 "Submissions: per-form recent submissions; PII-aware") ─────────────
//
// The PII-aware promise is structural, not a filter this code applies: Zone A NEVER receives
// submission content over the WSK-12 bridge — `validateFormReceivedData` (zoneb-event-schema.ts)
// admits only `siteSlug`/`formId`/`submissionId`/`hasAttachments`. There is no name/email/phone/
// message column anywhere in `webdev_zoneb_event_log` to accidentally leak; the slim projection IS
// the whole payload.

export interface SubmissionFact {
  submissionId: string;
  formId: string;
  hasAttachments: boolean;
  receivedAt: string;
}

export interface SubmissionsResult {
  submissions: SubmissionFact[];
  meta: DegradeMeta;
}

export async function getSubmissions(tenantId: string, slug: string, formId?: string): Promise<SubmissionsResult> {
  const facts = await recentFacts(tenantId, ["form.received"], 500);
  const submissions: SubmissionFact[] = [];
  for (const f of facts) {
    const p = f.payload;
    if (factSiteSlug(p) !== slug) continue;
    const fId = typeof p.formId === "string" ? p.formId : null;
    const subId = typeof p.submissionId === "string" ? p.submissionId : null;
    if (!fId || !subId) continue;
    if (formId && fId !== formId) continue;
    submissions.push({ submissionId: subId, formId: fId, hasAttachments: p.hasAttachments === true, receivedAt: iso(f.received_at) });
  }

  return {
    submissions,
    meta: {
      stale: true,
      source: submissions.length ? "facts" : "unavailable",
      asOf: submissions[0]?.receivedAt ?? null,
      reason: "slim_pii_free_projection_from_zoneb_event_log_only",
    },
  };
}

// ── Contract pin-vs-latest (design §08 "Contract card": pinned vs latest published) ────────────
//
// THE ONE READ IN THIS FILE WITH A GENUINE LIVE UPSTREAM: WSK-19's `getContractBundle` already
// exists and already answers "what is the latest published contract for this Zone B tenant slug".
// This is the three-tier degrade the ticket asks to be proven with a test that kills the upstream:
//   1. live  — call `provider.getContractBundle(slug)` now. Success -> cache it, return fresh.
//   2. cache — the live call THREW (not configured, or a real `WebdevControlEgressError`). A
//      short-TTL in-process cache entry from an earlier successful call is still fresh -> serve it,
//      marked stale.
//   3. facts — no live source AND no fresh cache. Fall back to the last `contract.published` fact
//      this tenant's WSK-12 bridge ever recorded for this slug (if any) -> serve it, marked stale.
//   4. unavailable — none of the above. Return an explicit "we do not know", never a fabricated
//      version and never silently indistinguishable from "no news is good news".
//
// "pinned" (Zone A's OWN already-fetched, immutable snapshot row — WSK-19) never degrades: it is a
// plain DB read of data this tenant already committed, not a proxy of anything that can go stale in
// the way "latest" can.

interface LiveCacheEntry {
  meta: ContractBundleMeta;
  at: number;
}

/** Short in-process cache — deliberately NOT Redis/DB-backed (scope item 2's own wording: "a short
 *  in-process cache"). Same single-process-state tradeoff the PROGRESS tracker already flags for
 *  WSK-05's read quota and WSK-11's worker — correct for one replica, under-enforces at N>1, not
 *  reinvented here as something stronger than the ticket asked for. */
const liveCache = new Map<string, LiveCacheEntry>();
/** A local, narrow env knob — NOT added to `config.ts`'s shared namespace on purpose. This is the
 *  only file that reads it, and `config.ts` is one of this program's most contested shared files
 *  this session; a value nothing else needs does not belong there. */
const CONSOLE_CACHE_TTL_MS = Number(process.env.WEBDEV_CONSOLE_CACHE_TTL_MS ?? 60_000);

let providerOverride: WebdevControlProvider | null = null;
/** Test seam, matching `ContractSnapshotsController`'s own `setWebdevControlProviderForTests`
 *  precedent exactly (same directory family, same shape) — never set in production. */
export function setConsoleControlProviderForTests(p: WebdevControlProvider | null): void {
  providerOverride = p;
}

/** Unlike `ContractSnapshotsController.resolveProvider()`, an unconfigured control channel is NOT
 *  an error here — it is simply "no live source available right now", which this whole file's job
 *  is to degrade from gracefully. Returns `null` instead of throwing. */
function resolveConsoleProvider(): WebdevControlProvider | null {
  if (providerOverride) return providerOverride;
  try {
    return createWebdevControlHttpDriver();
  } catch (err) {
    if (err instanceof ContractControlNotConfiguredError) return null;
    throw err;
  }
}

export interface ContractPinStatus {
  webdeskTenantSlug: string;
  pinned: {
    snapshotId: string;
    contractVersion: string;
    vocabularyVersion: string;
    contentHash: string;
    fetchedAt: string;
  } | null;
  latest: { version: string | null; vocabularyVersion: string | null } & DegradeMeta;
}

async function latestPublishedFact(
  tenantId: string,
  slug: string,
): Promise<{ version: string | null; vocabularyVersion: string | null; receivedAt: string } | null> {
  const facts = await recentFacts(tenantId, ["contract.published"], 500);
  for (const f of facts) {
    if (factSiteSlug(f.payload) !== slug) continue;
    const p = f.payload;
    const version = typeof p.contractVersion === "string" ? p.contractVersion : (typeof p.version === "string" ? p.version : null);
    const vocabularyVersion = typeof p.vocabularyVersion === "string" ? p.vocabularyVersion : null;
    return { version, vocabularyVersion, receivedAt: iso(f.received_at) };
  }
  return null;
}

function snapshotToPinned(row: SnapshotDto): ContractPinStatus["pinned"] {
  return {
    snapshotId: row.id,
    contractVersion: row.contractVersion,
    vocabularyVersion: row.vocabularyVersion,
    contentHash: row.contentHash,
    fetchedAt: row.fetchedAt,
  };
}

export async function getContractPinStatus(tenantId: string, slug: string): Promise<ContractPinStatus> {
  const pinnedRows = await listContractSnapshots(tenantId, slug); // newest-first (the service's own ORDER BY)
  const pinned = pinnedRows[0] ? snapshotToPinned(pinnedRows[0]) : null;

  const cacheKey = `${tenantId}:${slug}`;
  const provider = resolveConsoleProvider();
  const notConfiguredReason = provider ? "control_channel_egress_error" : "control_channel_not_configured";

  if (provider) {
    try {
      const meta = await provider.getContractBundle(slug);
      liveCache.set(cacheKey, { meta, at: Date.now() });
      return {
        webdeskTenantSlug: slug,
        pinned,
        latest: {
          version: meta.version,
          vocabularyVersion: meta.vocabularyVersion,
          stale: false,
          source: "live",
          asOf: new Date().toISOString(),
          reason: "live_control_channel_read",
        },
      };
    } catch {
      // TIER 1 FAILED. Fall through to cache, then facts — never a 500, never a fabricated answer.
    }
  }

  const cached = liveCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= CONSOLE_CACHE_TTL_MS) {
    return {
      webdeskTenantSlug: slug,
      pinned,
      latest: {
        version: cached.meta.version,
        vocabularyVersion: cached.meta.vocabularyVersion,
        stale: true,
        source: "cache",
        asOf: new Date(cached.at).toISOString(),
        reason: notConfiguredReason,
      },
    };
  }

  const fact = await latestPublishedFact(tenantId, slug);
  if (fact) {
    return {
      webdeskTenantSlug: slug,
      pinned,
      latest: {
        version: fact.version,
        vocabularyVersion: fact.vocabularyVersion,
        stale: true,
        source: "facts",
        asOf: fact.receivedAt,
        reason: notConfiguredReason,
      },
    };
  }

  return {
    webdeskTenantSlug: slug,
    pinned,
    latest: { version: null, vocabularyVersion: null, stale: true, source: "unavailable", asOf: null, reason: notConfiguredReason },
  };
}

/** `?slug=` given -> single-element array. Omitted -> every Zone B tenant slug this ERP tenant has
 *  EVER fetched a snapshot for (`webdev_contract_snapshots` is the only place that set is truly
 *  known; `webdev_provisioned_sites.slug` is a DIFFERENT namespace — the provision seam's own
 *  project slug, not a Zone B tenant slug, and no `provider:'webdesk'` row exists yet — see this
 *  file's header). A tenant with no snapshot ever fetched gets an empty array, honestly: there is
 *  nothing to report a pin status FOR, which is different from "we don't know" about a slug that
 *  IS known. */
export async function listContractPinStatuses(tenantId: string, slug?: string): Promise<ContractPinStatus[]> {
  if (slug) return [await getContractPinStatus(tenantId, slug)];
  const all = await listContractSnapshots(tenantId);
  const slugs = Array.from(new Set(all.map((r) => r.webdeskTenantSlug)));
  return Promise.all(slugs.map((s) => getContractPinStatus(tenantId, s)));
}
