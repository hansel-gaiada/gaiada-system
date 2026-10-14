// PV5-01 (part a) — migration 202610130400_pv5_billing_data_model.sql, proven against a REAL Postgres.
// Plan: docs/plans/2026-10-12-pv5-contracts-billing-tickets.md (PV5-01).
//
// Everything runs as the NOSUPERUSER NOBYPASSRLS app role (the harness repoints the app pool at it), except
// `adminPool()`, used ONLY to read ground truth past RLS. Needs DATABASE_URL_TEST (a superuser URL to a disposable
// Postgres): the Linux gate. Skips without it, and a skipped run proves nothing.
//
// Part (b), the enforcing CHECKs and the legacy exemption, is tested in pv5-enforcement.db.test.ts.
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withGlobal, withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";

/** The finance module wall: a finance_* table reads ZERO rows without the declared scope. */
const withFinance = <T>(tenants: string[], fn: (c: PoolClient) => Promise<T>) =>
  withTenants(tenants, fn, { modules: ["finance"] });

describe.skipIf(!TEST_URL)("PV5-01a — billing, series, issue, content and payment data model", () => {
  let A: string;
  let B: string;
  let user: string;
  let clientA1: string;
  let clientA2: string;
  let clientB1: string;
  let seq = 0;

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV5 Tenant A", ["finance"]);
    B = await createCompany("PV5 Tenant B", ["finance"]);
    user = await createUser("pv5-user@schema.test");
    clientA1 = await createClient(A, "PV5 Client A1");
    clientA2 = await createClient(A, "PV5 Client A2");
    clientB1 = await createClient(B, "PV5 Client B1");
  }, 120_000);
  afterAll(teardownTestDb);

  // ── helpers ─────────────────────────────────────────────────────────────────────────────────────
  const insert = async (c: PoolClient, table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row);
    await c.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  };
  const nextNo = (tenant: string, series: string, year: number) =>
    withTenants([tenant], async (c) =>
      (await c.query<{ n: number }>("SELECT next_document_no($1, $2, $3) AS n", [tenant, series, year])).rows[0].n,
    );

  async function profile(tenant: string, cols: Record<string, unknown> = {}) {
    await withTenants([tenant], (c) =>
      insert(c, "company_billing_profiles", {
        tenant_id: tenant, legal_name: "Example Legal Name", address: "1 Example Street", invoice_prefix: "EX", ...cols,
      }),
    );
  }
  async function invoice(tenant: string, client: string | null, cols: Record<string, unknown> = {}): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      insert(c, "invoices", {
        id, tenant_id: tenant, client_id: client, status: "approved", currency: "IDR", total: 1000, origin_site: "test", ...cols,
      }),
    );
    return id;
  }
  /** A draft ledger AR invoice (no journal needed in draft) plus its customer: what `ar_invoice_id` points at. */
  async function arInvoice(tenant: string, clientId: string | null = null): Promise<string> {
    const cust = newId();
    const ar = newId();
    await withFinance([tenant], async (c) => {
      await insert(c, "finance_ar_customers", { id: cust, tenant_id: tenant, code: `C-${++seq}`, name: "Cust", client_id: clientId });
      await insert(c, "finance_ar_invoices", {
        id: ar, tenant_id: tenant, customer_id: cust, invoice_no: `AR-${++seq}`, invoice_date: "2026-10-13",
        due_date: "2026-11-12", currency_code: "IDR", subtotal: 1000, tax_total: 0, total: 1000,
      });
    });
    return ar;
  }
  /** The columns an issued invoice must carry (totals agree: 1000 = 900 + 100). */
  const issuedCols = (ar: string, no: string, over: Record<string, unknown> = {}) => ({
    status: "sent", total: 1000, subtotal: 900, tax_total: 100, tax_code: "PPN", invoice_no: no, issued_at: new Date(),
    issued_by: user, issue_date: "2026-10-13", due_date: "2026-11-12", issuer: JSON.stringify({ legalName: "Example" }),
    ar_invoice_id: ar, ...over,
  });
  const update = (tenant: string, table: string, id: string, set: string, params: unknown[] = []) =>
    withTenants([tenant], (c) => c.query(`UPDATE ${table} SET ${set} WHERE id = $1`, [id, ...params]));
  const contract = (tenant: string, client: string, cols: Record<string, unknown> = {}) => {
    const id = newId();
    return withTenants([tenant], (c) =>
      insert(c, "contracts", { id, tenant_id: tenant, client_id: client, title: `C ${++seq}`, origin_site: "test", ...cols }),
    ).then(() => id);
  };
  const file = (tenant: string, cols: Record<string, unknown> = {}) => {
    const id = newId();
    return withTenants([tenant], (c) =>
      insert(c, "files", {
        id, tenant_id: tenant, target_entity_type: "contract", target_entity_id: newId(), filename: "a.pdf",
        storage_key: `k-${id}`, origin_site: "test", ...cols,
      }),
    ).then(() => id);
  };
  const HASH = "a".repeat(64);
  /** Valid under BOTH parts: a sent contract with its content fixed (part b requires it). */
  const fixed = () => ({ content_sha256: HASH, content_fixed_at: new Date(), signature_tier: "attested" });

  // ── RLS ─────────────────────────────────────────────────────────────────────────────────────────
  describe("RLS", () => {
    const TABLES = ["company_billing_profiles", "document_series", "payment_checkouts", "provider_events"];

    it("every new table has RLS enabled AND forced, with the tenant_isolation policy", async () => {
      for (const t of TABLES) {
        const rls = await adminPool().query<{ on: boolean; forced: boolean }>(
          `SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass`, [t],
        );
        expect(rls.rows[0], t).toEqual({ on: true, forced: true });
        const pol = await adminPool().query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`, [t]);
        expect(pol.rowCount, t).toBe(1);
      }
    });

    it("an UNSET tenant GUC reads ZERO rows from every new table (the RLS zero-row trap, on purpose), while rows exist", async () => {
      const co = await createCompany("PV5 RLS Co", ["finance"]);
      const cl = await createClient(co, "PV5 RLS Client");
      await profile(co);
      await nextNo(co, "invoice", 2030);
      const inv = await invoice(co, cl);
      await withTenants([co], (c) =>
        insert(c, "payment_checkouts", {
          id: newId(), tenant_id: co, invoice_id: inv, client_id: cl, amount: 1000, currency_code: "IDR", provider: "demo",
          provider_checkout_id: `chk-${newId()}`, checkout_url: "https://example.invalid/pay", expires_at: new Date(Date.now() + 3600_000),
        }),
      );
      await withTenants([co], (c) =>
        insert(c, "provider_events", { provider: "demo", event_id: `evt-${newId()}`, kind: "payment", tenant_id: co }),
      );
      for (const t of TABLES) {
        const truth = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
        expect(truth.rows[0].n, `${t}: ground truth has rows`).toBeGreaterThan(0);
        const unset = await withGlobal((c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
        expect(unset.rows[0].n, `${t}: unset GUC`).toBe(0);
        const other = await withTenants([B], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`));
        expect(other.rows[0].n, `${t}: other tenant`).toBe(0);
      }
    });

    it("a write for another tenant is refused by the policy's WITH CHECK, and next_document_no cannot mint for another tenant", async () => {
      await expect(
        withTenants([B], (c) => insert(c, "provider_events", { provider: "demo", event_id: `x-${newId()}`, kind: "payment", tenant_id: A })),
      ).rejects.toThrow(/row-level security/);
      await expect(
        withTenants([B], (c) => c.query("SELECT next_document_no($1, 'invoice', 2030)", [A])),
      ).rejects.toThrow(/row-level security/);
    });

    it("finance_ar_customers keeps its module wall: no finance scope reads zero rows while rows exist", async () => {
      await arInvoice(A);
      const truth = await adminPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM finance_ar_customers`);
      expect(truth.rows[0].n).toBeGreaterThan(0);
      const noScope = await withTenants([A], (c) => c.query<{ n: number }>(`SELECT count(*)::int AS n FROM finance_ar_customers`));
      expect(noScope.rows[0].n).toBe(0);
    });
  });

  // ── billing profile ─────────────────────────────────────────────────────────────────────────────
  describe("company_billing_profiles", () => {
    it("one row per company (tenant_id is the primary key)", async () => {
      const co = await createCompany("PV5 Profile Co");
      await profile(co);
      await expect(profile(co)).rejects.toThrow(/company_billing_profiles_pkey/);
    });

    it("invoice_prefix is 1 to 16 characters of [A-Z0-9-]", async () => {
      const co = await createCompany("PV5 Prefix Co");
      for (const bad of ["", "lower", "A/B", "A B", "X".repeat(17)]) {
        await expect(profile(co, { invoice_prefix: bad }), JSON.stringify(bad)).rejects.toThrow(/billing_profiles_prefix_format/);
      }
      await expect(profile(co, { invoice_prefix: "A-1".padEnd(16, "Z") })).resolves.toBeUndefined();
    });

    it("the bank block is all-or-none and never blank; threshold, terms and currency are constrained", async () => {
      const co = await createCompany("PV5 Bank Co");
      await expect(profile(co, { bank_name: "Bank" })).rejects.toThrow(/billing_profiles_bank_all_or_none/);
      await expect(profile(co, { bank_name: "B", bank_account_name: "N", bank_account_no: " " })).rejects.toThrow(/billing_profiles_bank_nonblank/);
      await expect(profile(co, { signature_threshold: 0 })).rejects.toThrow(/billing_profiles_threshold_positive/);
      await expect(profile(co, { default_payment_terms_days: 366 })).rejects.toThrow(/billing_profiles_terms_range/);
      await expect(profile(co, { currency_code: "ZZZ" })).rejects.toThrow(/company_billing_profiles_currency_code_fkey/);
      await expect(profile(co, { legal_name: "  " })).rejects.toThrow(/billing_profiles_legal_name_nonblank/);
      await expect(
        profile(co, { bank_name: "B", bank_account_name: "N", bank_account_no: "000", signature_threshold: 5000 }),
      ).resolves.toBeUndefined();
    });
  });

  // ── gapless series ──────────────────────────────────────────────────────────────────────────────
  describe("document_series / next_document_no", () => {
    it("counts 1, 2, 3 per (company, series, year), independently", async () => {
      const co = await createCompany("PV5 Series Co");
      expect([await nextNo(co, "invoice", 2031), await nextNo(co, "invoice", 2031), await nextNo(co, "invoice", 2031)]).toEqual([1, 2, 3]);
      expect(await nextNo(co, "invoice", 2032)).toBe(1);
      expect(await nextNo(co, "credit_note", 2031)).toBe(1);
      const other = await createCompany("PV5 Series Other Co");
      expect(await nextNo(other, "invoice", 2031)).toBe(1);
    });

    it("a rolled-back transaction returns its number, including the very first one of a series", async () => {
      const co = await createCompany("PV5 Rollback Co");
      await expect(
        withTenants([co], async (c) => {
          const r = await c.query<{ n: number }>("SELECT next_document_no($1,'invoice',2033) AS n", [co]);
          expect(r.rows[0].n).toBe(1);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await nextNo(co, "invoice", 2033)).toBe(1);
      await expect(
        withTenants([co], async (c) => {
          await c.query("SELECT next_document_no($1,'invoice',2033)", [co]);
          throw new Error("abort");
        }),
      ).rejects.toThrow("abort");
      expect(await nextNo(co, "invoice", 2033)).toBe(2);
    });

    it("concurrent transactions are serialised: two waiters behind a holder each get their own next number, no duplicate", async () => {
      const co = await createCompany("PV5 Concurrent Co");
      expect(await nextNo(co, "invoice", 2034)).toBe(1); // the counter row is committed, so only the lock protects it
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let took!: () => void;
      const tookP = new Promise<void>((r) => (took = r));
      const t1 = withTenants([co], async (c) => {
        const n = (await c.query<{ n: number }>("SELECT next_document_no($1,'invoice',2034) AS n", [co])).rows[0].n;
        took();
        await gate;
        return n;
      });
      await tookP;
      // TWO waiters, released together when the holder commits: a missing row lock hands both the same number.
      const t2 = nextNo(co, "invoice", 2034);
      const t3 = nextNo(co, "invoice", 2034);
      const state = await Promise.race([Promise.all([t2, t3]).then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 700))]);
      expect(state).toBe("blocked");
      release();
      const got = await Promise.all([t1, t2, t3]);
      expect(got[0]).toBe(2); // the holder came first
      expect([...got].sort((x, y) => x - y)).toEqual([2, 3, 4]);
    });

    it("a concurrent transaction that waits on a ROLLED-BACK holder gets the holder's number: no gap", async () => {
      const co = await createCompany("PV5 Gap Co");
      expect(await nextNo(co, "invoice", 2035)).toBe(1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let took!: () => void;
      const tookP = new Promise<void>((r) => (took = r));
      let held = -1;
      const t1 = withTenants([co], async (c) => {
        held = (await c.query<{ n: number }>("SELECT next_document_no($1,'invoice',2035) AS n", [co])).rows[0].n;
        took();
        await gate;
        throw new Error("abort");
      });
      await tookP;
      const t2 = nextNo(co, "invoice", 2035);
      const state = await Promise.race([t2.then(() => "done"), new Promise((r) => setTimeout(() => r("blocked"), 700))]);
      expect(state).toBe("blocked");
      release();
      await expect(t1).rejects.toThrow("abort");
      expect(held).toBe(2);
      expect(await t2).toBe(2);
      expect(await nextNo(co, "invoice", 2035)).toBe(3);
    });

    it("ten parallel callers get ten distinct consecutive numbers", async () => {
      const co = await createCompany("PV5 Parallel Co");
      const got = await Promise.all(Array.from({ length: 10 }, () => nextNo(co, "invoice", 2036)));
      expect([...got].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    it("the series name and year are constrained", async () => {
      await expect(nextNo(A, "Invoice", 2030)).rejects.toThrow(/document_series_series_format/);
      await expect(nextNo(A, "invoice", 1999)).rejects.toThrow(/document_series_year_range/);
    });
  });

  // ── invoices ────────────────────────────────────────────────────────────────────────────────────
  describe("invoices: the invoice of record", () => {
    it("an invoice moves from approved to issued in one UPDATE carrying every issue column", async () => {
      const ar = await arInvoice(A);
      const id2 = await invoice(A, clientA1);
      await expect(
        update(A, "invoices", id2,
          `status = 'sent', invoice_no = 'EX/2026/0001', issued_at = now(), issued_by = $2, issue_date = '2026-10-13', due_date = '2026-11-12',
           subtotal = 900, tax_total = 100, tax_code = 'PPN', issuer = '{"legalName":"Example"}', ar_invoice_id = $3`,
          [user, ar]),
      ).resolves.toBeDefined();
    });

    it("issued_at demands every issue column; the totals must agree; the dates must be ordered", async () => {
      const ar = await arInvoice(A);
      for (const col of ["invoice_no", "issue_date", "due_date", "issuer", "ar_invoice_id", "issued_by", "subtotal", "tax_total"]) {
        const base = issuedCols(await arInvoice(A), `EX/M/${++seq}`);
        await expect(invoice(A, clientA1, { ...base, [col]: null }), col).rejects.toThrow(/invoices_issued_complete/);
      }
      await expect(invoice(A, clientA1, issuedCols(ar, "EX/T/1", { total: 999 }))).rejects.toThrow(/invoices_issued_complete/);
      await expect(invoice(A, clientA1, issuedCols(ar, "EX/T/2", { due_date: "2026-10-01" }))).rejects.toThrow(/invoices_due_after_issue/);
      await expect(invoice(A, clientA1, issuedCols(ar, "EX/T/3", { status: "approved" }))).rejects.toThrow(/invoices_issued_status/);
    });

    it("a number, snapshot, ledger link or issuer on an UNISSUED row is refused (no half-issued invoice)", async () => {
      const ar = await arInvoice(A);
      await expect(invoice(A, clientA1, { invoice_no: "EX/H/1" })).rejects.toThrow(/invoices_no_half_issued/);
      await expect(invoice(A, clientA1, { issuer: JSON.stringify({ a: 1 }) })).rejects.toThrow(/invoices_no_half_issued/);
      await expect(invoice(A, clientA1, { ar_invoice_id: ar })).rejects.toThrow(/invoices_no_half_issued/);
    });

    it("invoice_no is unique per tenant, reusable across tenants, and many drafts may have none (NULL)", async () => {
      await invoice(A, clientA1);
      await invoice(A, clientA1);
      const no = `EX/U/${++seq}`;
      await invoice(A, clientA1, issuedCols(await arInvoice(A), no));
      await expect(invoice(A, clientA1, issuedCols(await arInvoice(A), no))).rejects.toThrow(/ux_invoices_tenant_invoice_no/);
      await expect(invoice(B, clientB1, issuedCols(await arInvoice(B), no))).resolves.toBeDefined();
    });

    it("one ledger AR invoice backs at most one invoice, and it must be in the same tenant", async () => {
      const ar = await arInvoice(A);
      await invoice(A, clientA1, issuedCols(ar, `EX/L/${++seq}`));
      await expect(invoice(A, clientA1, issuedCols(ar, `EX/L/${++seq}`))).rejects.toThrow(/ux_invoices_ar_invoice/);
      const arB = await arInvoice(B);
      await expect(invoice(A, clientA1, issuedCols(arB, `EX/L/${++seq}`))).rejects.toThrow(/fk_invoices_ar_invoice_tenant/);
    });

    it("IMMUTABILITY: once issued, lines, total, invoice_no, client and the snapshot cannot change; paid and void can", async () => {
      const mk = async () => invoice(A, clientA1, issuedCols(await arInvoice(A), `EX/I/${++seq}`));
      const id = await mk();
      await expect(update(A, "invoices", id, `lines = '[{"x":1}]'`)).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "total = 1001, subtotal = 901")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "invoice_no = 'EX/I/CHANGED'")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "client_id = $2", [clientA2])).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, `issuer = '{"legalName":"Other"}'`)).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "due_date = '2027-01-01'")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "deleted_at = now()")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "issued_at = NULL")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(update(A, "invoices", id, "status = 'approved'")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      await expect(withTenants([A], (c) => c.query("DELETE FROM invoices WHERE id = $1", [id]))).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      // The things that may change: status to paid or void, and the updated stamps.
      await expect(update(A, "invoices", id, "updated_at = now(), updated_by = $2", [user])).resolves.toBeDefined();
      await expect(update(A, "invoices", id, "status = 'paid', updated_at = now()")).resolves.toBeDefined();
      const id2 = await mk();
      await expect(update(A, "invoices", id2, "status = 'void'")).resolves.toBeDefined();
      await expect(update(A, "invoices", id2, "status = 'paid'")).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
    });

    it("an unissued invoice stays freely editable and deletable", async () => {
      const id = await invoice(A, clientA1);
      await expect(update(A, "invoices", id, `lines = '[{"x":1}]', total = 5, client_id = $2`, [clientA2])).resolves.toBeDefined();
      await expect(withTenants([A], (c) => c.query("DELETE FROM invoices WHERE id = $1", [id]))).resolves.toBeDefined();
    });
  });

  // ── AR customers ────────────────────────────────────────────────────────────────────────────────
  describe("finance_ar_customers", () => {
    const customer = (tenant: string, cols: Record<string, unknown>) =>
      withFinance([tenant], (c) => insert(c, "finance_ar_customers", { id: newId(), tenant_id: tenant, code: `K-${++seq}`, name: "Cust", ...cols }));

    it("a second LIVE customer for the same client fails; a different client, no client, or a replacement after soft delete is fine", async () => {
      const cl = await createClient(A, "PV5 One Customer");
      await customer(A, { client_id: cl });
      await expect(customer(A, { client_id: cl })).rejects.toThrow(/ux_finance_ar_customers_client_live/);
      await customer(A, { client_id: clientA2 });
      await customer(A, { client_id: null });
      await customer(A, { client_id: null });
      await withFinance([A], (c) => c.query("UPDATE finance_ar_customers SET deleted_at = now() WHERE client_id = $1", [cl]));
      await expect(customer(A, { client_id: cl })).resolves.toBeUndefined();
    });

    it("client_id must name a client of the SAME tenant (composite FK)", async () => {
      await expect(customer(A, { client_id: clientB1 })).rejects.toThrow(/fk_finance_ar_customers_client_tenant/);
      await expect(customer(A, { client_id: newId() })).rejects.toThrow(/fk_finance_ar_customers_client_tenant/);
    });

    it("counterparty_company_id is a company, and never the company itself", async () => {
      await expect(customer(A, { counterparty_company_id: B })).resolves.toBeUndefined();
      await expect(customer(A, { counterparty_company_id: A })).rejects.toThrow(/ck_finance_ar_customers_counterparty_not_self/);
      await expect(customer(A, { counterparty_company_id: newId() })).rejects.toThrow(/finance_ar_customers_counterparty_company_id_fkey/);
    });
  });

  // ── contracts, signatures, files ────────────────────────────────────────────────────────────────
  describe("contracts, contract_signatures and files", () => {
    it("tier and hash are shaped; a draft carries neither; a hash needs its stamp", async () => {
      await expect(contract(A, clientA1, { status: "void", signature_tier: "other" })).rejects.toThrow(/contracts_signature_tier_check/);
      await expect(contract(A, clientA1, { status: "void", content_sha256: "xyz", content_fixed_at: new Date() })).rejects.toThrow(/contracts_content_sha256_format/);
      await expect(contract(A, clientA1, { status: "void", content_sha256: HASH })).rejects.toThrow(/contracts_content_hash_stamped/);
      await expect(contract(A, clientA1, { status: "draft", signature_tier: "attested" })).rejects.toThrow(/contracts_draft_not_fixed/);
      await expect(contract(A, clientA1, { status: "draft", content_sha256: HASH, content_fixed_at: new Date() })).rejects.toThrow(/contracts_draft_not_fixed/);
      const id = await contract(A, clientA1, { status: "sent", sent_at: new Date(), content_sha256: HASH, content_fixed_at: new Date(), signature_tier: "certified" });
      expect(id).toBeTruthy();
      // certified_requested defaults to false.
      const r = await adminPool().query<{ certified_requested: boolean }>("SELECT certified_requested FROM contracts WHERE id = $1", [id]);
      expect(r.rows[0].certified_requested).toBe(false);
    });

    it("once the content is fixed, hash, tier, file and body cannot change; status still can", async () => {
      const f = await file(A);
      const id = await contract(A, clientA1, {
        status: "sent", sent_at: new Date(), content_sha256: HASH, content_fixed_at: new Date(), signature_tier: "attested", body_md: "terms", file_id: f,
      });
      await expect(update(A, "contracts", id, "body_md = 'other'")).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      await expect(update(A, "contracts", id, "content_sha256 = $2", ["b".repeat(64)])).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      await expect(update(A, "contracts", id, "signature_tier = 'certified'")).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      await expect(update(A, "contracts", id, "file_id = NULL")).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      await expect(update(A, "contracts", id, "content_fixed_at = NULL, content_sha256 = NULL")).rejects.toThrow(/PV5_CONTRACT_CONTENT_FIXED/);
      await expect(update(A, "contracts", id, "status = 'signed', signed_at = now()")).resolves.toBeDefined();
      // A draft can be edited freely, and fixing happens in one UPDATE.
      const d = await contract(A, clientA1, { body_md: "v1" });
      await expect(update(A, "contracts", d, "body_md = 'v2'")).resolves.toBeDefined();
      await expect(
        update(A, "contracts", d, "status = 'sent', sent_at = now(), content_sha256 = $2, content_fixed_at = now(), signature_tier = 'attested'", [HASH]),
      ).resolves.toBeDefined();
    });

    it("a signature records the hash it covered, and a provider envelope needs a provider", async () => {
      const id = await contract(A, clientA1);
      const sig = (cols: Record<string, unknown>) =>
        withTenants([A], (c) => insert(c, "contract_signatures", { id: newId(), tenant_id: A, contract_id: id, party: "client", origin_site: "test", ...cols }));
      await expect(sig({ content_sha256: "nope" })).rejects.toThrow(/contract_signatures_content_sha256_format/);
      await expect(sig({ provider_envelope_id: "env-1" })).rejects.toThrow(/contract_signatures_envelope_has_provider/);
      // PV5-11 (202610150300): a provider signature must name the provider and envelope the contract is signed through,
      // which only a CERTIFIED contract with an envelope has.
      await expect(sig({ content_sha256: HASH, provider: "demo", provider_envelope_id: "env-1" })).rejects.toThrow(/PV5_PROVIDER_SIGNATURE_MISMATCH/);
      const certified = await contract(A, clientA1, {
        status: "sent", sent_at: new Date(), content_sha256: HASH, content_fixed_at: new Date(), signature_tier: "certified",
        signature_provider: "demo", provider_envelope_id: "env-1",
      });
      await expect(
        withTenants([A], (c) => insert(c, "contract_signatures", {
          id: newId(), tenant_id: A, contract_id: certified, party: "client", origin_site: "test", content_sha256: HASH, provider: "demo", provider_envelope_id: "env-1",
        })),
      ).resolves.toBeUndefined();
    });

    it("files.sha256 is shaped and nullable", async () => {
      await expect(file(A, { sha256: "short" })).rejects.toThrow(/files_sha256_format/);
      await expect(file(A, { sha256: HASH })).resolves.toBeTruthy();
      await expect(file(A)).resolves.toBeTruthy();
    });

    it("FILE TRIGGER: soft-deleting a file under a non-draft contract fails; under a draft, or under no contract, it succeeds", async () => {
      const fSent = await file(A);
      await contract(A, clientA1, { status: "sent", sent_at: new Date(), file_id: fSent, ...fixed() });
      await expect(update(A, "files", fSent, "deleted_at = now()")).rejects.toThrow(/PV5_FILE_UNDER_CONTRACT/);

      const fSigned = await file(A);
      await contract(A, clientA1, { status: "signed", sent_at: new Date(), signed_at: new Date(), file_id: fSigned, ...fixed() });
      await expect(update(A, "files", fSigned, "deleted_at = now()")).rejects.toThrow(/PV5_FILE_UNDER_CONTRACT/);

      const fVoid = await file(A);
      await contract(A, clientA1, { status: "void", sent_at: new Date(), file_id: fVoid, ...fixed() });
      await expect(update(A, "files", fVoid, "deleted_at = now()")).rejects.toThrow(/PV5_FILE_UNDER_CONTRACT/);

      const fDraft = await file(A);
      await contract(A, clientA1, { status: "draft", file_id: fDraft });
      await expect(update(A, "files", fDraft, "deleted_at = now()")).resolves.toBeDefined();

      const fFree = await file(A);
      await expect(update(A, "files", fFree, "deleted_at = now()")).resolves.toBeDefined();
      // Other file updates under a sent contract are not this trigger's business.
      await expect(update(A, "files", fSent, "filename = 'renamed.pdf'")).resolves.toBeDefined();
    });
  });

  // ── invoice_payments ────────────────────────────────────────────────────────────────────────────
  describe("invoice_payments", () => {
    async function payment(tenant: string, client: string, inv: string, cols: Record<string, unknown> = {}) {
      await withTenants([tenant], (c) =>
        insert(c, "invoice_payments", {
          id: newId(), tenant_id: tenant, invoice_id: inv, client_id: client, amount: 100, paid_on: "2026-10-13", origin_site: "test", ...cols,
        }),
      );
    }

    it("existing methods are all still accepted, 'online' is new, and the default source is client_claim", async () => {
      const inv = await invoice(A, clientA1);
      for (const m of ["bank_transfer", "card", "cash", "other"]) await expect(payment(A, clientA1, inv, { method: m }), m).resolves.toBeUndefined();
      await expect(payment(A, clientA1, inv, { method: "crypto" })).rejects.toThrow(/invoice_payments_method_check/);
      const r = await adminPool().query<{ source: string }>("SELECT DISTINCT source FROM invoice_payments WHERE invoice_id = $1", [inv]);
      expect(r.rows).toEqual([{ source: "client_claim" }]);
    });

    it("a gateway payment names provider and payment, is method online, and 'online' is only ever gateway", async () => {
      const inv = await invoice(A, clientA1);
      await expect(payment(A, clientA1, inv, { source: "gateway", method: "online" })).rejects.toThrow(/invoice_payments_(provider_pair|gateway_consistent)/);
      await expect(payment(A, clientA1, inv, { source: "gateway", method: "bank_transfer", provider: "demo", provider_payment_id: "p-0" })).rejects.toThrow(/invoice_payments_gateway_consistent/);
      await expect(payment(A, clientA1, inv, { source: "client_claim", method: "online" })).rejects.toThrow(/invoice_payments_gateway_consistent/);
      await expect(payment(A, clientA1, inv, { source: "robot" })).rejects.toThrow(/invoice_payments_source_check/);
      await expect(payment(A, clientA1, inv, { provider: "demo" })).rejects.toThrow(/invoice_payments_provider_pair/);
      await expect(payment(A, clientA1, inv, { source: "gateway", method: "online", provider: "demo", provider_payment_id: "p-1", status: "confirmed" })).resolves.toBeUndefined();
    });

    it("a provider payment id is unique per provider (a replay cannot double-write); NULLs do not collide", async () => {
      const inv = await invoice(A, clientA1);
      const g = (pid: string, provider = "demo") => payment(A, clientA1, inv, { source: "gateway", method: "online", provider, provider_payment_id: pid });
      await g("dup-1");
      await expect(g("dup-1")).rejects.toThrow(/ux_invoice_payments_provider_payment/);
      await expect(g("dup-1", "other")).resolves.toBeUndefined();
      await payment(A, clientA1, inv);
      await payment(A, clientA1, inv);
    });

    it("ar_receipt_id points at a receipt in the same tenant, once", async () => {
      const fin = await createCompany("PV5 Receipt Co", ["finance"]);
      const finClient = await createClient(fin, "PV5 Receipt Client");
      await withFinance([fin], (c) =>
        c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1,'IDR','IDR')`, [fin]),
      );
      await withFinance([fin], (c) => c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [fin]));
      const bank = await withFinance([fin], async (c) =>
        (await c.query<{ id: string }>("SELECT id FROM finance_accounts WHERE tenant_id=$1 AND code='1120'", [fin])).rows[0].id,
      );
      const cust = newId();
      const receipt = newId();
      await withFinance([fin], async (c) => {
        await insert(c, "finance_ar_customers", { id: cust, tenant_id: fin, code: "RC-1", name: "RC" });
        await insert(c, "finance_ar_receipts", {
          id: receipt, tenant_id: fin, customer_id: cust, receipt_no: "R-1", receipt_date: "2026-10-13", currency_code: "IDR", amount: 100, bank_account_id: bank,
        });
      });
      const inv = await invoice(fin, finClient);
      await payment(fin, finClient, inv, { ar_receipt_id: receipt });
      await expect(payment(fin, finClient, inv, { ar_receipt_id: receipt })).rejects.toThrow(/ux_invoice_payments_ar_receipt/);
      await expect(payment(fin, finClient, inv, { ar_receipt_id: newId() })).rejects.toThrow(/fk_invoice_payments_ar_receipt_tenant/);
      // A receipt of ANOTHER tenant cannot be pointed at (composite FK). A second, still-unreferenced receipt, so the
      // unique index cannot be what refuses it.
      const receipt2 = newId();
      await withFinance([fin], (c) =>
        insert(c, "finance_ar_receipts", {
          id: receipt2, tenant_id: fin, customer_id: cust, receipt_no: "R-2", receipt_date: "2026-10-13", currency_code: "IDR", amount: 100, bank_account_id: bank,
        }),
      );
      await expect(payment(A, clientA1, await invoice(A, clientA1), { ar_receipt_id: receipt2 })).rejects.toThrow(/fk_invoice_payments_ar_receipt_tenant/);
    });
  });

  // ── checkouts and provider events ───────────────────────────────────────────────────────────────
  describe("payment_checkouts", () => {
    const checkout = (tenant: string, inv: string, client: string, cols: Record<string, unknown> = {}) =>
      withTenants([tenant], (c) =>
        insert(c, "payment_checkouts", {
          id: newId(), tenant_id: tenant, invoice_id: inv, client_id: client, amount: 1000, currency_code: "IDR", provider: "demo",
          provider_checkout_id: `chk-${newId()}`, checkout_url: "https://example.invalid/pay", expires_at: new Date(Date.now() + 3600_000), ...cols,
        }),
      );

    it("at most ONE open checkout per invoice; a settled or expired one frees the slot", async () => {
      const inv = await invoice(A, clientA1);
      await checkout(A, inv, clientA1);
      await expect(checkout(A, inv, clientA1)).rejects.toThrow(/ux_payment_checkouts_open_per_invoice/);
      await checkout(A, inv, clientA1, { status: "expired" });
      await checkout(A, inv, clientA1, { status: "failed" });
      await withTenants([A], (c) => c.query("UPDATE payment_checkouts SET status = 'paid' WHERE invoice_id = $1 AND status = 'open'", [inv]));
      await expect(checkout(A, inv, clientA1)).resolves.toBeUndefined();
    });

    it("the provider's checkout id is unique; amount, status and tenant of invoice and client are constrained", async () => {
      const inv = await invoice(A, clientA1);
      await checkout(A, inv, clientA1, { provider_checkout_id: "same", status: "expired" });
      await expect(checkout(A, inv, clientA1, { provider_checkout_id: "same", status: "expired" })).rejects.toThrow(/ux_payment_checkouts_provider_checkout/);
      await expect(checkout(A, inv, clientA1, { amount: 0, status: "failed" })).rejects.toThrow(/payment_checkouts_amount_positive/);
      await expect(checkout(A, inv, clientA1, { status: "pending" })).rejects.toThrow(/payment_checkouts_status_check/);
      await expect(checkout(A, inv, clientB1, { status: "failed" })).rejects.toThrow(/fk_payment_checkouts_client_tenant/);
      const invB = await invoice(B, clientB1);
      await expect(checkout(A, invB, clientA1, { status: "failed" })).rejects.toThrow(/fk_payment_checkouts_invoice_tenant/);
    });
  });

  describe("provider_events", () => {
    const claim = (tenant: string, provider: string, eventId: string) =>
      withTenants([tenant], async (c) =>
        (await c.query<{ id: string }>(
          `INSERT INTO provider_events (provider, event_id, kind, tenant_id) VALUES ($1, $2, 'payment', $3)
           ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [provider, eventId, tenant])).rowCount,
      );

    it("the claim is atomic: of N concurrent deliveries of one event exactly one wins; a replay wins nothing", async () => {
      const id = `evt-${newId()}`;
      const results = await Promise.all(Array.from({ length: 8 }, () => claim(A, "demo", id)));
      expect(results.filter((n) => n === 1)).toHaveLength(1);
      expect(await claim(A, "demo", id)).toBe(0);
      expect(await claim(A, "other", id)).toBe(1); // the same id from another provider is another event
    });

    it("kind, status and the error column are constrained", async () => {
      const ins = (cols: Record<string, unknown>) =>
        withTenants([A], (c) => insert(c, "provider_events", { provider: "demo", event_id: `e-${newId()}`, kind: "payment", tenant_id: A, ...cols }));
      await expect(ins({ kind: "refund" })).rejects.toThrow(/provider_events_kind_check/);
      await expect(ins({ status: "done" })).rejects.toThrow(/provider_events_status_check/);
      await expect(ins({ error: "boom" })).rejects.toThrow(/provider_events_error_only_when_unhappy/);
      await expect(ins({ status: "ignored", error: "amount mismatch" })).resolves.toBeUndefined();
      await expect(ins({ status: "failed", error: "boom" })).resolves.toBeUndefined();
      await expect(ins({ kind: "signature" })).resolves.toBeUndefined();
    });
  });
});
