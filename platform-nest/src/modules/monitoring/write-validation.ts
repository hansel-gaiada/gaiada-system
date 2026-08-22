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
