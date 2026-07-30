// SM-18 — SEM domain (campaigns/ad-groups/ads/negatives/change-proposals), cluster→plan generator,
// RSA + negative AI drafts, against LIVE Postgres (RLS actually exercised) + the real HTTP layer.
// Same harness as search.test.ts (SM-02) / search-keywords.test.ts (SM-09) / search-audit.test.ts
// (SM-08). Cerbos is stubbed to always-allow here too — SM-03's resource_search_campaign.yaml parity
// matrix (incl. the member-denied-launch/apply_manual/apply_negatives/set_budget/delete headline deny
// case, and read/create/update/propose_change baseline-allowed) is covered separately by
// search-cerbos.test.ts and is NOT re-derived here; this file exercises what SM-18 actually owns: the
// routes, tenant/RLS scoping, FK tenant-validation, the plan generator's provenance handling, the
// change-proposal state machine, and the AI-draft fail-soft contracts.
//
// The AI gateway is mocked at the module boundary (embedViaGateway/completeViaGateway), same
// technique and the same syntheticEmbedding helper as search-keywords.test.ts — gateway-client.test.ts
// already proves the real HTTP contract in isolation.
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

// Deterministic synthetic embedding keyed on the keyword TEXT (never Math.random) — identical
// technique to search-keywords.test.ts so two topics ("t1-kwN"/"t2-kwN") reliably cluster apart.
function syntheticEmbedding(text: string, dim = 24): number[] {
  const m = /^t(\d+)-kw(\d+)$/.exec(text);
  if (m) {
    const topic = Number(m[1]);
    const item = Number(m[2]);
    const base = Array.from({ length: dim }, (_, d) => (d === topic % dim ? 5 : Math.sin(d + topic) * 0.01));
    const wobble = Array.from({ length: dim }, (_, d) => Math.cos(item * 0.017 + d * 0.7) * 0.02);
    return base.map((b, d) => b + wobble[d]);
  }
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed += text.charCodeAt(i) * (i + 1);
  return Array.from({ length: dim }, (_, d) => Math.sin(seed + d));
}

