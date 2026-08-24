// HR CONFIGURATION seed — the company's own RULES, so the HR console has something to operate on.
//
// ── WHAT THIS SEEDS, AND WHY THAT LINE IS WHERE IT IS ───────────────────────────────────────────
// Holiday calendar · leave policies · recruitment pipeline stages · pay grades · allowance types ·
// BPJS benefit plans · a statutory parameter set.
//
// **NOT A SINGLE ROW OF PERSONAL DATA.** No employees, no candidates, no compensation, no payslips.
// That boundary is deliberate and it is the reason this seed can run against the live estate at all:
// `legal/ropa.md` records the programme as "Pre-Gate-1; not yet in production with real data", and
// CLAUDE.md makes Legal Gate 1 + the day-one technical gate non-negotiable before real employee data
// is ingested. A holiday calendar is not employee data — it is a company policy that happens to live
// in the HR module. Everything on the other side of that line stays out until the gates are green.
//
// ── IDEMPOTENT, AND HONEST ABOUT WHAT IT WILL NOT OVERWRITE ─────────────────────────────────────
// Every insert is `ON CONFLICT DO NOTHING` against a natural key, and the run reports `created` vs
// `existing` per section. It will NOT re-point a calendar somebody has edited, will NOT re-open a
// ratified parameter set, and will NOT change an existing policy's numbers — a seed that silently
// rewrites a configured estate is worse than one that does nothing.
//
// ⚠ THE HR WALL IS A THIRD GUC, AND FORGETTING IT WRITES ZERO ROWS SILENTLY. Every hr_* table
// composes its policy as `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('hr')`.
// A `withTenants([t], fn)` without `{ modules: ["hr"] }` leaves `app.scopes` unset, every row fails
// the predicate, and the INSERT reports success having written nothing. Every call below passes it.
//
// ⚠ AND THE COROLLARY THAT BURNED THIS PROGRAM: `set_config(..., true)` inside `withGlobal` IS A
// NO-OP — withGlobal opens no transaction, so the GUC is discarded before the next statement. Any
// verification count must go through `withTenants`, which is why the self-check at the bottom does.
import { withTenants, withGlobal, closePool } from "../db";
import { config } from "../config";

const AGENCY_NAME = "Gaia Digital Agency";

export interface HrConfigResult {
  tenantId: string;
  calendar: { created: boolean; holidaysAdded: number };
  leavePolicies: { created: string[]; existing: string[] };
  pipelineStages: { created: string[]; existing: string[] };
  payGrades: { created: string[]; existing: string[] };
  allowanceTypes: { created: string[]; existing: string[] };
  benefitPlans: { created: string[]; existing: string[] };
  statutorySet: { created: boolean; ratified: boolean; parameters: number };
}

/**
 * Indonesian public holidays for 2026.
 *
 * ⚠ THESE ARE UNVERIFIED. Indonesian religious holidays follow the lunar calendar and the joint-leave
 *   (`cuti bersama`) days are fixed each year by a JOINT MINISTERIAL DECREE (SKB 3 Menteri) that is
 *   published late and amended. Treat this list as a STARTING SHAPE that HR corrects against the
 *   actual decree, not as an authority. The reason it is seeded at all: an empty calendar silently
 *   charges leave across public holidays, which is a worse default than a list somebody has to fix.
 *
 * `joint_leave` rows carry `deductsEntitlement: true` because a cuti bersama day is normally taken
 * out of the annual entitlement — that is the whole reason the kind exists separately from `public`.
 */
