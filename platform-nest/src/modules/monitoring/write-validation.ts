// MON-19/20 — pure validation + decision helpers for the monitor write surface (create/update/
// delete) and incident acknowledge. NO I/O, NO DB, NO Cerbos: everything here is a function of its
// inputs so it can be unit-tested without DATABASE_URL_TEST, mirroring the drivers/registry.ts and
// runner.ts split between "pure decisions" and "the DB shell".
//
// ── WHY A SEPARATE FILE, NOT INLINE IN THE CONTROLLER ───────────────────────────────────────────
// The controller's SSRF check (§ below) is the security core of this ticket, and a security-critical
// decision that can only be exercised through a live-DB Cerbos+RLS suite is a decision nobody
// actually re-runs on every change. Keeping the host-extraction and allowlist-membership logic pure
// means `write-validation.test.ts` can pin every edge case (bad URL, host:port, bare hostname,
// heartbeat's "no target" case, case/trailing-dot normalisation) in milliseconds, with the live suite
// left to prove the wiring (does the controller actually call this before the INSERT) rather than
// re-proving arithmetic.
import { isHostAllowlisted } from "./drivers/egress";
import type { MonitorKind } from "./drivers/registry";

export type MonitorSeverity = "page" | "ticket" | "info";

export const MONITOR_SEVERITIES: readonly MonitorSeverity[] = ["page", "ticket", "info"];

export class MonitorValidationError extends Error {}

/** `severity` defaults to `ticket` when absent; any other value must be one of the three named ones. */
export function parseSeverity(input: unknown): MonitorSeverity {
  if (input === undefined || input === null || input === "") return "ticket";
  if (typeof input === "string" && (MONITOR_SEVERITIES as readonly string[]).includes(input)) {
    return input as MonitorSeverity;
  }
  throw new MonitorValidationError(`severity must be one of ${MONITOR_SEVERITIES.join("|")}`);
}

/** `intervalSec` defaults to 60 (the schema's own default) and is floored by the CHECK at >=20 — this
 *  re-states that floor at the API so a bad value is a clean 400, not a raw constraint-violation 500. */
export function parseIntervalSec(input: unknown): number {
  if (input === undefined || input === null || input === "") return 60;
  const n = Number(input);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new MonitorValidationError("intervalSec must be an integer number of seconds");
  }
  if (n < 20) throw new MonitorValidationError("intervalSec must be at least 20 seconds");
  return n;
}

/** Free-form tags, filtered to non-empty strings. Anything else silently drops rather than 400s —
 *  tags are cosmetic, and a stray non-string in a client-built array must not block the whole write. */
export function parseTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
}

/**
 * Extracts the hostname a monitor of this `kind` will actually dial, for the SSRF allowlist check.
 * Returns `null` for `heartbeat`, which has no outbound target by definition (§NewMonitorForm) — a
 * driver that never dials anything has nothing to allowlist, and forcing a target on it would make
 * the form lie about what the check does.
 *
 * THROWS on a target the kind cannot make sense of, rather than returning null: a null here would be
 * indistinguishable from "no target needed" and would skip the allowlist check entirely for a kind
 * that absolutely dials something (the exact hole this function exists to close).
 */
