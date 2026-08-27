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
      const rows = (await get(`/api/${tenant}/finance/accounts?q=Piutang`, clerk))
        .json() as Array<{ code: string; name: string }>;
      expect(rows.length).toBeGreaterThan(0);
      // Asserts the filter's ACTUAL contract — every row matches the query — rather than that the
      // matches fall in a code range. The range version said `11`/`12` only, which encoded a
      // layout assumption rather than a filter property: 202608270900 added 6950 "Beban Kerugian
      // Piutang", a bad-debt EXPENSE that legitimately contains the word and legitimately sits in
      // the 6xxx block, and the old assertion failed on a correct chart.
      const q = "piutang";
      expect(rows.every((a) => a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q))).toBe(true);
      // ...and it is still filtering, not returning the whole chart.
      expect(rows.length).toBeLessThan(20);
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

  // ── The terminal actions (owner decision 2026-08-26: typed-confirmation gate) ────────────────────
  //
  // These five endpoints are the only ones in the module that cannot be undone by an ordinary
  // correction, so each is gated by requireConfirmation() — the caller must echo the object's own
  // name back, exactly, server-side. A dialog is dismissed by reflex; typing the name back is not.
  // Proven here against the LIVE PDP and the LIVE readiness gate, not by reading the handler: a
  // confirmation string that only "looks" enforced in the source is not enforced at all.
  describe("terminal actions — sign-off and close", () => {
    let march: { id: string; name: string };

    it("finds March's period, already carrying postings from the tests above", async () => {
      const periods = (await get(`/api/${tenant}/finance/periods`, clerk)).json() as
        Array<{ id: string; periodNo: number; name: string }>;
      const m = periods.find((p) => p.periodNo === 3)!;
      march = { id: m.id, name: m.name };
      expect(march.id).toBeTruthy();
    });

    it("sign-off REFUSES a wrong confirmation string", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/sign-off`,
        headers: asUser(controller), payload: { confirm: "definitely not the period name" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("sign-off REFUSES with no confirmation at all", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/sign-off`,
        headers: asUser(controller), payload: {},
      });
      expect(r.statusCode).toBe(400);
    });

    // Cerbos, not a UI check — `outsider` holds `member` and no finance role at all, so this must
    // deny before the confirmation is even inspected.
    it("a plain member gets 403 on sign-off, not a validation error", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/sign-off`,
        headers: asUser(outsider), payload: { confirm: march.name },
      });
      expect(r.statusCode).toBe(403);
    });

    // The seeded company has never been signed off, so this blocker must be present BEFORE the
    // sign-off below — otherwise the next test proves nothing about what sign-off actually changed.
    it("close-readiness names NO_ACCOUNTANT_SIGNOFF before anyone signs off", async () => {
      const body = (await get(`/api/${tenant}/finance/periods/${march.id}/close-readiness`, clerk)).json() as
        { blockers: Array<{ blocker: string }>; ready: boolean };
      expect(body.blockers.map((b) => b.blocker)).toContain("NO_ACCOUNTANT_SIGNOFF");
    });

    it("sign-off SUCCEEDS with the exact period name", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/sign-off`,
        headers: asUser(controller), payload: { confirm: march.name },
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, period: march.name });
    });

    it("a second sign-off of the same period is refused", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/sign-off`,
        headers: asUser(controller), payload: { confirm: march.name },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: expect.stringContaining("already signed off") });
    });

    // Sign-off is an INPUT to the close gate, not a synonym for passing it — assert only the one
    // thing sign-off actually changed, and do not assume the gate is now clear.
    it("close-readiness no longer names NO_ACCOUNTANT_SIGNOFF once signed off", async () => {
      const body = (await get(`/api/${tenant}/finance/periods/${march.id}/close-readiness`, clerk)).json() as
        { blockers: Array<{ blocker: string }>; ready: boolean };
      expect(body.blockers.map((b) => b.blocker)).not.toContain("NO_ACCOUNTANT_SIGNOFF");
    });

    it("close REFUSES without a reason", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/close`,
        headers: asUser(controller), payload: { confirm: march.name },
      });
      expect(r.statusCode).toBe(400);
    });

    // "aug 2026" is not proof of having read "Aug 2026" — the comparison is trimmed but
    // case-sensitive on purpose, and the refusal must still name the period correctly.
    it("close is CASE-SENSITIVE: the period name in lowercase is refused", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/close`,
        headers: asUser(controller),
        payload: { confirm: march.name.toLowerCase(), reason: "month-end close, case-sensitivity probe" },
      });
      expect(r.statusCode).toBe(400);
      expect(r.json()).toMatchObject({ error: expect.stringContaining(march.name) });
    });

    // The readiness gate is RE-CHECKED inside the handler, not trusted from whatever the caller
    // last saw — so read current readiness first and let it decide which branch is correct. Do NOT
    // assume the close succeeds just because sign-off happened above; other blockers (an open AR
    // subledger, an unreconciled bank account, etc.) may still be there.
    it("close REFUSES while blockers remain and names one, or else genuinely succeeds", async () => {
      const readiness = (await get(`/api/${tenant}/finance/periods/${march.id}/close-readiness`, clerk)).json() as
        { blockers: Array<{ blocker: string }>; ready: boolean };
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/close`,
        headers: asUser(controller), payload: { confirm: march.name, reason: "month-end close" },
      });
      if (readiness.ready) {
        expect(r.statusCode).toBe(200);
      } else {
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ error: expect.stringContaining(readiness.blockers[0].blocker) });
      }
    });

    it("a plain member gets 403 on close, not a validation error", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/periods/${march.id}/close`,
        headers: asUser(outsider), payload: { confirm: march.name, reason: "should never reach this" },
      });
      expect(r.statusCode).toBe(403);
    });

    describe("recognise-lease", () => {
      // finance_instruments.kind is a CHECK ('loan_payable','loan_receivable','bond_issued','lease')
      // — there is no create endpoint yet (F11 is read-only over HTTP so far), so a loan is seeded
      // directly to prove the handler refuses a non-lease BEFORE it ever asks for confirmation.
      it("refuses an instrument whose kind is not 'lease', naming the kind", async () => {
        let loanId = "";
        await withTenants([tenant], async (c) => {
          await c.query("SELECT set_config('app.scopes','finance',true)");
          const r = await c.query<{ id: string }>(
            `INSERT INTO finance_instruments
               (tenant_id, code, name, kind, currency_code, principal, start_date, maturity_date, repayment_method)
             VALUES ($1,'LOAN-900','Bank Loan','loan_payable','IDR',100000000,'2026-01-01','2030-01-01','bullet')
             RETURNING id`,
            [tenant],
          );
          loanId = r.rows[0].id;
        }, { modules: ["finance"] });

        const r = await app.inject({
          method: "POST", url: `/api/${tenant}/finance/instruments/${loanId}/recognise-lease`,
          headers: asUser(controller),
          payload: { confirm: "LOAN-900", assetClassId: "00000000-0000-0000-0000-000000000000" },
        });
        expect(r.statusCode).toBe(400);
        expect(r.json()).toMatchObject({ error: expect.stringContaining("loan_payable") });
      });
    });
  });

  // ── The payables WRITE path, driven over HTTP ─────────────────────────────────────────────────
  //
  // `finance_ap` is the module with the widest action split in the policy (see
  // cerbos/policies/resource_finance_ap.yaml): read/reconcile, bill_entry, vendor_master, approve
  // and payment_release are FIVE separately-grantable actions, not one "manage". The point of this
  // block is to prove the split is real against the live PDP, not just present in the yaml — and
  // that the withholding math a vendor bill computes is the actual reason the endpoint exists: a
  // vendor and DJP are different creditors, and paying the vendor the bill total would simply be
  // wrong.
  describe("payables — the write path", () => {
    let vendorId = "";
    let billId = "";

    // ── Master data authorization ───────────────────────────────────────────────────────────────
    // resource_finance_ap.yaml, `vendor_master` rule: derivedRoles ["module_manager","company_admin"]
    // at assurance == "high". NOT module_staff — editing a vendor (bank details included) is kept off
    // the clerk's hands deliberately, per the file's own header ("the highest-leverage AP fraud").
    it("a plain member cannot create a vendor", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendors`, headers: asUser(outsider),
        payload: { code: "V-NOPE", name: "Should Not Exist" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("★ finance_staff CANNOT create a vendor — vendor_master is module_manager/company_admin only", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendors`, headers: asUser(clerk),
        payload: { code: "V-CLERK-NOPE", name: "Clerk Should Not Create This" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("the controller (finance_manager → module_manager) CAN create a vendor", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendors`, headers: asUser(controller),
        payload: { code: "V-900", name: "PT Pemasok Uji", npwp: "01.234.567.8-901.000" },
      });
      expect(r.statusCode).toBe(201);
      vendorId = (r.json() as { id: string }).id;
      expect(vendorId).toBeTruthy();
    });

    it("REFUSES a duplicate vendor code", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendors`, headers: asUser(controller),
        payload: { code: "V-900", name: "Same Code, Different Company" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("REFUSES a duplicate AR customer code too", async () => {
      // finance_ar `manage` is module_staff-reachable (unlike vendor_master), so this is deliberately
      // driven as the clerk — the duplicate-code guard is not an authorization question.
      const first = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/customers`, headers: asUser(clerk),
        payload: { code: "C-950", name: "PT Pelanggan Uji" },
      });
      expect(first.statusCode).toBe(201);
      const dup = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/customers`, headers: asUser(clerk),
        payload: { code: "C-950", name: "Same Code Again" },
      });
      expect(dup.statusCode).toBe(400);
    });

    // ── withholdingRate validation ──────────────────────────────────────────────────────────────
    it("REFUSES withholdingRate expressed as a PERCENTAGE rather than a rate", async () => {
      // 2 (meaning "2%") would withhold 200% of the subtotal and pay the vendor a negative amount —
      // the controller rejects anything outside [0,1] for exactly this reason.
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills`, headers: asUser(clerk),
        payload: {
          vendorId, billNo: "BILL-BADRATE", billDate: "2026-03-05", dueDate: "2026-04-04",
          withholdingRate: 2, withholdingAccountCode: "2151",
          lines: [{ description: "Jasa konsultasi", unitPrice: 1_000_000, expenseAccountCode: "6200" }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it("REFUSES a withholding rate with no withholdingAccountCode", async () => {
      // Tax withheld is a liability TO DJP, not to the vendor — it needs an account of its own.
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills`, headers: asUser(clerk),
        payload: {
          vendorId, billNo: "BILL-NOACCT", billDate: "2026-03-05", dueDate: "2026-04-04",
          withholdingRate: 0.02,
          lines: [{ description: "Jasa konsultasi", unitPrice: 1_000_000, expenseAccountCode: "6200" }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    // ── bill entry authorization ────────────────────────────────────────────────────────────────
    // `bill_entry` rule: derivedRoles ["module_staff","module_manager"], condition notLow — the AP
    // clerk's day job, nothing has reached the books yet.
    it("a plain member cannot enter a bill", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills`, headers: asUser(outsider),
        payload: {
          vendorId, billNo: "BILL-NOPE", billDate: "2026-03-05", dueDate: "2026-04-04",
          lines: [{ description: "x", unitPrice: 1000, expenseAccountCode: "6200" }],
        },
      });
      expect(r.statusCode).toBe(403);
    });

    // ── ★ THE WITHHOLDING SPLIT — the whole point of this endpoint ─────────────────────────────
    it("★ clerk enters a bill as a DRAFT, computing the withholding split correctly", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills`, headers: asUser(clerk),
        payload: {
          vendorId, billNo: "BILL-900", billDate: "2026-03-05", dueDate: "2026-04-04",
          withholdingRate: 0.02, withholdingCode: "PPh23", withholdingAccountCode: "2151",
          lines: [{
            description: "Jasa konsultasi", quantity: 1, unitPrice: 35_000_000,
            expenseAccountCode: "6200", taxCode: "PPN", taxRate: 12,
          }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as {
        id: string; status: string; subtotal: number; taxTotal: number; total: number;
        withholdingAmount: number; amountPayable: number;
      };
      billId = body.id;
      expect(body.status).toBe("draft");
      // PPN: 35,000,000 x 11/12 x 12% = 3,850,000 — NOT a flat 12% (4,200,000).
      expect(body.taxTotal).toBe(3_850_000);
      expect(body.total).toBe(38_850_000);
      // Withholding: 35,000,000 x 2% = 700,000, held back from the VENDOR, not from DJP's cut.
      expect(body.withholdingAmount).toBe(700_000);
      // The vendor is owed total MINUS withholding — DJP is owed the 700,000 separately.
      expect(body.amountPayable).toBe(38_150_000);
    });

    // ── A draft posts NOTHING ───────────────────────────────────────────────────────────────────
    it("the draft bill does NOT appear in AP aging — nothing has posted yet", async () => {
      // finance_ap_aging (and open-bills) only count approved/paid bills. A draft is a form on
      // someone's desk, not a liability the company has admitted to.
      const aging = (await get(`/api/${tenant}/finance/ap/aging?asOf=2026-04-30`, clerk)).json() as
        Array<{ vendorName: string }>;
      expect(aging.some((a) => a.vendorName === "PT Pemasok Uji")).toBe(false);

      const open = (await get(`/api/${tenant}/finance/ap/open-bills`, clerk)).json() as
        Array<{ billNo: string }>;
      expect(open.some((b) => b.billNo === "BILL-900")).toBe(false);
    });

    // ── approve authorization ───────────────────────────────────────────────────────────────────
    // `approve` rule: derivedRoles ["module_manager","company_admin"] at assurance high. NOT
    // module_staff — the person who typed the bill in must not be the one who admits it to the books
    // (ap_bill_entry + ap_payment_approve is a seeded blocking conflict per the policy file's header).
    it("★ finance_staff CANNOT approve the bill it just entered", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/approve`, headers: asUser(clerk),
      });
      expect(r.statusCode).toBe(403);
    });

    it("a plain member cannot approve a bill", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/approve`, headers: asUser(outsider),
      });
      expect(r.statusCode).toBe(403);
    });

    // ── Approving POSTS — the assertion that matters is the tie-out, not the 200 ──────────────────
    it("the controller approves the bill, and it posts", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/approve`, headers: asUser(controller),
      });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ok: true, billNo: "BILL-900" });
    });

    it("★ the approved bill appears in open-bills, and AP reconcile is STILL clean", async () => {
      const open = (await get(`/api/${tenant}/finance/ap/open-bills`, clerk)).json() as
        Array<{ billNo: string; amountPayable: string; withholdingAmount: string }>;
      const posted = open.find((b) => b.billNo === "BILL-900");
      expect(posted).toBeTruthy();
      expect(Number(posted!.amountPayable)).toBe(38_150_000);

      // ★ THE REAL ASSERTION. A 201 with a broken subledger tie-out is worse than a 500 — this is
      // what proves the withholding split actually posted to two DIFFERENT liability accounts
      // instead of silently leaving the AP control account short.
      const rec = (await get(`/api/${tenant}/finance/ap/reconcile?asOf=2026-04-30`, clerk)).json() as
        { clean: boolean; problems: unknown[] };
      expect(rec.problems).toEqual([]);
      expect(rec.clean).toBe(true);
    });

    // ── payment_release authorization — the narrowest grant in the module ──────────────────────
    // `payment_release` rule: derivedRoles ["module_manager"] ONLY at assurance high — not even
    // company_admin. Whoever enters bills must not also release money (a second SoD pair, distinct
    // from bill_entry/approve).
    it("★ finance_staff CANNOT release a payment", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/payments`, headers: asUser(clerk),
        payload: {
          vendorId, paymentNo: "PAY-NOPE", paymentDate: "2026-03-20",
          amount: 1000, bankAccountCode: "1120",
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it("a plain member cannot release a payment", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/payments`, headers: asUser(outsider),
        payload: {
          vendorId, paymentNo: "PAY-NOPE2", paymentDate: "2026-03-20",
          amount: 1000, bankAccountCode: "1120",
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it("the controller (module_manager) CAN release a payment against the approved bill", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/payments`, headers: asUser(controller),
        payload: {
          vendorId, paymentNo: "PAY-900", paymentDate: "2026-03-25", amount: 38_150_000,
          bankAccountCode: "1120", allocations: [{ billId, amount: 38_150_000 }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { allocated: number; onAccount: number };
      expect(body.allocated).toBe(38_150_000);
      expect(body.onAccount).toBe(0);

      const rec = (await get(`/api/${tenant}/finance/ap/reconcile?asOf=2026-04-30`, clerk)).json() as
        { clean: boolean };
      expect(rec.clean).toBe(true);
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

  // ── The fiscal-year list exists so closing a year is reachable ────────────────────────────────
  it("fiscal-years returns the ID the close endpoint needs, and the open-period count", async () => {
    const r = await get(`/api/${tenant}/finance/fiscal-years`, controller);
    expect(r.statusCode).toBe(200);
    const rows = r.json() as Array<{
      id: string; code: string; startDate: string; endDate: string;
      status: string; periodCount: number; openPeriods: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    // The whole point: POST /fiscal-years/:id/close takes a uuid, and before this endpoint nothing
    // returned one — /periods carries the year CODE only, so a console could list years and not act.
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rows[0].startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Counts are numbers, not decimal strings — they are ::int in the query so the UI can compare
    // `openPeriods > 0` without coercing. A string "0" is truthy and would disable nothing.
    expect(typeof rows[0].periodCount).toBe("number");
    expect(typeof rows[0].openPeriods).toBe("number");
  });

  // ── F4b: CREDIT NOTES AND WRITE-OFFS ──────────────────────────────────────────────────────────
  //
  // The whole point of these two being separate documents is the VAT treatment, and that is a
  // difference no type system and no typecheck can catch — it only shows up in the posted journal.
  // So the two central assertions here are literally "is there a 2140 line" and "is there not".
  describe("credit notes and write-offs (F4b)", () => {
    let cust = "";
    let invoiceId = "";

    beforeAll(async () => {
      await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        await c.query(
          `INSERT INTO finance_ar_customers (tenant_id, code, name, payment_terms_days, is_pkp)
           VALUES ($1,'C-950','Credit Note Co',30,true)
           ON CONFLICT DO NOTHING`, [tenant]);
        const r = await c.query<{ id: string }>(
          `SELECT id FROM finance_ar_customers WHERE tenant_id = $1 AND code = 'C-950'`, [tenant]);
        cust = r.rows[0].id;
      });

      const inv = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId: cust, invoiceNo: "INV-950", invoiceDate: "2026-03-05", dueDate: "2026-04-04",
          lines: [{ description: "Services", quantity: 1, unitPrice: 1000000, revenueAccountCode: "4100", taxRate: 12 }],
        },
      });
      expect(inv.statusCode).toBe(201);
      invoiceId = (inv.json() as { id: string }).id;
    });

    // ── TIER: the AR clerk banks receipts, so must hold neither of these ────────────────────────
    it("★ finance_staff cannot issue a credit note — the other half of the lapping pair", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/credit-notes`, headers: asUser(clerk),
        payload: {
          customerId: cust, creditNoteNo: "CN-DENIED", creditNoteDate: "2026-03-10",
          reasonCode: "return", reason: "should not be allowed",
          lines: [{ description: "x", amount: 1000, creditAccountCode: "4300" }],
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it("★ finance_staff cannot write off a receivable", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices/${invoiceId}/write-off`,
        headers: asUser(clerk),
        payload: { amount: 1000, writeOffDate: "2026-03-10", reasonCode: "uncollectible", reason: "x", confirm: "INV-950" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("a credit note with no recorded reason is refused", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/credit-notes`, headers: asUser(controller),
        payload: {
          customerId: cust, creditNoteNo: "CN-NOREASON", creditNoteDate: "2026-03-10",
          reasonCode: "return",
          lines: [{ description: "x", amount: 1000, creditAccountCode: "4300" }],
        },
      });
      expect(r.statusCode).toBe(400);
    });

    it("★★ a credit note REVERSES output VAT — there is a 2140 debit", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/credit-notes`, headers: asUser(controller),
        payload: {
          customerId: cust, creditNoteNo: "CN-950", creditNoteDate: "2026-03-10",
          reasonCode: "return", reason: "Client returned part of the engagement",
          originalInvoiceId: invoiceId,
          lines: [{ description: "Returned services", amount: 200000, creditAccountCode: "4300", taxRate: 12 }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { id: string; taxTotal: number };
      // 12% applied to 11/12 of the base — the same convention the invoice used.
      expect(body.taxTotal).toBe(Math.round(200000 * (11 / 12) * 0.12));

      const lines = await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        const q = await c.query<{ code: string; side: string; amount: string }>(
          `SELECT a.code, l.side, l.amount::text
             FROM finance_ar_credit_notes n
             JOIN finance_journal_lines l ON l.entry_id = n.journal_entry_id
             JOIN finance_accounts a ON a.id = l.account_id
            WHERE n.id = $1 ORDER BY a.code`, [body.id]);
        return q.rows;
      }, { modules: ["finance"] });

      const vat = lines.find((l) => l.code === "2140");
      expect(vat, "a credit note must reverse output VAT").toBeTruthy();
      expect(vat!.side).toBe("debit");
      // Contra-revenue, NOT the original revenue account — netting them hides the return rate.
      expect(lines.some((l) => l.code === "4300" && l.side === "debit")).toBe(true);
    });

    it("a write-off refuses a confirmation that does not match the invoice number", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices/${invoiceId}/write-off`,
        headers: asUser(controller),
        payload: { amount: 300000, writeOffDate: "2026-03-12", reasonCode: "uncollectible", reason: "gone", confirm: "INV-951" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("★★ a write-off does NOT reverse output VAT — there is no 2140 line", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices/${invoiceId}/write-off`,
        headers: asUser(controller),
        payload: {
          amount: 300000, writeOffDate: "2026-03-12", reasonCode: "customer_insolvent",
          reason: "Customer entered liquidation", confirm: "INV-950",
        },
      });
      expect(r.statusCode).toBe(201);

      const lines = await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        const q = await c.query<{ code: string; side: string }>(
          `SELECT a.code, l.side
             FROM finance_ar_writeoffs w
             JOIN finance_journal_lines l ON l.entry_id = w.journal_entry_id
             JOIN finance_accounts a ON a.id = l.account_id
            WHERE w.invoice_id = $1 ORDER BY a.code`, [invoiceId]);
        return q.rows;
      }, { modules: ["finance"] });

      // THE assertion. Indonesian PPN gives no relief for a bad debt; a 2140 line here would
      // reclaim VAT the company is not entitled to and understate tax payable.
      expect(lines.some((l) => l.code === "2140"), "a write-off must NOT reverse VAT").toBe(false);
      expect(lines.some((l) => l.code === "6950" && l.side === "debit")).toBe(true);
    });

    it("★★ the subledger still ties to the general ledger after both", async () => {
      const r = await get(`/api/${tenant}/finance/ar/reconcile`, controller);
      expect(r.statusCode).toBe(200);
      const rec = r.json() as { clean: boolean; problems?: unknown[] };
      // If this fails, the aging/reconcile re-definitions in 202608270900 did not learn about
      // credits or write-offs — which is the failure that whole migration exists to avoid.
      expect(rec.problems ?? [], "credits and write-offs must not break the tie-out").toEqual([]);
      expect(rec.clean).toBe(true);
    });
  });

  // ── F5b: AP VENDOR CREDITS AND WRITE-OFFS ─────────────────────────────────────────────────────
  //
  // The payables mirror, and the tests exist because it is NOT a sign flip. Three assertions carry
  // the whole design: the credit touches INPUT VAT (1170) and never output VAT; the write-off
  // credits INCOME and never an expense or a VAT account; and unwinding withholding raises a bukti
  // potong flag instead of blocking or silently amending a filing.
  describe("AP vendor credits and write-offs (F5b)", () => {
    let vend = "";
    let billId = "";
    let creditId = "";

    beforeAll(async () => {
      await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        await c.query(
          `INSERT INTO finance_ap_vendors (tenant_id, code, name, npwp, is_pkp, payment_terms_days)
           VALUES ($1,'V-950','Vendor Credit Co','01.234.567.8-901.000',true,30)
           ON CONFLICT DO NOTHING`, [tenant]);
        const r = await c.query<{ id: string }>(
          `SELECT id FROM finance_ap_vendors WHERE tenant_id = $1 AND code = 'V-950'`, [tenant]);
        vend = r.rows[0].id;
      }, { modules: ["finance"] });

      // 10,000,000 + 1,100,000 PPN Masukan, less 2% PPh 23 = 200,000 withheld.
      // amount_payable therefore 10,900,000 — the company never owed the vendor the withheld part.
      const bill = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills`, headers: asUser(clerk),
        payload: {
          vendorId: vend, billNo: "BILL-950", billDate: "2026-03-05", dueDate: "2026-04-04",
          withholdingCode: "PPH23", withholdingRate: 0.02, withholdingAccountCode: "2151",
          lines: [{ description: "Consulting", quantity: 1, unitPrice: 10000000, expenseAccountCode: "6600", taxRate: 12 }],
        },
      });
      expect(bill.statusCode).toBe(201);
      billId = (bill.json() as { id: string }).id;
      // A draft bill is not on the books; approving is what posts it.
      const ok = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/approve`, headers: asUser(controller),
        payload: {},
      });
      expect(ok.statusCode).toBeLessThan(300);
    });

    it("★ finance_staff can enter a bill but cannot credit it away", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendor-credits`, headers: asUser(clerk),
        payload: {
          vendorId: vend, creditNo: "VC-DENIED", creditDate: "2026-03-10",
          reasonCode: "return", reason: "should not be allowed",
          lines: [{ description: "x", amount: 1000, creditAccountCode: "6600" }],
        },
      });
      expect(r.statusCode).toBe(403);
    });

    it("★ finance_staff cannot write off a payable", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/write-off`, headers: asUser(clerk),
        payload: { amount: 1000, writeOffDate: "2026-03-10", reasonCode: "unclaimed", reason: "x", confirm: "BILL-950" },
      });
      expect(r.statusCode).toBe(403);
    });

    it("★★ a vendor credit reverses INPUT VAT (1170) and never output VAT, and unwinds withholding", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendor-credits`, headers: asUser(controller),
        payload: {
          vendorId: vend, creditNo: "VC-950", creditDate: "2026-03-10",
          reasonCode: "return", reason: "Returned part of the engagement",
          originalBillId: billId, notaReturNo: "NR-950",
          withholdingCode: "PPH23", withholdingRate: 0.02, withholdingAmount: 40000,
          lines: [{ description: "Returned consulting", amount: 2000000, creditAccountCode: "6600", taxRate: 12 }],
        },
      });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { id: string; taxTotal: number; amountPayable: number; requiresBupotAmendment: boolean };
      creditId = body.id;
      expect(body.taxTotal).toBe(Math.round(2000000 * (11 / 12) * 0.12));
      // total 2,220,000 less 40,000 withheld
      expect(body.amountPayable).toBe(2000000 + body.taxTotal - 40000);
      expect(body.requiresBupotAmendment).toBe(true);

      const lines = await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        const q = await c.query<{ code: string; side: string; amount: string }>(
          `SELECT a.code, l.side, l.amount::text
             FROM finance_ap_vendor_credits vc
             JOIN finance_journal_lines l ON l.entry_id = vc.journal_entry_id
             JOIN finance_accounts a ON a.id = l.account_id
            WHERE vc.id = $1 ORDER BY a.code`, [body.id]);
        return q.rows;
      }, { modules: ["finance"] });

      // THE assertion pair. Input VAT is an asset we CLAIMED; crediting gives the claim back.
      expect(lines.some((l) => l.code === "1170" && l.side === "credit"),
        "a vendor credit must reverse INPUT VAT").toBe(true);
      expect(lines.some((l) => l.code === "2140"),
        "a vendor credit must NOT touch output VAT — that is the AR side").toBe(false);
      // The withholding leg, without which the journal cannot balance.
      expect(lines.some((l) => l.code === "2151" && l.side === "debit")).toBe(true);
      // AP is debited by amount_payable, NOT the gross total.
      const ap = lines.find((l) => l.code === "2110" && l.side === "debit");
      expect(ap, "AP control must be debited").toBeTruthy();
      expect(Number(ap!.amount)).toBe(body.amountPayable);
    });

    it("★★ the bukti potong exposure is FLAGGED, not blocked and not auto-amended", async () => {
      // Ruling (c): the credit above already posted — that is the "not blocked" half.
      const ex = await get(`/api/${tenant}/finance/ap/bupot-exceptions`, controller);
      expect(ex.statusCode).toBe(200);
      const rows = ex.json() as Array<{ creditNo: string; withholdingReversed: string }>;
      expect(rows.some((x) => x.creditNo === "VC-950")).toBe(true);

      // ...and it surfaces on the reconciliation, which is the screen somebody reads at close.
      const rec = await get(`/api/${tenant}/finance/ap/reconcile`, controller);
      const problems = (rec.json() as { problems: Array<{ problem: string }> }).problems;
      expect(problems.some((p) => p.problem === "AP_BUPOT_AMENDMENT_PENDING")).toBe(true);
      // Crucially it is the ONLY complaint: the ledger itself ties out.
      expect(problems.filter((p) => p.problem !== "AP_BUPOT_AMENDMENT_PENDING")).toEqual([]);
    });

    it("recording the amended bukti potong clears the flag, and needs a reference", async () => {
      const noRef = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendor-credits/${creditId}/bupot-amended`,
        headers: asUser(controller), payload: {},
      });
      expect(noRef.statusCode).toBe(400);

      const ok = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/vendor-credits/${creditId}/bupot-amended`,
        headers: asUser(controller), payload: { amendmentRef: "BP-AMEND-950" },
      });
      expect(ok.statusCode).toBe(200);

      const rec = await get(`/api/${tenant}/finance/ap/reconcile`, controller);
      expect((rec.json() as { problems: unknown[] }).problems).toEqual([]);
    });

    it("a write-off refuses a confirmation that does not match the bill number", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/write-off`, headers: asUser(controller),
        payload: { amount: 500000, writeOffDate: "2026-03-12", reasonCode: "unclaimed", reason: "x", confirm: "BILL-951" },
      });
      expect(r.statusCode).toBe(400);
    });

    it("★★ an AP write-off credits INCOME, not an expense, and posts no VAT leg", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ap/bills/${billId}/write-off`, headers: asUser(controller),
        payload: {
          amount: 500000, writeOffDate: "2026-03-12", reasonCode: "vendor_dissolved",
          reason: "Supplier struck off the register", confirm: "BILL-950",
        },
      });
      expect(r.statusCode).toBe(201);

      const lines = await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        const q = await c.query<{ code: string; account_type: string; side: string }>(
          `SELECT a.code, a.account_type, l.side
             FROM finance_ap_writeoffs w
             JOIN finance_journal_lines l ON l.entry_id = w.journal_entry_id
             JOIN finance_accounts a ON a.id = l.account_id
            WHERE w.bill_id = $1`, [billId]);
        return q.rows;
      }, { modules: ["finance"] });

      // Released debt is taxable INCOME (pembebasan utang). Crediting the original expense account
      // would understate taxable profit and bury the event in a cost centre.
      const credit = lines.find((l) => l.side === "credit");
      expect(credit, "the write-off must credit something").toBeTruthy();
      expect(credit!.account_type, "released debt is INCOME, not a negative expense").toBe("revenue");
      expect(credit!.code).toBe("7300");
      // The input VAT was validly claimed when the supply happened; not paying does not undo that.
      expect(lines.some((l) => l.code === "1170"),
        "an AP write-off must NOT claw back input VAT").toBe(false);
    });

    it("★★ the payables subledger still ties to the general ledger after both", async () => {
      const r = await get(`/api/${tenant}/finance/ap/reconcile`, controller);
      expect(r.statusCode).toBe(200);
      const rec = r.json() as {
        clean: boolean; problems?: unknown[];
        position: { openBills: string; paymentsOnAccount: string; unappliedCredits: string; netPayable: string };
      };
      expect(rec.problems ?? [], "vendor credits and write-offs must not break the AP tie-out").toEqual([]);
      expect(rec.clean).toBe(true);

      // ★ The WIRE payload, not just the SQL. finance_ap_position() gained unapplied_credits in
      // 202608272000 and the handler's SELECT list did not name it — the function computed the
      // number and the handler threw it away. tsc cannot see that (the SQL is a string, the return
      // type is inferred from nothing), the reconciliation still passed, and the console rendered
      // undefined. Caught in review, not by a test, which is why this assertion exists.
      expect(rec.position, "the reconcile payload must carry the position").toBeTruthy();
      for (const k of ["openBills", "paymentsOnAccount", "unappliedCredits", "netPayable"] as const) {
        expect(rec.position[k], `position.${k} must be on the wire, not just in the function`).toBeDefined();
      }
      // And the identity the third term exists to preserve.
      const n = (v: string) => Number(v);
      expect(n(rec.position.netPayable)).toBeCloseTo(
        n(rec.position.openBills) - n(rec.position.paymentsOnAccount) - n(rec.position.unappliedCredits), 4);
    });
  });

  // ── F7b: THE TAX RETURN LIFECYCLE ─────────────────────────────────────────────────────────────
  //
  // The lifecycle lives in SQL (202608271230). What matters here is the property the whole design
  // exists for: a FILED return is a snapshot of what was told to DJP, and it must stop tracking the
  // ledger. The last test posts into a filed period and asserts the drift check notices — if filed
  // figures were being recomputed, that test would pass silently and the snapshot would be a lie.
  describe("tax return lifecycle (F7b)", () => {
    let returnId = "";
    let cust2 = "";

    beforeAll(async () => {
      await withTenants([tenant], async (c) => {
        await c.query("SELECT set_config('app.scopes','finance',true)");
        await c.query(
          `INSERT INTO finance_ar_customers (tenant_id, code, name, payment_terms_days, is_pkp)
           VALUES ($1,'C-960','Late Billing Co',30,true) ON CONFLICT DO NOTHING`, [tenant]);
        const r = await c.query<{ id: string }>(
          `SELECT id FROM finance_ar_customers WHERE tenant_id = $1 AND code = 'C-960'`, [tenant]);
        cust2 = r.rows[0].id;
      }, { modules: ["finance"] });
    });

    it("refuses a monthly return with no month, and an annual one with a month", async () => {
      const noMonth = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns`, headers: asUser(controller),
        payload: { kind: "ppn", periodYear: 2026 },
      });
      expect(noMonth.statusCode).toBe(400);

      const badanWithMonth = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns`, headers: asUser(controller),
        payload: { kind: "pph_badan", periodYear: 2026, periodMonth: 3 },
      });
      expect(badanWithMonth.statusCode).toBe(400);
    });

    it("prepares a PPN return and is idempotent for the same period", async () => {
      const first = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns`, headers: asUser(controller),
        payload: { kind: "ppn", periodYear: 2026, periodMonth: 3 },
      });
      expect(first.statusCode).toBe(201);
      const a = first.json() as { id: string; status: string; computed: { output: number; net: number } };
      expect(a.status).toBe("draft");
      returnId = a.id;

      // UNIQUE (tenant, kind, year, month) — preparing twice is the same document, not a second one.
      const second = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns`, headers: asUser(controller),
        payload: { kind: "ppn", periodYear: 2026, periodMonth: 3 },
      });
      expect(second.statusCode).toBe(201);
      expect((second.json() as { id: string }).id).toBe(returnId);
    });

    it("filing refuses without a filingReference, and without a matching confirmation", async () => {
      const noRef = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns/${returnId}/file`,
        headers: asUser(controller), payload: { confirm: "PPN 2026-03" },
      });
      expect(noRef.statusCode).toBe(400);

      const badConfirm = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns/${returnId}/file`,
        headers: asUser(controller), payload: { filingReference: "NTPN-TEST-1", confirm: "PPN 2026-04" },
      });
      expect(badConfirm.statusCode).toBe(400);
    });

    it("★★ filing SNAPSHOTS the figures, and drift is clean immediately after", async () => {
      const r = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns/${returnId}/file`,
        headers: asUser(controller),
        payload: { filingReference: "NTPN-TEST-1", confirm: "PPN 2026-03" },
      });
      expect(r.statusCode).toBe(200);
      const filed = r.json() as { status: string; filed: { output: number; net: number } };
      expect(filed.status).toBe("filed");

      const drift = await get(`/api/${tenant}/finance/tax/returns/drift`, controller);
      expect(drift.statusCode).toBe(200);
      expect((drift.json() as { clean: boolean }).clean).toBe(true);
    });

    it("★★ a journal posted into a FILED period shows up as drift", async () => {
      // A late invoice in an already-declared month. This is a real event, not an error — but it
      // means the figure of record no longer matches the ledger, and somebody has to decide whether
      // to amend. The whole point of snapshotting is that this is DETECTABLE.
      const late = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/ar/invoices`, headers: asUser(clerk),
        payload: {
          customerId: cust2, invoiceNo: "INV-LATE-950", invoiceDate: "2026-03-28", dueDate: "2026-04-27",
          lines: [{ description: "Late billing", quantity: 1, unitPrice: 5000000, revenueAccountCode: "4100", taxRate: 12 }],
        },
      });
      expect(late.statusCode).toBe(201);

      const drift = await get(`/api/${tenant}/finance/tax/returns/drift`, controller);
      expect(drift.statusCode).toBe(200);
      const d = drift.json() as { clean: boolean; problems: Array<{ problem: string; detail: string }> };
      expect(d.clean, "a journal in a filed tax period must be detectable").toBe(false);
      expect(d.problems.some((p) => p.problem === "TAX_RETURN_LEDGER_DRIFT")).toBe(true);
    });

    it("re-filing a filed return requires amend:true, and records it as amended", async () => {
      const plain = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns/${returnId}/file`,
        headers: asUser(controller),
        payload: { filingReference: "NTPN-TEST-2", confirm: "PPN 2026-03" },
      });
      expect(plain.statusCode).toBe(400);

      const amended = await app.inject({
        method: "POST", url: `/api/${tenant}/finance/tax/returns/${returnId}/file`,
        headers: asUser(controller),
        payload: { filingReference: "NTPN-TEST-2", confirm: "PPN 2026-03", amend: true },
      });
      expect(amended.statusCode).toBe(200);
      expect((amended.json() as { status: string }).status).toBe("amended");

      // Amending re-snapshots, so the drift it was filed against is resolved.
      const drift = await get(`/api/${tenant}/finance/tax/returns/drift`, controller);
      expect((drift.json() as { clean: boolean }).clean).toBe(true);
    });
  });

});