const ID_HOLIDAYS_2026: { day: string; name: string; kind: "public" | "joint_leave"; deducts?: boolean }[] = [
  { day: "2026-01-01", name: "Tahun Baru Masehi", kind: "public" },
  { day: "2026-02-17", name: "Tahun Baru Imlek", kind: "public" },
  { day: "2026-03-19", name: "Hari Suci Nyepi", kind: "public" },
  { day: "2026-03-20", name: "Cuti Bersama Nyepi", kind: "joint_leave", deducts: true },
  { day: "2026-04-03", name: "Wafat Isa Almasih", kind: "public" },
  { day: "2026-05-01", name: "Hari Buruh Internasional", kind: "public" },
  { day: "2026-05-14", name: "Kenaikan Isa Almasih", kind: "public" },
  { day: "2026-05-21", name: "Hari Raya Idul Fitri", kind: "public" },
  { day: "2026-05-22", name: "Hari Raya Idul Fitri", kind: "public" },
  { day: "2026-05-25", name: "Cuti Bersama Idul Fitri", kind: "joint_leave", deducts: true },
  { day: "2026-05-31", name: "Hari Raya Waisak", kind: "public" },
  { day: "2026-06-01", name: "Hari Lahir Pancasila", kind: "public" },
  { day: "2026-07-28", name: "Hari Raya Idul Adha", kind: "public" },
  { day: "2026-08-17", name: "Hari Kemerdekaan RI", kind: "public" },
  { day: "2026-08-18", name: "Tahun Baru Islam", kind: "public" },
  { day: "2026-10-27", name: "Maulid Nabi Muhammad", kind: "public" },
  { day: "2026-12-25", name: "Hari Raya Natal", kind: "public" },
];

/** 480 minutes = one working day, the canonical unit 0028 charges leave in. */
const DAY = 480;

