// M5-G5b — an UNATTENDED `agency_privacy.*` call (an agent suspended by the mcp-hub, filing through
// `POST /automation-approvals` exactly as the hub's `approvals.request` tool does) against REAL Postgres and REAL
// Cerbos, over HTTP (app.inject). Proves, with distinctive identifiers, that neither the email nor the phone (nor a
// lower-cased / normalised form) lands in the approval row (every column), the outbox, the activity log, the
// notifications, the DSR ledger, the suppression list, the captured logs, or any approvals read shape; and that the
// approval still EXECUTES correctly once a second person approves, by rebuilding the subject from its hashes.
//
// Every write runs as `platform_app_test` (NOSUPERUSER NOBYPASSRLS) through the real routes; `adminPool()` only reads
// evidence. Every denial sends a VALID body, so validation can never stand in for the 403 asserted.
//
// Needs DATABASE_URL_TEST (+ CERBOS_URL): the Linux gate. Skips without it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { ERASED_MARKER, subjectHash } from "./agency-privacy.subject";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("M5-G5b — unattended agency_privacy.*: hashes only in every store, and it still executes after a second person approves", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string; // requester: holds `convert`
  let decider: string; // a second company_admin
  let manager: string; // no `convert`

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Privacy Unattended A");
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    admin = await mk("admin@privacy-unattended.test", "company_admin");
    decider = await mk("decider@privacy-unattended.test", "company_admin");
    manager = await mk("manager@privacy-unattended.test", "manager");
    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  function person() {
    const n = ++seq;
    return {
      name: `Budi Unattended${n} Wijaya`,
      email: `budi.unattended${n}@dsr-unattended.test`,
      phone: `+62 813 5000 ${String(2000 + n)}`,
      phoneDigits: `628135000${String(2000 + n)}`,
      national: `0813 5000 ${String(2000 + n)}`,
    };
  }
  const forms = (p: ReturnType<typeof person>) => [
    p.email, p.email.toUpperCase(), p.phone, p.phoneDigits, p.name, p.national, p.phoneDigits.slice(2), `budi.unattended${seq}`,
  ];

  async function insertLead(f: { name?: string | null; email?: string | null; phone?: string | null; status?: string; reason?: string | null }): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_leads (id, tenant_id, org_name, contact_name, contact_email, contact_phone, source, status, stage,
                                   declined_reason, origin_site, attribution, visitor_consent)
         VALUES ($1, $2, $3, $4, $5, $6, 'web', $7, $8, $9, 'test', $10::jsonb, $11::jsonb)`,
        [
          id, co, f.name ?? "Org (not given)", f.name ?? null, f.email ?? null, f.phone ?? null, f.status ?? "new",
          f.status === "declined" ? "lost" : "enquiry", f.reason ?? null,
          JSON.stringify({ landing: "/contact/", utm_source: "google" }), JSON.stringify({ analytics: true, marketing: false, version: "3" }),
        ],
      ),
    );
    return id;
  }
  async function insertSubmission(leadId: string, answers: Record<string, unknown>): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO agency_discovery_submissions (id, tenant_id, lead_id, schema_version, answers, origin_site)
         VALUES ($1, $2, $3, 'agency-discovery.2026-09-05.v1', $4::jsonb, 'test')`,
        [id, co, leadId, JSON.stringify(answers)],
      ),
    );
    return id;
  }
  const lead = async (id: string) => (await adminPool().query(`SELECT * FROM agency_leads WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

  /** File as the hub's `approvals.request` does for a suspended agent call: raw toolArgs, origin 'agent'. */
  const hubFile = (user: string, toolName: string, toolArgs: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asUser(user),
      payload: {
        workflowId: "agent-intake", toolName, toolArgs: { tenantId: co, ...toolArgs }, impact: "high", origin: "agent", agentName: "intake-agent",
        reason: `suspend: ${toolName} is a high-impact write; agent intake-agent requires human approval (only low-impact writes run unattended)`,
        ...extra,
      },
    });
  const decide = (user: string, approvalId: string, decision: "approved" | "rejected") =>
    app.inject({ method: "POST", url: `/api/${co}/automation-approvals/${approvalId}/decide`, headers: asUser(user), payload: { decision } });
  const run = (user: string, kind: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/${co}/agency/privacy/${kind}`, headers: asUser(user), payload });

  /** Every durable place an identifier must NOT land, as one lower-cased text blob. */
  async function dbText(): Promise<string> {
    const q = async (sql: string) => (await adminPool().query<{ t: string }>(sql)).rows.map((r) => r.t).join("\n");
    return (
      await Promise.all([
        q(`SELECT row_to_json(a)::text AS t FROM automation_approvals a`),
        q(`SELECT row_to_json(o)::text AS t FROM outbox_events o`),
        q(`SELECT row_to_json(a)::text AS t FROM activities a`),
        q(`SELECT row_to_json(n)::text AS t FROM notifications n`),
        q(`SELECT row_to_json(d)::text AS t FROM agency_dsr_requests d`),
        q(`SELECT row_to_json(s)::text AS t FROM agency_contact_suppressions s`),
      ])
    ).join("\n").toLowerCase();
  }
  /** Capture everything written to stdout/stderr and the console while `fn` runs. */
  async function withLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
    const chunks: string[] = [];
    const wrap = (stream: NodeJS.WriteStream) => {
      const orig = stream.write.bind(stream);
      stream.write = ((chunk: unknown, ...rest: unknown[]) => { chunks.push(String(chunk)); return (orig as (...a: unknown[]) => boolean)(chunk, ...rest); }) as never;
      return () => { stream.write = orig as never; };
    };
    const undo = [wrap(process.stdout), wrap(process.stderr)];
    try {
      return { result: await fn(), logs: chunks.join("").toLowerCase() };
    } finally {
      undo.forEach((u) => u());
    }
  }
  const noLeak = (text: string, p: ReturnType<typeof person>, where: string) => {
    for (const f of forms(p)) expect(text, `${where}: leaked ${f}`).not.toContain(f.toLowerCase());
  };

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // 1+2: the full flow — file (unattended) -> read shapes -> decide -> execute by approvalId -> scrubbed
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("erase: files with real identifiers, stores hashes only everywhere, and after a second person approves it erases the right lead", async () => {
    const p = person();
    // The person's own lead holds only the PHONE: no stored email hashes to the email hash, so the executor has no
    // plaintext email from any contact field.
    const direct = await insertLead({ name: p.name, phone: p.phone, status: "declined", reason: `${p.name} chose another agency` });
    // In scope through its AD-1 submission's contact phone. The email appears SOLELY in free text: the hash-only
    // path must still find and scrub it (by hashing the email-shaped tokens of the answers).
    const viaSub = await insertLead({ name: "Front Desk", email: `frontdesk${seq}@villa.test` });
    const sub = await insertSubmission(viaSub, {
      org_name: "Villa Wijaya", contact_name: p.name, contact_phone: p.national.replace("0813", "+62 813"), offering: "Boutique villas",
      anything_else: `Send the quote to ${p.email.toUpperCase()} please`,
    });
    const bystander = await insertLead({ name: "Other Person", email: `bystander${seq}@dsr-unattended.test` });

    const filed = await withLogs(() => hubFile(admin, "agency_privacy.erase", { email: p.email, phone: p.phone }));
    expect(filed.result.statusCode, filed.result.body).toBe(201);
    const approvalId = (filed.result.json() as { id: string }).id;

    // The approval row: every column, serialised. Hashes and the approver's hint, nothing else.
    const row = (await adminPool().query(`SELECT * FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0];
    expect(row).toMatchObject({ tool_name: "agency_privacy.erase", impact: "high", origin: "agent", status: "pending", requested_by: admin });
    expect(row.tool_args).toEqual({
      minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email", "phone"], tenantId: co,
      subject: {
        emailHash: subjectHash(p.email), emailHint: "***@dsr-unattended.test",
        phoneHash: subjectHash(p.phoneDigits), phoneHint: `***${p.phoneDigits.slice(-2)}`,
      },
    });
    noLeak(JSON.stringify(row).toLowerCase(), p, "approval row");
    // The ledger's filed row was written in the same transaction, hashes only.
    const filedRows = (await adminPool().query(`SELECT phase, kind, email_hash, phone_hash, actor_id FROM agency_dsr_requests WHERE approval_id = $1`, [approvalId])).rows;
    expect(filedRows).toEqual([{ phase: "filed", kind: "erase", email_hash: subjectHash(p.email), phone_hash: subjectHash(p.phoneDigits), actor_id: admin }]);

    // Read shapes the approvals UI uses: detail, the automation list, and the unified inbox.
    const detail = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals/${approvalId}`, headers: asUser(decider) });
    expect(detail.statusCode).toBe(200);
    noLeak(detail.body.toLowerCase(), p, "BFF detail");
    const list = await app.inject({ method: "GET", url: `/api/${co}/automation-approvals`, headers: asUser(decider) });
    expect(list.statusCode).toBe(200);
    noLeak(list.body.toLowerCase(), p, "BFF list");
    const unified = await app.inject({ method: "GET", url: `/api/approvals?scope=all`, headers: asUser(decider) });
    noLeak(unified.body.toLowerCase(), p, "BFF unified inbox");

    // Before a decision: awaiting, nothing changes.
    const early = await run(admin, "erase", { approvalId });
    expect(early.statusCode).toBe(202);
    expect(early.json()).toMatchObject({ outcome: "awaiting_approval" });
    expect((await lead(direct)).contact_phone).toBe(p.phone);

    // The decision (a different admin) and its outbox event.
    const decided = await withLogs(() => decide(decider, approvalId, "approved"));
    expect(decided.result.statusCode, decided.result.body).toBe(200);
    const ev = (await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'automation_approval.decided'`, [approvalId])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0].payload.toolArgs.subject).toEqual({ emailHash: subjectHash(p.email), phoneHash: subjectHash(p.phoneDigits) });
    expect(JSON.stringify(ev[0].payload)).not.toContain("***");
    // D14 never runs it: barred, so the row says so.
    expect((await adminPool().query(`SELECT execution_status FROM automation_approvals WHERE id = $1`, [approvalId])).rows[0].execution_status).toBe("not_applicable");

    // Only the requester runs it, even another company_admin; the self-approver rule is the ledger's.
    const notMine = await run(decider, "erase", { approvalId });
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json()).toMatchObject({ reason: "privacy_request_not_requester" });
    // A different command on this approval is a mismatch; it never widens.
    const wrongKind = await run(admin, "export", { approvalId });
    expect(wrongKind.statusCode).toBe(400);
    expect(wrongKind.json()).toMatchObject({ reason: "privacy_request_mismatch" });
    expect((await lead(direct)).contact_phone).toBe(p.phone);

    // THE EXECUTION: just the approvalId. The subject is rebuilt from the hashes.
    const exec = await withLogs(() => run(admin, "erase", { approvalId }));
    expect(exec.result.statusCode, exec.result.body).toBe(200);
    expect(exec.result.json()).toMatchObject({ outcome: "executed", replayed: false, counts: { leadCount: 2, submissionCount: 1 } });
    expect((exec.result.json() as { counts: { suppressionCount: number } }).counts.suppressionCount).toBeGreaterThanOrEqual(2);

    expect(await lead(direct)).toMatchObject({
      status: "declined", org_name: "(erased)", contact_name: null, contact_email: null, contact_phone: null, attribution: null, declined_reason: "(erased)",
    });
    expect((await lead(direct)).erased_at).not.toBeNull();
    expect(await lead(viaSub)).toMatchObject({ contact_email: null, contact_name: null, org_name: "(erased)" });
    const s = (await adminPool().query(`SELECT answers, erased_at FROM agency_discovery_submissions WHERE id = $1`, [sub])).rows[0];
    expect(s.erased_at).not.toBeNull();
    expect(s.answers).toMatchObject({
      contact_name: ERASED_MARKER, contact_phone: ERASED_MARKER, offering: "Boutique villas", org_name: "Villa Wijaya",
      anything_else: `Send the quote to ${ERASED_MARKER} please`, // the free-text email, found by its hash
    });
    expect((await lead(bystander)).erased_at).toBeNull();
    expect((await lead(bystander)).contact_email).toBe(`bystander${seq}@dsr-unattended.test`);

    const sup = (await adminPool().query(`SELECT contact_kind, contact_hash, scope FROM agency_contact_suppressions WHERE tenant_id = $1`, [co])).rows;
    expect(sup).toEqual(expect.arrayContaining([
      { contact_kind: "email", contact_hash: subjectHash(p.email), scope: "all" },
      { contact_kind: "phone", contact_hash: subjectHash(p.phoneDigits), scope: "all" },
    ]));
    expect((await adminPool().query(`SELECT phase FROM agency_dsr_requests WHERE approval_id = $1 ORDER BY created_at`, [approvalId])).rows.map((r) => r.phase))
      .toEqual(["filed", "executed"]);

    // A replay returns the stored counts and changes nothing.
    const again = await run(admin, "erase", { approvalId });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ outcome: "executed", replayed: true });
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM agency_dsr_requests WHERE approval_id = $1`, [approvalId])).rows[0].n).toBe(2);

    // After everything: no store, no log line, no read shape ever held an identifier.
    noLeak(await dbText(), p, "database");
    noLeak(filed.logs + decided.logs + exec.logs, p, "logs");
  });

  it("an identifier that matches no lead files, is approved, and runs as a clean no-op that still suppresses the hash", async () => {
    const p = person();
    const bystander = await insertLead({ name: "Someone Else", email: `else${seq}@dsr-unattended.test` });
    const filed = await hubFile(admin, "agency_privacy.erase", { email: p.email });
    expect(filed.statusCode, filed.body).toBe(201);
    const approvalId = (filed.json() as { id: string }).id;
    expect((await decide(decider, approvalId, "approved")).statusCode).toBe(200);
    const exec = await run(admin, "erase", { approvalId });
    expect(exec.statusCode, exec.body).toBe(200);
    expect(exec.json()).toMatchObject({ outcome: "executed", replayed: false, counts: { leadCount: 0, submissionCount: 0, tokenCount: 0, outOfScopeCount: 0, suppressionCount: 1 }, outOfScope: [] });
    expect((await lead(bystander)).erased_at).toBeNull();
    const sup = (await adminPool().query(`SELECT 1 FROM agency_contact_suppressions WHERE tenant_id = $1 AND contact_kind = 'email' AND contact_hash = $2`, [co, subjectHash(p.email)])).rows;
    expect(sup).toHaveLength(1);
    noLeak(await dbText(), p, "database");
  });

  it("find and export run by approvalId too; export is returned once and a re-use is 409", async () => {
    const p = person();
    const id = await insertLead({ name: p.name, email: p.email, phone: p.phone, status: "submitted" });
    const f = await hubFile(admin, "agency_privacy.find", { phone: p.phone.replace(" 813", "-813") });
    const findId = (f.json() as { id: string }).id;
    expect((await decide(decider, findId, "approved")).statusCode).toBe(200);
    const found = await run(admin, "find", { approvalId: findId });
    expect(found.statusCode, found.body).toBe(200);
    expect((found.json() as { leads: { leadId: string }[] }).leads.map((l) => l.leadId)).toEqual([id]);

    const e = await hubFile(admin, "agency_privacy.export", { email: p.email.toUpperCase() });
    const exportId = (e.json() as { id: string }).id;
    expect((await decide(decider, exportId, "approved")).statusCode).toBe(200);
    const ex = await run(admin, "export", { approvalId: exportId });
    expect(ex.statusCode, ex.body).toBe(200);
    expect((ex.json() as { leads: { contactEmail: string }[] }).leads[0].contactEmail).toBe(p.email);
    expect((await run(admin, "export", { approvalId: exportId })).statusCode).toBe(409);
    // the export's personal data was never stored anywhere durable
    noLeak(await dbText(), p, "database");
  });

  it("a route-filed approval (attended) can also be run with just its approvalId", async () => {
    const p = person();
    const id = await insertLead({ name: p.name, email: p.email });
    const filed = await run(admin, "erase", { email: p.email });
    expect(filed.statusCode).toBe(202);
    const approvalId = (filed.json() as { approvalId: string }).approvalId;
    expect((await decide(decider, approvalId, "approved")).statusCode).toBe(200);
    const exec = await run(admin, "erase", { approvalId });
    expect(exec.statusCode, exec.body).toBe(200);
    expect((await lead(id)).contact_email).toBeNull();
    noLeak(await dbText(), p, "database");
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // refusals (valid bodies) and the D14 re-run digest
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("the generic create cannot plant a privacy approval for someone without `convert`: 403, nothing stored", async () => {
    const p = person();
    const before = (await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n;
    for (const tool of ["agency_privacy.find", "agency_privacy.export", "agency_privacy.erase"]) {
      const r = await hubFile(manager, tool, { email: p.email });
      expect(r.statusCode, tool).toBe(403);
    }
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n).toBe(before);
  });

  it("a malformed identifier is 400 subject_invalid and nothing is stored (no raw value, no row)", async () => {
    const before = (await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n;
    const bad = await hubFile(admin, "agency_privacy.erase", { email: "this is not an email" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ reason: "subject_invalid" });
    expect((await hubFile(admin, "agency_privacy.erase", {})).statusCode).toBe(400);
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM automation_approvals WHERE tenant_id = $1`, [co])).rows[0].n).toBe(before);
  });

  it("a rejected request is 409 and an approval no ledger row binds (a raw forged row) is 404; neither touches data", async () => {
    const p = person();
    const id = await insertLead({ name: p.name, email: p.email });
    const f = await hubFile(admin, "agency_privacy.erase", { email: p.email });
    const approvalId = (f.json() as { id: string }).id;
    expect((await decide(decider, approvalId, "rejected")).statusCode).toBe(200);
    const rej = await run(admin, "erase", { approvalId });
    expect(rej.statusCode).toBe(409);
    expect(rej.json()).toMatchObject({ reason: "approval_rejected" });

    const forged = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, requested_by, origin, origin_site)
         VALUES ($1, $2, 'agent-intake', 'agency_privacy.erase', $3::jsonb, 'high', $4, 'agent', 'test')`,
        [forged, co, JSON.stringify({ minimised: "agency-privacy.v1", kind: "erase", identifiers: ["email"], subject: { emailHash: subjectHash(p.email) } }), admin],
      ),
    );
    expect((await decide(decider, forged, "approved")).statusCode).toBe(200);
    const r = await run(admin, "erase", { approvalId: forged });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ reason: "privacy_request_not_found" });
    expect((await lead(id)).contact_email).toBe(p.email);
  });

  it("resolve-and-execute finds the minimised approval for the SAME raw args (so the runner does not re-file it) and reports it not executable", async () => {
    const p = person();
    const f = await hubFile(admin, "agency_privacy.erase", { email: p.email, phone: p.phone });
    const approvalId = (f.json() as { id: string }).id;
    const rae = (toolArgs: Record<string, unknown>) =>
      app.inject({
        method: "POST", url: `/api/${co}/automation-approvals/resolve-and-execute`, headers: asUser(admin),
        payload: { agentName: "agent-intake", toolName: "agency_privacy.erase", toolArgs: { tenantId: co, ...toolArgs } },
      });
    expect((await rae({ email: p.email, phone: p.phone })).json()).toEqual({ match: "none" }); // still pending
    expect((await decide(decider, approvalId, "approved")).statusCode).toBe(200);
    // the same person, spelled differently, is the same call
    const same = await rae({ email: p.email.toUpperCase(), phone: p.national.replace("0813", "+62 813") });
    expect(same.json()).toMatchObject({ match: "not_executable", approvalId, reason: "no_executable_registry_entry" });
    // another person is not
    expect((await rae({ email: person().email })).json()).toEqual({ match: "none" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // regression: a tool with no args policy stores exactly what it always did
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  it("another tool's args and reason are stored verbatim, and its decided event carries them unchanged", async () => {
    const toolArgs = { amount: 100, note: "call budi@regression.test on +62 811 000 0000", nested: { a: [1, 2] } };
    const r = await app.inject({
      method: "POST", url: `/api/${co}/automation-approvals`, headers: asUser(admin),
      payload: { workflowId: "agent-x", toolName: "money.transfer", toolArgs, impact: "medium", reason: "suspend: medium-impact write", origin: "agent" },
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = (r.json() as { id: string }).id;
    const row = (await adminPool().query(`SELECT tool_args, reason FROM automation_approvals WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ tool_args: toolArgs, reason: "suspend: medium-impact write" });
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM agency_dsr_requests WHERE approval_id = $1`, [id])).rows[0].n).toBe(0);
    expect((await decide(decider, id, "approved")).statusCode).toBe(200);
    const ev = (await adminPool().query(`SELECT payload FROM outbox_events WHERE entity_id = $1 AND event_type = 'automation_approval.decided'`, [id])).rows[0];
    expect(ev.payload.toolArgs).toEqual(toolArgs);
  });
});
