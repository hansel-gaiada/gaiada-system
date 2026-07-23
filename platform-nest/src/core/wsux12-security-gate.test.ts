// WSUX-12 — the ADVERSARIAL security gate over the WS-UX cross-tenant surfaces before production
// exposure. This suite is deliberately hostile: it does NOT re-assert the authors' happy paths, it
// tries to BREAK the isolation boundary of every surface and the seams between them. A surviving
// leak here = breach. Runs against live PG (NOBYPASSRLS app role, FORCE RLS) + Cerbos.
//
// Threat model: `attacker` is a fully-legitimate company_admin of company A. `victim` is a
// company_admin of company C. attacker has NO membership or grant in C. Every test asks: can
// attacker, using only A-scoped credentials, observe or mutate ANYTHING in C — via the unified
// approvals read (WSUX-1), the decide façade (WSUX-2), the connections vault (WSUX-14), or the
// claude-seat registry (WSUX-17) — or extract a stored token through any of them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules, registerModule } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { seedAutomationAccounts } from "../seed/automation";
import { agencyModule } from "../modules/agency";
import { newId, withTenants } from "../db";
import {
  createConnection, setConnectionTokens, getConnectionRow, listConnections, patchConnection,
} from "./integrations.service";
import { randomBytes } from "node:crypto";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const asWorkflow = (wf: string) => ({ ...svc, "x-obo-provider": "n8n", "x-obo-external-id": wf });

// Secrets seeded into company C. If any of these strings ever appears in a response body attacker
// receives, that is a token/credential leak — the whole point of the gate.
const C_ACCESS = "ghp_C_secret_ACCESS_should_never_egress_xyz";
const C_REFRESH = "rt_C_secret_REFRESH_should_never_egress_xyz";
const C_SEAT_TOKEN = "claude_C_seat_secret_TOKEN_never_egress";

interface EnvelopeBody {
  items: Array<{ id: string; origin: string; tenantId: string; company: string; status: string }>;
  companies: Array<{ id: string; name?: string; included: boolean; reason?: string }>;
}

