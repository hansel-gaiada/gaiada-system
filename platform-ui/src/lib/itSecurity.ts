import "server-only";
// DW-7h (docs/FRONTEND-BFF-CONTRACT.md §52.6): the readers behind IT > Network, the ERP side of IT's security work.
//   GET /api/:t/it/security/connections?window=   -> { asOf, window, connections }
//   GET /api/:t/it/security/sign-ins?window=      -> { asOf, window, state, reason?, events, summary, unknownAccounts }
//   GET /api/:t/it/security/alerts?window=        -> { asOf, window, signIns, alerts }
//   GET /api/:t/it/security/blocks                -> { ipBlocks, revokedSessions }
// All four are `it_account` `read` (PERMISSION-CONTRACT §42), the same people who run logins in IT accounts.
//
// ── A 200 IN THE WRONG SHAPE IS "UNAVAILABLE", NEVER AN EMPTY LIST ──────────────────────────────────────────────
// Every one of these claims something about security: "nobody is connected", "no failed sign-ins", "no address is blocked". The
// demo layer answers `[]` to any GET it has no fixture for, and a drifted backend could do the same; read as `{}` that would
// become four confident "nothing here" pages. Each reader checks what the page relies on and throws inside `readResult`, so a
// wrong shape renders as "cannot be read right now" (the pattern of `finance-data.ts` `listTaxReturnsResult`).
//
// The sign-ins answer is three-state on purpose: `on` (events were read), `off` (the realm records none) and `unavailable`
// (the read failed or the role is missing). The last two are carried as states, not as empty lists.
import { platformFetch } from "./platform";
import { readResult, type ReadResult } from "./readResult";

/** The windows the routes accept. Sign-ins take only the last two; anything else is a 400. */
export type SecurityWindow = "15m" | "24h" | "7d";
export type SignInWindow = "24h" | "7d";

export type DeviceKind = "desktop" | "mobile" | "tablet" | "unknown";

/** A person as the security routes name one. */
export interface Who { userId: string; displayName: string; email: string }
/** Who did something (created a block, ended a session): no address. */
export interface Actor { userId: string; displayName: string }

export interface Connection {
  who: Who;
  // the session: `sessionId` is the token's `sid`, or '' when it carries none
  sessionId: string;
  ip: string | null;
  userAgent: string | null;
  /** Parsed from the user agent on the server: the browser has no version ("Chrome", "Safari", "Edge", ... or "Unknown"). */
  device: { browser: string; os: string; kind: DeviceKind };
  firstSeenAt: string;
  lastSeenAt: string;
  requestCount: number;
  /** The session or the login is cut (§52.4). */
  revoked: boolean;
  /** The address has an active block. */
  ipBlocked: boolean;
}

export interface ConnectionsAnswer {
  asOf: string;
  window: SecurityWindow;
  connections: Connection[];
}

export type SignInEventType = "sign_in" | "failed" | "sign_out";

export interface SignInEvent {
  at: string;
  type: SignInEventType;
  userId: string | null;
  email: string | null;
  ip: string | null;
  error: string | null;
}

export interface SignInSummary {
  signIns: number;
  failed: number;
  failedByAccount: { userId: string; email: string | null; count: number }[];
  failedByIp: { ip: string | null; count: number }[];
}

/** `on`: the events were read. `off` and `unavailable` carry no counts: the server sends them with `events: []` and an all-zero
 *  summary, and the reader drops both, so a zero can never be drawn from a record that was not read. */
export type SignInsAnswer =
  | {
    asOf: string; window: SignInWindow; state: "on";
    events: SignInEvent[]; summary: SignInSummary;
    /** Failed sign-ins whose username matches no ERP user (the usernames are not given). */
    unknownAccounts: { failed: number };
  }
  | { asOf: string; window: SignInWindow; state: "off" | "unavailable"; reason?: string };

export type AlertKind = "failed_signins_account" | "failed_signins_ip" | "new_device" | "blocked_ip_hits";
export type AlertSeverity = "high" | "medium" | "low";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  at: string;
  subject: { userId?: string; email?: string; ip?: string };
  detail: string;
  count: number;
}

export interface AlertsAnswer {
  asOf: string;
  window: SecurityWindow;
  /** Whether the two sign-in rules could run. When not `on`, the alerts below are only the rules that did. */
  signIns: "on" | "off" | "unavailable";
  /** A sentence for IT, with `unavailable`. */
  reason?: string;
  alerts: Alert[];
}

// As built (BFF §52, 7h-2). The list puts active blocks first, then those ended in the last 30 days.
export interface IpBlock {
  id: string;
  ip: string;
  reason: string;
  /** Not lifted and not yet expired, as the server judges it. */
  active: boolean;
  createdAt: string;
  createdBy: Actor;
  expiresAt: string;
  liftedAt: string | null;
  liftedBy: Actor | null;
  hitCount: number;
  lastHitAt: string | null;
}

