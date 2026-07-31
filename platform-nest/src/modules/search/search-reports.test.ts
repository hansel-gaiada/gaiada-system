// SM-22 — controller e2e for the report review -> approve -> preview -> deliver lifecycle, against
// LIVE Postgres (RLS actually exercised) + the real HTTP layer. Same harness technique as
// search-sem-export.test.ts (SM-30): in-memory storage backend (never touches disk), Cerbos `check`
// mocked but its CALL ARGUMENTS captured so this file proves WHICH action gates WHICH route, not just
// the HTTP outcome a permissive stub would identically produce either way.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { setStorageForTest } from "../../core/storage";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient, createProject } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";

const capturedActions: string[] = [];
let denyAction: string | null = null;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (_principal: unknown, _resource: unknown, action: string) => {
      capturedActions.push(action);
      if (denyAction && action === denyAction) return { allow: false as const, reason: "test-forced-deny" };
      return { allow: true as const };
    }),
  };
});

const mem = new Map<string, Buffer>();
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("search-marketing client reports lifecycle (SM-22)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let projectA: string;
  let engagementWithProject: string;
  let engagementNoProject: string;
  let propertyId: string;

  async function draftReport(engagementId: string, period: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
      payload: { period, kind: "monthly" },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  async function submitForReview(reportId: string): Promise<void> {
    const r = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/reports/${reportId}`, headers: asUser(uA), payload: { status: "in_review" } });
    expect(r.statusCode).toBe(200);
  }

  async function approveReport(reportId: string): Promise<void> {
    const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/approve`, headers: asUser(uA) });
    expect(r.statusCode).toBe(200);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest({
      put: async (k, d) => { mem.set(k, d); },
      get: async (k) => { const b = mem.get(k); if (!b) throw new Error("missing"); return b; },
      del: async (k) => { mem.delete(k); },
    });
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM22 Co A", ["search"]);
    C = await createCompany("SM22 Co C", ["search"]);
    uA = await createUser("sm22-a@a.test");
    uC = await createUser("sm22-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM22 Client of A");
    projectA = await createProject(A, "SM22 Project");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm22.example.com", siteUrl: "https://sm22.example.com" },
    });
    propertyId = propRes.json().id as string;

    const engWithProjectRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, projectId: projectA, name: "SM22 engagement (with project)" },
    });
    engagementWithProject = engWithProjectRes.json().id as string;

    const engNoProjectRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM22 engagement (no project)" },
    });
    engagementNoProject = engNoProjectRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => { capturedActions.length = 0; denyAction = null; });

  // ─────────────────────────────────────────── lifecycle guard rails ──────────────────────────────
  describe("status transition guard rails", () => {
    it("404s PATCH/approve/preview/deliver on a nonexistent report", async () => {
      const badId = "00000000-0000-0000-0000-000000000000";
      for (const req of [
        { method: "PATCH" as const, url: `/api/${A}/modules/search/reports/${badId}`, payload: { status: "in_review" } },
        { method: "POST" as const, url: `/api/${A}/modules/search/reports/${badId}/approve` },
        { method: "GET" as const, url: `/api/${A}/modules/search/reports/${badId}/preview` },
        { method: "POST" as const, url: `/api/${A}/modules/search/reports/${badId}/deliver` },
      ]) {
        const r = await app.inject({ ...req, headers: asUser(uA) });
        expect(r.statusCode).toBe(404);
      }
    });

    it("cannot approve a 'draft' report (must be submitted for review first)", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-01");
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/approve`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/in_review/);
    });

    it("cannot submit an already-in_review report for review again", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-01b");
      await submitForReview(reportId);
      const r = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/reports/${reportId}`, headers: asUser(uA), payload: { status: "in_review" } });
      expect(r.statusCode).toBe(400);
    });

    it("can send an in_review report back to draft", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-01c");
      await submitForReview(reportId);
      const back = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/reports/${reportId}`, headers: asUser(uA), payload: { status: "draft" } });
      expect(back.statusCode).toBe(200);
      expect(back.json().status).toBe("draft");
    });

    it("cannot deliver an 'approved but not yet delivered'... wait: cannot deliver a report that is only 'draft' or 'in_review'", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-01d");
      const r1 = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(r1.statusCode).toBe(400);
      await submitForReview(reportId);
      const r2 = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(r2.statusCode).toBe(400);
    });

    it("cannot deliver the same report twice", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-02");
      await submitForReview(reportId);
      await approveReport(reportId);
      const d1 = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(d1.statusCode).toBe(200);
      const d2 = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(d2.statusCode).toBe(400);
    });

    it("company C cannot act on company A's report (404, not a data leak)", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-03");
      const r = await app.inject({ method: "PATCH", url: `/api/${C}/modules/search/reports/${reportId}`, headers: asUser(uC), payload: { status: "in_review" } });
      expect(r.statusCode).toBe(404);
    });
  });

  // ─────────────────────────────────────────── Cerbos action wiring ───────────────────────────────
  describe("Cerbos action wiring", () => {
    it("PATCH uses 'update'; approve uses 'approve'; preview uses 'read'; deliver uses 'deliver' — never blended", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-04");
      capturedActions.length = 0;
      await submitForReview(reportId);
      expect(capturedActions).toEqual(["update"]);

      capturedActions.length = 0;
      await approveReport(reportId);
      expect(capturedActions).toEqual(["approve"]);

      capturedActions.length = 0;
      const preview = await app.inject({ method: "GET", url: `/api/${A}/modules/search/reports/${reportId}/preview`, headers: asUser(uA) });
      expect(preview.statusCode).toBe(200);
      expect(capturedActions).toEqual(["read"]);

      capturedActions.length = 0;
      const deliver = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(deliver.statusCode).toBe(200);
      expect(capturedActions).toEqual(["deliver"]);
    });

    it("a Cerbos deny on 'approve' blocks approval exactly like a real policy deny would", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-05");
      await submitForReview(reportId);
      denyAction = "approve";
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/approve`, headers: asUser(uA) });
      expect(r.statusCode).toBe(403);
    });

    it("a Cerbos deny on 'deliver' blocks delivery exactly like a real policy deny would", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-06");
      await submitForReview(reportId);
      await approveReport(reportId);
      denyAction = "deliver";
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(r.statusCode).toBe(403);
    });
  });

  // ─────────────────────────────────────────── preview (read-only) ────────────────────────────────
  describe("preview", () => {
    it("returns the rendered markdown WITHOUT writing a file or touching status", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-07");
      await submitForReview(reportId);
      const before = await withTenants([A], (c) => c.query(`SELECT status, file_id FROM search_reports WHERE id = $1`, [reportId]), { modules: ["search"] });
      const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/reports/${reportId}/preview`, headers: asUser(uA) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { markdown: string; anySimulated: boolean; allSimulated: boolean; filename: string };
      expect(body.markdown).toMatch(/# SM22 engagement \(with project\)/);
      expect(body.filename).toMatch(/\.md$/);
      const after = await withTenants([A], (c) => c.query(`SELECT status, file_id FROM search_reports WHERE id = $1`, [reportId]), { modules: ["search"] });
      expect(after.rows[0].status).toBe(before.rows[0].status);
      expect(after.rows[0].file_id).toBeNull();
    });

    it("with no rank/gsc/ga4/ads/kpi/audit data at all, renders every section as an honest empty state (empty is not zero)", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-08");
      await submitForReview(reportId);
      const r = await app.inject({ method: "GET", url: `/api/${A}/modules/search/reports/${reportId}/preview`, headers: asUser(uA) });
      const { markdown } = r.json() as { markdown: string };
      expect(markdown).toMatch(/No rank-tracking data collected yet/);
      expect(markdown).toMatch(/No technical audits completed yet/);
      expect(markdown).toMatch(/No Search Console data pulled for this period/);
      expect(markdown).toMatch(/No Analytics data pulled for this period/);
      expect(markdown).toMatch(/No advertising data available for this period/);
      expect(markdown).toMatch(/No KPI targets set for this engagement/);
      expect(markdown).not.toMatch(/SIMULATED DATA/);
    });
  });

  // ─────────────────────────────────────────── deliver ────────────────────────────────────────────
  describe("deliver", () => {
    it("writes a `files` row, links a `deliverables` row when the engagement carries a project_id, and stamps delivered_at", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-09");
      await submitForReview(reportId);
      await approveReport(reportId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { fileId: string; deliverableId: string | null; filename: string };
      expect(body.fileId).toBeTruthy();
      expect(body.deliverableId).toBeTruthy();

      const bytes = mem.get(`${A}/search-reports/${body.fileId}`);
      expect(bytes?.toString("utf8")).toMatch(/# SM22 engagement \(with project\)/);

      const fileRow = await withTenants([A], (c) => c.query(`SELECT target_entity_type, target_entity_id, content_type FROM files WHERE id = $1`, [body.fileId]), { modules: ["search"] });
      expect(fileRow.rows[0]).toMatchObject({ target_entity_type: "search_report", target_entity_id: reportId, content_type: "text/markdown" });

      const deliverableRow = await withTenants([A], (c) => c.query(`SELECT project_id, client_id, status FROM deliverables WHERE id = $1`, [body.deliverableId]));
      expect(deliverableRow.rows[0]).toMatchObject({ project_id: projectA, client_id: clientA, status: "delivered" });

      const reportRow = await withTenants([A], (c) => c.query(`SELECT status, delivered_at, deliverable_id, file_id FROM search_reports WHERE id = $1`, [reportId]), { modules: ["search"] });
      expect(reportRow.rows[0].status).toBe("delivered");
      expect(reportRow.rows[0].delivered_at).not.toBeNull();
      expect(reportRow.rows[0].deliverable_id).toBe(body.deliverableId);
      expect(reportRow.rows[0].file_id).toBe(body.fileId);
    });

    it("delivers successfully with a NULL deliverableId when the engagement has no project_id — never blocked on it", async () => {
      const reportId = await draftReport(engagementNoProject, "2026-10");
      await submitForReview(reportId);
      await approveReport(reportId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { fileId: string; deliverableId: string | null };
      expect(body.fileId).toBeTruthy();
      expect(body.deliverableId).toBeNull();
    });

    it("emits search.report.ready_for_review on submit and search.report.delivered on deliver", async () => {
      const reportId = await draftReport(engagementWithProject, "2026-11");
      await submitForReview(reportId);
      await approveReport(reportId);
      await app.inject({ method: "POST", url: `/api/${A}/modules/search/reports/${reportId}/deliver`, headers: asUser(uA) });
      const events = await withTenants(
        [A],
        (c) => c.query<{ event_type: string }>(`SELECT event_type FROM outbox_events WHERE entity_id = $1 ORDER BY created_at`, [reportId]),
      );
      const types = events.rows.map((r) => r.event_type);
      expect(types).toContain("search.report.ready_for_review");
      expect(types).toContain("search.report.delivered");
    });
  });

  // ─────────────────────────────────────────── index.ts wiring sanity ─────────────────────────────
  it("draftReport MCP tool (SM-10) still exists — this ticket adds no MCP tool of its own (index.ts is owned by SM-21 this wave; a search.deliverReport tool is a follow-up wiring gap, reported separately)", () => {
    const tool = searchModule.mcpTools?.find((t) => t.name === "search.draftReport");
    expect(tool).toBeDefined();
  });
});
