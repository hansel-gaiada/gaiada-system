// Separation-pay arithmetic. PURE — no database, no clock, and no hard-coded multiplier.
//
// ⚠ Same discipline as payroll-calc.ts, and for a stronger reason: severance is the single most
//    litigated number an employer produces. Every multiplier below arrives from
//    `hr_statutory_parameters` (migration 202608240143), which is effective-dated and carries a
//    `ratified_by` signature. `DEFAULT_SEVERANCE_UNRATIFIED` at the bottom is a TEST FIXTURE
//    expressing the structure of PP 35/2021, not a legal opinion.
//
// ── The structure the Indonesian statute actually has ───────────────────────────────────────────
// Separation pay is THREE distinct components, and they are three because the law applies different
// multipliers to each depending on why employment ended:
//
//   UP  — uang pesangon              severance proper, a table over completed years (max 9x wage)
//   UPMK— uang penghargaan masa kerja long-service reward, a coarser table starting at 3 years
//   UPH — uang penggantian hak       compensation of entitlements: unused annual leave, relocation,
//                                    and anything the contract owes on exit
//
// A resignation typically earns UPH only. A redundancy earns all three, with UP at a multiple. An
// efficiency dismissal, a retirement and a death each carry their own multiplier pair. Collapsing
// these into one "severance amount" makes every one of those distinctions unrepresentable, which is
// why `hr_separations` stores them in three columns and this engine returns them separately.
//
// ── What this engine deliberately does NOT decide ───────────────────────────────────────────────
// Whether a given factual situation IS a redundancy rather than a misconduct dismissal is a legal
// judgement, not arithmetic. The `ground` is an input. The engine computes what that ground implies
// and refuses grounds it has no table for, rather than falling back to a default that would quietly
// under- or over-pay.

import { serviceYears } from "./working-days";

/** The multiplier pair a termination ground implies. */
export interface GroundMultipliers {
  /** Multiplier applied to the uang pesangon table result. 2 = "twice the table" (2 x UP). */
  severanceMultiplier: number;
  /** Multiplier applied to the long-service (UPMK) table result. Usually 0 or 1. */
  serviceRewardMultiplier: number;
  /**
   * Percentage of (UP + UPMK) paid as separation/housing compensation on top, where the statute
   * provides one. 0 when it does not.
   */
  entitlementCompensationRate: number;
  note?: string;
}

export interface SeveranceParams {
  /**
   * uang pesangon: months of wage owed at each completed-year bracket.
   * `{ minYears, months }`, ascending; the applicable row is the LAST whose `minYears` is reached.
   */
  severanceTable: { minYears: number; months: number }[];
  /** uang penghargaan masa kerja: the same shape, a coarser table that starts later. */
  serviceRewardTable: { minYears: number; months: number }[];
  /** Multiplier pair per `hr_separations.ground`. A ground absent here is refused, not defaulted. */
  grounds: Record<string, GroundMultipliers>;
}

export interface SeveranceInput {
  /** The monthly wage the multipliers apply to — base plus fixed allowances, by statute. */
  monthlyWage: number;
  /** ISO hire date. Prefer the earliest CONTINUOUS-service hire from hr_job_events, not employees.hire_date. */
  hireDate: string;
  /** ISO effective date of the separation. */
  effectiveOn: string;
  ground: string;
  /** Unused annual leave in minutes, encashed as part of UPH. */
  unusedLeaveMinutes?: number;
  /** Minutes in a working day, for converting the leave above. */
  minutesPerDay?: number;
  /** Working days in a month, for converting encashed leave days to a wage fraction. */
  workingDaysPerMonth?: number;
  /** Anything else the contract owes on exit (relocation, unpaid reimbursements). */
  otherEntitlements?: number;
}

export interface SeveranceResult {
  serviceYears: number;
  /** uang pesangon, after the ground's multiplier. */
  severanceAmount: number;
  /** uang penghargaan masa kerja, after the ground's multiplier. */
  serviceRewardAmount: number;
  /** uang penggantian hak: encashed leave + statutory percentage + contractual extras. */
  entitlementCompensationAmount: number;
  totalAmount: number;
  workings: Record<string, unknown>;
}

const toCents = (v: number): number => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number): number => Math.round(c) / 100;

/**
 * Months of wage owed by a bracket table at a given completed-service figure.
 *
 * Brackets are on COMPLETED years — "1 year but less than 2" pays the 1-year row — so the lookup
 * floors the fractional service figure before comparing. Doing the comparison on the fraction would
 * move somebody who has served 11.9 months into the 1-year bracket, which is the wrong direction and
 * the expensive one.
 */
export function monthsFromTable(table: { minYears: number; months: number }[], years: number): number {
  const completed = Math.floor(years);
  let months = 0;
  for (const row of [...table].sort((a, b) => a.minYears - b.minYears)) {
    if (completed >= row.minYears) months = row.months;
    else break;
  }
  return months;
}

/**
 * Compute the three separation-pay components for one employee.
 *
 * Throws on an unknown ground. That is deliberate: silently returning zero for a ground the
 * parameter set does not describe would produce a separation record that looks computed and is not.
 */