export function extractTargetHost(kind: MonitorKind, target: string): string | null {
  if (kind === "heartbeat") return null;

  if (kind === "http" || kind === "keyword") {
    if (!target) throw new MonitorValidationError("target is required for this check type");
    let u: URL;
    try {
      u = new URL(target);
    } catch {
      throw new MonitorValidationError("target is not a valid URL");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new MonitorValidationError(`target must be http or https, got ${u.protocol}`);
    }
    return u.hostname;
  }

  if (kind === "tcp" || kind === "tls") {
    if (!target) throw new MonitorValidationError("target is required for this check type");
    // host:port, with IPv6 [::1]:443 handled the same way the runtime dialer would.
    const bracket = target.match(/^\[(.+)\]:(\d+)$/);
    if (bracket) return bracket[1];
    const idx = target.lastIndexOf(":");
    if (idx <= 0 || idx === target.length - 1) {
      throw new MonitorValidationError("target must be host:port");
    }
    return target.slice(0, idx);
  }

  if (kind === "dns") {
    if (!target) throw new MonitorValidationError("target is required for this check type");
    return target;
  }

  // grpc/snmp/steam/docker/database and any future kind: no driver is registered for these yet
  // (registry.ts KNOWN_KINDS), so `hasDriver()` refuses the create/update before this function is
  // ever reached for them in production. Still handled explicitly (never a default branch) so a
  // future driver cannot slip through this file un-thought-about.
  throw new MonitorValidationError(`no target-extraction rule defined for kind '${kind}' yet`);
}

/**
 * THE SSRF FLOOR AT WRITE TIME (design §4.3, non-negotiable constraint 2 of MON-19/20).
 *
 * Creating (or re-targeting, on update) a monitor IS the standing authorization to probe that host
 * on a schedule. Without this check, "create a monitor" would be an unauthenticated-adjacent way to
 * make the platform dial an arbitrary host indefinitely — worse than a one-shot SSRF, because it is a
 * SCHEDULED one. `host === null` (heartbeat) always passes: there is nothing to dial.
 */