describe.skipIf(!TEST_URL)("WSUX-12 cross-tenant security gate (adversarial)", () => {
  let app: NestFastifyApplication;
  let coA: string; // attacker's company (agency enabled)
  let coC: string; // victim's company (agency enabled) — holds all the real, secret data
  let attacker: string; // company_admin in A ONLY
  let memberA: string; // plain member in A
  let victim: string; // company_admin in C ONLY

  // C's real approval ids, so we can prove they neither leak nor mutate.
  let cAgencyApprovalId: string;
  let cPipelineGateId: string;
  let cAutomationId: string;
  let cCampaignId: string;
  // C's connection + seat ids holding real tokens.
  let cCompanyConnId: string;
  let cSeatId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.integrationTokenKey = randomBytes(32).toString("base64");
    resetModules();
    resetCoreRollupProviders();
    registerModule(agencyModule);

    coA = await createCompany("WSUX12 Co A (attacker)", ["agency"]);
    coC = await createCompany("WSUX12 Co C (victim SECRET)", ["agency"]);
    await seedAutomationAccounts(coA);
    await seedAutomationAccounts(coC);

    attacker = await createUser("wsux12-attacker@a.test");
    memberA = await createUser("wsux12-member@a.test");
    victim = await createUser("wsux12-victim@c.test");
    await addMembership(coA, attacker);
    await addMembership(coA, memberA);
    await addMembership(coC, victim);

    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    await grantRole(attacker, adminRole, "company", coA);
    await grantRole(memberA, memberRole, "company", coA);
    await grantRole(victim, adminRole, "company", coC);

    app = await buildApp();

    // ---- Seed REAL, secret data inside company C (as the legitimate victim admin) ----
    const proj = await app.inject({ method: "POST", url: `/api/${coC}/projects`, headers: asUser(victim), payload: { name: "C secret project" } });
    const campaign = await app.inject({
      method: "POST", url: `/api/${coC}/modules/agency/campaigns`, headers: asUser(victim),
      payload: { name: "C secret campaign", projectId: proj.json().id },
    });
    cCampaignId = campaign.json().id;
    const approval = await app.inject({
      method: "POST", url: `/api/${coC}/modules/agency/approvals`, headers: asUser(victim),
      payload: { campaignId: cCampaignId, subject: "C SECRET hero asset" },
    });
    cAgencyApprovalId = approval.json().id;

    // NOTE: workflow OBO names MUST be ones seedAutomationAccounts actually registers a verified
    // identity_link for (wf:mtg-dispatcher / wf:delivery / wf:new-client-seed), else the OBO
    // resolves to ANONYMOUS and the create is denied — leaving an undefined id (a self-inflicted
    // test bug, not a product finding).
    const run = await app.inject({ method: "POST", url: `/api/${coC}/pipeline/runs`, headers: asWorkflow("wf:mtg-dispatcher"), payload: { sourceMeetingId: "c-mtg", title: "C SECRET kickoff" } });
    expect(run.statusCode, "C pipeline run seed").toBe(201);
    const gate = await app.inject({ method: "POST", url: `/api/${coC}/pipeline/gates`, headers: asWorkflow("wf:delivery"), payload: { runId: run.json().id, kind: "prd_review", actorSide: "internal" } });
    expect(gate.statusCode, "C pipeline gate seed").toBe(201);
    cPipelineGateId = gate.json().id;

    const auto = await app.inject({
      method: "POST", url: `/api/${coC}/automation-approvals`, headers: asWorkflow("wf:new-client-seed"),
      payload: { workflowId: "wf:new-client-seed", toolName: "money.transfer", toolArgs: { amount: 999 }, impact: "high", reason: "C SECRET high-impact write" },
    });
    expect(auto.statusCode, "C automation approval seed").toBe(201);
    cAutomationId = auto.json().id;

    // A company-owned connection in C with a REAL sealed token, and a claude seat with a token.
    const cConn = await createConnection(coC, { ownerKind: "company", ownerId: coC, provider: "github", externalAccount: "c-team@github", createdBy: victim });
    cCompanyConnId = cConn.id;
    await setConnectionTokens(coC, cCompanyConnId, { accessToken: C_ACCESS, refreshToken: C_REFRESH, scopes: ["repo"] });

    const cSeat = await createConnection(coC, { ownerKind: "user", ownerId: victim, provider: "claude", externalAccount: "victim@claude", createdBy: victim });
    cSeatId = cSeat.id;
    // Simulate a future seat token path landing a credential on the seat row — the projection must
    // STILL never surface it.
    await setConnectionTokens(coC, cSeatId, { accessToken: C_SEAT_TOKEN });
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // Helper: assert a response body carries NO secret material, in any shape.
  const assertNoSecrets = (raw: string, label: string) => {
    expect(raw, `${label}: plaintext access token leaked`).not.toContain(C_ACCESS);
    expect(raw, `${label}: plaintext refresh token leaked`).not.toContain(C_REFRESH);
    expect(raw, `${label}: plaintext seat token leaked`).not.toContain(C_SEAT_TOKEN);
    expect(raw, `${label}: ciphertext envelope leaked`).not.toContain("enc:v1:");
    expect(raw, `${label}: token_enc column name leaked`).not.toMatch(/token_enc/);
  };

  // ─────────────────────────── SURFACE 1: unified approvals read (WSUX-1) ───────────────────────────

  it("APPROVALS scope=all: attacker's fan-out is bounded to their OWN memberships — C never enters it, zero C rows", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=all`, headers: asUser(attacker) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.companies.map((c) => c.id)).not.toContain(coC);
    expect(body.items.every((i) => i.tenantId !== coC)).toBe(true);
    // and none of C's specific secret ids appear
    const ids = new Set(body.items.map((i) => i.id));
    expect(ids.has(cAgencyApprovalId)).toBe(false);
    expect(ids.has(cPipelineGateId)).toBe(false);
    expect(ids.has(cAutomationId)).toBe(false);
    // no C subject text leaks either
    assertNoSecrets(JSON.stringify(body), "approvals scope=all");
    expect(JSON.stringify(body)).not.toContain("C SECRET");
  });

  it("APPROVALS crafted scope=<C>: degrades to an EXCLUDED envelope entry with NO name (F1) and zero rows — never a 500, never a leak", async () => {
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coC}`, headers: asUser(attacker) });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items).toEqual([]);
    expect(body.companies).toEqual([{ id: coC, included: false, reason: "no_access" }]);
    // F1: the excluded entry must NOT carry the company name (would confirm existence + disclose name)
    const cEntry = body.companies.find((c) => c.id === coC)!;
    expect(cEntry.name).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("victim SECRET");
  });

  it("APPROVALS crafted scope=<C> + every origin: no origin filter widens the fan-out into C", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/approvals?scope=${coC}&origin=agency,pipeline,hr,automation,agent`, headers: asUser(attacker),
    });
    expect(r.statusCode).toBe(200);
    const body = r.json() as EnvelopeBody;
    expect(body.items).toEqual([]);
    expect(body.companies).toEqual([{ id: coC, included: false, reason: "no_access" }]);
  });

  it("APPROVALS positive control: attacker DOES see their own A approvals — proving the C-empty result is real isolation, not a blanket-empty bug", async () => {
    // Seed one approval in A so we know the endpoint is live for attacker.
    const proj = await app.inject({ method: "POST", url: `/api/${coA}/projects`, headers: asUser(attacker), payload: { name: "A proj" } });
    const camp = await app.inject({ method: "POST", url: `/api/${coA}/modules/agency/campaigns`, headers: asUser(attacker), payload: { name: "A camp", projectId: proj.json().id } });
    await app.inject({ method: "POST", url: `/api/${coA}/modules/agency/approvals`, headers: asUser(attacker), payload: { campaignId: camp.json().id, subject: "A visible asset" } });
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=${coA}`, headers: asUser(attacker) });
    const body = r.json() as EnvelopeBody;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.tenantId === coA)).toBe(true);
  });

  // ─────────────────────────── SURFACE 2: decide façade (WSUX-2) ───────────────────────────

  it("DECIDE façade: attacker cannot decide C's items via C's tenant path (403), and C's rows stay pending", async () => {
    for (const [origin, id] of [["agency", cAgencyApprovalId], ["pipeline", cPipelineGateId], ["automation", cAutomationId]] as const) {
      const r = await app.inject({
        method: "POST", url: `/api/${coC}/approvals/${id}/decide`, headers: asUser(attacker),
        payload: { origin, decision: "approved" },
      });
      expect(r.statusCode, `${origin} via C path should be denied`).toBe(403);
    }
    // C's rows untouched.
    expect((await adminPool().query(`SELECT status FROM agency_approvals WHERE id=$1`, [cAgencyApprovalId])).rows[0].status).toBe("pending");
    expect((await adminPool().query(`SELECT status FROM pipeline_gates WHERE id=$1`, [cPipelineGateId])).rows[0].status).toBe("pending");
    expect((await adminPool().query(`SELECT status FROM automation_approvals WHERE id=$1`, [cAutomationId])).rows[0].status).toBe("pending");
  });

  it("DECIDE façade: attacker cannot LAUNDER C's item through their OWN authorized tenant path (tenantId=A, id in C) — RLS makes the row invisible, so it 404s and never mutates", async () => {
    // attacker IS company_admin in A, so the authorize() gate for tenant A PASSES — the only wall
    // left is RLS. Prove RLS holds: the UPDATE/SELECT sees zero rows and the C item is untouched.
    for (const [origin, id] of [["pipeline", cPipelineGateId], ["automation", cAutomationId]] as const) {
      const r = await app.inject({
        method: "POST", url: `/api/${coA}/approvals/${id}/decide`, headers: asUser(attacker),
        payload: { origin, decision: "approved" },
      });
      expect(r.statusCode, `${origin} laundered through A must not succeed`).not.toBe(200);
    }
    expect((await adminPool().query(`SELECT status FROM pipeline_gates WHERE id=$1`, [cPipelineGateId])).rows[0].status).toBe("pending");
    expect((await adminPool().query(`SELECT status FROM automation_approvals WHERE id=$1`, [cAutomationId])).rows[0].status).toBe("pending");
  });

  it("DECIDE façade: a bad origin is a 400 and touches nothing", async () => {
    const r = await app.inject({ method: "POST", url: `/api/${coA}/approvals/${newId()}/decide`, headers: asUser(attacker), payload: { origin: "root", decision: "approved" } });
    expect(r.statusCode).toBe(400);
  });

  // ─────────────────────────── SURFACE 3: connections vault (WSUX-14) ───────────────────────────

  it("VAULT non-exposure: NO owner selector on C's connections returns anything to attacker (403), so no token path exists", async () => {
    const base = `/api/${coC}/integrations/connections`;
    for (const owner of ["company", "me", `user:${victim}`]) {
      const r = await app.inject({ method: "GET", url: `${base}?owner=${owner}`, headers: asUser(attacker) });
      expect([403], `owner=${owner}`).toContain(r.statusCode);
    }
  });

  it("VAULT FORCE-RLS (independent of the controller): the service layer itself yields ZERO of C's rows under an A-scoped tenant set", async () => {
    // getConnectionRow scopes withTenants([coA]); C's row must be invisible even though the id is valid.
    const row = await getConnectionRow(coA, cCompanyConnId);
    expect(row).toBeNull();
    // and a full list under A never contains C's connection
    const listed = await listConnections(coA, {});
    expect(listed.map((c) => c.id)).not.toContain(cCompanyConnId);
  });

  it("VAULT FORCE-RLS: a cross-tenant WRITE (A-scoped UPDATE on C's row) affects zero rows — RLS blocks the mutation at the DB", async () => {
    const affected = await withTenants([coA], async (c) => {
      const res = await c.query(`UPDATE integration_connections SET external_account = 'HIJACKED' WHERE id = $1`, [cCompanyConnId]);
      return res.rowCount;
    });
    expect(affected).toBe(0);
    // C's row is unchanged when read with a bypass pool.
    const db = await adminPool().query<{ external_account: string }>(`SELECT external_account FROM integration_connections WHERE id=$1`, [cCompanyConnId]);
    expect(db.rows[0].external_account).toBe("c-team@github");
  });

  it("VAULT: a forged / other-tenant connection id on attacker's OWN tenant route is a 404 (not a 403 that would confirm existence)", async () => {
    const base = `/api/${coA}/integrations/connections`;
    expect((await app.inject({ method: "PATCH", url: `${base}/${cCompanyConnId}`, headers: asUser(attacker), payload: { externalAccount: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${base}/${cCompanyConnId}`, headers: asUser(attacker) })).statusCode).toBe(404);
    // a syntactically-forged id likewise 404s
    expect((await app.inject({ method: "DELETE", url: `${base}/${newId()}`, headers: asUser(attacker) })).statusCode).toBe(404);
  });

  it("VAULT: even the legitimate owner (victim) reading C's own connection gets hasToken:true but ZERO token material — the enc column never serializes", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${coC}/integrations/connections?owner=company`, headers: asUser(victim) });
    expect(r.statusCode).toBe(200);
    const row = r.json().find((c: { id: string }) => c.id === cCompanyConnId);
    expect(row).toMatchObject({ hasToken: true, hasRefreshToken: true, tokenKeyVersion: "v1", status: "linked" });
    assertNoSecrets(JSON.stringify(r.json()), "vault owner read");
  });

  it("VAULT fail-closed: with INTEGRATION_TOKEN_KEY unset, a token write is refused (503) and NO plaintext lands in the DB", async () => {
    const saved = config.integrationTokenKey;
    config.integrationTokenKey = "";
    try {
      const freshConn = await createConnection(coC, { ownerKind: "user", ownerId: victim, provider: "google_drive", createdBy: victim });
      await expect(setConnectionTokens(coC, freshConn.id, { accessToken: "would_be_plaintext" })).rejects.toThrow(/vault not configured/i);
      const db = await adminPool().query<{ access_token_enc: string | null }>(`SELECT access_token_enc FROM integration_connections WHERE id=$1`, [freshConn.id]);
      expect(db.rows[0].access_token_enc).toBeNull();
    } finally {
      config.integrationTokenKey = saved;
    }
  });

  it("VAULT at-rest: C's stored value is enc:v1 ciphertext, never the plaintext", async () => {
    const db = await adminPool().query<{ access_token_enc: string; refresh_token_enc: string }>(
      `SELECT access_token_enc, refresh_token_enc FROM integration_connections WHERE id=$1`, [cCompanyConnId],
    );
    expect(db.rows[0].access_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(db.rows[0].access_token_enc).not.toContain(C_ACCESS);
    expect(db.rows[0].refresh_token_enc.startsWith("enc:v1:")).toBe(true);
    expect(db.rows[0].refresh_token_enc).not.toContain(C_REFRESH);
  });

  // ─────────────────────────── SURFACE 4: claude-seat registry (WSUX-17) ───────────────────────────

  it("SEATS: team roster is gated to company.manage — a plain member of A is denied their OWN company's roster", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${coA}/integrations/claude-seats?owner=team`, headers: asUser(memberA) });
    expect(r.statusCode).toBe(403);
  });

  it("SEATS: attacker cannot read C's team roster or a C user's seat, and a forged/cross-tenant seat id 404s", async () => {
    const base = `/api/${coC}/integrations/claude-seats`;
    expect((await app.inject({ method: "GET", url: `${base}?owner=team`, headers: asUser(attacker) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `${base}?owner=user:${victim}`, headers: asUser(attacker) })).statusCode).toBe(403);
    // forged id on attacker's OWN tenant route -> 404
    expect((await app.inject({ method: "DELETE", url: `/api/${coA}/integrations/claude-seats/${cSeatId}`, headers: asUser(attacker) })).statusCode).toBe(404);
  });

  it("SEATS inherit non-exposure EVEN WITH a token present: victim's own seat + team roster surface no plaintext/ciphertext", async () => {
    const own = await app.inject({ method: "GET", url: `/api/${coC}/integrations/claude-seats?owner=user:${victim}`, headers: asUser(victim) });
    expect(own.statusCode).toBe(200);
    assertNoSecrets(JSON.stringify(own.json()), "seat owner read");
    const roster = await app.inject({ method: "GET", url: `/api/${coC}/integrations/claude-seats?owner=team`, headers: asUser(victim) });
    expect(roster.statusCode).toBe(200);
    assertNoSecrets(JSON.stringify(roster.json()), "seat team roster");
    // sanity: the seat is actually in the roster (so we know we tested a real, token-bearing row)
    expect(roster.json().map((s: { id: string }) => s.id)).toContain(cSeatId);
  });

  it("SEATS provider confinement: the seat controller cannot mutate a NON-claude connection (github id -> 404), and that github row is left untouched", async () => {
    // victim owns a github company connection (cCompanyConnId). Attempt to drive it through the seat route.
    const seatBase = `/api/${coC}/integrations/claude-seats`;
    expect((await app.inject({ method: "PATCH", url: `${seatBase}/${cCompanyConnId}`, headers: asUser(victim), payload: { codeSeatEmail: "x" } })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: `${seatBase}/${cCompanyConnId}`, headers: asUser(victim) })).statusCode).toBe(404);
    // the github row is still linked, not revoked, and its token is intact.
    const db = await adminPool().query<{ status: string; provider: string; access_token_enc: string }>(`SELECT status, provider, access_token_enc FROM integration_connections WHERE id=$1`, [cCompanyConnId]);
    expect(db.rows[0]).toMatchObject({ status: "linked", provider: "github" });
    expect(db.rows[0].access_token_enc.startsWith("enc:v1:")).toBe(true);
  });

  // ─────────────────────────── SURFACE 5: seams BETWEEN subsystems ───────────────────────────

  it("SEAM: a token-bearing connection/seat in A never bleeds a credential into the approvals envelope", async () => {
    // give attacker's own company a token-bearing connection, then read approvals — the two
    // subsystems share the DB but must not cross-contaminate.
    const aConn = await createConnection(coA, { ownerKind: "company", ownerId: coA, provider: "github", createdBy: attacker });
    await setConnectionTokens(coA, aConn.id, { accessToken: "A_local_token_should_stay_in_vault" });
    const r = await app.inject({ method: "GET", url: `/api/approvals?scope=all`, headers: asUser(attacker) });
    const raw = JSON.stringify(r.json());
    expect(raw).not.toContain("A_local_token_should_stay_in_vault");
    expect(raw).not.toContain("enc:v1:");
    expect(raw).not.toMatch(/token_enc/);
  });

  it("SEAM: a claude-seat id cannot be used to reach a cross-tenant connection through the generic integrations route either", async () => {
    // attacker drives C's seat id through their OWN generic integrations PATCH route -> 404 (RLS).
    const r = await app.inject({ method: "PATCH", url: `/api/${coA}/integrations/connections/${cSeatId}`, headers: asUser(attacker), payload: { externalAccount: "hijack" } });
    expect(r.statusCode).toBe(404);
    // and C's seat row is unchanged.
    const db = await adminPool().query<{ external_account: string }>(`SELECT external_account FROM integration_connections WHERE id=$1`, [cSeatId]);
    expect(db.rows[0].external_account).toBe("victim@claude");
  });
});
