// SM-10 — AI drafting services (content briefs, audit-finding triage/fix drafts, report-narrative
// drafts) against LIVE Postgres (RLS) + the real HTTP layer, same harness as search-keywords.test.ts
// (SM-09). Cerbos is stubbed to always-allow here too (parity matrix is search-cerbos.test.ts's
// job) — this file exercises what SM-10 actually owns: the routes, tenant/RLS scoping, FK
// tenant-validation (cross-tenant -> 404), the fail-soft AI drafting pipeline, and the "gateway is
// the only egress path" property (completeViaGateway is mocked at the module boundary, exactly
// like SM-09 — gateway-client.test.ts already proves the real single-host HTTP contract).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { syncMetricDefinitions, resetCoreRollupProviders } from "../../rollups/engine";

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

// Deterministic "Hermes" stand-in: echoes back a strict-JSON shape derived from the prompt so
// assertions can prove the grounding facts actually reached the prompt, without a live gateway.
// vi.hoisted() is required here (not a plain top-level const) because vi.mock's factory below is
// hoisted above ALL top-level statements, including const declarations — referencing a plain const
// from inside the factory throws a TDZ ReferenceError at module-eval time.
const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(async (prompt: string) => {
    if (prompt.includes("drafting a content brief")) {
      return {
        text: JSON.stringify({
          outline: ["Intro", "Body"],
          body: `Draft body. Prompt saw: ${prompt.includes("missing_title") ? "missing_title" : "no-findings"} / ${
            prompt.includes("running shoes") ? "running shoes" : "no-keywords"
          }`,
          geoNotes: "Use FAQ schema for extractability.",
        }),
        provider: "hermes-mock",
      };
    }
    if (prompt.includes("Polish and tighten")) {
      return { text: JSON.stringify({ outline: ["Intro", "Body", "Polished section"], body: "Polished body text.", geoNotes: "Polished GEO notes." }), provider: "claude-mock" };
    }
    if (prompt.includes("triaging technical SEO audit findings")) {
      return {
        text: JSON.stringify({
          summary: "Fix the critical server error first, then the missing title.",
          fixes: [
            { code: "server_error", suggestion: "Investigate the origin 500s." },
            { code: "missing_title", suggestion: "Add a descriptive <title> tag." },
            { code: "not_a_real_code", suggestion: "must be dropped" },
          ],
        }),
        provider: "hermes-mock",
      };
    }
    if (prompt.includes("drafting the narrative section")) {
      return { text: "## Strong month\nRankings improved and findings are under control.", provider: "hermes-mock" };
    }
    return { text: "{}", provider: "hermes-mock" };
  }),
}));

vi.mock("./providers/gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/gateway-client")>();
  return { ...actual, completeViaGateway: completeMock };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const CRAWLER_REPORT_WITH_FINDINGS = {
  startUrl: "https://sm10.example.com",
  pages: [
    { url: "https://sm10.example.com/", statusCode: 200, title: "" }, // -> missing_title
    { url: "https://sm10.example.com/down", statusCode: 500 }, // -> server_error
  ],
};