export function assertHostAllowlisted(host: string | null, allowlist: readonly string[]): void {
  if (host === null) return;
  if (!isHostAllowlisted(host, allowlist)) {
    throw new MonitorValidationError(
      `target host '${host}' is not a verified property for this client. Add and verify it under ` +
        `Search before creating or re-targeting a monitor for it — an unverified target would be ` +
        `accepted here and then silently never run (registry.ts's absent-driver rule, restated for hosts).`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Channel / route / maintenance write surface — the management endpoints that fill in the middle
// between "a monitor exists" and "runner.ts:293-345 has somewhere to fan an incident out to".
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export type MonitorChannelKind = "email" | "telegram" | "ntfy" | "webhook" | "wa" | "mcp";

export const MONITOR_CHANNEL_KINDS: readonly MonitorChannelKind[] = [
  "email", "telegram", "ntfy", "webhook", "wa", "mcp",
];

/** `kind` is required and must be one of the declared channel kinds — an unrecognised value is a
 *  typo, not a new kind, and a row nothing will ever deliver through must fail loudly at write
 *  time rather than sit on the console looking like coverage (monitoring.ts's own `channelHealth`
 *  concern, restated at the write boundary). Only `email` is actually wired to a delivery driver
 *  today (runner.ts's notifyIncidents skips the rest); the others are legal to create ahead of
 *  their driver landing — "absent, not silently inert" applies to drivers, not to channel rows. */
export function parseChannelKind(input: unknown): MonitorChannelKind {
  if (typeof input === "string" && (MONITOR_CHANNEL_KINDS as readonly string[]).includes(input)) {
    return input as MonitorChannelKind;
  }
  throw new MonitorValidationError(`kind must be one of ${MONITOR_CHANNEL_KINDS.join("|")}`);
}

/**
 * A route's match fields are a FILTER, not a value with a default. `parseSeverity` defaults an
 * absent severity to `"ticket"` because that is right for a monitor's OWN severity — but an absent
 * `matchSeverity` on a route means "match every severity" (a catch-all), and silently narrowing that
 * to `"ticket"` would make a route quietly stop matching `page`/`info` events nobody asked to exclude.
 * Returns `null` for "unset", never a default.
 */
export function parseOptionalMatchSeverity(input: unknown): MonitorSeverity | null {
  if (input === undefined || input === null || input === "") return null;
  if (typeof input === "string" && (MONITOR_SEVERITIES as readonly string[]).includes(input)) {
    return input as MonitorSeverity;
  }
  throw new MonitorValidationError(`matchSeverity must be one of ${MONITOR_SEVERITIES.join("|")}`);
}

/** `matchKind` filters against `monitors.kind`, which is free text (registry.ts's driver-kind CHECK
 *  lives at monitor-create time, not here) — so this only trims, it does not re-validate against the
 *  driver registry. A route may legitimately target a kind whose driver was since removed. */
export function parseOptionalMatchKind(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  const s = String(input).trim();
  return s === "" ? null : s;
}

export interface MaintenanceScope {
  /** `null` = tenant-wide window (matches every monitor). */
  monitorId: string | null;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The GET /maintenance read path renders `scope` as `"all"` or `"monitor:<uuid>"` (see the
 * controller's `mapMaintenance`); the write path accepts the same string back so the UI's
 * scheduleMaintenance form (platform-ui/src/lib/monitoringActions.ts) round-trips without a
 * second representation to keep in sync.
 */
export function parseMaintenanceScope(input: unknown): MaintenanceScope {
  const raw = input === undefined || input === null ? "all" : String(input).trim();
  if (raw === "" || raw === "all") return { monitorId: null };
  const m = raw.match(/^monitor:(.+)$/);
  if (!m || !UUID_RE.test(m[1])) {
    throw new MonitorValidationError(`scope must be "all" or "monitor:<uuid>", got '${raw}'`);
  }
  return { monitorId: m[1] };
}

/** Both ends are required and the window must run forward — an open-ended or inverted window is how
 *  alerting gets muted permanently (K7, the exact failure this table exists to prevent). The DB CHECK
 *  (`monitor_maintenance_range`) enforces this too, but re-stating it here turns a constraint
 *  violation into a clean 400 instead of a raw pg error. */
export function parseMaintenanceWindow(startsAtInput: unknown, endsAtInput: unknown): { startsAt: Date; endsAt: Date } {
  const startsAt = new Date(String(startsAtInput ?? ""));
  const endsAt = new Date(String(endsAtInput ?? ""));
  if (Number.isNaN(startsAt.getTime())) throw new MonitorValidationError("startsAt is not a valid date");
  if (Number.isNaN(endsAt.getTime())) throw new MonitorValidationError("endsAt is not a valid date");
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new MonitorValidationError("endsAt must be after startsAt");
  }
  return { startsAt, endsAt };
}

/** Results windows the board offers — a fixed, safe set of interval literals rather than splicing a
 *  caller-supplied string into SQL. An unrecognised window is a 400, not a silent fallback to 24h. */
export const RESULT_WINDOWS: Record<string, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

export function parseResultWindow(input: unknown): string {
  const key = input === undefined ? "24h" : String(input);
  const interval = RESULT_WINDOWS[key];
  if (!interval) throw new MonitorValidationError(`window must be one of ${Object.keys(RESULT_WINDOWS).join("|")}`);
  return interval;
}

/** Raw (unvalidated) driver config built from the write body. The DRIVER's own `validate()` is still
 *  the authority — this only assembles the shape each kind expects; it never trusts the result. */
export function buildRawDriverConfig(
  kind: MonitorKind,
  input: { target: string; assertions?: unknown; graceSec?: unknown },
): unknown {
  if (kind === "http") {
    return { url: input.target };
  }
  if (kind === "keyword") {
    const assertions = Array.isArray(input.assertions) ? input.assertions : [];
    const bodyContains = assertions.find(
      (a): a is { type: string; expr: string } =>
        !!a && typeof a === "object" && (a as Record<string, unknown>).type === "body_contains",
    );
    return { url: input.target, expect: bodyContains?.expr };
  }
  if (kind === "heartbeat") {
    return input.graceSec === undefined ? {} : { graceSec: input.graceSec };
  }
  // Any other kind has no driver registered in this deployment (see extractTargetHost's note), so
  // the controller refuses before this is called. Kept exhaustive rather than a default/`{}` branch.
  throw new MonitorValidationError(`no config builder defined for kind '${kind}' yet`);
}
