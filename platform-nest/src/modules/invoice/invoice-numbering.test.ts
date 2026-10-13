// PV5-04b — invoice numbers per ruling PV-D35: `{company}/{yyyy}/{mm}/{code}/{nnnn}`, e.g. `GDA/2026/10/7K3/0001`.
// Real HTTP surface against Postgres + RLS + Cerbos (the Linux gate; skips without DATABASE_URL_TEST, and a skipped run
// proves nothing). The data model is in db/pv5-invoice-numbering.db.test.ts.
//
// TEETH (each proven in the PV5-04b hand-back by breaking the code in a throwaway commit):
//   (a) take the monthly counter with month 0 (a yearly counter)   -> "a new month restarts at 0001" fails;
//   (b) key the counter by code (a series per code)                -> "different codes in one month get consecutive numbers" fails;
//   (c) drop the NO_SERVICE_LINE blocker                            -> "issuing without a service line is refused" fails.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../../testing/fixtures";
import { createIssuedInvoice, ensureBillingSetup } from "../../seed/billing-setup";
import { formatInvoiceNo } from "./issue";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const CODE = "[2-9A-HJKMNP-Z]{3}";

describe("formatInvoiceNo (PV-D35)", () => {
  it("reads {company}/{yyyy}/{mm}/{code}/{nnnn}: mm zero-padded, nnnn at least four digits", () => {
    expect(formatInvoiceNo("GDA", 2026, 10, "7K3", 1)).toBe("GDA/2026/10/7K3/0001");
    expect(formatInvoiceNo("EX-1", 2027, 3, "AB2", 42)).toBe("EX-1/2027/03/AB2/0042");
    expect(formatInvoiceNo("X", 2026, 12, "ZZ9", 12345)).toBe("X/2026/12/ZZ9/12345");
  });
});

