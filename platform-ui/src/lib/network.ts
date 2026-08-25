import "server-only";
// Network security console data layer — traffic rollups, IDS/IPS threats, isolation state and
// WiFi presence. Frontend-first, exactly like lib/it.ts: the backend endpoints do NOT exist yet, so
// every reader DEGRADES on 404/403 and then falls back to a LABELLED fixture set so the pages can
// be visualized before the collector is built.
//
// The fixture fallback is the one risky thing in this file, and it is the lesson of the IT module's
// own history: 8 seeded fictional devices at "Bali Office" on a 10.0.x.x range that does not exist
// shipped to a live tenant and read as a bug for months. So EVERY reader returns a `source`
// discriminator and the pages render a loud banner on `"fixture"`. Fixture data must never be
// silently indistinguishable from a real feed.
//
// BFF CONTRACT (implement in platform-nest to match — design doc
// docs/superpowers/specs/2026-08-25-network-security-console-design.md §5):
//   GET  /api/:t/it/network/traffic?hours=   -> TrafficResponse
//   GET  /api/:t/it/network/threats?state=   -> ThreatsResponse
//   GET  /api/:t/it/network/rules            -> IsolationResponse
//   POST /api/:t/it/network/isolate  {..}    -> { approvalId }   (Phase 4 — files a D14 approval)
//   GET  /api/:t/it/network/presence         -> PresenceResponse
import { platformFetch, PlatformError } from "./platform";
import { NETWORK_FIXTURES } from "./demoNetwork";

/** Where the rendered numbers actually came from. `"fixture"` MUST surface in the UI. */
export type FeedSource = "live" | "fixture";

// ---- Feed health ----------------------------------------------------------
/** One collector run. Mirrors `DiscoveryRun` in lib/it.ts — same "a dead feed and an empty network
 *  must not render identically" reasoning, applied to the traffic/threat feeds. */
export interface FeedRun {
  startedAt: string | null;
  finishedAt: string | null;
  ok: boolean;
  error: string | null;
}

// ---- Traffic --------------------------------------------------------------
/** An hourly per-client per-destination rollup. Deliberately NOT a flow record: the collector
 *  aggregates before shipping (design N3) so the ERP never becomes a SIEM by accident. */
export interface TrafficRollup {
  deviceId: string | null;
  deviceName: string;
  /** Null for a device the registry has never seen — an unregistered host that is nonetheless
   *  moving traffic, which is more interesting than a known one, not less. */
  ip: string | null;
  destAsn: string | null;
  destCountry: string | null;
  app: string | null;
  bytesIn: number;
  bytesOut: number;
  sessions: number;
}
export interface TrafficResponse {
  source: FeedSource;
  windowHours: number;
  rollups: TrafficRollup[];
  lastRun: FeedRun | null;
}

// ---- Threats --------------------------------------------------------------
export type ThreatSeverity = "critical" | "high" | "medium" | "low";
export const THREAT_SEVERITIES: ThreatSeverity[] = ["critical", "high", "medium", "low"];
/** What the gateway ACTUALLY did. `detected` vs `blocked` is the IDS-vs-IPS distinction and it is
 *  the single most consequential word on the threats page — see design O7. */
export type ThreatAction = "blocked" | "detected";
export type TriageState = "new" | "investigating" | "resolved" | "false_positive";

export interface NetworkThreat {
  id: string;
  occurredAt: string;
  severity: ThreatSeverity;
  signature: string;
  srcIp: string;
  dstIp: string;
  /** Which side of the perimeter the offending host is on. Drives whether isolation is even a
   *  possible response: you cannot isolate a host you do not control. */
  direction: "inbound" | "outbound" | "internal";
  deviceId: string | null;
  deviceName: string | null;
  action: ThreatAction;
  triageState: TriageState;
}
export interface ThreatsResponse {
  source: FeedSource;
  threats: NetworkThreat[];
  lastRun: FeedRun | null;
}

// ---- Isolation / enforcement ---------------------------------------------
export type IsolationState = "active" | "expired" | "reverted" | "pending_approval";
export interface Isolation {
  id: string;
  deviceId: string | null;
  deviceName: string;
  ip: string | null;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  /** Null while the approval is still pending, or while the collector has not yet picked the action
   *  up. The gap between "approved" and "applied" is real and is up to one collector poll — the UI
   *  must never imply an isolation took effect the instant it was approved (design §5). */
  appliedAt: string | null;
  expiresAt: string | null;
  revertedAt: string | null;
  state: IsolationState;
}
export interface IsolationResponse {
  source: FeedSource;
  /** False until Phase 4 ships. The page renders read-only and says so rather than offering a
   *  button that would 404. */
  enforcementEnabled: boolean;
  isolations: Isolation[];
}

