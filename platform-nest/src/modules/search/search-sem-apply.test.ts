// SM-21 — controller e2e for the api-mode (AUTOMATED twin) execution path, against LIVE Postgres
// (RLS + the real UNIQUE constraint actually exercised) and the real HTTP layer. Same harness
// technique as search-sem-export.test.ts (SM-30): Cerbos's `check` is MOCKED but its call arguments
// are CAPTURED, because the ticket's hazard is a claim about WHICH resource+action gates WHICH step —
// not about an HTTP outcome a permissive stub would produce identically either way.
//
// This file does NOT re-derive SM-03's resource_search_campaign.yaml parity matrix
// (search-cerbos.test.ts owns that against live Cerbos, unmodified by this ticket, and its policy
// already lists launch/apply_negatives/set_budget as module_manager/company_admin/group_executive-
// only). It proves that THIS controller sends those actions, that a DENY blocks execution, and that
// the SECOND gate is a genuinely different resource+action (`automation_approval:decide`, which
// resource_automation_approval.yaml grants only to company_admin/group_executive) — the separation
// of duties D-6 actually buys.
//
// ── WHAT IS PROVEN AGAINST REAL INFRASTRUCTURE HERE, AND WHAT IS DEFERRED ──────────────────────────
// Proven here: the approval linkage, the content binding, the one-shot consumption under a
// GENUINELY FORCED race (with a naive check-then-insert competitor as the negative control), the
// four-outcome classification, the cascade scoping, and the simulate-mode stamping.
// Deferred to staging (SM-41G, real Google Ads test account): that the operations this path emits
// apply as intended in a real ad account, and anything about real OAuth credentials. No real Google
// Ads client or OAuth client exists in dev, so every assertion below runs against the built-in
// simulator or an injected executor — never against a claim that a real push happened.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createClient } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { searchModule } from "./index";
import { resetCoreRollupProviders, syncMetricDefinitions } from "../../rollups/engine";
import { APPLY_RACE_DELAY_MS, setAdsExecutorForTest, type AdsExecutor } from "./sem-apply";

