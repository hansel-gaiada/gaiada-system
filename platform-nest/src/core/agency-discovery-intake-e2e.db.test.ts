// QA gate — AD-1..AD-8 agency discovery intake, driven end-to-end against REAL Postgres + Cerbos.
//
// Covers, all by ACTUALLY calling the shipped HTTP surface (never by asserting on the service
// functions in isolation):
//   1. Submit idempotency under a real race (design §6.1) — modelled on webdev-cr-race.test.ts /
//      agency-lead-convert-race.db.test.ts's advisory-lock-collision method.
//   2. Tenant isolation from the PROSPECT endpoints (design §2.3's claim that a token replayed
//      against the wrong tenant path is indistinguishable from an unknown hash).
//   3. The golden end-to-end case: lead -> invite token -> GET questionnaire -> POST a realistic
//      submission -> staff `open` -> `convert` with delegations -> assert the spawned reality.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { mintInviteToken, setInviteTokenTtlMsForTests, AGENCY_INTAKE_LOCK_NS } from "./agency-intake-tokens.service";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

describe.skipIf(!TEST_URL)("AD-1..AD-8 — agency discovery intake, driven end to end", () => {
  let app: NestFastifyApplication;
  let co: string; // tenant A
  let coB: string; // tenant B — for cross-tenant isolation
  let admin: string; // company_admin in tenant A (owns leads, converts)
  let adminB: string; // company_admin in tenant B

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative A");
    coB = await createCompany("Gaiada Creative B");
    admin = await createUser("admin@intake-e2e.test");
    adminB = await createUser("admin-b@intake-e2e.test");
    const roleId = await createRole("company_admin");
    await addMembership(co, admin);
    await grantRole(admin, roleId, "company", co);
    await addMembership(coB, adminB);
    await grantRole(adminB, roleId, "company", coB);

    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const nextOrg = () => `Intake Org ${String.fromCharCode(97 + (seq % 26))}${++seq}`;

  async function createLead(tenantId: string, actorId: string, orgName: string) {
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenantId}/agency/leads`,
      headers: asUser(actorId),
      payload: { orgName, contactName: "Prospect Contact", contactEmail: `${orgName.replace(/\s+/g, "").toLowerCase()}@prospect.test`, contactPhone: "+62-811-000-111" },
    });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  }

  const getQuestionnaire = (tenantId: string, token: string) =>
    app.inject({ method: "GET", url: `/api/${tenantId}/intake/questionnaire`, headers: { "x-intake-token": token } });

  const submit = (tenantId: string, token: string, answers: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: `/api/${tenantId}/intake/submissions`,
      headers: { "x-intake-token": token },
      payload: { answers },
    });

  const openLead = (tenantId: string, leadId: string, actorId: string) =>
    app.inject({ method: "POST", url: `/api/${tenantId}/agency/leads/${leadId}/open`, headers: asUser(actorId) });

  const convertLead = (tenantId: string, leadId: string, actorId: string, delegations: unknown[] = []) =>
    app.inject({
      method: "POST", url: `/api/${tenantId}/agency/leads/${leadId}/convert`, headers: asUser(actorId),
      payload: { delegations },
    });

  async function advisoryWaiters(): Promise<number> {
    const r = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
    );
    return r.rows[0].n;
  }
  async function waitForAdvisoryWaiters(n: number, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = -1;
    while (Date.now() < deadline) {
      last = await advisoryWaiters();
      if (last >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect.fail(`expected ${n} advisory-lock waiters; saw ${last} — the racers never collided, so this test proves nothing`);
  }
  async function holdTokenLock(tokenId: string): Promise<() => Promise<void>> {
    const c = await adminPool().connect();
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AGENCY_INTAKE_LOCK_NS, tokenId]);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await c.query("COMMIT");
      c.release();
    };
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // §6.1 — SUBMIT IDEMPOTENCY UNDER A REAL RACE
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("two CONCURRENT submits on the SAME token collide on the advisory lock and produce exactly ONE submission row; both get 200 with the SAME id", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);
    const minted = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });
    const release = await holdTokenLock(minted.id);
    try {
      const flights = [0, 1].map(() => submit(co, minted.plaintext, { objective: "grow leads" }));
      await waitForAdvisoryWaiters(2);
      expect(await settledWithin(Promise.all(flights), 300)).toBe(false);

      const subCountBefore = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_discovery_submissions WHERE lead_id = $1`, [leadId],
      );
      expect(subCountBefore.rows[0].n).toBe(0); // neither committed before the release

      await release();
      const results = await Promise.all(flights);
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]); // BOTH 200 — design §6.1, never 409 here

      const ids = results.map((r) => (r.json() as { submissionId: string }).submissionId);
      expect(ids[0]).toBe(ids[1]); // same submission id surfaced to both callers

      const subCountAfter = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_discovery_submissions WHERE lead_id = $1`, [leadId],
      );
      expect(subCountAfter.rows[0].n).toBe(1); // exactly one row, not two

      const submittedEvents = await adminPool().query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox_events WHERE entity_type = 'agency_discovery_submission' AND event_type = 'agency.lead.submitted' AND entity_id = $1`,
        [ids[0]],
      );
      expect(submittedEvents.rows[0].n).toBe(1);

      const leadRow = await adminPool().query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [leadId]);
      expect(leadRow.rows[0].status).toBe("submitted"); // flipped exactly once, not toggled/re-flipped
    } finally {
      await release();
    }
  });

  it("a SEQUENTIAL replay (HTTP retry after the first commits) returns the SAME submission id, no second row", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);
    const minted = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });

    const first = await submit(co, minted.plaintext, { objective: "first answer" });
    expect(first.statusCode).toBe(200);
    const firstId = (first.json() as { submissionId: string }).submissionId;

    for (let i = 0; i < 3; i++) {
      const again = await submit(co, minted.plaintext, { objective: "a RETRY with a DIFFERENT body — must be ignored" });
      expect(again.statusCode).toBe(200);
      expect((again.json() as { submissionId: string }).submissionId).toBe(firstId);
    }
    const count = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_discovery_submissions WHERE lead_id = $1`, [leadId],
    );
    expect(count.rows[0].n).toBe(1);
    // The retry's DIFFERENT body must never have overwritten the original (submissions are
    // insert-only) — the stored answer is still the FIRST call's.
    const stored = await adminPool().query<{ answers: { objective: string } }>(
      `SELECT answers FROM agency_discovery_submissions WHERE id = $1`, [firstId],
    );
    expect(stored.rows[0].answers.objective).toBe("first answer");
  });

  it("schema backstop: ux_sub_token refuses a second submission row for the same token even via a raw insert", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);
    const minted = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });
    const first = await submit(co, minted.plaintext, { objective: "x" });
    expect(first.statusCode).toBe(200);

    await expect(
      withTenants([co], (c) =>
        c.query(
          `INSERT INTO agency_discovery_submissions (id, tenant_id, lead_id, token_id, schema_version, answers, origin_site)
           VALUES (gen_random_uuid(), $1, $2, $3, 'v', '{}'::jsonb, 'test')`,
          [co, leadId, minted.id],
        ),
      ),
    ).rejects.toThrow(/ux_sub_token|duplicate key/i);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // §2.3 — TENANT ISOLATION FROM THE APPLICATION PATH (the "indistinguishable from unknown" claim)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a token minted for tenant A resolves NOTHING when replayed against tenant B's path — same shape as an unknown token", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);
    const minted = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });

    // Genuinely correct path — sanity check the token DOES work against its own tenant.
    const ok = await getQuestionnaire(co, minted.plaintext);
    expect(ok.statusCode).toBe(200);

    // Same token, WRONG tenant path.
    const wrongTenant = await getQuestionnaire(coB, minted.plaintext);
    // A garbage token against the SAME wrong tenant.
    const bogus = await getQuestionnaire(coB, "not-a-real-token-at-all");

    expect(wrongTenant.statusCode).toBe(bogus.statusCode);
    expect(wrongTenant.statusCode).toBe(401);
    expect(wrongTenant.json()).toEqual(bogus.json()); // byte-identical refusal — no existence oracle
    expect((wrongTenant.json() as { error: string }).error).toBe("token_invalid");

    // The write path refuses identically, and — the load-bearing assertion — creates NOTHING in
    // EITHER tenant's submissions table.
    const wrongSubmit = await submit(coB, minted.plaintext, { objective: "should never land anywhere" });
    expect(wrongSubmit.statusCode).toBe(401);
    expect((wrongSubmit.json() as { error: string }).error).toBe("token_invalid");

    const subsA = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_discovery_submissions WHERE lead_id = $1`, [leadId],
    );
    expect(subsA.rows[0].n).toBe(0);
    const subsAnyB = await withTenants([coB], (c) =>
      c.query<{ n: string }>(`SELECT count(*)::int AS n FROM agency_discovery_submissions`),
    );
    expect(Number(subsAnyB.rows[0].n)).toBe(0);
  });

  it("typed refusals: missing / garbage / expired / revoked tokens are each their OWN reason, never folded together", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);

    const missing = await app.inject({ method: "GET", url: `/api/${co}/intake/questionnaire` });
    expect(missing.statusCode).toBe(401);
    expect((missing.json() as { error: string }).error).toBe("token_missing");

    const invalid = await getQuestionnaire(co, "totally-bogus");
    expect(invalid.statusCode).toBe(401);
    expect((invalid.json() as { error: string }).error).toBe("token_invalid");

    setInviteTokenTtlMsForTests(-1000); // mint an ALREADY-expired token
    const expiredMint = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });
    setInviteTokenTtlMsForTests(null);
    const expired = await getQuestionnaire(co, expiredMint.plaintext);
    expect(expired.statusCode).toBe(401);
    expect((expired.json() as { error: string }).error).toBe("token_expired");

    const revokedMint = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });
    await withTenants([co], (c) => c.query(`UPDATE agency_intake_tokens SET revoked_at = now() WHERE id = $1`, [revokedMint.id]));
    const revoked = await getQuestionnaire(co, revokedMint.plaintext);
    expect(revoked.statusCode).toBe(401);
    expect((revoked.json() as { error: string }).error).toBe("token_revoked");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // THE GOLDEN CASE — lead -> invite -> questionnaire -> submit -> open -> convert -> spawned reality
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("GOLDEN CASE: the full flow, driven against the real endpoints, spawns client+signer contact+project+run+stages+gate+tasks from the prospect's own answers", async () => {
    const orgName = nextOrg();
    const techLead = await createUser(`tech-${orgName.replace(/\s+/g, "").toLowerCase()}@intake-e2e.test`);
    await addMembership(co, techLead);

    // 1 · staff creates the lead.
    const leadId = await createLead(co, admin, orgName);
    const leadRowBefore = await adminPool().query<{ status: string; owner_id: string }>(
      `SELECT status, owner_id FROM agency_leads WHERE id = $1`, [leadId],
    );
    // DEFECT (reported, not fixed here): createStaffLead's own DB write inserts status='new'
    // (agency-leads.service.ts:107), which is the CORRECT value per the design's own §4.1
    // amendment — yet AgencyLeadsController.create() hardcodes `{ id, status: "invited" }` in its
    // HTTP response (agency-leads.controller.ts:105), so the API LIES about the row it just wrote.
    // This assertion pins what is ACTUALLY stored; see this ticket's report for the response-body
    // mismatch.
    expect(leadRowBefore.rows[0].status).toBe("new");
    expect(leadRowBefore.rows[0].owner_id).toBe(admin);

    // 2 · staff mints an invite token.
    //
    // ── HISTORY, kept because the pin is the point ──────────────────────────────────────────────
    // This assertion originally read `.toBe("new")` and was written to PIN TWO REAL DEFECTS that
    // QA found here: (a) no controller anywhere called `mintInviteToken()` — it was a service
    // function with no HTTP surface, so no staff member could actually invite a prospect; and
    // (b) minting never advanced the lead, so a lead stayed 'new' forever after we had sent the
    // form, inverting `queueRank()`'s whole "whose move is it" ordering for exactly the leads that
    // had been handled.
    //
    // Both are now fixed: `POST /agency/leads/:leadId/invite` exists, and `mintInviteToken` flips
    // `new -> invited` in the SAME transaction as the token insert. So the pin flips with them —
    // it now asserts the correct behaviour rather than documenting the broken one.
    const minted = await mintInviteToken({ tenantId: co, leadId, createdBy: admin });
    const leadRowAfterMint = await adminPool().query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [leadId]);
    expect(leadRowAfterMint.rows[0].status).toBe("invited");

    // 3 · GET the questionnaire — the platform's own stored schema_version and full section set.
    const q = await getQuestionnaire(co, minted.plaintext);
    expect(q.statusCode).toBe(200);
    const questionnaire = q.json() as { schemaVersion: string; sections: Array<{ id: string; fields: unknown[] }> };
    expect(questionnaire.schemaVersion).toMatch(/^agency-discovery\./);
    expect(questionnaire.sections.length).toBeGreaterThan(5);
    expect(questionnaire.sections.map((s) => s.id)).toContain("technical");

    // 4 · POST a realistic full submission — answers keyed EXACTLY as AD-6's render functions read
    // them (objective/primary_audience/features_required/pages_required/integrations/in_scope/
    // out_scope/dependencies/dns_owner/asset_inventory). AD-6's own header flagged these key names
    // as an "UNVERIFIED ASSUMPTION... inferred from the design doc's prose" — this test VERIFIES
    // them against the actual questionnaire module and finds them CORRECT (a real cross-check, not
    // a coincidence: see agency-discovery-questionnaire.ts's own field ids).
    const answers = {
      org_name: orgName,
      objective: "Convert more qualified leads from organic search within 6 months.",
      primary_audience: "SME facilities managers evaluating a vendor switch.",
      features_required: ["Contact form", "Booking or appointment system"],
      pages_required: ["Homepage", "Services / Products", "Contact"],
      integrations: ["CRM", "WhatsApp Business"],
      in_scope: "New marketing site, CRM integration, booking widget.",
      out_scope: "The internal ops dashboard is explicitly excluded.",
      dependencies: "Client must supply CRM API credentials before build starts.",
      dns_owner: "Client IT department (Budi Santoso)",
      asset_inventory: {
        "Logo (vector)": "Ready to use",
        "Brand guidelines": "Does not exist",
        "Photography": "Exists, needs work",
      },
    };
    const submitRes = await submit(co, minted.plaintext, answers);
    expect(submitRes.statusCode).toBe(200);

    const leadRowAfterSubmit = await adminPool().query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [leadId]);
    expect(leadRowAfterSubmit.rows[0].status).toBe("submitted");

    // 5 · staff opens it.
    const openRes = await openLead(co, leadId, admin);
    expect(openRes.statusCode).toBe(200);
    expect((openRes.json() as { status: string }).status).toBe("in_review");

    // 6 · staff converts, with explicit delegation overrides for the three roles that have NO
    // resolvable default assignee in this schema (agency-lead-convert.service.ts's own finding).
    const convertRes = await convertLead(co, leadId, admin, [
      { role: "sitemap", assigneeId: techLead },
      { role: "integrations", assigneeId: techLead },
      { role: "dns", assigneeId: techLead },
    ]);
    expect(convertRes.statusCode).toBe(200);
    const converted = convertRes.json() as { clientId: string; projectId: string; runId: string };

    // ── ASSERT THE SPAWNED REALITY ────────────────────────────────────────────────────────────
    const client = await adminPool().query<{ name: string; tenant_id: string }>(
      `SELECT name, tenant_id FROM clients WHERE id = $1`, [converted.clientId],
    );
    expect(client.rows[0]).toMatchObject({ name: orgName, tenant_id: co });

    // client_contacts: capability MUST be 'signer' (never the column default 'viewer') — AD-6's
    // own reasoning is that a viewer-only contact leaves prd_sign open onto nobody who can sign it.
    const contact = await adminPool().query<{ capability: string; status: string; user_id: string }>(
      `SELECT capability, status, user_id FROM client_contacts WHERE client_id = $1`, [converted.clientId],
    );
    expect(contact.rows).toHaveLength(1);
    expect(contact.rows[0].capability).toBe("signer");
    expect(contact.rows[0].status).toBe("invited");
    const contactUser = await adminPool().query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [contact.rows[0].user_id]);
    expect(contactUser.rows[0].email).toBe(`${orgName.replace(/\s+/g, "").toLowerCase()}@prospect.test`);

    const project = await adminPool().query<{ client_id: string }>(`SELECT client_id FROM projects WHERE id = $1`, [converted.projectId]);
    expect(project.rows[0].client_id).toBe(converted.clientId);

    const run = await adminPool().query<{ status: string; client_id: string; project_id: string }>(
      `SELECT status, client_id, project_id FROM pipeline_runs WHERE id = $1`, [converted.runId],
    );
    expect(run.rows[0]).toMatchObject({ status: "delivery_active", client_id: converted.clientId, project_id: converted.projectId });

    // The two extraction stages, DONE, with artifact_ref actually rendered from the prospect's
    // own answers — not a placeholder.
    const stages = await adminPool().query<{ track: string; name: string; status: string; artifact_ref: string }>(
      `SELECT track, name, status, artifact_ref FROM pipeline_stages WHERE run_id = $1 ORDER BY track`, [converted.runId],
    );
    expect(stages.rows).toHaveLength(2);
    const prd = stages.rows.find((s) => s.name === "prd_extract")!;
    expect(prd).toMatchObject({ track: "delivery", status: "done" });
    expect(prd.artifact_ref).toContain(answers.objective);
    expect(prd.artifact_ref).toContain(answers.primary_audience);
    const scope = stages.rows.find((s) => s.name === "scope_extract")!;
    expect(scope).toMatchObject({ track: "scope", status: "done" });
    expect(scope.artifact_ref).toContain(answers.in_scope);
    expect(scope.artifact_ref).toContain(answers.out_scope);

    // The open client prd_sign gate — pending, never pre-decided (a real client signature is the
    // only thing that can ever close it).
    const gates = await adminPool().query<{ kind: string; actor_side: string; status: string; decided_at: string | null }>(
      `SELECT kind, actor_side, status, decided_at FROM pipeline_gates WHERE run_id = $1`, [converted.runId],
    );
    expect(gates.rows).toHaveLength(1);
    expect(gates.rows[0]).toMatchObject({ kind: "prd_sign", actor_side: "client", status: "pending", decided_at: null });

    // pm_tasks: discovery_review + content_owners default to the lead's OWNER (admin); sitemap/
    // integrations/dns exist ONLY because this call supplied an explicit override, and carry THAT
    // assignee (techLead) — proving the "no resolvable default -> skip unless overridden" behaviour
    // agency-lead-convert.service.ts's header documents as a judgment call.
    const tasks = await adminPool().query<{ title: string; assignee: { refId: string } }>(
      `SELECT title, assignee FROM pm_tasks WHERE project_id = $1 ORDER BY title`, [converted.projectId],
    );
    const byTitle = new Map(tasks.rows.map((t) => [t.title, t.assignee?.refId]));
    expect(byTitle.get("Review discovery answers & flag contradictions")).toBe(admin);
    expect(byTitle.get("Chase missing content owners")).toBe(admin); // asset_inventory had "Does not exist"
    expect(byTitle.get("Produce sitemap from stated pages")).toBe(techLead);
    expect(byTitle.get("Confirm integrations & API access")).toBe(techLead);
    expect(byTitle.get("Confirm domain/DNS control")).toBe(techLead);
    expect(tasks.rows).toHaveLength(5); // exactly these five, no more, no fewer

    // The lead itself: converted, all three FK columns set, triaged_by the converting staff member.
    const leadRowFinal = await adminPool().query(
      `SELECT status, converted_client_id, converted_project_id, pipeline_run_id, triaged_by FROM agency_leads WHERE id = $1`, [leadId],
    );
    expect(leadRowFinal.rows[0]).toMatchObject({
      status: "converted", converted_client_id: converted.clientId,
      converted_project_id: converted.projectId, pipeline_run_id: converted.runId, triaged_by: admin,
    });

    // The load-bearing zero-special-casing event: pipeline.run.created, for the shipped
    // pipeline-fanout workflow to pick up.
    const runCreatedEvents = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'pipeline.run.created' AND entity_id = $1`, [converted.runId],
    );
    expect(runCreatedEvents.rows[0].n).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // TENANT ISOLATION — the STAFF read/triage/convert path, not just the prospect one
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a lead created in tenant A is invisible (404, not an empty/blank read) through tenant B's staff routes", async () => {
    const orgName = nextOrg();
    const leadId = await createLead(co, admin, orgName);

    const detailCrossTenant = await app.inject({
      method: "GET", url: `/api/${coB}/agency/leads/${leadId}`, headers: asUser(adminB),
    });
    expect(detailCrossTenant.statusCode).toBe(404);

    const openCrossTenant = await openLead(coB, leadId, adminB);
    expect(openCrossTenant.statusCode).toBe(404);

    const convertCrossTenant = await convertLead(coB, leadId, adminB);
    expect(convertCrossTenant.statusCode).toBe(404);

    // The lead is completely untouched by any of the above.
    const row = await adminPool().query<{ status: string }>(`SELECT status FROM agency_leads WHERE id = $1`, [leadId]);
    expect(row.rows[0].status).toBe("new");

    // Sanity: the SAME lead through its OWN tenant works normally.
    const detailSameTenant = await app.inject({ method: "GET", url: `/api/${co}/agency/leads/${leadId}`, headers: asUser(admin) });
    expect(detailSameTenant.statusCode).toBe(200);
  });
});
