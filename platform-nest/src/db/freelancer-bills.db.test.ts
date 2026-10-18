// DW-10f-1 (BFF §61.2 "The time and payables half", §61.12, §61.14) — migration 202610181101_freelancer_bills.sql against a
// REAL Postgres.
//
// What it proves, each refusal by its SQLSTATE:
//   * time_entries_ap_bill_guard: a claimed entry's minutes, date, project, person and deletion are frozen while notes and
//     billable still change (PD615); a claim needs a finance-scoped session, a draft freelancer bill of this company made for
//     this person whose period holds the date, and never moves; a release needs the bill gone or void (PD616); a
//     cross-company claim is refused; two concurrent claims of one entry: exactly one wins;
//   * discarding a draft (deleting the AP bill) releases its entries through the FK and takes the freelancer row with it;
//     voiding a bill releases them (finance_ap_bills_release_hours); an approved bill cannot be deleted (PD617);
//   * finance_ap_vendors.user_id: one live vendor per person and company; finance_freelancer_rates: no overlap (EXCLUDE);
//   * the zero-row trap: without the finance scope the two new tables read nothing, and the claim is refused rather than
//     silently allowed;
//   * the migration applies a second time, every assertion holding, with no row changed.
// Everything runs as the NOSUPERUSER NOBYPASSRLS app role inside withTenants, except `adminPool()` (superuser), used only to
// read what is really stored and to re-apply the migration. Needs DATABASE_URL_TEST (the Linux gate); skips without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "./index";
import { config } from "../config";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createProject } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/202610181101_freelancer_bills.sql");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

