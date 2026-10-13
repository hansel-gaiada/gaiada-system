// PV5-F2 — tax-code setup. Since PV5-04 a taxed invoice or a taxed manual entry must name a `finance_tax_codes` code, and
// no company had a way to create one. This drives the setup API over the REAL HTTP surface (Postgres + RLS + Cerbos; the
// Linux gate; skips without DATABASE_URL_TEST, and a skipped run proves nothing).
//
// TEETH (proven in the PV5-F2 hand-back by breaking the code in a throwaway commit):
//   (a) drop the overlap/existence guard from POST .../tax/codes/standard-ppn -> "running it twice creates nothing" fails
//       (the second run inserts a second PPN row from 2025-01-01 or violates the unique index);
//   (b) let PATCH change a rate -> "an in-use code cannot be edited" fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface CodeRow {
  id: string; code: string; name: string; kind: string; rate: number; baseMultiplier: number;
  effectiveFrom: string; effectiveTo: string | null; accountCode: string | null; inUse: boolean;
}

describe.skipIf(!TEST_URL)("PV5-F2 — tax codes: setup screen API and the standard PPN codes", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let other: string;      // a second company the controller holds no role in
  let controller: string; // finance_manager: may configure tax codes
  let clerk: string;      // finance_staff: may read, may not configure
  let outsider: string;   // plain member: nothing

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: string, payload?: unknown) =>
    app.inject({ method, url: `/api/${tenant}/finance/tax/codes${url}`, headers: asUser(who), payload: payload as object | undefined });
  const list = async (who = controller) => (await call("GET", "", who)).json() as CodeRow[];
  const compute = (base: number, code: string, on: string) =>
    withTenants([tenant], async (c) => {
      const r = await c.query<{ t: string | null }>(`SELECT finance_tax_compute($1, $2, $3::numeric, $4::date)::text AS t`, [tenant, code, String(base), on]);
      return r.rows[0].t === null ? null : Number(r.rows[0].t);
    }, { modules: ["finance"] });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("PV5-F2 Tax Co", ["finance"]);
    other = await createCompany("PV5-F2 Other Co", ["finance"]);
    controller = await createUser("controller@pv5f2-tax.test");
    clerk = await createUser("clerk@pv5f2-tax.test");
    outsider = await createUser("outsider@pv5f2-tax.test");
    for (const u of [controller, clerk, outsider]) await addMembership(tenant, u);
    await grantRole(controller, await createRole("finance_manager"), "company", tenant);
    await grantRole(clerk, await createRole("finance_staff"), "company", tenant);
    await grantRole(outsider, await createRole("member"), "company", tenant);
    await withTenants([tenant], async (c) => {
      await c.query(
        `INSERT INTO finance_company_settings (tenant_id, functional_currency, presentation_currency) VALUES ($1,'IDR','IDR')`, [tenant]);
      await c.query("SELECT finance_instantiate_coa($1,'id_psak_general_v1')", [tenant]);
    }, { modules: ["finance"] });
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("the standard PPN codes", () => {
    it("a company with no codes lists none", async () => {
      const r = await call("GET", "", controller);
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual([]);
    });

    it("creates the two statutory rows; running it twice creates nothing", async () => {
      const first = await call("POST", "/standard-ppn", controller);
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toEqual({ created: ["PPN from 2022-04-01", "PPN from 2025-01-01"], skipped: [] });

      const rows = await list();
      expect(rows.map((r) => `${r.code}|${r.kind}|${r.rate}|${r.baseMultiplier}|${r.effectiveFrom}|${r.effectiveTo}`).sort()).toEqual([
        "PPN|ppn_output|11|1|2022-04-01|2024-12-31",
        "PPN|ppn_output|12|0.9166666667|2025-01-01|null",
      ]);
      // Linked to the chart's output VAT account when the company has one.
      expect(rows.every((r) => r.accountCode === "2140")).toBe(true);

      const second = await call("POST", "/standard-ppn", controller);
      expect(second.statusCode, second.body).toBe(200);
      expect(second.json()).toEqual({ created: [], skipped: ["PPN from 2022-04-01", "PPN from 2025-01-01"] });
      expect(await list()).toHaveLength(2);
    });

    it("finance_tax_compute: 11% of the FULL base for a 2024 date, 12% x 11/12 for a 2025 date", async () => {
      // 12,000,000: 11% = 1,320,000; 12% on 11/12 of the base is the same effective 11%.
      expect(Math.round((await compute(12_000_000, "PPN", "2024-06-01")) as number)).toBe(1_320_000);
      expect(Math.round((await compute(12_000_000, "PPN", "2025-06-01")) as number)).toBe(1_320_000);
      // The two regimes differ in what they SAY: a 2025 supply is not taxed 12% of the full base (1,440,000).
      expect(await compute(12_000_000, "PPN", "2025-06-01")).not.toBe(1_440_000);
      // The boundary days.
      expect(Math.round((await compute(1_000_000, "PPN", "2024-12-31")) as number)).toBe(110_000);
      expect(Math.round((await compute(1_000_000, "PPN", "2025-01-01")) as number)).toBe(110_000);
      // Before the first row there is no rate in force: refused downstream, never a wrong rate.
      expect(await compute(1_000_000, "PPN", "2022-03-31")).toBeNull();
    });

    it("a company the caller holds no role in is refused (403)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${other}/finance/tax/codes`, headers: asUser(controller) });
      expect(r.statusCode).toBe(403); // the controller holds no role in the other company
    });
  });

  describe("a rate is never edited in place", () => {
    let current: CodeRow; // the open-ended 2025 row

    beforeAll(async () => {
      current = (await list()).find((r) => r.effectiveFrom === "2025-01-01") as CodeRow;
      // A draft invoice naming the code: the code is now IN USE.
      await withTenants([tenant], (c) =>
        c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                                 created_by, updated_by, tax_code)
           VALUES ($1, $2, NULL, current_date - 30, current_date, 'draft', 'IDR', '[]'::jsonb, 0, 'test', $3, $3, 'PPN')`,
          [newId(), tenant, controller],
        ));
    });

    it("the list says a code is in use", async () => {
      expect((await list()).every((r) => r.inUse === true)).toBe(true);
    });

    it("★ an in-use code cannot be edited: PATCH of the rate is 409, the row is unchanged, and a name edit is the only change allowed", async () => {
      const r = await call("PATCH", `/${current.id}`, controller, { rate: 5 });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "tax_code_immutable" });
      for (const body of [{ baseMultiplier: 1 }, { effectiveFrom: "2025-02-01" }, { kind: "exempt" }, { code: "X" }]) {
        expect((await call("PATCH", `/${current.id}`, controller, body)).statusCode).toBe(409);
      }
      const after = (await list()).find((x) => x.id === current.id) as CodeRow;
      expect(after).toMatchObject({ rate: 12, baseMultiplier: 0.9166666667, effectiveFrom: "2025-01-01", kind: "ppn_output" });
      expect((await call("PATCH", `/${current.id}`, controller, { name: "PPN 12% (renamed)" })).statusCode).toBe(200);
    });

    it("an in-use code cannot be removed (409); it is end-dated instead", async () => {
      const del = await call("DELETE", `/${current.id}`, controller);
      expect(del.statusCode, del.body).toBe(409);
      expect(del.json()).toMatchObject({ reason: "tax_code_in_use" });
      expect(await list()).toHaveLength(2);
    });

    it("end-dating works, can only shorten, and a rate change is a new row that may not overlap", async () => {
      // An overlapping new row is refused while the old one is open-ended.
      const overlap = await call("POST", "", controller, {
        code: "PPN", name: "PPN 13%", kind: "ppn_output", rate: 13, baseMultiplier: 1, effectiveFrom: "2026-01-01" });
      expect(overlap.statusCode, overlap.body).toBe(409);
      expect(overlap.json()).toMatchObject({ reason: "tax_code_overlaps" });

      const end = await call("POST", `/${current.id}/end`, controller, { effectiveTo: "2025-12-31" });
      expect(end.statusCode, end.body).toBe(200);
      expect(end.json()).toMatchObject({ code: "PPN", effectiveTo: "2025-12-31" });
      // Pushing the end back is refused: it would re-rate days already closed out.
      const extend = await call("POST", `/${current.id}/end`, controller, { effectiveTo: "2026-06-30" });
      expect(extend.statusCode).toBe(409);
      expect(extend.json()).toMatchObject({ reason: "tax_code_cannot_extend" });
      // Before its own start is a 400.
      expect((await call("POST", `/${current.id}/end`, controller, { effectiveTo: "2024-01-01" })).statusCode).toBe(400);

      const created = await call("POST", "", controller, {
        code: "PPN", name: "PPN 13% (hypothetical)", kind: "ppn_output", rate: 13, baseMultiplier: 1,
        effectiveFrom: "2026-01-01", accountCode: "2140" });
      expect(created.statusCode, created.body).toBe(201);

      // History reproduces under the OLD rows; the new date reads the NEW row.
      expect(Math.round((await compute(1_000_000, "PPN", "2025-06-01")) as number)).toBe(110_000);
      expect(Math.round((await compute(1_000_000, "PPN", "2026-06-01")) as number)).toBe(130_000);
    });

    it("an unused row added by mistake can be removed", async () => {
      const made = await call("POST", "", controller, {
        code: "TMP", name: "Temporary", kind: "pph23", rate: 2, effectiveFrom: "2026-01-01" });
      expect(made.statusCode, made.body).toBe(201);
      const id = (made.json() as { id: string }).id;
      const del = await call("DELETE", `/${id}`, controller);
      expect(del.statusCode, del.body).toBe(200);
      expect((await list()).some((r) => r.code === "TMP")).toBe(false);
      expect((await call("DELETE", `/${id}`, controller)).statusCode).toBe(404);
    });

    it("validation: a bad kind, rate, multiplier or date is a 400", async () => {
      const base = { code: "BAD", name: "Bad", kind: "ppn_output", rate: 11, effectiveFrom: "2026-01-01" };
      for (const patch of [{ kind: "vat" }, { rate: 101 }, { rate: "abc" }, { baseMultiplier: 1.5 }, { effectiveFrom: "01/01/2026" },
        { code: "has space" }, { effectiveTo: "2025-01-01" }, { accountCode: "9999" }]) {
        const r = await call("POST", "", controller, { ...base, ...patch });
        expect(r.statusCode, JSON.stringify(patch)).toBe(400);
      }
    });
  });

  describe("authorization", () => {
    it("★ a member without the permission gets 403 on every tax-code route, before any validation", async () => {
      const id = newId();
      for (const [method, url, body] of [
        ["GET", "", undefined],
        ["POST", "/standard-ppn", undefined],
        ["POST", "", {}],
        ["POST", `/${id}/end`, {}],
        ["PATCH", `/${id}`, {}],
        ["DELETE", `/${id}`, undefined],
      ] as const) {
        const r = await call(method, url, outsider, body);
        expect(r.statusCode, `${method} ${url}`).toBe(403);
      }
    });

    it("finance_staff may read the codes but not configure them (403, not 400, on an empty body)", async () => {
      expect((await call("GET", "", clerk)).statusCode).toBe(200);
      expect((await call("POST", "/standard-ppn", clerk)).statusCode).toBe(403);
      expect((await call("POST", "", clerk, {})).statusCode).toBe(403);
    });
  });
});
