// TR-18 — the export endpoints (§6.2 `POST .../export`, `GET .../exports/:jobId`,
// `GET .../exports/:jobId/download`) against LIVE Postgres + real Cerbos, exercising the exact
// authz/fetch paths a document read uses.
//
// Acceptance criteria pinned here:
//   * POST creates a job -> {jobId}; GET status returns filename/contentType/byteSize/downloadUrl;
//     GET download streams the real bytes with a safe Content-Disposition;
//   * ⚡ an export of an UNSEALED (here: custom-range) period carries the AD HOC banner — asserted
//     directly on the downloaded xlsx bytes, not just on the pure builder;
//   * a SEALED calendar-period export instead carries the SEALED banner with the real seal_hash
//     prefix, proving the export follows the SAME sealed-branch-else-live path a document read
//     does (not a second, independently-computed fetch);
//   * standing ruling 1 — a plain member is DENIED an export of a scope they cannot read (403),
//     identically to a document read, and a member CAN export their OWN person-grain scope;
//   * an unknown/foreign jobId (wrong tenant) -> 404, never a cross-tenant leak;
//   * format validation: "pdf" is rejected today (400), not silently downgraded.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import ExcelJS from "exceljs";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { addMembership, createCompany, createProject, createRole, createUser, grantRole } from "../../testing/fixtures";
import { syncMetricDefinitions } from "../../rollups/engine";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("TR-18 export service (live PG + Cerbos)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let otherCo: string;
  let alice: string; // member, task owner — exports her OWN person-grain scope
  let bob: string; // member, NOT alice — denied alice's scope
  let admin: string; // company_admin
  let projectId: string;

  async function pmTask(id: string, dueDate: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, due_date, estimate_minutes, origin_site) VALUES ($1,$2,$3,'task',$4::date,60,'central')`, [id, co, projectId, dueDate]),
    );
  }
  async function ownerAssignee(taskId: string, userId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO pm_task_assignees (id, tenant_id, task_id, role, assignee_kind, assignee_ref, user_id, origin_site, valid_from)
         VALUES ($1,$2,$3,'owner','person',$4,$5,'central','2026-01-01'::date)`,
        [newId(), co, taskId, userId, userId],
      ),
    );
  }
  async function completedEvent(taskId: string, dateIso: string, actorUserId: string): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO work_activity (id, tenant_id, source, source_ref, actor_user_id, verb, object_kind, object_ref, occurred_at, origin_site)
         VALUES ($1,$2,'pm',$3,$4,'completed','pm_task',$5,$6::timestamptz,'central')`,
        [newId(), co, `ev-${newId()}`, actorUserId, taskId, `${dateIso}T10:00:00Z`],
      ),
    );
  }
  async function completeTaskOn(dateIso: string): Promise<void> {
    const taskId = newId();
    await pmTask(taskId, dateIso);
    await ownerAssignee(taskId, alice);
    await completedEvent(taskId, dateIso, alice);
  }

  const createExport = (body: Record<string, unknown>, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/export`, headers: asUser(as), payload: body });
  const getStatus = (jobId: string, as = admin, tenant = co) => app.inject({ method: "GET", url: `/api/${tenant}/reports/exports/${jobId}`, headers: asUser(as) });
  const download = (jobId: string, as = admin, tenant = co) => app.inject({ method: "GET", url: `/api/${tenant}/reports/exports/${jobId}/download`, headers: asUser(as) });
  const getPeriods = (kind: string, from: string, to: string, as = admin) => app.inject({ method: "GET", url: `/api/${co}/reports/periods?kind=${kind}&from=${from}&to=${to}`, headers: asUser(as) });
  const seal = (id: string, as = admin) => app.inject({ method: "POST", url: `/api/${co}/reports/periods/${id}/seal`, headers: asUser(as) });

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    await syncMetricDefinitions();

    co = await createCompany("TR-18 Co", ["reports", "pm", "hr"]);
    otherCo = await createCompany("TR-18 Other Co", ["reports", "pm", "hr"]);
    alice = await createUser("alice@tr18.test");
    bob = await createUser("bob@tr18.test");
    admin = await createUser("admin@tr18.test");

    await addMembership(co, alice);
    await addMembership(co, bob);
    await addMembership(co, admin);
    const memberRole = await createRole("member");
    await grantRole(alice, memberRole, "company", co);
    await grantRole(bob, memberRole, "company", co);
    await grantRole(admin, await createRole("company_admin"), "company", co);

    projectId = await createProject(co, "Website");
    for (let d = 1; d <= 5; d++) await completeTaskOn(`2026-07-0${d}`);

    app = await buildApp();
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ═══════════════════════════════ happy path — unsealed (custom range) ═══════════════════════

  let unsealedJobId: string;

  it("POST /export on a custom (unsealed) range -> {jobId}", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "xlsx" });
    expect(r.statusCode).toBe(200);
    unsealedJobId = r.json().jobId;
    expect(typeof unsealedJobId).toBe("string");
  });

  it("GET status returns filename/contentType/byteSize/downloadUrl, status 'completed'", async () => {
    const r = await getStatus(unsealedJobId);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.status).toBe("completed");
    expect(body.filename).toMatch(/\.xlsx$/);
    expect(body.contentType).toContain("spreadsheetml");
    expect(body.byteSize).toBeGreaterThan(0);
    expect(body.downloadUrl).toBe(`/api/${co}/reports/exports/${unsealedJobId}/download`);
  });

  it("⚡ GET download of the UNSEALED export carries the AD HOC banner in cell A1 of the KPIs sheet, and a Provenance sheet — the mark is not merely present in test fixtures, it is IN THE DOWNLOADED BYTES", async () => {
    const r = await download(unsealedJobId);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-disposition"]).toContain("attachment");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");

    const wb = new ExcelJS.Workbook();
    await (wb.xlsx.load as (data: unknown) => Promise<ExcelJS.Workbook>)(Buffer.from(r.rawPayload));
    const kpiSheet = wb.getWorksheet("KPIs")!;
    const banner = String(kpiSheet.getCell("A1").value);
    expect(banner).toMatch(/^AD HOC · UNSEALED · as of /);
    expect(wb.getWorksheet("Provenance")).toBeDefined();
    const provRows: string[] = [];
    wb.getWorksheet("Provenance")!.eachRow((row) => provRows.push(String(row.getCell(1).value)));
    expect(provRows).toContain("Sealed");
  });

  // ═══════════════════════════════ happy path — sealed calendar period ═════════════════════════

  it("⚡ a SEALED calendar-period export carries the SEALED banner with the real seal_hash prefix, never AD HOC", async () => {
    const list = (await getPeriods("month", "2026-07-01", "2026-07-01")).json().periods as Array<{ id: string }>;
    const julyId = list[0].id;
    const sealResult = await seal(julyId);
    expect(sealResult.statusCode).toBe(200);
    const sealHash = sealResult.json().sealHash as string;

    const exportResult = await createExport({ grain: "person", scopeRef: alice, periodKind: "month", start: "2026-07-16", format: "xlsx" });
    expect(exportResult.statusCode).toBe(200);
    const jobId = exportResult.json().jobId;

    const r = await download(jobId);
    const wb = new ExcelJS.Workbook();
    await (wb.xlsx.load as (data: unknown) => Promise<ExcelJS.Workbook>)(Buffer.from(r.rawPayload));
    const banner = String(wb.getWorksheet("KPIs")!.getCell("A1").value);
    expect(banner).toBe(`SEALED · rev 0 · ${sealHash.slice(0, 12)}`);
    expect(banner).not.toContain("AD HOC");
  });

  // ═══════════════════════════════ CSV format ═══════════════════════════════

  it("format=csv returns a text/csv job whose downloaded bytes start with the mandatory banner", async () => {
    const created = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "csv" });
    expect(created.statusCode).toBe(200);
    const jobId = created.json().jobId;
    const status = await getStatus(jobId);
    expect(status.json().contentType).toContain("text/csv");
    const r = await download(jobId);
    expect(r.rawPayload.toString("utf8").split("\r\n")[0]).toMatch(/^"AD HOC · UNSEALED/);
  });

  // ═══════════════════════════════ authz — standing ruling 1 ═══════════════════════════════

  it("format='pdf' is rejected today (400), not silently downgraded", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "pdf" });
    expect(r.statusCode).toBe(400);
  });

  it("a plain member CAN export their OWN person-grain scope (self, mirrors the document-read 'owns' tier)", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "xlsx" }, alice);
    expect(r.statusCode).toBe(200);
  });

  it("a plain member is DENIED (403) an export of a DIFFERENT person's scope — an export must never widen access beyond a document read", async () => {
    const r = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "xlsx" }, bob);
    expect(r.statusCode).toBe(403);
  });

  it("company-grain export is denied to a plain member (only exec/company_admin per §8), mirroring the document read", async () => {
    const r = await createExport({ grain: "company", periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "xlsx" }, bob);
    expect(r.statusCode).toBe(403);
  });

  it("GET status/download of an export a caller cannot read is ALSO denied (403) even with a valid jobId — the re-authorization on read, not only on create", async () => {
    const created = await createExport({ grain: "person", scopeRef: alice, periodKind: "custom", start: "2026-07-01", end: "2026-07-05", format: "xlsx" }, admin);
    const jobId = created.json().jobId;
    expect((await getStatus(jobId, bob)).statusCode).toBe(403);
    expect((await download(jobId, bob)).statusCode).toBe(403);
  });

  // ═══════════════════════════════ not-found / cross-tenant ═══════════════════════════════

  it("an unknown jobId -> 404", async () => {
    expect((await getStatus(newId())).statusCode).toBe(404);
    expect((await download(newId())).statusCode).toBe(404);
  });

  it("a jobId that exists but under a DIFFERENT tenant -> 404, never served cross-tenant", async () => {
    const otherAdmin = await createUser("admin@tr18-other.test");
    await addMembership(otherCo, otherAdmin);
    await grantRole(otherAdmin, await createRole("company_admin"), "company", otherCo);
    expect((await getStatus(unsealedJobId, otherAdmin, otherCo)).statusCode).toBe(404);
    expect((await download(unsealedJobId, otherAdmin, otherCo)).statusCode).toBe(404);
  });
});