export interface Revocation {
  id: string;
  who: Who;
  /** Null: every session of the person issued before `revokedAt` ("Block login"). */
  sessionId: string | null;
  reason: string | null;
  revokedAt: string;
  revokedBy: Actor | null;
  expiresAt: string;
}

export interface BlocksAnswer {
  ipBlocks: IpBlock[];
  revokedSessions: Revocation[];
}

// ── Shape checks ───────────────────────────────────────────────────────────────────────────────────────────────

const bad = () => new Error("The security read returned an unexpected answer.");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const KINDS: readonly string[] = ["desktop", "mobile", "tablet", "unknown"];
const SIGN_IN_TYPES: readonly string[] = ["sign_in", "failed", "sign_out"];
const SEVERITIES: readonly string[] = ["high", "medium", "low"];
const WINDOWS: readonly string[] = ["15m", "24h", "7d"];

const toWho = (w: unknown): Who => {
  if (!isObj(w) || !isStr(w.userId) || !isStr(w.displayName) || !isStr(w.email)) throw bad();
  return { userId: w.userId, displayName: w.displayName, email: w.email };
};
const toActor = (w: unknown): Actor => {
  if (!isObj(w) || !isStr(w.userId) || !isStr(w.displayName)) throw bad();
  return { userId: w.userId, displayName: w.displayName };
};

function toConnection(raw: unknown): Connection {
  if (!isObj(raw)) throw bad();
  const { device } = raw;
  if (
    !isStr(raw.sessionId) || !strOrNull(raw.ip) || !strOrNull(raw.userAgent ?? null) ||
    !isObj(device) || !isStr(device.browser) || !isStr(device.os) || !isStr(device.kind) || !KINDS.includes(device.kind) ||
    !isStr(raw.firstSeenAt) || !isStr(raw.lastSeenAt) || !isNum(raw.requestCount) ||
    typeof raw.revoked !== "boolean" || typeof raw.ipBlocked !== "boolean"
  ) throw bad();
  return {
    who: toWho(raw.who),
    sessionId: raw.sessionId, ip: raw.ip, userAgent: (raw.userAgent as string | null | undefined) ?? null,
    device: { browser: device.browser, os: device.os, kind: device.kind as DeviceKind },
    firstSeenAt: raw.firstSeenAt, lastSeenAt: raw.lastSeenAt, requestCount: raw.requestCount,
    revoked: raw.revoked, ipBlocked: raw.ipBlocked,
  };
}

function toConnections(d: unknown): ConnectionsAnswer {
  if (!isObj(d) || !isStr(d.asOf) || !isStr(d.window) || !WINDOWS.includes(d.window) || !Array.isArray(d.connections)) throw bad();
  return { asOf: d.asOf, window: d.window as SecurityWindow, connections: d.connections.map(toConnection) };
}

function toEvent(raw: unknown): SignInEvent {
  if (!isObj(raw) || !isStr(raw.at) || !isStr(raw.type) || !SIGN_IN_TYPES.includes(raw.type)) throw bad();
  if (!strOrNull(raw.userId ?? null) || !strOrNull(raw.email ?? null) || !strOrNull(raw.ip ?? null) || !strOrNull(raw.error ?? null)) throw bad();
  return {
    at: raw.at, type: raw.type as SignInEventType,
    userId: (raw.userId as string | null | undefined) ?? null, email: (raw.email as string | null | undefined) ?? null,
    ip: (raw.ip as string | null | undefined) ?? null, error: (raw.error as string | null | undefined) ?? null,
  };
}

function toSummary(raw: unknown): SignInSummary {
  if (!isObj(raw) || !isNum(raw.signIns) || !isNum(raw.failed) || !Array.isArray(raw.failedByAccount) || !Array.isArray(raw.failedByIp)) throw bad();
  return {
    signIns: raw.signIns, failed: raw.failed,
    failedByAccount: raw.failedByAccount.map((a) => {
      if (!isObj(a) || !isStr(a.userId) || !isNum(a.count) || !strOrNull(a.email ?? null)) throw bad();
      return { userId: a.userId, email: (a.email as string | null | undefined) ?? null, count: a.count };
    }),
    failedByIp: raw.failedByIp.map((a) => {
      if (!isObj(a) || !isNum(a.count) || !strOrNull(a.ip ?? null)) throw bad();
      return { ip: (a.ip as string | null | undefined) ?? null, count: a.count };
    }),
  };
}

function toSignIns(d: unknown): SignInsAnswer {
  if (!isObj(d) || !isStr(d.asOf) || (d.window !== "24h" && d.window !== "7d")) throw bad();
  const base = { asOf: d.asOf, window: d.window as SignInWindow };
  if (d.state === "off" || d.state === "unavailable") {
    return { ...base, state: d.state, ...(isStr(d.reason) && d.reason ? { reason: d.reason } : {}) };
  }
  if (d.state !== "on" || !Array.isArray(d.events)) throw bad();
  const unknown = d.unknownAccounts;
  if (!isObj(unknown) || !isNum(unknown.failed)) throw bad();
  return { ...base, state: "on", events: d.events.map(toEvent), summary: toSummary(d.summary), unknownAccounts: { failed: unknown.failed } };
}

