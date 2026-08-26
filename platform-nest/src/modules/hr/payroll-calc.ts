// Payroll arithmetic. PURE — no database, no clock, no config, and NO HARD-CODED STATUTORY NUMBER.
//
// ⚠ READ THIS BEFORE CHANGING ANYTHING BELOW ⚠
//
// Every rate, cap, bracket and threshold arrives as a PARAMETER, loaded from
// `hr_statutory_parameters` (migration 202608240143), which is effective-dated and carries a
// `ratified_by` column that is NULL until an owner signs the numbers off. That indirection is not
// ceremony — it is the entire mechanism by which this engine can exist at all while the blueprint's
// "blocked on statutory facts" gate is still open:
//
//   * The ENGINE (this file) encodes the SHAPE of the calculation — which is a matter of arithmetic
//     and public regulation structure, and is testable today.
//   * The NUMBERS live in data, are marked unratified, and a run finalized against an unratified set
//     records who forced it and why.
//
// So: never write a rate into this file. If you find yourself typing `0.04`, the parameter is
// missing and the correct fix is to add it to the parameter set, not to inline it here. The one
// exception is `DEFAULT_PARAMS` at the bottom, which exists so tests have a fixture and is clearly
// labelled UNRATIFIED.
//
// ── Integer minor units, throughout ─────────────────────────────────────────────────────────────
// Same discipline as loan-schedule.ts. IDR has no minor unit in practice but `numeric(14,2)` does,
// and mixing float rupiah with float percentages is how a payslip ends up off by a rupiah that
// somebody has to explain. Everything below is in integer *cents* (1/100 of the currency unit) and
// converts once at each boundary.
//
// ── What this file does NOT do ──────────────────────────────────────────────────────────────────
// It does not read the database, decide who is in a run, or persist anything. It takes one
// employee's resolved facts for one period and returns the itemization. The controller composes.

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Parameter surface
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** A statutory contribution program: its split, and the wage window the rate applies to. */
export interface ContributionParam {
  /** Employer share as a fraction of the contribution base (0.04 = 4%). */
  employerRate: number;
  /** Employee share as a fraction of the contribution base. */
  employeeRate: number;
  /** Wage ceiling the rate applies to. Undefined = uncapped. */
  wageCap?: number;
  /** Wage floor (regional minimum wage, typically). Undefined = no floor. */
  wageFloor?: number;
}

/** One row of a progressive tax table. */
export interface TaxBracket {
  /** Inclusive lower bound of annual taxable income this rate applies from. */
  from: number;
  /** Exclusive upper bound; undefined = the top bracket. */
  to?: number;
  /** Marginal rate as a fraction. */
  rate: number;
}