describe.skipIf(!TEST_URL)("DW-10f-1 · time_entries.ap_bill_id, freelancer rates and bills (202610181101)", () => {
  let A: string;
  let B: string;
  let F: string; // a freelancer with a vendor
  let G: string; // another person
  let actor: string;
  let P: string; // a project of A
  let PB: string; // a project of B
  let expenseA: string;
  let vendorF: string;
  let vendorFB: string; // F's vendor at B
  let seq = 0;

  const fin = <T>(fn: (c: PoolClient) => Promise<T>, tenant = A) => withTenants([tenant], fn, { modules: ["finance"] });
  const plain = <T>(fn: (c: PoolClient) => Promise<T>, tenant = A) => withTenants([tenant], fn);

  async function setupFinance(tenant: string) {
    await fin(async (c) => {
      await c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1, 'IDR', 'IDR')`, [tenant]);
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [tenant]);
      const fy = newId();
      await c.query(`INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date) VALUES ($1, $2, 'FY2026', '2026-01-01', '2027-01-01')`, [fy, tenant]);
      await c.query(`SELECT finance_generate_periods($1, 'monthly')`, [fy]);
    }, tenant);
  }
  async function entry(user: string, date: string, o: { tenant?: string; project?: string; minutes?: number } = {}) {
    const id = newId();
    const tenant = o.tenant ?? A;
    await plain((c) => c.query(
      `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, entry_date, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenant, user, o.project ?? P, o.minutes ?? 60, date, config.originSite],
    ), tenant);
    return id;
  }
  /** A draft freelancer AP bill (the AP bill, one line, and its finance_freelancer_bills row), as 10f-4a's draft writes it. */
  async function draftBill(user: string, vendor: string, start: string, end: string, tenant = A) {
    const id = newId();
    const expense = tenant === A ? expenseA
      : (await fin((c) => c.query<{ id: string }>(`SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = '6600'`, [tenant]), tenant)).rows[0].id;
    await fin(async (c) => {
      await c.query(
        `INSERT INTO finance_ap_bills (id, tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code, subtotal, total, amount_payable, notes)
         VALUES ($1, $2, $3, $4, $5::date, $5::date + 30, 'IDR', 100000, 100000, 100000, 'Freelancer hours')`,
        [id, tenant, vendor, `FB-${++seq}`, end],
      );
      await c.query(
        `INSERT INTO finance_ap_bill_lines (tenant_id, bill_id, line_no, description, quantity, unit_price, line_subtotal, expense_account_id)
         VALUES ($1, $2, 1, 'Project · 1 h × 100000', 1, 100000, 100000, $3)`,
        [tenant, id, expense],
      );
      await c.query(
        `INSERT INTO finance_freelancer_bills (bill_id, tenant_id, user_id, vendor_id, period_start, period_end, minutes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, 60, $7)`,
        [id, tenant, user, vendor, start, end, actor],
      );
    }, tenant);
    return id;
  }
  const claim = (te: string, bill: string, o: { finance?: boolean; tenant?: string } = {}) =>
    withTenants([o.tenant ?? A], (c) => c.query(`UPDATE time_entries SET ap_bill_id = $2 WHERE id = $1`, [te, bill]),
      o.finance === false ? undefined : { modules: ["finance"] });
  const billOf = async (te: string) =>
    (await adminPool().query<{ ap_bill_id: string | null }>(`SELECT ap_bill_id FROM time_entries WHERE id = $1`, [te])).rows[0].ap_bill_id;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("DW-10f-1 Agency", ["finance"]);
    B = await createCompany("DW-10f-1 Other company", ["finance"]);
    F = await createUser("freelancer.f@dw10f1.test");
    G = await createUser("person.g@dw10f1.test");
    actor = await createUser("finance.manager@dw10f1.test");
    P = await createProject(A, "DW-10f-1 project");
    PB = await createProject(B, "DW-10f-1 project at B");
    await setupFinance(A);
    await setupFinance(B);
    expenseA = (await fin((c) => c.query<{ id: string }>(`SELECT id FROM finance_accounts WHERE tenant_id = $1 AND code = '6600'`, [A]))).rows[0].id;
    vendorF = newId();
    vendorFB = newId();
    await fin((c) => c.query(`INSERT INTO finance_ap_vendors (id, tenant_id, code, name, user_id) VALUES ($1, $2, 'FL-F', 'Freelancer F', $3)`, [vendorF, A, F]));
    await fin((c) => c.query(`INSERT INTO finance_ap_vendors (id, tenant_id, code, name, user_id) VALUES ($1, $2, 'FL-F', 'Freelancer F', $3)`, [vendorFB, B, F]), B);
  }, 120_000);
  afterAll(teardownTestDb);

  // ── the vendor link and the rates ───────────────────────────────────────────────────────────────────────────────────
  describe("the vendor link and the rates", () => {
    it("one live vendor per person and company; an archived one does not block; another company may link the same person", async () => {
      await expect(fin((c) => c.query(`INSERT INTO finance_ap_vendors (id, tenant_id, code, name, user_id) VALUES ($1, $2, 'FL-F2', 'F again', $3)`, [newId(), A, F])))
        .rejects.toThrow(/ux_finance_ap_vendors_user_live/);
      const archived = newId();
      await fin((c) => c.query(`INSERT INTO finance_ap_vendors (id, tenant_id, code, name, user_id, deleted_at) VALUES ($1, $2, 'FL-G-OLD', 'G old', $3, now())`, [archived, A, G]));
      await fin((c) => c.query(`INSERT INTO finance_ap_vendors (id, tenant_id, code, name, user_id) VALUES ($1, $2, 'FL-G', 'G', $3)`, [newId(), A, G]));
    });

    it("no two rates of one person overlap (EXCLUDE, both ends inclusive, an open rate runs on); the CHECKs hold", async () => {
      const rate = (user: string, from: string, to: string | null, extra: Record<string, unknown> = {}) => fin((c) => {
        const row: Record<string, unknown> = {
          tenant_id: A, user_id: user, hourly_rate: "100000", currency_code: "IDR", expense_account_code: "6600",
          valid_from: from, valid_to: to, created_by: actor, ...extra,
        };
        const names = Object.keys(row);
        return c.query(`INSERT INTO finance_freelancer_rates (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`, names.map((n) => row[n]));
      });
      await rate(F, "2026-01-01", "2026-03-15");
      await expect(rate(F, "2026-03-15", null)).rejects.toMatchObject({ code: "23P01" }); // shares the last day
      await rate(F, "2026-03-16", null);
      await expect(rate(F, "2030-01-01", null)).rejects.toMatchObject({ code: "23P01" }); // inside the open rate
      await rate(G, "2026-03-01", null); // another person is independent
      await expect(rate(F, "2025-01-01", "2024-12-31")).rejects.toThrow(/ck_finance_freelancer_rates_valid/);
      await expect(rate(F, "2020-01-01", "2020-01-31", { hourly_rate: "0" })).rejects.toThrow(/ck_finance_freelancer_rates_rate/);
      await expect(rate(F, "2020-01-01", "2020-01-31", { expense_account_code: " " })).rejects.toThrow(/ck_finance_freelancer_rates_account/);
      await expect(rate(F, "2020-01-01", "2020-01-31", { note: "x".repeat(501) })).rejects.toThrow(/ck_finance_freelancer_rates_note/);
    });
  });

  // ── the claim ───────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the claim (PD616) and the freeze (PD615)", () => {
    it("refuses a claim without the finance scope, of another person, outside the period, onto a non-freelancer bill, or born claimed", async () => {
      const t = await entry(F, "2026-03-10");
      const tG = await entry(G, "2026-03-10");
      const tLate = await entry(F, "2026-04-01");
      const bill = await draftBill(F, vendorF, "2026-03-01", "2026-03-31");
      await expect(claim(t, bill, { finance: false })).rejects.toMatchObject({ code: "PD616" });
      await expect(claim(tG, bill)).rejects.toMatchObject({ code: "PD616" });
      await expect(claim(tLate, bill)).rejects.toMatchObject({ code: "PD616" });
      // A manual AP bill (no finance_freelancer_bills row).
      const manual = newId();
      await fin((c) => c.query(
        `INSERT INTO finance_ap_bills (id, tenant_id, vendor_id, bill_no, bill_date, due_date, currency_code, subtotal, total, amount_payable)
         VALUES ($1, $2, $3, 'MANUAL-1', '2026-03-31', '2026-04-30', 'IDR', 1, 1, 1)`, [manual, A, vendorF]));
      await expect(claim(t, manual)).rejects.toMatchObject({ code: "PD616" });
      await expect(fin((c) => c.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, entry_date, origin_site, ap_bill_id) VALUES ($1, $2, $3, $4, 60, '2026-03-12', $5, $6)`,
        [newId(), A, F, P, config.originSite, bill]))).rejects.toMatchObject({ code: "PD616" });
      // A deleted entry is not billed.
      const gone = await entry(F, "2026-03-13");
      await plain((c) => c.query(`UPDATE time_entries SET deleted_at = now() WHERE id = $1`, [gone]));
      await expect(claim(gone, bill)).rejects.toMatchObject({ code: "PD616" });
      expect(await billOf(t)).toBeNull();
    });

    it("a claimed entry is frozen (PD615) except notes and billable; release needs finance scope and a gone or void bill (PD616); no move", async () => {
      const t = await entry(F, "2026-03-10");
      const bill = await draftBill(F, vendorF, "2026-03-01", "2026-03-31");
      await claim(t, bill);
      expect(await billOf(t)).toBe(bill);
      for (const set of ["minutes = 30", "entry_date = '2026-03-11'", `project_id = '${P}'::uuid, minutes = 61`, `user_id = '${G}'`, "deleted_at = now()"]) {
        await expect(plain((c) => c.query(`UPDATE time_entries SET ${set} WHERE id = $1`, [t])), set).rejects.toMatchObject({ code: "PD615" });
      }
      await expect(plain((c) => c.query(`DELETE FROM time_entries WHERE id = $1`, [t]))).rejects.toMatchObject({ code: "PD615" });
      await expect(plain((c) => c.query(`UPDATE time_entries SET notes = 'reworded', billable = true WHERE id = $1`, [t]))).resolves.toBeDefined();
      await expect(plain((c) => c.query(`UPDATE time_entries SET ap_bill_id = NULL WHERE id = $1`, [t]))).rejects.toMatchObject({ code: "PD616" });
      await expect(fin((c) => c.query(`UPDATE time_entries SET ap_bill_id = NULL WHERE id = $1`, [t]))).rejects.toMatchObject({ code: "PD616" }); // bill is a live draft
      const other = await draftBill(F, vendorF, "2026-03-01", "2026-03-31");
      await expect(claim(t, other)).rejects.toMatchObject({ code: "PD616" }); // a move
      expect(await billOf(t)).toBe(bill);
    });

    it("refuses a cross-company claim, even with both companies in the tenant set", async () => {
      const t = await entry(F, "2026-03-10");
      const billB = await draftBill(F, vendorFB, "2026-03-01", "2026-03-31", B);
      await expect(claim(t, billB)).rejects.toMatchObject({ code: "PD616" });
      await expect(withTenants([A, B], (c) => c.query(`UPDATE time_entries SET ap_bill_id = $2 WHERE id = $1`, [t, billB]),
        { modules: ["finance"], crossRoot: { reason: "DW-10f-1 test: a cross-company time claim with both companies visible is still refused" } }))
        .rejects.toMatchObject({ code: "PD616" });
      // B's session cannot see A's entry at all.
      expect((await claim(t, billB, { tenant: B })).rowCount).toBe(0);
      expect(await billOf(t)).toBeNull();
      // B's own entry is claimable by B's bill.
      const tB = await entry(F, "2026-03-10", { tenant: B, project: PB });
      await claim(tB, billB, { tenant: B });
      expect(await billOf(tB)).toBe(billB);
    });

    it("two concurrent claims of one entry: exactly one wins", async () => {
      const t = await entry(F, "2026-03-20");
      const x = await draftBill(F, vendorF, "2026-03-01", "2026-03-31");
      const y = await draftBill(F, vendorF, "2026-03-01", "2026-03-31");
      const sql = `UPDATE time_entries SET ap_bill_id = $2 WHERE id = $1 AND ap_bill_id IS NULL`;
      const results = await Promise.allSettled([
        fin(async (c) => {
          const r = await c.query(sql, [t, x]);
          await c.query("SELECT pg_sleep(0.4)");
          return r.rowCount;
        }),
        (async () => {
          await sleep(120);
          return fin(async (c) => (await c.query(sql, [t, y])).rowCount);
        })(),
      ]);
      const counts = results.map((r) => (r.status === "fulfilled" ? r.value : `rejected ${codeOf(r.reason)}`));
      expect(counts.slice().sort()).toEqual([0, 1]);
      expect(await billOf(t)).toBe(counts[0] === 1 ? x : y);
    });
  });

  // ── discard, void, delete ───────────────────────────────────────────────────────────────────────────────────────────
  describe("discard, void and delete", () => {
    it("discarding a draft (deleting its AP bill) releases its entries and removes its freelancer row and lines", async () => {
      const t1 = await entry(F, "2026-05-04");
      const t2 = await entry(F, "2026-05-05");
      const bill = await draftBill(F, vendorF, "2026-05-01", "2026-05-31");
      await claim(t1, bill);
      await claim(t2, bill);
      await fin((c) => c.query(`DELETE FROM finance_ap_bills WHERE id = $1`, [bill]));
      expect([await billOf(t1), await billOf(t2)]).toEqual([null, null]);
      const left = await adminPool().query(
        `SELECT (SELECT count(*)::int FROM finance_freelancer_bills WHERE bill_id = $1) AS fb,
                (SELECT count(*)::int FROM finance_ap_bill_lines WHERE bill_id = $1) AS lines`, [bill]);
      expect(left.rows[0]).toEqual({ fb: 0, lines: 0 });
      // The released entries are billable again, by the next draft.
      const again = await draftBill(F, vendorF, "2026-05-01", "2026-05-31");
      await claim(t1, again);
      expect(await billOf(t1)).toBe(again);
    });

    it("an approved bill cannot be deleted (PD617) and cannot take a new claim; voiding it releases its entries", async () => {
      const t = await entry(F, "2026-06-10");
      const bill = await draftBill(F, vendorF, "2026-06-01", "2026-06-30");
      await claim(t, bill);
      await fin((c) => c.query(`SELECT finance_ap_approve_bill($1, $2)`, [bill, actor]));
      expect((await adminPool().query(`SELECT status FROM finance_ap_bills WHERE id = $1`, [bill])).rows[0].status).toBe("approved");
      await expect(fin((c) => c.query(`DELETE FROM finance_ap_bills WHERE id = $1`, [bill]))).rejects.toMatchObject({ code: "PD617" });
      const late = await entry(F, "2026-06-11");
      await expect(claim(late, bill)).rejects.toMatchObject({ code: "PD616" });
      // An approved bill's entries stay frozen.
      await expect(plain((c) => c.query(`UPDATE time_entries SET minutes = 1 WHERE id = $1`, [t]))).rejects.toMatchObject({ code: "PD615" });
      await fin((c) => c.query(`UPDATE finance_ap_bills SET status = 'void', updated_at = now() WHERE id = $1`, [bill]));
      expect(await billOf(t)).toBeNull();
      await expect(plain((c) => c.query(`UPDATE time_entries SET minutes = 1 WHERE id = $1`, [t]))).resolves.toBeDefined();
    });
  });

  // ── RLS ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  describe("RLS (§61.12)", () => {
    it("the zero-row trap: the two tables read nothing without the finance scope, or with no tenant set", async () => {
      const real = await adminPool().query(
        `SELECT (SELECT count(*)::int FROM finance_freelancer_rates) AS r, (SELECT count(*)::int FROM finance_freelancer_bills) AS b`);
      expect(real.rows[0].r).toBeGreaterThan(0);
      expect(real.rows[0].b).toBeGreaterThan(0);
      const count = `SELECT (SELECT count(*)::int FROM finance_freelancer_rates) AS r, (SELECT count(*)::int FROM finance_freelancer_bills) AS b`;
      expect((await plain((c) => c.query(count))).rows[0]).toEqual({ r: 0, b: 0 });
      expect((await withTenants([], (c) => c.query(count), { modules: ["finance"] })).rows[0]).toEqual({ r: 0, b: 0 });
      expect((await fin((c) => c.query(count))).rows[0].b).toBeGreaterThan(0);
      // And B's finance session reads none of A's.
      expect((await fin((c) => c.query(`SELECT count(*)::int AS n FROM finance_freelancer_bills WHERE tenant_id = $1`, [A]), B)).rows[0].n).toBe(0);
    });

    it("without the finance scope a session cannot release a claim it cannot see the bill of (no fail-open)", async () => {
      const t = await entry(F, "2026-07-01");
      const bill = await draftBill(F, vendorF, "2026-07-01", "2026-07-31");
      await claim(t, bill);
      // The plain session sees the entry but not the bill; it must not read that as "gone".
      expect((await plain((c) => c.query(`SELECT count(*)::int AS n FROM finance_ap_bills WHERE id = $1`, [bill]))).rows[0].n).toBe(0);
      await expect(plain((c) => c.query(`UPDATE time_entries SET ap_bill_id = NULL WHERE id = $1`, [t]))).rejects.toMatchObject({ code: "PD616" });
      expect(await billOf(t)).toBe(bill);
    });
  });

  // ── the migration ───────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the migration", () => {
    it("applies a second time: every assertion holds and no row changes", async () => {
      const snapshot = async () => (await adminPool().query(
        `SELECT (SELECT coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'bill', t.ap_bill_id, 'm', t.minutes) ORDER BY t.id), '[]') FROM time_entries t) AS te,
                (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM finance_freelancer_rates r) AS rates,
                (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.bill_id), '[]') FROM finance_freelancer_bills b) AS bills,
                (SELECT coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'u', v.user_id) ORDER BY v.id), '[]') FROM finance_ap_vendors v) AS vendors`,
      )).rows[0];
      const before = await snapshot();
      const c = await adminPool().connect();
      try {
        await c.query("BEGIN");
        await c.query(readFileSync(MIGRATION, "utf8"));
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      expect(await snapshot()).toEqual(before);
    });
  });
});
