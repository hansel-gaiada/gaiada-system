// PV7-07 — the monthly account summary (docs/FRONTEND-BFF-CONTRACT.md §56), proven over HTTP against real Postgres + RLS + Cerbos
// (skips silently without DATABASE_URL_TEST: check the skip count; runs on the Linux CI gate). The publish flow also needs a real
// Redis for the one-shot print token (REDIS_URL_TEST); those tests skip without it, and the count says so.
//
// WHAT IS PROVEN
//   1. The snapshot is the CLIENT-WIDE view of ONE client, month-bound: client B's summary carries B's two projects (B1, which the
//      shared multi-client contact reaches, AND B2, which they do not: a project-scoped-only project still appears, it is the
//      client-wide view) and none of A's, none of an internal project's; milestones completed and deliverables delivered in the
//      month and not outside it; the turnaround window ends at the month's end; the reports published in the month (titles only).
//      It EQUALS what a client-wide contact of B reads on `GET portal/health` (the positive control): same projects, same counts.
//   2. PLANTED and scanned for in the whole snapshot and narrative: a blocked task's title, a time entry's note, a staff user's name,
//      an internal gate, a pending payment's amount. None of them appears. (The money KPI tooth is the unit suite's.)
//   3. One live draft per client and month; a retry returns it; a published one blocks a re-draft until withdrawn.
//   4. The routes' order and codes: authorization before validation, the client's owner rule, the agent (automation) may draft and may
//      not publish, 404s, 400s, the PATCH state rules.
//   5. Publish renders THEN publishes: not configured / sidecar fails / sidecar returns a non-PDF => 503 and the report stays a draft
//      with no file; success stores the role file with its sha256 and the client-wide contact downloads exactly those bytes; an edit
//      that lands mid-render is a 409 `draft_changed` (the PDF can never disagree with the narrative).
//   6. The database: the content CHECK, the whole-month CHECK, the live-month UNIQUE, and the freeze trigger (PD056) in every state.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import Redis from "ioredis";
import { config } from "../../../config";
import { buildApp } from "../../../main";
import { resetModules } from "../../registry";
import { resetCoreRollupProviders } from "../../../rollups/engine";
import { setRedis, closeRedis } from "../../../events/redis";
import { initTestDb, teardownTestDb, TEST_URL } from "../../../testing/setup";
import { addMembership, createClient, createCompany, createProject, createRole, createUser, grantRole } from "../../../testing/fixtures";
import { createMultiClientContact, type MultiClientContact } from "../../../testing/portal-fixtures";
import { newId, withGlobal, withTenants } from "../../../db";
import { setStorageForTest } from "../../../core/storage";
import { sha256Hex } from "../../../core/content-hash";
import { createIssuedInvoice, ensureBillingSetup } from "../../../seed/billing-setup";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;
const mem = new Map<string, Buffer>();

const PLANT = {
  taskTitle: "SECRET task title: refactor auth before the demo",
  timeNote: "TIMEENTRY secret billing note",
  staffName: "Ada Admin",
  amount: "98765.43",
};

interface StaffReport {
  id: string; clientId: string; source: string; status: string; title: string; period: string;
  narrativeMd: string; narrativeSource: string; generatedAt: string; snapshot: Snapshot;
  file: { id: string; filename: string; contentType: string; byteSize: number } | null;
  periodStart: string; periodEnd: string; projectId: string | null;
}
interface Snapshot {
  version: number; clientId: string; clientName: string; period: string; periodStart: string; periodEnd: string; generatedAt: string;
  projects: Array<{ projectId: string; name: string; status: string; milestones: { total: number; done: number; late: number }; deliverables: { total: number; delivered: number } }> | null;
  waiting: { onClient: { count: number }; onUs: { count: number } } | null;
  completed: {
    milestones: { count: number; knownSince: string | null; wholeMonthKnown: boolean | null; items: Array<{ name: string; projectName: string; completedOn: string }> } | null;
    deliverables: { count: number; basis: string; items: Array<{ name: string; on: string }> } | null;
  };
  turnaround: { windowDays: number; windowEnd: string; client: { medianDays: number | null; n: number; withheld: boolean }; ours: { medianDays: number | null; n: number; withheld: boolean } } | null;
  results: unknown;
  reports: Array<{ title: string; source: string; publishedOn: string }> | null;
  unavailable: string[];
}
interface PortalReport { id: string; title: string; source: string; projectId: string | null; file: { id: string } }

