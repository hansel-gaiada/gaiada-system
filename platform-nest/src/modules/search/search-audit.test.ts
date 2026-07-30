// SM-08 — Site-audit ingest + findings triage (design §12 SM-08 + §04 "Audits"). Same harness as
// search.test.ts (SM-02) / search-keywords.test.ts (SM-09): LIVE Postgres (RLS actually exercised)
// + the real HTTP layer. Cerbos is stubbed to always-allow here too — SM-03's
// resource_search_audit.yaml parity matrix is covered separately by search-cerbos.test.ts; this
// file exercises what SM-08 actually owns: ingest, idempotency, the regression diff, events, the
// triage PATCH, and cross-tenant refusal.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

// finishedAt varies per call (a real re-crawl always runs at a different wall-clock time) so that
// two DELIBERATELY-identical-content reports (e.g. run1 and run3 in the regression test below,
// which represent a real defect reappearing with byte-identical page data) still hash differently
// and are NOT mistaken for an idempotent re-post of the SAME crawl.
let reportSeq = 0;
function crawlerReport(pages: Array<{ url: string; statusCode?: number; title?: string; skipped?: "robots" | "off-host" | "max-pages"; error?: string }>) {
  reportSeq += 1;
  return {
    startUrl: "https://sm08.example.com/", pages,
    startedAt: "2026-07-29T00:00:00.000Z",
    finishedAt: new Date(Date.parse("2026-07-29T00:05:00.000Z") + reportSeq * 60_000).toISOString(),
  };
}