export async function seedHrConfig(): Promise<HrConfigResult> {
  const site = config.originSite;

  // Resolve the tenant BY NAME and refuse to create one. Same by-name fork hazard migration
  // 202608230612 exists to fix: a seed that creates a company when it cannot find one produces a
  // SECOND company holding none of the history.
  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  const tenantId = t.rows[0]?.id;
  if (!tenantId) {
    throw new Error(
      `seedHrConfig: no company named "${AGENCY_NAME}". Refusing to create one — a by-name miss here ` +
        `forks the estate into a second company with no history (see migration 202608230612).`,
    );
  }

  const result: HrConfigResult = {
    tenantId,
    calendar: { created: false, holidaysAdded: 0 },
    leavePolicies: { created: [], existing: [] },
    pipelineStages: { created: [], existing: [] },
    payGrades: { created: [], existing: [] },
    allowanceTypes: { created: [], existing: [] },
    benefitPlans: { created: [], existing: [] },
    statutorySet: { created: false, ratified: false, parameters: 0 },
  };

  await withTenants(
    [tenantId],
    async (c) => {
      // ── 1 · Holiday calendar ────────────────────────────────────────────────────────────────
      let calendarId: string | undefined;
      const existingCal = await c.query<{ id: string }>(
        `SELECT id FROM hr_holiday_calendars WHERE is_default AND deleted_at IS NULL LIMIT 1`,
      );
      if (existingCal.rows[0]) {
        calendarId = existingCal.rows[0].id;
      } else {
        const ins = await c.query<{ id: string }>(
          `INSERT INTO hr_holiday_calendars (tenant_id, name, country_code, weekend_days, is_default, origin_site)
           VALUES ($1,'Indonesia — national','ID',ARRAY[6,7],true,$2) RETURNING id`,
          [tenantId, site],
        );
        calendarId = ins.rows[0].id;
        result.calendar.created = true;
      }
      for (const h of ID_HOLIDAYS_2026) {
        const r = await c.query(
          `INSERT INTO hr_holidays (tenant_id, calendar_id, day, name, kind, deducts_entitlement)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (tenant_id, calendar_id, day) DO NOTHING`,
          [tenantId, calendarId, h.day, h.name, h.kind, h.kind === "joint_leave" ? (h.deducts ?? true) : null],
        );
        result.calendar.holidaysAdded += r.rowCount ?? 0;
      }

      // ── 2 · Leave policies ──────────────────────────────────────────────────────────────────
      // The vacation policy encodes UU 13/2003 art. 79: 12 working days after 12 months of
      // continuous service. Sick leave is `none` on purpose — Indonesian sick leave is a
      // PAID-WAGE rule, not a counted entitlement, so an accrual would invent a limit the law
      // does not impose.
      const POLICIES = [
        {
          name: "Annual leave (statutory)", leaveType: "vacation", accrual: "upfront",
          entitlement: 12 * DAY, waiting: 12, prorate: true,
          carryMax: 6 * DAY, carryExpiry: 3, negative: false, excludesHolidays: true, notice: 7,
        },
        {
          name: "Sick leave", leaveType: "sick", accrual: "none",
          entitlement: 0, waiting: 0, prorate: false,
          carryMax: 0, carryExpiry: 0, negative: true, excludesHolidays: true, notice: 0,
        },
        {
          name: "Unpaid leave", leaveType: "unpaid", accrual: "none",
          entitlement: 0, waiting: 0, prorate: false,
          carryMax: 0, carryExpiry: 0, negative: true,
          // Counted in CALENDAR days: you are away, the employer is not paying, and a weekend in
          // the middle does not make you present.
          excludesHolidays: false, notice: 14,
        },
      ];
      for (const p of POLICIES) {
        const existing = await c.query<{ id: string }>(
          `SELECT id FROM hr_leave_policies WHERE name = $1 AND deleted_at IS NULL`, [p.name],
        );
        if (existing.rows[0]) { result.leavePolicies.existing.push(p.name); continue; }
        const ins = await c.query<{ id: string }>(
          `INSERT INTO hr_leave_policies
             (tenant_id, name, leave_type, accrual_method, annual_entitlement_minutes, waiting_period_months,
              prorate_first_year, carryover_max_minutes, carryover_expiry_months, allow_negative_balance,
              excludes_holidays, min_notice_days, origin_site)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [tenantId, p.name, p.leaveType, p.accrual, p.entitlement, p.waiting, p.prorate,
           p.carryMax, p.carryExpiry, p.negative, p.excludesHolidays, p.notice, site],
        );
        // A tenant-wide default assignment (no subject, no unit) so the accrual runner can resolve
        // a policy for everyone from day one. Person- and unit-level overrides beat it later.
        await c.query(
          `INSERT INTO hr_leave_policy_assignments (tenant_id, policy_id, effective_from)
           VALUES ($1,$2,date_trunc('year', CURRENT_DATE)::date)`,
          [tenantId, ins.rows[0].id],
        );
        result.leavePolicies.created.push(p.name);
      }

      // ── 3 · Recruitment funnel ──────────────────────────────────────────────────────────────
      const STAGES = [
        { key: "applied", label: "Applied", order: 10, terminal: false, kind: null, interview: false },
        { key: "screening", label: "Screening", order: 20, terminal: false, kind: null, interview: false },
        { key: "interview", label: "Interview", order: 30, terminal: false, kind: null, interview: true },
        { key: "technical", label: "Technical assessment", order: 40, terminal: false, kind: null, interview: true },
        { key: "final", label: "Final interview", order: 50, terminal: false, kind: null, interview: true },
        { key: "offer", label: "Offer", order: 60, terminal: false, kind: null, interview: false },
        { key: "hired", label: "Hired", order: 70, terminal: true, kind: "hired", interview: false },
        { key: "rejected", label: "Rejected", order: 80, terminal: true, kind: "rejected", interview: false },
        { key: "withdrawn", label: "Withdrawn", order: 90, terminal: true, kind: "withdrawn", interview: false },
      ];
      for (const s of STAGES) {
        const r = await c.query(
          `INSERT INTO hr_pipeline_stages (tenant_id, key, label, sort_order, is_terminal, terminal_kind, requires_interview)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, key) DO NOTHING`,
          [tenantId, s.key, s.label, s.order, s.terminal, s.kind, s.interview],
        );
        (r.rowCount ? result.pipelineStages.created : result.pipelineStages.existing).push(s.key);
      }

      // ── 4 · Pay grades ──────────────────────────────────────────────────────────────────────
      // Two tracks at comparable pay, which is the point of having `track` at all: a senior engineer
      // and a manager are peers in money and not on one ladder.
      const GRADES = [
        { code: "IC1", name: "Junior", track: "individual", level: 1, min: 5_000_000, mid: 7_000_000, max: 9_000_000 },
        { code: "IC2", name: "Mid", track: "individual", level: 2, min: 9_000_000, mid: 12_000_000, max: 15_000_000 },
        { code: "IC3", name: "Senior", track: "individual", level: 3, min: 15_000_000, mid: 20_000_000, max: 25_000_000 },
        { code: "IC4", name: "Lead", track: "individual", level: 4, min: 25_000_000, mid: 32_000_000, max: 40_000_000 },
        { code: "M1", name: "Manager", track: "management", level: 3, min: 18_000_000, mid: 24_000_000, max: 30_000_000 },
        { code: "M2", name: "Head of department", track: "management", level: 4, min: 30_000_000, mid: 40_000_000, max: 50_000_000 },
        { code: "SUP1", name: "Support", track: "support", level: 1, min: 4_500_000, mid: 6_000_000, max: 8_000_000 },
      ];
      for (const g of GRADES) {
        const r = await c.query(
          `INSERT INTO hr_pay_grades (tenant_id, code, name, track, level, min_amount, mid_amount, max_amount)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8
            WHERE NOT EXISTS (SELECT 1 FROM hr_pay_grades WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL)`,
          [tenantId, g.code, g.name, g.track, g.level, g.min, g.mid, g.max],
        );
        (r.rowCount ? result.payGrades.created : result.payGrades.existing).push(g.code);
      }

      // ── 5 · Allowance types ─────────────────────────────────────────────────────────────────
      // `taxable` and `bpjs_base` are set INDEPENDENTLY — Indonesian practice treats the two bases
      // differently per component, and collapsing them is a statutory error rather than a rounding one.
      const ALLOWANCES = [
        { code: "transport", label: "Transport allowance", dir: "allowance", taxable: true, bpjs: false, prorated: true },
        { code: "meal", label: "Meal allowance", dir: "allowance", taxable: true, bpjs: false, prorated: true },
        { code: "position", label: "Position allowance", dir: "allowance", taxable: true, bpjs: true, prorated: true },
        { code: "communication", label: "Communication allowance", dir: "allowance", taxable: true, bpjs: false, prorated: true },
        { code: "attendance", label: "Attendance incentive", dir: "allowance", taxable: true, bpjs: false, prorated: true },
        { code: "late_penalty", label: "Lateness deduction", dir: "deduction", taxable: false, bpjs: false, prorated: false },
      ];
      for (const a of ALLOWANCES) {
        const r = await c.query(
          `INSERT INTO hr_allowance_types (tenant_id, code, label, direction, calc_kind, taxable, bpjs_base, prorated)
           VALUES ($1,$2,$3,$4,'fixed',$5,$6,$7) ON CONFLICT (tenant_id, code) DO NOTHING`,
          [tenantId, a.code, a.label, a.dir, a.taxable, a.bpjs, a.prorated],
        );
        (r.rowCount ? result.allowanceTypes.created : result.allowanceTypes.existing).push(a.code);
      }

      // ── 6 · BPJS benefit plans ──────────────────────────────────────────────────────────────
      // Five separate plans, not one "BPJS" flag: each program carries a DIFFERENT rate, a different
      // cap and a different employer/employee split, and one boolean cannot express any of that.
      // The rate columns here are a DISPLAY MIRROR — the payroll engine reads the effective-dated
      // parameter set below, never these.
      const PLANS = [
        { code: "bpjs-kes", name: "BPJS Kesehatan", statutory: "bpjs_kesehatan", er: 0.04, ee: 0.01, cap: 12_000_000 },
        { code: "bpjs-jht", name: "BPJS JHT (old age)", statutory: "bpjs_jht", er: 0.037, ee: 0.02, cap: null },
        { code: "bpjs-jp", name: "BPJS JP (pension)", statutory: "bpjs_jp", er: 0.02, ee: 0.01, cap: 10_547_400 },
        { code: "bpjs-jkk", name: "BPJS JKK (accident)", statutory: "bpjs_jkk", er: 0.0024, ee: 0, cap: null },
        { code: "bpjs-jkm", name: "BPJS JKM (death)", statutory: "bpjs_jkm", er: 0.003, ee: 0, cap: null },
      ];
      for (const p of PLANS) {
        const r = await c.query(
          `INSERT INTO hr_benefit_plans (tenant_id, code, name, kind, statutory_code, employer_rate, employee_rate, wage_cap)
           VALUES ($1,$2,$3,'statutory',$4,$5,$6,$7) ON CONFLICT (tenant_id, code) DO NOTHING`,
          [tenantId, p.code, p.name, p.statutory, p.er, p.ee, p.cap],
        );
        (r.rowCount ? result.benefitPlans.created : result.benefitPlans.existing).push(p.code);
      }

      // ── 7 · Statutory parameter set — SEEDED UNRATIFIED, ON PURPOSE ─────────────────────────
      // This is the gate, expressed as data. `ratified_by` stays NULL, so the payroll runner will
      // calculate against these numbers but REFUSE to finalize a run without an explicit,
      // permanently-recorded override. Ratification is a company-administrator act at high
      // assurance and is deliberately NOT something a seed can perform.
      const existingSet = await c.query<{ id: string }>(
        `SELECT id FROM hr_statutory_parameter_sets WHERE name = $1`, ["Indonesia 2026 (seeded, UNRATIFIED)"],
      );
      if (!existingSet.rows[0]) {
        const setIns = await c.query<{ id: string }>(
          `INSERT INTO hr_statutory_parameter_sets (tenant_id, country_code, name, effective_from, source_note)
           VALUES ($1,'ID',$2,'2026-01-01',$3) RETURNING id`,
          [
            tenantId, "Indonesia 2026 (seeded, UNRATIFIED)",
            "Seeded by seed:hr-config from public summaries of PP 58/2023 (PPh 21 TER) and BPJS " +
            "rates as understood 2026-08-24. NOT legally verified. Confirm every figure with counsel " +
            "or the finance function, then ratify.",
          ],
        );
        const setId = setIns.rows[0].id;
        const params: [string, number | null, unknown, string | null][] = [
          ["bpjs.kesehatan.employer_rate", 0.04, null, "rate"],
          ["bpjs.kesehatan.employee_rate", 0.01, null, "rate"],
          ["bpjs.kesehatan.wage_cap", 12_000_000, null, "amount"],
          ["bpjs.jht.employer_rate", 0.037, null, "rate"],
          ["bpjs.jht.employee_rate", 0.02, null, "rate"],
          ["bpjs.jp.employer_rate", 0.02, null, "rate"],
          ["bpjs.jp.employee_rate", 0.01, null, "rate"],
          ["bpjs.jp.wage_cap", 10_547_400, null, "amount"],
          ["bpjs.jkk.employer_rate", 0.0024, null, "rate"],
          ["bpjs.jkm.employer_rate", 0.003, null, "rate"],
          ["bpjs.jkp.employer_rate", 0.0036, null, "rate"],
          ["pph21.no_npwp_multiplier", 1.2, null, "rate"],
          ["pph21.occupational_cost.rate", 0.05, null, "rate"],
          ["pph21.occupational_cost.monthly_cap", 500_000, null, "amount"],
          ["thr.min_service_months", 1, null, "months"],
          ["pph21.ptkp.TK/0", 54_000_000, null, "amount"],
          ["pph21.ptkp.TK/1", 58_500_000, null, "amount"],
          ["pph21.ptkp.TK/2", 63_000_000, null, "amount"],
          ["pph21.ptkp.TK/3", 67_500_000, null, "amount"],
          ["pph21.ptkp.K/0", 58_500_000, null, "amount"],
          ["pph21.ptkp.K/1", 63_000_000, null, "amount"],
          ["pph21.ptkp.K/2", 67_500_000, null, "amount"],
          ["pph21.ptkp.K/3", 72_000_000, null, "amount"],
          ["pph21.brackets", null, [
            { from: 0, to: 60_000_000, rate: 0.05 },
            { from: 60_000_000, to: 250_000_000, rate: 0.15 },
            { from: 250_000_000, to: 500_000_000, rate: 0.25 },
            { from: 500_000_000, to: 5_000_000_000, rate: 0.30 },
            { from: 5_000_000_000, rate: 0.35 },
          ], null],
        ];
        for (const [key, num, json, unit] of params) {
          await c.query(
            `INSERT INTO hr_statutory_parameters (tenant_id, set_id, key, value_num, value_json, unit)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, set_id, key) DO NOTHING`,
            [tenantId, setId, key, num, json === null ? null : JSON.stringify(json), unit],
          );
          result.statutorySet.parameters += 1;
        }
        result.statutorySet.created = true;
      } else {
        const r = await c.query<{ ratified_at: string | null }>(
          `SELECT ratified_at FROM hr_statutory_parameter_sets WHERE id = $1`, [existingSet.rows[0].id],
        );
        result.statutorySet.ratified = !!r.rows[0]?.ratified_at;
      }
    },
    { modules: ["hr"] },
  );

  return result;
}

/**
 * Self-check: re-count through `withTenants` (never `withGlobal` + set_config, which is a no-op and
 * has produced a confident wrong survey of this estate before) and refuse to report success on an
 * empty read.
 */
export async function verifyHrConfig(tenantId: string): Promise<Record<string, number>> {
  return withTenants(
    [tenantId],
    async (c) => {
      const counts: Record<string, number> = {};
      for (const table of [
        "hr_holiday_calendars", "hr_holidays", "hr_leave_policies", "hr_leave_policy_assignments",
        "hr_pipeline_stages", "hr_pay_grades", "hr_allowance_types", "hr_benefit_plans",
        "hr_statutory_parameter_sets", "hr_statutory_parameters",
      ]) {
        const r = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`);
        counts[table] = Number(r.rows[0].n);
      }
      return counts;
    },
    { modules: ["hr"] },
  );
}

