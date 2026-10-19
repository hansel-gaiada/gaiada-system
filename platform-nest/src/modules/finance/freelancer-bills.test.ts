// DW-10f-4a — freelancers, their rates and their bills over the REAL HTTP surface (docs/FRONTEND-BFF-CONTRACT.md §61.7,
// §61.8, §61.12, §61.14 "Freelancers"; PERMISSION-CONTRACT §51), against live Postgres + RLS + Cerbos.
//
// What it proves:
//   * authorization first: a denied caller gets 403 before any 400 on every new route; vendor_master needs HIGH assurance
//     (a finance_manager at linked assurance and a finance_staff are refused; a company_admin at high passes); a
//     company_admin cannot draft (no bill_entry);
//   * rates: add, the automatic close of the open rate, rate_overlap (and the EXCLUDE itself), end, reopen, withdraw an
//     unused rate, rate_used, freelancer_on_payroll, currency_not_functional, expense_account_invalid, rate_invalid,
//     date_invalid, person_not_found for a client contact and for a member of another company;
//   * the vendor link: person_has_vendor, vendor_not_found, unlink and relink, userId on the vendor list;
//   * preview and draft: the rate in force per entry date, a line per (project, rate), the money rounded ONCE per line
//     (two 25-minute entries at 100,000/h are 83,333, not 2 × 41,667), withholding = finance_tax_compute() with PPH21
//     (5% on half the base), amount payable = total − withholding, every entry claimed; DW-D47 (no code: no withholding and
//     NO_WITHHOLDING on the preview, the POST answer and the list row); each blocker writes nothing; replay, late entry,
//     nothing_to_bill;
//   * the claim: two concurrent drafts of one period bill each entry once; a claimed entry's minutes cannot be edited
//     (409 time_entry_billed; notes still change); discard releases the entries; an approved bill is not discarded;
//   * approval through the existing AP route posts the expense, the payable and the 2150 withholding, and AP reconciles;
//   * RLS: another company's freelancers, vendors and bills are invisible, and the finance scope is what makes rows readable.
// Needs DATABASE_URL_TEST and a running Cerbos (the Linux CI gate); skips without the database.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject, linkIdentity } from "../../testing/fixtures";