describe.skipIf(!TEST_URL)("search-marketing site-audit ingest + triage (SM-08)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let propertyId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM08 Co A", ["search"]);
    C = await createCompany("SM08 Co C", ["search"]);
    uA = await createUser("sm08-a@a.test");
    uC = await createUser("sm08-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM08 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm08.example.com", siteUrl: "https://sm08.example.com" },
    });
    propertyId = propRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("rejects hostile input (malformed/oversized/partial report) with 400, never 500 and never a partial write", async () => {
    const notObject = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report: "not an object" },
    });
    expect(notObject.statusCode).toBe(400);

    const noPages = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report: { startUrl: "https://x.test/" } },
    });
    expect(noPages.statusCode).toBe(400);

    const emptyPages = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report: { startUrl: "https://x.test/", pages: [] } },
    });
    expect(emptyPages.statusCode).toBe(400);

    const badPage = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report: { startUrl: "https://x.test/", pages: [{ url: 123 }] } },
    });
    expect(badPage.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "technical", source: "crawler",
        report: crawlerReport(Array.from({ length: 10_001 }, (_, i) => ({ url: `https://x.test/${i}`, statusCode: 200, title: "t" }))),
      },
    });
    expect(oversized.statusCode).toBe(400);

    // Bad kind/source are also 400s, not 500s.
    const badKind = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "bogus", source: "crawler", report: crawlerReport([{ url: "https://x.test/", statusCode: 200, title: "t" }]) },
    });
    expect(badKind.statusCode).toBe(400);

    const unadaptedSource = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "seonaut", report: crawlerReport([{ url: "https://x.test/", statusCode: 200, title: "t" }]) },
    });
    expect(unadaptedSource.statusCode).toBe(400);

    // None of the above rejected calls left ANY audit row behind (no partial write).
    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits`, headers: asUser(uA) });
    expect(list.json()).toEqual([]);
  });

  it("ingests a crawl report into audits+findings, severity-ranked and grouped by code", async () => {
    const report = crawlerReport([
      { url: "https://sm08.example.com/", statusCode: 200, title: "Home" },
      { url: "https://sm08.example.com/about", statusCode: 200 }, // missing title
      { url: "https://sm08.example.com/broken", statusCode: 404 },
      { url: "https://sm08.example.com/down", statusCode: 503 },
      { url: "https://sm08.example.com/blocked", skipped: "robots" },
      { url: "https://external.example.com/", skipped: "off-host" }, // NOT a finding
    ]);
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; idempotent: boolean; findings: number; regressed: string[] };
    expect(body.idempotent).toBe(false);
    expect(body.findings).toBe(4); // missing_title, broken_link, server_error, blocked_by_robots (off-host excluded)
    const auditId = body.id;

    const findings = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId}/findings`, headers: asUser(uA) });
    expect(findings.statusCode).toBe(200);
    const rows = findings.json() as Array<{ code: string; severity: string; status: string; urlCount: number }>;
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(byCode.server_error).toMatchObject({ severity: "critical", status: "open", urlCount: 1 });
    expect(byCode.broken_link).toMatchObject({ severity: "medium", status: "open", urlCount: 1 });
    expect(byCode.missing_title).toMatchObject({ severity: "medium", status: "open", urlCount: 1 });
    expect(byCode.blocked_by_robots).toMatchObject({ severity: "low", status: "open", urlCount: 1 });
    expect(rows.every((r) => !("off-host" in r))).toBe(true);

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits?propertyId=${propertyId}`, headers: asUser(uA) });
    const auditRow = (list.json() as Array<{ id: string; score: string; summary: Record<string, number> }>).find((a) => a.id === auditId);
    expect(auditRow?.summary).toMatchObject({ critical: 1, high: 0, medium: 2, low: 1, info: 0 });
  });

  // QA gate (2026-07-30): the ledger's SM-08 record claims idempotency is enforced "in the
  // SCHEMA" (the UNIQUE constraint + ON CONFLICT DO NOTHING), not just in app code — but every
  // existing test in this file posts sequentially (await, then await), which only proves the
  // app-code-level re-check path, never the actual race the schema constraint exists to close.
  // Fire two byte-identical ingests genuinely concurrently (Promise.all, no await between them)
  // to attack the claim directly: if the UNIQUE constraint were missing or the ON CONFLICT clause
  // were dropped, this is the test that would show two audit rows and/or a duplicated finding.
  it("QA: two GENUINELY CONCURRENT identical ingests (Promise.all, not sequential) land exactly ONE audit row (schema-level idempotency, not just app-code re-check)", async () => {
    const report = crawlerReport([{ url: "https://sm08.example.com/race", statusCode: 200 }]); // missing_title
    const [r1, r2] = await Promise.all([
      app.inject({
        method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
        payload: { propertyId, kind: "geo", source: "crawler", report },
      }),
      app.inject({
        method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
        payload: { propertyId, kind: "geo", source: "crawler", report },
      }),
    ]);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(201);
    const b1 = r1.json() as { id: string; idempotent: boolean };
    const b2 = r2.json() as { id: string; idempotent: boolean };
    // Exactly one of the two actually inserted; the other observed the conflict and no-opped.
    expect([b1.idempotent, b2.idempotent].sort()).toEqual([false, true]);
    expect(b1.id).toBe(b2.id);

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits?propertyId=${propertyId}&kind=geo`, headers: asUser(uA) });
    expect((list.json() as unknown[]).length).toBe(1); // no duplicate audit row from the race
    const findings = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${b1.id}/findings`, headers: asUser(uA) });
    expect((findings.json() as unknown[]).length).toBe(1); // no duplicate finding row from the race
  });

  it("re-ingesting the IDENTICAL report is a no-op (idempotent) — no duplicate audit or finding rows", async () => {
    const report = crawlerReport([{ url: "https://sm08.example.com/dup", statusCode: 200 }]); // missing_title
    const first = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "cwv", source: "crawler", report },
    });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as { id: string; idempotent: boolean };
    expect(firstBody.idempotent).toBe(false);

    const second = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "cwv", source: "crawler", report },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as { id: string; idempotent: boolean };
    expect(secondBody.idempotent).toBe(true);
    expect(secondBody.id).toBe(firstBody.id); // same audit, not a new row

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits?propertyId=${propertyId}&kind=cwv`, headers: asUser(uA) });
    expect((list.json() as unknown[]).length).toBe(1); // only ONE audit row for this property+kind

    const findings = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${firstBody.id}/findings`, headers: asUser(uA) });
    expect((findings.json() as unknown[]).length).toBe(1); // only ONE finding row, not duplicated
  });

  it("a second, DIFFERENT run diffs against the first: resolved issues flip to fixed, new ones appear, and a REAPPEARING issue regresses + emits search.audit.regression", async () => {
    // Run 1: two issues (missing_title on /r1, broken_link on /r1-broken).
    const run1 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "links", source: "crawler",
        report: crawlerReport([
          { url: "https://sm08.example.com/r1", statusCode: 200 },
          { url: "https://sm08.example.com/r1-broken", statusCode: 404 },
        ]),
      },
    });
    const auditId1 = (run1.json() as { id: string }).id;
    const findings1 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId1}/findings`, headers: asUser(uA) });
    const missingTitleId = (findings1.json() as Array<{ id: string; code: string }>).find((f) => f.code === "missing_title")!.id;

    // Manually triage missing_title as FIXED before the next crawl confirms it (the ordinary human workflow).
    const triage = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/findings/${missingTitleId}`, headers: asUser(uA), payload: { status: "fixed" },
    });
    expect(triage.statusCode).toBe(200);
    expect(triage.json()).toEqual({ id: missingTitleId, status: "fixed" });

    // Run 2 (different content -> different hash -> a NEW audit row): missing_title is gone
    // (title now present), broken_link persists.
    const run2 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "links", source: "crawler",
        report: crawlerReport([
          { url: "https://sm08.example.com/r1", statusCode: 200, title: "Now has a title" },
          { url: "https://sm08.example.com/r1-broken", statusCode: 404 },
        ]),
      },
    });
    expect(run2.statusCode).toBe(201);
    const body2 = run2.json() as { id: string; idempotent: boolean; regressed: string[] };
    expect(body2.idempotent).toBe(false);
    expect(body2.regressed).toEqual([]); // nothing regressed yet
    const auditId2 = body2.id;
    expect(auditId2).not.toBe(auditId1);

    // The FIRST audit's missing_title row is still 'fixed' (triage stands; run2 has no missing_title finding of its own).
    const findings1After = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId1}/findings`, headers: asUser(uA) });
    expect((findings1After.json() as Array<{ code: string; status: string }>).find((f) => f.code === "missing_title")?.status).toBe("fixed");
    // broken_link carried forward into run2's own findings, still 'open'.
    const findings2 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId2}/findings`, headers: asUser(uA) });
    const brokenLink2 = (findings2.json() as Array<{ code: string; status: string }>).find((f) => f.code === "broken_link");
    expect(brokenLink2?.status).toBe("open");

    // Run 3: missing_title REAPPEARS (title removed again) -> regression against the 'fixed' state.
    const run3 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "links", source: "crawler",
        report: crawlerReport([
          { url: "https://sm08.example.com/r1", statusCode: 200 }, // title gone again
          { url: "https://sm08.example.com/r1-broken", statusCode: 404 },
        ]),
      },
    });
    expect(run3.statusCode).toBe(201);
    const body3 = run3.json() as { id: string; regressed: string[] };
    expect(body3.regressed).toEqual(["missing_title"]);
    const findings3 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${body3.id}/findings`, headers: asUser(uA) });
    const missingTitle3 = (findings3.json() as Array<{ code: string; status: string }>).find((f) => f.code === "missing_title");
    expect(missingTitle3?.status).toBe("regressed");

    // The event backbone actually recorded both a completed event (run1) and a regression event (run3).
    const events = await withTenants(
      [A],
      (c) => c.query<{ event_type: string }>(
        `SELECT event_type FROM outbox_events WHERE tenant_id = $1 AND entity_type = 'search_audit' ORDER BY created_at ASC`,
        [A],
      ),
      { modules: ["search"] },
    );
    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain("search.audit.completed");
    expect(types).toContain("search.audit.regression");
  });

  it("triage rejects a caller-supplied 'regressed' status (system-derived only) and unknown statuses", async () => {
    const run = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "content", source: "crawler", report: crawlerReport([{ url: "https://sm08.example.com/tri", statusCode: 200 }]) },
    });
    const findingId = (await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${run.json().id}/findings`, headers: asUser(uA) })
      .then((r) => r.json() as Array<{ id: string }>))[0].id;

    const cannotFakeRegression = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/findings/${findingId}`, headers: asUser(uA), payload: { status: "regressed" },
    });
    expect(cannotFakeRegression.statusCode).toBe(400);

    const bogus = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/findings/${findingId}`, headers: asUser(uA), payload: { status: "bogus" },
    });
    expect(bogus.statusCode).toBe(400);

    const ok = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/findings/${findingId}`, headers: asUser(uA), payload: { status: "ignored" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("rejects ingest for a propertyId not visible in this tenant (FK tenant-validation)", async () => {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId: "00000000-0000-0000-0000-000000000000", kind: "technical", source: "crawler",
        report: crawlerReport([{ url: "https://x.test/", statusCode: 200, title: "t" }]),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/propertyId not found/);
  });

  it("cross-tenant refusal: an audit id and a finding id from tenant A both 404 under tenant C", async () => {
    const run = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "geo", source: "crawler", report: crawlerReport([{ url: "https://sm08.example.com/geo", statusCode: 500 }]) },
    });
    const auditId = (run.json() as { id: string }).id;
    const findingsRes = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId}/findings`, headers: asUser(uA) });
    const findingId = (findingsRes.json() as Array<{ id: string }>)[0].id;

    const crossAuditList = await app.inject({ method: "GET", url: `/api/${C}/modules/search/audits/${auditId}/findings`, headers: asUser(uC) });
    expect(crossAuditList.statusCode).toBe(404);

    const crossTriage = await app.inject({
      method: "PATCH", url: `/api/${C}/modules/search/findings/${findingId}`, headers: asUser(uC), payload: { status: "ignored" },
    });
    expect(crossTriage.statusCode).toBe(404);

    // The finding is untouched by the refused cross-tenant attempt.
    const stillThere = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId}/findings`, headers: asUser(uA) });
    expect((stillThere.json() as Array<{ id: string; status: string }>).find((f) => f.id === findingId)?.status).toBe("open");
  });
});