// ---- Presence -------------------------------------------------------------
/** Zone occupancy ONLY. No identity, no per-person tracks, no raw CSI — design N9. The shape is
 *  deliberately incapable of carrying a person: there is nowhere to put one. */
export interface PresenceZone {
  zoneId: string;
  name: string;
  occupancy: number;
  /** Sensor confidence 0..1. Presence sensing is probabilistic and presenting it as a hard count
   *  would overstate what CSI can actually tell you. */
  confidence: number;
  updatedAt: string | null;
  sensorOnline: boolean;
}
export interface PresenceResponse {
  source: FeedSource;
  /** False until the Phase 5 spike picks hardware. Everything below is illustrative until then. */
  hardwareDeployed: boolean;
  zones: PresenceZone[];
}

// Same absorb-404/403 helper as lib/it.ts — a missing endpoint and a disabled module both mean
// "render the fallback", not "crash the page".
async function skipUnavailable<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403 || e.status === 405)) return fallback;
    throw e;
  }
}

export const getTraffic = (u: string, t: string, hours = 24) =>
  skipUnavailable(
    platformFetch<TrafficResponse>(`/api/${t}/it/network/traffic?hours=${hours}`, u),
    NETWORK_FIXTURES.traffic,
  );

export const getThreats = (u: string, t: string) =>
  skipUnavailable(
    platformFetch<ThreatsResponse>(`/api/${t}/it/network/threats`, u),
    NETWORK_FIXTURES.threats,
  );

export const getIsolations = (u: string, t: string) =>
  skipUnavailable(
    platformFetch<IsolationResponse>(`/api/${t}/it/network/rules`, u),
    NETWORK_FIXTURES.isolations,
  );

export const getPresence = (u: string, t: string) =>
  skipUnavailable(
    platformFetch<PresenceResponse>(`/api/${t}/it/network/presence`, u),
    NETWORK_FIXTURES.presence,
  );

// ================= Pure helpers (unit-tested) =================

/**
 * Bytes → a short human string. Binary units (KiB steps) because this is network volume read by an
 * operator comparing hosts, where consistency between rows matters more than decimal correctness.
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export interface Talker {
  deviceName: string;
  ip: string | null;
  deviceId: string | null;
  bytesIn: number;
  bytesOut: number;
  total: number;
  sessions: number;
  destinations: number;
}

/**
 * Collapse rollups to one row per device, ranked by total volume.
 *
 * Ranks on IN+OUT rather than OUT alone. Exfiltration is an outbound story and it is tempting to
 * sort by `bytesOut`, but a compromised host pulling a payload is inbound-heavy, and a camera
 * streaming to a foreign host is outbound-heavy — sorting on one hides the other. The table shows
 * both columns so the operator, not the sort order, decides which shape is suspicious.
 */
export function topTalkers(rollups: TrafficRollup[], limit = 10): Talker[] {
  const by = new Map<string, Talker & { dests: Set<string> }>();
  for (const r of rollups) {
    const key = r.deviceId ?? r.ip ?? r.deviceName;
    const cur = by.get(key) ?? {
      deviceName: r.deviceName, ip: r.ip, deviceId: r.deviceId,
      bytesIn: 0, bytesOut: 0, total: 0, sessions: 0, destinations: 0,
      dests: new Set<string>(),
    };
    cur.bytesIn += r.bytesIn;
    cur.bytesOut += r.bytesOut;
    cur.sessions += r.sessions;
    if (r.destAsn) cur.dests.add(r.destAsn);
    by.set(key, cur);
  }
  return [...by.values()]
    .map(({ dests, ...t }) => ({ ...t, total: t.bytesIn + t.bytesOut, destinations: dests.size }))
    .sort((a, b) => b.total - a.total || a.deviceName.localeCompare(b.deviceName))
    .slice(0, limit);
}

export interface EgressRow { country: string; bytes: number; sessions: number; devices: number }
/** Where traffic actually leaves to, by destination country. The "what's out of our network" half
 *  of the ask — one unexpected country is worth more than a hundred rows of normal volume. */