const SVC = "svc-token-dw10f4a";
const as = (id: string) => ({ authorization: `Bearer ${SVC}`, "x-user-id": id });
const codeOf = (e: unknown) => (e as { code?: string } | undefined)?.code;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe.skipIf(!TEST_URL)("DW-10f-4a · freelancers, rates and freelancer bills over HTTP (BFF §61.7, §61.8)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  // Staff of A.
  let fm: string; // finance_manager (vendor_master at high, approve, bill_entry)
  let fs: string; // finance_staff (bill_entry, read; never vendor_master)
  let ca: string; // company_admin (vendor_master at high, approve; never bill_entry)
  let mem: string; // a plain member
  // People of A.
  let F: string; // freelancer with a vendor naming PPH21
  let G: string; // a rate, no vendor
  let H: string; // a vendor with no withholding code (DW-D47)
  let E: string; // an employee on payroll
  let K: string; // a PKP vendor
  let W: string; // a vendor naming a code with no tax code
  let R: string; // the race
  let X: string; // a client contact (users.kind = 'client') with a membership in A
  let Y: string; // a member of B only
  let P1: string;
  let P2: string;
  let P3: string;
  // B.
  let bfs: string;
  let FB: string;
  let PB: string;
  let billB = "";

  let r1 = ""; // F 100,000 from 2026-01-01 (closed 2026-03-15 by r2)
  let r2 = ""; // F 150,000 from 2026-03-16
  let vendorF = "";
  let vendorH = "";
  let billF1 = "";
  const fEntries: string[] = [];
  let fFeb = "";

  const fin = <T>(fn: (c: PoolClient) => Promise<T>, t = A) => withTenants([t], fn, { modules: ["finance"] });
  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: string, payload?: unknown) =>
    app.inject({ method, url: `/api/${url}`, headers: as(who), ...(payload === undefined ? {} : { payload: payload as Json }) });
  const linked = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, ext: string, payload?: unknown) =>
    app.inject({
      method, url: `/api/${url}`,
      headers: { authorization: `Bearer ${SVC}`, "x-obo-provider": "dw10f4a-test", "x-obo-external-id": ext },
      ...(payload === undefined ? {} : { payload: payload as Json }),
    });

  async function setupFinance(t: string, prefix: string) {
    await fin(async (c) => {
      await c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1, 'IDR', 'IDR')`, [t]);
      await c.query(`SELECT finance_instantiate_coa($1, 'id_psak_general_v1')`, [t]);
      // FY2026 for the fixtures' dates, and the current year when it is another one (the preview prices at today).
      const years = [...new Set([2026, new Date().getUTCFullYear()])];
      for (const y of years) {
        const fy = newId();
        await c.query(`INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date) VALUES ($1, $2, $3, $4::date, $5::date)`,
          [fy, t, `FY${y}`, `${y}-01-01`, `${y + 1}-01-01`]);
        await c.query(`SELECT finance_generate_periods($1, 'monthly')`, [fy]);
      }
      // §61.14: PPH21 (kind pph21, rate 5, base multiplier 0.5, account 2150) and PPH23.
      await c.query(
        `INSERT INTO finance_tax_codes (tenant_id, code, name, kind, rate, base_multiplier, account_id, effective_from)
         SELECT $1, 'PPH21', 'PPh 21 non-employee', 'pph21', 5, 0.5, id, '2026-01-01' FROM finance_accounts WHERE tenant_id = $1 AND code = '2150'`, [t]);
      await c.query(
        `INSERT INTO finance_tax_codes (tenant_id, code, name, kind, rate, base_multiplier, account_id, effective_from)
         SELECT $1, 'PPH23', 'PPh 23 services', 'pph23', 2, 1, id, '2026-01-01' FROM finance_accounts WHERE tenant_id = $1 AND code = '2151'`, [t]);
    }, t);
    await withTenants([t], (c) => c.query(
      `INSERT INTO company_billing_profiles (tenant_id, legal_name, address, invoice_prefix) VALUES ($1, $2, 'Jl. Uji 1', $3)`,
      [t, `${prefix} Legal`, prefix]));
  }
  async function entry(user: string, date: string, project: string, minutes: number, t = A) {
    const id = newId();
    await withTenants([t], (c) => c.query(
      `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, entry_date, origin_site) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, t, user, project, minutes, date, config.originSite]));
    return id;
  }
  async function directVendorAndRate(user: string, code: string, o: { pkp?: boolean; wht?: string | null; from?: string } = {}) {
    await fin(async (c) => {
      await c.query(
        `INSERT INTO finance_ap_vendors (tenant_id, code, name, user_id, is_pkp, default_withholding_code) VALUES ($1, $2, $3, $4, $5, $6)`,
        [A, code, `Vendor ${code}`, user, o.pkp ?? null, o.wht ?? null]);
      await c.query(
        `INSERT INTO finance_freelancer_rates (tenant_id, user_id, hourly_rate, currency_code, expense_account_code, valid_from)
         VALUES ($1, $2, 100000, 'IDR', '6600', $3)`, [A, user, o.from ?? "2026-01-01"]);
    });
  }
  const apBillCount = async (t = A) =>
    Number((await adminPool().query(`SELECT count(*)::int AS n FROM finance_ap_bills WHERE tenant_id = $1`, [t])).rows[0].n);
  const billOf = async (te: string) =>
    (await adminPool().query<{ ap_bill_id: string | null }>(`SELECT ap_bill_id FROM time_entries WHERE id = $1`, [te])).rows[0].ap_bill_id;
  const codes = (r: { json: () => unknown }) => ((r.json() as Json).blockers as Array<{ code: string }>).map((b) => b.code);
  const march = { periodStart: "2026-03-01", periodEnd: "2026-03-31" };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = SVC;
    A = await createCompany("DW-10f-4a Agency", ["finance"]);
    B = await createCompany("DW-10f-4a Other company", ["finance"]);
    await setupFinance(A, "GDA");
    await setupFinance(B, "OTH");

    const role = async (name: string) => createRole(name);
    fm = await createUser("fm@dw10f4a.test", "Fina Manager");
    fs = await createUser("fs@dw10f4a.test", "Fadil Staff");
    ca = await createUser("ca@dw10f4a.test", "Citra Admin");
    mem = await createUser("mem@dw10f4a.test", "Maya Member");
    F = await createUser("f@dw10f4a.test", "Fajar Freelancer");
    G = await createUser("g@dw10f4a.test", "Gita NoVendor");
    H = await createUser("h@dw10f4a.test", "Hana NoCode");
    E = await createUser("e@dw10f4a.test", "Eko Employee");
    K = await createUser("k@dw10f4a.test", "Kurnia Pkp");
    W = await createUser("w@dw10f4a.test", "Wawan BadCode");
    R = await createUser("r@dw10f4a.test", "Rina Race");
    X = await createUser("x@dw10f4a.test", "Xena Client");
    Y = await createUser("y@dw10f4a.test", "Yudi OtherCo");
    bfs = await createUser("bfs@dw10f4a.test", "Budi B Staff");
    FB = await createUser("fb@dw10f4a.test", "Fikri B Freelancer");
    for (const u of [fm, fs, ca, mem, F, G, H, E, K, W, R, X]) await addMembership(A, u);
    for (const u of [Y, bfs, FB]) await addMembership(B, u);
    await adminPool().query(`UPDATE users SET kind = 'client' WHERE id = $1`, [X]);
    await grantRole(fm, await role("finance_manager"), "company", A);
    await grantRole(fs, await role("finance_staff"), "company", A);
    await grantRole(ca, await role("company_admin"), "company", A);
    for (const u of [mem, F, G, H, E, K, W, R]) await grantRole(u, await role("member"), "company", A);
    await grantRole(bfs, await role("finance_staff"), "company", B);
    await linkIdentity(fm, "dw10f4a-test", "fm-linked", true);

    P1 = await createProject(A, "P1 Alpha");
    P2 = await createProject(A, "P2 Beta");
    P3 = await createProject(A, "P3 Gamma");
    PB = await createProject(B, "PB project");

    // E is on payroll from 2026-01-01 (hr_compensation through an employees row).
    await withTenants([A], async (c) => {
      const em = await c.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, user_id, display_name, hire_date) VALUES ($1, $2, 'Eko Employee', '2025-06-01') RETURNING id`, [A, E]);
      await c.query(`INSERT INTO hr_compensation (tenant_id, employee_id, subject_user_id, base_amount, effective_from) VALUES ($1, $2, $3, 9000000, '2026-01-01')`,
        [A, em.rows[0].id, E]);
    }, { modules: ["hr"] });

    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("authorization comes first (PERMISSION §51)", () => {
    it("a denied caller gets 403 before any 400, on every new route", async () => {
      expect((await call("POST", `${A}/finance/freelancers/${F}/rates`, fs, { hourlyRate: "x" })).statusCode).toBe(403);
      expect((await call("PATCH", `${A}/finance/freelancers/${F}/rates/${newId()}`, fs, { validTo: "bad" })).statusCode).toBe(403);
      expect((await call("DELETE", `${A}/finance/freelancers/${F}/rates/not-a-uuid`, fs)).statusCode).toBe(403);
      expect((await call("PATCH", `${A}/finance/ap/vendors/${newId()}/person`, fs, {})).statusCode).toBe(403);
      expect((await call("POST", `${A}/finance/freelancer-bills`, mem, { periodStart: "nope" })).statusCode).toBe(403);
      expect((await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=bad`, mem)).statusCode).toBe(403);
      expect((await call("GET", `${A}/finance/freelancer-bills?status=bad`, mem)).statusCode).toBe(403);
      expect((await call("GET", `${A}/finance/freelancers`, mem)).statusCode).toBe(403);
      expect((await call("DELETE", `${A}/finance/freelancer-bills/not-a-uuid`, mem)).statusCode).toBe(403);
    });

    it("vendor_master needs high assurance: a finance_manager at linked assurance and a finance_staff are refused", async () => {
      const body = { hourlyRate: 100000, validFrom: "2026-01-01", expenseAccountCode: "6600" };
      expect((await linked("POST", `${A}/finance/freelancers/${F}/rates`, "fm-linked", body)).statusCode).toBe(403);
      expect((await call("POST", `${A}/finance/freelancers/${F}/rates`, fs, body)).statusCode).toBe(403);
      expect((await linked("PATCH", `${A}/finance/ap/vendors/${newId()}/person`, "fm-linked", { userId: F })).statusCode).toBe(403);
      // ...while the same finance_manager can still READ at linked assurance (notLow).
      expect((await linked("GET", `${A}/finance/freelancers`, "fm-linked")).statusCode).toBe(200);
    });

    it("a company_admin may not draft (no bill_entry), even with a valid body", async () => {
      const r = await call("POST", `${A}/finance/freelancer-bills`, ca, { userId: F, ...march });
      expect(r.statusCode).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("rates (§61.7)", () => {
    it("adds a rate; a second rate closes the open one the day before, in the same transaction", async () => {
      const a = await call("POST", `${A}/finance/freelancers/${F}/rates`, fm, { hourlyRate: 100000, validFrom: "2026-01-01", expenseAccountCode: "6600", note: "first" });
      expect(a.statusCode, a.body).toBe(201);
      expect(a.json()).toMatchObject({ hourlyRate: 100000, currency: "IDR", expenseAccountCode: "6600", validFrom: "2026-01-01", validTo: null, used: false, closedRate: null });
      r1 = a.json().id;
      // A company_admin at high assurance holds vendor_master too.
      const b = await call("POST", `${A}/finance/freelancers/${F}/rates`, ca, { hourlyRate: "150000", validFrom: "2026-03-16", expenseAccountCode: "6600" });
      expect(b.statusCode, b.body).toBe(201);
      r2 = b.json().id;
      expect(b.json().closedRate).toEqual({ id: r1, validTo: "2026-03-15" });
      const stored = await adminPool().query(`SELECT to_char(valid_to, 'YYYY-MM-DD') AS t FROM finance_freelancer_rates WHERE id = $1`, [r1]);
      expect(stored.rows[0].t).toBe("2026-03-15");
      const acts = await adminPool().query(`SELECT verb FROM activities WHERE target_entity_id = ANY($1::uuid[]) ORDER BY occurred_at`, [[r1, r2]]);
      expect(acts.rows.map((x) => x.verb)).toEqual(["freelancer_rate_added", "freelancer_rate_ended", "freelancer_rate_added"]);
    });

    it("refuses an overlapping rate (409 rate_overlap); the EXCLUDE is the wall underneath", async () => {
      const r = await call("POST", `${A}/finance/freelancers/${F}/rates`, fm, { hourlyRate: 120000, validFrom: "2026-02-01", expenseAccountCode: "6600" });
      expect(r.statusCode).toBe(409);
      expect(r.json()).toMatchObject({ reason: "rate_overlap" });
      const direct = await fin((c) => c.query(
        `INSERT INTO finance_freelancer_rates (tenant_id, user_id, hourly_rate, currency_code, expense_account_code, valid_from, valid_to)
         VALUES ($1, $2, 1, 'IDR', '6600', '2026-03-10', '2026-03-20')`, [A, F])).catch((e) => e);
      expect(codeOf(direct)).toBe("23P01");
    });

    it("refuses bad input with its reason: date_invalid, rate_invalid, currency_not_functional, expense_account_invalid", async () => {
      const post = (body: Json) => call("POST", `${A}/finance/freelancers/${G}/rates`, fm, { hourlyRate: 90000, validFrom: "2026-03-01", expenseAccountCode: "6600", ...body });
      const cases: Array<[Json, number, string]> = [
        [{ validFrom: "2026-02-30" }, 400, "date_invalid"],
        [{ hourlyRate: "90000.5" }, 400, "rate_invalid"], // IDR has no decimals
        [{ hourlyRate: -5 }, 400, "rate_invalid"],
        [{ currency: "USD" }, 400, "currency_not_functional"],
        [{ expenseAccountCode: "6000" }, 400, "expense_account_invalid"], // a header account
        [{ expenseAccountCode: "2110" }, 400, "expense_account_invalid"], // the AP control account
        [{ expenseAccountCode: "9999" }, 400, "expense_account_invalid"],
      ];
      for (const [body, status, reason] of cases) {
        const r = await post(body);
        expect(r.statusCode, JSON.stringify(body)).toBe(status);
        expect(r.json().reason, JSON.stringify(body)).toBe(reason);
      }
      expect(Number((await adminPool().query(`SELECT count(*)::int AS n FROM finance_freelancer_rates WHERE user_id = $1`, [G])).rows[0].n)).toBe(0);
    });

    it("person_not_found for a client contact, a member of another company and an unknown id; freelancer_on_payroll for E", async () => {
      const body = { hourlyRate: 90000, validFrom: "2026-03-01", expenseAccountCode: "6600" };
      for (const who of [X, Y, newId(), "not-a-uuid"]) {
        const r = await call("POST", `${A}/finance/freelancers/${who}/rates`, fm, body);
        expect(r.statusCode, who).toBe(404);
        expect(r.json().reason).toBe("person_not_found");
      }
      const e = await call("POST", `${A}/finance/freelancers/${E}/rates`, fm, body);
      expect(e.statusCode).toBe(409);
      expect(e.json().reason).toBe("freelancer_on_payroll");
    });

    it("ends, reopens and withdraws a rate; refuses a reopen that overlaps and an end before the start", async () => {
      const end = await call("PATCH", `${A}/finance/freelancers/${F}/rates/${r2}`, fm, { validTo: "2026-12-31" });
      expect(end.statusCode, end.body).toBe(200);
      expect(end.json().validTo).toBe("2026-12-31");
      const reopen = await call("PATCH", `${A}/finance/freelancers/${F}/rates/${r2}`, fm, { validTo: null });
      expect(reopen.statusCode).toBe(200);
      expect(reopen.json().validTo).toBeNull();
      const overlap = await call("PATCH", `${A}/finance/freelancers/${F}/rates/${r1}`, fm, { validTo: null });
      expect(overlap.statusCode).toBe(409);
      expect(overlap.json().reason).toBe("rate_overlap");
      const before = await call("PATCH", `${A}/finance/freelancers/${F}/rates/${r1}`, fm, { validTo: "2025-12-01" });
      expect(before.statusCode).toBe(400);
      expect(before.json().reason).toBe("date_invalid");
      expect((await call("PATCH", `${A}/finance/freelancers/${G}/rates/${r1}`, fm, { validTo: null })).json().reason).toBe("rate_not_found");

      // G: a rate, withdrawn (it priced nothing), then added again for the drafts below.
      const g = await call("POST", `${A}/finance/freelancers/${G}/rates`, fm, { hourlyRate: 90000, validFrom: "2026-03-01", expenseAccountCode: "6600" });
      expect(g.statusCode).toBe(201);
      const del = await call("DELETE", `${A}/finance/freelancers/${G}/rates/${g.json().id}`, fm);
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ deleted: true });
      expect((await call("POST", `${A}/finance/freelancers/${G}/rates`, fm, { hourlyRate: 90000, validFrom: "2026-03-01", expenseAccountCode: "6600" })).statusCode).toBe(201);
      // H's rate starts in April (an earlier day of H's is uncovered: NO_RATE below).
      expect((await call("POST", `${A}/finance/freelancers/${H}/rates`, fm, { hourlyRate: 80000, validFrom: "2026-04-01", expenseAccountCode: "6600" })).statusCode).toBe(201);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the vendor link (§61.7)", () => {
    it("POST vendors takes userId; a second live vendor for the person is person_has_vendor", async () => {
      const v = await call("POST", `${A}/finance/ap/vendors`, fm, { code: "FL-F", name: "Fajar (freelancer)", defaultWithholdingCode: "PPH21", userId: F });
      expect(v.statusCode, v.body).toBe(201);
      expect(v.json()).toMatchObject({ code: "FL-F", userId: F });
      vendorF = v.json().id;
      const dup = await call("POST", `${A}/finance/ap/vendors`, fm, { code: "FL-F2", name: "Fajar again", userId: F });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().reason).toBe("person_has_vendor");
      const client = await call("POST", `${A}/finance/ap/vendors`, fm, { code: "FL-X", name: "Client contact", userId: X });
      expect(client.statusCode).toBe(404);
      expect(client.json().reason).toBe("person_not_found");
    });

    it("PATCH …/person links, refuses, unlinks and relinks", async () => {
      const v = await call("POST", `${A}/finance/ap/vendors`, fm, { code: "FL-H", name: "Hana (freelancer)" });
      expect(v.statusCode).toBe(201);
      vendorH = v.json().id;
      const link = await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, ca, { userId: H });
      expect(link.statusCode, link.body).toBe(200);
      expect(link.json()).toEqual({ vendorId: vendorH, userId: H });
      expect((await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, fm, { userId: F })).json().reason).toBe("person_has_vendor");
      expect((await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, fm, { userId: X })).json().reason).toBe("person_not_found");
      const missing = await call("PATCH", `${A}/finance/ap/vendors/${newId()}/person`, fm, { userId: H });
      expect(missing.statusCode).toBe(404);
      expect(missing.json().reason).toBe("vendor_not_found");
      expect((await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, fm, {})).statusCode).toBe(400);
      const unlink = await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, fm, { userId: null });
      expect(unlink.json()).toEqual({ vendorId: vendorH, userId: null });
      expect((await call("PATCH", `${A}/finance/ap/vendors/${vendorH}/person`, fm, { userId: H })).statusCode).toBe(200);
      const verbs = await adminPool().query(`SELECT verb FROM activities WHERE target_entity_id = $1 ORDER BY occurred_at`, [vendorH]);
      expect(verbs.rows.map((x) => x.verb)).toEqual(["vendor_person_linked", "vendor_person_unlinked", "vendor_person_linked"]);
      const list = (await call("GET", `${A}/finance/ap/vendors`, fs)).json() as Array<{ id: string; userId: string | null }>;
      expect(list.find((x) => x.id === vendorH)?.userId).toBe(H);
    });

    it("GET finance/freelancers lists every person with a rate or a linked vendor", async () => {
      // K, W and R: vendors and rates written directly (the shapes the routes write), for the blockers and the race.
      await directVendorAndRate(K, "FL-K", { pkp: true });
      await directVendorAndRate(W, "FL-W", { wht: "PPH99" });
      await directVendorAndRate(R, "FL-R");
      const r = await call("GET", `${A}/finance/freelancers`, fs);
      expect(r.statusCode).toBe(200);
      const rows = r.json() as Json[];
      const f = rows.find((x) => x.user.id === F)!;
      expect(f.vendor).toEqual({ id: vendorF, code: "FL-F", name: "Fajar (freelancer)", withholdingCode: "PPH21" });
      expect(f.rates.map((x: Json) => x.id)).toEqual([r2, r1]);
      expect(f.currentRate?.id).toBe(r2);
      expect(f.onPayroll).toBe(false);
      expect(rows.find((x) => x.user.id === G)?.vendor).toBeNull();
      expect(rows.find((x) => x.user.id === E)).toBeUndefined(); // no rate, no vendor
      expect(rows.some((x) => x.user.id === FB)).toBe(false); // another company's person
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("preview and draft (§61.8)", () => {
    beforeAll(async () => {
      // F in March: P1 at r1 (50 + 70 min), P1 at r2 (45), P2 at r1 (25 + 25), P2 at r2 (10), P3 at r2 (7); and a February entry.
      for (const [d, p, m] of [
        ["2026-03-02", P1, 50], ["2026-03-03", P1, 70], ["2026-03-20", P1, 45], ["2026-03-10", P2, 25], ["2026-03-11", P2, 25],
        ["2026-03-17", P2, 10], ["2026-03-25", P3, 7],
      ] as Array<[string, string, number]>) {
        fEntries.push(await entry(F, d, p, m));
      }
      fFeb = await entry(F, "2026-02-10", P1, 30);
      await entry(G, "2026-03-05", P1, 60);
      await entry(H, "2026-03-28", P1, 60); // before H's rate
      await entry(E, "2026-03-05", P1, 60);
      await entry(K, "2026-03-05", P1, 60);
      await entry(W, "2026-03-05", P1, 60);
    });

    it("previews F: the rate in force per date, a line per (project, rate), the money rounded once per line, PPH21 withholding", async () => {
      const r = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-03-01&periodEnd=2026-03-31&userId=${F}`, fs);
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as Json;
      expect(body).toMatchObject({ periodStart: "2026-03-01", periodEnd: "2026-03-31" });
      expect(body.freelancers).toHaveLength(1);
      const f = body.freelancers[0];
      expect(f.lines.map((l: Json) => [l.project.name, l.minutes, l.hours, l.hourlyRate, l.amount])).toEqual([
        ["P1 Alpha", 120, 2, 100000, 200000],
        ["P1 Alpha", 45, 0.75, 150000, 112500],
        ["P2 Beta", 50, 0.8333, 100000, 83333], // NOT 41,667 × 2: the hours are never rounded, the money once per line
        ["P2 Beta", 10, 0.1667, 150000, 25000],
        ["P3 Gamma", 7, 0.1167, 150000, 17500],
      ]);
      expect(f.subtotal).toBe(438333);
      // finance_tax_compute: 438,333 × 0.5 × 5% = 10,958.325, rounded to IDR's 0 decimals.
      expect(f.withholding).toEqual({ code: "PPH21", amount: 10958 });
      expect(f.amountPayable).toBe(427375);
      expect(f).toMatchObject({ currency: "IDR", entryCount: 7, blockers: [], earlierUnbilled: { count: 1, minutes: 30, oldest: "2026-02-10" } });
      expect(f.warnings.map((w: Json) => w.code)).toEqual(["EARLIER_UNBILLED"]);
      expect(f.vendor).toEqual({ id: vendorF, code: "FL-F", name: "Fajar (freelancer)", withholdingCode: "PPH21" });
    });

    it("previews everyone with a rate or vendor and unbilled time, with their blockers and warnings", async () => {
      const r = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-03-01&periodEnd=2026-03-31`, fs);
      const people = (r.json() as Json).freelancers as Json[];
      const byId = (id: string) => people.find((p) => p.user.id === id);
      expect(byId(F)?.blockers).toEqual([]);
      expect(byId(G)?.blockers.map((b: Json) => b.code)).toEqual(["NO_VENDOR"]);
      expect(byId(H)?.blockers.map((b: Json) => b.code)).toEqual(["NO_RATE"]);
      expect(byId(H)?.blockers[0].detail).toEqual({ dates: ["2026-03-28"] });
      expect(byId(H)?.warnings.map((w: Json) => w.code)).toContain("NO_WITHHOLDING");
      expect(byId(E)).toBeUndefined(); // no rate and no vendor: not a freelancer
      const e = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-03-01&periodEnd=2026-03-31&userId=${E}`, fs);
      expect(e.json().freelancers[0].blockers.map((b: Json) => b.code)).toEqual(expect.arrayContaining(["NO_VENDOR", "NO_RATE", "ON_PAYROLL"]));
    });

    it("every blocker refuses the draft with 409 bill_blocked and writes nothing", async () => {
      const draft = (userId: string, extra: Json = {}) => call("POST", `${A}/finance/freelancer-bills`, fs, { userId, ...march, billDate: "2026-04-05", ...extra });
      const cases: Array<[string, Json, string]> = [
        [G, {}, "NO_VENDOR"],
        [H, {}, "NO_RATE"],
        [E, {}, "ON_PAYROLL"],
        [K, {}, "VENDOR_IS_PKP"],
        [W, {}, "WITHHOLDING_CODE_NOT_IN_FORCE"],
        [F, { billDate: "2025-12-15" }, "NO_OPEN_PERIOD"],
      ];
      for (const [who, extra, code] of cases) {
        const r = await draft(who, extra);
        expect(r.statusCode, `${code}: ${r.body}`).toBe(409);
        expect(r.json().reason).toBe("bill_blocked");
        expect(codes(r), code).toContain(code);
      }
      expect(await apBillCount()).toBe(0);
      for (const t of fEntries) expect(await billOf(t)).toBeNull();
    });

    it("refuses a malformed period or bill date (400) and an unknown person (404)", async () => {
      const bad = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, periodStart: "2026-03-31", periodEnd: "2026-03-01" });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().reason).toBe("period_invalid");
      const long = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-01-01&periodEnd=2027-01-02`, fs);
      expect(long.json().reason).toBe("period_invalid");
      const bd = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, ...march, billDate: "05/04/2026" });
      expect(bd.json().reason).toBe("bill_date_invalid");
      const nobody = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: newId(), ...march });
      expect(nobody.statusCode).toBe(404);
      expect(nobody.json().reason).toBe("person_not_found");
    });

    it("drafts F's bill: an AP draft numbered {prefix}/FB/{yyyy}/{nnnn}, the money exactly as previewed, every entry claimed", async () => {
      const r = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, ...march, billDate: "2026-04-05" });
      expect(r.statusCode, r.body).toBe(201);
      const b = r.json() as Json;
      expect(b).toMatchObject({
        billNo: "GDA/FB/2026/0001", status: "draft", subtotal: 438333, withholdingAmount: 10958, amountPayable: 427375,
        currency: "IDR", entryCount: 7,
      });
      expect(b.deduped).toBeUndefined();
      expect(b.warnings.map((w: Json) => w.code)).toEqual(["EARLIER_UNBILLED"]);
      billF1 = b.billId;
      const stored = (await adminPool().query(
        `SELECT ab.status, ab.vendor_id, to_char(ab.due_date, 'YYYY-MM-DD') AS due, ab.subtotal::text, ab.total::text, ab.tax_total::text,
                ab.withholding_code, ab.withholding_rate::text, ab.withholding_amount::text, ab.amount_payable::text, a.code AS wht_account, ab.notes
           FROM finance_ap_bills ab LEFT JOIN finance_accounts a ON a.id = ab.withholding_account_id WHERE ab.id = $1`, [billF1])).rows[0];
      expect(stored).toEqual({
        status: "draft", vendor_id: vendorF, due: "2026-05-05", subtotal: "438333.0000", total: "438333.0000", tax_total: "0.0000",
        withholding_code: "PPH21", withholding_rate: "0.025000", withholding_amount: "10958.0000", amount_payable: "427375.0000",
        wht_account: "2150", notes: "Freelancer hours 2026-03-01 to 2026-03-31",
      });
      const lines = await adminPool().query(
        `SELECT l.line_no, l.description, l.quantity::text, l.unit_price::text, l.line_subtotal::text, a.code
           FROM finance_ap_bill_lines l JOIN finance_accounts a ON a.id = l.expense_account_id WHERE l.bill_id = $1 ORDER BY l.line_no`, [billF1]);
      expect(lines.rows.map((l) => [l.quantity, l.unit_price, l.line_subtotal, l.code])).toEqual([
        ["2.0000", "100000.0000", "200000.0000", "6600"],
        ["0.7500", "150000.0000", "112500.0000", "6600"],
        ["0.8333", "100000.0000", "83333.0000", "6600"],
        ["0.1667", "150000.0000", "25000.0000", "6600"],
        ["0.1167", "150000.0000", "17500.0000", "6600"],
      ]);
      expect(lines.rows[2].description).toBe("P2 Beta · 0.8333 h × 100000 (2026-03-10 to 2026-03-11)");
      for (const t of fEntries) expect(await billOf(t)).toBe(billF1);
      expect(await billOf(fFeb)).toBeNull();
      const fb = (await adminPool().query(`SELECT user_id, vendor_id, minutes, created_by FROM finance_freelancer_bills WHERE bill_id = $1`, [billF1])).rows[0];
      expect(fb).toEqual({ user_id: F, vendor_id: vendorF, minutes: 232, created_by: fs });
      expect((await adminPool().query(`SELECT verb FROM activities WHERE target_entity_id = $1`, [billF1])).rows.map((x) => x.verb)).toEqual(["freelancer_bill_drafted"]);
    });

    it("a replay answers the same draft (deduped); a late entry is drafted by the next call; nothing_to_bill when nothing is left", async () => {
      const replay = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, ...march, billDate: "2026-04-05" });
      expect(replay.statusCode).toBe(201);
      expect(replay.json()).toMatchObject({ billId: billF1, billNo: "GDA/FB/2026/0001", deduped: true, entryCount: 7 });
      const late = await entry(F, "2026-03-30", P1, 15);
      const next = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, ...march, billDate: "2026-04-06" });
      expect(next.statusCode).toBe(201);
      expect(next.json()).toMatchObject({ billNo: "GDA/FB/2026/0002", entryCount: 1, subtotal: 37500 });
      expect(next.json().billId).not.toBe(billF1);
      expect(await billOf(late)).toBe(next.json().billId);
      const none = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: F, periodStart: "2026-06-01", periodEnd: "2026-06-30" });
      expect(none.statusCode).toBe(409);
      expect(none.json().reason).toBe("nothing_to_bill");
    });

    it("a rate that priced a billed hour is used: it cannot be withdrawn or ended before that hour", async () => {
      const del = await call("DELETE", `${A}/finance/freelancers/${F}/rates/${r1}`, fm);
      expect(del.statusCode).toBe(409);
      expect(del.json().reason).toBe("rate_used");
      const shorten = await call("PATCH", `${A}/finance/freelancers/${F}/rates/${r2}`, fm, { validTo: "2026-03-19" });
      expect(shorten.statusCode).toBe(409);
      expect(shorten.json().reason).toBe("rate_used");
      const early = await call("POST", `${A}/finance/freelancers/${F}/rates`, fm, { hourlyRate: 175000, validFrom: "2026-03-20", expenseAccountCode: "6600" });
      expect(early.statusCode).toBe(409);
      expect(early.json().reason).toBe("rate_used");
      const list = (await call("GET", `${A}/finance/freelancers`, fs)).json() as Json[];
      expect(list.find((x) => x.user.id === F)!.rates.map((x: Json) => x.used)).toEqual([true, true]);
    });

    it("a claimed entry's minutes cannot be edited (409 time_entry_billed, after authorization); notes still change", async () => {
      const t = fEntries[0];
      const denied = await call("PATCH", `${A}/time-entries/${t}`, mem, { minutes: 55 });
      expect(denied.statusCode).toBe(403);
      const r = await call("PATCH", `${A}/time-entries/${t}`, F, { minutes: 55 });
      expect(r.statusCode).toBe(409);
      expect(r.json().reason).toBe("time_entry_billed");
      const ok = await call("PATCH", `${A}/time-entries/${t}`, F, { notes: "reworded", billable: true });
      expect(ok.statusCode).toBe(200);
      const row = (await adminPool().query(`SELECT minutes, notes, billable FROM time_entries WHERE id = $1`, [t])).rows[0];
      expect(row).toEqual({ minutes: 50, notes: "reworded", billable: true });
      const direct = await withTenants([A], (c) => c.query(`UPDATE time_entries SET minutes = 1 WHERE id = $1`, [t])).catch((e) => e);
      expect(codeOf(direct)).toBe("PD615");
      // An unclaimed entry still edits as before.
      expect((await call("PATCH", `${A}/time-entries/${fFeb}`, F, { minutes: 35 })).statusCode).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("DW-D47: no withholding code, no withholding, and the warning everywhere", () => {
    let billH = "";
    let hApril: string[] = [];
    it("H in April: nothing withheld; NO_WITHHOLDING on the preview, the POST answer and the list row", async () => {
      hApril = [await entry(H, "2026-04-02", P1, 60), await entry(H, "2026-04-03", P2, 30)];
      const pre = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-04-01&periodEnd=2026-04-30&userId=${H}`, fs);
      const p = pre.json().freelancers[0];
      expect(p).toMatchObject({ subtotal: 120000, withholding: null, amountPayable: 120000, blockers: [] });
      expect(p.warnings.map((w: Json) => w.code)).toEqual(["NO_WITHHOLDING", "EARLIER_UNBILLED"]);
      const r = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: H, periodStart: "2026-04-01", periodEnd: "2026-04-30", billDate: "2026-04-30" });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json()).toMatchObject({ subtotal: 120000, withholdingAmount: 0, amountPayable: 120000 });
      expect(r.json().warnings.map((w: Json) => w.code)).toContain("NO_WITHHOLDING");
      billH = r.json().billId;
      const stored = (await adminPool().query(`SELECT withholding_code, withholding_amount::text, withholding_account_id FROM finance_ap_bills WHERE id = $1`, [billH])).rows[0];
      expect(stored).toEqual({ withholding_code: null, withholding_amount: "0.0000", withholding_account_id: null });
      const list = (await call("GET", `${A}/finance/freelancer-bills?status=draft`, fs)).json() as Json[];
      const row = list.find((x) => x.billId === billH)!;
      expect(row).toMatchObject({ user: { id: H }, vendor: { id: vendorH, code: "FL-H" }, periodStart: "2026-04-01", minutes: 90, status: "draft" });
      expect(row.warnings.map((w: Json) => w.code)).toEqual(["NO_WITHHOLDING"]);
      expect(list.find((x) => x.billId === billF1)!.warnings).toEqual([]);
      expect(row.createdBy).toEqual({ id: fs, name: "Fadil Staff" });
    });

    it("discarding the draft deletes the bill, its lines and its row, and frees the entries; the next draft bills them again", async () => {
      const d = await call("DELETE", `${A}/finance/freelancer-bills/${billH}`, fs);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toEqual({ billId: billH, discarded: true, releasedEntries: 2 });
      const left = (await adminPool().query(
        `SELECT (SELECT count(*)::int FROM finance_ap_bills WHERE id = $1) AS b, (SELECT count(*)::int FROM finance_ap_bill_lines WHERE bill_id = $1) AS l,
                (SELECT count(*)::int FROM finance_freelancer_bills WHERE bill_id = $1) AS f`, [billH])).rows[0];
      expect(left).toEqual({ b: 0, l: 0, f: 0 });
      for (const t of hApril) expect(await billOf(t)).toBeNull();
      expect((await adminPool().query(`SELECT verb FROM activities WHERE target_entity_id = $1 ORDER BY occurred_at`, [billH])).rows.map((x) => x.verb))
        .toEqual(["freelancer_bill_drafted", "freelancer_bill_discarded"]);
      const again = await call("POST", `${A}/finance/freelancer-bills`, fs, { userId: H, periodStart: "2026-04-01", periodEnd: "2026-04-30", billDate: "2026-04-30" });
      expect(again.statusCode).toBe(201);
      for (const t of hApril) expect(await billOf(t)).toBe(again.json().billId);
      expect((await call("DELETE", `${A}/finance/freelancer-bills/${billH}`, fs)).json().reason).toBe("freelancer_bill_not_found");
    });

    it("a manual AP bill is never discarded by this route (404)", async () => {
      const manual = await call("POST", `${A}/finance/ap/bills`, fs, {
        vendorId: vendorH, billNo: "MAN-1", billDate: "2026-04-10", dueDate: "2026-05-10",
        lines: [{ description: "Software licence", unitPrice: 1000, expenseAccountCode: "6600" }],
      });
      expect(manual.statusCode, manual.body).toBe(201);
      const d = await call("DELETE", `${A}/finance/freelancer-bills/${manual.json().id}`, fs);
      expect(d.statusCode).toBe(404);
      expect(d.json().reason).toBe("freelancer_bill_not_found");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("approval through the existing AP route", () => {
    it("posts the expense debit, the payable credit and the 2150 withholding credit; AP reconciles; an approved bill is not discarded", async () => {
      const a = await call("POST", `${A}/finance/ap/bills/${billF1}/approve`, fm);
      expect(a.statusCode, a.body).toBe(200);
      const j = await adminPool().query(
        `SELECT a.code, l.side, l.amount::text FROM finance_journal_lines l
           JOIN finance_accounts a ON a.id = l.account_id
          WHERE l.entry_id = (SELECT journal_entry_id FROM finance_ap_bills WHERE id = $1) ORDER BY l.side DESC, a.code`, [billF1]);
      expect(j.rows).toEqual([
        { code: "6600", side: "debit", amount: "438333.0000" },
        { code: "2110", side: "credit", amount: "427375.0000" },
        { code: "2150", side: "credit", amount: "10958.0000" },
      ]);
      const rec = await call("GET", `${A}/finance/ap/reconcile`, fm);
      expect(rec.statusCode).toBe(200);
      expect(rec.json().clean).toBe(true);
      const d = await call("DELETE", `${A}/finance/freelancer-bills/${billF1}`, fs);
      expect(d.statusCode).toBe(409);
      expect(d.json().reason).toBe("bill_not_draft");
      const direct = await fin((c) => c.query(`DELETE FROM finance_ap_bills WHERE id = $1`, [billF1])).catch((e) => e);
      expect(codeOf(direct)).toBe("PD617");
      for (const t of fEntries) expect(await billOf(t)).toBe(billF1);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("the claim race", () => {
    it("two concurrent drafts of one period: one bill, each entry billed once", async () => {
      const ids = [await entry(R, "2026-05-04", P1, 60), await entry(R, "2026-05-05", P2, 90), await entry(R, "2026-05-06", P3, 30)];
      const body = { userId: R, periodStart: "2026-05-01", periodEnd: "2026-05-31", billDate: "2026-06-01" };
      const [x, y] = await Promise.all([
        call("POST", `${A}/finance/freelancer-bills`, fs, body),
        call("POST", `${A}/finance/freelancer-bills`, fm, body),
      ]);
      const answers = [x, y].map((r) => ({ status: r.statusCode, body: r.json() as Json }));
      // The loser waited on the row locks and then found the entries claimed: it answers the winner's draft (deduped), or
      // refuses with 409; it never makes a second bill.
      for (const a of answers) expect([201, 409], JSON.stringify(a)).toContain(a.status);
      const made = answers.filter((a) => a.status === 201 && !a.body.deduped);
      expect(made).toHaveLength(1);
      const winner = made[0].body.billId as string;
      for (const a of answers.filter((q) => q.status === 201)) expect(a.body.billId).toBe(winner);
      const n = await adminPool().query(`SELECT count(*)::int AS n FROM finance_freelancer_bills WHERE user_id = $1`, [R]);
      expect(n.rows[0].n).toBe(1);
      for (const t of ids) expect(await billOf(t)).toBe(winner);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
  describe("RLS and tenancy (§61.12)", () => {
    beforeAll(async () => {
      await withTenants([B], (c) => c.query(
        `INSERT INTO finance_ap_vendors (tenant_id, code, name, user_id) VALUES ($1, 'FL-FB', 'Fikri (B)', $2)`, [B, FB]), { modules: ["finance"] });
      await withTenants([B], (c) => c.query(
        `INSERT INTO finance_freelancer_rates (tenant_id, user_id, hourly_rate, currency_code, expense_account_code, valid_from)
         VALUES ($1, $2, 50000, 'IDR', '6600', '2026-01-01')`, [B, FB]), { modules: ["finance"] });
      await entry(FB, "2026-03-05", PB, 60, B);
      const r = await call("POST", `${B}/finance/freelancer-bills`, bfs, { userId: FB, ...march, billDate: "2026-04-05" });
      expect(r.statusCode, r.body).toBe(201);
      expect(r.json().billNo).toBe("OTH/FB/2026/0001"); // B's own series and prefix
      billB = r.json().billId;
    });

    it("another company's freelancers, vendors and bills are invisible; its bill is not found from here", async () => {
      const people = (await call("GET", `${A}/finance/freelancers`, fs)).json() as Json[];
      expect(people.some((p) => p.user.id === FB)).toBe(false);
      const bills = (await call("GET", `${A}/finance/freelancer-bills`, fs)).json() as Json[];
      expect(bills.some((b) => b.billId === billB)).toBe(false);
      expect(bills.length).toBeGreaterThan(0);
      const del = await call("DELETE", `${A}/finance/freelancer-bills/${billB}`, fs);
      expect(del.statusCode).toBe(404);
      expect(await billOf((await adminPool().query(`SELECT id FROM time_entries WHERE user_id = $1`, [FB])).rows[0].id)).toBe(billB);
      // A's staff hold nothing in B; B's staff see only B.
      expect((await call("GET", `${B}/finance/freelancers`, fs)).statusCode).toBe(403);
      const bList = (await call("GET", `${B}/finance/freelancer-bills`, bfs)).json() as Json[];
      expect(bList.map((b) => b.billId)).toEqual([billB]);
      // A person of A is not a person of B: no rate, no bill for them there.
      const cross = await call("POST", `${B}/finance/freelancer-bills`, bfs, { userId: F, ...march });
      expect(cross.statusCode).toBe(404);
    });

    it("the finance scope is what makes the rows readable: without it they read zero, and the routes always set it", async () => {
      const count = `SELECT (SELECT count(*)::int FROM finance_freelancer_rates) AS r, (SELECT count(*)::int FROM finance_freelancer_bills) AS b`;
      expect((await withTenants([A], (c) => c.query(count))).rows[0]).toEqual({ r: 0, b: 0 });
      const scoped = (await fin((c) => c.query(count))).rows[0];
      expect(scoped.r).toBeGreaterThan(0);
      expect(scoped.b).toBeGreaterThan(0);
      // The route answers with real rows, never an empty "nothing to bill" for want of the scope.
      const pre = await call("GET", `${A}/finance/freelancer-bills/preview?periodStart=2026-02-01&periodEnd=2026-02-28&userId=${F}`, fs);
      expect(pre.json().freelancers[0]).toMatchObject({ entryCount: 1, blockers: [] });
      expect(pre.json().freelancers[0].lines[0]).toMatchObject({ minutes: 35, hourlyRate: 100000 });
    });
  });
});