function toAlert(raw: unknown): Alert {
  if (!isObj(raw) || !isStr(raw.kind) || !isStr(raw.severity) || !SEVERITIES.includes(raw.severity)) throw bad();
  if (!isStr(raw.at) || !isStr(raw.detail) || !isNum(raw.count) || !isObj(raw.subject)) throw bad();
  const { userId, email, ip } = raw.subject;
  const subject: Alert["subject"] = {};
  if (isStr(userId)) subject.userId = userId;
  if (isStr(email)) subject.email = email;
  if (isStr(ip)) subject.ip = ip;
  return { kind: raw.kind as AlertKind, severity: raw.severity as AlertSeverity, at: raw.at, subject, detail: raw.detail, count: raw.count };
}

function toAlerts(d: unknown): AlertsAnswer {
  if (
    !isObj(d) || !isStr(d.asOf) || !isStr(d.window) || !WINDOWS.includes(d.window) ||
    (d.signIns !== "on" && d.signIns !== "off" && d.signIns !== "unavailable") || !Array.isArray(d.alerts)
  ) throw bad();
  return {
    asOf: d.asOf, window: d.window as SecurityWindow, signIns: d.signIns, alerts: d.alerts.map(toAlert),
    ...(isStr(d.reason) && d.reason ? { reason: d.reason } : {}),
  };
}

function toBlock(raw: unknown): IpBlock {
  if (
    !isObj(raw) || !isStr(raw.id) || !isStr(raw.ip) || !isStr(raw.reason) || typeof raw.active !== "boolean" ||
    !isStr(raw.createdAt) || !isStr(raw.expiresAt) || !strOrNull(raw.liftedAt ?? null) || !isNum(raw.hitCount) || !strOrNull(raw.lastHitAt ?? null)
  ) throw bad();
  return {
    id: raw.id, ip: raw.ip, reason: raw.reason, active: raw.active, createdAt: raw.createdAt, createdBy: toActor(raw.createdBy),
    expiresAt: raw.expiresAt, liftedAt: (raw.liftedAt as string | null | undefined) ?? null,
    liftedBy: raw.liftedBy == null ? null : toActor(raw.liftedBy),
    hitCount: raw.hitCount, lastHitAt: (raw.lastHitAt as string | null | undefined) ?? null,
  };
}

function toRevocation(raw: unknown): Revocation {
  if (!isObj(raw) || !isStr(raw.id) || !strOrNull(raw.sessionId ?? null) || !strOrNull(raw.reason ?? null) || !isStr(raw.revokedAt) || !isStr(raw.expiresAt)) throw bad();
  return {
    id: raw.id, who: toWho(raw.who), sessionId: (raw.sessionId as string | null | undefined) ?? null,
    reason: (raw.reason as string | null | undefined) ?? null, revokedAt: raw.revokedAt,
    revokedBy: raw.revokedBy == null ? null : toActor(raw.revokedBy), expiresAt: raw.expiresAt,
  };
}

function toBlocks(d: unknown): BlocksAnswer {
  if (!isObj(d) || !Array.isArray(d.ipBlocks) || !Array.isArray(d.revokedSessions)) throw bad();
  return { ipBlocks: d.ipBlocks.map(toBlock), revokedSessions: d.revokedSessions.map(toRevocation) };
}

// ── Readers ────────────────────────────────────────────────────────────────────────────────────────────────────

const base = (t: string) => `/api/${t}/it/security`;

/** Who is connected: newest `lastSeenAt` first, at most 500. */
export const listConnectionsResult = (u: string, t: string, window: SecurityWindow = "24h"): Promise<ReadResult<ConnectionsAnswer>> =>
  readResult(platformFetch<unknown>(`${base(t)}/connections?window=${window}`, u).then(toConnections));

/** Every sign-in, failed sign-in and sign-out of this company's members, from Keycloak's events. */
export const listSignInsResult = (u: string, t: string, window: SignInWindow = "24h"): Promise<ReadResult<SignInsAnswer>> =>
  readResult(platformFetch<unknown>(`${base(t)}/sign-ins?window=${window}`, u).then(toSignIns));

/** Alerts computed on read, newest first. */
export const listAlertsResult = (u: string, t: string, window: SecurityWindow = "24h"): Promise<ReadResult<AlertsAnswer>> =>
  readResult(platformFetch<unknown>(`${base(t)}/alerts?window=${window}`, u).then(toAlerts));

/** The company's address blocks (active first, then the last 30 days) and the sessions its IT ended in the last 7 days. */
export const listBlocksResult = (u: string, t: string): Promise<ReadResult<BlocksAnswer>> =>
  readResult(platformFetch<unknown>(`${base(t)}/blocks`, u).then(toBlocks));