export interface StatutoryParams {
  /** BPJS and any other contribution program, keyed by `statutory_code`. */
  contributions: Record<string, ContributionParam>;
  /** PTKP (non-taxable annual income) by status code: 'TK/0', 'K/1', ... */
  ptkp: Record<string, number>;
  /** Progressive annual brackets (PPh 21 art. 17). */
  brackets: TaxBracket[];
  /**
   * TER (Tarif Efektif Rata-Rata) monthly bands per category A/B/C, introduced by PP 58/2023.
   * Each band is `{ upTo, rate }`, ordered ascending; the LAST band's `upTo` is undefined.
   *
   * Why TER exists in this engine at all: since 2024 the monthly withholding is a flat effective
   * rate on monthly gross, and the progressive bracket calculation is done ONCE, in December, as a
   * reconciliation. Modelling only the brackets would produce a monthly figure that does not match
   * anybody's payslip.
   */
  ter: Record<"A" | "B" | "C", { upTo?: number; rate: number }[]>;
  /** Surcharge multiplier applied when the employee has no NPWP (regulation sets this at 1.2). */
  noNpwpMultiplier: number;
  /** Occupational-cost deduction: a percentage of gross, capped, subtracted before tax. */
  occupationalCost: { rate: number; monthlyCap: number };
  /** THR eligibility floor, in months of service. */
  thrMinServiceMonths: number;
  /** Severance multiplier tables, by termination ground. See `severance.ts`. */
  severance?: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Input / output shapes
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface PayComponent {
  code: string;
  label: string;
  /** Signed major-unit amount. Positive adds, negative subtracts. */
  amount: number;
  taxable: boolean;
  bpjsBase: boolean;
  category:
    | "base" | "allowance" | "overtime" | "bonus" | "thr" | "leave_encashment"
    | "reimbursement" | "loan_repayment" | "unpaid_leave" | "advance" | "other_deduction";
  sourceKind?: string;
  sourceId?: string;
}

export interface PayrollEmployeeInput {
  employeeId: string;
  /** Monthly base pay in major units, already resolved from the effective-dated record. */
  baseAmount: number;
  /** Full-time equivalent; base and prorated allowances are scaled by this. */
  fte?: number;
  /** Working days in the period, and how many the employee was actually paid for. */
  workingDays?: number;
  paidDays?: number;
  /** Additional earnings and deductions beyond base. */
  components?: PayComponent[];
  /** `statutory_code`s the employee is enrolled in. Only these contributions are computed. */
  enrolledContributions?: string[];
  ptkpStatus?: string;
  terCategory?: "A" | "B" | "C";
  hasNpwp?: boolean;
  taxResident?: boolean;
  /** Set for the December reconciliation run: tax already withheld Jan..Nov, in major units. */
  ytdTaxWithheld?: number;
  /** Set for the December reconciliation run: taxable gross Jan..Nov, in major units. */
  ytdTaxableGross?: number;
}

export interface PayslipLine {
  side: "employee" | "employer";
  category: string;
  code: string;
  label: string;
  /** Signed major-unit amount. */
  amount: number;
  taxable: boolean;
  bpjsBase: boolean;
  sourceKind?: string;
  sourceId?: string;
  meta?: Record<string, unknown>;
  sortOrder: number;
}

export interface PayslipResult {
  lines: PayslipLine[];
  gross: number;
  taxableGross: number;
  bpjsBase: number;
  employeeDeductions: number;
  taxWithheld: number;
  net: number;
  employerCost: number;
  /** The engine's own workings, attached to the payslip so a disputed figure can be traced. */
  workings: Record<string, unknown>;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Money helpers — integer cents in, integer cents out
// ════════════════════════════════════════════════════════════════════════════════════════════════

const toCents = (v: number | string): number => Math.round(Number(v ?? 0) * 100);
const fromCents = (c: number): number => Math.round(c) / 100;
/** Apply a fractional rate to a cent amount, rounding half-up to the cent. */
const applyRate = (cents: number, rate: number): number => Math.round(cents * rate);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Tax
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * The monthly withholding under the TER scheme (PP 58/2023): a single effective rate looked up by
 * category and monthly gross, applied to monthly gross. No PTKP subtraction, no bracket walk — that
 * is the December reconciliation's job, and conflating the two is the most common way a "correct"
 * payroll produces a monthly figure nobody recognizes.
 */
export function terRate(params: StatutoryParams, category: "A" | "B" | "C", monthlyGross: number): number {
  const bands = params.ter?.[category];
  if (!bands?.length) return 0;
  for (const band of bands) {
    if (band.upTo === undefined || monthlyGross <= band.upTo) return band.rate;
  }
  return bands[bands.length - 1].rate;
}

/**
 * The progressive annual liability (PPh 21 art. 17) on an annual taxable income.
 *
 * Used for the December reconciliation and for any run that asks for the full calculation. Walks the
 * brackets in cents so the marginal slices sum exactly.
 */
export function progressiveAnnualTax(params: StatutoryParams, annualTaxableCents: number): number {
  if (annualTaxableCents <= 0) return 0;
  let tax = 0;
  const brackets = [...params.brackets].sort((a, b) => a.from - b.from);
  for (const bracket of brackets) {
    const fromC = toCents(bracket.from);
    const toC = bracket.to === undefined ? Infinity : toCents(bracket.to);
    if (annualTaxableCents <= fromC) break;
    const sliceTop = Math.min(annualTaxableCents, toC);
    const slice = sliceTop - fromC;
    if (slice <= 0) continue;
    tax += applyRate(slice, bracket.rate);
    if (sliceTop >= annualTaxableCents) break;
  }
  return tax;
}

export interface AnnualTaxInput {
  annualGrossCents: number;
  annualBpjsEmployeeCents: number;
  ptkpStatus: string;
  hasNpwp: boolean;
  monthsWorked: number;
}

/**
 * The full annual PPh 21 calculation: gross, less occupational cost (capped), less the employee's
 * own pension-type contributions, less PTKP, through the brackets, times the no-NPWP surcharge.
 *
 * `monthsWorked` scales the occupational-cost cap: the cap is monthly by regulation, so a partial
 * year is capped proportionally rather than at the full annual figure.
 */
export function annualIncomeTax(params: StatutoryParams, input: AnnualTaxInput): {
  taxCents: number;
  workings: Record<string, unknown>;
} {
  const occupationalCap = toCents(params.occupationalCost.monthlyCap) * Math.max(0, Math.min(12, input.monthsWorked));
  const occupational = Math.min(applyRate(input.annualGrossCents, params.occupationalCost.rate), occupationalCap);
  const netIncome = input.annualGrossCents - occupational - input.annualBpjsEmployeeCents;
  const ptkp = toCents(params.ptkp[input.ptkpStatus] ?? 0);
  // Taxable income is rounded DOWN to the nearest thousand currency units by regulation before the
  // brackets are applied. Skipping that rounding produces figures that are close but never match an
  // official calculation, which is worse than being obviously wrong.
  const taxableRaw = Math.max(0, netIncome - ptkp);
  const taxable = Math.floor(taxableRaw / 100_000) * 100_000; // 1000 major units = 100_000 cents
  const base = progressiveAnnualTax(params, taxable);
  const taxCents = input.hasNpwp ? base : applyRate(base, params.noNpwpMultiplier);
  return {
    taxCents,
    workings: {
      annualGross: fromCents(input.annualGrossCents),
      occupationalCost: fromCents(occupational),
      occupationalCostCap: fromCents(occupationalCap),
      bpjsEmployeeDeduction: fromCents(input.annualBpjsEmployeeCents),
      ptkp: fromCents(ptkp),
      taxableIncome: fromCents(taxable),
      taxBeforeSurcharge: fromCents(base),
      noNpwpSurchargeApplied: !input.hasNpwp,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Contributions
// ════════════════════════════════════════════════════════════════════════════════════════════════

export interface ContributionResult {
  code: string;
  base: number;
  employer: number;
  employee: number;
  capped: boolean;
}

/**
 * One contribution program's employer and employee amounts.
 *
 * The floor/cap window is applied to the BASE, not to the result: capping the contribution instead
 * of the wage gives a different (wrong) answer whenever floor and cap are both in play.
 */
export function computeContribution(param: ContributionParam, bpjsBaseCents: number): { employer: number; employee: number; base: number; capped: boolean } {
  let base = bpjsBaseCents;
  let capped = false;
  if (param.wageFloor !== undefined) base = Math.max(base, toCents(param.wageFloor));
  if (param.wageCap !== undefined && base > toCents(param.wageCap)) { base = toCents(param.wageCap); capped = true; }
  return {
    base,
    capped,
    employer: applyRate(base, param.employerRate ?? 0),
    employee: applyRate(base, param.employeeRate ?? 0),
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The composition
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Compute one employee's payslip for one period.
 *
 * Order matters and is not arbitrary:
 *   1. base (prorated by FTE and by paid days)
 *   2. the supplied components — these establish `gross`, `taxableGross` and `bpjsBase`
 *   3. statutory contributions, computed on `bpjsBase`, producing BOTH employee deductions and
 *      employer-side cost lines
 *   4. tax, computed on `taxableGross` (monthly TER) or reconciled annually
 *   5. non-statutory deductions (loan repayments, advances) — AFTER tax, because they are not
 *      deductible and must not reduce the taxable base
 *
 * Step 5 sitting after step 4 is the one ordering that has real money consequences. A loan
 * repayment deducted before tax would under-withhold, and the shortfall surfaces at year end as the
 * employee's problem.
 */
export function computePayslip(
  params: StatutoryParams,
  input: PayrollEmployeeInput,
  opts: { mode?: "monthly_ter" | "annual_reconcile"; periodMonths?: number } = {},
): PayslipResult {
  const mode = opts.mode ?? "monthly_ter";
  const lines: PayslipLine[] = [];
  let sortOrder = 0;
  const push = (l: Omit<PayslipLine, "sortOrder">) => { lines.push({ ...l, sortOrder: sortOrder++ }); };

  // ── 1. Base, prorated ─────────────────────────────────────────────────────────────────────────
  const fte = input.fte ?? 1;
  const workingDays = input.workingDays ?? 0;
  const paidDays = input.paidDays ?? workingDays;
  // Proration only applies when we actually know the period's shape. `workingDays = 0` means "not
  // supplied", and treating that as "worked nothing" would zero every payslip — a failure mode
  // worth being explicit about rather than discovering in a run.
  const prorationFactor = workingDays > 0 ? Math.min(1, paidDays / workingDays) : 1;
  const baseCents = Math.round(toCents(input.baseAmount) * fte * prorationFactor);

  push({
    side: "employee", category: "base", code: "base", label: "Base pay",
    amount: fromCents(baseCents), taxable: true, bpjsBase: true, sourceKind: "compensation",
    meta: { fte, workingDays, paidDays, prorationFactor: Number(prorationFactor.toFixed(4)) },
  });

  // ── 2. Components ─────────────────────────────────────────────────────────────────────────────
  // Split by sign: earnings feed the bases, deductions are held back for step 5. Reimbursements are
  // deliberately neither taxable nor bpjs-base by default (they repay an expense, they are not pay),
  // but the flag is on the component so a taxable reimbursement is still expressible.
  const deferredDeductions: PayComponent[] = [];
  let grossCents = baseCents;
  let taxableCents = baseCents;
  let bpjsBaseCents = baseCents;

  for (const component of input.components ?? []) {
    const amountCents = toCents(component.amount);
    if (amountCents < 0 || component.category === "loan_repayment" || component.category === "advance" || component.category === "other_deduction") {
      deferredDeductions.push(component);
      continue;
    }
    grossCents += amountCents;
    if (component.taxable) taxableCents += amountCents;
    if (component.bpjsBase) bpjsBaseCents += amountCents;
    push({
      side: "employee", category: component.category, code: component.code, label: component.label,
      amount: fromCents(amountCents), taxable: component.taxable, bpjsBase: component.bpjsBase,
      sourceKind: component.sourceKind, sourceId: component.sourceId,
    });
  }

  // ── 3. Statutory contributions ────────────────────────────────────────────────────────────────
  let employeeContributionCents = 0;
  let employerContributionCents = 0;
  const contributionWorkings: ContributionResult[] = [];

  for (const code of input.enrolledContributions ?? []) {
    const param = params.contributions[code];
    if (!param) continue;   // not enrolled in a program the parameter set knows about — skip, don't guess
    const result = computeContribution(param, bpjsBaseCents);
    contributionWorkings.push({
      code, base: fromCents(result.base), employer: fromCents(result.employer),
      employee: fromCents(result.employee), capped: result.capped,
    });
    if (result.employee > 0) {
      employeeContributionCents += result.employee;
      push({
        side: "employee", category: "bpjs", code, label: `${code} (employee)`,
        amount: -fromCents(result.employee), taxable: false, bpjsBase: false,
        sourceKind: "statutory", meta: { base: fromCents(result.base), rate: param.employeeRate, capped: result.capped },
      });
    }
    if (result.employer > 0) {
      employerContributionCents += result.employer;
      push({
        side: "employer", category: "bpjs", code, label: `${code} (employer)`,
        amount: fromCents(result.employer), taxable: false, bpjsBase: false,
        sourceKind: "statutory", meta: { base: fromCents(result.base), rate: param.employerRate, capped: result.capped },
      });
    }
  }

  // ── 4. Tax ────────────────────────────────────────────────────────────────────────────────────
  // Only the employee's own PENSION-type contributions (JHT, JP) reduce taxable income; the health
  // contribution does not. Rather than hard-code which codes qualify, a program qualifies when the
  // parameter set says so via a `taxDeductible` marker on the contribution — see DEFAULT_PARAMS.
  const taxDeductibleContributionCents = (input.enrolledContributions ?? []).reduce((sum, code) => {
    const param = params.contributions[code] as ContributionParam & { taxDeductible?: boolean };
    if (!param?.taxDeductible) return sum;
    return sum + computeContribution(param, bpjsBaseCents).employee;
  }, 0);

  // A non-resident is outside this regime entirely (PPh 26 — a different article, a flat rate on
  // gross with no PTKP). Refuse BEFORE computing anything, rather than producing a plausible and
  // wrong figure that would then have to be spotted by a human reading the payslip.
  if (input.taxResident === false) {
    throw new Error(
      "non-resident tax withholding is a different regime (PPh 26) and is not implemented; " +
      "set an explicit manual tax component for this employee instead of relying on the engine",
    );
  }

  let taxCents = 0;
  let taxWorkings: Record<string, unknown>;
  const ptkpStatus = input.ptkpStatus ?? "TK/0";
  const hasNpwp = input.hasNpwp ?? false;

  if (mode === "annual_reconcile") {
    const monthsWorked = opts.periodMonths ?? 12;
    const annualGross = toCents(input.ytdTaxableGross ?? 0) + taxableCents;
    const annual = annualIncomeTax(params, {
      annualGrossCents: annualGross,
      annualBpjsEmployeeCents: taxDeductibleContributionCents * monthsWorked,
      ptkpStatus, hasNpwp, monthsWorked,
    });
    // The December figure is the annual liability MINUS what has already been withheld. It can be
    // negative (an over-withholding refund), and that is a legitimate payslip line, not an error.
    taxCents = annual.taxCents - toCents(input.ytdTaxWithheld ?? 0);
    taxWorkings = { mode, ...annual.workings, alreadyWithheld: input.ytdTaxWithheld ?? 0, reconciliation: fromCents(taxCents) };
  } else {
    const category = input.terCategory ?? terCategoryFor(ptkpStatus);
    const rate = terRate(params, category, fromCents(taxableCents));
    const base = applyRate(taxableCents, rate);
    taxCents = hasNpwp ? base : applyRate(base, params.noNpwpMultiplier);
    taxWorkings = {
      mode, terCategory: category, terRate: rate,
      taxableGross: fromCents(taxableCents), taxBeforeSurcharge: fromCents(base),
      noNpwpSurchargeApplied: !hasNpwp,
    };
  }
  if (taxCents !== 0) {
    push({
      side: "employee", category: "tax", code: "pph21", label: "PPh 21",
      amount: -fromCents(taxCents), taxable: false, bpjsBase: false,
      sourceKind: "statutory", meta: taxWorkings,
    });
  }

  // ── 5. Post-tax deductions ────────────────────────────────────────────────────────────────────
  let otherDeductionCents = 0;
  for (const component of deferredDeductions) {
    const magnitude = Math.abs(toCents(component.amount));
    otherDeductionCents += magnitude;
    push({
      side: "employee", category: component.category, code: component.code, label: component.label,
      amount: -fromCents(magnitude), taxable: false, bpjsBase: false,
      sourceKind: component.sourceKind, sourceId: component.sourceId,
    });
  }

  const employeeDeductionsCents = employeeContributionCents + otherDeductionCents;
  const netCents = grossCents - employeeDeductionsCents - taxCents;
  const employerCostCents = grossCents + employerContributionCents;

  return {
    lines,
    gross: fromCents(grossCents),
    taxableGross: fromCents(taxableCents),
    bpjsBase: fromCents(bpjsBaseCents),
    employeeDeductions: fromCents(employeeDeductionsCents),
    taxWithheld: fromCents(taxCents),
    net: fromCents(netCents),
    employerCost: fromCents(employerCostCents),
    workings: { proration: { fte, workingDays, paidDays }, contributions: contributionWorkings, tax: taxWorkings },
  };
}

/**
 * The TER category implied by a PTKP status (PP 58/2023's own mapping).
 *
 * A fallback only. `hr_tax_profiles.ter_category` is the stored value and takes precedence, because
 * the mapping is itself regulated and a future change must not retroactively re-categorize past
 * runs. This function exists so a profile that predates the column still computes.
 */
export function terCategoryFor(ptkpStatus: string): "A" | "B" | "C" {
  switch (ptkpStatus) {
    case "TK/0": case "TK/1": case "K/0":
      return "A";
    case "TK/2": case "TK/3": case "K/1": case "K/2":
      return "B";
    case "K/3":
      return "C";
    default:
      // K/I/* (combined-income statuses) are not in the TER table's simple form; A is the
      // conservative fallback and the profile should carry an explicit category.
      return "A";
  }
}

/**
 * THR (Tunjangan Hari Raya) — the religious-holiday allowance, a statutory 13th-month payment.
 *
 * One month's wage at 12+ months of service, pro-rated by month below that, and nothing at all below
 * the eligibility floor. Payable no later than 7 days before the holiday, which is a scheduling
 * matter for the run, not an arithmetic one.
 */
export function computeThr(
  params: StatutoryParams,
  input: { monthlyWage: number; monthsOfService: number },
): { amount: number; eligible: boolean; workings: Record<string, unknown> } {
  const minMonths = params.thrMinServiceMonths ?? 1;
  if (input.monthsOfService < minMonths) {
    return { amount: 0, eligible: false, workings: { monthsOfService: input.monthsOfService, minMonths } };
  }
  const wageCents = toCents(input.monthlyWage);
  const amountCents = input.monthsOfService >= 12
    ? wageCents
    : Math.round((wageCents * input.monthsOfService) / 12);
  return {
    amount: fromCents(amountCents),
    eligible: true,
    workings: {
      monthsOfService: input.monthsOfService,
      prorated: input.monthsOfService < 12,
      formula: input.monthsOfService >= 12 ? "1 month wage" : `${input.monthsOfService}/12 x monthly wage`,
    },
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// ⚠ UNRATIFIED test fixture.
//
// These are the Indonesian 2026 figures as understood on 2026-08-24 from public summaries. They are
// NOT legally verified and MUST NOT be treated as authoritative. They exist so the unit tests have a
// parameter set and so a fresh tenant has something to seed and then correct. The live values belong
// in `hr_statutory_parameters`, where they carry an effective date and a ratification signature.
//
// If you are reading this because a payslip looks wrong: check `hr_payroll_runs.parameter_set_id`
// and the `ratified_by` on that set BEFORE debugging the arithmetic.
// ════════════════════════════════════════════════════════════════════════════════════════════════
export const DEFAULT_PARAMS_UNRATIFIED: StatutoryParams = {
  contributions: {
    // employer 4% / employee 1%, capped wage base.
    bpjs_kesehatan: { employerRate: 0.04, employeeRate: 0.01, wageCap: 12_000_000 },
    // JHT (old-age): employer 3.7% / employee 2%, uncapped. Employee side is tax-deductible.
    bpjs_jht: { employerRate: 0.037, employeeRate: 0.02, taxDeductible: true } as ContributionParam,
    // JP (pension): employer 2% / employee 1%, capped.
    bpjs_jp: { employerRate: 0.02, employeeRate: 0.01, wageCap: 10_547_400, taxDeductible: true } as ContributionParam,
    // JKK (accident): employer-only, rate varies by industry risk class — this is the lowest class.
    bpjs_jkk: { employerRate: 0.0024, employeeRate: 0 },
    // JKM (death): employer-only.
    bpjs_jkm: { employerRate: 0.003, employeeRate: 0 },
    // JKP (job-loss): employer + government funded, nothing from the employee.
    bpjs_jkp: { employerRate: 0.0036, employeeRate: 0 },
  },
  ptkp: {
    "TK/0": 54_000_000, "TK/1": 58_500_000, "TK/2": 63_000_000, "TK/3": 67_500_000,
    "K/0": 58_500_000, "K/1": 63_000_000, "K/2": 67_500_000, "K/3": 72_000_000,
    "K/I/0": 112_500_000, "K/I/1": 117_000_000, "K/I/2": 121_500_000, "K/I/3": 126_000_000,
  },
  brackets: [
    { from: 0, to: 60_000_000, rate: 0.05 },
    { from: 60_000_000, to: 250_000_000, rate: 0.15 },
    { from: 250_000_000, to: 500_000_000, rate: 0.25 },
    { from: 500_000_000, to: 5_000_000_000, rate: 0.30 },
    { from: 5_000_000_000, rate: 0.35 },
  ],
  ter: {
    A: [
      { upTo: 5_400_000, rate: 0 }, { upTo: 5_650_000, rate: 0.0025 }, { upTo: 5_950_000, rate: 0.005 },
      { upTo: 6_300_000, rate: 0.0075 }, { upTo: 6_750_000, rate: 0.01 }, { upTo: 7_500_000, rate: 0.02 },
      { upTo: 8_550_000, rate: 0.03 }, { upTo: 9_650_000, rate: 0.04 }, { upTo: 10_050_000, rate: 0.05 },
      { upTo: 12_000_000, rate: 0.06 }, { upTo: 16_950_000, rate: 0.08 }, { upTo: 22_000_000, rate: 0.11 },
      { upTo: 32_400_000, rate: 0.15 }, { upTo: 60_000_000, rate: 0.20 }, { rate: 0.30 },
    ],
    B: [
      { upTo: 6_200_000, rate: 0 }, { upTo: 6_500_000, rate: 0.0025 }, { upTo: 6_850_000, rate: 0.005 },
      { upTo: 7_300_000, rate: 0.0075 }, { upTo: 9_200_000, rate: 0.01 }, { upTo: 10_750_000, rate: 0.02 },
      { upTo: 11_250_000, rate: 0.03 }, { upTo: 11_600_000, rate: 0.04 }, { upTo: 12_600_000, rate: 0.05 },
      { upTo: 14_950_000, rate: 0.06 }, { upTo: 19_750_000, rate: 0.08 }, { upTo: 24_150_000, rate: 0.11 },
      { upTo: 34_750_000, rate: 0.15 }, { upTo: 66_000_000, rate: 0.20 }, { rate: 0.30 },
    ],
    C: [
      { upTo: 6_600_000, rate: 0 }, { upTo: 6_950_000, rate: 0.0025 }, { upTo: 7_350_000, rate: 0.005 },
      { upTo: 7_800_000, rate: 0.0075 }, { upTo: 8_850_000, rate: 0.01 }, { upTo: 9_800_000, rate: 0.02 },
      { upTo: 10_950_000, rate: 0.03 }, { upTo: 11_200_000, rate: 0.04 }, { upTo: 12_050_000, rate: 0.05 },
      { upTo: 15_550_000, rate: 0.06 }, { upTo: 19_400_000, rate: 0.08 }, { upTo: 25_200_000, rate: 0.11 },
      { upTo: 36_500_000, rate: 0.15 }, { upTo: 68_000_000, rate: 0.20 }, { rate: 0.30 },
    ],
  },
  noNpwpMultiplier: 1.2,
  occupationalCost: { rate: 0.05, monthlyCap: 500_000 },
  thrMinServiceMonths: 1,
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// RATE BASIS → PERIOD AMOUNT
//
// `hr_compensation.base_amount` is quoted in a unit (`rate_basis`) that is NOT necessarily the pay
// period. Before this existed, the payslip generator selected the basis and then ignored it,
// handing `base_amount` to computePayslip() as though it were always monthly — so an employee on an
// `annual` row would have been paid their entire annual salary EVERY MONTH. It never fired only
// because no compensation row has ever existed on the live estate.
//
// These two mirror the SQL functions `hr_annualisation_factor()` and `hr_periods_per_year()` in
// migration 202608260930. They are duplicated deliberately — payroll must not need a database round
// trip to convert a rate — and `payroll-rate-basis.test.ts` asserts the two copies agree, so the
// duplication cannot drift silently.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Multiplier from a quoted rate to an annual figure. NULL-equivalent (undefined) for piece_rate,
 *  which cannot be annualised from a rate alone: the annual figure depends on output, which is not
 *  in the compensation row. A guess there would be a fabricated salary. */
export function annualisationFactor(rateBasis: string): number | undefined {
  switch (rateBasis) {
    case "hourly": return 2080;   // 40h x 52w, full-time equivalent
    case "daily": return 260;     // 5d x 52w
    case "weekly": return 52;
    case "monthly": return 12;
    case "annual": return 1;
    default: return undefined;
  }
}

/** Payslips produced per year. Semi-monthly (24, fixed dates) and biweekly (26, every 14 days) are
 *  genuinely different and are the pair most often conflated. */
export function periodsPerYear(payFrequency: string): number | undefined {
  switch (payFrequency) {
    case "weekly": return 52;
    case "biweekly": return 26;
    case "semi_monthly": return 24;
    case "monthly": return 12;
    default: return undefined;
  }
}

/**
 * The gross base owed for ONE pay period, from a rate quoted in some other unit.
 *
 * Returns `undefined` rather than a number when the conversion is not defined — an unknown basis or
 * frequency, or piece_rate. The caller must SKIP AND REPORT that employee, never substitute a
 * default: a defaulted salary is indistinguishable from a computed one on the payslip, and this is
 * the one file where a plausible wrong number is worse than a visible gap.
 */
export function periodBaseAmount(
  baseAmount: number, rateBasis: string, payFrequency: string,
): number | undefined {
  const factor = annualisationFactor(rateBasis);
  const periods = periodsPerYear(payFrequency);
  if (factor === undefined || periods === undefined) return undefined;
  return (baseAmount * factor) / periods;
}