export function computeSeverance(params: SeveranceParams, input: SeveranceInput): SeveranceResult {
  const multipliers = params.grounds[input.ground];
  if (!multipliers) {
    throw new Error(
      `no severance multipliers configured for ground "${input.ground}" — add it to the statutory ` +
      `parameter set rather than accepting a zero computation`,
    );
  }

  const years = serviceYears(input.hireDate, input.effectiveOn);
  const wageCents = toCents(input.monthlyWage);

  const upMonths = monthsFromTable(params.severanceTable, years);
  const upmkMonths = monthsFromTable(params.serviceRewardTable, years);

  const severanceCents = Math.round(wageCents * upMonths * multipliers.severanceMultiplier);
  const serviceRewardCents = Math.round(wageCents * upmkMonths * multipliers.serviceRewardMultiplier);

  // UPH: encashed unused leave, plus the statutory percentage of (UP + UPMK) where one applies,
  // plus whatever the contract owes.
  const minutesPerDay = input.minutesPerDay ?? 480;
  const workingDaysPerMonth = input.workingDaysPerMonth ?? 21;
  const leaveDays = (input.unusedLeaveMinutes ?? 0) / minutesPerDay;
  const leaveCents = Math.round((wageCents * leaveDays) / workingDaysPerMonth);
  const statutoryExtraCents = Math.round(
    (severanceCents + serviceRewardCents) * (multipliers.entitlementCompensationRate ?? 0),
  );
  const entitlementCents = leaveCents + statutoryExtraCents + toCents(input.otherEntitlements ?? 0);

  const totalCents = severanceCents + serviceRewardCents + entitlementCents;

  return {
    serviceYears: years,
    severanceAmount: fromCents(severanceCents),
    serviceRewardAmount: fromCents(serviceRewardCents),
    entitlementCompensationAmount: fromCents(entitlementCents),
    totalAmount: fromCents(totalCents),
    workings: {
      ground: input.ground,
      groundNote: multipliers.note,
      monthlyWage: input.monthlyWage,
      completedYears: Math.floor(years),
      uangPesangon: { tableMonths: upMonths, multiplier: multipliers.severanceMultiplier, amount: fromCents(severanceCents) },
      uangPenghargaan: { tableMonths: upmkMonths, multiplier: multipliers.serviceRewardMultiplier, amount: fromCents(serviceRewardCents) },
      uangPenggantianHak: {
        encashedLeaveDays: Number(leaveDays.toFixed(2)),
        encashedLeaveAmount: fromCents(leaveCents),
        statutoryPercentage: multipliers.entitlementCompensationRate ?? 0,
        statutoryAmount: fromCents(statutoryExtraCents),
        contractualExtras: input.otherEntitlements ?? 0,
      },
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ UNRATIFIED test fixture — the STRUCTURE of PP 35/2021, not verified legal advice.
//
// The two tables are the statutory ones and are stable across the 2021 reform. The per-ground
// multipliers are the part most likely to need correction against a lawyer's reading, and the part
// with the largest money consequence, which is why they live in data.
// ════════════════════════════════════════════════════════════════════════════════════════════════
export const DEFAULT_SEVERANCE_UNRATIFIED: SeveranceParams = {
  // uang pesangon: 1 month at under a year, rising to 9 at 8+ years.
  severanceTable: [
    { minYears: 0, months: 1 }, { minYears: 1, months: 2 }, { minYears: 2, months: 3 },
    { minYears: 3, months: 4 }, { minYears: 4, months: 5 }, { minYears: 5, months: 6 },
    { minYears: 6, months: 7 }, { minYears: 7, months: 8 }, { minYears: 8, months: 9 },
  ],
  // uang penghargaan masa kerja: nothing under 3 years, then 2 months rising to 10 at 24+.
  serviceRewardTable: [
    { minYears: 0, months: 0 }, { minYears: 3, months: 2 }, { minYears: 6, months: 3 },
    { minYears: 9, months: 4 }, { minYears: 12, months: 5 }, { minYears: 15, months: 6 },
    { minYears: 18, months: 7 }, { minYears: 21, months: 8 }, { minYears: 24, months: 10 },
  ],
  grounds: {
    // A resignation earns entitlement compensation only — no UP, no UPMK.
    resignation: { severanceMultiplier: 0, serviceRewardMultiplier: 0, entitlementCompensationRate: 0,
      note: "voluntary resignation: UPH only" },
    // A fixed-term (PKWT) contract simply ending carries a compensation payment, not the tables.
    contract_end: { severanceMultiplier: 0, serviceRewardMultiplier: 0, entitlementCompensationRate: 0,
      note: "PKWT expiry: uang kompensasi is contractual/proportional, supply it via otherEntitlements" },
    redundancy: { severanceMultiplier: 1, serviceRewardMultiplier: 1, entitlementCompensationRate: 0,
      note: "efficiency/redundancy with company losses: 0.5x UP is also provided for in some cases — verify the sub-ground" },
    efficiency: { severanceMultiplier: 1, serviceRewardMultiplier: 1, entitlementCompensationRate: 0 },
    mutual_agreement: { severanceMultiplier: 1, serviceRewardMultiplier: 1, entitlementCompensationRate: 0 },
    retirement: { severanceMultiplier: 1.75, serviceRewardMultiplier: 1, entitlementCompensationRate: 0 },
    prolonged_illness: { severanceMultiplier: 2, serviceRewardMultiplier: 1, entitlementCompensationRate: 0 },
    death: { severanceMultiplier: 2, serviceRewardMultiplier: 1, entitlementCompensationRate: 0 },
    // Misconduct is the contested one: the multiplier depends on the specific sub-ground and on
    // whether the dismissal survived a dispute. 0 is the conservative default and the note says so.
    misconduct: { severanceMultiplier: 0, serviceRewardMultiplier: 0, entitlementCompensationRate: 0,
      note: "sub-ground dependent and frequently disputed — verify before relying on this figure" },
    probation_fail: { severanceMultiplier: 0, serviceRewardMultiplier: 0, entitlementCompensationRate: 0,
      note: "probation dismissal: no statutory severance" },
    other: { severanceMultiplier: 1, serviceRewardMultiplier: 1, entitlementCompensationRate: 0,
      note: "generic fallback — prefer a specific ground" },
  },
};
