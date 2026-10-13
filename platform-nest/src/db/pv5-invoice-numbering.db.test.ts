// PV5-04b — migration 202610132100_pv5_invoice_numbering.sql, proven against a REAL Postgres (ruling PV-D35).
//
// The monthly counter, the code lookup and its generation, and the immutability of both a code and an issued invoice's
// service line. The HTTP behaviour (readiness, the issued number, the portal and the staff decode) is in
// modules/invoice/invoice-numbering.test.ts.
//
// Everything runs as the NOSUPERUSER NOBYPASSRLS app role (the harness repoints the app pool at it); `adminPool()` reads
// ground truth past RLS and tries the writes the app role may not make. Needs DATABASE_URL_TEST (the Linux gate); a
// skipped run proves nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { NUMBER_CODE_ALPHABET } from "../modules/invoice/billing-numbering";

describe.skipIf(!TEST_URL)("PV5-04b — invoice numbering data model", () => {
  let A: string;
  let B: string;
  let user: string;
  let seq = 0;

  const code = (t: string, line: string, bt: string) =>
    withTenants([t], async (c) => (await c.query<{ c: string }>(`SELECT billing_number_code($1, $2, $3) AS c`, [t, line, bt])).rows[0].c);
  const nextMonthly = (t: string, series: string, y: number, m: number) =>
    withTenants([t], async (c) => (await c.query<{ n: number }>(`SELECT next_document_no($1, $2, $3, $4::smallint) AS n`, [t, series, y, m])).rows[0].n);
  const nextYearly = (t: string, series: string, y: number) =>
    withTenants([t], async (c) => (await c.query<{ n: number }>(`SELECT next_document_no($1, $2, $3) AS n`, [t, series, y])).rows[0].n);
  async function line(t: string, key: string, extra: Record<string, unknown> = {}) {
    await withTenants([t], (c) =>
      c.query(`INSERT INTO billing_service_lines (id, tenant_id, key, name, department_id) VALUES ($1, $2, $3, $4, $5)`,
        [newId(), t, key, extra.name ?? `Line ${key}`, extra.departmentId ?? null]),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV5-04b Co A", ["finance"]);
    B = await createCompany("PV5-04b Co B", ["finance"]);
    user = await createUser("pv504b@schema.test");
    await line(A, "design");
    await line(A, "build");
    await line(A, "support");
    await line(B, "design");
  }, 120_000);
  afterAll(teardownTestDb);

  // ── the shape ───────────────────────────────────────────────────────────────────────────────────
  describe("shape", () => {
    it("both new tables have RLS enabled AND forced, with the tenant_isolation policy; an unset tenant reads ZERO rows", async () => {
      for (const t of ["billing_service_lines", "billing_number_codes"]) {
        const rls = await adminPool().query<{ on: boolean; forced: boolean }>(
          `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass`, [t],
        );
        expect(rls.rows[0], t).toEqual({ on: true, forced: true });
        expect((await adminPool().query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`, [t])).rowCount, t).toBe(1);
      }
      await code(A, "design", "hotel"); // a row exists
      // The RLS zero-row trap: no tenant GUC set means nothing is visible, and nothing raises.
      const rows = await withTenants([A, B], async (c) => {
        await c.query(`SELECT set_config('app.current_tenant_ids', '', true)`);
        return (await c.query(`SELECT * FROM billing_number_codes`)).rows;
      });
      expect(rows).toEqual([]);
      // And company B cannot see company A's codes.
      expect((await withTenants([B], (c) => c.query(`SELECT * FROM billing_number_codes`))).rows).toEqual([]);
    });

    it("document_series is keyed by (tenant, series, year, month) and month defaults to 0, the legacy yearly counter", async () => {
      const pk = await adminPool().query<{ cols: string }>(
        `SELECT string_agg(a.attname, ',' ORDER BY k.ord) AS cols
           FROM pg_constraint pc CROSS JOIN LATERAL unnest(pc.conkey) WITH ORDINALITY AS k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = pc.conrelid AND a.attnum = k.attnum
          WHERE pc.conname = 'document_series_pkey' AND pc.conrelid = 'document_series'::regclass`,
      );
      expect(pk.rows[0].cols).toBe("tenant_id,series,year,month");
      const def = await adminPool().query<{ d: string }>(
        `SELECT pg_get_expr(d.adbin, d.adrelid) AS d FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
          WHERE d.adrelid = 'document_series'::regclass AND a.attname = 'month'`,
      );
      expect(def.rows[0].d).toBe("0");
    });

    it("a service line key and a code are format-checked, and a key is unique per company", async () => {
      await expect(line(A, "Bad-Key")).rejects.toThrow(/billing_service_lines_key_format/);
      await expect(line(A, "x")).rejects.toThrow(/billing_service_lines_key_format/);
      await expect(line(A, "design")).rejects.toThrow(/ux_billing_service_lines_tenant_key/);
      for (const bad of ["abc", "A", "ABCDE", "A-B", "a1b"]) {
        await expect(
          adminPool().query(`INSERT INTO billing_number_codes (tenant_id, service_line_key, business_type, code) VALUES ($1, 'design', $2, $3)`, [A, `bt${++seq}`, bad]),
          bad,
        ).rejects.toThrow(/billing_number_codes_code_format/);
      }
    });
  });

  // ── the monthly counter ─────────────────────────────────────────────────────────────────────────
  describe("next_document_no(tenant, series, year, month)", () => {
    it("counts per (company, series, year, MONTH): a new month restarts at 1, months and years are independent", async () => {
      const co = await createCompany("PV5-04b Monthly Co");
      expect([await nextMonthly(co, "invoice", 2031, 10), await nextMonthly(co, "invoice", 2031, 10), await nextMonthly(co, "invoice", 2031, 10)]).toEqual([1, 2, 3]);
      expect(await nextMonthly(co, "invoice", 2031, 11)).toBe(1);
      expect(await nextMonthly(co, "invoice", 2032, 10)).toBe(1);
      expect(await nextMonthly(co, "invoice", 2031, 10)).toBe(4);
      expect(await nextMonthly(co, "credit_note", 2031, 10)).toBe(1);
      const other = await createCompany("PV5-04b Monthly Other Co");
      expect(await nextMonthly(other, "invoice", 2031, 10)).toBe(1);
    });

    it("the 3-argument function keeps counting the YEARLY series (month 0), separate from every monthly counter", async () => {
      const co = await createCompany("PV5-04b Yearly Co");
      expect([await nextYearly(co, "receipt", 2031), await nextYearly(co, "receipt", 2031)]).toEqual([1, 2]);
      expect(await nextMonthly(co, "receipt", 2031, 3)).toBe(1);
      expect(await nextYearly(co, "receipt", 2031)).toBe(3);
      const rows = await adminPool().query<{ month: number; next_no: number }>(
        `SELECT month, next_no FROM document_series WHERE tenant_id = $1 AND series = 'receipt' AND year = 2031 ORDER BY month`, [co],
      );
      expect(rows.rows).toEqual([{ month: 0, next_no: 4 }, { month: 3, next_no: 2 }]);
    });

    it("the month is range-checked, and a rolled-back transaction returns its monthly number", async () => {
      const co = await createCompany("PV5-04b Range Co");
      await expect(nextMonthly(co, "invoice", 2031, 13)).rejects.toThrow(/document_series_month_range/);
      await expect(
        withTenants([co], async (c) => {
          expect((await c.query<{ n: number }>(`SELECT next_document_no($1,'invoice',2031,7::smallint) AS n`, [co])).rows[0].n).toBe(1);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await nextMonthly(co, "invoice", 2031, 7)).toBe(1);
    });

    it("ten parallel callers in one month get ten distinct consecutive numbers", async () => {
      const co = await createCompany("PV5-04b Parallel Co");
      const got = await Promise.all(Array.from({ length: 10 }, () => nextMonthly(co, "invoice", 2031, 5)));
      expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });
  });

  // ── the code lookup ─────────────────────────────────────────────────────────────────────────────
  describe("billing_number_code(tenant, service line, business type)", () => {
    it("generates a 3-character code from the unambiguous alphabet, and returns the SAME code every time after", async () => {
      const first = await code(A, "build", "restaurant");
      expect(first).toMatch(/^[2-9A-HJKMNP-Z]{3}$/);
      for (const ch of first) expect(NUMBER_CODE_ALPHABET).toContain(ch);
      expect(first).not.toMatch(/[O0I1L]/);
      expect([await code(A, "build", "restaurant"), await code(A, "build", "restaurant")]).toEqual([first, first]);
    });

    it("codes are unique per company and NOT derived from the key or the business type", async () => {
      const co = await createCompany("PV5-04b Codes Co");
      const keys = ["design", "build", "support", "consulting", "training", "hosting"];
      const types = ["hotel", "restaurant", "hospital", "spa", "agency", "retail"];
      for (const k of keys) await line(co, k);
      const seen = new Map<string, string>();
      for (const k of keys) {
        for (const bt of types) {
          const c = await code(co, k, bt);
          expect(seen.has(c), `${c} reused for ${k}/${bt} and ${seen.get(c)}`).toBe(false);
          seen.set(c, `${k}/${bt}`);
          // Not mnemonic: never the key's or the type's initials, in any case.
          expect([k.slice(0, 3).toUpperCase(), bt.slice(0, 3).toUpperCase(), (k[0] + bt[0]).toUpperCase()]).not.toContain(c);
        }
      }
      expect(seen.size).toBe(keys.length * types.length);
      // The same pair in ANOTHER company is that company's own code (not shared, no global table).
      expect((await withTenants([B], (c) => c.query(`SELECT 1 FROM billing_number_codes`))).rowCount).toBe(0);
    });

    it("concurrent FIRST uses of one pair agree on ONE code, and exactly one row exists", async () => {
      const co = await createCompany("PV5-04b Race Co");
      await line(co, "design");
      const got = await Promise.all(Array.from({ length: 12 }, () => code(co, "design", "spa")));
      expect(new Set(got).size).toBe(1);
      const rows = await adminPool().query(`SELECT code FROM billing_number_codes WHERE tenant_id = $1 AND service_line_key = 'design' AND business_type = 'spa'`, [co]);
      expect(rows.rows).toEqual([{ code: got[0] }]);
    });

    it("concurrent first uses of DIFFERENT pairs each get their own distinct code", async () => {
      const co = await createCompany("PV5-04b Race Many Co");
      await line(co, "design");
      const types = ["hotel", "restaurant", "hospital", "spa", "agency", "services", "retail", "ecommerce"];
      const got = await Promise.all(types.map((bt) => code(co, "design", bt)));
      expect(new Set(got).size).toBe(types.length);
    });

    it("a code is generated INSIDE the caller's transaction: a rollback leaves no code behind", async () => {
      const co = await createCompany("PV5-04b Rollback Co");
      await line(co, "design");
      await expect(
        withTenants([co], async (c) => {
          await c.query(`SELECT billing_number_code($1, 'design', 'hotel')`, [co]);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect((await adminPool().query(`SELECT 1 FROM billing_number_codes WHERE tenant_id = $1`, [co])).rowCount).toBe(0);
    });

    it("a pair names a service line of THIS company: another company's line is refused", async () => {
      await expect(code(B, "build", "hotel")).rejects.toThrow(/fk_billing_number_codes_service_line/);
    });

    it("it cannot mint a code for another company (the policy's WITH CHECK)", async () => {
      await expect(withTenants([B], (c) => c.query(`SELECT billing_number_code($1, 'design', 'hotel')`, [A]))).rejects.toThrow();
    });
  });

  // ── a code never changes ────────────────────────────────────────────────────────────────────────
  describe("a code, once assigned, is a record", () => {
    it("UPDATE is refused by the trigger (any column), even for the owner", async () => {
      const c0 = await code(A, "support", "hotel");
      for (const set of ["code = 'ZZZ'", "business_type = 'spa'", "service_line_key = 'design'"]) {
        await expect(
          adminPool().query(`UPDATE billing_number_codes SET ${set} WHERE tenant_id = $1 AND code = $2`, [A, c0]),
          set,
        ).rejects.toThrow(/PV5_NUMBER_CODE_IMMUTABLE/);
      }
      expect(await code(A, "support", "hotel")).toBe(c0);
    });

    it("a code cannot be DELETED either (a freed code could be handed to another pair): refused for the app role and the owner", async () => {
      const c0 = await code(A, "support", "hotel");
      await expect(withTenants([A], (c) => c.query(`DELETE FROM billing_number_codes WHERE code = $1`, [c0]))).rejects.toThrow(/PV5_NUMBER_CODE_IMMUTABLE/);
      await expect(adminPool().query(`DELETE FROM billing_number_codes WHERE tenant_id = $1 AND code = $2`, [A, c0])).rejects.toThrow(/PV5_NUMBER_CODE_IMMUTABLE/);
      await expect(withTenants([A], (c) => c.query(`UPDATE billing_number_codes SET code = 'ZZZ' WHERE code = $1`, [c0]))).rejects.toThrow(/PV5_NUMBER_CODE_IMMUTABLE/);
      expect(await code(A, "support", "hotel")).toBe(c0);
    });

    it("a service line that a code stands on cannot be deleted (the FK), only switched off", async () => {
      await code(A, "support", "hotel");
      await expect(adminPool().query(`DELETE FROM billing_service_lines WHERE tenant_id = $1 AND key = 'support'`, [A])).rejects.toThrow(/fk_billing_number_codes_service_line/);
      await withTenants([A], (c) => c.query(`UPDATE billing_service_lines SET active = false WHERE key = 'support'`));
      await withTenants([A], (c) => c.query(`UPDATE billing_service_lines SET active = true WHERE key = 'support'`));
    });
  });

  // ── the invoice's service line and number code are frozen at issue ──────────────────────────────
  describe("invoices.service_line_key / number_code", () => {
    it("a number code on an UNISSUED invoice is refused (a half-issued invoice); a service line can be changed until issue", async () => {
      const co = await createCompany("PV5-04b Invoice Co", ["finance"]);
      await line(co, "design");
      await line(co, "build");
      const client = await createClient(co, "PV5-04b Client");
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, status, currency, lines, total, origin_site, service_line_key)
           VALUES ($1, $2, $3, 'approved', 'IDR', '[]', 10, 'test', 'design')`, [id, co, client]),
      );
      await withTenants([co], (c) => c.query(`UPDATE invoices SET service_line_key = 'build' WHERE id = $1`, [id]));
      await expect(withTenants([co], (c) => c.query(`UPDATE invoices SET number_code = 'ABC' WHERE id = $1`, [id]))).rejects.toThrow(/invoices_number_code_needs_issue/);
      // A key that is not a line of THIS company is refused by the composite FK.
      await expect(withTenants([co], (c) => c.query(`UPDATE invoices SET service_line_key = 'nonesuch' WHERE id = $1`, [id]))).rejects.toThrow(/fk_invoices_service_line/);
    });

    it("once ISSUED, the service line and the code cannot change (the immutability guard names both)", async () => {
      const co = await createCompany("PV5-04b Issued Co");
      await ensureBillingSetup(co, { prefix: "NUM" });
      const client = await createClient(co, "PV5-04b Issued Client");
      const issued = await createIssuedInvoice(co, { clientId: client, actorId: user, lines: [{ description: "Work", amount: 1000 }] });
      const row = (await adminPool().query<{ service_line_key: string; number_code: string }>(`SELECT service_line_key, number_code FROM invoices WHERE id = $1`, [issued.id])).rows[0];
      expect(row.service_line_key).toBe("services");
      expect(issued.invoiceNo).toMatch(new RegExp(`^NUM/\\d{4}/\\d{2}/${row.number_code}/0001$`));

      for (const set of ["service_line_key = 'support'", "service_line_key = NULL", "number_code = 'ZZZ'", "number_code = NULL"]) {
        await expect(withTenants([co], (c) => c.query(`UPDATE invoices SET ${set} WHERE id = $1`, [issued.id])), set).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
        // The owner is held to it too: the guard is a trigger, not a grant.
        await expect(adminPool().query(`UPDATE invoices SET ${set} WHERE id = $1`, [issued.id]), `${set} (owner)`).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      }
      // The code the invoice carries decodes to exactly one pair.
      const decode = await adminPool().query(`SELECT service_line_key, business_type FROM billing_number_codes WHERE tenant_id = $1 AND code = $2`, [co, row.number_code]);
      expect(decode.rows).toEqual([{ service_line_key: "services", business_type: "other" }]);
    });
  });
});