describe.skipIf(!TEST_URL)("PV5-04b — invoice numbers: service line, code, monthly counter", () => {
  let app: NestFastifyApplication;
  let N: string;          // fully set up, prefix NUM
  let admin: string;      // company_admin of N
  let member: string;     // member of N (nothing)
  let contact: string;    // client contact of clientHotel (portal)
  let clientHotel: string;   // business type 'hotel'
  let clientOther: string;   // no centre profile: business type 'other'
  let clientSpa: string;     // business type 'spa'
  let year: number;
  let month: number;

  const row = async (sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows[0];
  const rows = async (sql: string, args: unknown[] = []) => (await adminPool().query(sql, args)).rows;
  const pad = (n: number) => String(n).padStart(2, "0");

  async function profile(client: string, businessType: string) {
    await withTenants([N], (c) =>
      c.query(`INSERT INTO client_centre_profiles (id, tenant_id, client_id, business_type, origin_site) VALUES ($1, $2, $3, $4, 'test')`,
        [newId(), N, client, businessType]),
    );
  }
  /** An APPROVED invoice, inserted directly. `serviceLineKey` undefined = the seeded `services` line, null = none. */
  async function approved(client: string, o: { serviceLineKey?: string | null; lines?: unknown[]; amount?: number } = {}): Promise<string> {
    const id = newId();
    const amount = o.amount ?? 1000;
    const lines = o.lines ?? [{ description: "Work", hours: 1, rate: amount, amount }];
    const total = (lines as Array<{ amount: number }>).reduce((s, l) => s + l.amount, 0);
    await withTenants([N], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, service_line_key)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', 'IDR', $4, $5, 'test', $6, $6, $6, now(), $7)`,
        [id, N, client, JSON.stringify(lines), total, admin, o.serviceLineKey === undefined ? "services" : o.serviceLineKey],
      ),
    );
    return id;
  }
  const issue = (id: string, who = admin) => app.inject({ method: "POST", url: `/api/${N}/invoices/${id}/issue`, headers: asUser(who) });
  const readiness = (id: string, who = admin) => app.inject({ method: "GET", url: `/api/${N}/invoices/${id}/issue-readiness`, headers: asUser(who) });
  const detail = (id: string, who = admin) => app.inject({ method: "GET", url: `/api/${N}/invoices/${id}`, headers: asUser(who) });
  const put = (key: string, payload: unknown, who = admin) =>
    app.inject({ method: "PUT", url: `/api/${N}/billing/service-lines/${key}`, headers: asUser(who), payload: payload as Record<string, unknown> });
  const pre = (payload: unknown, who = admin) =>
    app.inject({ method: "POST", url: `/api/${N}/billing/number-codes`, headers: asUser(who), payload: payload as Record<string, unknown> });
  const codes = (who = admin) => app.inject({ method: "GET", url: `/api/${N}/billing/number-codes`, headers: asUser(who) });
  const blockerCodes = (res: { json: () => unknown }) => ((res.json() as { blockers: Array<{ code: string }> }).blockers ?? []).map((b) => b.code);
  const parts = (no: string) => {
    const [prefix, y, m, code, n] = no.split("/");
    return { prefix, y: Number(y), m: Number(m), code, n: Number(n) };
  };
  /** The first `day` of the month `back` months ago (UTC), as YYYY-MM-DD, with its year and month. */
  function monthsAgo(back: number, day = 5) {
    let y = year;
    let m = month - back;
    while (m < 1) { m += 12; y -= 1; }
    return { y, m, date: `${y}-${pad(m)}-${pad(day)}` };
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    N = await createCompany("PV5-04b Agency N", ["agency", "invoice", "clients"]);
    admin = await createUser("admin@pv504b.test");
    member = await createUser("member@pv504b.test");
    contact = await createUser("contact@pv504b-client.test");
    await addMembership(N, admin);
    await addMembership(N, member);
    await grantRole(admin, await createRole("company_admin"), "company", N);
    await grantRole(member, await createRole("member"), "company", N);
    clientHotel = await createClient(N, "PV5-04b Hotel Client");
    clientOther = await createClient(N, "PV5-04b Other Client");
    clientSpa = await createClient(N, "PV5-04b Spa Client");
    await profile(clientHotel, "hotel");
    await profile(clientSpa, "spa");
    await withTenants([N], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), 'test')`,
        [newId(), N, clientHotel, contact],
      ),
    );
    await grantRole(contact, await createRole("client"), "company", N);
    await ensureBillingSetup(N, { prefix: "NUM" });
    const now = (await row(`SELECT extract(year FROM current_date)::int AS y, extract(month FROM current_date)::int AS m`));
    year = now.y;
    month = now.m;
    app = await buildApp();
  }, 180_000);
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── service lines ───────────────────────────────────────────────────────────────────────────────────
  describe("service lines (billing settings)", () => {
    it("the seeded company has two generic lines; a finance writer adds, renames, links a department and switches one off", async () => {
      const list = await app.inject({ method: "GET", url: `/api/${N}/billing/service-lines`, headers: asUser(admin) });
      expect(list.statusCode, list.body).toBe(200);
      expect((list.json() as Array<{ key: string }>).map((l) => l.key).sort()).toEqual(["services", "support"]);

      const made = await put("consulting", { name: "Consulting", departmentId: "dept-x" });
      expect(made.statusCode, made.body).toBe(200);
      expect(made.json()).toMatchObject({ key: "consulting", name: "Consulting", departmentId: "dept-x", active: true, invoiceCount: 0 });
      const renamed = await put("consulting", { name: "Advisory" });
      expect(renamed.json()).toMatchObject({ name: "Advisory", departmentId: "dept-x" }); // department untouched
      const unlinked = await put("consulting", { departmentId: null, active: false });
      expect(unlinked.json()).toMatchObject({ name: "Advisory", departmentId: null, active: false });
    });

    it("authorization runs before validation (a member gets 403 even for a bad key); bad input is a named 400", async () => {
      expect((await put("Bad-Key", {}, member)).statusCode).toBe(403);
      expect((await put("Bad-Key", { name: "x" })).statusCode).toBe(400);
      expect((await put("newline", {})).statusCode).toBe(400); // a new line needs a name
      expect((await put("newline", { name: "  " })).statusCode).toBe(400);
      expect((await put("services", { active: "yes" })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/${N}/billing/service-lines`, headers: asUser(member) })).statusCode).toBe(403);
    });
  });

  // ── the decode table and pre-assigning ──────────────────────────────────────────────────────────────
  describe("number codes (the staff decode table)", () => {
    it("a code is pre-assigned (generated) before first use, the same answer comes back every time, and a chosen code is refused when taken", async () => {
      const first = await pre({ serviceLineKey: "support", businessType: "retail" });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ serviceLineKey: "support", businessType: "retail", alreadyAssigned: false });
      expect(first.json().code).toMatch(new RegExp(`^${CODE}$`));
      const again = await pre({ serviceLineKey: "support", businessType: "retail" });
      expect(again.json()).toMatchObject({ code: first.json().code, alreadyAssigned: true });

      // A code is never changed: a different one for the same pair is a 409; the same one is idempotent.
      const other = await pre({ serviceLineKey: "support", businessType: "retail", code: "ZZ9" });
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ reason: "code_already_assigned" });

      // A chosen code is allowed for a new pair, and then unavailable to every other pair.
      const chosen = await pre({ serviceLineKey: "support", businessType: "saas", code: "QX7" });
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect(chosen.json()).toMatchObject({ code: "QX7", alreadyAssigned: false });
      const taken = await pre({ serviceLineKey: "services", businessType: "saas", code: "QX7" });
      expect(taken.statusCode).toBe(409);
      expect(taken.json()).toMatchObject({ reason: "code_taken" });
    });

    it("validation: a malformed code, an unknown business type or an unknown line are named refusals, and authorization comes first", async () => {
      expect((await pre({ serviceLineKey: "support", businessType: "retail", code: "abc" }, member)).statusCode).toBe(403);
      for (const code of ["abc", "A", "ABCDE", "A B"]) {
        expect((await pre({ serviceLineKey: "services", businessType: "ecommerce", code })).statusCode, code).toBe(400);
      }
      expect((await pre({ serviceLineKey: "services", businessType: "not_a_type" })).statusCode).toBe(400);
      expect((await pre({ serviceLineKey: "Bad Key", businessType: "hotel" })).statusCode).toBe(400);
      expect((await pre({ serviceLineKey: "nonesuch", businessType: "hotel" })).statusCode).toBe(404);
    });

    it("the decode table lists every pair with its line name and business type; a member is refused (403)", async () => {
      const r = await codes();
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as { codes: Array<{ serviceLineKey: string; serviceLineName: string; businessType: string; businessTypeLabel: string; code: string; used: boolean }>; businessTypes: Array<{ id: string }> };
      const retail = body.codes.find((c) => c.serviceLineKey === "support" && c.businessType === "retail")!;
      expect(retail).toMatchObject({ serviceLineName: "Support and maintenance", used: false });
      expect(retail.businessTypeLabel).toBeTruthy();
      expect(body.businessTypes.map((b) => b.id)).toContain("hotel");
      expect(new Set(body.codes.map((c) => c.code)).size).toBe(body.codes.length); // one code, one pair
      expect((await codes(member)).statusCode).toBe(403);
    });
  });

  // ── the number ──────────────────────────────────────────────────────────────────────────────────────
  describe("the number {company}/{yyyy}/{mm}/{code}/{nnnn}", () => {
    it("issuing writes the PV-D35 shape, the code is the decoded (line, business type) pair, the AR invoice carries the same number, and the staff detail decodes it", async () => {
      const id = await approved(clientHotel, { serviceLineKey: "services" });
      const res = await issue(id);
      expect(res.statusCode, res.body).toBe(200);
      const no = res.json().invoiceNo as string;
      expect(no).toMatch(new RegExp(`^NUM/${year}/${pad(month)}/${CODE}/\\d{4}$`));
      const p = parts(no);

      const inv = await row(`SELECT invoice_no, service_line_key, number_code, ar_invoice_id FROM invoices WHERE id = $1`, [id]);
      expect(inv).toMatchObject({ invoice_no: no, service_line_key: "services", number_code: p.code });
      expect((await row(`SELECT invoice_no FROM finance_ar_invoices WHERE id = $1`, [inv.ar_invoice_id])).invoice_no).toBe(no);
      expect(await row(`SELECT service_line_key, business_type FROM billing_number_codes WHERE tenant_id = $1 AND code = $2`, [N, p.code]))
        .toEqual({ service_line_key: "services", business_type: "hotel" });

      // Staff decode: the invoice detail names what the code stands for.
      const d = await detail(id);
      expect(d.statusCode, d.body).toBe(200);
      expect(d.json()).toMatchObject({
        invoiceNo: no, serviceLineKey: "services", serviceLineName: "Professional services", numberCode: p.code,
        numberDecode: { serviceLineKey: "services", serviceLineName: "Professional services", businessType: "hotel" },
      });
      // ... and so does the decode table, which now shows the code as used.
      const table = (await codes()).json() as { codes: Array<{ code: string; used: boolean; invoiceCount: number }> };
      expect(table.codes.find((c) => c.code === p.code)).toMatchObject({ used: true, invoiceCount: 1 });
    });

    it("two invoices with DIFFERENT codes in one month get consecutive numbers (the counter is per company, never per code)", async () => {
      // Three different pairs: (services, hotel) is coded already; (support, hotel) and (services, other) are new.
      const a = await issue(await approved(clientHotel, { serviceLineKey: "services" }));
      const b = await issue(await approved(clientHotel, { serviceLineKey: "support" }));
      const c = await issue(await approved(clientOther, { serviceLineKey: "services" }));
      for (const r of [a, b, c]) expect(r.statusCode, r.body).toBe(200);
      const [pa, pb, pc] = [a, b, c].map((r) => parts(r.json().invoiceNo));
      expect(new Set([pa.code, pb.code, pc.code]).size).toBe(3);
      expect([pa.n + 1, pb.n + 1]).toEqual([pb.n, pc.n]);
      expect(pa.m).toBe(month);
      // Per company per month: the month's issued numbers are exactly 1..k with no gap, whatever their codes.
      const issuedNow = await rows(
        `SELECT invoice_no FROM invoices WHERE tenant_id = $1 AND invoice_no LIKE $2`, [N, `NUM/${year}/${pad(month)}/%`],
      );
      expect(issuedNow.map((r) => parts(r.invoice_no).n).sort((x, y) => x - y)).toEqual(issuedNow.map((_, i) => i + 1));
    });

    it("a new month restarts at 0001: the year and month come from the ISSUE DATE", async () => {
      const m2 = monthsAgo(2);
      const m1 = monthsAgo(1);
      const mk = (issueDate: string) =>
        createIssuedInvoice(N, { clientId: clientHotel, actorId: admin, lines: [{ description: "x", amount: 1000 }], issueDate });
      const a = await mk(m2.date);
      const b = await mk(m2.date);
      const c = await mk(m1.date);
      expect(a.invoiceNo).toMatch(new RegExp(`^NUM/${m2.y}/${pad(m2.m)}/${CODE}/0001$`));
      expect(b.invoiceNo).toMatch(new RegExp(`^NUM/${m2.y}/${pad(m2.m)}/${CODE}/0002$`));
      // The next month starts again at 0001 (even though the older month already reached 0002).
      expect(c.invoiceNo).toMatch(new RegExp(`^NUM/${m1.y}/${pad(m1.m)}/${CODE}/0001$`));
      // And the current month's counter was not touched by any of them.
      const cur = await issue(await approved(clientHotel));
      expect(parts(cur.json().invoiceNo).n).toBeGreaterThan(3);
      expect(parts(cur.json().invoiceNo).m).toBe(month);
    });

    it("CONCURRENT first issues for one new pair agree on one code, and take distinct consecutive numbers", async () => {
      const before = (await row(`SELECT count(*)::int AS n FROM billing_number_codes WHERE tenant_id = $1`, [N])).n;
      const ids = await Promise.all(Array.from({ length: 5 }, () => approved(clientSpa, { serviceLineKey: "services" })));
      const out = await Promise.all(ids.map((id) => issue(id)));
      for (const r of out) expect(r.statusCode, r.body).toBe(200);
      const ps = out.map((r) => parts(r.json().invoiceNo));
      expect(new Set(ps.map((p) => p.code)).size).toBe(1);
      const ns = ps.map((p) => p.n).sort((x, y) => x - y);
      expect(ns[4] - ns[0]).toBe(4);
      expect(new Set(ns).size).toBe(5);
      expect((await row(`SELECT count(*)::int AS n FROM billing_number_codes WHERE tenant_id = $1`, [N])).n).toBe(before + 1);
    });

    it("a PRE-ASSIGNED code is the one the number carries", async () => {
      // (support, spa) has no code yet: pre-assign a known one, then issue under it.
      expect((await pre({ serviceLineKey: "support", businessType: "spa", code: "PR3" })).statusCode).toBe(200);
      const r = await issue(await approved(clientSpa, { serviceLineKey: "support" }));
      expect(r.statusCode, r.body).toBe(200);
      expect(parts(r.json().invoiceNo).code).toBe("PR3");
    });

    it("a refused issue (not approved) writes no code and takes no number", async () => {
      const pairsBefore = (await row(`SELECT count(*)::int AS n FROM billing_number_codes WHERE tenant_id = $1`, [N])).n;
      const seriesBefore = await rows(`SELECT year, month, next_no FROM document_series WHERE tenant_id = $1 AND series = 'invoice' ORDER BY year, month`, [N]);
      // (support, other) has no code yet: a refused issue must not mint one.
      const id = await approved(clientOther, { serviceLineKey: "support" });
      await withTenants([N], (c) => c.query(`UPDATE invoices SET status = 'draft' WHERE id = $1`, [id]));
      const res = await issue(id);
      expect(res.statusCode).toBe(409);
      expect((await row(`SELECT count(*)::int AS n FROM billing_number_codes WHERE tenant_id = $1`, [N])).n).toBe(pairsBefore);
      expect(await rows(`SELECT year, month, next_no FROM document_series WHERE tenant_id = $1 AND series = 'invoice' ORDER BY year, month`, [N])).toEqual(seriesBefore);
    });
  });

  // ── the service line on the invoice ─────────────────────────────────────────────────────────────────
  describe("the invoice's service line", () => {
    it("issuing WITHOUT a service line is refused with NO_SERVICE_LINE, in the readiness GET and the 409, and writes nothing", async () => {
      const id = await approved(clientHotel, { serviceLineKey: null });
      const r = await readiness(id);
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ ready: false, issued: false });
      expect(blockerCodes(r)).toEqual(["NO_SERVICE_LINE"]);
      const seriesBefore = await rows(`SELECT year, month, next_no FROM document_series WHERE tenant_id = $1 AND series = 'invoice' ORDER BY year, month`, [N]);
      const res = await issue(id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toMatchObject({ reason: "issue_blocked" });
      expect(blockerCodes(res)).toEqual(["NO_SERVICE_LINE"]);
      expect(await row(`SELECT status, issued_at, invoice_no, number_code FROM invoices WHERE id = $1`, [id])).toEqual({ status: "approved", issued_at: null, invoice_no: null, number_code: null });
      expect(await rows(`SELECT year, month, next_no FROM document_series WHERE tenant_id = $1 AND series = 'invoice' ORDER BY year, month`, [N])).toEqual(seriesBefore);
    });

    it("staff pick the line (PATCH …/service-line); then it issues. An unknown or switched-off line is refused, and null clears the choice", async () => {
      const id = await approved(clientHotel, { serviceLineKey: null });
      const patch = (payload: unknown, who = admin) =>
        app.inject({ method: "PATCH", url: `/api/${N}/invoices/${id}/service-line`, headers: asUser(who), payload: payload as Record<string, unknown> });
      expect((await patch({ serviceLineKey: "support" }, member)).statusCode).toBe(403);
      expect((await patch({ serviceLineKey: "Bad Key" })).statusCode).toBe(400);
      expect((await patch({})).statusCode).toBe(400);
      expect((await patch({ serviceLineKey: "nonesuch" })).statusCode).toBe(400);
      expect((await patch({ serviceLineKey: "consulting" })).statusCode).toBe(400); // exists, but switched off above
      const ok = await patch({ serviceLineKey: "support" });
      expect(ok.statusCode, ok.body).toBe(200);
      expect((await detail(id)).json()).toMatchObject({ serviceLineKey: "support", serviceLineName: "Support and maintenance" });
      expect(blockerCodes(await readiness(id))).toEqual([]);
      expect((await patch({ serviceLineKey: null })).statusCode).toBe(200);
      expect(blockerCodes(await readiness(id))).toEqual(["NO_SERVICE_LINE"]);
      expect((await app.inject({ method: "PATCH", url: `/api/${N}/invoices/${newId()}/service-line`, headers: asUser(admin), payload: { serviceLineKey: "support" } })).statusCode).toBe(404);
    });

    it("a line switched off after it was chosen blocks the issue (NO_SERVICE_LINE naming it); switching it back on clears it", async () => {
      expect((await put("consulting", { active: true })).statusCode).toBe(200);
      const id = await approved(clientHotel, { serviceLineKey: "consulting" });
      expect(blockerCodes(await readiness(id))).toEqual([]);
      expect((await put("consulting", { active: false })).statusCode).toBe(200);
      const r = await readiness(id);
      expect(blockerCodes(r)).toEqual(["NO_SERVICE_LINE"]);
      expect((r.json() as { blockers: Array<{ message: string }> }).blockers[0].message).toMatch(/switched off/);
      expect((await issue(id)).statusCode).toBe(409);
      expect((await put("consulting", { active: true })).statusCode).toBe(200);
      expect((await issue(id)).statusCode).toBe(200);
    });

    it("the service line is FROZEN once issued: PATCH is a 409, and the row refuses a change", async () => {
      const id = await approved(clientHotel, { serviceLineKey: "services" });
      expect((await issue(id)).statusCode).toBe(200);
      const r = await app.inject({ method: "PATCH", url: `/api/${N}/invoices/${id}/service-line`, headers: asUser(admin), payload: { serviceLineKey: "support" } });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json()).toMatchObject({ reason: "issued" });
      await expect(withTenants([N], (c) => c.query(`UPDATE invoices SET service_line_key = 'support' WHERE id = $1`, [id]))).rejects.toThrow(/PV5_INVOICE_ISSUED_IMMUTABLE/);
      expect((await row(`SELECT service_line_key FROM invoices WHERE id = $1`, [id])).service_line_key).toBe("services");
    });

    describe("it DEFAULTS from the projects' departments", () => {
      let web1: string; let web2: string; let seo: string; let dup: string; let none: string;
      const line = (projectId: string | null, amount = 500) => ({ description: "Project work", ...(projectId ? { projectId } : {}), hours: 1, rate: amount, amount });

      beforeAll(async () => {
        for (const [k, name, dept] of [["webdev", "Web development", "dept-web"], ["seo", "Search", "dept-seo"], ["dupone", "Duplicate one", "dept-dup"], ["duptwo", "Duplicate two", "dept-dup"]]) {
          expect((await put(k, { name, departmentId: dept })).statusCode).toBe(200);
        }
        const mk = async (name: string, dept: string | null) => {
          const id = await createProject(N, name, admin);
          if (dept) await withTenants([N], (c) => c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [id, dept]));
          return id;
        };
        web1 = await mk("Site one", "dept-web");
        web2 = await mk("Site two", "dept-web");
        seo = await mk("Rankings", "dept-seo");
        dup = await mk("Ambiguous", "dept-dup");
        none = await mk("No department", null);
      });

      it("every project maps to ONE line: no choice needed; the invoice is ready, and issuing freezes the defaulted line", async () => {
        const id = await approved(clientHotel, { serviceLineKey: null, lines: [line(web1), line(web2)] });
        expect(blockerCodes(await readiness(id))).toEqual([]);
        expect((await detail(id)).json()).toMatchObject({ serviceLineKey: null, defaultServiceLineKey: "webdev" });
        const res = await issue(id);
        expect(res.statusCode, res.body).toBe(200);
        expect((await row(`SELECT service_line_key FROM invoices WHERE id = $1`, [id])).service_line_key).toBe("webdev");
        expect((await detail(id)).json()).toMatchObject({ serviceLineKey: "webdev", numberDecode: { serviceLineKey: "webdev" } });
      });

      it("a default is never a guess: projects that disagree, a department two lines share, a project with no department, or a line with no project give no default", async () => {
        for (const lines of [[line(web1), line(seo)], [line(dup)], [line(none)], [line(web1), line(null)], [line(newId())]]) {
          const id = await approved(clientHotel, { serviceLineKey: null, lines });
          expect(blockerCodes(await readiness(id)), JSON.stringify(lines)).toEqual(["NO_SERVICE_LINE"]);
          expect((await detail(id)).json()).toMatchObject({ defaultServiceLineKey: null });
        }
      });

      it("a line switched off is not a default; and a choice by staff beats the default", async () => {
        const id = await approved(clientHotel, { serviceLineKey: null, lines: [line(seo)] });
        expect(blockerCodes(await readiness(id))).toEqual([]);
        expect((await put("seo", { active: false })).statusCode).toBe(200);
        expect(blockerCodes(await readiness(id))).toEqual(["NO_SERVICE_LINE"]);
        expect((await put("seo", { active: true })).statusCode).toBe(200);
        const chosen = await approved(clientHotel, { serviceLineKey: "support", lines: [line(web1)] });
        expect((await issue(chosen)).statusCode).toBe(200);
        expect((await row(`SELECT service_line_key FROM invoices WHERE id = $1`, [chosen])).service_line_key).toBe("support");
      });

      it("an invoice generated from logged time carries each line's projectId, so the default works end to end", async () => {
        const proj = await createProject(N, "Logged project", admin);
        await withTenants([N], (c) => c.query(`UPDATE projects SET client_id = $2, department_id = 'dept-web' WHERE id = $1`, [proj, clientHotel]));
        const t = await app.inject({
          method: "POST", url: `/api/${N}/time-entries`, headers: asUser(member),
          payload: { projectId: proj, minutes: 120, billable: true, entryDate: "2026-07-10" },
        });
        expect(t.statusCode, t.body).toBeLessThan(300);
        const created = await app.inject({
          method: "POST", url: `/api/${N}/invoices`, headers: asUser(admin),
          payload: { clientId: clientHotel, periodStart: "2026-07-01", periodEnd: "2026-07-31", rate: 100, currency: "IDR" },
        });
        expect(created.statusCode, created.body).toBe(201);
        const d = (await detail(created.json().id as string)).json() as { lines: Array<{ projectId?: string }>; defaultServiceLineKey: string | null };
        expect(d.lines.map((l) => l.projectId)).toEqual([proj]);
        expect(d.defaultServiceLineKey).toBe("webdev");
      });
    });
  });

  // ── staff-only: the portal never carries the code table ─────────────────────────────────────────────
  describe("the portal shows the number only", () => {
    it("a client contact reads the issued number, but no decode, service line, code or project id; and cannot reach the staff settings or the staff invoice route", async () => {
      const issued = await createIssuedInvoice(N, {
        clientId: clientHotel, actorId: admin,
        lines: [{ description: "Portal work", amount: 800_000 }],
      });
      const list = await app.inject({ method: "GET", url: `/api/${N}/portal/invoices`, headers: asUser(contact) });
      expect(list.statusCode, list.body).toBe(200);
      const mine = (list.json() as Array<Record<string, unknown>>).find((r) => r.id === issued.id)!;
      expect(mine.invoiceNo).toBe(issued.invoiceNo);

      const det = await app.inject({ method: "GET", url: `/api/${N}/portal/invoices/${issued.id}`, headers: asUser(contact) });
      expect(det.statusCode, det.body).toBe(200);
      const d = det.json() as Record<string, unknown>;
      expect(d.invoiceNo).toBe(issued.invoiceNo);
      for (const body of [mine, d]) {
        for (const k of ["numberCode", "numberDecode", "serviceLineKey", "serviceLineName", "defaultServiceLineKey", "codes", "decode"]) {
          expect(body, k).not.toHaveProperty(k);
        }
      }
      const text = JSON.stringify([mine, d]);
      expect(text).not.toMatch(/billing_number|number_code|service_line|numberDecode/);
      expect(text).not.toContain("Professional services"); // the line's name is staff-side too
      expect(text).not.toContain("projectId");

      // A client role holds none of the staff reads.
      for (const url of [`/api/${N}/billing/number-codes`, `/api/${N}/billing/service-lines`, `/api/${N}/invoices/${issued.id}`, `/api/${N}/invoices`]) {
        expect((await app.inject({ method: "GET", url, headers: asUser(contact) })).statusCode, url).toBe(403);
      }
      expect((await pre({ serviceLineKey: "services", businessType: "hotel" }, contact)).statusCode).toBe(403);
    });

    it("a portal invoice whose tracker lines carry a project id is served without it", async () => {
      // An issued invoice's lines are frozen, so a line with a projectId is written on a fresh approved invoice and issued.
      const proj = await createProject(N, "Portal project", admin);
      const id = await approved(clientHotel, { lines: [{ description: "Tracked", projectId: proj, hours: 1, rate: 1000, amount: 1000 }] });
      expect((await issue(id)).statusCode).toBe(200);
      const det = await app.inject({ method: "GET", url: `/api/${N}/portal/invoices/${id}`, headers: asUser(contact) });
      expect(det.statusCode, det.body).toBe(200);
      const lines = (det.json() as { lines: Array<Record<string, unknown>> }).lines;
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toHaveProperty("projectId");
      expect(lines[0]).toMatchObject({ description: "Tracked", amount: 1000 });
      // Staff do see it (the default depends on it).
      expect(((await detail(id)).json() as { lines: Array<Record<string, unknown>> }).lines[0]).toHaveProperty("projectId", proj);
    });
  });
});
