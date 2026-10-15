// DW-7g-2 (BFF §49) — chart of accounts: add, rename, archive and restore. This drives the four write routes over the REAL
// HTTP surface (Postgres + RLS + Cerbos; the Linux gate; skips without DATABASE_URL_TEST, and a skipped run proves nothing).
//
// TEETH (prove each by breaking the code in a throwaway commit):
//   (a) drop `authorize` from a handler        -> the finance_staff 403 tests fail (and a bad body would answer 400, not 403);
//   (b) drop the balance check from archive    -> "refused for a balance" fails (1120 holds 250,000,000);
//   (c) drop the referrer query                -> "refused for a posting rule" / "for a tax code" fail;
//   (d) forget `{ modules: ["finance"] }`      -> every test fails with 404 (the account reads as absent, silent-empty);
//   (e) re-code through a raw UPDATE            -> "account_frozen" fails only if the trigger is bypassed, so the trigger is the proof.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface Acct {
  code: string; name: string; accountType: string; normalBalance: string; isPostable: boolean; isControl: boolean;
  allowManualPosting: boolean; status: string; hasPostings: boolean;
  description: string | null; parentCode: string | null; currencyCode: string | null;
}

describe.skipIf(!TEST_URL)("DW-7g-2 — chart of accounts: add, rename, archive, restore", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let other: string;        // a second company, with its own manager
  let controller: string;   // finance_manager of `tenant`
  let otherManager: string; // finance_manager of `other`
  let clerk: string;        // finance_staff of `tenant`: reads, never writes
  let seq = 0;

  const url = (t: string, rest = "") => `/api/${t}/finance/accounts${rest}`;
  const send = (method: "GET" | "POST" | "PATCH", t: string, rest: string, who: string, payload?: unknown) =>
    app.inject({ method, url: url(t, rest), headers: asUser(who), payload: payload as object | undefined });
  const add = (body: Record<string, unknown>, who = controller, t = tenant) => send("POST", t, "", who, body);
  const patch = (code: string, body: Record<string, unknown>, who = controller, t = tenant) => send("PATCH", t, `/${code}`, who, body);
  const archive = (code: string, who = controller, t = tenant) => send("POST", t, `/${code}/archive`, who);
  const restore = (code: string, who = controller, t = tenant) => send("POST", t, `/${code}/restore`, who);
  const list = async (t = tenant, who = controller) => (await send("GET", t, "", who)).json() as Acct[];
  const find = async (code: string, t = tenant, who = controller) => (await list(t, who)).find((a) => a.code === code);

  const inFinance = <T,>(fn: (c: import("pg").PoolClient) => Promise<T>, t = tenant) => withTenants([t], fn, { modules: ["finance"] });
  const post = (date: string, lines: Array<{ account_code: string; side: "debit" | "credit"; amount: number }>) =>
    inFinance((c) =>
      c.query(`SELECT finance_post_journal($1,$2::date,$3,'DW-7g-2 test',$4::jsonb)`, [tenant, date, `dw7g2-${++seq}`, JSON.stringify(lines)]));
  const row = (code: string, t = tenant) =>
    inFinance(async (c) => (await c.query(
      `SELECT id, parent_id, normal_balance, is_control, allow_manual_posting, is_postable, currency_code, status, description, first_posted_at
         FROM finance_accounts WHERE tenant_id = $1 AND code = $2 AND deleted_at IS NULL`, [t, code])).rows[0], t);
  const activities = (t = tenant) =>
    withTenants([t], async (c) => (await c.query<{ verb: string; metadata: Record<string, unknown> }>(
      `SELECT verb, metadata FROM activities WHERE tenant_id = $1 AND target_entity_type = 'finance_account' ORDER BY occurred_at, id`, [t])).rows);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("DW7g2 Co", ["finance"]);
    other = await createCompany("DW7g2 Other Co", ["finance"]);
    controller = await createUser("controller@dw7g2.test");
    otherManager = await createUser("other-manager@dw7g2.test");
    clerk = await createUser("clerk@dw7g2.test");
    await addMembership(tenant, controller); await addMembership(tenant, clerk); await addMembership(other, otherManager);
    await grantRole(controller, await createRole("finance_manager"), "company", tenant);
    await grantRole(clerk, await createRole("finance_staff"), "company", tenant);
    await grantRole(otherManager, await createRole("finance_manager"), "company", other);
    for (const t of [tenant, other]) {
      await inFinance(async (c) => {
        await c.query(`INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1,'IDR','IDR')`, [t]);
        await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [t]);
        const fy = newId();
        await c.query(`INSERT INTO finance_fiscal_years (id, tenant_id, code, start_date, end_date) VALUES ($1,$2,'FY2026','2026-01-01','2027-01-01')`, [fy, t]);
        await c.query("SELECT finance_generate_periods($1,'monthly')", [fy]);
      }, t);
    }
    // 1120 Bank holds money: the balance refusal needs a real one.
    await post("2026-03-05", [
      { account_code: "1120", side: "debit", amount: 250_000_000 },
      { account_code: "3100", side: "credit", amount: 250_000_000 },
    ]);
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("add (§49.2)", () => {
    it("adds a header and a postable child under it; the normal balance defaults by type; control stays off", async () => {
      const h = await add({ code: "4900", name: "  Other revenue (header)  ", accountType: "revenue", isPostable: false, description: "roll-up" });
      expect(h.statusCode, h.body).toBe(201);
      expect(h.json()).toEqual({ code: "4900" });
      const c = await add({ code: "4910", name: "Interest income", accountType: "revenue", parentCode: "4900" });
      expect(c.statusCode, c.body).toBe(201);

      const hr = await row("4900");
      expect(hr).toMatchObject({ is_postable: false, normal_balance: "credit", is_control: false, allow_manual_posting: true, status: "active", description: "roll-up" });
      const cr = await row("4910");
      expect(cr).toMatchObject({ is_postable: true, normal_balance: "credit", is_control: false, allow_manual_posting: true });
      expect(cr.parent_id).toBe(hr.id);

      const listed = await find("4900");
      expect(listed).toMatchObject({ name: "Other revenue (header)", isPostable: false, hasPostings: false, status: "active", description: "roll-up", parentCode: null });
      // the GET carries the parent's CODE, so the screen can offer headers as parents without a second read
      expect((await list()).find((a) => a.code === "4910")).toMatchObject({ parentCode: "4900", description: null });
      // asset and expense default to debit
      expect((await add({ code: "T-DEF-A", name: "x", accountType: "asset" })).statusCode).toBe(201);
      expect((await row("T-DEF-A")).normal_balance).toBe("debit");
    });

    it("a duplicate live code is 409 code_taken", async () => {
      const r = await add({ code: "4910", name: "Again", accountType: "revenue" });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "code_taken" });
      expect(r.json().error).toMatch(/4910/);
    });

    it("a parent of another type, a postable parent, an unknown parent and an archived parent are each 400 on parentCode", async () => {
      for (const [body, why] of [
        [{ code: "4920", name: "x", accountType: "expense", parentCode: "4900" }, /revenue/],
        [{ code: "4921", name: "x", accountType: "revenue", parentCode: "4910" }, /postable/],
        [{ code: "4922", name: "x", accountType: "revenue", parentCode: "NOPE" }, /not a live account/],
      ] as const) {
        const r = await add(body);
        expect(r.statusCode, r.body).toBe(400);
        expect(r.json()).toMatchObject({ field: "parentCode" });
        expect(r.json().error).toMatch(why);
      }
      expect(await row("4920")).toBeUndefined();
    });

    it("a contra account takes an explicit normal balance", async () => {
      const r = await add({ code: "4930", name: "Sales returns (contra)", accountType: "revenue", normalBalance: "debit" });
      expect(r.statusCode, r.body).toBe(201);
      expect((await row("4930")).normal_balance).toBe("debit");
      expect((await find("4930"))?.normalBalance).toBe("debit");
    });

    it("rejects malformed fields with a 400 that names the field", async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ code: "", name: "x", accountType: "asset" }, "code"],
        [{ code: "has space", name: "x", accountType: "asset" }, "code"],
        [{ code: "X".repeat(21), name: "x", accountType: "asset" }, "code"],
        [{ code: "V1", name: "   ", accountType: "asset" }, "name"],
        [{ code: "V2", name: "n".repeat(121), accountType: "asset" }, "name"],
        [{ code: "V3", name: "x", accountType: "income" }, "accountType"],
        [{ code: "V4", name: "x", accountType: "asset", normalBalance: "left" }, "normalBalance"],
        [{ code: "V5", name: "x", accountType: "asset", description: "d".repeat(501) }, "description"],
        [{ code: "V6", name: "x", accountType: "asset", isPostable: "yes" }, "isPostable"],
        [{ code: "V7", name: "x", accountType: "asset", currencyCode: "RUPIAH" }, "currencyCode"],
      ];
      for (const [body, field] of cases) {
        const r = await add(body);
        expect(r.statusCode, `${JSON.stringify(body)} -> ${r.body}`).toBe(400);
        expect(r.json()).toMatchObject({ field });
      }
      expect((await list()).some((a) => /^V\d$/.test(a.code))).toBe(false);
    });

    it("currencyCode must be one the company uses: its own currency, or one it has a rate for", async () => {
      const r = await add({ code: "C-USD", name: "USD bank", accountType: "asset", currencyCode: "USD" });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ field: "currencyCode" });
      expect((await add({ code: "C-IDR", name: "IDR cash", accountType: "asset", currencyCode: "idr" })).statusCode).toBe(201);
      expect((await row("C-IDR")).currency_code).toBe("IDR");
      await inFinance((c) => c.query(
        `INSERT INTO finance_exchange_rates (tenant_id, from_currency, to_currency, rate_date, basis, rate) VALUES ($1,'USD','IDR','2026-03-01','spot',16000)`, [tenant]));
      expect((await add({ code: "C-USD", name: "USD bank", accountType: "asset", currencyCode: "USD" })).statusCode).toBe(201);
      expect((await row("C-USD")).currency_code).toBe("USD");
    });

    it("every write leaves an activity row on finance_account with the code", async () => {
      const rows = await activities();
      expect(rows.some((a) => a.verb === "created" && a.metadata.code === "4900")).toBe(true);
      expect(rows.some((a) => a.verb === "created" && a.metadata.code === "4910")).toBe(true);
    });
  });

  describe("rename and edit (§49.3)", () => {
    it("renames and re-describes; the code changes freely before a posting", async () => {
      expect((await add({ code: "T100", name: "Test expense", accountType: "expense" })).statusCode).toBe(201);
      const r1 = await patch("T100", { name: "  Renamed expense  ", description: "now described" });
      expect(r1.statusCode, r1.body).toBe(200);
      expect(r1.json()).toEqual({ code: "T100" });
      expect(await find("T100")).toMatchObject({ name: "Renamed expense" });
      expect((await row("T100")).description).toBe("now described");

      const r2 = await patch("T100", { newCode: "T101" });
      expect(r2.statusCode, r2.body).toBe(200);
      expect(r2.json()).toEqual({ code: "T101" });
      expect(await find("T100")).toBeUndefined();
      expect(await find("T101")).toMatchObject({ name: "Renamed expense", hasPostings: false });
      expect((await patch("T100", { name: "gone" })).statusCode).toBe(404);

      const rows = await activities();
      expect(rows.some((a) => a.verb === "updated" && a.metadata.code === "T101")).toBe(true);
    });

    it("★ after a posting the code is frozen: 409 account_frozen with the trigger's hint; the name still changes", async () => {
      await post("2026-03-06", [
        { account_code: "T101", side: "debit", amount: 1_000 },
        { account_code: "1120", side: "credit", amount: 1_000 },
      ]);
      expect(await find("T101")).toMatchObject({ hasPostings: true });
      const r = await patch("T101", { newCode: "T102" });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_frozen" });
      expect(r.json().hint).toMatch(/Archive this account and create a new one/);
      expect(r.json().error).toMatch(/has postings/);
      expect(await find("T101")).toBeDefined();
      expect(await find("T102")).toBeUndefined();

      const ok = await patch("T101", { name: "Still renamable" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await find("T101")).toMatchObject({ name: "Still renamable" });
    });

    it("a code another live account holds is 409 code_taken", async () => {
      const r = await patch("T101", { newCode: "4910" });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "code_taken" });
    });

    it("type, normal balance and the control flags are not editable here; an empty edit is refused", async () => {
      for (const k of ["accountType", "normalBalance", "isControl", "allowManualPosting", "status"]) {
        const r = await patch("T101", { [k]: k === "accountType" ? "asset" : k === "normalBalance" ? "credit" : true });
        expect(r.statusCode, `${k}: ${r.body}`).toBe(400);
        expect(r.json()).toMatchObject({ field: k });
      }
      expect((await patch("T101", {})).statusCode).toBe(400);
      expect((await patch("T101", { surprise: 1 })).statusCode).toBe(400);
      expect(await find("T101")).toMatchObject({ accountType: "expense", normalBalance: "debit", isControl: false });
    });

    it("re-parents under a same-type header; refuses a postable parent, another type, itself and a loop", async () => {
      expect((await add({ code: "H-A", name: "Header A", accountType: "asset", isPostable: false })).statusCode).toBe(201);
      expect((await add({ code: "H-B", name: "Header B", accountType: "asset", isPostable: false, parentCode: "H-A" })).statusCode).toBe(201);
      expect((await add({ code: "H-C", name: "Header C", accountType: "asset", isPostable: false, parentCode: "H-B" })).statusCode).toBe(201);
      const self = await patch("H-A", { parentCode: "H-A" });
      expect(self.statusCode, self.body).toBe(400);
      const loop = await patch("H-A", { parentCode: "H-C" });
      expect(loop.statusCode, loop.body).toBe(400);
      expect(loop.json()).toMatchObject({ field: "parentCode" });
      expect(loop.json().error).toMatch(/loop/);
      expect((await row("H-A")).parent_id).toBeNull();
      expect((await patch("H-A", { parentCode: "4900" })).statusCode).toBe(400); // revenue header
      expect((await patch("H-A", { parentCode: "1110" })).statusCode).toBe(400); // a postable asset

      const ok = await patch("H-C", { parentCode: "H-A" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await row("H-C")).parent_id).toBe((await row("H-A")).id);
      expect((await patch("H-C", { parentCode: null })).statusCode).toBe(200);
      expect((await row("H-C")).parent_id).toBeNull();
    });
  });

  describe("archive refusals (§49.4)", () => {
    it("★ refused for a balance: 1120 Bank holds money", async () => {
      const r = await archive("1120");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_has_balance" });
      expect(r.json().error).toMatch(/250000000 debit/);
      expect((await find("1120"))?.status).toBe("active");
    });

    it("refused for an active child account", async () => {
      const r = await archive("4900");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_has_children" });
      expect((await find("4900"))?.status).toBe("active");
    });

    it("refused for a control account (1130 Piutang Usaha, balance zero)", async () => {
      const r = await archive("1130");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_is_control" });
    });

    it("★ refused while an ACTIVE posting rule names it, with usedBy; allowed once the rule is retired", async () => {
      expect((await add({ code: "R100", name: "Rule target", accountType: "expense" })).statusCode).toBe(201);
      const ruleId = newId();
      await inFinance(async (c) => {
        await c.query(
          `INSERT INTO finance_posting_rules (id, tenant_id, event_type, name, status, activated_at) VALUES ($1,$2,'dw7g.test.rule','DW-7g-2 rule','active', now())`, [ruleId, tenant]);
        await c.query(
          `INSERT INTO finance_posting_rule_lines (tenant_id, rule_id, line_no, account_code, side, amount_path) VALUES ($1,$2,1,'R100','debit','amount')`, [tenant, ruleId]);
        await c.query(
          `INSERT INTO finance_posting_rule_lines (tenant_id, rule_id, line_no, account_code, side, amount_path) VALUES ($1,$2,2,'1120','credit','amount')`, [tenant, ruleId]);
      });
      const r = await archive("R100");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_in_use", usedBy: [{ table: "finance_posting_rules", count: 1 }] });
      expect((await find("R100"))?.status).toBe("active");

      await inFinance((c) => c.query(`UPDATE finance_posting_rules SET status = 'retired', activated_at = NULL WHERE id = $1`, [ruleId]));
      const ok = await archive("R100");
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("refused while a tax code in force posts to it; allowed once the code has ended", async () => {
      expect((await add({ code: "TX100", name: "Tax liability", accountType: "liability" })).statusCode).toBe(201);
      const acct = await row("TX100");
      await inFinance((c) => c.query(
        `INSERT INTO finance_tax_codes (tenant_id, code, name, kind, rate, base_multiplier, account_id, effective_from)
         VALUES ($1,'DW7G','DW-7g-2 tax','ppn_output',11,1,$2,'2025-01-01')`, [tenant, acct.id]));
      const r = await archive("TX100");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "account_in_use", usedBy: [{ table: "finance_tax_codes", count: 1 }] });
      await inFinance((c) => c.query(`UPDATE finance_tax_codes SET effective_to = '2025-12-31' WHERE tenant_id = $1 AND code = 'DW7G'`, [tenant]));
      expect((await archive("TX100")).statusCode).toBe(200);
    });

    it("an unknown code is 404; archiving twice is 409 already_archived", async () => {
      expect((await archive("NOPE-1")).statusCode).toBe(404);
      const again = await archive("R100");
      expect(again.statusCode, again.body).toBe(409);
      expect(again.json()).toMatchObject({ reason: "already_archived" });
    });
  });

  describe("archive allowed, and what it does to postings (§49.4)", () => {
    it("★ an unused zero-balance account archives; a journal to it is then refused by finance_post_journal", async () => {
      expect((await add({ code: "U100", name: "Unused", accountType: "expense" })).statusCode).toBe(201);
      const r = await archive("U100");
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ code: "U100", status: "archived" });
      expect(await find("U100")).toMatchObject({ status: "archived" });
      await expect(post("2026-03-07", [
        { account_code: "U100", side: "debit", amount: 5 },
        { account_code: "1120", side: "credit", amount: 5 },
      ])).rejects.toThrow(/FINANCE_ACCOUNT_ARCHIVED/);
      expect(await find("1120")).toMatchObject({ status: "active" });
      expect((await activities()).some((a) => a.verb === "archived" && a.metadata.code === "U100")).toBe(true);
    });

    it("an account with postings that net to zero archives: its history stays", async () => {
      expect((await add({ code: "N100", name: "Nets to zero", accountType: "expense" })).statusCode).toBe(201);
      await post("2026-03-08", [{ account_code: "N100", side: "debit", amount: 700 }, { account_code: "1120", side: "credit", amount: 700 }]);
      expect((await archive("N100")).json()).toMatchObject({ reason: "account_has_balance" });
      await post("2026-03-09", [{ account_code: "1120", side: "debit", amount: 700 }, { account_code: "N100", side: "credit", amount: 700 }]);
      const r = await archive("N100");
      expect(r.statusCode, r.body).toBe(200);
      expect(await find("N100")).toMatchObject({ status: "archived", hasPostings: true });
    });
  });

  describe("restore (§49.4)", () => {
    it("★ refused under an archived parent (parent_archived); an archived child does not block archiving its parent", async () => {
      expect((await add({ code: "PH", name: "Parent header", accountType: "expense", isPostable: false })).statusCode).toBe(201);
      expect((await add({ code: "PC", name: "Child", accountType: "expense", parentCode: "PH" })).statusCode).toBe(201);
      expect((await archive("PH")).json()).toMatchObject({ reason: "account_has_children" });
      expect((await archive("PC")).statusCode).toBe(200);
      expect((await archive("PH")).statusCode).toBe(200);

      const refused = await restore("PC");
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ reason: "parent_archived" });
      expect((await find("PC"))?.status).toBe("archived");
      // and a new child cannot be put under an archived header
      const under = await add({ code: "PC2", name: "x", accountType: "expense", parentCode: "PH" });
      expect(under.statusCode, under.body).toBe(400);
      expect(under.json()).toMatchObject({ field: "parentCode" });

      const ph = await restore("PH");
      expect(ph.statusCode, ph.body).toBe(200);
      expect(ph.json()).toEqual({ code: "PH", status: "active" });
      expect((await restore("PC")).json()).toEqual({ code: "PC", status: "active" });
      expect(await find("PC")).toMatchObject({ status: "active" });
      expect((await activities()).some((a) => a.verb === "restored" && a.metadata.code === "PC")).toBe(true);
    });

    it("restoring an active account is 409 not_archived; an archived account keeps its code (restore never collides)", async () => {
      const r = await restore("PC");
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "not_archived" });
      const dup = await add({ code: "U100", name: "Takes the archived code?", accountType: "expense" });
      expect(dup.statusCode, dup.body).toBe(409);
      expect((await restore("U100")).statusCode).toBe(200);
    });
  });

  describe("authorization", () => {
    it("★ finance_staff may read the chart and is refused every write (403), even with a body that would be a 400", async () => {
      const before = (await list()).length;
      expect((await list(tenant, clerk)).length).toBe(before);
      expect((await add({ code: "CLK1", name: "x", accountType: "asset" }, clerk)).statusCode).toBe(403);
      expect((await add({}, clerk)).statusCode).toBe(403); // not 400: a refused caller learns nothing about the shape
      expect((await patch("PC", { name: "hijack" }, clerk)).statusCode).toBe(403);
      expect((await patch("PC", {}, clerk)).statusCode).toBe(403);
      expect((await archive("PC", clerk)).statusCode).toBe(403);
      expect((await restore("U100", clerk)).statusCode).toBe(403);
      expect(await row("CLK1")).toBeUndefined();
      expect(await find("PC")).toMatchObject({ name: "Child", status: "active" });
      expect((await list()).length).toBe(before);
    });

    it("a manager of another company is refused (403) here", async () => {
      expect((await add({ code: "OTH1", name: "x", accountType: "asset" }, otherManager)).statusCode).toBe(403);
      expect((await archive("PC", otherManager)).statusCode).toBe(403);
      expect((await send("GET", tenant, "", otherManager)).statusCode).toBe(403);
    });
  });

  describe("tenant isolation", () => {
    it("the same code lives in two companies; changing one leaves the other untouched", async () => {
      expect((await add({ code: "ISO1", name: "Tenant copy", accountType: "expense" })).statusCode).toBe(201);
      expect((await add({ code: "ISO1", name: "Other copy", accountType: "expense" }, otherManager, other)).statusCode).toBe(201);
      expect((await archive("ISO1", otherManager, other)).statusCode).toBe(200);
      expect((await patch("ISO1", { name: "Other renamed" }, otherManager, other)).statusCode).toBe(200);
      expect(await find("ISO1", tenant)).toMatchObject({ name: "Tenant copy", status: "active" });
      expect(await find("ISO1", other, otherManager)).toMatchObject({ name: "Other renamed", status: "archived" });
      // a code that exists only in `tenant` is absent for the other company's manager
      expect((await patch("PC", { name: "x" }, otherManager, other)).statusCode).toBe(404);
      expect((await archive("T101", otherManager, other)).statusCode).toBe(404);
      // and 1120's 250,000,000 is `tenant`'s: the other company's 1120 archives (it holds nothing).
      expect((await archive("1120", otherManager, other)).statusCode).toBe(200);
      expect(await find("1120", tenant)).toMatchObject({ status: "active" });
    });
  });
});
