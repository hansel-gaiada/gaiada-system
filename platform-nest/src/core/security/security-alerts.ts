// DW-7h (FRONTEND-BFF-CONTRACT §52.6) — the four alert rules, as one PURE function. The route reads the sign-in events, the
// recorded connections and the active blocks, hands them here, and sends back what comes out; nothing here touches a
// database or Keycloak, so the thresholds and the edges are tested without either.
//
// The rules (the contract's table):
//   failed_signins_account  5+ failed sign-ins for ONE member's account within any 15 minutes            high
//   failed_signins_ip       10+ failed sign-ins from ONE address within any 15 minutes (members + unknown)  high
//   new_device              a member's first connection from an (address, device) pair, inside the window,
//                           when the member already had connections before the window                       medium
//   blocked_ip_hits         an active block of this company that stopped requests inside the window         low
//
// "Within any 15 minutes" is a SLIDING window, not a clock bucket: five failures at 10:14 and 10:16 would straddle a
// 10:15 bucket edge and read as two groups of fewer than five. The span is inclusive: the first and the last failure at
// most 15:00 apart count as one window (so exactly 15 minutes is an alert, 15:00.001 is not).
import { deviceKey, parseUserAgent } from "./user-agent";
import { WINDOW_MS, type SecurityWindow } from "./security-window";

export const FAILED_ACCOUNT_THRESHOLD = 5;
export const FAILED_IP_THRESHOLD = 10;
export const FAILED_SPAN_MS = 15 * 60_000;

export type AlertKind = "failed_signins_account" | "failed_signins_ip" | "new_device" | "blocked_ip_hits";
export type AlertSeverity = "high" | "medium" | "low";

export interface Alert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** ISO instant the alert is about: the last failure of the densest window, the first connection, the last blocked hit. */
  at: string;
  subject: { userId?: string; email?: string; ip?: string };
  detail: string;
  /** Failures in the densest window, 1 for a new device, the block's hit count for blocked hits. */
  count: number;
}

export interface FailedSignIn {
  atMs: number;
  /** Null when Keycloak did not record an address. Such an event can count for an account, never for an address. */
  ip: string | null;
  /** The member the account maps to; null for an UNKNOWN account (matches no ERP user). A user of another company never gets here. */
  userId: string | null;
  /** Set only with `userId`; an unknown account's typed name is never carried (it can be anything, a password included). */
  email: string | null;
}

export interface SeenConnection {
  userId: string;
  email: string | null;
  ip: string | null;
  userAgent: string | null;
  firstSeenAt: Date;
}

export interface ActiveBlockHits {
  ip: string;
  hitCount: number;
  lastHitAt: Date | null;
}

export interface AlertInput {
  now: Date;
  window: SecurityWindow;
  /** The two sign-in rules run only when this is "on". */
  signIns: "on" | "off" | "unavailable";
  failed: FailedSignIn[];
  /** Every recorded connection of the company's members (NOT only the window: the rule needs the history before it). */
  seen: SeenConnection[];
  /** This company's ACTIVE blocks. */
  blocks: ActiveBlockHits[];
}

/** The densest sliding window of `spanMs` over the times, when it holds at least `min`. Ties go to the LATEST window. */
export function densestWindow(times: number[], spanMs: number, min: number): { count: number; endMs: number } | null {
  const t = [...times].sort((a, b) => a - b);
  let best: { count: number; endMs: number } | null = null;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] > spanMs) lo++;
    const count = hi - lo + 1;
    if (count >= min && (!best || count >= best.count)) best = { count, endMs: t[hi] };
  }
  return best;
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

export function computeAlerts(input: AlertInput): Alert[] {
  const nowMs = input.now.getTime();
  const startMs = nowMs - WINDOW_MS[input.window];
  const alerts: Alert[] = [];

  if (input.signIns === "on") {
    const failed = input.failed.filter((f) => f.atMs >= startMs);

    for (const [userId, rows] of groupBy(failed, (f) => f.userId)) {
      const hit = densestWindow(rows.map((r) => r.atMs), FAILED_SPAN_MS, FAILED_ACCOUNT_THRESHOLD);
      if (!hit) continue;
      const email = rows.find((r) => r.email)?.email ?? undefined;
      alerts.push({
        kind: "failed_signins_account",
        severity: "high",
        at: new Date(hit.endMs).toISOString(),
        subject: { userId, ...(email ? { email } : {}) },
        detail: `${hit.count} failed sign-ins for ${email ?? "one account"} within 15 minutes`,
        count: hit.count,
      });
    }

    for (const [ip, rows] of groupBy(failed, (f) => f.ip)) {
      const hit = densestWindow(rows.map((r) => r.atMs), FAILED_SPAN_MS, FAILED_IP_THRESHOLD);
      if (!hit) continue;
      alerts.push({
        kind: "failed_signins_ip",
        severity: "high",
        at: new Date(hit.endMs).toISOString(),
        subject: { ip },
        detail: `${hit.count} failed sign-ins from ${ip} within 15 minutes`,
        count: hit.count,
      });
    }
  }

  // New device: a pair first seen inside the window, for a member who was already known before it. A member whose FIRST ever
  // connection is inside the window (a new hire, or the day recording began) has no "before", so nothing is new to them.
  for (const [userId, rows] of groupBy(input.seen, (s) => s.userId)) {
    if (!rows.some((r) => r.firstSeenAt.getTime() < startMs)) continue;
    const pairs = new Map<string, { ip: string; device: ReturnType<typeof parseUserAgent>; first: SeenConnection }>();
    for (const r of rows) {
      if (!r.ip) continue; // an unknown address cannot be an (address, device) pair
      const device = parseUserAgent(r.userAgent);
      const k = `${r.ip}\n${deviceKey(device)}`;
      const cur = pairs.get(k);
      if (!cur || r.firstSeenAt < cur.first.firstSeenAt) pairs.set(k, { ip: r.ip, device, first: r });
    }
    for (const p of pairs.values()) {
      const firstMs = p.first.firstSeenAt.getTime();
      if (firstMs < startMs || firstMs > nowMs) continue;
      const email = p.first.email ?? undefined;
      alerts.push({
        kind: "new_device",
        severity: "medium",
        at: p.first.firstSeenAt.toISOString(),
        subject: { userId, ...(email ? { email } : {}), ip: p.ip },
        detail: `First connection from ${p.ip} on ${p.device.browser} / ${p.device.os}`,
        count: 1,
      });
    }
  }

  // Blocked hits. The block keeps one running total and the time of the latest hit, so "hits inside the window" is read as
  // "the latest hit is inside the window", and the count is the block's total (it is not split by window).
  for (const b of input.blocks) {
    if (!b.lastHitAt || b.hitCount < 1 || b.lastHitAt.getTime() < startMs) continue;
    alerts.push({
      kind: "blocked_ip_hits",
      severity: "low",
      at: b.lastHitAt.toISOString(),
      subject: { ip: b.ip },
      detail: `The block on ${b.ip} has stopped ${b.hitCount} request${b.hitCount === 1 ? "" : "s"}`,
      count: b.hitCount,
    });
  }

  // Newest first; the kind breaks a tie so the order never depends on map iteration.
  return alerts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.kind.localeCompare(b.kind)));
}