describe.skipIf(!TEST_URL)("search AI drafting (SM-10)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let D: string; // cross-tenant isolation probe
  let uA: string;
  let uD: string;
  let clientA: string;
  let propertyId: string;
  let engagementId: string;
  let keywordSetId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    config.services.knowledge = { url: "", token: "" }; // unconfigured by default -> fail-soft path
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM10 Co A", ["search"]);
    D = await createCompany("SM10 Co D", ["search"]);
    uA = await createUser("sm10-a@a.test");
    uD = await createUser("sm10-d@d.test");
    await addMembership(A, uA);
    await addMembership(D, uD);
    clientA = await createClient(A, "SM10 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm10.example.com", siteUrl: "https://sm10.example.com" },
    });
    propertyId = propRes.json().id as string;
    const engRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM10 Engagement" },
    });
    engagementId = engRes.json().id as string;

    // Seed real grounding data: a keyword + an ingested audit with findings, exactly the shape
    // draftBrief/aiTriage read from.
    const setRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "SM10 set" },
    });
    keywordSetId = setRes.json().id as string;
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${keywordSetId}/import`, headers: asUser(uA),
      payload: { text: "running shoes" },
    });
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("drafts a content brief grounded in real findings + keywords, via the gateway-client choke point only", async () => {
    completeMock.mockClear();
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties/${propertyId}/briefs`, headers: asUser(uA),
      payload: { topic: "running shoes buying guide" },
    });
    expect(res.statusCode).toBe(201);
    const brief = res.json() as { id: string; status: string; draftedVia: string; body: string; grounding: { keywordCount: number } };
    expect(brief.status).toBe("draft");
    expect(brief.draftedVia).toBe("ai");
    // Proves the grounding facts (real DB rows, not fabricated) reached the prompt handed to the
    // ONE gateway choke point (completeViaGateway) — the mock echoes back which markers it saw.
    expect(brief.body).toContain("running shoes");
    expect(brief.grounding.keywordCount).toBeGreaterThan(0);
    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(completeMock.mock.calls[0][0]).toContain("running shoes");

    const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: brief.id, topic: "running shoes buying guide", status: "draft" });

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/properties/${propertyId}/briefs`, headers: asUser(uA) });
    expect((list.json() as unknown[]).some((b) => (b as { id: string }).id === brief.id)).toBe(true);

    // Polish pass: re-drafts via a SECOND gateway call, never auto-approves.
    completeMock.mockClear();
    const polish = await app.inject({ method: "POST", url: `/api/${A}/modules/search/briefs/${brief.id}/polish`, headers: asUser(uA) });
    expect(polish.statusCode).toBe(200);
    expect(polish.json()).toMatchObject({ body: "Polished body text.", draftedVia: "ai", model: "claude-mock" });
    expect(completeMock).toHaveBeenCalledTimes(1);
    const afterPolish = await app.inject({ method: "GET", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA) });
    expect(afterPolish.json()).toMatchObject({ status: "draft", body: "Polished body text." });

    // Human edit + approve — a plain permission-gated PATCH, never something the AI picks.
    const patch = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA), payload: { status: "approved" },
    });
    expect(patch.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA) })).json()).toMatchObject({ status: "approved" });

    // Invalid status is rejected outright (never silently coerced).
    const badStatus = await app.inject({
      method: "PATCH", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA), payload: { status: "published" },
    });
    expect(badStatus.statusCode).toBe(400);

    // Cross-tenant: D cannot read/patch/polish/delete A's brief — every one is a 404, never a 403
    // that would leak existence.
    expect((await app.inject({ method: "GET", url: `/api/${D}/modules/search/briefs/${brief.id}`, headers: asUser(uD) })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: `/api/${D}/modules/search/briefs/${brief.id}`, headers: asUser(uD), payload: { topic: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/${D}/modules/search/briefs/${brief.id}/polish`, headers: asUser(uD) })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `/api/${D}/modules/search/briefs/${brief.id}`, headers: asUser(uD) })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/${D}/modules/search/properties/${propertyId}/briefs`, headers: asUser(uD), payload: { topic: "x" } })).statusCode).toBe(404);

    // Delete then confirm gone for the owning tenant too.
    const del = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA) });
    expect(del.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/${A}/modules/search/briefs/${brief.id}`, headers: asUser(uA) })).statusCode).toBe(404);
  });

  it("draftBrief without a topic is a 400; unknown property is a 404", async () => {
    expect((await app.inject({ method: "POST", url: `/api/${A}/modules/search/properties/${propertyId}/briefs`, headers: asUser(uA), payload: {} })).statusCode).toBe(400);
    expect(
      (await app.inject({
        method: "POST", url: `/api/${A}/modules/search/properties/00000000-0000-0000-0000-000000000000/briefs`,
        headers: asUser(uA), payload: { topic: "x" },
      })).statusCode,
    ).toBe(404);
  });

  it("best-effort ingests + RAG-queries WS8 knowledge when configured (fail-soft when not)", async () => {
    let ingestBody: unknown;
    let searchHeaders: Record<string, string> = {};
    const { server, base } = await new Promise<{ server: Server; base: string }>((resolve) => {
      const s = createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          if (req.method === "POST" && req.url === "/ingest") {
            ingestBody = JSON.parse(raw || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ written: (ingestBody as { chunks: string[] }).chunks.length }));
          } else if (req.method === "POST" && req.url === "/search") {
            searchHeaders = req.headers as unknown as Record<string, string>;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ hits: [{ sourceRef: "search-property:x:grounding", text: "crawled excerpt", score: 0.87 }] }));
          } else {
            res.writeHead(404);
            res.end("{}");
          }
        });
      });
      s.listen(0, "127.0.0.1", () => resolve({ server: s, base: `http://127.0.0.1:${(s.address() as AddressInfo).port}` }));
    });
    config.services.knowledge = { url: base, token: "kn-tok" };
    try {
      completeMock.mockClear();
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/properties/${propertyId}/briefs`, headers: asUser(uA),
        payload: { topic: "trail running shoes" },
      });
      expect(res.statusCode).toBe(201);
      const brief = res.json() as { grounding: { knowledgeHits: Array<{ sourceRef: string }> } };
      expect(brief.grounding.knowledgeHits).toEqual([{ sourceRef: "search-property:x:grounding", score: 0.87 }]);
      expect(ingestBody).toMatchObject({ tenantId: A, acl: [propertyId] });
      expect(searchHeaders["x-obo-provider"]).toBe("platform");
      expect(searchHeaders["x-obo-external-id"]).toBe(uA);
    } finally {
      config.services.knowledge = { url: "", token: "" };
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("AI-triages an audit's findings (draft only; never touches finding status)", async () => {
    const ingest = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "technical", source: "crawler", report: CRAWLER_REPORT_WITH_FINDINGS },
    });
    expect(ingest.statusCode).toBe(201);
    const auditId = ingest.json().id as string;

    completeMock.mockClear();
    const triage = await app.inject({ method: "POST", url: `/api/${A}/modules/search/audits/${auditId}/ai-triage`, headers: asUser(uA) });
    expect(triage.statusCode).toBe(200);
    const body = triage.json() as { aiSummary: string; fixes: Array<{ code: string; suggestion: string }>; draftedVia: string };
    expect(body.draftedVia).toBe("ai");
    expect(body.aiSummary).toContain("critical server error");
    // The hallucinated code (not a real finding on this audit) must have been dropped, never
    // written anywhere.
    expect(body.fixes.map((f) => f.code).sort()).toEqual(["missing_title", "server_error"]);
    expect(completeMock).toHaveBeenCalledTimes(1);

    const audits = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits?propertyId=${propertyId}`, headers: asUser(uA) });
    const auditRow = (audits.json() as Array<{ id: string; aiSummary: string | null }>).find((a) => a.id === auditId);
    expect(auditRow?.aiSummary).toContain("critical server error");

    const findings = await app.inject({ method: "GET", url: `/api/${A}/modules/search/audits/${auditId}/findings`, headers: asUser(uA) });
    const findingRows = findings.json() as Array<{ code: string; status: string; aiFixSuggestion: string | null }>;
    const missingTitle = findingRows.find((f) => f.code === "missing_title");
    expect(missingTitle?.aiFixSuggestion).toBe("Add a descriptive <title> tag.");
    // Triage NEVER moves the finding's own status — that stays the human-only PATCH /findings/:id.
    expect(missingTitle?.status).toBe("open");

    // Cross-tenant audit id -> 404.
    expect((await app.inject({ method: "POST", url: `/api/${D}/modules/search/audits/${auditId}/ai-triage`, headers: asUser(uD) })).statusCode).toBe(404);
  });

  it("ai-triage on an audit with zero open findings drafts a fallback, no-op summary without calling the gateway", async () => {
    const clean = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: { propertyId, kind: "cwv", source: "crawler", report: { startUrl: "https://sm10.example.com", pages: [{ url: "https://sm10.example.com/ok", statusCode: 200, title: "OK" }] } },
    });
    completeMock.mockClear();
    const triage = await app.inject({ method: "POST", url: `/api/${A}/modules/search/audits/${clean.json().id}/ai-triage`, headers: asUser(uA) });
    expect(triage.statusCode).toBe(200);
    expect(triage.json()).toMatchObject({ aiSummary: "No open findings to triage.", fixes: [], draftedVia: "fallback" });
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("drafts a report narrative (draft-only), refuses to re-draft past 'draft', and 404s cross-tenant", async () => {
    completeMock.mockClear();
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
      payload: { period: "2026-08" },
    });
    expect(res.statusCode).toBe(201);
    const report = res.json() as { id: string; status: string; narrativeMd: string; draftedVia: string };
    expect(report.status).toBe("draft");
    expect(report.draftedVia).toBe("ai");
    expect(report.narrativeMd).toContain("Strong month");
    expect(completeMock).toHaveBeenCalledTimes(1);

    const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA) });
    expect((list.json() as unknown[]).some((r) => (r as { id: string }).id === report.id)).toBe(true);

    const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/reports/${report.id}`, headers: asUser(uA) });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ id: report.id, status: "draft" });

    // Re-drafting the SAME engagement+period+kind while still 'draft' updates the same row
    // (upsert-by-natural-key), never creating a duplicate.
    const redraft = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
      payload: { period: "2026-08" },
    });
    expect(redraft.statusCode).toBe(201);
    expect(redraft.json()).toMatchObject({ id: report.id });

    // Move the report past 'draft' (SM-22's own lifecycle — simulated directly here since this
    // ticket does not build the approve endpoint) and confirm a re-draft attempt is refused rather
    // than silently rewriting an artifact under human review.
    await withTenants([A], (c) => c.query(`UPDATE search_reports SET status = 'approved' WHERE id = $1`, [report.id]), { modules: ["search"] });
    const blocked = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
      payload: { period: "2026-08" },
    });
    expect(blocked.statusCode).toBe(400);

    // Cross-tenant.
    expect((await app.inject({ method: "GET", url: `/api/${D}/modules/search/reports/${report.id}`, headers: asUser(uD) })).statusCode).toBe(404);
    expect(
      (await app.inject({
        method: "POST", url: `/api/${D}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uD), payload: { period: "2026-09" },
      })).statusCode,
    ).toBe(404);
  });

  // SM-46b (design addendum §A4.7 enumeration, QA's find) — draftReportNarrative's top-10 count must
  // be mode-filtered, proven in BOTH directions on a MIXED search_rank_snapshots table: sim mode
  // counts only simulated rows, live mode only real rows. A test asserting only one direction misses
  // the fail-open half (the same class as §4d).
  it("SM-46b: draftReportNarrative's rankTop10 metric is mode-filtered on a MIXED search_rank_snapshots table", async () => {
    const prevMode = config.search.providerMode;
    try {
      // Two extra keywords, distinct from the "running shoes" one used by other tests in this file,
      // so this test's rows are isolated regardless of run order.
      const kw = await withTenants(
        [A],
        (c) => c.query<{ id: string }>(
          `INSERT INTO search_keywords (tenant_id, set_id, keyword, locale)
           VALUES ($1,$2,'sm46b probe one','en-US'), ($1,$2,'sm46b probe two','en-US')
           RETURNING id`,
          [A, keywordSetId],
        ),
        { modules: ["search"] },
      );
      const [kw1, kw2] = kw.rows.map((r) => r.id);

      // Mixed table: 2 simulated top-10 rows (kw1, kw2) + 1 real top-10 row (kw1, different
      // engine so it doesn't collapse under DISTINCT ON) + 1 real NOT-top-10 row (kw2).
      await withTenants(
        [A],
        (c) => c.query(
          `INSERT INTO search_rank_snapshots (tenant_id, property_id, keyword_id, engine, device, position, simulated)
           VALUES
             ($1,$2,$3,'google','desktop',3,true),
             ($1,$2,$4,'google','desktop',5,true),
             ($1,$2,$3,'bing','desktop',7,false),
             ($1,$2,$4,'google','mobile',42,false)`,
          [A, propertyId, kw1, kw2],
        ),
        { modules: ["search"] },
      );

      config.search.providerMode = "simulate";
      const simRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
        payload: { period: "2026-12" },
      });
      expect(simRes.statusCode).toBe(201);
      expect((simRes.json() as { metrics: { rankTop10: number } }).metrics.rankTop10).toBe(2);

      // A fresh period so the draft-vs-redraft upsert rule doesn't interfere with the count itself.
      config.search.providerMode = "live";
      const liveRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA),
        payload: { period: "2026-12-live" },
      });
      expect(liveRes.statusCode).toBe(201);
      expect((liveRes.json() as { metrics: { rankTop10: number } }).metrics.rankTop10).toBe(1);
    } finally {
      config.search.providerMode = prevMode;
    }
  });

  it("rejects an invalid report kind and requires a period", async () => {
    expect(
      (await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA), payload: { period: "2026-08", kind: "weekly" },
      })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/reports`, headers: asUser(uA), payload: {} })).statusCode,
    ).toBe(400);
  });
});
