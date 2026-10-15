import type { OverviewWidgetProps } from "./index";
import type { PulseSource, PulseTile } from "@/lib/workspaces";
import { listChangeRequests } from "@/lib/webdevChangeRequests-data";
import { listInternalPendingGates } from "@/lib/pipeline";
import { getSummary } from "@/lib/monitoring";
import { listPosts } from "@/lib/social";
import { listAccounts } from "@/lib/it-accounts";
import { hrScopeCompanies } from "@/lib/hr";
import { listLeaveResult, listCasesResult } from "@/lib/hr-data";
import { listPayrollRunsResult } from "@/lib/hr-full-data";
import { listDevicesResult } from "@/lib/it-data";
import { listAlertsResult } from "@/lib/itSecurity";
import {
  getArAgingResult, getCloseReadinessResult, getTrialBalanceResult, listPendingPaymentsResult, listPeriodsResult,
  reconcileApResult, reconcileArResult, reconcileAssetsResult, reconcileTreasuryResult, verifyLedgerResult,
} from "@/lib/finance-data";
import { todayIsoInDisplayZone } from "@/lib/format";
import type { Me } from "@/lib/platform";
import {
  NO_CURRENT_PERIOD, UNAVAILABLE_READING, currentPeriod, everyTileFailed, pulseHref, readingOfAccounts, readingOfAllResults, readingOfClose,
  readingOfAlerts, readingOfDevices, readingOfGuarded, readingOfIntegrity, readingOfOverdue, readingOfPayrollRuns, readingOfPendingPayments, readingOfResult,
  readingOfSummary, runsWaiting, type PulseReading, type PulseTileModel,
} from "@/lib/overviewPulse";
import { PulseBlock } from "./PulseBlock";

// DW-3e: "Pulse", the Department band's block: the workspace's own tiles, only the ones an honest reader feeds
// (the registry's `source`; every other tile stays planned and is never drawn). Each tile reads its own source,
// all at once, and answers for itself: a refused read says "No access" and any other failure says "Unavailable",
// never 0, and one tile failing does not blank the others. The block throws, so the frame's boundary says
// "Unavailable", only when EVERY tile failed.
//
// HR's leave and case lists fall back to the viewer's OWN rows on the server when they may not read the company's, so a
// count from them is only the department's for a viewer in the HR scope. A viewer outside it gets "No access", never
// their own two requests under the label "Leave pending" (DW-7e). The payroll and device routes refuse outright.
const FORBIDDEN_READING: PulseReading = { kind: "forbidden" };
const inHrScope = (me: Me, tenantId: string) => hrScopeCompanies(me, tenantId).some((c) => c.id === tenantId);