describe.skipIf(!TEST_URL)("PV7-07 · the monthly account summary", () => {
  let app: NestFastifyApplication;
  let nestBaseUrl = "";
  let sidecar: Server;
  let sidecarUrl = "";
  let sidecarMode: "ok" | "fail" | "notpdf" | "edit" = "ok";
  let sidecarRequests = 0;
  let lastDocument: { header: { grain: string; scopeRef: string; periodLabel: string }; narrative: { source: string; text: string } } | null = null;
  let onRender: (() => Promise<void>) | null = null;

  let co: string;
  let admin: string;        // company_admin; named PLANT.staffName
  let ownerA: string;       // member, the owner of client A
  let plainMember: string;  // member, owns nothing
  let viewer: string;       // viewer
  let automationMgr: string; // manager, users.kind = 'automation': drafts, never publishes
  let m: MultiClientContact;
  let wideB: string;        // positive control: client-wide contact of B
  let internalClient: string;
  let projectInternal: string;
  let projectB1: string;
  let projectB2: string;

  const PERIOD = "2026-09";

  async function staffUser(email: string, name: string, role: string, kind?: string): Promise<string> {
    const u = await createUser(email, name);
    await addMembership(co, u);
    await grantRole(u, await createRole(role), "company", co);
    if (kind) await withGlobal((q) => q.query(`UPDATE users SET kind = $2 WHERE id = $1`, [u, kind]));
    return u;
  }
  const post = (user: string, clientId: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api/${co}/clients/${clientId}/reports/summary`, headers: asUser(user), payload: payload as object });
  const draft = async (user: string, clientId: string, period = PERIOD): Promise<{ created: boolean; report: StaffReport }> => {
    const r = await post(user, clientId, { period });
    expect(r.statusCode, r.body.slice(0, 400)).toBe(200);
    return r.json();
  };
  const patch = (user: string, id: string, payload: unknown) =>
    app.inject({ method: "PATCH", url: `/api/${co}/client-reports/${id}`, headers: asUser(user), payload: payload as object });
  const publish = (user: string, id: string) =>
    app.inject({ method: "POST", url: `/api/${co}/client-reports/${id}/publish`, headers: asUser(user) });
  const withdraw = (user: string, id: string, reason = "wrong figures") =>
    app.inject({ method: "POST", url: `/api/${co}/client-reports/${id}/withdraw`, headers: asUser(user), payload: { reason } });
  const staffList = async (clientId: string): Promise<StaffReport[]> => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/clients/${clientId}/reports`, headers: asUser(admin) });
    expect(r.statusCode).toBe(200);
    return r.json().reports;
  };
  const portalReports = async (user: string): Promise<PortalReport[]> => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/reports`, headers: asUser(user) });
    expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
    return r.json();
  };
  const dbCode = async (fn: () => Promise<unknown>): Promise<string | null> => {
    try { await fn(); return null; } catch (e) { return (e as { code?: string }).code ?? "unknown"; }
  };
  const liveSummaries = async (clientId: string) =>
    (await withTenants([co], (q) => q.query<{ id: string; status: string }>(
      `SELECT id, status FROM client_reports WHERE client_id = $1 AND source = 'account_summary' ORDER BY created_at`, [clientId]))).rows;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    if (REDIS_TEST_URL) setRedis(new Redis(REDIS_TEST_URL));
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error(`missing blob ${k}`); return b; },
      del: async (k) => { mem.delete(k); },
    });
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Account Summary Co", ["clients", "invoice", "pm", "social", "webdev"]);
    admin = await staffUser("admin@account-summary.test", PLANT.staffName, "company_admin");
    ownerA = await staffUser("owner-a@account-summary.test", "Olive Owner", "member");
    plainMember = await staffUser("member@account-summary.test", "Mick Member", "member");
    viewer = await staffUser("viewer@account-summary.test", "Vera Viewer", "viewer");
    automationMgr = await staffUser("automation@account-summary.test", "Auto Mation", "manager", "automation");

    m = await createMultiClientContact(co, { tag: "as", staffUserId: admin });
    const { clientA: A, clientB: B, projectA: pA } = m;
    projectB1 = m.projectB1;
    projectB2 = m.projectB2;
    await withTenants([co], (q) => q.query(`UPDATE clients SET owner_user_id = $2 WHERE id = $1`, [A, ownerA]));

    wideB = await createUser("wide-b@account-summary.test", "Wanda Wide");
    await addMembership(co, wideB);
    await grantRole(wideB, await createRole("client"), "company", co);
    await withGlobal((q) => q.query(`UPDATE users SET kind = 'client' WHERE id = $1`, [wideB]));

    internalClient = await createClient(co, "Internal Sentinel");
    await withTenants([co], (q) => q.query(`UPDATE clients SET is_internal = true WHERE id = $1`, [internalClient]));
    projectInternal = await createProject(co, "Internal tooling", admin);
    await withTenants([co], (q) => q.query(`UPDATE projects SET client_id = $2, is_internal = true WHERE id = $1`, [projectInternal, B]));

    await ensureBillingSetup(co);
    const invB = (await createIssuedInvoice(co, { clientId: B, actorId: admin, lines: [{ description: "Work", amount: 1000 }] })).id;

    await withTenants([co], async (q) => {
      await q.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'viewer', 'active', now(), $5)`,
        [newId(), co, B, wideB, site()],
      );

      // ── milestones: completed_at is named so the trigger keeps it ──
      const milestone = (project: string, name: string, status: string, completedAt: string | null, dueOffset: number | null, deleted = false) =>
        q.query(
          `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, completed_at, deleted_at, origin_site)
           VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE current_date + $5::int END, $6, $7::timestamptz,
                   CASE WHEN $8 THEN now() END, $9)`,
          [newId(), co, project, name, dueOffset, status, completedAt, deleted, site()],
        );
      await milestone(projectB1, "B1 Design approved", "done", "2026-09-14T10:00:00Z", null);
      await milestone(projectB1, "B1 Done in August", "done", "2026-08-20T10:00:00Z", null);
      await milestone(projectB1, "B1 Deleted but done in September", "done", "2026-09-15T10:00:00Z", null, true);
      await milestone(projectB1, "B1 Late one", "open", null, -5);
      await milestone(projectB2, "B2 Content signed off", "done", "2026-09-28T23:30:00Z", null);
      await milestone(projectB2, "B2 Done in October", "done", "2026-10-02T10:00:00Z", null);
      await milestone(projectInternal, "Internal done in September", "done", "2026-09-10T10:00:00Z", null);
      await milestone(pA, "A Secret milestone", "done", "2026-09-11T10:00:00Z", null);

      // ── deliverables: updated_at is the delivered-in-month evidence ──
      const deliverable = (project: string, name: string, status: string, updatedAt: string) =>
        q.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, custom_fields, updated_at, origin_site)
           VALUES ($1, $2, $3, NULL, $4, $5, '{}', $6::timestamptz, $7)`,
          [newId(), co, project, name, status, updatedAt, site()],
        );
      await deliverable(projectB2, "B2 Brand guide", "delivered", "2026-09-21T09:00:00Z");
      await deliverable(projectB1, "B1 Old delivery", "delivered", "2026-08-02T09:00:00Z");
      await deliverable(projectB1, "B1 Still pending", "pending", "2026-09-05T09:00:00Z");
      await deliverable(pA, "A Secret deliverable", "delivered", "2026-09-22T09:00:00Z");

      // ── PLANTED: a blocked task, a time entry, an internal gate, a pending payment ──
      await q.query(`INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, origin_site) VALUES ($1, $2, $3, $4, 'blocked', $5)`,
        [newId(), co, projectB2, PLANT.taskTitle, site()]);
      await q.query(
        `INSERT INTO time_entries (id, tenant_id, user_id, project_id, minutes, billable, entry_date, notes, origin_site)
         VALUES ($1, $2, $3, $4, 480, true, '2026-09-10', $5, $6)`,
        [newId(), co, admin, projectB2, PLANT.timeNote, site()],
      );
      await q.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, source, origin_site)
         VALUES ($1, $2, $3, $4, $5, 'IDR', current_date - 1, 'pending', 'client_claim', $6)`,
        [newId(), co, invB, B, PLANT.amount, site()],
      );

      // ── runs and gates (turnaround, and the ball) ──
      const run = (id: string, projectId: string | null, title: string) =>
        q.query(
          `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
           VALUES ($1, $2, $3, 'delivery_active', $4, $5, $6)`,
          [id, co, title, B, projectId, site()],
        );
      const runB1 = newId();
      const runB0 = newId();
      await run(runB1, projectB1, "Run B1");
      await run(runB0, null, "Run B client-wide");
      // created -> decided, absolute timestamps so the window is exact: window = [2026-07-02, 2026-10-01) for 2026-09
      const gate = (runId: string, side: string, status: string, created: string, decided: string | null) =>
        q.query(
          `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, decision, decided_at, created_at, origin_site)
           VALUES ($1, $2, $3, 'prd_sign', $4, $5, CASE WHEN $6::timestamptz IS NULL THEN NULL ELSE 'approved' END, $6::timestamptz, $7::timestamptz, $8)`,
          [newId(), co, runId, side, status, decided, created, site()],
        );
      for (const d of ["2026-09-03", "2026-09-05", "2026-09-07"]) {
        await gate(runB1, "client", "decided", `${d}T00:00:00Z`, `${d.slice(0, 8)}${String(Number(d.slice(8)) + 2).padStart(2, "0")}T00:00:00Z`); // 2 days
      }
      for (const d of ["2026-09-10", "2026-09-12", "2026-09-14"]) {
        await gate(runB0, "client", "decided", `${d}T00:00:00Z`, `${d.slice(0, 8)}${String(Number(d.slice(8)) + 4).padStart(2, "0")}T00:00:00Z`); // 4 days
      }
      await gate(runB1, "client", "decided", "2026-08-25T00:00:00Z", "2026-10-05T00:00:00Z"); // answered AFTER the month: not a sample
      await gate(runB1, "client", "decided", "2026-04-01T00:00:00Z", "2026-05-01T00:00:00Z"); // before the 90-day window: not a sample
      await gate(runB1, "internal", "decided", "2026-09-01T00:00:00Z", "2026-09-30T00:00:00Z"); // internal: never a sample
      // pending: two client-side (one on B1, one client-wide) and one INTERNAL (never counted)
      await gate(runB1, "client", "pending", "2026-09-20T00:00:00Z", null);
      await gate(runB0, "client", "pending", "2026-09-22T00:00:00Z", null);
      await gate(runB1, "internal", "pending", "2026-09-23T00:00:00Z", null);

      // change requests we triaged in 1 day (our side): three on B1
      for (let i = 0; i < 3; i++) {
        await q.query(
          `INSERT INTO webdev_change_requests (id, tenant_id, source, kind, title, status, route, client_id, project_id, requested_by, triaged_by,
                                              triaged_at, created_at, origin_site)
           VALUES ($1, $2, 'portal', 'content', 'Triaged', 'triaged', 'mini_run', $3, $4, $5, $5,
                   '2026-09-11T00:00:00Z', '2026-09-10T00:00:00Z', $6)`,
          [newId(), co, B, projectB1, admin, site()],
        );
      }
    });

    // Published client reports need their own role file (the CHECK): make them through a tiny helper.
    const seedReport = async (clientId: string, projectId: string | null, status: "draft" | "published" | "withdrawn", title: string, publishedAt: string | null) => {
      const id = newId();
      const fileId = newId();
      const bytes = Buffer.from(`%PDF-fake ${title}`);
      const key = `${co}/client-reports/${fileId}`;
      mem.set(key, bytes);
      await withTenants([co], async (q) => {
        await q.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size,
                              storage_key, sha256, scrubbed, origin_site, role)
           VALUES ($1, $2, $3, 'client_report', $4, 'r.pdf', 'application/pdf', $5, $6, $7, false, $8, 'client_report_file')`,
          [fileId, co, admin, id, bytes.byteLength, key, sha256Hex(bytes), site()],
        );
        await q.query(
          `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, title, period_start, period_end, file_id, status,
                                       published_at, published_by, withdrawn_at, withdrawn_by, withdrawn_reason, created_by, origin_site)
           VALUES ($1, $2, $3, $4, 'social_report', gen_random_uuid(), $5, '2026-08-01', '2026-08-31', $6, $7, $8::timestamptz,
                   CASE WHEN $7 <> 'draft' THEN $9::uuid END, CASE WHEN $7 = 'withdrawn' THEN now() END,
                   CASE WHEN $7 = 'withdrawn' THEN $9::uuid END, CASE WHEN $7 = 'withdrawn' THEN 'wrong' END, $9, $10)`,
          [id, co, clientId, projectId, title, fileId, status, publishedAt, admin, site()],
        );
      });
    };
    await seedReport(B, null, "published", "B Sept whole-account report", "2026-09-10T10:00:00Z");
    await seedReport(B, projectB1, "published", "B Sept project report", "2026-09-12T10:00:00Z");
    await seedReport(B, null, "published", "B August report", "2026-08-30T10:00:00Z");
    await seedReport(B, null, "withdrawn", "B withdrawn Sept report", "2026-09-15T10:00:00Z");
    await seedReport(B, null, "draft", "B draft report", null);
    await seedReport(A, null, "published", "A Sept SECRET report", "2026-09-10T10:00:00Z");

    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    nestBaseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    // The renderer stand-in: relays to OUR real print-payload route over a real socket (the social report test's technique).
    sidecar = createServer((req, res) => {
      sidecarRequests++;
      if (req.method !== "POST" || req.url !== "/render") { res.writeHead(404).end(); return; }
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        const { url } = JSON.parse(raw) as { url: string };
        const jobToken = url.slice(url.lastIndexOf("/") + 1);
        const payloadRes = await fetch(`${nestBaseUrl}/internal/reports/print-payload/${jobToken}`);
        if (!payloadRes.ok) { res.writeHead(502).end(); return; }
        const payload = (await payloadRes.json()) as { document: NonNullable<typeof lastDocument>; grain: string };
        lastDocument = payload.document;
        if (onRender) await onRender();
        if (sidecarMode === "fail") { res.writeHead(500).end("renderer exploded"); return; }
        if (sidecarMode === "notpdf") { res.writeHead(200, { "content-type": "text/html" }).end("<html>an error page</html>"); return; }
        res.writeHead(200, { "content-type": "application/pdf" })
          .end(Buffer.from(`%PDF-fake\ngrain=${payload.document.header.grain}\nnarrative=${payload.document.narrative.text}`));
      });
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", resolve));
    sidecarUrl = `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`;
  }, 240_000);

  afterAll(async () => {
    config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 30000 };
    await new Promise<void>((r) => sidecar?.close(() => r()));
    await app?.close();
    if (REDIS_TEST_URL) await closeRedis();
    await teardownTestDb();
  });

  // ── 1. The snapshot ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the snapshot: the client-wide view of one client, for one month", () => {
    let b: StaffReport;
    beforeAll(async () => { b = (await draft(admin, m.clientB)).report; });

    it("is a draft account summary with the frozen snapshot and a narrative; the gateway is not configured here, so it is deterministic", () => {
      expect(b).toMatchObject({ source: "account_summary", status: "draft", clientId: m.clientB, projectId: null, period: PERIOD, periodStart: "2026-09-01", periodEnd: "2026-09-30", file: null });
      expect(b.title).toBe("Account summary, September 2026");
      expect(b.snapshot.version).toBe(1);
      expect(b.snapshot).toMatchObject({ clientId: m.clientB, period: PERIOD });
      expect(b.narrativeSource).toBe("deterministic");
      expect(b.narrativeMd.length).toBeGreaterThan(10);
      expect(b.generatedAt).toBe(b.snapshot.generatedAt);
      expect(Object.keys(b.snapshot).sort()).toEqual([
        "clientId", "clientName", "completed", "generatedAt", "period", "periodEnd", "periodStart", "projects", "reports", "results",
        "turnaround", "unavailable", "version", "waiting",
      ]);
      expect(b.snapshot.unavailable).toEqual([]);
    });

    it("has B's two projects, including the one the shared contact is NOT scoped to, and neither an internal project nor client A's", () => {
      const names = b.snapshot.projects!.map((p) => p.name).sort();
      expect(names).toEqual([`Multi as B1 project`, `Multi as B2 project`].sort());
      expect(b.snapshot.projects!.find((p) => p.projectId === projectB2)).toBeDefined(); // project-scoped-only for another contact: still in the client-wide view
      expect(JSON.stringify(b.snapshot)).not.toContain("Internal tooling");
      expect(JSON.stringify(b.snapshot)).not.toContain("Multi as A");
      expect(JSON.stringify(b.snapshot)).not.toContain("A Secret");
    });

    it("lists the milestones completed IN the month (not August, not October, not a deleted one, not an internal project's)", () => {
      const ms = b.snapshot.completed.milestones!;
      expect(ms.items.map((i) => i.name).sort()).toEqual(["B1 Design approved", "B2 Content signed off"]);
      expect(ms.count).toBe(2);
      expect(ms.items.find((i) => i.name === "B2 Content signed off")!.completedOn).toBe("2026-09-28"); // 23:30Z stays on the 28th (UTC)
      // Completion dates exist from migration 202610151710 and nothing was back-filled: a month that starts before it says so.
      expect(ms.wholeMonthKnown === false || ms.wholeMonthKnown === null).toBe(true);
      expect(ms.knownSince === null || /^\d{4}-\d{2}-\d{2}$/.test(ms.knownSince)).toBe(true);
    });

    it("lists the deliverables whose status changed to delivered in the month, labelled honestly", () => {
      const ds = b.snapshot.completed.deliverables!;
      expect(ds.basis).toBe("status_changed_in_month");
      expect(ds.items.map((i) => i.name)).toEqual(["B2 Brand guide"]);
      expect(ds.items[0].on).toBe("2026-09-21");
    });

    it("the turnaround window ends at the month's end: answers after it, before it, and internal gates are not samples", () => {
      const t = b.snapshot.turnaround!;
      expect(t.windowDays).toBe(90);
      expect(t.windowEnd).toBe("2026-09-30");
      // 3 x 2 days on B1's run and 3 x 4 days on the client-wide run: a client-wide contact sees both. Median of 2,2,2,4,4,4 = 3.
      expect(t.client).toEqual({ medianDays: 3, n: 6, withheld: false });
      // Our side: three change requests triaged in 1 day.
      expect(t.ours).toEqual({ medianDays: 1, n: 3, withheld: false });
    });

    it("counts what waits on each side, with the internal gate and nothing else counted", () => {
      // Waiting on the client: the pending client gates on B1's run and on the client-wide run (the internal one is never counted).
      expect(b.snapshot.waiting!.onClient.count).toBe(2);
      // Waiting on us: the client-recorded payment pending confirmation.
      expect(b.snapshot.waiting!.onUs.count).toBe(1);
    });

    it("lists the client reports published in the month by title (not August's, not a withdrawn or draft one, not another client's)", () => {
      expect(b.snapshot.reports!.map((r) => r.title).sort()).toEqual(["B Sept project report", "B Sept whole-account report"]);
      expect(JSON.stringify(b.snapshot)).not.toContain("SECRET");
    });

    it("EQUALS what a client-wide contact of B reads on GET portal/health: the same projects and counts (positive control)", async () => {
      const r = await app.inject({ method: "GET", url: `/api/${co}/portal/health`, headers: asUser(wideB) });
      expect(r.statusCode).toBe(200);
      const section = r.json().clients.find((c: { clientId: string }) => c.clientId === m.clientB);
      expect(section.projects.map((p: { name: string }) => p.name).sort()).toEqual(b.snapshot.projects!.map((p) => p.name).sort());
      for (const p of section.projects as Array<{ projectId: string; milestones: unknown; deliverables: unknown; status: string }>) {
        const mine = b.snapshot.projects!.find((x) => x.projectId === p.projectId)!;
        expect(mine.milestones).toMatchObject(p.milestones as object);
        expect(mine.deliverables).toMatchObject(p.deliverables as object);
        expect(mine.status).toBe(p.status);
      }
      const count = (key: "waitingOnYou" | "waitingOnUs") =>
        (section.projects as Array<Record<string, { count: number } | null>>).reduce((n, p) => n + (p[key]?.count ?? 0), 0) + (section.clientWide[key]?.count ?? 0);
      expect(b.snapshot.waiting!.onClient.count).toBe(count("waitingOnYou"));
      expect(b.snapshot.waiting!.onUs.count).toBe(count("waitingOnUs"));
    });

    it("carries none of the planted task, time, person, internal-gate or payment amount, anywhere in the snapshot or narrative", () => {
      const body = JSON.stringify(b.snapshot) + b.narrativeMd;
      for (const banned of [PLANT.taskTitle, "TIMEENTRY", PLANT.timeNote, PLANT.staffName, "INTERNAL", PLANT.amount, "98765", "98,765", "480"]) {
        expect(body, banned).not.toContain(banned);
      }
      const keys = new Set<string>();
      const walk = (v: unknown) => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); }
      };
      walk(b.snapshot);
      for (const k of keys) expect(k, k).not.toMatch(/task|effort|minutes|assignee|owner|person|people|author|gate|amount|currency|money|invoice|payment|price|cost|spend/i);
    });

    it("client A's summary holds A's data and none of B's", async () => {
      const a = (await draft(admin, m.clientA)).report;
      expect(a.snapshot.projects!.map((p) => p.name)).toEqual(["Multi as A project"]);
      expect(a.snapshot.completed.milestones!.items.map((i) => i.name)).toEqual(["A Secret milestone"]);
      expect(a.snapshot.completed.deliverables!.items.map((i) => i.name)).toEqual(["A Secret deliverable"]);
      expect(a.snapshot.reports!.map((r) => r.title)).toEqual(["A Sept SECRET report"]);
      const body = JSON.stringify(a.snapshot);
      for (const banned of ["B1", "B2", "B Sept", "Internal tooling"]) expect(body, banned).not.toContain(banned);
    });
  });

  // ── 2. One live draft per client and month ─────────────────────────────────────────────────────────────────────────
  describe("one live draft per client and month", () => {
    it("a second POST for the same month returns the existing draft and writes nothing", async () => {
      const first = await draft(admin, m.clientB, "2026-08");
      expect(first.created).toBe(true);
      const second = await draft(admin, m.clientB, "2026-08");
      expect(second.created).toBe(false);
      expect(second.report.id).toBe(first.report.id);
      expect(second.report.narrativeMd).toBe(first.report.narrativeMd);
      expect((await liveSummaries(m.clientB)).filter((r) => r.status === "draft").length).toBe(2); // 2026-09 and 2026-08, one each
    });

    it("two POSTs at once make one draft (the lock and the unique index)", async () => {
      const [x, y] = await Promise.all([post(admin, m.clientB, { period: "2026-07" }), post(admin, m.clientB, { period: "2026-07" })]);
      expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
      expect(x.json().report.id).toBe(y.json().report.id);
      expect([x.json().created, y.json().created].sort()).toEqual([false, true]);
    });
  });

  // ── 3. The routes: order and codes ─────────────────────────────────────────────────────────────────────────────────
  describe("routes: authorization first, then the body, then the state", () => {
    it("a viewer and a member who does not own the client are 403, even with a malformed body (validation never pre-empts authz)", async () => {
      expect((await post(viewer, m.clientB, { period: "2026-09" })).statusCode).toBe(403);
      expect((await post(viewer, m.clientB, { period: "nonsense" })).statusCode).toBe(403);
      expect((await post(plainMember, m.clientB, { period: "nonsense" })).statusCode).toBe(403);
      expect((await post(ownerA, m.clientB, { period: "2026-09" })).statusCode).toBe(403); // owns A, not B
    });

    it("the client's own owner (a member) may draft for THEIR client", async () => {
      const r = await post(ownerA, m.clientA, { period: "2026-06" });
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(r.json().created).toBe(true);
    });

    it("an agent (automation) drafts; it never publishes (L6)", async () => {
      const r = await post(automationMgr, m.clientB, { period: "2026-05" });
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect((await publish(automationMgr, r.json().report.id)).statusCode).toBe(403);
      expect((await withTenants([co], (q) => q.query(`SELECT status FROM client_reports WHERE id = $1`, [r.json().report.id]))).rows[0].status).toBe("draft");
    });

    it("validation, for a caller who may draft: a bad or future month, the internal client, an unknown or malformed client", async () => {
      for (const period of ["2026-13", "2026-9", "", null, 202609, undefined]) {
        const r = await post(admin, m.clientB, { period });
        expect(r.statusCode, String(period)).toBe(400);
        expect(r.body).toContain("invalid_period");
      }
      const future = await post(admin, m.clientB, { period: "2099-01" });
      expect(future.statusCode).toBe(400);
      expect(future.body).toContain("period_in_future");
      const internal = await post(admin, internalClient, { period: "2026-09" });
      expect(internal.statusCode).toBe(400);
      expect(internal.body).toContain("internal_client");
      expect((await post(admin, newId(), { period: "2026-09" })).statusCode).toBe(404);
      expect((await post(admin, "not-a-uuid", { period: "2026-09" })).statusCode).toBe(404);
    });

    it("PATCH: a staff edit makes the narrative human; blank, too long, a viewer, an unknown id and a social report are refused", async () => {
      const d = (await draft(admin, m.clientB, "2026-04")).report;
      expect(d.narrativeSource).toBe("deterministic");
      const ok = await patch(admin, d.id, { narrativeMd: "  Our own words for April.  " });
      expect(ok.statusCode, ok.body.slice(0, 300)).toBe(200);
      expect(ok.json().report).toMatchObject({ narrativeMd: "Our own words for April.", narrativeSource: "human", status: "draft" });
      // The frozen snapshot did not move.
      expect(ok.json().report.snapshot).toEqual(d.snapshot);
      for (const bad of [{ narrativeMd: "   " }, { narrativeMd: 5 }, {}]) {
        const r = await patch(admin, d.id, bad);
        expect(r.statusCode, JSON.stringify(bad)).toBe(400);
        expect(r.body).toContain("narrative_required");
      }
      const long = await patch(admin, d.id, { narrativeMd: "x".repeat(20_001) });
      expect(long.statusCode).toBe(400);
      expect(long.body).toContain("narrative_too_long");
      expect((await patch(viewer, d.id, { narrativeMd: "no" })).statusCode).toBe(403);
      expect((await patch(viewer, d.id, {})).statusCode).toBe(403);
      expect((await patch(admin, newId(), { narrativeMd: "x" })).statusCode).toBe(404);
      expect((await patch(admin, "nope", { narrativeMd: "x" })).statusCode).toBe(404);
      const social = (await staffList(m.clientB)).find((r) => r.source === "social_report")!;
      const refused = await patch(admin, social.id, { narrativeMd: "x" });
      expect(refused.statusCode).toBe(409);
      expect(refused.body).toContain("not_an_account_summary");
    });

    it("the staff list carries the summary fields for a summary and exactly the 04a shape for a social report", async () => {
      const list = await staffList(m.clientB);
      const s = list.find((r) => r.source === "account_summary")!;
      expect(s.snapshot).toBeDefined();
      expect(typeof s.narrativeMd).toBe("string");
      const social = list.find((r) => r.source === "social_report")! as unknown as Record<string, unknown>;
      for (const k of ["snapshot", "narrativeMd", "narrativeSource", "generatedAt", "period"]) expect(k in social, k).toBe(false);
    });
  });

  // ── 4. Publish: render first, then publish ─────────────────────────────────────────────────────────────────────────
  describe.skipIf(!REDIS_TEST_URL)("publish renders the PDF, stores it, then publishes", () => {
    let id: string;
    beforeAll(async () => {
      id = (await draft(admin, m.clientB, "2026-03")).report.id;
      expect((await patch(admin, id, { narrativeMd: "March went as planned." })).statusCode).toBe(200);
    });

    it("no renderer configured => 503 and the report stays a draft with no file", async () => {
      config.reportRenderer = { url: "", token: "", platformUiInternalUrl: "", timeoutMs: 5000 };
      const r = await publish(admin, id);
      expect(r.statusCode).toBe(503);
      expect(r.body).toContain("pdf_render_not_configured");
      const row = (await withTenants([co], (q) => q.query(`SELECT status, file_id FROM client_reports WHERE id = $1`, [id]))).rows[0];
      expect(row).toEqual({ status: "draft", file_id: null });
    });

    it("a renderer that fails, or answers with something that is not a PDF => 503, still a draft, no file stored", async () => {
      config.reportRenderer = { url: sidecarUrl, token: "render-tok", platformUiInternalUrl: nestBaseUrl, timeoutMs: 5000 };
      const blobsBefore = mem.size;
      for (const mode of ["fail", "notpdf"] as const) {
        sidecarMode = mode;
        const r = await publish(admin, id);
        expect(r.statusCode, mode).toBe(503);
        expect(r.body, mode).toContain("pdf_render_failed");
      }
      sidecarMode = "ok";
      const row = (await withTenants([co], (q) => q.query(`SELECT status, file_id FROM client_reports WHERE id = $1`, [id]))).rows[0];
      expect(row).toEqual({ status: "draft", file_id: null });
      expect(mem.size).toBe(blobsBefore);
      expect((await portalReports(wideB)).some((x) => x.id === id)).toBe(false);
    });

    it("an edit that lands while the PDF renders is a 409 draft_changed: nothing is published and the blob is discarded", async () => {
      sidecarMode = "ok";
      const blobsBefore = mem.size;
      onRender = async () => {
        await withTenants([co], (q) => q.query(`UPDATE client_reports SET narrative_md = 'changed mid-render', narrative_source = 'human' WHERE id = $1`, [id]));
      };
      try {
        const r = await publish(admin, id);
        expect(r.statusCode).toBe(409);
        expect(r.body).toContain("draft_changed");
      } finally { onRender = null; }
      expect((await withTenants([co], (q) => q.query(`SELECT status FROM client_reports WHERE id = $1`, [id]))).rows[0].status).toBe("draft");
      expect(mem.size).toBe(blobsBefore);
      // Restore the narrative the next test publishes.
      expect((await patch(admin, id, { narrativeMd: "March went as planned." })).statusCode).toBe(200);
    });

    it("success: renders a client-grain document of the edited narrative, stores the role file with its sha256, publishes, and the client-wide contact downloads exactly those bytes", async () => {
      sidecarMode = "ok";
      const before = sidecarRequests;
      const r = await publish(admin, id);
      expect(r.statusCode, r.body.slice(0, 300)).toBe(200);
      expect(r.json()).toMatchObject({ id, status: "published" });
      expect(sidecarRequests).toBe(before + 1);
      expect(lastDocument!.header).toMatchObject({ grain: "client", scopeRef: m.clientB, periodLabel: "March 2026" });
      expect(lastDocument!.narrative).toEqual({ source: "deterministic", text: "March went as planned." }); // staff-written reads as non-AI

      const row = (await withTenants([co], (q) => q.query<{ status: string; file_id: string; published_by: string; project_id: string | null }>(
        `SELECT status, file_id, published_by, project_id FROM client_reports WHERE id = $1`, [id]))).rows[0];
      expect(row).toMatchObject({ status: "published", published_by: admin, project_id: null });
      const file = (await withTenants([co], (q) => q.query<{ role: string; target_entity_type: string; target_entity_id: string; sha256: string; content_type: string; filename: string; storage_key: string }>(
        `SELECT role, target_entity_type, target_entity_id, sha256, content_type, filename, storage_key FROM files WHERE id = $1`, [row.file_id]))).rows[0];
      expect(file).toMatchObject({ role: "client_report_file", target_entity_type: "client_report", target_entity_id: id, content_type: "application/pdf", filename: "account-summary-2026-03.pdf" });
      const stored = mem.get(file.storage_key)!;
      expect(file.sha256).toBe(sha256Hex(stored));
      expect(stored.toString()).toContain("narrative=March went as planned.");

      // The portal: client-wide contacts of B see it and download those bytes; the contact limited to one project of B does not.
      const wide = await portalReports(wideB);
      const mine = wide.find((x) => x.id === id)!;
      expect(mine).toMatchObject({ source: "account_summary", projectId: null, title: "Account summary, March 2026" });
      const dl = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${mine.file.id}`, headers: asUser(wideB) });
      expect(dl.statusCode).toBe(200);
      expect(dl.rawPayload.equals(stored)).toBe(true);
      expect((await portalReports(m.userId)).some((x) => x.id === id)).toBe(false);
      expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${mine.file.id}`, headers: asUser(m.userId) })).statusCode).toBe(404);
    });

    it("afterwards: no edit, no second publish, no re-draft of that month; withdrawing frees the month", async () => {
      const edit = await patch(admin, id, { narrativeMd: "late edit" });
      expect(edit.statusCode).toBe(409);
      expect(edit.body).toContain("not_a_draft");
      expect((await publish(admin, id)).statusCode).toBe(409);
      const again = await post(admin, m.clientB, { period: "2026-03" });
      expect(again.statusCode).toBe(409);
      expect(again.body).toContain("summary_published");
      expect((await withdraw(admin, id)).statusCode).toBe(200);
      expect((await portalReports(wideB)).some((x) => x.id === id)).toBe(false);
      const redo = await post(admin, m.clientB, { period: "2026-03" });
      expect(redo.statusCode).toBe(200);
      expect(redo.json().created).toBe(true);
      expect(redo.json().report.id).not.toBe(id);
      // The withdrawn one is untouched: its snapshot and narrative still read as published.
      const old = (await staffList(m.clientB)).find((r) => r.id === id)!;
      expect(old.status).toBe("withdrawn");
      expect(old.narrativeMd).toBe("March went as planned.");
    });
  });

  // ── 5. The database ────────────────────────────────────────────────────────────────────────────────────────────────
  describe("the database: the content CHECK, the whole-month CHECK, the live-month UNIQUE and the freeze trigger", () => {
    const insert = (o: Record<string, unknown>) => withTenants([co], (q) => q.query(
      `INSERT INTO client_reports (id, tenant_id, client_id, project_id, source, source_id, title, period_start, period_end, status,
                                   snapshot, narrative_md, narrative_source, generated_at, origin_site)
       VALUES ($1, $2, $3, NULL, $4, $5, 'T', $6::date, $7::date, $8, $9::jsonb, $10, $11, $12::timestamptz, $13)`,
      [o.id ?? newId(), co, o.clientId ?? m.clientA, o.source ?? "account_summary", o.sourceId ?? null,
       o.start ?? "2025-01-01", o.end ?? "2025-01-31", o.status ?? "draft",
       "snapshot" in o ? o.snapshot : "{}", "narrative" in o ? o.narrative : "Words.", "nsource" in o ? o.nsource : "human",
       "generatedAt" in o ? o.generatedAt : new Date().toISOString(), site()],
    ));

    it("an account summary must carry a snapshot, a narrative, its source and a time; any other source carries none; a source value is checked", async () => {
      expect(await dbCode(() => insert({ snapshot: null }))).toBe("23514");
      expect(await dbCode(() => insert({ snapshot: "[]" }))).toBe("23514"); // not an object
      expect(await dbCode(() => insert({ narrative: null }))).toBe("23514");
      expect(await dbCode(() => insert({ narrative: "   " }))).toBe("23514");
      expect(await dbCode(() => insert({ nsource: null }))).toBe("23514");
      expect(await dbCode(() => insert({ nsource: "robot" }))).toBe("23514");
      expect(await dbCode(() => insert({ generatedAt: null }))).toBe("23514");
      expect(await dbCode(() => insert({ source: "social_report", sourceId: newId() }))).toBe("23514"); // carries a snapshot it must not
      expect(await dbCode(() => insert({ source: "social_report", sourceId: newId(), snapshot: null, narrative: null, nsource: null, generatedAt: null }))).toBeNull();
      expect(await dbCode(() => insert({}))).toBeNull();
    });

    it("an account summary sits on one whole calendar month", async () => {
      expect(await dbCode(() => insert({ start: "2025-02-02", end: "2025-02-28" }))).toBe("23514");
      expect(await dbCode(() => insert({ start: "2025-02-01", end: "2025-02-27" }))).toBe("23514");
      expect(await dbCode(() => insert({ start: "2025-02-01", end: "2025-03-31" }))).toBe("23514");
      expect(await dbCode(() => insert({ start: "2028-02-01", end: "2028-02-29" }))).toBeNull();
    });

    it("one live summary per client and month; a withdrawn one does not block a re-draft", async () => {
      expect(await dbCode(() => insert({ start: "2025-04-01", end: "2025-04-30" }))).toBeNull();
      expect(await dbCode(() => insert({ start: "2025-04-01", end: "2025-04-30" }))).toBe("23505");
      expect(await dbCode(() => insert({ start: "2025-04-01", end: "2025-04-30", clientId: m.clientB }))).toBeNull(); // another client
      // withdrawn rows do not count: make one (needs the published stamps and a file), then a live one still fits
      const wid = newId();
      const fileId = newId();
      await withTenants([co], async (q) => {
        await q.query(
          `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
           VALUES ($1, $2, $3, 'client_report', $4, 'w.pdf', 'application/pdf', 1, 'k', 'h', false, $5, 'client_report_file')`,
          [fileId, co, admin, wid, site()],
        );
        await q.query(
          `INSERT INTO client_reports (id, tenant_id, client_id, source, title, period_start, period_end, status, snapshot, narrative_md, narrative_source,
                                       generated_at, file_id, published_at, published_by, withdrawn_at, withdrawn_by, withdrawn_reason, origin_site)
           VALUES ($1, $2, $3, 'account_summary', 'T', '2025-05-01', '2025-05-31', 'withdrawn', '{}', 'w', 'human', now(), $4, now(), $5, now(), $5, 'x', $6)`,
          [wid, co, m.clientA, fileId, admin, site()],
        );
      });
      expect(await dbCode(() => insert({ start: "2025-05-01", end: "2025-05-31" }))).toBeNull();
    });

    it("the freeze trigger: in draft the snapshot and narrative change; once published or withdrawn they never do (SQLSTATE PD056), and publishing cannot smuggle a change", async () => {
      const id = newId();
      await insert({ id, start: "2025-06-01", end: "2025-06-30" });
      const upd = (sql: string, values: unknown[] = []) => withTenants([co], (q) => q.query(sql, [id, ...values]));
      // draft: free to edit
      expect(await dbCode(() => upd(`UPDATE client_reports SET narrative_md = 'edited', narrative_source = 'human' WHERE id = $1`))).toBeNull();
      expect(await dbCode(() => upd(`UPDATE client_reports SET snapshot = '{"a":1}'::jsonb WHERE id = $1`))).toBeNull();
      // a role file so the row can be published
      const fileId = newId();
      await withTenants([co], (q) => q.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type, byte_size, storage_key, sha256, scrubbed, origin_site, role)
         VALUES ($1, $2, $3, 'client_report', $4, 'f.pdf', 'application/pdf', 1, 'k2', 'h2', false, $5, 'client_report_file')`,
        [fileId, co, admin, id, site()],
      ));
      // the publishing UPDATE itself may not change the narrative or the snapshot with it
      expect(await dbCode(() => upd(`UPDATE client_reports SET status = 'published', file_id = $2, published_at = now(), published_by = $3, narrative_md = 'smuggled' WHERE id = $1`, [fileId, admin]))).toBe("PD056");
      expect(await dbCode(() => upd(`UPDATE client_reports SET status = 'published', file_id = $2, published_at = now(), published_by = $3, snapshot = '{}'::jsonb WHERE id = $1`, [fileId, admin]))).toBe("PD056");
      expect(await dbCode(() => upd(`UPDATE client_reports SET status = 'published', file_id = $2, published_at = now(), published_by = $3 WHERE id = $1`, [fileId, admin]))).toBeNull();
      // published: frozen, every column of the four
      for (const set of [
        `snapshot = '{"b":2}'::jsonb`, `narrative_md = 'rewritten'`, `narrative_source = 'ai'`, `generated_at = now() - interval '1 day'`,
      ]) {
        expect(await dbCode(() => upd(`UPDATE client_reports SET ${set} WHERE id = $1`)), set).toBe("PD056");
      }
      // other columns still move (the read marker path, the title)
      expect(await dbCode(() => upd(`UPDATE client_reports SET title = 'Renamed', updated_at = now() WHERE id = $1`))).toBeNull();
      // withdrawn: still frozen
      expect(await dbCode(() => upd(`UPDATE client_reports SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = 'x' WHERE id = $1`, [admin]))).toBeNull();
      expect(await dbCode(() => upd(`UPDATE client_reports SET narrative_md = 'again' WHERE id = $1`))).toBe("PD056");
      const row = (await withTenants([co], (q) => q.query<{ narrative_md: string; snapshot: unknown }>(`SELECT narrative_md, snapshot FROM client_reports WHERE id = $1`, [id]))).rows[0];
      expect(row.narrative_md).toBe("edited");
      expect(row.snapshot).toEqual({ a: 1 });
    });
  });
});
