// SM-13 — events -> notifications wiring for the search-marketing module (design §09/§12).
// Verifies, against LIVE Postgres + Redis (same pattern as hr.test.ts's drainConsumer + this
// module's own search.test.ts cerbos-allow stub):
//  (1) the two REAL producers wired here (audit ingest -> search.audit.completed/regression;
//      providers/dispatch.ts -> search.provider.budget_threshold) flow through the REAL outbox ->
//      Redis Streams -> EventConsumerService pipeline and land a notification row with the correct
//      href for the engagement's/property's owner,
//  (2) duplicate suppression: re-processing the SAME outbox event id never creates a second row,
//  (3) tenant isolation: an event whose entityId belongs to a DIFFERENT tenant resolves no owner at
//      all (RLS makes the row invisible under the wrong tenant scope), so it can never notify a
//      user of that other tenant.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId, withTenants } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { syncMetricDefinitions, resetCoreRollupProviders } from "../../rollups/engine";
import { MockSearchProvider } from "./providers/mock-provider";
import { registerProvider, resetProviders } from "./providers/registry";
import { dispatchProviderOp } from "./providers/dispatch";
import { relayBatch } from "../../events/relay";
import { consumeOnce } from "../../events/consumer.service";
import { emitEvent } from "../../events/outbox.service";
import {
  handleBudgetThreshold,
  handleRankDropped,
  handleBudgetOverspend,
  handleReportReady,
  handleReportDelivered,
  handleCampaignProposed,
  handleAiVisibilityChanged,
  handleIncurredCost,
  handleCampaignApplied,
} from "./notifications";
import type { OutboxEvent } from "../../events/types";

const REDIS_TEST_URL = process.env.REDIS_URL_TEST ?? "";
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

async function drainConsumer(entityTypes: string[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const relayed = await relayBatch(500);
    let consumed = 0;
    for (const t of entityTypes) consumed += await consumeOnce(t);
    if (relayed === 0 && consumed === 0) return;
  }
}

async function notificationsFor(tenantId: string, userId: string, type: string) {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ payload: { href?: string; severity?: string; sourceEventId?: string } }>(
      `SELECT payload FROM notifications WHERE tenant_id = $1 AND user_id = $2 AND type = $3 ORDER BY created_at`,
      [tenantId, userId, type],
    ),
  );
  return r.rows.map((row) => row.payload);
}

vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return { ...actual, check: vi.fn(async () => ({ allow: true as const })) };
});