const READERS: Record<PulseSource, (userId: string, tenantId: string, me: Me) => Promise<PulseReading>> = {
  "change-requests-new": async (u, t) => readingOfResult(await listChangeRequests(u, t, { status: "new" }), (rows) => ({ value: rows.length })),
  "pipeline-gates-pending": async (u, t) => readingOfResult(await listInternalPendingGates(u, t), (gates) => ({ value: runsWaiting(gates) })),
  "monitoring-problem-sites": async (u, t) => readingOfSummary(await getSummary(u, t)),
  "social-posts-scheduled": async (u, t) => readingOfGuarded(await listPosts(u, t, { status: "scheduled" })),
  "social-posts-failed": async (u, t) => readingOfGuarded(await listPosts(u, t, { status: "failed" })),
  "it-account-requests": async (u, t) => readingOfAccounts(await listAccounts(u, t)),
  "hr-leave-pending": async (u, t, me) =>
    inHrScope(me, t) ? readingOfResult(await listLeaveResult(u, t, { status: "pending" }), (rows) => ({ value: rows.length })) : FORBIDDEN_READING,
  // Onboarding still open is two statuses: a leg that failed is the tile's failure, never summed as 0.
  "hr-onboarding-open": async (u, t, me) => inHrScope(me, t)
    ? readingOfAllResults(await Promise.all([
      listCasesResult(u, t, { kind: "onboarding", status: "open" }),
      listCasesResult(u, t, { kind: "onboarding", status: "in_progress" }),
    ]))
    : FORBIDDEN_READING,
  // "Open" is the status `open`, as the HR page's own "Open cases" figure reads it; a case being worked on is `in_progress`.
  "hr-cases-open": async (u, t, me) =>
    inHrScope(me, t) ? readingOfResult(await listCasesResult(u, t, { status: "open" }), (rows) => ({ value: rows.length })) : FORBIDDEN_READING,
  "hr-payroll-waiting": async (u, t) => readingOfPayrollRuns(await listPayrollRunsResult(u, t)),
  "it-devices-offline": async (u, t) => readingOfDevices(await listDevicesResult(u, t)),
  // DW-7h: high plus medium alerts in the last 24 hours. The route is `it_account` `read`, so a viewer without it reads "No access".
  "it-security-alerts": async (u, t) => readingOfAlerts(await listAlertsResult(u, t, "24h")),
  // Finance (DW-7e-2). Every route refuses outright (no own-rows fallback), so no scope check is needed here.
  "finance-payments-to-confirm": async (u, t) => readingOfPendingPayments(await listPendingPaymentsResult(u, t)),
  "finance-overdue-receivables": async (u, t) => readingOfOverdue(await getArAgingResult(u, t)),
  // The CURRENT period only. No period today is "Unavailable: No current period", never a count and never "Ready to close".
  "finance-close-progress": async (u, t) => {
    const periods = await listPeriodsResult(u, t);
    if (periods.kind !== "ok") return periods.kind === "forbidden" ? FORBIDDEN_READING : UNAVAILABLE_READING;
    const period = currentPeriod(periods.data, todayIsoInDisplayZone());
    return period ? readingOfClose(period, await getCloseReadinessResult(u, t, period.id)) : NO_CURRENT_PERIOD;
  },
  // The number of integrity checks that FAILED. Every check is read; one that could not be is never counted as passed.
  "finance-integrity-findings": async (u, t) => {
    const [ledger, ar, ap, assets, treasury, tb] = await Promise.all([
      verifyLedgerResult(u, t), reconcileArResult(u, t), reconcileApResult(u, t), reconcileAssetsResult(u, t),
      reconcileTreasuryResult(u, t), getTrialBalanceResult(u, t),
    ]);
    return readingOfIntegrity([
      { label: "Ledger chain", result: ledger },
      { label: "Receivables", result: ar },
      { label: "Payables", result: ap },
      { label: "Fixed assets", result: assets },
      { label: "Treasury", result: treasury },
      // A trial balance's verdict is `balanced`; a payload without it is not a verdict.
      { label: "Trial balance", result: tb.kind === "ok" ? { kind: "ok", data: { clean: tb.data.balanced } } : tb },
    ]);
  },
};

/** One tile's reading. A reader that throws (a 5xx, a timeout) is this tile's failure, not the block's. */
async function readTile(tile: PulseTile, userId: string, tenantId: string, me: Me): Promise<PulseReading> {
  const read = tile.source ? READERS[tile.source] : undefined;
  if (!read) return UNAVAILABLE_READING;
  try {
    return await read(userId, tenantId, me);
  } catch {
    return UNAVAILABLE_READING;
  }
}

export async function Pulse({ me, tenantId, deptId, pulse }: OverviewWidgetProps) {
  const tiles = pulse ?? [];
  // A workspace with no built tile draws no Pulse (the frame does not even place it).
  if (tiles.length === 0) return null;
  const readings = await Promise.all(tiles.map((t) => readTile(t, me.userId, tenantId, me)));
  const models: PulseTileModel[] = tiles.map((t, i) => ({
    key: t.key, label: t.label, href: pulseHref(t, { deptId, companyId: tenantId }), reading: readings[i],
  }));
  if (everyTileFailed(models)) throw new Error("Pulse: every tile failed to read");
  return <PulseBlock tiles={models} />;
}