export function egressByCountry(rollups: TrafficRollup[]): EgressRow[] {
  const by = new Map<string, { bytes: number; sessions: number; devices: Set<string> }>();
  for (const r of rollups) {
    const c = r.destCountry?.trim() || "Unknown";
    const cur = by.get(c) ?? { bytes: 0, sessions: 0, devices: new Set<string>() };
    cur.bytes += r.bytesIn + r.bytesOut;
    cur.sessions += r.sessions;
    cur.devices.add(r.deviceId ?? r.ip ?? r.deviceName);
    by.set(c, cur);
  }
  return [...by.entries()]
    .map(([country, v]) => ({ country, bytes: v.bytes, sessions: v.sessions, devices: v.devices.size }))
    .sort((a, b) => b.bytes - a.bytes || a.country.localeCompare(b.country));
}

export interface ThreatSummary {
  total: number;
  open: number;
  blocked: number;
  detected: number;
  bySeverity: Record<ThreatSeverity, number>;
}
/**
 * `open` counts `new` + `investigating`. A resolved or false-positive event is history, not a
 * workload, and rolling them into one "total threats" figure is how a console starts reporting a
 * number that only ever goes up and therefore means nothing.
 */
export function summarizeThreats(threats: NetworkThreat[]): ThreatSummary {
  const s: ThreatSummary = {
    total: 0, open: 0, blocked: 0, detected: 0,
    bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
  };
  for (const t of threats) {
    s.total += 1;
    if (t.triageState === "new" || t.triageState === "investigating") s.open += 1;
    if (t.action === "blocked") s.blocked += 1;
    else s.detected += 1;
    if (t.severity in s.bySeverity) s.bySeverity[t.severity] += 1;
  }
  return s;
}

/**
 * Is a feed stale? Identical contract to `isDiscoveryStale` in lib/it.ts, and identical reason for
 * existing: no run at all is stale BY DEFINITION, because "we have never heard from the collector"
 * and "the network is quiet" must not render the same way.
 */
export function isFeedStale(run: FeedRun | null, now: Date = new Date(), thresholdMs = 15 * 60 * 1000): boolean {
  if (!run || !run.ok) return true;
  const stamp = run.finishedAt ?? run.startedAt;
  if (!stamp) return true;
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return true;
  return now.getTime() - t > thresholdMs;
}

/** "4 min ago" / "just now" / "never". Mirrors describeLastSync in lib/it.ts. */
export function describeFeed(run: FeedRun | null, now: Date = new Date()): string {
  const stamp = run?.finishedAt ?? run?.startedAt;
  if (!stamp) return "never";
  const t = new Date(stamp).getTime();
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.floor(Math.max(0, now.getTime() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * How long until an isolation lapses, as an operator-facing string.
 *
 * Returns "expired" for a past timestamp rather than a negative duration — an isolation whose
 * window has closed is no longer protecting anything, and rendering "-14 min" invites the reader to
 * think it is still in force.
 */
export function describeExpiry(expiresAt: string | null, now: Date = new Date()): string {
  if (!expiresAt) return "no expiry";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "unknown";
  const mins = Math.floor((t - now.getTime()) / 60000);
  if (mins <= 0) return "expired";
  if (mins < 60) return `${mins} min left`;
  const hrs = Math.floor(mins / 60);
  return hrs < 24 ? `${hrs}h left` : `${Math.floor(hrs / 24)}d left`;
}

/**
 * Can this threat's host be isolated at all?
 *
 * Server-side authority for this lives in the D14 precondition (design N7) — this is the UI's
 * cheap mirror so the page does not offer an action that would be refused. The mirror is
 * deliberately CONSERVATIVE: it says no in every case the precondition might, and never says yes
 * where the precondition would say no. Getting that direction backwards is what produces a button
 * that fails at execution time, after an approver has already signed off.
 */
export function canProposeIsolation(t: NetworkThreat, protectedIps: string[] = []): boolean {
  // An inbound attacker is outside our network — there is nothing of ours to quarantine.
  if (t.direction === "inbound") return false;
  // No registry row means no stable UniFi client id to key the action on.
  if (!t.deviceId) return false;
  if (protectedIps.includes(t.srcIp)) return false;
  return t.triageState === "new" || t.triageState === "investigating";
}