describe.skipIf(!TEST_URL || !REDIS_TEST_URL)("search module notifications (SM-13)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let clientC: string;
  let propertyId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM-13 Co A", ["search"]);
    C = await createCompany("SM-13 Co C", ["search"]);
    uA = await createUser("sm13-a@a.test");
    uC = await createUser("sm13-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM-13 Client A");
    clientC = await createClient(C, "SM-13 Client C");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm13.example.com", siteUrl: "https://sm13.example.com" },
    });
    expect(propRes.statusCode).toBe(201);
    propertyId = propRes.json().id as string;
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("audit ingest -> search.audit.completed lands a notification on the property's engagement owner, deep-linking to Site Audit", async () => {
    const engRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM-13 Audit Engagement", ownerId: uA },
    });
    expect(engRes.statusCode).toBe(201);

    const ingest1 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "technical", source: "crawler",
        report: { startUrl: "https://sm13.example.com", pages: [{ url: "https://sm13.example.com/a", statusCode: 500 }] },
      },
    });
    expect(ingest1.statusCode).toBe(201);
    expect(ingest1.json().idempotent).toBe(false);

    await drainConsumer(["search_audit"]);

    const notifs = await notificationsFor(A, uA, "search.audit.completed");
    expect(notifs.length).toBe(1);
    expect(notifs[0]).toMatchObject({ href: "/departments/seo/audit" });
  });

  it("a code that was fixed then reappears -> search.audit.regression, severity critical, same Site Audit href", async () => {
    // Second ingest: no error pages -> the 'server_error' code is marked fixed, no regression yet.
    const ingest2 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "technical", source: "crawler",
        report: { startUrl: "https://sm13.example.com", pages: [{ url: "https://sm13.example.com/a", statusCode: 200, title: "OK" }] },
      },
    });
    expect(ingest2.statusCode).toBe(201);
    await drainConsumer(["search_audit"]);

    // Third ingest: the same error reappears -> a genuine regression. An extra clean page is added
    // so this report's canonical content differs from ingest1's (same report_hash would otherwise
    // make this a byte-identical idempotent no-op per the UNIQUE(tenant_id,property_id,kind,
    // report_hash) constraint — that path is exercised deliberately below, not by accident here).
    const ingest3 = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "technical", source: "crawler",
        report: {
          startUrl: "https://sm13.example.com",
          pages: [
            { url: "https://sm13.example.com/a", statusCode: 500 },
            { url: "https://sm13.example.com/b", statusCode: 200, title: "Extra page" },
          ],
        },
      },
    });
    expect(ingest3.statusCode).toBe(201);
    expect(ingest3.json().idempotent).toBe(false);
    await drainConsumer(["search_audit"]);

    const notifs = await notificationsFor(A, uA, "search.audit.regression");
    expect(notifs.length).toBe(1);
    expect(notifs[0]).toMatchObject({ href: "/departments/seo/audit", severity: "critical" });

    // Re-ingesting the byte-identical 3rd report is a no-op upstream (report_hash UNIQUE) — proves
    // the upstream idempotency this handler layers duplicate-suppression ON TOP OF.
    const ingest3Again = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/audits`, headers: asUser(uA),
      payload: {
        propertyId, kind: "technical", source: "crawler",
        report: {
          startUrl: "https://sm13.example.com",
          pages: [
            { url: "https://sm13.example.com/a", statusCode: 500 },
            { url: "https://sm13.example.com/b", statusCode: 200, title: "Extra page" },
          ],
        },
      },
    });
    expect(ingest3Again.json().idempotent).toBe(true);
    await drainConsumer(["search_audit"]);
    const notifsAfterReplay = await notificationsFor(A, uA, "search.audit.regression");
    expect(notifsAfterReplay.length).toBe(1); // still exactly one — no duplicate
  });

  it("dispatch budget-warn threshold -> search.provider.budget_threshold notifies the engagement owner, deep-linking to the engagement", async () => {
    resetProviders();
    registerProvider(new MockSearchProvider());
    config.search.tenantMonthlyCapUsd = null;
    config.search.globalMonthlyCapUsd = 1_000_000;
    config.search.budgetWarnRatio = 0.8;

    const engId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8)`,
        [engId, A, clientA, propertyId, "SM-13 Budget Engagement", JSON.stringify({ backlinks: { enabled: true } }), 0.024, uA],
      ),
      { modules: ["search"] },
    );

    await dispatchProviderOp({
      tenantId: A, engagementId: engId,
      op: { kind: "backlinks", query: "sm13-warn.example.com" }, requestedBy: uA,
    });

    await drainConsumer(["search_engagement"]);

    const notifs = await notificationsFor(A, uA, "search.provider.budget_threshold");
    expect(notifs.length).toBe(1);
    expect(notifs[0]).toMatchObject({ href: `/departments/seo/engagements/${engId}`, severity: "warning" });

    resetProviders();
  });

  it("duplicate suppression: re-processing the identical OutboxEvent id never inserts a second notification", async () => {
    const engId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propertyId, "SM-13 Dedup Engagement", 10, uA],
      ),
      { modules: ["search"] },
    );
    const event: OutboxEvent = {
      id: "sm13-dedup-evt-1", tenantId: A, entityType: "search_engagement", entityId: engId,
      eventType: "search.provider.budget_threshold", payload: { level: "warn" }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    };
    await handleBudgetThreshold(event);
    await handleBudgetThreshold(event); // simulated redelivery of the SAME event id

    const notifs = await notificationsFor(A, uA, "search.provider.budget_threshold");
    // Only the one from THIS engagement should be present among uA's threshold notifications from
    // this test onward; scope by sourceEventId to be exact regardless of prior tests in the file.
    const thisEvent = notifs.filter((p) => p.sourceEventId === "sm13-dedup-evt-1");
    expect(thisEvent.length).toBe(1);
  });

  it("cross-tenant isolation: an event carrying tenantId=A but an entityId that belongs to tenant C resolves NO owner, so C's user is never notified", async () => {
    // A genuinely-C-owned property + engagement (uC is a member of C only, never of A).
    const cProp = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [cProp, C, clientC, "c-only.example.com", "https://c-only.example.com"],
      ), { modules: ["search"] });
    const cEngId = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [cEngId, C, clientC, cProp, "SM-13 C-only Engagement", 10, uC],
      ), { modules: ["search"] });

    // A hostile/mis-relayed event: tenantId says A, but entityId is C's engagement id. Under RLS,
    // `withTenants([A], …)` can NEVER see a row whose tenant_id is C — so the owner lookup returns
    // null and the handler no-ops, regardless of what the payload claims.
    const crossEvent: OutboxEvent = {
      id: "sm13-cross-tenant-evt-1", tenantId: A, entityType: "search_engagement", entityId: cEngId,
      eventType: "search.provider.budget_threshold", payload: { level: "blocked" }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    };
    await handleBudgetThreshold(crossEvent);

    const cNotifs = await notificationsFor(C, uC, "search.provider.budget_threshold");
    expect(cNotifs.every((p) => p.sourceEventId !== "sm13-cross-tenant-evt-1")).toBe(true);
    const aSideAttempt = await withTenants([A], (c) =>
      c.query(`SELECT 1 FROM notifications WHERE payload->>'sourceEventId' = 'sm13-cross-tenant-evt-1'`),
    );
    expect(aSideAttempt.rows.length).toBe(0);
  });

  // QA gate (2026-07-30): the ledger's SM-13 record claims "nine §09 event types mapped to
  // deep-link hrefs" but the ticket's own suite above only ever drives 3 of them
  // (audit.completed, audit.regression, provider.budget_threshold) through a producer. The other
  // six "forward-looking" handlers had ZERO test coverage — not even a direct unit call — so
  // their href/owner-resolution correctness was an unverified claim. Exercised directly here
  // (same technique the ticket's own dedup/cross-tenant tests already use for
  // handleBudgetThreshold: call the exported handler with a hand-built OutboxEvent).
  it("QA: the six forward-looking handlers resolve the correct owner + href, and no-op (never throw) on a payload missing its required id", async () => {
    const engId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propertyId, "SM-13 QA forward-looking engagement", 10, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-13 QA campaign"],
      ),
      { modules: ["search"] },
    );

    await handleRankDropped({
      id: "qa-rank-1", tenantId: A, entityType: "search_property", entityId: propertyId,
      eventType: "search.rank.dropped", payload: { propertyId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const rankNotifs = await notificationsFor(A, uA, "search.rank.dropped");
    expect(rankNotifs.some((p) => p.sourceEventId === "qa-rank-1" && p.href === "/departments/seo/rankings")).toBe(true);

    await handleBudgetOverspend({
      id: "qa-overspend-1", tenantId: A, entityType: "search_engagement", entityId: engId,
      eventType: "search.budget.overspend", payload: { engagementId: engId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const overspendNotifs = await notificationsFor(A, uA, "search.budget.overspend");
    expect(overspendNotifs.some((p) => p.sourceEventId === "qa-overspend-1" && p.href === "/departments/seo/pacing")).toBe(true);

    await handleReportReady({
      id: "qa-report-ready-1", tenantId: A, entityType: "search_report", entityId: newId(),
      eventType: "search.report.ready_for_review", payload: { engagementId: engId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const reportReadyNotifs = await notificationsFor(A, uA, "search.report.ready_for_review");
    expect(reportReadyNotifs.some((p) => p.sourceEventId === "qa-report-ready-1" && p.href === "/departments/seo/reports")).toBe(true);

    await handleReportDelivered({
      id: "qa-report-delivered-1", tenantId: A, entityType: "search_report", entityId: newId(),
      eventType: "search.report.delivered", payload: { engagementId: engId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const reportDeliveredNotifs = await notificationsFor(A, uA, "search.report.delivered");
    expect(reportDeliveredNotifs.some((p) => p.sourceEventId === "qa-report-delivered-1" && p.href === "/departments/seo/reports")).toBe(true);

    // campaign.proposed -> campaign's OWN engagement's owner (via the campaign join, not a
    // caller-supplied engagementId) -> /ads
    await handleCampaignProposed({
      id: "qa-campaign-1", tenantId: A, entityType: "search_change_proposal", entityId: newId(),
      eventType: "search.campaign.proposed", payload: { campaignId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const campaignNotifs = await notificationsFor(A, uA, "search.campaign.proposed");
    expect(campaignNotifs.some((p) => p.sourceEventId === "qa-campaign-1" && p.href === "/departments/seo/ads")).toBe(true);

    await handleAiVisibilityChanged({
      id: "qa-aivis-1", tenantId: A, entityType: "search_property", entityId: propertyId,
      eventType: "search.ai_visibility.changed", payload: { propertyId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const aiVisNotifs = await notificationsFor(A, uA, "search.ai_visibility.changed");
    expect(aiVisNotifs.some((p) => p.sourceEventId === "qa-aivis-1" && p.href === "/departments/seo/ai-visibility")).toBe(true);

    // Malformed payloads (missing the id each handler needs to resolve an owner/campaign) must
    // no-op silently — never throw, never fabricate a notification with a wrong/absent link.
    await expect(handleRankDropped({
      id: "qa-rank-bad", tenantId: A, entityType: "search_property", entityId: propertyId,
      eventType: "search.rank.dropped", payload: {}, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    })).resolves.toBeUndefined();
    await expect(handleReportReady({
      id: "qa-report-bad", tenantId: A, entityType: "search_report", entityId: newId(),
      eventType: "search.report.ready_for_review", payload: {}, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    })).resolves.toBeUndefined();
    await expect(handleCampaignProposed({
      id: "qa-campaign-bad", tenantId: A, entityType: "search_change_proposal", entityId: newId(),
      eventType: "search.campaign.proposed", payload: {}, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    })).resolves.toBeUndefined();
    await expect(handleAiVisibilityChanged({
      id: "qa-aivis-bad", tenantId: A, entityType: "search_property", entityId: propertyId,
      eventType: "search.ai_visibility.changed", payload: {}, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    })).resolves.toBeUndefined();
    const bogusNotifs = await notificationsFor(A, uA, "search.report.ready_for_review");
    expect(bogusNotifs.some((p) => p.sourceEventId === "qa-report-bad")).toBe(false);
  });

  // A campaign.proposed event whose campaignId belongs to tenant C must not leak a notification to
  // A's owner, even though A is the caller-asserted tenantId — the campaignEngagementOwner lookup
  // is RLS-scoped to [tenantId] exactly like propertyOwners/engagementOwner, so a cross-tenant
  // campaignId resolves null under the wrong tenant.
  it("QA: campaign.proposed cross-tenant campaignId resolves no owner (RLS-scoped join, not a caller-trusted id)", async () => {
    const cProp2 = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [cProp2, C, clientC, "c-campaign.example.com", "https://c-campaign.example.com"],
      ), { modules: ["search"] });
    const cCampaignEngId = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [cCampaignEngId, C, clientC, cProp2, "SM-13 QA C campaign engagement", 10, uC],
      ), { modules: ["search"] });
    const cCampaignId = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [cCampaignId, C, cCampaignEngId, "SM-13 QA C-only campaign"],
      ), { modules: ["search"] });

    await handleCampaignProposed({
      id: "qa-cross-campaign-1", tenantId: A, entityType: "search_change_proposal", entityId: newId(),
      eventType: "search.campaign.proposed", payload: { campaignId: cCampaignId }, originSite: "central",
      schemaVersion: 1, createdAt: new Date().toISOString(),
    });
    const cNotifs = await notificationsFor(C, uC, "search.campaign.proposed");
    expect(cNotifs.every((p) => p.sourceEventId !== "qa-cross-campaign-1")).toBe(true);
    const anyRow = await withTenants([A], (c) =>
      c.query(`SELECT 1 FROM notifications WHERE payload->>'sourceEventId' = 'qa-cross-campaign-1'`),
    );
    expect(anyRow.rows.length).toBe(0);
  });

  // ── SM-50 (addendum §A11.2 #11) — the incurred-cost bell ─────────────────────────────────────────
  // "Repeated incurred failures must reach a human, not only the sums." The producer (the compensating
  // write in providers/dispatch.ts) is proven in providers/incurred-cost.test.ts; this is the CONSUMER
  // half: owner resolution, href, dedupe, cross-tenant isolation, and the TEXT-SAFETY rule.
  it("SM-50: search.provider.incurred_cost notifies the engagement owner, and never renders the money figure", async () => {
    const engId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propertyId, "SM-50 incurred-cost engagement", 10, uA],
      ),
      { modules: ["search"] },
    );

    const event: OutboxEvent = {
      id: "sm50-incurred-1", tenantId: A, entityType: "search_engagement", entityId: engId,
      eventType: "search.provider.incurred_cost",
      payload: {
        ledgerId: newId(), provider: "dataforseo", endpoint: "dataforseo.serp",
        costUsd: 0.0006, vendorRef: "task-abc", items: 1, correlationId: null, simulated: false,
      },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    };
    await handleIncurredCost(event);

    const notifs = await notificationsFor(A, uA, "search.provider.incurred_cost");
    const mine = notifs.filter((p) => p.sourceEventId === "sm50-incurred-1");
    expect(mine).toHaveLength(1);
    // Deep-links to the engagement, where SM-17's cost surface lives. Deliberately NOT a `/ledger`
    // route: the uiManifest has no such tab, and SM-13's rule is that a wrong-but-plausible href is
    // worse than a broad-but-correct one.
    expect(mine[0].href).toBe(`/departments/seo/engagements/${engId}`);
    // Real money with nothing to show for it, and the repeat case is a burn in progress.
    expect(mine[0].severity).toBe("critical");

    // TEXT SAFETY (SM-13's binding rule, and this event is where it bites hardest): the payload carries
    // costUsd, and no dollar figure may appear in the prose a human reads. Provider spend is
    // standard-rate accounting, not cash (§A3), and a bell line quoting a number is the first place
    // someone would read it as cash. The money belongs on the ledger surface the href points at.
    // Title/body live INSIDE the notifications payload (that table carries no title/body columns —
    // checked against the DDL, not against a TS interface, per §4i discipline).
    const text = await withTenants([A], (c) =>
      c.query<{ title: string | null; body: string | null }>(
        `SELECT payload->>'title' AS title, payload->>'body' AS body
           FROM notifications WHERE payload->>'sourceEventId' = 'sm50-incurred-1'`,
      ),
    );
    expect(text.rows).toHaveLength(1);
    const prose = `${text.rows[0].title ?? ""} ${text.rows[0].body ?? ""}`;
    // The load-bearing assertion: NO money figure in the prose. A notification body cannot carry the
    // simulated/real provenance badge the ledger surfaces attach to a figure, so a bare amount here
    // would be an unlabelled money claim (SM-50 probe P8 pins this).
    expect(prose).not.toMatch(/\$|0\.0006|\d+\.\d{2,}/);
    // SM-60 widened the wording from "…returned no data" to "…produced no usable data", because
    // `incurred` gained a second cause: the vendor charged AND delivered, but our own post-success
    // write failed and the rollback discarded the payload. "no data" became literally false for that
    // case, and a notification that misstates the cause sends an operator to the vendor's console
    // hunting a fault that is on our side.
    //
    // Asserting the two facts an operator must act on — a CHARGE happened, and nothing USABLE was
    // kept — rather than one brittle phrase. The previous `/no data/i` pinned wording that had to
    // change, which is why it failed here rather than catching a defect: a copy assertion should
    // pin the CLAIM, not the sentence, or it turns every honest rewording into a red build.
    expect(prose).toMatch(/charge/i);
    expect(prose).toMatch(/no usable data|no data/i);

    // Dedupe on the outbox event id, exactly like every other handler here: a Redis redelivery whose
    // earlier attempt threw after notify() succeeded must not double-notify.
    await handleIncurredCost(event);
    const after = (await notificationsFor(A, uA, "search.provider.incurred_cost"))
      .filter((p) => p.sourceEventId === "sm50-incurred-1");
    expect(after).toHaveLength(1);
  });

  it("SM-50: an incurred_cost event whose engagementId belongs to another tenant notifies nobody", async () => {
    // A cost event is engagement-scoped, and engagementOwner is RLS-scoped to [tenantId] — so an
    // entityId from tenant C, presented under tenantId A, resolves no owner at all.
    const cProp3 = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [cProp3, C, clientC, "c-incurred.example.com", "https://c-incurred.example.com"],
      ), { modules: ["search"] });
    const cEng = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [cEng, C, clientC, cProp3, "SM-50 C-only engagement", 10, uC],
      ), { modules: ["search"] });

    await handleIncurredCost({
      id: "sm50-cross-1", tenantId: A, entityType: "search_engagement", entityId: cEng,
      eventType: "search.provider.incurred_cost",
      payload: { provider: "dataforseo", costUsd: 0.0006, vendorRef: "task-x" },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const anyRow = await withTenants([A], (c) =>
      c.query(`SELECT 1 FROM notifications WHERE payload->>'sourceEventId' = 'sm50-cross-1'`),
    );
    expect(anyRow.rows.length).toBe(0);
    const cRows = await notificationsFor(C, uC, "search.provider.incurred_cost");
    expect(cRows.every((p) => p.sourceEventId !== "sm50-cross-1")).toBe(true);
  });

  // ── SM-73: search.campaign.applied notification mapping ─────────────────────────────────────────
  // All four terminal outcomes (applied, partial, failed, indeterminate) emitted by SM-21's
  // reconcileExecution, wired here with status-distinct copy per the ruling. Text safety rule:
  // simulated must be unmissable, and indeterminate must be clearly distinguished from failed.
  it("SM-73: search.campaign.applied 'applied' outcome notifies the campaign's engagement owner with simulation mark", async () => {
    const engId = newId();
    const propId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propId, A, clientA, "sm73-applied.example.com", "https://sm73-applied.example.com"],
      ),
      { modules: ["search"] },
    );
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propId, "SM-73 applied test", 100, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-73 test campaign"],
      ),
      { modules: ["search"] },
    );

    const proposalId = newId();
    await handleCampaignApplied({
      id: "sm73-applied-1", tenantId: A, entityType: "search_change_proposal", entityId: proposalId,
      eventType: "search.campaign.applied", payload: { campaignId, status: "applied", simulated: true },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const notifs = await notificationsFor(A, uA, "search.campaign.applied");
    const mine = notifs.filter((p) => p.sourceEventId === "sm73-applied-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].href).toBe("/departments/seo/ads");
    expect(mine[0].severity).toBe("info");
    const text = await withTenants([A], (c) =>
      c.query<{ title: string | null; body: string | null }>(
        `SELECT payload->>'title' AS title, payload->>'body' AS body
           FROM notifications WHERE payload->>'sourceEventId' = 'sm73-applied-1'`,
      ),
    );
    expect(text.rows[0].title).toMatch(/simulation mode/i);
    expect(text.rows[0].body).toMatch(/test/i);
  });

  it("SM-73: search.campaign.applied 'partial' outcome signals some success and some failure", async () => {
    const engId = newId();
    const propId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propId, A, clientA, "sm73-partial.example.com", "https://sm73-partial.example.com"],
      ),
      { modules: ["search"] },
    );
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propId, "SM-73 partial test", 100, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-73 partial campaign"],
      ),
      { modules: ["search"] },
    );

    const proposalId = newId();
    await handleCampaignApplied({
      id: "sm73-partial-1", tenantId: A, entityType: "search_change_proposal", entityId: proposalId,
      eventType: "search.campaign.applied", payload: { campaignId, status: "partial", simulated: true },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const notifs = await notificationsFor(A, uA, "search.campaign.applied");
    const mine = notifs.filter((p) => p.sourceEventId === "sm73-partial-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].severity).toBe("warning");
    const text = await withTenants([A], (c) =>
      c.query<{ title: string | null; body: string | null }>(
        `SELECT payload->>'title' AS title, payload->>'body' AS body
           FROM notifications WHERE payload->>'sourceEventId' = 'sm73-partial-1'`,
      ),
    );
    expect(text.rows[0].title).toMatch(/some.*applied/i);
    expect(text.rows[0].body).toMatch(/succeeded.*failed|failed.*succeeded/i);
  });

  it("SM-73: search.campaign.applied 'failed' outcome signals nothing applied", async () => {
    const engId = newId();
    const propId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propId, A, clientA, "sm73-failed.example.com", "https://sm73-failed.example.com"],
      ),
      { modules: ["search"] },
    );
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propId, "SM-73 failed test", 100, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-73 failed campaign"],
      ),
      { modules: ["search"] },
    );

    const proposalId = newId();
    await handleCampaignApplied({
      id: "sm73-failed-1", tenantId: A, entityType: "search_change_proposal", entityId: proposalId,
      eventType: "search.campaign.applied", payload: { campaignId, status: "failed", simulated: false },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const notifs = await notificationsFor(A, uA, "search.campaign.applied");
    const mine = notifs.filter((p) => p.sourceEventId === "sm73-failed-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].severity).toBe("critical");
    const text = await withTenants([A], (c) =>
      c.query<{ title: string | null; body: string | null }>(
        `SELECT payload->>'title' AS title, payload->>'body' AS body
           FROM notifications WHERE payload->>'sourceEventId' = 'sm73-failed-1'`,
      ),
    );
    expect(text.rows[0].title).toMatch(/failed/i);
    expect(text.rows[0].title).not.toMatch(/simulation/i);
  });

  it("SM-73: search.campaign.applied 'indeterminate' outcome signals outcome unclear (distinct from failed)", async () => {
    const engId = newId();
    const propId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propId, A, clientA, "sm73-indeterminate.example.com", "https://sm73-indeterminate.example.com"],
      ),
      { modules: ["search"] },
    );
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propId, "SM-73 indeterminate test", 100, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-73 indeterminate campaign"],
      ),
      { modules: ["search"] },
    );

    const proposalId = newId();
    await handleCampaignApplied({
      id: "sm73-indeterminate-1", tenantId: A, entityType: "search_change_proposal", entityId: proposalId,
      eventType: "search.campaign.applied", payload: { campaignId, status: "indeterminate", simulated: false },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const notifs = await notificationsFor(A, uA, "search.campaign.applied");
    const mine = notifs.filter((p) => p.sourceEventId === "sm73-indeterminate-1");
    expect(mine).toHaveLength(1);
    expect(mine[0].severity).toBe("critical");
    const text = await withTenants([A], (c) =>
      c.query<{ title: string | null; body: string | null }>(
        `SELECT payload->>'title' AS title, payload->>'body' AS body
           FROM notifications WHERE payload->>'sourceEventId' = 'sm73-indeterminate-1'`,
      ),
    );
    // indeterminate must be clearly distinguished from failed — it's about uncertainty, not refusal
    expect(text.rows[0].title).toMatch(/unclear|cannot determine/i);
    expect(text.rows[0].body).toMatch(/account|may exist/i);
  });

  it("SM-73: cross-tenant isolation: campaign.applied with campaignId from another tenant notifies nobody", async () => {
    const cProp = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [cProp, C, clientC, "c-campaign-applied.example.com", "https://c-campaign-applied.example.com"],
      ), { modules: ["search"] });
    const cEngId = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [cEngId, C, clientC, cProp, "SM-73 C-only engagement", 100, uC],
      ), { modules: ["search"] });
    const cCampaignId = newId();
    await withTenants([C], (c) =>
      c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [cCampaignId, C, cEngId, "SM-73 C-only campaign"],
      ), { modules: ["search"] });

    // Cross-tenant event: tenantId=A but campaignId belongs to C. campaignEngagementOwner is RLS-scoped,
    // so it resolves no owner under the wrong tenant.
    await handleCampaignApplied({
      id: "sm73-cross-1", tenantId: A, entityType: "search_change_proposal", entityId: newId(),
      eventType: "search.campaign.applied", payload: { campaignId: cCampaignId, status: "applied", simulated: true },
      originSite: "central", schemaVersion: 1, createdAt: new Date().toISOString(),
    });

    const cNotifs = await notificationsFor(C, uC, "search.campaign.applied");
    expect(cNotifs.every((p) => p.sourceEventId !== "sm73-cross-1")).toBe(true);
    const anyRow = await withTenants([A], (c) =>
      c.query(`SELECT 1 FROM notifications WHERE payload->>'sourceEventId' = 'sm73-cross-1'`),
    );
    expect(anyRow.rows.length).toBe(0);
  });

  // ── SM-24 QA gate: prove the actual wire, not the handler in isolation ─────────────────────────
  // Every SM-73 test above calls handleCampaignApplied() directly — none of them exercise the real
  // outbox -> Redis Streams -> EventConsumerService path. That path is exactly what the orchestrator's
  // main.ts fix (adding "search_change_proposal" to startConsumerLoop's entityTypes) claims to have
  // repaired, after finding the handler registered but the stream unlisted (so nothing would ever have
  // read it). This test emits a REAL outbox row via emitEvent (the only write path into outbox_events,
  // same call shape as search.controller.ts's applyProposalApi), relays it onto the real Redis stream via
  // relayBatch, and drains it through consumeOnce("search_change_proposal") — the same entity type string
  // main.ts now passes to startConsumerLoop. If that string were still missing (the pre-fix state), or if
  // it were misspelled, or if the handler weren't registered in searchModule.eventHandlers under the exact
  // event_type string emitEvent wrote, this test would time out with zero notifications rather than pass
  // for an unrelated reason — it does not call handleCampaignApplied anywhere in its own body.
  it("SM-24 gate: search.campaign.applied delivers a notification through the REAL outbox -> Redis -> consumer pipeline, not via a direct handler call", async () => {
    const engId = newId();
    const propId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url) VALUES ($1,$2,$3,$4,$5)`,
        [propId, A, clientA, "sm24-gate-wiring.example.com", "https://sm24-gate-wiring.example.com"],
      ),
      { modules: ["search"] },
    );
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_engagements (id, tenant_id, client_id, property_id, name, tool_scope, provider_budget_usd, status, owner_id)
         VALUES ($1,$2,$3,$4,$5,'{}',$6,'active',$7)`,
        [engId, A, clientA, propId, "SM-24 gate wiring test", 100, uA],
      ),
      { modules: ["search"] },
    );
    const campaignId = newId();
    await withTenants(
      [A],
      (c) => c.query(
        `INSERT INTO search_campaigns (id, tenant_id, engagement_id, platform, name, status)
         VALUES ($1,$2,$3,'google_ads',$4,'proposed')`,
        [campaignId, A, engId, "SM-24 gate wiring campaign"],
      ),
      { modules: ["search"] },
    );

    const proposalId = newId();
    let outboxId = "";
    await withTenants(
      [A],
      (c) => (async () => {
        outboxId = await emitEvent(c, A, "search_change_proposal", proposalId, "search.campaign.applied", {
          campaignId, status: "applied", simulated: true,
        });
      })(),
      { modules: ["search"] },
    );

    // Real relay + real consumer, exactly the entityType string main.ts now lists.
    await drainConsumer(["search_change_proposal"]);

    const notifs = await notificationsFor(A, uA, "search.campaign.applied");
    const mine = notifs.filter((p) => p.sourceEventId === outboxId);
    expect(mine).toHaveLength(1);
    expect(mine[0].href).toBe("/departments/seo/ads");
  });
});
