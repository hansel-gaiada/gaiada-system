// PV5-01b, INVOICE HALF — migration 202610131800_pv5_enforce_invoice_issued.sql, against a REAL Postgres.
// (Taken from PV5-01b's pv5-enforcement.db.test.ts, invoice cases only; the contract half ships with PV5-06.)
//
// The enforcing CHECK (an invoice is sent/paid only if issued) and the LEGACY exemption: a flag only the migration may
// set. Everything runs as the NOSUPERUSER NOBYPASSRLS app role except `adminPool()` (superuser), which is used to
// (1) simulate rows that pre-date the migration by disabling the guard trigger, which no application role can do, and
// (2) re-run the migration's own backfill block. Needs DATABASE_URL_TEST: the Linux gate. Skips without it.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withTenants, newId } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, createClient } from "../testing/fixtures";

const MIGRATION = path.resolve(__dirname, "../../migrations/202610131800_pv5_enforce_invoice_issued.sql");

describe.skipIf(!TEST_URL)("PV5-01b (invoices) — sent/paid require an issue, and the legacy exemption", () => {
  let A: string;
  let client: string;
  let user: string;
  let seq = 0;

  const insert = async (c: PoolClient, table: string, row: Record<string, unknown>) => {
    const names = Object.keys(row);
    await c.query(
      `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      names.map((n) => row[n]),
    );
  };
  const invoice = (cols: Record<string, unknown> = {}) => {
    const id = newId();
    return withTenants([A], (c) =>
      insert(c, "invoices", { id, tenant_id: A, client_id: client, status: "approved", currency: "IDR", total: 1000, origin_site: "test", ...cols }),
    ).then(() => id);
  };
  const update = (id: string, set: string, params: unknown[] = []) =>
    withTenants([A], (c) => c.query(`UPDATE invoices SET ${set} WHERE id = $1`, [id, ...params]));
  /** A real AR invoice to point an issued tracker invoice at. */
  async function arInvoice(): Promise<string> {
    const cust = newId();
    const ar = newId();
    await withTenants([A], async (c) => {
      await insert(c, "finance_ar_customers", { id: cust, tenant_id: A, code: `EC-${++seq}`, name: "Cust" });
      await insert(c, "finance_ar_invoices", {
        id: ar, tenant_id: A, customer_id: cust, invoice_no: `EAR-${++seq}`, invoice_date: "2026-10-13", due_date: "2026-11-12",
        currency_code: "IDR", subtotal: 1000, tax_total: 0, total: 1000,
      });
    }, { modules: ["finance"] });
    return ar;
  }

  /** Run `fn` as superuser with the legacy guard trigger off, so a row can be born flagged (a pre-PV-5 row). */
  async function asLegacy<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await adminPool().connect();
    try {
      await c.query("ALTER TABLE invoices DISABLE TRIGGER trg_invoices_pv5_legacy_guard");
      try {
        return await fn(c);
      } finally {
        await c.query("ALTER TABLE invoices ENABLE TRIGGER trg_invoices_pv5_legacy_guard");
      }
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    await initTestDb();
    A = await createCompany("PV5b Invoices A", ["finance"]);
    user = await createUser("pv5b-inv-user@schema.test");
    client = await createClient(A, "PV5b Invoices Client");
  }, 120_000);
  afterAll(teardownTestDb);

  // NOTE: runs FIRST on purpose. It asserts exact counts, so no other test may have created rows yet.
  describe("the migration's own backfill block", () => {
    it("flags exactly the sent/paid-unissued invoices, and the CHECK then validates", async () => {
      const sql = readFileSync(MIGRATION, "utf8");
      const from = sql.indexOf("DO $$", sql.indexOf("-- ── backfill, per company"));
      const to = sql.indexOf("-- ── the guard");
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const backfill = sql.slice(from, to);

      const c = await adminPool().connect();
      const notices: string[] = [];
      c.on("notice", (n) => notices.push(n.message ?? ""));
      const ids: Record<string, string> = {};
      try {
        await c.query("BEGIN");
        await c.query("ALTER TABLE invoices DROP CONSTRAINT invoices_sent_paid_issued");
        const inv = async (key: string, status: string) => {
          ids[key] = newId();
          await insert(c, "invoices", { id: ids[key], tenant_id: A, client_id: client, status, total: 5, origin_site: "test" });
        };
        // The backfill's UPDATE must run while the guard is off, exactly as in the migration (guard created after).
        await c.query("ALTER TABLE invoices DISABLE TRIGGER trg_invoices_pv5_legacy_guard");
        await inv("iDraft", "draft"); await inv("iApproved", "approved"); await inv("iSent", "sent"); await inv("iPaid", "paid"); await inv("iVoid", "void");

        await c.query(backfill);

        const flags = await c.query<{ id: string; legacy: boolean }>(
          "SELECT id, pre_pv5_legacy AS legacy FROM invoices WHERE id = ANY($1::uuid[])", [[ids.iDraft, ids.iApproved, ids.iSent, ids.iPaid, ids.iVoid]],
        );
        const f = Object.fromEntries(flags.rows.map((r) => [r.id, r.legacy]));
        expect([f[ids.iDraft], f[ids.iApproved], f[ids.iSent], f[ids.iPaid], f[ids.iVoid]]).toEqual([false, false, true, true, false]);
        expect(notices.some((m) => m.includes("legacy sent/paid invoices exempted: 2 row(s)"))).toBe(true);

        // The decisive step: the CHECK validates against every row the backfill left behind.
        await c.query("ALTER TABLE invoices ADD CONSTRAINT invoices_sent_paid_issued CHECK (status NOT IN ('sent','paid') OR issued_at IS NOT NULL OR pre_pv5_legacy)");
      } finally {
        await c.query("ROLLBACK").catch(() => undefined);
        c.release();
      }
      // The rollback left the real constraint and trigger in place.
      const left = await adminPool().query("SELECT conname FROM pg_constraint WHERE conname = 'invoices_sent_paid_issued' AND convalidated");
      expect(left.rowCount).toBe(1);
      const trg = await adminPool().query("SELECT tgname FROM pg_trigger WHERE tgname = 'trg_invoices_pv5_legacy_guard' AND tgenabled = 'O'");
      expect(trg.rowCount).toBe(1);
    });
  });

  describe("sent and paid require an issue", () => {
    it("a new row, or an update, to sent or paid without issued_at fails", async () => {
      await expect(invoice({ status: "sent" })).rejects.toThrow(/invoices_sent_paid_issued/);
      await expect(invoice({ status: "paid" })).rejects.toThrow(/invoices_sent_paid_issued/);
      const id = await invoice({ status: "approved" });
      await expect(update(id, "status = 'sent'")).rejects.toThrow(/invoices_sent_paid_issued/);
      await expect(update(id, "status = 'paid'")).rejects.toThrow(/invoices_sent_paid_issued/);
      // Draft, approved and void-before-issue are untouched by the rule.
      await expect(invoice({ status: "draft" })).resolves.toBeTruthy();
      await expect(invoice({ status: "void" })).resolves.toBeTruthy();
      await expect(update(id, "status = 'void'")).resolves.toBeDefined();
    });

    it("issuing in one UPDATE (the PV5-04 shape) satisfies it, and paid follows", async () => {
      const id = await invoice({ status: "approved" });
      await expect(
        update(id,
          `status = 'sent', invoice_no = $2, issued_at = now(), issued_by = $3, issue_date = '2026-10-13', due_date = '2026-11-12',
           subtotal = 1000, tax_total = 0, issuer = '{"legalName":"Example"}'::jsonb, ar_invoice_id = $4`,
          [`EX/E/${++seq}`, user, await arInvoice()]),
      ).resolves.toBeDefined();
      await expect(update(id, "status = 'paid'")).resolves.toBeDefined();
    });
  });

  describe("the legacy exemption cannot be reached by new rows", () => {
    it("no INSERT may carry pre_pv5_legacy = true, however the row is shaped", async () => {
      await expect(invoice({ status: "sent", pre_pv5_legacy: true })).rejects.toThrow(/PV5_LEGACY_FLAG/);
      await expect(invoice({ status: "approved", pre_pv5_legacy: true })).rejects.toThrow(/PV5_LEGACY_FLAG/);
    });

    it("no UPDATE may set it, on a row that would then escape the CHECK", async () => {
      const id = await invoice({ status: "approved" });
      await expect(update(id, "status = 'sent', pre_pv5_legacy = true")).rejects.toThrow(/PV5_LEGACY_FLAG/);
      await expect(update(id, "pre_pv5_legacy = true")).rejects.toThrow(/PV5_LEGACY_FLAG/);
    });

    it("backdating created_at does not buy an exemption (the exemption is not a date bound)", async () => {
      await expect(invoice({ status: "sent", created_at: "2020-01-01" })).rejects.toThrow(/invoices_sent_paid_issued/);
    });
  });

  describe("legacy rows keep working, and stay exempt only themselves", () => {
    it("a legacy sent invoice can be paid and re-stamped; its flag cannot be cleared; a legacy-era approved one must be issued", async () => {
      const id = newId();
      await asLegacy((c) => insert(c, "invoices", { id, tenant_id: A, client_id: client, status: "sent", total: 7, origin_site: "test", pre_pv5_legacy: true }));
      await expect(update(id, "updated_at = now()")).resolves.toBeDefined();
      await expect(update(id, "status = 'paid'")).resolves.toBeDefined();
      await expect(update(id, "pre_pv5_legacy = false")).rejects.toThrow(/PV5_LEGACY_FLAG/);
      const approved = await invoice({ status: "approved" });
      await expect(update(approved, "status = 'sent'")).rejects.toThrow(/invoices_sent_paid_issued/);
    });
  });
});
