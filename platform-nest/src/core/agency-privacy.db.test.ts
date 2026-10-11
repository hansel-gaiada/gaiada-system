// M5-G5 — privacy find / export / erase over the agency intake data, driven over HTTP (app.inject) against
// REAL Postgres and REAL Cerbos, plus the suppression list's effect on the web intake. Every write runs as
// `platform_app_test` (NOSUPERUSER NOBYPASSRLS) through the real routes and services; `adminPool()` (superuser)
// only READS evidence.
//
// Roles: company_admin may file and run a request (Cerbos `convert` on agency_lead); a manager may not. A
// SECOND company_admin decides the WS4 approval (the requester may not: maker != checker). Every denial below
// sends a VALID body, so a validation 400 can never stand in for the 403 being asserted.
//
// Needs DATABASE_URL_TEST (+ CERBOS_URL): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { createLeadFromWebSubmission, type WebLeadsDeps } from "./agency-web-leads.service";
import { isContactSuppressed } from "./agency-privacy.service";
import { insertAutomationApprovalRow } from "./approval-filing";
import { ERASED_MARKER, subjectHash } from "./agency-privacy.subject";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("M5-G5 — agency privacy commands: WS4 flow, erase keeps rows, export, suppression, isolation", () => {
  let app: NestFastifyApplication;
  let co: string; // tenant A
  let coB: string; // tenant B
  let admin: string; // A requester
  let decider: string; // A second company_admin
  let manager: string; // A manager (no `convert`)
  let adminB: string;
  let deciderB: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    process.env.AGENCY_WEB_LEADS_ENABLED = "1";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Privacy Agency A");
    coB = await createCompany("Privacy Agency B");
    const mk = async (email: string, role: string, tenant: string) => {
      const id = await createUser(email);
      await addMembership(tenant, id);
      await grantRole(id, await createRole(role), "company", tenant);
      return id;
    };
    admin = await mk("admin@agency-privacy.test", "company_admin", co);
    decider = await mk("decider@agency-privacy.test", "company_admin", co);
    manager = await mk("manager@agency-privacy.test", "manager", co);
    adminB = await mk("admin-b@agency-privacy.test", "company_admin", coB);
    deciderB = await mk("decider-b@agency-privacy.test", "company_admin", coB);
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    delete process.env.AGENCY_WEB_LEADS_ENABLED;
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  /** A distinctive person per test, so a grep for their identifiers proves where they did (not) land. */
  function person() {
    const n = ++seq;
    return {
      name: `Ayu Privacy${n} Sari`,
      email: `ayu.privacy${n}@dsr-subject.test`,
      phone: `+62 812 7000 ${String(1000 + n)}`,
      phoneDigits: `628127000${String(1000 + n)}`,
    };
  }

  async function insertLead(tenant: string, f: {
    status?: string; stage?: string; name?: string | null; email?: string | null; phone?: string | null;
    reason?: string | null; clientId?: string | null; source?: string; submissionRef?: string | null;
  }): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage,
                                   declined_reason, converted_client_id, origin_site, submission_ref, attribution, visitor_consent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'test', $12, $13::jsonb, $14::jsonb)`,
        [
          id, tenant, f.name ?? "Org (not given)", f.name ?? null, f.email ?? null, f.phone ?? null, f.source ?? "web",
          f.status ?? "new", f.stage ?? "enquiry", f.reason ?? null, f.clientId ?? null, f.submissionRef ?? null,
          JSON.stringify({ landing: "/services/web/", utm_source: "google", gclid: `gclid-${id}` }),
          JSON.stringify({ analytics: true, marketing: true, version: "3", decided_at: "2026-10-11T09:00:00Z" }),
        ],
      ),
    );
    return id;
  }

  async function insertSubmission(tenant: string, leadId: string, answers: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_discovery_submissions (id, tenant_id, lead_id, schema_version, answers, origin_site)
         VALUES ($1, $2, $3, 'agency-discovery.2026-09-05.v1', $4::jsonb, 'test')`,
        [id, tenant, leadId, JSON.stringify(answers)],
      ),
    );
    return id;
  }

  async function insertToken(tenant: string, leadId: string): Promise<string> {
    const id = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO agency_intake_tokens (id, tenant_id, lead_id, kind, token_hash, expires_at, origin_site)
         VALUES ($1, $2, $3, 'invite', $4, now() + interval '30 days', 'test')`,
        [id, tenant, leadId, createHash("sha256").update(randomBytes(32)).digest()],
      ),
    );
    return id;
  }

  const call = (tenant: string, user: string, kind: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${tenant}/agency/privacy/${kind}`, headers: asUser(user), payload });
  const decide = (tenant: string, user: string, approvalId: string, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${tenant}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision } });

  /** File, have `by` decide, and return the approval id. */
  async function fileAndDecide(tenant: string, requester: string, by: string, kind: string, ids: Record<string, unknown>, decision: "approved" | "rejected" = "approved") {
    const filed = await call(tenant, requester, kind, ids);
    expect(filed.statusCode, filed.body).toBe(202);
    const body = filed.json() as { outcome: string; approvalId: string; requestId: string };
    expect(body.outcome).toBe("suspended");
    const d = await decide(tenant, by, body.approvalId, decision);
    expect(d.statusCode, d.body).toBe(200);
    return body;
  }

  const lead = async (id: string) =>
    (await adminPool().query(`SELECT * FROM agency_leads WHERE id = $1`, [id])).rows[0] as Record<string, unknown> | undefined;

  /** Every place an identifier must NOT land, as one text blob per table. */
  async function leakText(): Promise<string> {
    const q = async (sql: string) => (await adminPool().query<{ t: string }>(sql)).rows.map((r) => r.t).join("\n");
    return [
      await q(`SELECT tool_args::text || ' ' || coalesce(reason, '') AS t FROM automation_approvals`),
      await q(`SELECT payload::text AS t FROM outbox_events`),
      await q(`SELECT metadata::text AS t FROM activities`),
      await q(`SELECT row_to_json(d)::text AS t FROM agency_dsr_requests d`),
      await q(`SELECT row_to_json(s)::text AS t FROM agency_contact_suppressions s`),
    ].join("\n");
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // erase: the WS4 flow end to end, scrub-and-keep, CHECKs, the client link, suppression, the ledger
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("erase: files, waits, refuses the wrong caller / wrong identifiers, then scrubs every row in scope and keeps it", async () => {
    const p = person();
    const clientId = await createClient(co, `Client of ${p.name}`);
    const declined = await insertLead(co, { status: "declined", stage: "lost", name: p.name, email: p.email, phone: p.phone, reason: `${p.name} chose another agency` });
    const converted = await insertLead(co, { status: "converted", stage: "won", name: p.name, phone: p.phone, clientId });
    // A lead whose OWN contact is someone else, but whose AD-1 contact is the subject: in scope via the submission.
    const viaSub = await insertLead(co, { status: "in_review", name: "Front Desk", email: `frontdesk${seq}@villa.test` });
    const sub = await insertSubmission(co, viaSub, {
      org_name: "Villa Sari", contact_name: p.name, contact_role: "Owner", contact_email: p.email.toUpperCase(),
      contact_phone: p.phone, decision_makers: `${p.name} and Budi`, offering: "Boutique villas",
      anything_else: `Reach me at ${p.email}`,
    });
    const token = await insertToken(co, viaSub);
    const bystander = await insertLead(co, { status: "new", name: "Other Person", email: `other${seq}@dsr-subject.test` });

    // Call 1 files a HIGH approval and the ledger's filed row; nothing is read or changed.
    const filed = await call(co, admin, "erase", { email: p.email, phone: p.phone });
    expect(filed.statusCode, filed.body).toBe(202);
    const { approvalId, requestId } = filed.json() as { approvalId: string; requestId: string };
    const appr = (await adminPool().query(`SELECT impact, status, origin, tool_name, tool_args, requested_by FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0];
    expect(appr).toMatchObject({ impact: "high", status: "pending", origin: "automation", tool_name: "agency_privacy.erase", requested_by: admin });
    expect(appr.tool_args).toEqual({ kind: "erase", requestId, identifiers: ["email", "phone"] });
    const ledger1 = (await adminPool().query(`SELECT phase, kind, email_hash, phone_hash FROM agency_dsr_requests WHERE approval_id = $1`, [approvalId])).rows;
    expect(ledger1).toEqual([{ phase: "filed", kind: "erase", email_hash: subjectHash(p.email), phone_hash: subjectHash(p.phoneDigits) }]);
    expect((await lead(declined))!.contact_email).toBe(p.email);

    // Before a decision: 202 awaiting, nothing changes.
    const early = await call(co, admin, "erase", { email: p.email, phone: p.phone, approvalId });
    expect(early.statusCode).toBe(202);
    expect(early.json()).toMatchObject({ outcome: "awaiting_approval" });

    expect((await decide(co, decider, approvalId, "approved")).statusCode).toBe(200);

    // Content binding: email only is NOT what was approved (an approval never widens or changes).
    const narrower = await call(co, admin, "erase", { email: p.email, approvalId });
    expect(narrower.statusCode).toBe(400);
    expect(narrower.json()).toMatchObject({ reason: "privacy_request_mismatch" });
    // Only the requester may run it, even another company_admin of the same tenant.
    const notMine = await call(co, decider, "erase", { email: p.email, phone: p.phone, approvalId });
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json()).toMatchObject({ reason: "privacy_request_not_requester" });
    expect((await lead(declined))!.contact_email).toBe(p.email);

    // The approved re-call runs it once.
    const run = await call(co, admin, "erase", { email: p.email, phone: p.phone, approvalId });
    expect(run.statusCode, run.body).toBe(200);
    const out = run.json() as { outcome: string; replayed: boolean; counts: Record<string, number>; outOfScope: unknown[] };
    expect(out).toMatchObject({ outcome: "executed", replayed: false });
    expect(out.counts).toMatchObject({ leadCount: 3, submissionCount: 1, tokenCount: 1, outOfScopeCount: 1 });
    expect(out.counts.suppressionCount).toBeGreaterThanOrEqual(2);
    expect(out.outOfScope).toEqual([{ leadId: converted, convertedClientId: clientId, reason: "client_record_retention" }]);

    // The declined lead: scrubbed, kept, still declined/lost with a (scrubbed) reason, consent snapshot kept.
    const d = (await lead(declined))!;
    expect(d).toMatchObject({
      status: "declined", stage: "lost", org_name: "(erased)", contact_name: null, contact_email: null, contact_phone: null,
      attribution: null, declined_reason: "(erased)",
    });
    expect(d.erased_at).not.toBeNull();
    expect(d.visitor_consent).toMatchObject({ marketing: true, version: "3" });
    // The converted lead: scrubbed, but its client link and the client record are untouched.
    const cv = (await lead(converted))!;
    expect(cv).toMatchObject({ status: "converted", stage: "won", converted_client_id: clientId, contact_phone: null, contact_name: null });
    expect((await adminPool().query(`SELECT name FROM clients WHERE id = $1`, [clientId])).rows[0].name).toBe(`Client of ${p.name}`);
    // The lead in scope through its AD-1 submission: scrubbed too; the person answers erased, business kept.
    expect((await lead(viaSub))!).toMatchObject({ status: "in_review", contact_email: null, contact_name: null });
    const s = (await adminPool().query(`SELECT answers, erased_at FROM agency_discovery_submissions WHERE id = $1`, [sub])).rows[0];
    expect(s.erased_at).not.toBeNull();
    expect(s.answers).toMatchObject({
      contact_name: ERASED_MARKER, contact_role: ERASED_MARKER, contact_email: ERASED_MARKER, contact_phone: ERASED_MARKER,
      decision_makers: ERASED_MARKER, org_name: "Villa Sari", offering: "Boutique villas", anything_else: `Reach me at ${ERASED_MARKER}`,
    });
    expect((await adminPool().query(`SELECT revoked_at FROM agency_intake_tokens WHERE id = $1`, [token])).rows[0].revoked_at).not.toBeNull();
    // A bystander is untouched.
    expect((await lead(bystander))!.erased_at).toBeNull();

    // The CHECKs still hold on the scrubbed rows, and an erased row can never get a contact back.
    await expect(
      withTenants([co], (c) => c.query(`UPDATE agency_leads SET contact_email = 'back@x.test' WHERE id = $1`, [declined])),
    ).rejects.toThrow(/lead_erased_holds_no_contact/);
    await expect(
      withTenants([co], (c) => c.query(`UPDATE agency_leads SET declined_reason = NULL WHERE id = $1`, [declined])),
    ).rejects.toThrow(/lead_declined_has_reason/);

    // Suppression (hashed) for both identifiers; the ledger has filed + executed; no identifier landed anywhere.
    const sup = (await adminPool().query(`SELECT contact_kind, contact_hash, scope, reason FROM agency_contact_suppressions WHERE tenant_id = $1`, [co])).rows;
    expect(sup).toEqual(expect.arrayContaining([
      { contact_kind: "email", contact_hash: subjectHash(p.email), scope: "all", reason: "erasure" },
      { contact_kind: "phone", contact_hash: subjectHash(p.phoneDigits), scope: "all", reason: "erasure" },
    ]));
    const phases = (await adminPool().query(`SELECT phase FROM agency_dsr_requests WHERE approval_id = $1 ORDER BY created_at`, [approvalId])).rows.map((r) => r.phase);
    expect(phases).toEqual(["filed", "executed"]);
    const text = await leakText();
    for (const pii of [p.email, p.email.toUpperCase(), p.phone, p.phoneDigits, p.name]) expect(text).not.toContain(pii);

    // A replay of the same approval returns the stored counts and changes nothing.
    const again = await call(co, admin, "erase", { email: p.email, phone: p.phone, approvalId });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "executed", replayed: true, counts: { leadCount: 3, submissionCount: 1, tokenCount: 1 } });
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM agency_dsr_requests WHERE approval_id = $1`, [approvalId])).rows[0].n).toBe(2);
  });

  it("the ledger is append-only, even for the app role", async () => {
    const p = person();
    await fileAndDecide(co, admin, decider, "find", { email: p.email });
    await expect(withTenants([co], (c) => c.query(`UPDATE agency_dsr_requests SET kind = 'find' WHERE tenant_id = $1`, [co]))).rejects.toThrow(/append-only/);
    await expect(withTenants([co], (c) => c.query(`DELETE FROM agency_dsr_requests WHERE tenant_id = $1`, [co]))).rejects.toThrow(/append-only/);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // export / find
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("export returns the person's lead data, AD-1 answers and token history once; a re-use is 409", async () => {
    const p = person();
    const id = await insertLead(co, { status: "submitted", name: p.name, email: p.email, phone: p.phone, submissionRef: newId() });
    await insertSubmission(co, id, { contact_name: p.name, contact_email: p.email, offering: "Surf school" });
    await insertToken(co, id);
    const { approvalId } = await fileAndDecide(co, admin, decider, "export", { phone: p.phone });

    const r = await call(co, admin, "export", { phone: p.phone, approvalId });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { leads: Array<Record<string, unknown>>; counts: Record<string, number> };
    expect(body.counts).toMatchObject({ leadCount: 1, submissionCount: 1, tokenCount: 1, outOfScopeCount: 0 });
    expect(body.leads).toHaveLength(1);
    const l = body.leads[0];
    expect(l).toMatchObject({
      leadId: id, status: "submitted", directMatch: true, contactName: p.name, contactEmail: p.email, contactPhone: p.phone,
      attribution: { landing: "/services/web/", utm_source: "google" }, visitorConsent: { marketing: true },
    });
    expect((l.submissions as Array<{ answers: unknown }>)[0].answers).toMatchObject({ contact_email: p.email, offering: "Surf school" });
    expect(l.intakeTokens as unknown[]).toHaveLength(1);
    expect(JSON.stringify(l.intakeTokens)).not.toMatch(/token_hash|tokenHash/);
    // Export reads; it changes nothing.
    expect((await lead(id))!.contact_email).toBe(p.email);

    const reuse = await call(co, admin, "export", { phone: p.phone, approvalId });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json()).toMatchObject({ reason: "approval_already_used" });
    // The export's personal data was never stored anywhere durable.
    const text = await leakText();
    for (const pii of [p.email, p.phone, p.name]) expect(text).not.toContain(pii);
  });

  it("find lists matches with no contact data; an unknown person is a clean empty result, still ledgered", async () => {
    const p = person();
    const id = await insertLead(co, { status: "new", name: p.name, email: p.email });
    const { approvalId } = await fileAndDecide(co, admin, decider, "find", { email: p.email.toUpperCase() });
    const r = await call(co, admin, "find", { email: p.email.toUpperCase(), approvalId });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as { leads: Array<Record<string, unknown>> };
    expect(body.leads.map((x) => x.leadId)).toEqual([id]);
    expect(JSON.stringify(body.leads)).not.toContain(p.email);

    const nobody = person();
    const n = await fileAndDecide(co, admin, decider, "find", { email: nobody.email });
    const r2 = await call(co, admin, "find", { email: nobody.email, approvalId: n.approvalId });
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ leads: [], counts: { leadCount: 0 } });
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM agency_dsr_requests WHERE approval_id = $1 AND phase = 'executed'`, [n.approvalId])).rows[0].n).toBe(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // WS4 gating
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("a manager is refused (403, valid body) and nothing is filed", async () => {
    const p = person();
    const before = (await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n;
    for (const kind of ["find", "export", "erase"]) {
      const r = await call(co, manager, kind, { email: p.email });
      expect(r.statusCode, kind).toBe(403);
    }
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n).toBe(before);
  });

  it("a self-approved request never runs (maker != checker), and a rejected one is 409", async () => {
    const p = person();
    const id = await insertLead(co, { status: "new", name: p.name, email: p.email });
    const self = await fileAndDecide(co, admin, admin, "erase", { email: p.email });
    const r = await call(co, admin, "erase", { email: p.email, approvalId: self.approvalId });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ reason: "self_approved" });
    expect((await lead(id))!.contact_email).toBe(p.email);

    const rej = await fileAndDecide(co, admin, decider, "erase", { email: p.email }, "rejected");
    const r2 = await call(co, admin, "erase", { email: p.email, approvalId: rej.approvalId });
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toMatchObject({ reason: "approval_rejected" });
    expect((await lead(id))!.contact_email).toBe(p.email);
  });

  it("an approval filed for find cannot run an erase, and an approval no route filed is refused", async () => {
    const p = person();
    const id = await insertLead(co, { status: "new", email: p.email });
    const f = await fileAndDecide(co, admin, decider, "find", { email: p.email });
    const r = await call(co, admin, "erase", { email: p.email, approvalId: f.approvalId });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ reason: "privacy_request_mismatch" });
    // A hand-filed approval row with matching-looking args (what any member can file through
    // POST /automation-approvals) is NOT a privacy request: the binding is the ledger's filed row, never tool_args.
    const forgedId = newId();
    await withTenants([co], (c) =>
      insertAutomationApprovalRow(c, forgedId, {
        tenantId: co, workflowId: "agency-privacy:forged", toolName: "agency_privacy.erase",
        toolArgs: { kind: "erase", requestId: newId(), identifiers: ["email"] }, impact: "high", origin: "automation", requestedBy: admin,
      }),
    );
    expect((await decide(co, decider, forgedId, "approved")).statusCode).toBe(200);
    const r2 = await call(co, admin, "erase", { email: p.email, approvalId: forgedId });
    expect(r2.statusCode).toBe(404);
    expect(r2.json()).toMatchObject({ reason: "privacy_request_not_found" });
    expect((await lead(id))!.contact_email).toBe(p.email);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // suppression: no re-intake, no ad upload
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("after an erase the web intake stores nothing for that person; P2's check says 'do not upload'", async () => {
    const p = person();
    await insertLead(co, { status: "new", name: p.name, email: p.email, phone: p.phone });
    const e = await fileAndDecide(co, admin, decider, "erase", { email: p.email });
    expect((await call(co, admin, "erase", { email: p.email, approvalId: e.approvalId })).statusCode).toBe(200);

    const submissionId = newId();
    const deps: WebLeadsDeps = {
      async assertTenantOwnsSite(tenantId, slug) {
        if (tenantId !== co || slug !== "gaiada") throw new NotFoundException("site_not_found");
      },
      async fetchSubmission(_slug, id) {
        // The person comes back through the contact form, with a differently-cased email.
        return {
          submissionId: id, formId: "f", formKey: "contact", siteSlug: "gaiada", createdAt: "2026-10-12T09:00:00Z", status: "new",
          fields: { name: p.name, email_address: p.email.toUpperCase(), phone_number: "" },
          attribution: { landing: "/contact/" }, visitorConsent: { analytics: true, marketing: true, version: "3" },
        };
      },
    };
    expect(await createLeadFromWebSubmission({ tenantId: co, siteSlug: "gaiada", submissionId }, deps)).toEqual({ outcome: "suppressed" });
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM agency_leads WHERE submission_ref = $1`, [submissionId])).rows[0].n).toBe(0);
    // The lead's own phone was suppressed too (the person's other key, from a lead that matched directly).
    const viaPhone = { ...deps, async fetchSubmission(_s: string, id: string) {
      return { submissionId: id, formId: "f", formKey: "contact", siteSlug: "gaiada", fields: { name: "X", email_address: "fresh@x.test", phone_number: p.phone } };
    } };
    expect(await createLeadFromWebSubmission({ tenantId: co, siteSlug: "gaiada", submissionId: newId() }, viaPhone)).toEqual({ outcome: "suppressed" });

    // P2's gate, and its tenant scope.
    expect(await withTenants([co], (c) => isContactSuppressed(c, co, { email: p.email }, "ad_upload"))).toBe(true);
    expect(await withTenants([co], (c) => isContactSuppressed(c, co, { email: p.email }, "intake"))).toBe(true);
    expect(await withTenants([coB], (c) => isContactSuppressed(c, coB, { email: p.email }, "ad_upload"))).toBe(false);
    // Another person is unaffected.
    const other = person();
    expect(await withTenants([co], (c) => isContactSuppressed(c, co, { email: other.email, phone: other.phone }, "ad_upload"))).toBe(false);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // cross-tenant isolation (valid bodies)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("tenant B can neither reach A's route, nor run A's approval, nor find or erase A's leads from its own tenant", async () => {
    const p = person();
    const idA = await insertLead(co, { status: "new", name: p.name, email: p.email });

    // B's admin on A's route: Cerbos refuses (not a member of A), valid body.
    const cross = await call(co, adminB, "erase", { email: p.email });
    expect(cross.statusCode).toBe(403);

    // A's approval presented on B's route: invisible under B's tenant wall.
    const a = await fileAndDecide(co, admin, decider, "erase", { email: p.email });
    const steal = await call(coB, adminB, "erase", { email: p.email, approvalId: a.approvalId });
    expect(steal.statusCode).toBe(404);
    expect((await lead(idA))!.contact_email).toBe(p.email);

    // B's own erase for the same person runs in B and finds nothing of A's.
    const b = await fileAndDecide(coB, adminB, deciderB, "erase", { email: p.email });
    const runB = await call(coB, adminB, "erase", { email: p.email, approvalId: b.approvalId });
    expect(runB.statusCode, runB.body).toBe(200);
    expect(runB.json()).toMatchObject({ counts: { leadCount: 0 } });
    expect((await lead(idA))!.contact_email).toBe(p.email);
    // B's suppression lives in B only.
    expect(await withTenants([co], (c) => isContactSuppressed(c, co, { email: p.email }, "intake"))).toBe(false);
    // RLS: B's ledger rows are invisible to A's tenant context.
    const seen = await withTenants([co], (c) => c.query(`SELECT count(*)::int AS n FROM agency_dsr_requests WHERE approval_id = $1`, [b.approvalId]));
    expect(seen.rows[0].n).toBe(0);
  });
});