interface CapturedCall { kind: string; action: string }
const captured: CapturedCall[] = [];
let denyAction: string | null = null;
vi.mock("../../rbac/cerbos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../rbac/cerbos")>();
  return {
    ...actual,
    check: vi.fn(async (_principal: unknown, resource: { kind: string }, action: string) => {
      captured.push({ kind: resource.kind, action });
      if (denyAction && action === denyAction) return { allow: false as const, reason: "test-forced-deny" };
      return { allow: true as const };
    }),
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("search-marketing api-mode execution (SM-21)", () => {
  let app: NestFastifyApplication;
  let A: string;
  let C: string;
  let uA: string;
  let uC: string;
  let clientA: string;
  let engagementId: string;
  let propertyId: string;

  const url = (t: string, path: string) => `/api/${t}/modules/search/${path}`;

  async function newCampaign(name: string, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await app.inject({
      method: "POST", url: url(A, `engagements/${engagementId}/campaigns`), headers: asUser(uA),
      payload: { name, ...extra },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function newProposal(campaignId: string, kind: string, payload: Record<string, unknown> = {}, mode = "api"): Promise<string> {
    const res = await app.inject({
      method: "POST", url: url(A, `campaigns/${campaignId}/change-proposals`), headers: asUser(uA),
      payload: { kind, payload, mode },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function approveProposal(proposalId: string): Promise<void> {
    const r = await app.inject({
      method: "PATCH", url: url(A, `change-proposals/${proposalId}`), headers: asUser(uA),
      payload: { status: "approved" },
    });
    expect(r.statusCode).toBe(200);
  }

  const applyApi = (proposalId: string, tenant = A, user = uA) =>
    app.inject({ method: "POST", url: url(tenant, `change-proposals/${proposalId}/apply-api`), headers: asUser(user) });

  async function decideApproval(approvalId: string, decision: "approved" | "rejected"): Promise<void> {
    const r = await app.inject({
      method: "POST", url: `/api/${A}/automation-approvals/${approvalId}/decide`, headers: asUser(uA),
      payload: { decision },
    });
    expect(r.statusCode).toBe(200);
  }

  /** An approved api proposal with its WS4 approval minted AND approved — i.e. ready to execute
   *  exactly once. Returns both ids. */
  async function readyToExecute(kind: string, payload: Record<string, unknown> = {}, campaignExtra: Record<string, unknown> = {}) {
    const campaignId = await newCampaign(`c-${kind}-${newId().slice(0, 8)}`, campaignExtra);
    const proposalId = await newProposal(campaignId, kind, payload);
    await approveProposal(proposalId);
    const suspended = await applyApi(proposalId);
    expect(suspended.statusCode).toBe(202);
    const approvalId = suspended.json().approvalId as string;
    await decideApproval(approvalId, "approved");
    return { campaignId, proposalId, approvalId };
  }

  async function executions(proposalId: string) {
    return withTenants(
      [A],
      (c) => c.query<{
        id: string; status: string; simulated: boolean; provider: string | null; approval_id: string;
        changes_total: number; changes_applied: number; changes_failed: number; changes_unknown: number;
        per_change: { entityId: string; outcome: string }[]; echo_violations: string[]; payload_hash: string;
        error: string | null;
      }>(
        `SELECT id, status, simulated, provider, approval_id, changes_total, changes_applied,
                changes_failed, changes_unknown, per_change, echo_violations, payload_hash, error
           FROM search_change_executions WHERE proposal_id = $1 ORDER BY created_at ASC`,
        [proposalId],
      ),
      { modules: ["search"] },
    ).then((r) => r.rows);
  }

  /**
   * "Nothing executed" for a route that ANSWERS BEFORE IT FINISHES.
   *
   * `app.inject()` resolves the moment the response is sent, so an immediate `executions()` read
   * cannot see writes the handler makes afterwards. That blind spot is not hypothetical: mutation
   * probe P1 for this ticket — dropping the `return` after the pending-approval 202, the single most
   * plausible fail-open on this route — left the suite GREEN precisely because every "nothing
   * executed" assertion read the table before the fire-and-forget writes landed. A guard test that
   * cannot fail proves nothing while looking like the strongest line in the file (§6bc Ruling 5,
   * §6bi Ruling 4 clause 2), so the assertion now waits out a bounded settle window and the
   * instrument self-asserts that it actually engaged (clause 3).
   */
  async function expectNothingExecuted(proposalId: string, settleMs = 400): Promise<void> {
    const started = Date.now();
    let maxSeen = 0;
    while (Date.now() - started < settleMs) {
      maxSeen = Math.max(maxSeen, (await executions(proposalId)).length);
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(settleMs);
    expect(maxSeen).toBe(0);
  }

  async function proposalRow(proposalId: string) {
    return withTenants(
      [A],
      (c) => c.query<{ status: string; mode: string; approval_id: string | null; applied_by: string | null; payload: Record<string, unknown> }>(
        `SELECT status, mode, approval_id, applied_by, payload FROM search_change_proposals WHERE id = $1`,
        [proposalId],
      ),
      { modules: ["search"] },
    ).then((r) => r.rows[0]);
  }

  async function newNegative(campaignId: string, term: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: url(A, `campaigns/${campaignId}/negatives`), headers: asUser(uA),
      payload: { term, matchType: "broad" },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  }

  async function negativeStatus(id: string): Promise<string> {
    return withTenants(
      [A],
      (c) => c.query<{ status: string }>(`SELECT status FROM search_negatives WHERE id = $1`, [id]),
      { modules: ["search"] },
    ).then((r) => r.rows[0].status);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    registerModule(searchModule);
    await syncMetricDefinitions();

    A = await createCompany("SM21 Co A", ["search"]);
    C = await createCompany("SM21 Co C", ["search"]);
    uA = await createUser("sm21-a@a.test");
    uC = await createUser("sm21-c@c.test");
    await addMembership(A, uA);
    await addMembership(C, uC);
    clientA = await createClient(A, "SM21 Client of A");

    app = await buildApp();

    const propRes = await app.inject({
      method: "POST", url: url(A, "properties"), headers: asUser(uA),
      payload: { clientId: clientA, domain: "sm21.example.com", siteUrl: "https://sm21.example.com" },
    });
    propertyId = propRes.json().id as string;
    const engRes = await app.inject({
      method: "POST", url: url(A, "engagements"), headers: asUser(uA),
      payload: { clientId: clientA, propertyId, name: "SM21 engagement" },
    });
    engagementId = engRes.json().id as string;
  });
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  beforeEach(() => {
    captured.length = 0;
    denyAction = null;
    // The suite runs in the DEFAULT platform mode. Every assertion about `simulated` below is
    // therefore an assertion about the mode the tests actually run in, read from config rather than
    // assumed — see the mode-honesty test for why that matters.
    (config.search as { providerMode: "simulate" | "live" }).providerMode = "simulate";
  });
  afterEach(() => {
    setAdsExecutorForTest(null);
    APPLY_RACE_DELAY_MS.value = 0;
  });

  // ───────────────────────────────────── index.ts wiring ──────────────────────────────────────────
  it("the three §07 high-impact tools now have REAL bindings onto the one api-execution route", () => {
    for (const name of ["search.applyNegatives", "search.setBudget", "search.launchCampaign"]) {
      const tool = searchModule.mcpTools?.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.method).toBe("POST");
      expect(tool?.pathTemplate).toBe("/api/:tenantId/modules/search/change-proposals/:proposalId/apply-api");
      // impact stays 'high' and assurance stays 'verified' — §A13.6: this is a risk classification,
      // never a claim that an automation principal (minted assurance:'low') can enter here.
      expect(tool?.impact).toBe("high");
      expect(tool?.minAssurance).toBe("verified");
      expect(tool?.write).toBe(true);
    }
  });

  it("registers migration 0064 in the module contract (0047's omission, not repeated)", () => {
    expect(searchModule.migrations).toContain("0064_search_change_executions.sql");
  });

  it("registers NO automation_approval.decided handler — deciding must not execute a live ad change", () => {
    // D14 (project memory `d14-no-resume-gap`): there is no resume-on-decision here, deliberately.
    // HR's leave flow DOES register this handler because it moves an internal row; this path would
    // spend a client's advertising money with no human present at the moment of execution.
    expect(Object.keys(searchModule.eventHandlers ?? {})).not.toContain("automation_approval.decided");
  });

  // ───────────────────────────────── approval is a precondition ───────────────────────────────────
  describe("approval is a precondition, not a suggestion", () => {
    it("the FIRST call executes nothing — it suspends into WS4's existing store and returns 202", async () => {
      const campaignId = await newCampaign("suspend-first");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);

      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(202);
      expect(res.json().outcome).toBe("suspended");
      const approvalId = res.json().approvalId as string;
      expect(approvalId).toBeTruthy();

      // Nothing executed: no execution row at all, and the proposal is untouched.
      await expectNothingExecuted(proposalId);
      const p = await proposalRow(proposalId);
      expect(p.status).toBe("approved");
      expect(p.applied_by).toBeNull();
      // The approval landed in the SHARED WS4 table, high impact, pending, carrying the content hash.
      const appr = await withTenants(
        [A],
        (c) => c.query<{ status: string; impact: string; origin: string; tool_name: string; tool_args: Record<string, unknown> }>(
          `SELECT status, impact, origin, tool_name, tool_args FROM automation_approvals WHERE id = $1`, [approvalId],
        ),
      ).then((r) => r.rows[0]);
      expect(appr.status).toBe("pending");
      expect(appr.impact).toBe("high");
      expect(appr.tool_name).toBe("search.launchCampaign");
      expect(appr.tool_args.payloadHash).toBe(res.json().payloadHash);
      expect(appr.tool_args.proposalId).toBe(proposalId);
      // origin stays inside the unified inbox's CLOSED taxonomy — an unlisted origin would make the
      // row invisible there (core/approvals.controller.ts filters `origin = ANY(...)`) and would
      // compute a NaN urgency. See the route header for the full reasoning.
      expect(["automation", "agent", "hr"]).toContain(appr.origin);
      // ...and it is genuinely visible in the unified inbox a human decides from.
      const inbox = await app.inject({ method: "GET", url: `/api/approvals?status=pending`, headers: asUser(uA) });
      expect(inbox.statusCode).toBe(200);
      expect((inbox.json().items as { id: string }[]).some((i) => i.id === approvalId)).toBe(true);
    });

    it("a SECOND call while the approval is still pending executes nothing either", async () => {
      const campaignId = await newCampaign("suspend-second");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      const first = await applyApi(proposalId);
      const approvalId = first.json().approvalId as string;

      const second = await applyApi(proposalId);
      expect(second.statusCode).toBe(202);
      expect(second.json().outcome).toBe("awaiting_approval");
      expect(second.json().approvalId).toBe(approvalId); // no second approval is minted
      await expectNothingExecuted(proposalId);
      const count = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM automation_approvals WHERE tool_args->>'proposalId' = $1`, [proposalId]),
      ).then((r) => Number(r.rows[0].n));
      expect(count).toBe(1);
    });

    it("an APPROVED decision lets it execute exactly once", async () => {
      const { proposalId, approvalId } = await readyToExecute("pause");
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("applied");
      const rows = await executions(proposalId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
      expect(rows[0].approval_id).toBe(approvalId);
      expect((await proposalRow(proposalId)).status).toBe("applied");
    });

    it("a REJECTED decision can never execute, and no second approval is ever minted for it", async () => {
      const campaignId = await newCampaign("rejected");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "rejected");

      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/can never execute/);
      expect(await executions(proposalId)).toHaveLength(0);
      // Re-driving does not mint a fresh approval to try again with.
      await applyApi(proposalId);
      const count = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM automation_approvals WHERE tool_args->>'proposalId' = $1`, [proposalId]),
      ).then((r) => Number(r.rows[0].n));
      expect(count).toBe(1);
    });

    it("a FORGED approval cannot authorize anything — the linkage comes from the proposal's own column", async () => {
      // The attack this closes: POST /api/:t/automation-approvals is open to member-tier principals
      // with ARBITRARY tool_args. An implementation that FOUND its approval by matching
      // tool_args->>'proposalId' would execute off this row. One that follows
      // search_change_proposals.approval_id cannot.
      const campaignId = await newCampaign("forged");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      const payloadHash = (await applyApi(proposalId)).json().payloadHash as string;
      // Reset the proposal's link so the ONLY approval mentioning it is the forged one.
      await withTenants([A], (c) => c.query(`UPDATE search_change_proposals SET approval_id = NULL WHERE id = $1`, [proposalId]), { modules: ["search"] });

      const forged = await app.inject({
        method: "POST", url: `/api/${A}/automation-approvals`, headers: asUser(uA),
        payload: {
          workflowId: "wf:attacker", toolName: "search.launchCampaign", impact: "high",
          toolArgs: { proposalId, payloadHash, kind: "pause", mode: "api" },
        },
      });
      expect(forged.statusCode).toBe(201);
      const forgedId = forged.json().id as string;
      await decideApproval(forgedId, "approved");

      // The route ignores it completely and suspends afresh.
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(202);
      expect(res.json().outcome).toBe("suspended");
      expect(res.json().approvalId).not.toBe(forgedId);
      await expectNothingExecuted(proposalId);
    });

    it("an unresolvable approval reference fails CLOSED, not open", async () => {
      const campaignId = await newCampaign("dangling");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "approved");
      // Soft-delete the approval out from under the proposal (an operator/GDPR sweep, a bug — the
      // route must not read "cannot read the authorization" as "no authorization needed").
      await withTenants([A], (c) => c.query(`UPDATE automation_approvals SET deleted_at = now() WHERE id = $1`, [approvalId]));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/could not be read/);
      expect(await executions(proposalId)).toHaveLength(0);
    });
  });

  // ───────────────────────────────── what executes = what was approved ────────────────────────────
  describe("content binding", () => {
    it("a payload edited after approval refuses execution (hash mismatch)", async () => {
      const { proposalId } = await readyToExecute("budget", { budgetMinor: 50_000, currency: "USD" });
      // SM-18's app layer already refuses `PATCH payload` once status != 'proposed' — asserted here
      // so this test cannot be read as testing a door that is open.
      const patched = await app.inject({
        method: "PATCH", url: url(A, `change-proposals/${proposalId}`), headers: asUser(uA),
        payload: { payload: { budgetMinor: 5_000_000, currency: "USD" } },
      });
      expect(patched.statusCode).toBe(400);
      // Now change it the way a future route, a migration or a direct SQL edit could — the hash is
      // the wall that does not depend on that app-level rule being obeyed.
      await withTenants(
        [A],
        (c) => c.query(`UPDATE search_change_proposals SET payload = $2 WHERE id = $1`, [proposalId, JSON.stringify({ budgetMinor: 5_000_000, currency: "USD" })]),
        { modules: ["search"] },
      );
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/content changed since it was approved/);
      expect(await executions(proposalId)).toHaveLength(0);
      expect((await proposalRow(proposalId)).status).toBe("approved");
    });

    it("an approval carrying NO payload hash refuses execution — fail closed, never skip the check", async () => {
      // This is the shape a hand-crafted or legacy approvals row has. The guard is written
      // `if (!storedHash) refuse`, NOT `if (storedHash && mismatch) refuse` — the second is the
      // plausible fail-open, and it is what this test exists to keep out.
      const { proposalId, approvalId } = await readyToExecute("pause");
      await withTenants([A], (c) => c.query(
        `UPDATE automation_approvals SET tool_args = tool_args - 'payloadHash' WHERE id = $1`, [approvalId],
      ));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/no payload hash/);
      expect(await executions(proposalId)).toHaveLength(0);
    });

    it("an approval naming a DIFFERENT proposal refuses execution", async () => {
      const { proposalId, approvalId } = await readyToExecute("pause");
      await withTenants([A], (c) => c.query(
        `UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{proposalId}', '"00000000-0000-0000-0000-000000000000"') WHERE id = $1`,
        [approvalId],
      ));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/refers to a different proposal/);
      expect(await executions(proposalId)).toHaveLength(0);
    });

    it("the executed hash is recorded on the execution row, provable after the fact", async () => {
      const { proposalId } = await readyToExecute("pause");
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(200);
      const rows = await executions(proposalId);
      expect(rows[0].payload_hash).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ───────────────────────────────────────── replay safety ────────────────────────────────────────
  describe("replay safety", () => {
    it("a sequential replay is refused with 409 and leaves exactly ONE execution row", async () => {
      const { proposalId } = await readyToExecute("pause");
      expect((await applyApi(proposalId)).statusCode).toBe(200);
      const replay = await applyApi(proposalId);
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toMatch(/already been consumed/);
      expect(await executions(proposalId)).toHaveLength(1);
    });

    it("a FAILED execution does not reopen the door — the approval stays spent", async () => {
      setAdsExecutorForTest(async () => { throw new Error("ads api down"); });
      const { proposalId } = await readyToExecute("pause");
      const first = await applyApi(proposalId);
      expect(first.statusCode).toBe(400);
      const rows = await executions(proposalId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("failed");
      expect(rows[0].error).toMatch(/ads api down/);
      // A retry — even with a now-healthy executor — is refused. Remediation is a NEW proposal.
      setAdsExecutorForTest(null);
      expect((await applyApi(proposalId)).statusCode).toBe(409);
      expect(await executions(proposalId)).toHaveLength(1);
    });

    it("FORCED RACE: two genuinely-overlapping executions produce exactly one 200 and one 409", async () => {
      const { proposalId } = await readyToExecute("pause");
      // Widen the admission->claim window so both requests are past their reads before either
      // inserts. Without this, natural timing on fast local hardware may never collide and the test
      // would pass while proving nothing (§6ay's lesson).
      APPLY_RACE_DELAY_MS.value = 250;
      const started = Date.now();
      const [r1, r2] = await Promise.all([applyApi(proposalId), applyApi(proposalId)]);
      const elapsed = Date.now() - started;
      // The instrument self-asserts (negative-control rule clause 3): a dead lever must be loud,
      // not silently narrow the race window to zero.
      expect(elapsed).toBeGreaterThanOrEqual(APPLY_RACE_DELAY_MS.value);

      const codes = [r1.statusCode, r2.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      // The independent witness is ROW STATE, not the handlers' return values.
      const rows = await executions(proposalId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("applied");
    });

    it("NEGATIVE CONTROL: a naive check-then-insert competitor genuinely collides and is refused BY THE CONSTRAINT", async () => {
      // Proves two things the race test above cannot prove on its own:
      //   (a) the widened window makes the requests ACTUALLY overlap — both competitors below pass
      //       their `SELECT` before either inserts, which is only observable by writing the naive
      //       version and watching it break;
      //   (b) it is the UNIQUE (approval_id) constraint that makes production safe, not the
      //       existence of an application-level pre-check. The plausible defect here is exactly
      //       check-then-insert (§6bi Ruling 4 clause 1), so that is what the control is.
      const { proposalId, campaignId, approvalId } = await readyToExecute("pause");
      const naive = () => withTenants(
        [A],
        async (c) => {
          const existing = await c.query(`SELECT 1 FROM search_change_executions WHERE approval_id = $1`, [approvalId]);
          await new Promise((r) => setTimeout(r, 250)); // the same widened window
          if (existing.rowCount && existing.rowCount > 0) throw new Error("APP_LEVEL_CHECK_REFUSED");
          await c.query(
            `INSERT INTO search_change_executions
               (id, tenant_id, proposal_id, campaign_id, approval_id, kind, payload_hash, status, origin_site)
             VALUES ($1,$2,$3,$4,$5,'pause','deadbeef','dispatched','central')`,
            [newId(), A, proposalId, campaignId, approvalId],
          );
        },
        { modules: ["search"] },
      );
      const settled = await Promise.allSettled([naive(), naive()]);
      const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
      // Exactly one loser, and it lost at the INDEX (23505) — not at the app-level check, which both
      // competitors passed. If the app-level check had been what stopped it, the reason would be
      // APP_LEVEL_CHECK_REFUSED instead.
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as { code?: string }).code).toBe("23505");
      expect((rejected[0].reason as { message?: string }).message).not.toMatch(/APP_LEVEL_CHECK_REFUSED/);
      // And the constraint held: still exactly one row for that approval.
      const n = await withTenants(
        [A], (c) => c.query<{ n: string }>(`SELECT count(*) AS n FROM search_change_executions WHERE approval_id = $1`, [approvalId]),
        { modules: ["search"] },
      ).then((r) => Number(r.rows[0].n));
      expect(n).toBe(1);
    });
  });

  // ─────────────────────────────── partial / indeterminate outcomes ───────────────────────────────
  describe("outcome honesty", () => {
    const mixedExecutor = (appliedIds: string[]): AdsExecutor => async (ctx) => ({
      provider: "simulation",
      simulated: true,
      results: ctx.operations.map((op) => ({
        ref: op.ref,
        outcome: appliedIds.includes(op.entityId) ? "applied" as const : "failed" as const,
        detail: appliedIds.includes(op.entityId) ? null : "POLICY_VIOLATION",
      })),
    });

    it("PARTIAL is recorded as partial — the proposal is neither 'applied' nor untouched", async () => {
      const campaignId = await newCampaign("partial");
      const n1 = await newNegative(campaignId, "free stuff");
      const n2 = await newNegative(campaignId, "cheap knockoff");
      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [n1, n2] });
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "approved");

      setAdsExecutorForTest(mixedExecutor([n1]));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(200);
      expect(res.json().outcome).toBe("partial");
      expect(res.json().changesApplied).toBe(1);
      expect(res.json().changesFailed).toBe(1);

      const rows = await executions(proposalId);
      expect(rows[0].status).toBe("partial");
      expect(rows[0].changes_applied).toBe(1);
      expect(rows[0].changes_failed).toBe(1);
      // Not rounded to success: the proposal stays 'approved' with an execution on record.
      const p = await proposalRow(proposalId);
      expect(p.status).toBe("approved");
      expect(p.applied_by).toBeNull();
      // The cascade touched ONLY the negative that actually applied.
      expect(await negativeStatus(n1)).toBe("applied");
      expect(await negativeStatus(n2)).toBe("proposed");
    });

    it("a partial outcome is still terminal — no re-run, and the read surface can see why", async () => {
      const campaignId = await newCampaign("partial-terminal");
      const n1 = await newNegative(campaignId, "aaa");
      const n2 = await newNegative(campaignId, "bbb");
      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [n1, n2] });
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "approved");
      setAdsExecutorForTest(mixedExecutor([n1]));
      expect((await applyApi(proposalId)).statusCode).toBe(200);

      setAdsExecutorForTest(null);
      expect((await applyApi(proposalId)).statusCode).toBe(409);
      // The proposal read carries the execution state, so 'partial' is distinguishable from
      // 'never attempted' — both of which leave status='approved'.
      const got = await app.inject({ method: "GET", url: url(A, `change-proposals/${proposalId}`), headers: asUser(uA) });
      expect(got.json().status).toBe("approved");
      expect(got.json().executionStatus).toBe("partial");
      const list = await app.inject({ method: "GET", url: url(A, `change-proposals/${proposalId}/executions`), headers: asUser(uA) });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toHaveLength(1);
      expect(list.json()[0].perChange).toHaveLength(2);
    });

    it("an UNPAIRABLE response is 'indeterminate': recorded, 502, and NOTHING is attributed", async () => {
      const campaignId = await newCampaign("indeterminate");
      const n1 = await newNegative(campaignId, "ccc");
      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [n1] });
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "approved");

      // Echoes a ref we never sent (§A14.5: an identity violation on a paired response impeaches the
      // addressing scheme, so no result in it can be trusted).
      setAdsExecutorForTest(async () => ({
        provider: "simulation", simulated: true,
        results: [{ ref: "negative.add#somebody-elses-row", outcome: "applied" as const }],
      }));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(502);
      expect(res.json().outcome).toBe("indeterminate");
      expect((res.json().echoViolations as string[]).join(" ")).toMatch(/never sent/);
      // Recorded BEFORE the refusal (record-then-throw): the live side effect may exist, so the
      // absence of a local trace would be the SM-50 orphan class at its most expensive.
      const rows = await executions(proposalId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("indeterminate");
      expect(rows[0].echo_violations.length).toBeGreaterThan(0);
      // No attribution, no cascade, no 'applied' proposal.
      expect(await negativeStatus(n1)).toBe("proposed");
      expect((await proposalRow(proposalId)).status).toBe("approved");
    });

    it("an executor claiming a LIVE push while the platform is in simulate mode is refused", async () => {
      const { proposalId } = await readyToExecute("pause");
      setAdsExecutorForTest(async (ctx) => ({
        provider: "google_ads", simulated: false,
        results: ctx.operations.map((op) => ({ ref: op.ref, outcome: "applied" as const })),
      }));
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(502);
      const rows = await executions(proposalId);
      expect(rows[0].status).toBe("indeterminate");
      expect(rows[0].echo_violations.join(" ")).toMatch(/simulated=false while the platform expected simulated=true/);
      expect((await proposalRow(proposalId)).status).toBe("approved");
    });
  });

  // ──────────────────────────────────── simulation honesty ────────────────────────────────────────
  describe("simulation is stamped in the database, not just shown in the UI", () => {
    it("simulate mode stamps simulated=true + provider='simulation' on the row", async () => {
      const { proposalId } = await readyToExecute("pause");
      expect((await applyApi(proposalId)).statusCode).toBe(200);
      const rows = await executions(proposalId);
      expect(rows[0].simulated).toBe(true);
      expect(rows[0].provider).toBe("simulation");
      // ...and it is readable from the API, so a console can badge it.
      const got = await app.inject({ method: "GET", url: url(A, `change-proposals/${proposalId}`), headers: asUser(uA) });
      expect(got.json().executionSimulated).toBe(true);
    });

    it("LIVE mode with no registered executor REFUSES and does not consume the approval", async () => {
      const { proposalId } = await readyToExecute("pause");
      // SM-26 / addendum §A12.6: the live-ness of an AD WRITE is now `SEARCH_ADS_WRITE_MODE`, not
      // `config.search.providerMode` (which describes the DATA vendors). SM-21 shipped `providerMode`
      // here as a declared interim and this test pinned that interim; the switch is what changed, so
      // only the SETUP moves. Every assertion below is byte-for-byte the original — the refusal, the
      // SM-26 message, the un-burned approval, and the recovery — because the behaviour being pinned
      // did not change and must not.
      //
      // Set via `process.env`, deliberately: `resolveSearchAdsWriteMode()` reads it per call, so a test
      // can exercise the REAL switch. Reading it through `config` would capture at module load and this
      // mutation would silently stop working while the test still passed.
      process.env.SEARCH_ADS_WRITE_MODE = "live";
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/SM-26/);
      // The one-shot approval must NOT be burned by a platform-capability gap — that would make an
      // operator-fixable condition terminal for the proposal.
      expect(await executions(proposalId)).toHaveLength(0);
      delete process.env.SEARCH_ADS_WRITE_MODE;
      expect((await applyApi(proposalId)).statusCode).toBe(200);
    });
  });

  // ─────────────────────────────────────── guard rails ────────────────────────────────────────────
  describe("guard rails", () => {
    it("400s (never 500s) on a malformed proposal id", async () => {
      const res = await app.inject({ method: "POST", url: url(A, "change-proposals/not-a-uuid/apply-api"), headers: asUser(uA) });
      expect(res.statusCode).toBe(400);
    });

    it("404s on a nonexistent proposal", async () => {
      const res = await applyApi("00000000-0000-0000-0000-000000000000");
      expect(res.statusCode).toBe(404);
    });

    it("400s on a mode='manual' proposal, and SM-30's manual door is UNCHANGED", async () => {
      const campaignId = await newCampaign("manual-mode");
      const proposalId = await newProposal(campaignId, "pause", {}, "manual");
      await approveProposal(proposalId);
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/mode='manual'/);
      expect(await executions(proposalId)).toHaveLength(0);
      // Regression pin: the manual twin still works, and still refuses via its own rules.
      const marked = await app.inject({ method: "POST", url: url(A, `change-proposals/${proposalId}/mark-applied`), headers: asUser(uA), payload: {} });
      expect(marked.statusCode).toBe(200);
    });

    it("400s on a proposal that is not yet 'approved'", async () => {
      const campaignId = await newCampaign("not-approved");
      const proposalId = await newProposal(campaignId, "pause");
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/must be 'approved'/);
      expect(await executions(proposalId)).toHaveLength(0);
    });

    it("the generic PATCH still refuses status='applied' (SM-18/SM-30's rule, unchanged)", async () => {
      const campaignId = await newCampaign("patch-applied");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      const res = await app.inject({
        method: "PATCH", url: url(A, `change-proposals/${proposalId}`), headers: asUser(uA), payload: { status: "applied" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("company C cannot execute company A's proposal (404, not a leak) nor read its executions", async () => {
      const { proposalId } = await readyToExecute("pause");
      const exec = await applyApi(proposalId, C, uC);
      expect(exec.statusCode).toBe(404);
      const read = await app.inject({ method: "GET", url: url(C, `change-proposals/${proposalId}/executions`), headers: asUser(uC) });
      expect(read.statusCode).toBe(404);
      expect(await executions(proposalId)).toHaveLength(0);
    });

    it("a negatives batch whose ids do not resolve 1:1 is refused BEFORE the approval is consumed", async () => {
      const campaignId = await newCampaign("bad-ids");
      const n1 = await newNegative(campaignId, "ddd");
      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [n1, "00000000-0000-0000-0000-000000000000"] });
      await approveProposal(proposalId);
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      await decideApproval(approvalId, "approved");
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/one-to-one/);
      // A fixable input error must not burn the one-shot approval.
      expect(await executions(proposalId)).toHaveLength(0);
    });
  });

  // ──────────────────────────────────── authorization surface ─────────────────────────────────────
  describe("authorization", () => {
    it("sends the ELEVATED, kind-derived Cerbos action — never the baseline 'update'/'propose_change'", async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ["pause", {}, "launch"],
        ["budget", { budgetMinor: 1_000, currency: "USD" }, "set_budget"],
      ];
      for (const [kind, payload, expectedAction] of cases) {
        const campaignId = await newCampaign(`authz-${kind}`);
        const proposalId = await newProposal(campaignId, kind, payload);
        await approveProposal(proposalId);
        captured.length = 0;
        await applyApi(proposalId);
        const onCampaign = captured.filter((c) => c.kind === "resource_search_campaign").map((c) => c.action);
        expect(onCampaign, kind).toContain(expectedAction);
        expect(onCampaign, kind).not.toContain("update");
        expect(onCampaign, kind).not.toContain("propose_change");
        expect(onCampaign, kind).not.toContain("apply_manual");
      }
    });

    it("negatives_batch rides apply_negatives", async () => {
      const campaignId = await newCampaign("authz-negatives");
      const n1 = await newNegative(campaignId, "eee");
      const proposalId = await newProposal(campaignId, "negatives_batch", { ids: [n1] });
      await approveProposal(proposalId);
      captured.length = 0;
      await applyApi(proposalId);
      expect(captured.filter((c) => c.kind === "resource_search_campaign").map((c) => c.action)).toContain("apply_negatives");
    });

    it("a DENY on the execution action blocks it and writes nothing", async () => {
      const { proposalId } = await readyToExecute("pause");
      denyAction = "launch";
      const res = await applyApi(proposalId);
      expect(res.statusCode).toBe(403);
      expect(await executions(proposalId)).toHaveLength(0);
      expect((await proposalRow(proposalId)).status).toBe("approved");
    });

    it("the SECOND gate is a different resource+action — the requester cannot self-approve by policy", async () => {
      // resource_search_campaign grants `launch` to module_manager; resource_automation_approval
      // grants `decide` ONLY to company_admin/group_executive. Pinned here as the two distinct
      // (kind, action) pairs the flow actually asks Cerbos about — the live parity matrix for each
      // policy is search-cerbos.test.ts / the core approvals suites, unmodified by this ticket.
      const campaignId = await newCampaign("two-gates");
      const proposalId = await newProposal(campaignId, "pause");
      await approveProposal(proposalId);
      captured.length = 0;
      const approvalId = (await applyApi(proposalId)).json().approvalId as string;
      expect(captured).toEqual(expect.arrayContaining([{ kind: "resource_search_campaign", action: "launch" }]));
      captured.length = 0;
      await decideApproval(approvalId, "approved");
      expect(captured).toEqual(expect.arrayContaining([{ kind: "automation_approval", action: "decide" }]));
      expect(captured.some((c) => c.kind === "resource_search_campaign")).toBe(false);
    });

    it("reading executions uses the BASELINE 'read' action — reading an outcome is not executing one", async () => {
      const { proposalId } = await readyToExecute("pause");
      await applyApi(proposalId);
      captured.length = 0;
      const res = await app.inject({ method: "GET", url: url(A, `change-proposals/${proposalId}/executions`), headers: asUser(uA) });
      expect(res.statusCode).toBe(200);
      const actions = captured.filter((c) => c.kind === "resource_search_campaign").map((c) => c.action);
      expect(actions).toContain("read");
      expect(actions).not.toContain("launch");
    });
  });

  // ──────────────────────────────────────── audit trail ──────────────────────────────────────────
  it("the audit trail is complete: suspend, execute, and the outbox event", async () => {
    const { proposalId } = await readyToExecute("pause");
    const res = await applyApi(proposalId);
    expect(res.statusCode).toBe(200);
    const acts = await withTenants(
      [A],
      (c) => c.query<{ verb: string }>(
        `SELECT verb FROM activities WHERE target_entity_type = 'search_change_proposal' AND target_entity_id = $1 ORDER BY occurred_at ASC`,
        [proposalId],
      ),
    ).then((r) => r.rows.map((x) => x.verb));
    expect(acts).toContain("suspended");
    expect(acts).toContain("api_execution_applied");
    const events = await withTenants(
      [A],
      (c) => c.query<{ event_type: string; payload: Record<string, unknown> }>(
        `SELECT event_type, payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'search.campaign.applied'`,
        [proposalId],
      ),
    ).then((r) => r.rows);
    expect(events).toHaveLength(1);
    expect(events[0].payload.simulated).toBe(true);
    expect(events[0].payload.status).toBe("applied");
  });
});