let gatewayShouldFail = false;
let lastCompletePrompt = "";
vi.mock("./providers/gateway-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./providers/gateway-client")>();
  return {
    ...actual,
    embedViaGateway: vi.fn(async (text: string) => syntheticEmbedding(text)),
    completeViaGateway: vi.fn(async (prompt: string) => {
      lastCompletePrompt = prompt;
      if (gatewayShouldFail) throw new Error("simulated gateway outage");
      // Clustering's own label/intent request (search-keywords.test.ts's exact stand-in).
      const clusterMatch = /Keywords: ([^\n]+)/.exec(prompt);
      if (clusterMatch) {
        const first = clusterMatch[1].split(",")[0].trim();
        return { text: JSON.stringify({ label: `${first} theme`, intent: "commercial" }), provider: "hermes-mock" };
      }
      // RSA-draft prompt (sem-drafts.ts).
      if (/Responsive Search Ad/.test(prompt)) {
        return {
          text: JSON.stringify({
            headlines: ["Great Running Shoes", "Shop Now", "Best Prices Today"],
            descriptions: ["Find the perfect fit today.", "Free shipping on all orders."],
          }),
          provider: "hermes-mock",
        };
      }
      // Negatives-classification prompt (sem-drafts.ts).
      if (/NEGATIVE keyword candidates/.test(prompt)) {
        return {
          text: JSON.stringify({
            negatives: [
              { term: "free shoes", matchType: "phrase", reason: "free-seeking, not a buyer" },
              { term: "shoe repair jobs", matchType: "exact", reason: "job-seeking intent" },
              { term: "this term was never submitted", matchType: "exact", reason: "should be dropped" },
            ],
          }),
          provider: "hermes-mock",
        };
      }
      return { text: "{}", provider: "hermes-mock" };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("search-marketing SEM domain (SM-18)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let engagementId: string;
  let propertyId: string;
  let clusteredSetId: string;
  let emptySetId: string;
  let t1ClusterId: string;
  let t2ClusterId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.services.gateway = { url: "https://gateway.test", token: "gw-tok" };
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM18 Co A", ["search"]);
    C = await createCompany("SM18 Co C", ["search"]);
    uA = await createUser("sm18-a@a.test");
    uC = await createUser("sm18-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM18 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm18.example.com", siteUrl: "https://sm18.example.com" },
    });
    propertyId = propRes.json().id as string;

    const engRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM18 engagement" },
    });
    engagementId = engRes.json().id as string;

    // A clustered keyword set: two topics, four keywords each, run through the REAL import/embed/
    // cluster pipeline (mocked gateway) — same technique as search-keywords.test.ts.
    const setRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "SM18 clustered set" },
    });
    clusteredSetId = setRes.json().id as string;
    const csv = [1, 2].flatMap((topic) => Array.from({ length: 4 }, (_, i) => `t${topic}-kw${i + 1}`)).join("\n");
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${clusteredSetId}/import`, headers: asUser(uA),
      payload: { text: csv },
    });
    await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${clusteredSetId}/embed`, headers: asUser(uA),
      payload: {},
    });
    const clusterRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets/${clusteredSetId}/cluster`, headers: asUser(uA),
      payload: {},
    });
    const clusterBody = clusterRes.json() as { clusters: { clusterId: string; label: string }[] };
    expect(clusterBody.clusters.length).toBe(2); // the whole point of the two near-orthogonal topics
    const t1 = clusterBody.clusters.find((c) => c.label.startsWith("t1"));
    const t2 = clusterBody.clusters.find((c) => c.label.startsWith("t2"));
    t1ClusterId = t1!.clusterId;
    t2ClusterId = t2!.clusterId;

    // Provenance fixture (standing rule §A2/§A4.7): stamp t1's keywords with MIXED real vendor
    // provenance directly (no SM-14 writer exists yet to do this via HTTP) — half dataforseo/real,
    // half semrush/simulated — and leave t2 entirely unpulled (metrics_provider stays NULL).
    await withTenants(
      [A],
      async (c) => {
        const t1Kws = await c.query<{ id: string }>(`SELECT id FROM search_keywords WHERE cluster_id = $1 ORDER BY keyword`, [t1ClusterId]);
        for (const [i, row] of t1Kws.rows.entries()) {
          const provider = i % 2 === 0 ? "dataforseo" : "semrush";
          const simulated = i % 2 === 1;
          await c.query(
            `UPDATE search_keywords SET metrics_provider = $2, metrics_simulated = $3, volume = 100 WHERE id = $1`,
            [row.id, provider, simulated],
          );
        }
      },
      { modules: ["search"] },
    );

    // A second, never-clustered keyword set for the "no clusters yet" refusal test.
    const emptySetRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: "SM18 never-clustered set" },
    });
    emptySetId = emptySetRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ─────────────────────────────────── Malformed input -> 400, never 500, never a partial write ────
  describe("refuses malformed input with 400, never 500, never a partial write", () => {
    it("createCampaign", async () => {
      const noName = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: {} });
      expect(noName.statusCode).toBe(400);
      const badPlatform = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "x", platform: "bing_ads" } });
      expect(badPlatform.statusCode).toBe(400);
      const badStatus = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "x", status: "live" } });
      expect(badStatus.statusCode).toBe(400);
      const noCurrency = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "x", budgetMinor: 1000 } });
      expect(noCurrency.statusCode).toBe(400);
      const badBudgetType = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "x", budgetMinor: "a lot", currency: "USD" } });
      expect(badBudgetType.statusCode).toBe(400);
      // Not one campaign was created by any of the five rejected calls above.
      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA) });
      expect(list.json()).toEqual([]);
    });

    it("malformed uuid path params return 400 (assertUuid guard — a bare Postgres 22P02 would 500)", async () => {
      const r1 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/not-a-uuid`, headers: asUser(uA) });
      expect(r1.statusCode).toBe(400);
      const r2 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/ad-groups/12345`, headers: asUser(uA) });
      expect(r2.statusCode).toBe(400);
      const r3 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/not-a-uuid/campaigns`, headers: asUser(uA) });
      expect(r3.statusCode).toBe(400);
    });

    it("generateCampaignPlan: missing fields, bad keywordSetId, cross-engagement set, and an unclustered set", async () => {
      const missing = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns/generate-plan`, headers: asUser(uA), payload: {},
      });
      expect(missing.statusCode).toBe(400);

      const badId = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns/generate-plan`, headers: asUser(uA),
        payload: { keywordSetId: "not-a-uuid", name: "plan" },
      });
      expect(badId.statusCode).toBe(400);

      const notFound = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns/generate-plan`, headers: asUser(uA),
        payload: { keywordSetId: "00000000-0000-0000-0000-000000000000", name: "plan" },
      });
      expect(notFound.statusCode).toBe(400);

      const unclustered = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns/generate-plan`, headers: asUser(uA),
        payload: { keywordSetId: emptySetId, name: "plan" },
      });
      expect(unclustered.statusCode).toBe(400);
      expect(unclustered.json().error).toMatch(/no clustered keywords/);

      // No campaign was created by any rejected attempt (confirms no partial write).
      const list = await app.inject({ method: "GET", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA) });
      expect((list.json() as unknown[]).length).toBe(0);
    });

    it("createAdGroup / createAd / createNegative reject bad bodies", async () => {
      const campRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "guard campaign" },
      });
      const campaignId = campRes.json().id as string;

      const noAgName = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: {} });
      expect(noAgName.statusCode).toBe(400);
      const badClusterId = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "g", clusterId: "nope" } });
      expect(badClusterId.statusCode).toBe(400);

      const agRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "guard ad group" } });
      const adGroupId = agRes.json().id as string;

      const noAdContent = await app.inject({ method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA), payload: {} });
      expect(noAdContent.statusCode).toBe(400);
      const badAdStatus = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA),
        payload: { headlines: ["h"], descriptions: ["d"], status: "live" },
      });
      expect(badAdStatus.statusCode).toBe(400);

      const noTerm = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: {} });
      expect(noTerm.statusCode).toBe(400);
      const badMatchType = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: { term: "x", matchType: "fuzzy" } });
      expect(badMatchType.statusCode).toBe(400);
      const badAdGroupId = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: { term: "x", adGroupId: "not-a-uuid" } });
      expect(badAdGroupId.statusCode).toBe(400);

      const adsList = await app.inject({ method: "GET", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA) });
      expect(adsList.json()).toEqual([]);
      const negList = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA) });
      expect(negList.json()).toEqual([]);
    });

    it("createChangeProposal rejects bad kind/payload/mode; updateChangeProposal enforces the state machine", async () => {
      const campRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "proposal guard campaign" },
      });
      const campaignId = campRes.json().id as string;

      const badKind = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA), payload: { kind: "explode", payload: {} } });
      expect(badKind.statusCode).toBe(400);
      const noPayload = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA), payload: { kind: "pause" } });
      expect(noPayload.statusCode).toBe(400);
      const arrayPayload = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA), payload: { kind: "pause", payload: [1, 2] } });
      expect(arrayPayload.statusCode).toBe(400);
      const badMode = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA), payload: { kind: "pause", payload: {}, mode: "telepathy" } });
      expect(badMode.statusCode).toBe(400);

      const list0 = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA) });
      expect(list0.json()).toEqual([]);

      const created = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA),
        payload: { kind: "pause", payload: { reason: "seasonal" } },
      });
      const proposalId = created.json().id as string;

      // Mutation probe: attempting to set status='applied' directly must be refused — this is the
      // guard whose removal would let this ticket silently acquire a live side-effect it explicitly
      // does not have.
      const toApplied = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "applied" } });
      expect(toApplied.statusCode).toBe(400);

      const approve = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "approved" } });
      expect(approve.statusCode).toBe(200);

      // Mutation probe: payload can no longer be edited once approved (hash-match integrity).
      const editAfterApprove = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { payload: { reason: "changed my mind" } } });
      expect(editAfterApprove.statusCode).toBe(400);

      // Mutation probe: approved -> proposed is not a valid transition (only -> dismissed).
      const backToProposed = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "proposed" } });
      expect(backToProposed.statusCode).toBe(400);

      const dismiss = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "dismissed" } });
      expect(dismiss.statusCode).toBe(200);

      // Mutation probe: dismissed is terminal — no further transition is allowed.
      const afterDismiss = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "approved" } });
      expect(afterDismiss.statusCode).toBe(400);
    });

    it("proposeNegatives rejects an empty submission and an over-cap submission", async () => {
      const campRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "negatives guard campaign" },
      });
      const campaignId = campRes.json().id as string;
      const empty = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives/propose`, headers: asUser(uA), payload: {} });
      expect(empty.statusCode).toBe(400);
      const overCap = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives/propose`, headers: asUser(uA),
        payload: { terms: Array.from({ length: 201 }, (_, i) => `term-${i}`) },
      });
      expect(overCap.statusCode).toBe(400);
    });
  });

  // ─────────────────────────────────────────── Cross-tenant -> 404 ──────────────────────────────────
  describe("cross-tenant access returns 404, never a leak of existence", () => {
    let campaignIdOfA: string;
    let adGroupIdOfA: string;
    let adIdOfA: string;
    let negativeIdOfA: string;
    let proposalIdOfA: string;

    beforeAll(async () => {
      const campRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "cross-tenant campaign" },
      });
      campaignIdOfA = campRes.json().id as string;
      const agRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignIdOfA}/ad-groups`, headers: asUser(uA), payload: { name: "ct ad group" } });
      adGroupIdOfA = agRes.json().id as string;
      const adRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupIdOfA}/ads`, headers: asUser(uA), payload: { headlines: ["h"], descriptions: ["d"] } });
      adIdOfA = adRes.json().id as string;
      const negRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignIdOfA}/negatives`, headers: asUser(uA), payload: { term: "ct term" } });
      negativeIdOfA = negRes.json().id as string;
      const propRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignIdOfA}/change-proposals`, headers: asUser(uA), payload: { kind: "pause", payload: {} },
      });
      proposalIdOfA = propRes.json().id as string;
    });

    it("company C cannot read/update/delete company A's campaign", async () => {
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}`, headers: asUser(uC) })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}`, headers: asUser(uC), payload: { name: "hijacked" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}`, headers: asUser(uC) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}/ad-groups`, headers: asUser(uC) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}/negatives`, headers: asUser(uC) })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/campaigns/${campaignIdOfA}/change-proposals`, headers: asUser(uC) })).statusCode).toBe(404);
    });

    it("company C cannot reach A's ad group / ad / negative / change-proposal by id", async () => {
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/ad-groups/${adGroupIdOfA}`, headers: asUser(uC) })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/api/${C}/modules/search/ads/${adIdOfA}`, headers: asUser(uC), payload: { status: "approved" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/api/${C}/modules/search/negatives/${negativeIdOfA}`, headers: asUser(uC), payload: { status: "approved" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: `/api/${C}/modules/search/change-proposals/${proposalIdOfA}`, headers: asUser(uC) })).statusCode).toBe(404);
    });

    it("company C's own (correctly-scoped) request for A's engagement's campaigns 404s at the parent, not a silent empty list confusion", async () => {
      const res = await app.inject({ method: "GET", url: `/api/${C}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uC) });
      expect(res.statusCode).toBe(404); // the engagement itself is not C's
    });
  });

  // ───────────────────────────────────────────── Happy path ─────────────────────────────────────────
  describe("campaign/ad-group/ad/negative CRUD round-trips", () => {
    it("creates, reads, updates and deletes a campaign", async () => {
      const create = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA),
        payload: { name: "Manual campaign", platform: "google_ads", budgetMinor: 500000, currency: "USD" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().id as string;

      const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${id}`, headers: asUser(uA) });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toMatchObject({ name: "Manual campaign", status: "draft", budgetMinor: "500000", currency: "USD" });

      const patch = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/campaigns/${id}`, headers: asUser(uA), payload: { status: "proposed", objective: "leads" } });
      expect(patch.statusCode).toBe(200);
      const afterPatch = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${id}`, headers: asUser(uA) });
      expect(afterPatch.json()).toMatchObject({ status: "proposed", objective: "leads" });

      const del = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/campaigns/${id}`, headers: asUser(uA) });
      expect(del.statusCode).toBe(200);
      const afterDelete = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${id}`, headers: asUser(uA) });
      expect(afterDelete.statusCode).toBe(404);
    });

    it("ad-group and ad CRUD, and negative CRUD, round-trip under a campaign", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "roundtrip campaign" } });
      const campaignId = camp.json().id as string;

      const ag = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "Shoes" } });
      expect(ag.statusCode).toBe(201);
      const adGroupId = ag.json().id as string;
      const agGet = await app.inject({ method: "GET", url: `/api/${A}/modules/search/ad-groups/${adGroupId}`, headers: asUser(uA) });
      expect(agGet.json()).toMatchObject({ name: "Shoes", campaignId });

      const ad = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA),
        payload: { headlines: ["Buy Shoes"], descriptions: ["Great deals"] },
      });
      expect(ad.statusCode).toBe(201);
      const adId = ad.json().id as string;
      const adPatch = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/ads/${adId}`, headers: asUser(uA), payload: { status: "approved" } });
      expect(adPatch.statusCode).toBe(200);
      const adDel = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/ads/${adId}`, headers: asUser(uA) });
      expect(adDel.statusCode).toBe(200);

      const neg = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: { term: "cheap shoes", adGroupId } });
      expect(neg.statusCode).toBe(201);
      const negId = neg.json().id as string;
      const negGet = (await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA) })).json() as Array<{ id: string; term: string; source: string; status: string }>;
      expect(negGet.find((n) => n.id === negId)).toMatchObject({ term: "cheap shoes", source: "manual", status: "proposed" });
      const negPatch = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/negatives/${negId}`, headers: asUser(uA), payload: { status: "approved" } });
      expect(negPatch.statusCode).toBe(200);
      // Mutation probe: 'applied' is refused on the manual negative-status route too.
      const negToApplied = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/negatives/${negId}`, headers: asUser(uA), payload: { status: "applied" } });
      expect(negToApplied.statusCode).toBe(400);
      const negDel = await app.inject({ method: "DELETE", url: `/api/${A}/modules/search/negatives/${negId}`, headers: asUser(uA) });
      expect(negDel.statusCode).toBe(200);
    });
  });

  // ───────────────────────────────────── Cluster→plan generator + provenance ────────────────────────
  describe("generateCampaignPlan builds ad groups from clusters and carries keyword-metric provenance", () => {
    it("builds one ad group per cluster and reports provenance without blending vendors", async () => {
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns/generate-plan`, headers: asUser(uA),
        payload: { keywordSetId: clusteredSetId, name: "Generated plan", platform: "google_ads" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        id: string; adGroups: Array<{ clusterId: string; name: string; keywordCount: number; keywordSample: string[]; provenance: { providers: string[]; simulatedCount: number; realCount: number; unpulledCount: number } }>;
        totalClusteredKeywords: number; unclusteredSkipped: number;
      };
      expect(body.adGroups.length).toBe(2);
      expect(body.totalClusteredKeywords).toBe(8);
      expect(body.unclusteredSkipped).toBe(0);

      const g1 = body.adGroups.find((g) => g.clusterId === t1ClusterId)!;
      const g2 = body.adGroups.find((g) => g.clusterId === t2ClusterId)!;
      expect(g1.keywordCount).toBe(4);
      expect(g2.keywordCount).toBe(4);

      // t1: mixed real dataforseo + simulated semrush — BOTH named, never averaged into one number.
      expect(g1.provenance.providers).toEqual(["dataforseo", "semrush"]);
      expect(g1.provenance.realCount).toBe(2);
      expect(g1.provenance.simulatedCount).toBe(2);
      expect(g1.provenance.unpulledCount).toBe(0);

      // t2: entirely unpulled — absent stays absent, never coerced into 0 real / 0 simulated meaning "known".
      expect(g2.provenance.providers).toEqual([]);
      expect(g2.provenance.realCount).toBe(0);
      expect(g2.provenance.simulatedCount).toBe(0);
      expect(g2.provenance.unpulledCount).toBe(4);

      // The created ad groups actually persisted with the right cluster_id linkage.
      const adGroups = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${body.id}/ad-groups`, headers: asUser(uA) });
      const persisted = adGroups.json() as Array<{ clusterId: string }>;
      expect(persisted.map((p) => p.clusterId).sort()).toEqual([t1ClusterId, t2ClusterId].sort());

      // Mutation probe: the "search.campaign.created" event was actually emitted (via-plan-generator
      // flagged), not just implied by a 201.
      const events = await withTenants(
        [A],
        (c) => c.query<{ payload: { viaPlanGenerator?: boolean } }>(
          `SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'search.campaign.created'`,
          [body.id],
        ),
        { modules: ["search"] },
      );
      expect(events.rows.some((r) => r.payload.viaPlanGenerator === true)).toBe(true);
    });
  });

  // ───────────────────────────────────────────── AI drafts ──────────────────────────────────────────
  describe("RSA draft (ai-generated + fallback)", () => {
    it("drafts an RSA ad grounded in the ad group's cluster keywords", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "rsa campaign" } });
      const campaignId = camp.json().id as string;
      const ag = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "t1-kw1 theme", clusterId: t1ClusterId } });
      const adGroupId = ag.json().id as string;

      gatewayShouldFail = false;
      const draft = await app.inject({ method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads/draft`, headers: asUser(uA) });
      expect(draft.statusCode).toBe(201);
      const body = draft.json() as { headlines: string[]; descriptions: string[]; draftedVia: string };
      expect(body.draftedVia).toBe("ai");
      expect(body.headlines.length).toBeGreaterThanOrEqual(3);
      expect(body.descriptions.length).toBeGreaterThanOrEqual(2);
      expect(lastCompletePrompt).toContain("Responsive Search Ad");

      // A persisted, draft, ai_generated ad exists.
      const ads = (await app.inject({ method: "GET", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA) })).json() as Array<{ status: string; aiGenerated: boolean }>;
      expect(ads.some((a) => a.status === "draft" && a.aiGenerated === true)).toBe(true);
    });

    it("falls back to a deterministic draft (never a half-built ad) when the gateway is unavailable", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "rsa fallback campaign" } });
      const campaignId = camp.json().id as string;
      const ag = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "Fallback group" } });
      const adGroupId = ag.json().id as string;

      gatewayShouldFail = true;
      try {
        const draft = await app.inject({ method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads/draft`, headers: asUser(uA) });
        expect(draft.statusCode).toBe(201);
        const body = draft.json() as { headlines: string[]; descriptions: string[]; draftedVia: string };
        expect(body.draftedVia).toBe("fallback");
        expect(body.headlines.length).toBeGreaterThanOrEqual(3);
        expect(body.descriptions.length).toBeGreaterThanOrEqual(2);
      } finally {
        gatewayShouldFail = false;
      }
    });
  });

  describe("negative-keyword AI proposal", () => {
    it("proposes negatives only from the submitted terms — dropping any term the AI invented", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "negatives campaign" } });
      const campaignId = camp.json().id as string;

      gatewayShouldFail = false;
      const res = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives/propose`, headers: asUser(uA),
        payload: { text: "free shoes\nshoe repair jobs\nbest running shoes 2026" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { proposed: number; candidates: Array<{ term: string }>; draftedVia: string };
      expect(body.draftedVia).toBe("ai");
      // The mocked completion proposed 3 terms, one of which ("this term was never submitted") is
      // NOT in the submitted list — defense-in-depth must drop it.
      expect(body.candidates.map((c) => c.term).sort()).toEqual(["free shoes", "shoe repair jobs"]);
      expect(body.proposed).toBe(2);

      const persisted = (await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives?status=proposed`, headers: asUser(uA) })).json() as Array<{ term: string; source: string }>;
      expect(persisted.every((n) => n.source === "ai")).toBe(true);
      expect(persisted.map((n) => n.term).sort()).toEqual(["free shoes", "shoe repair jobs"]);
    });

    it("proposes nothing (never fabricates a judgment) when the gateway is unavailable", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "negatives fallback campaign" } });
      const campaignId = camp.json().id as string;

      gatewayShouldFail = true;
      try {
        const res = await app.inject({
          method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives/propose`, headers: asUser(uA),
          payload: { terms: ["some term"] },
        });
        expect(res.statusCode).toBe(200);
        const body = res.json() as { proposed: number; candidates: unknown[]; draftedVia: string };
        expect(body.draftedVia).toBe("fallback");
        expect(body.proposed).toBe(0);
        expect(body.candidates).toEqual([]);
      } finally {
        gatewayShouldFail = false;
      }
    });
  });

  describe("change-proposal creation emits search.campaign.proposed", () => {
    it("emits the event with the entityType/href-mapping notifications.ts expects", async () => {
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA), payload: { name: "event campaign" } });
      const campaignId = camp.json().id as string;
      const created = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA),
        payload: { kind: "budget", payload: { newBudgetMinor: 900000 }, mode: "manual" },
      });
      const proposalId = created.json().id as string;
      const events = await withTenants(
        [A],
        (c) => c.query<{ entity_type: string; payload: { campaignId?: string } }>(
          `SELECT entity_type, payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'search.campaign.proposed'`,
          [proposalId],
        ),
        { modules: ["search"] },
      );
      expect(events.rows.length).toBe(1);
      expect(events.rows[0].entity_type).toBe("search_change_proposal");
      expect(events.rows[0].payload.campaignId).toBe(campaignId);
    });
  });
});
