// DW-3e: the Overview's Pulse, as data. A tile's reading is what its reader said, kept in three kinds so a failed
// or refused read can never become a number: "ok" carries a count, "forbidden" is the reader's 403 and "unavailable"
// is every other failure (plan §3.3, §3.7). The mappers below are pure; the widget does the reading.
import type { ReadResult } from "./readResult";
import type { AccountsResult } from "./it-accounts";
import { summarize } from "./it-accounts";
import type { MonitoringSummary } from "./monitoringShared";
import type { PipelineGate } from "./pipeline";
import type { Device } from "./it";
import type { PayrollRun } from "./hr-full";
import type { Guarded } from "./socialShared";
import { WORKSPACES, hrefFor, isPlanned, type PulseTile } from "./workspaces";

export type PulseReading =
  | { kind: "ok"; value: number; detail?: string }
  | { kind: "forbidden" }
  | { kind: "unavailable" };

export interface PulseTileModel {
  key: string;
  label: string;
  /** The page that lists what the tile counts; null when it needs an id the Overview does not have. */
  href: string | null;
  reading: PulseReading;
}

export const NO_ACCESS = "No access";
export const UNAVAILABLE = "Unavailable";

/** What the tile's figure says: the count, or in words why there is none. Never 0 for a failure. */
export function pulseValueText(reading: PulseReading): string {
  switch (reading.kind) {
    case "ok": return String(reading.value);
    case "forbidden": return NO_ACCESS;
    case "unavailable": return UNAVAILABLE;
  }
}

/** The Pulse draws only when something can be read. A refusal is an answer; a failure is not. */
export function everyTileFailed(tiles: readonly Pick<PulseTileModel, "reading">[]): boolean {
  return tiles.length > 0 && tiles.every((t) => t.reading.kind === "unavailable");
}

export const UNAVAILABLE_READING: PulseReading = { kind: "unavailable" };

/** A `ReadResult` list (change requests, pipeline gates). */
export function readingOfResult<T>(r: ReadResult<T>, count: (data: T) => Omit<Extract<PulseReading, { kind: "ok" }>, "kind">): PulseReading {
  if (r.kind === "ok") return { kind: "ok", ...count(r.data) };
  return r.kind === "forbidden" ? { kind: "forbidden" } : UNAVAILABLE_READING;
}

/** Several `ReadResult` lists that make ONE count (onboarding is two statuses): a refusal or a failure in any leg is the
 *  tile's, so a leg that failed can never be summed as 0. A refusal wins over a failure: it is the more precise answer. */
export function readingOfAllResults<T>(rs: readonly ReadResult<T[]>[]): PulseReading {
  if (rs.some((r) => r.kind === "forbidden")) return { kind: "forbidden" };
  if (rs.some((r) => r.kind === "unavailable")) return UNAVAILABLE_READING;
  return { kind: "ok", value: rs.reduce((n, r) => n + (r.kind === "ok" ? r.data.length : 0), 0) };
}

/** Payroll runs that wait on someone (DW-7e). `calculated` and `pending_approval` wait for approval (the approve route
 *  accepts exactly those two); `approved` waits for its payslips to be published and the run marked paid. A `draft` is
 *  still being built and `paid` and `cancelled` are over, so none of them waits on anyone. */
export function payrollRunsWaiting(runs: readonly Pick<PayrollRun, "status">[]): { toApprove: number; toPay: number } {
  return {
    toApprove: runs.filter((r) => r.status === "calculated" || r.status === "pending_approval").length,
    toPay: runs.filter((r) => r.status === "approved").length,
  };
}

export function readingOfPayrollRuns(r: ReadResult<PayrollRun[]>): PulseReading {
  return readingOfResult(r, (runs) => {
    const { toApprove, toPay } = payrollRunsWaiting(runs);
    const detail = [toApprove > 0 ? `${toApprove} to approve` : "", toPay > 0 ? `${toPay} to pay` : ""].filter(Boolean).join(", ");
    return { value: toApprove + toPay, ...(detail ? { detail } : {}) };
  });
}

/** The IT device list: devices whose status is `offline` (the registry's own status, written by the heartbeat and the
 *  discovery run). `degraded` and `unknown` are not offline. A zero with nothing registered is no all-clear. */
export function readingOfDevices(r: ReadResult<Device[]>): PulseReading {
  return readingOfResult(r, (devices) => ({
    value: devices.filter((d) => d.status === "offline").length,
    detail: devices.length === 0 ? "No devices registered yet" : `of ${devices.length} devices`,
  }));
}

/** The Social reader's `Guarded` list: a 403 is `forbidden`; a failure threw before this was reached. */
export function readingOfGuarded<T>(r: Guarded<T[]>): PulseReading {
  return r.forbidden ? { kind: "forbidden" } : { kind: "ok", value: r.data.length };
}

/** Distinct runs with a gate waiting: a run holding two gates is still one run waiting. */
export function runsWaiting(gates: readonly PipelineGate[]): number {
  return new Set(gates.map((g) => g.run_id)).size;
}

/** The monitoring board's counters. `null` is "not connected", never an all-clear. */
export function readingOfSummary(s: MonitoringSummary | null): PulseReading {
  if (!s) return UNAVAILABLE_READING;
  const parts = [s.down > 0 ? `${s.down} down` : "", s.degraded > 0 ? `${s.degraded} degraded` : ""].filter(Boolean);
  // A zero is no all-clear while nothing is monitored or the runner has not reported a sweep.
  const detail = s.total === 0 ? "No monitors yet" : s.lastSweepAt === null ? "No sweep reported yet" : parts.join(", ");
  return { kind: "ok", value: s.down + s.degraded, ...(detail ? { detail } : {}) };
}

/** The IT accounts worklist: the staff who still need a login (the server's `missing` state). */
export function readingOfAccounts(r: AccountsResult): PulseReading {
  if (r.kind === "ok") return { kind: "ok", value: summarize(r.accounts).missing };
  return r.kind === "forbidden" ? { kind: "forbidden" } : UNAVAILABLE_READING;
}

/** The built Pulse tiles of the workspace an Overview belongs to: those with a reader and no ticket. Found by
 *  the subject's workspace key; none for Company (null) and for a generic department (not a registry workspace). */
export function builtPulseTiles(subject: { workspaceKey: string | null }): readonly PulseTile[] {
  const ws = WORKSPACES.find((w) => w.key === subject.workspaceKey);
  return (ws?.pulse ?? []).filter((t) => !isPlanned(t) && !!t.source);
}

/** A tile's link made concrete; null when it has none or needs a department id the Overview lacks. */
export function pulseHref(tile: PulseTile, ids: { deptId: string | null; companyId: string }): string | null {
  return tile.href ? hrefFor(tile.href, ids) : null;
}