if (require.main === module) {
  seedHrConfig()
    .then(async (r) => {
      console.log("[seed:hr-config] tenant", r.tenantId);
      console.log("  calendar        ", r.calendar.created ? "created" : "existing", `· ${r.calendar.holidaysAdded} holiday(s) added`);
      console.log("  leave policies  ", `created=[${r.leavePolicies.created}] existing=[${r.leavePolicies.existing}]`);
      console.log("  pipeline stages ", `created=${r.pipelineStages.created.length} existing=${r.pipelineStages.existing.length}`);
      console.log("  pay grades      ", `created=${r.payGrades.created.length} existing=${r.payGrades.existing.length}`);
      console.log("  allowance types ", `created=${r.allowanceTypes.created.length} existing=${r.allowanceTypes.existing.length}`);
      console.log("  benefit plans   ", `created=${r.benefitPlans.created.length} existing=${r.benefitPlans.existing.length}`);
      console.log("  statutory set   ", r.statutorySet.created ? `created (${r.statutorySet.parameters} params, UNRATIFIED)` : `existing (ratified=${r.statutorySet.ratified})`);
      const counts = await verifyHrConfig(r.tenantId);
      console.log("[seed:hr-config] verified through withTenants:", JSON.stringify(counts));
      if (counts.hr_leave_policies === 0 || counts.hr_pipeline_stages === 0) {
        throw new Error("[seed:hr-config] verification read ZERO rows — the hr module scope was not open. Nothing was written.");
      }
      console.log(
        "\n⚠ The statutory parameter set is UNRATIFIED by design. Payroll will calculate against it " +
        "but refuse to finalize a run without a recorded override. Verify every figure, then ratify " +
        "it from /hr/settings (company administrator, high assurance).",
      );
      await closePool();
    })
    .catch(async (e) => {
      console.error("[seed:hr-config] FAILED:", e instanceof Error ? e.message : e);
      await closePool();
      process.exit(1);
    });
}
