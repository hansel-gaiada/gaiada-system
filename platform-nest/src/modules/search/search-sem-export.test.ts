// SM-30 — controller e2e for the manual-apply/export twin, against LIVE Postgres (RLS actually
// exercised) + the real HTTP layer. Same harness technique as search-sem.test.ts (SM-18) / files.test.ts
// (in-memory storage backend, never touches disk). Cerbos's `check` is mocked but its CALL ARGUMENTS
// are captured — unlike search-sem.test.ts's blanket always-allow stub, this file asserts the exact
// ACTION STRING each route sends Cerbos, because the ticket's hazard #1 ("open exactly one door, make
// it narrow") is a claim about WHICH action gates WHICH route, not just about the HTTP outcome that a
// permissive stub would identically produce either way.
//
// This file does NOT re-derive SM-03's resource_search_campaign.yaml parity matrix (search-cerbos.
// test.ts owns that, and its policy already lists `apply_manual` as module_manager/company_admin/
// group_executive-only, unchanged by this ticket) — it proves that THIS controller calls Cerbos with
// `apply_manual` for mark-applied and `update` for export, and that a DENY on `apply_manual` blocks
// mark-applied exactly as a live policy deny would.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { setStorageForTest } from "../../core/storage";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
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

describe.skipIf(!TEST_URL)("search-marketing manual-apply/export twin (SM-30)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let engagementId: string;
  let propertyId: string;

  /** Direct-SQL keyword+ad-group fixture (bypasses the import/embed/cluster HTTP pipeline entirely —
   *  that pipeline is SM-09's own tested surface; this ticket only needs SOME cluster_id-linked
   *  keyword rows with a controlled provenance mix to prove the export's honesty channels). */
  async function makeClusteredAdGroup(
    campaignId: string, name: string, keywordFacts: { keyword: string; provider: string | null; simulated: boolean }[],
  ): Promise<{ adGroupId: string; clusterId: string }> {
    const setRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/keyword-sets`, headers: asUser(uA),
      payload: { engagementId, name: `set for ${name}` },
    });
    const setId = setRes.json().id as string;
    const clusterId = newId();
    await withTenants(
      [A],
      async (c) => {
        for (const kw of keywordFacts) {
          await c.query(
            `INSERT INTO search_keywords (id, tenant_id, set_id, keyword, cluster_id, metrics_provider, metrics_simulated, origin_site)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [newId(), A, setId, kw.keyword, clusterId, kw.provider, kw.simulated, config.originSite],
          );
        }
      },
      { modules: ["search"] },
    );
    const agRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA),
      payload: { name, clusterId },
    });
    return { adGroupId: agRes.json().id as string, clusterId };
  }

  async function newCampaign(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements/${engagementId}/campaigns`, headers: asUser(uA),
      payload: { name, ...extra },
    });
    return res.json().id as string;
  }

  async function newProposal(campaignId: string, kind: string, payload: Record<string, unknown> = {}, mode = "manual"): Promise<string> {
    const res = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/change-proposals`, headers: asUser(uA),
      payload: { kind, payload, mode },
    });
    return res.json().id as string;
  }

  async function approve(proposalId: string): Promise<void> {
    const r = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "approved" } });
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

    A = await createCompany("SM30 Co A", ["search"]);
    C = await createCompany("SM30 Co C", ["search"]);
    uA = await createUser("sm30-a@a.test");
    uC = await createUser("sm30-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM30 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/properties`, headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm30.example.com", siteUrl: "https://sm30.example.com" },
    });
    propertyId = propRes.json().id as string;
    const engRes = await app.inject({
      method: "POST", url: `/api/${A}/modules/search/engagements`, headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM30 engagement" },
    });
    engagementId = engRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => { capturedActions.length = 0; denyAction = null; });

  // ─────────────────────────────────────────── index.ts wiring ────────────────────────────────────
  it("index.ts's search.exportProposal MCP tool has a real method/pathTemplate binding, not a stub", () => {
    const tool = searchModule.mcpTools?.find((t) => t.name === "search.exportProposal");
    expect(tool).toBeDefined();
    expect(tool?.method).toBe("POST");
    expect(tool?.pathTemplate).toBe("/api/:tenantId/modules/search/change-proposals/:proposalId/export");
    // Mark-applied is deliberately NOT an MCP tool (a human attestation, never automatable) — the
    // module's tool list has no search.markApplied/search.markProposalApplied entry of any name.
    expect(searchModule.mcpTools?.some((t) => /markApplied|applyManual/i.test(t.name))).toBe(false);
  });

  // ─────────────────────────────────────────────── export: guard rails ────────────────────────────
  describe("export guard rails", () => {
    it("404s on a nonexistent proposal", async () => {
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/00000000-0000-0000-0000-000000000000/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(404);
    });

    it("400s exporting a 'proposed' (not yet approved) proposal", async () => {
      const campaignId = await newCampaign("guard-proposed");
      const proposalId = await newProposal(campaignId, "pause");
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/approved/);
    });

    it("400s exporting a mode='api' proposal (manual export is not its path)", async () => {
      const campaignId = await newCampaign("guard-api-mode");
      const proposalId = await newProposal(campaignId, "pause", {}, "api");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/mode='api'/);
    });

    it("company C cannot export company A's proposal (404, not a data leak)", async () => {
      const campaignId = await newCampaign("guard-cross-tenant");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${C}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uC) });
      expect(r.statusCode).toBe(404);
    });

    it("uses Cerbos action 'update' for export — the baseline tier, not the elevated apply_manual gate", async () => {
      const campaignId = await newCampaign("guard-action-name");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      expect(capturedActions).toContain("update");
      expect(capturedActions).not.toContain("apply_manual");
    });
  });

  // ────────────────────────────────────────── pause / budget / bid exports ────────────────────────
  describe("pause/budget/bid exports (no provenance claim — not data-informed)", () => {
    it("pause: always exportable, no payload needed", async () => {
      const campaignId = await newCampaign("pause-campaign");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { fileId: string; filename: string; provenance: unknown };
      expect(body.filename).toMatch(/^sem-pause-.*\.csv$/);
      expect(body.provenance).toBeNull();
      const bytes = mem.get(`${A}/sem-exports/${body.fileId}`);
      expect(bytes?.toString("utf8")).toBe("Campaign,Campaign status\r\npause-campaign,Paused\r\n");
    });

    it("budget: falls back to the campaign's own budget/currency when payload omits them", async () => {
      const campaignId = await newCampaign("budget-campaign", { budgetMinor: 500000, currency: "USD" });
      const proposalId = await newProposal(campaignId, "budget"); // empty payload
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const bytes = mem.get(`${A}/sem-exports/${r.json().fileId}`);
      expect(bytes?.toString("utf8")).toContain("5000.00");
    });

    it("budget: payload overrides the campaign's stored value when present", async () => {
      const campaignId = await newCampaign("budget-override-campaign", { budgetMinor: 500000, currency: "USD" });
      const proposalId = await newProposal(campaignId, "budget", { budgetMinor: 999900, currency: "USD" });
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      const bytes = mem.get(`${A}/sem-exports/${r.json().fileId}`);
      expect(bytes?.toString("utf8")).toContain("9999.00");
      expect(bytes?.toString("utf8")).not.toContain("5000.00");
    });

    it("budget: 400s when neither the campaign nor the payload has a budget", async () => {
      const campaignId = await newCampaign("budget-missing-campaign");
      const proposalId = await newProposal(campaignId, "budget");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
    });

    it("bid: exports whichever of bidStrategy/targetCpaMinor/targetRoas is set, blanks the rest", async () => {
      const campaignId = await newCampaign("bid-campaign");
      const proposalId = await newProposal(campaignId, "bid", { bidStrategy: "target_cpa", targetCpaMinor: 150000 });
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const csv = mem.get(`${A}/sem-exports/${r.json().fileId}`)!.toString("utf8");
      expect(csv).toContain("bid-campaign,target_cpa,1500.00,");
    });
  });

  // ───────────────────────────────────────────── launch export + provenance ───────────────────────
  describe("launch export — the data-informed kind (provenance must be honest, three channels)", () => {
    it("exports Ads Editor Keywords-shape CSV, provenance response, filename marker, and per-row Notes", async () => {
      const campaignId = await newCampaign("launch-campaign");
      const { adGroupId } = await makeClusteredAdGroup(campaignId, "Shoes", [
        { keyword: "running shoes", provider: "dataforseo", simulated: false },
        { keyword: "trail shoes", provider: "semrush", simulated: true },
        { keyword: "hiking boots", provider: null, simulated: false },
      ]);
      expect(adGroupId).toBeTruthy();
      const proposalId = await newProposal(campaignId, "launch");
      await approve(proposalId);

      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const body = r.json() as { fileId: string; filename: string; provenance: { providers: string[]; simulatedCount: number; realCount: number; unpulledCount: number } };

      // Channel 1: API response.
      expect(body.provenance).toEqual({ providers: ["dataforseo", "semrush"], simulatedCount: 1, realCount: 1, unpulledCount: 1 });
      // Channel 2: filename.
      expect(body.filename).toMatch(/-SIMULATED\.csv$/);
      // Channel 3: per-row Notes column, and the real header row is never shifted by a comment line.
      const csv = mem.get(`${A}/sem-exports/${body.fileId}`)!.toString("utf8");
      expect(csv.startsWith("Campaign,Ad group,Keyword,Criterion Type,Notes\r\n")).toBe(true);
      expect(csv).toContain("running shoes,Broad,verified market data");
      expect(csv).toContain("trail shoes,Broad,SIMULATED");
      expect(csv).toContain("hiking boots,Broad,not yet pulled");

      // export_file_id is actually linked on the proposal row.
      const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA) });
      expect(get.json().exportFileId).toBe(body.fileId);
    });

    it("400s when the campaign has no clustered ad group yet — never emits an empty 'successful' CSV", async () => {
      const campaignId = await newCampaign("launch-empty-campaign");
      const proposalId = await newProposal(campaignId, "launch");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
    });

    it("re-exporting is harmless — an 'applied' proposal can still be re-downloaded", async () => {
      const campaignId = await newCampaign("relaunch-campaign");
      await makeClusteredAdGroup(campaignId, "Boots", [{ keyword: "snow boots", provider: "dataforseo", simulated: false }]);
      const proposalId = await newProposal(campaignId, "launch");
      await approve(proposalId);
      const first = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(first.statusCode).toBe(201);
      const applyRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(applyRes.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(second.statusCode).toBe(201); // still exportable post-'applied', per the ticket's own idempotency note
    });
  });

  // ─────────────────────────────────────────── negatives_batch / ads_batch cascade ────────────────
  describe("negatives_batch and ads_batch — payload.ids contract + status cascade on mark-applied", () => {
    it("negatives_batch: exports Campaign-negative vs ad-group-negative rows correctly, cascades to status='applied'", async () => {
      const campaignId = await newCampaign("negatives-campaign");
      const agRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "NegGroup" } });
      const adGroupId = agRes.json().id as string;
      const camp = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: { term: "free stuff", matchType: "phrase" } });
      const adg = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA), payload: { term: "job openings", matchType: "exact", adGroupId } });
      const campNegId = camp.json().id as string;
      const adgNegId = adg.json().id as string;

      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [campNegId, adgNegId] });
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const csv = mem.get(`${A}/sem-exports/${r.json().fileId}`)!.toString("utf8");
      expect(csv).toContain("free stuff,Campaign Negative Phrase");
      expect(csv).toContain("job openings,Negative Exact");

      const apply = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(apply.statusCode).toBe(200);
      const negatives = await app.inject({ method: "GET", url: `/api/${A}/modules/search/campaigns/${campaignId}/negatives`, headers: asUser(uA) });
      const byId = new Map((negatives.json() as { id: string; status: string }[]).map((n) => [n.id, n.status]));
      expect(byId.get(campNegId)).toBe("applied");
      expect(byId.get(adgNegId)).toBe("applied");
    });

    it("negatives_batch: 400s when payload.ids is missing/empty", async () => {
      const campaignId = await newCampaign("negatives-missing-ids");
      const proposalId = await newProposal(campaignId, "negatives_batch");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
    });

    it("ads_batch: exports the RSA CSV shape and cascades status='approved' -> 'live' on mark-applied", async () => {
      const campaignId = await newCampaign("ads-batch-campaign");
      const agRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "AdsGroup" } });
      const adGroupId = agRes.json().id as string;
      const adRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA),
        payload: { headlines: ["Great Deal"], descriptions: ["Shop today."], status: "approved" },
      });
      const adId = adRes.json().id as string;

      const proposalId = await newProposal(campaignId, "ads_batch", { ids: [adId] });
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(201);
      const csv = mem.get(`${A}/sem-exports/${r.json().fileId}`)!.toString("utf8");
      expect(csv).toContain("Great Deal");
      expect(csv).toContain("Shop today.");
      expect(csv.trim().endsWith("Enabled")).toBe(true);

      const apply = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(apply.statusCode).toBe(200);
      const ad = await app.inject({ method: "GET", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA) });
      expect((ad.json() as { id: string; status: string }[]).find((a) => a.id === adId)?.status).toBe("live");
    });

    it("ads_batch: refuses to export a draft (non-approved) ad rather than silently skip it", async () => {
      const campaignId = await newCampaign("ads-batch-draft-campaign");
      const agRes = await app.inject({ method: "POST", url: `/api/${A}/modules/search/campaigns/${campaignId}/ad-groups`, headers: asUser(uA), payload: { name: "DraftGroup" } });
      const adGroupId = agRes.json().id as string;
      const adRes = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/ad-groups/${adGroupId}/ads`, headers: asUser(uA),
        payload: { headlines: ["Draft headline"], descriptions: ["Draft desc."] }, // status defaults to 'draft'
      });
      const adId = adRes.json().id as string;
      const proposalId = await newProposal(campaignId, "ads_batch", { ids: [adId] });
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/export`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/approved/);
    });
  });

  // ─────────────────────────────────────────────── mark-applied: the narrow door ──────────────────
  describe("mark-applied — the ONE new door to status='applied' (ticket hazard #1)", () => {
    it("REGRESSION MUTATION PROBE: the generic PATCH still refuses status='applied' unconditionally", async () => {
      const campaignId = await newCampaign("mutation-probe-campaign");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const patchAttempt = await app.inject({ method: "PATCH", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA), payload: { status: "applied" } });
      expect(patchAttempt.statusCode).toBe(400);
      // Confirms mark-applied is genuinely a DIFFERENT, additional route — not a relaxation of PATCH.
      const stillApproved = await app.inject({ method: "GET", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA) });
      expect(stillApproved.json().status).toBe("approved");
    });

    it("uses Cerbos action 'apply_manual' — a DENY on that action blocks mark-applied (proves the gate is load-bearing, not decorative)", async () => {
      const campaignId = await newCampaign("mutation-probe-gate-campaign");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      denyAction = "apply_manual";
      const denied = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(denied.statusCode).toBe(403);
      denyAction = null;
      const allowed = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(allowed.statusCode).toBe(200);
      expect(capturedActions).toContain("apply_manual");
    });

    it("400s marking an unapproved ('proposed') proposal applied", async () => {
      const campaignId = await newCampaign("mark-applied-not-approved");
      const proposalId = await newProposal(campaignId, "pause");
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
    });

    it("400s marking a mode='api' proposal applied (that is SM-21's exclusive path)", async () => {
      const campaignId = await newCampaign("mark-applied-api-mode");
      const proposalId = await newProposal(campaignId, "pause", {}, "api");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toMatch(/mode='api'/);
      const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA) });
      expect(get.json().status).toBe("approved"); // api-mode fields/status untouched
      expect(get.json().appliedBy).toBeFalsy();
    });

    it("stamps applied_by/applied_at and writes an audit activity row", async () => {
      const campaignId = await newCampaign("mark-applied-audit");
      const proposalId = await newProposal(campaignId, "pause", { note: "irrelevant to payload" });
      await approve(proposalId);
      const r = await app.inject({
        method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA),
        payload: { note: "paused by hand in Ads UI at 14:02" },
      });
      expect(r.statusCode).toBe(200);
      const get = await app.inject({ method: "GET", url: `/api/${A}/modules/search/change-proposals/${proposalId}`, headers: asUser(uA) });
      const body = get.json() as { status: string; appliedBy: string; appliedAt: string };
      expect(body.status).toBe("applied");
      expect(body.appliedBy).toBe(uA);
      expect(body.appliedAt).toBeTruthy();

      const activity = await withTenants(
        [A],
        (c) => c.query(`SELECT verb FROM activities WHERE target_entity_type = 'search_change_proposal' AND target_entity_id = $1 AND verb = 'marked_applied'`, [proposalId]),
      );
      expect(activity.rows.length).toBe(1);
    });

    it("IDEMPOTENCY — a second mark-applied call on an already-applied proposal is refused, never double-recorded", async () => {
      // Sequential calls never reach the CAS race window (the second's own pre-fetch already sees
      // status='applied', committed by the first) — so the SEQUENTIAL case is caught by the ordinary
      // application-level status check (400 "must be 'approved' first"), not the CAS backstop (404,
      // reserved for a genuine concurrent collision — see the next test). Both are "refused, not
      // applied a second time"; only the concurrent case exercises the schema-level guarantee.
      const campaignId = await newCampaign("idempotency-sequential");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const first = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) });
      expect(second.statusCode).toBe(400);
      expect(second.json().error).toMatch(/must be 'approved' first/);

      const rows = await withTenants([A], (c) => c.query(`SELECT status FROM search_change_proposals WHERE id = $1`, [proposalId]), { modules: ["search"] });
      expect(rows.rows[0].status).toBe("applied"); // exactly one transition happened, not reverted/duplicated
    });

    it("IDEMPOTENCY UNDER CONCURRENCY — two simultaneous mark-applied calls: exactly one 200, the loser is refused (400 pre-check or 404 CAS backstop — timing-dependent, never 200), exactly one applied_by stamped", async () => {
      // NOTE ON WHAT THIS TEST CAN AND CANNOT PROVE: Promise.all against app.inject() does not
      // GUARANTEE the two requests' SQL actually interleaves inside Postgres — that depends on the
      // pool/scheduler's real timing, which this test does not control. What the code GUARANTEES
      // (the schema-level CAS: `UPDATE ... WHERE status = 'approved'`, identical to
      // updateChangeProposal's own pattern) is that IF both requests' pre-checks race past the
      // status='approved' read before either UPDATE commits, only one UPDATE can affect a row — the
      // loser's WHERE clause re-evaluates against the now-committed 'applied' row and matches zero.
      // The invariant this test asserts is the one that has to hold regardless of which timing
      // actually occurred: exactly one 200, the DB ends with exactly one applied_by stamp, and the
      // loser is NEVER a second 200 (double-recorded) no matter which refusal code it received.
      const campaignId = await newCampaign("idempotency-concurrent");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const [r1, r2] = await Promise.all([
        app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) }),
        app.inject({ method: "POST", url: `/api/${A}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uA) }),
      ]);
      const codes = [r1.statusCode, r2.statusCode];
      expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one winner, never zero, never two
      for (const c of codes) expect([200, 400, 404]).toContain(c);
      const rows = await withTenants(
        [A], (c) => c.query<{ status: string; applied_by: string | null }>(`SELECT status, applied_by FROM search_change_proposals WHERE id = $1`, [proposalId]), { modules: ["search"] },
      );
      expect(rows.rows[0].status).toBe("applied");
      expect(rows.rows[0].applied_by).toBe(uA);
    });

    it("company C cannot mark-applied company A's proposal", async () => {
      const campaignId = await newCampaign("cross-tenant-mark-applied");
      const proposalId = await newProposal(campaignId, "pause");
      await approve(proposalId);
      const r = await app.inject({ method: "POST", url: `/api/${C}/modules/search/change-proposals/${proposalId}/mark-applied`, headers: asUser(uC) });
      expect(r.statusCode).toBe(404);
    });
  });
});
