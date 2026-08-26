// Finance module BFF surface — against live Postgres + RLS + Cerbos.
//
// This is the first test in the finance program that drives the REAL HTTP SURFACE rather than SQL
// directly. Everything below F0–F7 proved the accounting is correct; this proves a person can
// actually reach it, and that the authorization tiers designed across PERMISSION-CONTRACT §17–§24
// hold when a live PDP is asked.
//
// Two things it exists to catch that a SQL test structurally cannot:
//
//   1. THE SILENT-EMPTY FAILURE. Every finance_* table is module-walled. A handler that forgets
//      `{ modules: ["finance"] }` returns `[]` with a 200 and looks like it worked. A SQL test
//      calling the function directly never exercises that path.
//   2. TIER DRIFT. `finance_staff` must not be able to post a journal; `company_admin` must not be
//      able to release money or run the accounting queue. Those are Cerbos decisions, and only a
//      live PDP can confirm them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("Finance module BFF", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let controller: string; // finance_manager
  let clerk: string;      // finance_staff
  let outsider: string;   // plain member

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Finance Co", ["finance"]);
    controller = await createUser("controller@fin.test");
    clerk = await createUser("clerk@fin.test");
    outsider = await createUser("outsider@fin.test");
    for (const u of [controller, clerk, outsider]) await addMembership(tenant, u);
    await grantRole(controller, await createRole("finance_manager"), "company", tenant);
    await grantRole(clerk, await createRole("finance_staff"), "company", tenant);
    await grantRole(outsider, await createRole("member"), "company", tenant);

    // Seed a company with books: chart, calendar, and one posted journal.
    await withTenants([tenant], async (c) => {
      await c.query("SELECT set_config('app.scopes','finance',true)");
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency)
         VALUES ($1,'IDR','IDR')`,
        [tenant],
      );
      await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [tenant]);
      const fy = newId();
      await c.query(
        `INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date)
         VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`,
        [fy, tenant],
      );
      await c.query("SELECT finance_generate_periods($1,'monthly')", [fy]);
      await c.query(
        `SELECT finance_post_journal($1,'2026-03-05','seed-1','Opening capital',
           '[{"account_code":"1120","side":"debit","amount":250000000},
             {"account_code":"3100","side":"credit","amount":250000000}]'::jsonb)`,
        [tenant],
      );
    }, { modules: ["finance"] });

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const get = (url: string, who: string) => app.inject({ method: "GET", url, headers: asUser(who) });

  // ── The module scope is actually declared ─────────────────────────────────────────────────────
  describe("module scope", () => {
    // If withFinance() ever loses { modules: ["finance"] }, this is the test that fails — the
    // handler would return [] with a 200 and every other assertion would still pass.
    it("returns the chart of accounts, not a silent empty list", async () => {
      const r = await get(`/api/${tenant}/finance/accounts`, clerk);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ code: string; isControl: boolean }>;
      expect(rows.length).toBeGreaterThan(50);
      expect(rows.find((a) => a.code === "1130")?.isControl).toBe(true);
    });

    it("filters by query", async () => {
      const rows = (await get(`/api/${tenant}/finance/accounts?q=Piutang`, clerk)).json() as Array<{ code: string }>;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((a) => a.code.startsWith("11") || a.code.startsWith("12"))).toBe(true);
    });
  });

  // ── Statements over HTTP ──────────────────────────────────────────────────────────────────────
  describe("statements", () => {
    it("trial balance reports its own balanced property", async () => {
      const r = await get(`/api/${tenant}/finance/trial-balance?asOf=2026-12-31`, clerk);
      expect(r.statusCode).toBe(200);
      const body = r.json() as { totalDebit: number; totalCredit: number; balanced: boolean };
      expect(body.totalDebit).toBe(250_000_000);
      expect(body.balanced).toBe(true);
    });

    it("balance sheet reports A = L + E", async () => {
      const body = (
        await get(`/api/${tenant}/finance/balance-sheet?asOf=2026-12-31&fyStart=2026-01-01`, clerk)
      ).json() as { assets: number; liabilities: number; equity: number; balanced: boolean };
      expect(body.assets).toBe(250_000_000);
      expect(body.balanced).toBe(true);
    });

    // A wrong date that silently became "today" would return a confidently wrong statement.
    it("REJECTS a malformed date rather than coercing it", async () => {
      const r = await get(`/api/${tenant}/finance/trial-balance?asOf=31-12-2026`, clerk);
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: expect.stringContaining("ISO date") });
    });

    // A P&L is flow, not stock.
    it("REQUIRES both bounds for a P&L", async () => {
      const r = await get(`/api/${tenant}/finance/profit-and-loss?from=2026-01-01`, clerk);
      expect(r.statusCode).toBe(400);
    });

    // fyStart is required because "profit so far" needs to know when the year began.
    it("REQUIRES fyStart for a balance sheet", async () => {
      const r = await get(`/api/${tenant}/finance/balance-sheet?asOf=2026-12-31`, clerk);
      expect(r.statusCode).toBe(400);
    });
  });

  // ── The authorization tiers, against a live PDP ───────────────────────────────────────────────
  describe("authorization tiers", () => {
    it("a plain member cannot read the chart of accounts", async () => {
      const r = await get(`/api/${tenant}/finance/accounts`, outsider);
      expect(r.statusCode).toBe(403);
    });

    it("the controller can post a journal", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/journals`, headers: asUser(controller),
        payload: {
          date: "2026-03-10", sourceEventId: "api-1", description: "Office rent March",
          lines: [
            { accountCode: "6200", side: "debit", amount: 12_000_000 },
            { accountCode: "1120", side: "credit", amount: 12_000_000 },
          ],
        },
      });
      expect(r.statusCode).toBe(201);
      expect((r.json() as { id: string }).id).toBeTruthy();
    });

    // ★ The tier that matters: an AR/AP clerk enters documents, they do not post journals.
    it("★ finance_staff CANNOT post a journal", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/journals`, headers: asUser(clerk),
        payload: {
          date: "2026-03-11", sourceEventId: "api-clerk", description: "Should be refused",
          lines: [
            { accountCode: "6200", side: "debit", amount: 1000 },
            { accountCode: "1120", side: "credit", amount: 1000 },
          ],
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it("but finance_staff CAN read the ledger and run the integrity check", async () => {
      expect((await get(`/api/${tenant}/finance/journals`, clerk)).statusCode).toBe(200);
      const v = (await get(`/api/${tenant}/finance/ledger/verify`, clerk)).json() as { clean: boolean };
      expect(v.clean).toBe(true);
    });
  });

  // ── The ledger's own guards still apply through HTTP ──────────────────────────────────────────
  describe("ledger guards reach the API", () => {
    it("an unbalanced journal is refused by the database, not by this controller", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/journals`, headers: asUser(controller),
        payload: {
          date: "2026-03-12", sourceEventId: "api-bad", description: "Unbalanced",
          lines: [
            { accountCode: "6200", side: "debit", amount: 100 },
            { accountCode: "1120", side: "credit", amount: 90 },
          ],
        },
      });
      // The database computed the exact, useful message; the transport must not throw it away.
      // Before FinanceErrorFilter this was a body-less 500 "internal error".
      expect(r.statusCode).toBe(400);
      const body = r.json() as { error: string; code: string };
      expect(body.code).toBe("finance_unbalanced");
      expect(body.error).toContain("100");
      expect(body.error).toContain("90");
    });

    it("posting is idempotent on sourceEventId", async () => {
      const first = (
        await app.inject({
          method: "POST", url: `/api/${tenant}/finance/journals`, headers: asUser(controller),
          payload: {
            date: "2026-03-10", sourceEventId: "api-1", description: "Office rent March",
            lines: [
              { accountCode: "6200", side: "debit", amount: 12_000_000 },
              { accountCode: "1120", side: "credit", amount: 12_000_000 },
            ],
          },
        })
      ).json() as { id: string };
      const list = (await get(`/api/${tenant}/finance/journals`, clerk)).json() as Array<{ sourceEventId: string }>;
      expect(list.filter((j) => j.sourceEventId === "api-1")).toHaveLength(1);
      expect(first.id).toBeTruthy();
    });

    it("a journal is retrievable with its lines and its status", async () => {
      const list = (await get(`/api/${tenant}/finance/journals`, clerk)).json() as Array<{ id: string }>;
      const detail = (await get(`/api/${tenant}/finance/journals/${list[0].id}`, clerk)).json() as {
        lines: Array<{ accountCode: string; side: string }>; status: string; entryHash: string;
      };
      expect(detail.lines.length).toBeGreaterThanOrEqual(2);
      expect(detail.status).toBe("posted");
      expect(detail.entryHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("a reversal requires a substantive reason", async () => {
      const list = (await get(`/api/${tenant}/finance/journals`, clerk)).json() as Array<{ id: string }>;
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/journals/${list[0].id}/reverse`,
        headers: asUser(controller), payload: { reason: "oops" },
      });
      expect(r.statusCode).toBe(400);
    });
  });

  // ── Subledgers and the close ──────────────────────────────────────────────────────────────────
  describe("subledgers and close readiness", () => {
    it("AR reconcile returns BOTH numbers, because they are not the same", async () => {
      const body = (await get(`/api/${tenant}/finance/ar/reconcile`, clerk)).json() as {
        position: { openInvoices: string; paymentsOnAccount: string; netReceivable: string };
        clean: boolean;
      };
      expect(body.position).toHaveProperty("openInvoices");
      expect(body.position).toHaveProperty("paymentsOnAccount");
      expect(body.clean).toBe(true);
    });

    it("AP aging is reachable and empty on a company with no bills", async () => {
      const r = await get(`/api/${tenant}/finance/ap/aging`, clerk);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual([]);
    });

    it("close readiness names the accountant sign-off as a blocker", async () => {
      const periods = (await get(`/api/${tenant}/finance/periods`, clerk)).json() as Array<{ id: string; periodNo: number }>;
      const march = periods.find((p) => p.periodNo === 3)!;
      const body = (
        await get(`/api/${tenant}/finance/periods/${march.id}/close-readiness`, clerk)
      ).json() as { blockers: Array<{ blocker: string }>; ready: boolean };
      expect(body.ready).toBe(false);
      expect(body.blockers.map((b) => b.blocker)).toContain("NO_ACCOUNTANT_SIGNOFF");
    });
  });


  // ── The receivables WRITE path, driven over HTTP ───────────────────────────────────────────────
  //
  // These are the first finance endpoints that CREATE money records rather than read them, so the
  // thing under test is not "does it return 201" — it is whether the subledger still ties to the
  // general ledger afterwards. `finance_ar_reconcile` returning clean is the assertion that matters;
  // a 201 with a broken tie-out would be a worse outcome than a 500.
  describe("receivables — the write path", () => {
    let customerId = "";
    let invoiceId = "";

    it("a customer can be listed, so a form need not ask for a uuid", async () => {
      await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        await c.query(
          `INSERT INTO finance_ar_customers (tenant_id, code, name, payment_terms_days, is_pkp)
           VALUES ($1,'C-900','PT Uji Terima',30,true)`,
          [tenant],
        );
      }, { modules: ["finance"] });

      const r = await get(`/api/${tenant}/finance/ar/customers`, clerk);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Array<{ id: string; code: string }>;
      customerId = rows.find((x) => x.code === "C-900")!.id;
      expect(customerId).toBeTruthy();
    });

    it("REFUSES an invoice with no lines, rather than letting the database raise mid-transaction", async () => {
      // finance_ar_issue_invoice raises FINANCE_AR_EMPTY_INVOICE on a header with no lines. Catching
      // it here turns an opaque 500 into a field-level 400 a form can point at — and this case is
      // real: the demo seed hit it on the live schema before this guard existed.
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId, invoiceNo: "INV-EMPTY", invoiceDate: "2026-03-01", dueDate: "2026-03-31",
          lines: [],
        },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toHaveProperty("error");
    });

    it("REFUSES a due date before the invoice date", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId, invoiceNo: "INV-BACKWARDS", invoiceDate: "2026-03-31", dueDate: "2026-03-01",
          lines: [{ description: "x", unitPrice: 1000, revenueAccountCode: "4100" }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it("issues an invoice, computing PPN as 12% of 11/12 of the base", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId, invoiceNo: "INV-900", invoiceDate: "2026-03-05", dueDate: "2026-04-04",
          lines: [{
            description: "Jasa konsultasi", quantity: 1, unitPrice: 60_000_000,
            revenueAccountCode: "4100", taxCode: "PPN", taxRate: 12,
          }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { id: string; subtotal: number; taxTotal: number; total: number };
      invoiceId = body.id;
      expect(body.subtotal).toBe(60_000_000);
      // 60,000,000 x 11/12 x 12% = 6,600,000. NOT 7,200,000 (a flat 12%) and NOT 6,600,000 by
      // accident — the 11/12 base is the whole point of the Indonesian rule.
      expect(body.taxTotal).toBe(6_600_000);
      expect(body.total).toBe(66_600_000);
    });

    it("an unknown revenue account is refused by CODE, not swallowed", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId, invoiceNo: "INV-BADACCT", invoiceDate: "2026-03-05", dueDate: "2026-04-04",
          lines: [{ description: "x", unitPrice: 1000, revenueAccountCode: "9999" }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it("the issued invoice appears in the aging AND the subledger still ties to the ledger", async () => {
      const aging = (await get(`/api/${tenant}/finance/ar/aging?asOf=2026-03-31`, clerk)).json() as
        Array<{ customerName: string; totalOutstanding: string }>;
      expect(aging.some((a) => a.customerName === "PT Uji Terima")).toBe(true);

      // ★ THE REAL ASSERTION. Issuing posted a journal and moved the control account; if those two
      // disagreed, the aging and the balance sheet would answer "what are we owed" differently.
      const rec = (await get(`/api/${tenant}/finance/ar/reconcile?asOf=2026-03-31`, clerk)).json() as
        { clean: boolean; problems: unknown[] };
      expect(rec.problems).toEqual([]);
      expect(rec.clean).toBe(true);
    });

    it("banks a receipt and leaves the unallocated remainder ON ACCOUNT", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/receipts`, headers: asUser(clerk),
        payload: {
          customerId, receiptNo: "RCPT-900", receiptDate: "2026-03-20", amount: 30_000_000,
          bankAccountCode: "1120", reference: "Transfer",
          allocations: [{ invoiceId, amount: 20_000_000 }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { allocated: number; onAccount: number };
      expect(body.allocated).toBe(20_000_000);
      // The 10,000,000 remainder is the case the three-part position exists to surface: it lowers
      // the net while the invoice it might have settled still sits in the aging.
      expect(body.onAccount).toBe(10_000_000);

      const rec = (await get(`/api/${tenant}/finance/ar/reconcile?asOf=2026-03-31`, clerk)).json() as
        { clean: boolean; position: { paymentsOnAccount: string } };
      expect(rec.clean).toBe(true);
      expect(Number(rec.position.paymentsOnAccount)).toBe(10_000_000);
    });

    it("REFUSES allocations totalling more than the receipt", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/receipts`, headers: asUser(clerk),
        payload: {
          customerId, receiptNo: "RCPT-901", receiptDate: "2026-03-21", amount: 1_000_000,
          bankAccountCode: "1120",
          allocations: [{ invoiceId, amount: 5_000_000 }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it("a plain member cannot issue an invoice or bank a receipt", async () => {
      // Cerbos, not a UI check. `outsider` holds `member` and no finance role at all.
      const inv = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(outsider),
        payload: {
          customerId, invoiceNo: "INV-NOPE", invoiceDate: "2026-03-05", dueDate: "2026-04-04",
          lines: [{ description: "x", unitPrice: 1000, revenueAccountCode: "4100" }],
        },
      });
      expect(inv.statusCode).toBe(403);

      const rcpt = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/receipts`, headers: asUser(outsider),
        payload: {
          customerId, receiptNo: "RCPT-NOPE", receiptDate: "2026-03-20",
          amount: 1000, bankAccountCode: "1120",
        },
      });
      expect(rcpt.statusCode).toBe(403);
    });
  });

  // ── Cross-company isolation, over HTTP ────────────────────────────────────────────────────────
  it("another company's books are unreachable", async () => {
    const other = await createCompany("Other Co", ["finance"]);
    const r = await get(`/api/${other}/finance/accounts`, controller);
    // Either Cerbos denies (no membership) or RLS returns nothing — never another company's chart.
    if (r.statusCode === 200) expect(r.json()).toEqual([]);
    else expect(r.statusCode).toBe(403);
  });
  // ── DATE SHAPE ────────────────────────────────────────────────────────────────────────────────
  it("★★ dates come back as YYYY-MM-DD, not ISO datetimes — the page feeds them straight back", async () => {
    // The bug this pins took /finance down in production. pg maps a `date` column to a JS Date and
    // JSON.stringify renders it "2026-01-31T00:00:00.000Z". The console reads period.endDate and
    // passes it back as ?asOf=, this API's own isoDate() rejects the datetime with a 400, and
    // financeData() only degrades 403/404 — so the 400 propagated and crashed the page.
    //
    // DEMO_MODE hid it: the demo fixtures used plain "2026-01-31", so the build gate and every
    // local browse were green against a shape the live backend never produced.
    const r = await app.inject({ method: "GET", url: `/api/${tenant}/finance/periods`, headers: asUser(controller) });
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{ startDate: string; endDate: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(row.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // And the round-trip the page actually performs must work.
    const back = await app.inject({
      method: "GET",
      url: `/api/${tenant}/finance/trial-balance?asOf=${rows[0].endDate}`,
      headers: asUser(controller),
    });
    expect(back.statusCode).toBe(200);
  });

});
