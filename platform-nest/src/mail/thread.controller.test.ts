// MAIL-13 / design A10 — the thread-read authorization probes, against live Postgres + RLS + Cerbos.
//
// THE CONTRACT UNDER TEST is behavioural, not structural, and it is the whole compensating control for
// `mail_messages` being a global no-RLS table (§6.1): **a thread read must 403 in exactly the cases its
// PARENT entity 403s.** So every probe below is a PAIR — the same caller is sent at the parent
// surface's own endpoint and at the thread endpoint, and the two status codes are asserted EQUAL. A
// test that only checked "member gets 403 on the thread" would still pass if the thread became
// stricter than the parent (breaking the feature) or if the parent later loosened (breaking the rule).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { setStorageForTest, localStorage as localStorageBackend, type StorageBackend } from "../../src/core/storage";
import type { StoredAttachment } from "./inbound/intake";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("mail thread reads — parent-entity authorization (A10)", () => {
  let app: NestFastifyApplication;
  let coA: string, coB: string;
  let adminGlobal: string; // platform_admin @ global — elevated
  let adminA: string; // company_admin @ coA — CAN read runs/approvals in A
  let memberA: string; // member @ coA — CANNOT read runs/approvals
  let adminB: string; // company_admin @ coB — the cross-tenant probe
  let clientContactA: string; // portal contact of client A
  let clientContactB: string; // portal contact of client B — the cross-client probe

  let runA: string; // pipeline_run in coA, owned by client A
  let approvalA: string; // automation_approval in coA
  let gateA: string; // pipeline_gate on runA, actor_side='client' — clientContactA legitimately holds it
  let mailLogRun: string;
  let mailLogApproval: string;
  let mailLogGate: string;
  let messageWithAttachments: string;

  const files = new Map<string, Buffer>();
  const memBackend: StorageBackend = {
    async put(k, d) { files.set(k, d); },
    async get(k) { const b = files.get(k); if (!b) throw new Error("missing"); return b; },
    async del(k) { files.delete(k); },
  };

  /** Inserts an inbound message directly. Deliberately NOT via the webhook: this suite is about the
   *  READ authorization, and driving intake here would couple two independent failure surfaces. */
  async function seedMessage(opts: {
    mailLogId: string;
    tenantId: string;
    entityType: string | null;
    entityId: string | null;
    attachments?: StoredAttachment[];
    bodyTruncated?: boolean;
    bodyTruncatedChars?: number;
  }): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO mail_messages (id, mail_log_id, tenant_id, entity_type, entity_id, provider,
                                  provider_message_id, from_email, subject, body_text,
                                  body_html_sanitized, body_truncated, body_truncated_chars,
                                  attachments, size_bytes, origin_site)
       VALUES ($1,$2,$3,$4,$5,'brevo-inbound',$6,'dita@client-one.invalid','Re: approval',
               'the reply body','<p>the reply body</p>',$7,$8,$9::jsonb,120,'test')`,
      [
        id, opts.mailLogId, opts.tenantId, opts.entityType, opts.entityId, `pmid-${id}`,
        opts.bodyTruncated ?? false, opts.bodyTruncatedChars ?? 0,
        JSON.stringify(opts.attachments ?? []),
      ],
    );
    return id;
  }

  async function seedMailLog(tenantId: string, entityType: string, entityId: string): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status,
                             entity_type, entity_id, reply_token, origin_site)
       VALUES ($1,'notify',$2,'someone@a.test','approval.actionable','Approval needed','{}'::jsonb,'sent',
               $3,$4,$5,'test')`,
      [id, tenantId, entityType, entityId, `rt-${id}`.slice(0, 40)],
    );
    return id;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest(memBackend);

    coA = await createCompany("Thread Authz Co A");
    coB = await createCompany("Thread Authz Co B");

    adminGlobal = await createUser("thread-global@a.test");
    adminA = await createUser("thread-admin-a@a.test");
    memberA = await createUser("thread-member-a@a.test");
    adminB = await createUser("thread-admin-b@a.test");
    clientContactA = await createUser("thread-client-a@a.test");
    clientContactB = await createUser("thread-client-b@a.test");

    for (const u of [adminGlobal, adminA, memberA, clientContactA, clientContactB]) await addMembership(coA, u);
    await addMembership(coB, adminB);

    await grantRole(adminGlobal, await createRole("platform_admin"), "global", null);
    const companyAdminRole = await createRole("company_admin");
    await grantRole(adminA, companyAdminRole, "company", coA);
    await grantRole(adminB, companyAdminRole, "company", coB);
    await grantRole(memberA, await createRole("member"), "company", coA);
    const clientRole = await createRole("client");
    await grantRole(clientContactA, clientRole, "company", coA);
    await grantRole(clientContactB, clientRole, "company", coA);

    // Portal ownership: two clients, one contact each. `createClient`'s third argument sets the legacy
    // `clients.portal_user_id`, which `resolvePortalScope` unions in — the shortest real ownership path.
    const clientA = await createClient(coA, "Client One", clientContactA);
    await createClient(coA, "Client Two", clientContactB);
    const projectA = await createProject(coA, "Project One", adminA);

    runA = newId();
    approvalA = newId();
    await adminPool().query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
       VALUES ($1,$2,'Authz run','delivery_active',$3,$4,'test')`,
      [runA, coA, clientA, projectA],
    );
    await adminPool().query(
      `INSERT INTO automation_approvals (id, tenant_id, workflow_id, tool_name, tool_args, impact, reason,
                                         status, origin, origin_site)
       VALUES ($1,$2,'wf:authz','money.transfer','{}'::jsonb,'medium','suspend','pending','automation','test')`,
      [approvalA, coA],
    );

    // MAIL-33 — a real client-actionable gate on runA, exactly the shape `pipeline.controller.ts`'s
    // `openGate` creates. `actor_side = 'client'` is load-bearing: it is what both the portal
    // ownership predicate (mirrored off `PortalController.decideGate`) and the "who legitimately
    // holds this gate" framing in the ticket turn on.
    gateA = newId();
    await adminPool().query(
      `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, opened_by, origin_site)
       VALUES ($1,$2,$3,'prd_sign','client','pending',$4,'test')`,
      [gateA, coA, runA, adminA],
    );

    mailLogRun = await seedMailLog(coA, "pipeline_run", runA);
    mailLogApproval = await seedMailLog(coA, "automation_approval", approvalA);
    mailLogGate = await seedMailLog(coA, "pipeline_gate", gateA);

    messageWithAttachments = await seedMessage({
      mailLogId: mailLogRun,
      tenantId: coA,
      entityType: "pipeline_run",
      entityId: runA,
      attachments: [
        { index: 0, fileRef: "mail-quarantine/x/0", name: "clean.txt", contentType: "text/plain", bytes: 5, scanStatus: "clean" },
        { index: 1, fileRef: null, name: "bad.doc", contentType: "application/msword", bytes: 68, scanStatus: "infected" },
        { index: 2, fileRef: "mail-quarantine/x/2", name: "unscanned.bin", contentType: "application/octet-stream", bytes: 9, scanStatus: "pending" },
        { index: 3, fileRef: "mail-quarantine/x/3", name: "unscanned-off.txt", contentType: "text/plain", bytes: 7, scanStatus: "skipped" },
      ],
    });
    files.set("mail-quarantine/x/0", Buffer.from("clean"));
    files.set("mail-quarantine/x/2", Buffer.from("unscanned"));
    files.set("mail-quarantine/x/3", Buffer.from("skipped"));
    await seedMessage({ mailLogId: mailLogApproval, tenantId: coA, entityType: "automation_approval", entityId: approvalA });
    await seedMessage({ mailLogId: mailLogGate, tenantId: coA, entityType: "pipeline_gate", entityId: gateA });

    app = await buildApp();
  });

  afterAll(async () => {
    setStorageForTest(localStorageBackend);
    await app.close();
    await teardownTestDb();
  });

  const thread = (tenant: string, type: string, id: string, user: string) =>
    app.inject({ method: "GET", url: `/api/${tenant}/mail/threads?entityType=${type}&entityId=${id}`, headers: asUser(user) });

  // ── pipeline_run parity ───────────────────────────────────────────────────────────────────────
  it("pipeline_run: company_admin reads BOTH the parent and the thread (200/200)", async () => {
    const parent = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(adminA) });
    const t = await thread(coA, "pipeline_run", runA, adminA);
    expect(parent.statusCode).toBe(200);
    expect(t.statusCode).toBe(200);
    const body = t.json() as {
      messages: Array<{ bodyText: string; senderVerified: boolean; provenance: string; bodyTruncated: boolean; bodyTruncatedChars: number }>;
    };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].bodyText).toBe("the reply body");
    // The provenance contract MAIL-15's "Email reply — sender unverified" banner is driven by.
    expect(body.messages[0].senderVerified).toBe(false);
    expect(body.messages[0].provenance).toBe("inbound-email");
    // [MAIL-25] the structured truncation signal defaults false/0 for an ordinary, untruncated reply.
    expect(body.messages[0].bodyTruncated).toBe(false);
    expect(body.messages[0].bodyTruncatedChars).toBe(0);
  });

  // ── MAIL-25: the structured truncation field is exposed end to end ───────────────────────────────
  it("[MAIL-25] a message stored with body_truncated=true surfaces bodyTruncated/bodyTruncatedChars on every thread read", async () => {
    // A DEDICATED entity id, deliberately NOT `runA` — every other test in this file asserts an exact
    // message count on `runA`'s own thread (seeded once in `beforeAll`), so threading a second message
    // onto that same entity here would silently inflate those counts. `authorizeThreadParent`'s
    // pipeline_run branch authorizes on `{kind, id, tenantId}` alone (no existence lookup — see
    // `thread-authz.ts`), so a fresh id needs no matching `pipeline_runs` row to read the thread.
    const dedicatedRunId = newId();
    const truncatedLog = await seedMailLog(coA, "pipeline_run", dedicatedRunId);
    await seedMessage({
      mailLogId: truncatedLog, tenantId: coA, entityType: "pipeline_run", entityId: dedicatedRunId,
      bodyTruncated: true, bodyTruncatedChars: 18928,
    });

    const entity = await thread(coA, "pipeline_run", dedicatedRunId, adminA);
    const entityBody = entity.json() as { messages: Array<{ mailLogId: string; bodyTruncated: boolean; bodyTruncatedChars: number }> };
    expect(entityBody.messages).toHaveLength(1);
    expect(entityBody.messages[0]).toMatchObject({ bodyTruncated: true, bodyTruncatedChars: 18928 });

    const admin = await app.inject({ method: "GET", url: `/api/admin/mail/log/${truncatedLog}/thread`, headers: asUser(adminGlobal) });
    const adminBody = admin.json() as { messages: Array<{ bodyTruncated: boolean; bodyTruncatedChars: number }> };
    expect(adminBody.messages[0]).toMatchObject({ bodyTruncated: true, bodyTruncatedChars: 18928 });
  });

  it("pipeline_run: a plain member is refused on the parent AND on the thread, with the SAME status", async () => {
    const parent = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(memberA) });
    const t = await thread(coA, "pipeline_run", runA, memberA);
    expect(parent.statusCode).toBe(403);
    expect(t.statusCode).toBe(parent.statusCode);
  });

  // ── cross-tenant ──────────────────────────────────────────────────────────────────────────────
  it("CROSS-TENANT: company_admin of another tenant is refused on the parent AND the thread, and sees no content", async () => {
    const parent = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(adminB) });
    const t = await thread(coA, "pipeline_run", runA, adminB);
    expect(parent.statusCode).toBe(403);
    expect(t.statusCode).toBe(403);
    // §6.1's explicit requirement: no body_* content is serialized to a caller who fails the entity
    // check. Asserted on the raw response body, not on a parsed field, so a partial leak is caught too.
    expect(t.body).not.toContain("the reply body");
  });

  it("CROSS-TENANT: the attachment download is refused for the same caller", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/${coA}/mail/messages/${messageWithAttachments}/attachments/0`,
      headers: asUser(adminB),
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("clean");
  });

  // ── automation_approval parity (the `module` attribute path) ───────────────────────────────────
  it("automation_approval: parity for an allowed caller and for a refused one", async () => {
    const parentOk = await app.inject({ method: "GET", url: `/api/${coA}/automation-approvals`, headers: asUser(adminA) });
    const threadOk = await thread(coA, "automation_approval", approvalA, adminA);
    expect(parentOk.statusCode).toBe(200);
    expect(threadOk.statusCode).toBe(200);
    expect((threadOk.json() as { messages: unknown[] }).messages).toHaveLength(1);

    const parentNo = await app.inject({ method: "GET", url: `/api/${coA}/automation-approvals`, headers: asUser(memberA) });
    const threadNo = await thread(coA, "automation_approval", approvalA, memberA);
    expect(parentNo.statusCode).toBe(403);
    expect(threadNo.statusCode).toBe(parentNo.statusCode);
  });

  // ── pipeline_gate parity (MAIL-33: parent authorization is the RUN, not the gate's own kind) ──
  it("pipeline_gate: an allowed caller (readable via the parent RUN) reads the thread; a refused caller gets the SAME status", async () => {
    const parentOk = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(adminA) });
    const threadOk = await thread(coA, "pipeline_gate", gateA, adminA);
    expect(parentOk.statusCode).toBe(200);
    expect(threadOk.statusCode).toBe(200);
    expect((threadOk.json() as { messages: unknown[] }).messages).toHaveLength(1);

    const parentNo = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(memberA) });
    const threadNo = await thread(coA, "pipeline_gate", gateA, memberA);
    expect(parentNo.statusCode).toBe(403);
    expect(threadNo.statusCode).toBe(parentNo.statusCode);
  });

  // The negative probe MAIL-33's AC calls for explicitly: a caller who cannot read runA (a
  // DIFFERENT tenant's company_admin — has no grant on coA at all, so cannot read the run) must not
  // be able to read gateA's thread just because it hangs off `pipeline_gate` rather than
  // `pipeline_run`. Proves access was not WIDENED by routing the gate's authorization through its
  // parent run instead of through the gate's own (identically-shaped) Cerbos rule.
  it("NEGATIVE PROBE — pipeline_gate: a caller who cannot read the PARENT RUN cannot read the gate's thread either, and sees no content", async () => {
    const parent = await app.inject({ method: "GET", url: `/api/${coA}/pipeline/runs`, headers: asUser(adminB) });
    const t = await thread(coA, "pipeline_gate", gateA, adminB);
    expect(parent.statusCode).toBe(403);
    expect(t.statusCode).toBe(403);
    expect(t.body).not.toContain("the reply body");
  });

  it("pipeline_gate: a gate id with no matching row 404s rather than throwing (mirrors automation_approval's read-then-authorize ordering)", async () => {
    const res = await thread(coA, "pipeline_gate", newId(), adminA);
    expect(res.statusCode).toBe(404);
  });

  it("an entity kind that is not a thread parent is refused by the allowlist, not by Cerbos silence", async () => {
    const res = await thread(coA, "pm_task", newId(), adminGlobal);
    expect(res.statusCode).toBe(400);
    const missing = await thread(coA, "pipeline_run", "not-a-uuid", adminGlobal);
    expect(missing.statusCode).toBe(400);
  });

  // ── the attachment scan gate ──────────────────────────────────────────────────────────────────
  it("scan gate: clean serves; infected 403s; pending 403s; skipped is ADMIN-ONLY", async () => {
    const url = (i: number) => `/api/${coA}/mail/messages/${messageWithAttachments}/attachments/${i}`;

    const clean = await app.inject({ method: "GET", url: url(0), headers: asUser(adminA) });
    expect(clean.statusCode).toBe(200);
    expect(clean.body).toBe("clean");
    // Stored-XSS posture: never inline, never sniffable.
    expect(clean.headers["content-disposition"]).toContain("attachment;");
    expect(clean.headers["x-content-type-options"]).toBe("nosniff");

    // Infected: bytes were never stored, and the gate refuses before any lookup could matter.
    const infected = await app.inject({ method: "GET", url: url(1), headers: asUser(adminA) });
    expect(infected.statusCode).toBe(403);
    const infectedAdmin = await app.inject({ method: "GET", url: url(1), headers: asUser(adminGlobal) });
    expect(infectedAdmin.statusCode).toBe(403); // refused at EVERY privilege

    // Pending (unscannable) stays quarantined at every privilege — "fail-closed on exposure".
    expect((await app.inject({ method: "GET", url: url(2), headers: asUser(adminA) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: url(2), headers: asUser(adminGlobal) })).statusCode).toBe(403);

    // Skipped (scanning switched off) is admin-only, verbatim per §7.6.
    expect((await app.inject({ method: "GET", url: url(3), headers: asUser(adminA) })).statusCode).toBe(403);
    const skippedAdmin = await app.inject({ method: "GET", url: url(3), headers: asUser(adminGlobal) });
    expect(skippedAdmin.statusCode).toBe(200);
    expect(skippedAdmin.body).toBe("skipped");
  });

  it("the thread listing's downloadable/blockedReason agree with what the download endpoint actually does", async () => {
    const res = await thread(coA, "pipeline_run", runA, adminA);
    const atts = (res.json() as { messages: Array<{ attachments: Array<{ index: number; downloadable: boolean; blockedReason: string | null }> }> })
      .messages[0].attachments;
    expect(atts.find((a) => a.index === 0)).toMatchObject({ downloadable: true, blockedReason: null });
    expect(atts.find((a) => a.index === 1)).toMatchObject({ downloadable: false, blockedReason: "infected" });
    expect(atts.find((a) => a.index === 2)).toMatchObject({ downloadable: false, blockedReason: "not_yet_scanned" });
    expect(atts.find((a) => a.index === 3)).toMatchObject({ downloadable: false, blockedReason: "admin_only" });
  });

  // ── portal variant ────────────────────────────────────────────────────────────────────────────
  it("portal: the run's own client contact reads the thread; another client's contact gets 404", async () => {
    const mine = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?runId=${runA}`, headers: asUser(clientContactA),
    });
    expect(mine.statusCode).toBe(200);
    expect((mine.json() as { messages: unknown[] }).messages).toHaveLength(1);

    const theirs = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?runId=${runA}`, headers: asUser(clientContactB),
    });
    // 404 not 403: to a client, another client's run must be indistinguishable from a nonexistent one.
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).not.toContain("the reply body");
  });

  it("portal: a client contact CANNOT use the staff entity route (the portal predicate is not a Cerbos run grant)", async () => {
    const res = await thread(coA, "pipeline_run", runA, clientContactA);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("the reply body");
  });

  // ── portal gate variant (MAIL-33) ────────────────────────────────────────────────────────────────
  it("portal: the client signer who legitimately holds the gate reads its thread via ?gateId=; another client's contact gets 404", async () => {
    const mine = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?gateId=${gateA}`, headers: asUser(clientContactA),
    });
    expect(mine.statusCode).toBe(200);
    const body = mine.json() as { entityType: string; entityId: string; messages: unknown[] };
    expect(body).toMatchObject({ entityType: "pipeline_gate", entityId: gateA });
    expect(body.messages).toHaveLength(1);

    // 404, not 403 — same non-disclosure rule as the run variant: a gate belonging to a different
    // client of the same agency must be indistinguishable from a nonexistent one.
    const theirs = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?gateId=${gateA}`, headers: asUser(clientContactB),
    });
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).not.toContain("the reply body");
  });

  it("portal: a client contact CANNOT use the staff entity route for a gate either", async () => {
    const res = await thread(coA, "pipeline_gate", gateA, clientContactA);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("the reply body");
  });

  it("portal: gateId and runId are mutually exclusive, and at least one is required", async () => {
    const neither = await app.inject({ method: "GET", url: `/api/${coA}/portal/mail/threads`, headers: asUser(clientContactA) });
    expect(neither.statusCode).toBe(400);
    const both = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?runId=${runA}&gateId=${gateA}`, headers: asUser(clientContactA),
    });
    expect(both.statusCode).toBe(400);
  });

  it("portal: attachments never serve on the portal surface when scanning is off (skipped is admin-only)", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/${coA}/portal/mail/threads?runId=${runA}`, headers: asUser(clientContactA),
    });
    const atts = (res.json() as { messages: Array<{ attachments: Array<{ index: number; downloadable: boolean }> }> })
      .messages[0].attachments;
    expect(atts.find((a) => a.index === 3)).toMatchObject({ downloadable: false });
  });

  // ── admin log thread ──────────────────────────────────────────────────────────────────────────
  it("admin log thread: non-elevated 403s; elevated reads the replies", async () => {
    const denied = await app.inject({ method: "GET", url: `/api/admin/mail/log/${mailLogRun}/thread`, headers: asUser(adminA) });
    expect(denied.statusCode).toBe(403);

    const ok = await app.inject({ method: "GET", url: `/api/admin/mail/log/${mailLogRun}/thread`, headers: asUser(adminGlobal) });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { mailLogId: string; messages: Array<{ bodyText: string }> };
    expect(body.mailLogId).toBe(mailLogRun);
    expect(body.messages[0].bodyText).toBe("the reply body");
  });

  it("admin log thread: an NDR row (NULL entity) is visible on the LOG thread and invisible on the ENTITY thread", async () => {
    const ndrLog = await seedMailLog(coA, "pipeline_run", runA);
    await seedMessage({ mailLogId: ndrLog, tenantId: coA, entityType: null, entityId: null });

    const onLog = await app.inject({ method: "GET", url: `/api/admin/mail/log/${ndrLog}/thread`, headers: asUser(adminGlobal) });
    expect(onLog.statusCode).toBe(200);
    expect((onLog.json() as { messages: unknown[] }).messages).toHaveLength(1);

    // The entity thread still shows only the real replies — a bounce notice never renders behind the
    // "sender unverified" banner on a decision surface.
    const onEntity = await thread(coA, "pipeline_run", runA, adminA);
    expect((onEntity.json() as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("no thread endpoint ever serializes mail_log.payload or a reply_token", async () => {
    const entity = await thread(coA, "pipeline_run", runA, adminA);
    const admin = await app.inject({ method: "GET", url: `/api/admin/mail/log/${mailLogRun}/thread`, headers: asUser(adminGlobal) });
    for (const res of [entity, admin]) {
      expect(res.body).not.toContain("reply_token");
      expect(res.body).not.toContain("replyToken");
      expect(res.body).not.toContain("rt-");
      expect(res.body).not.toContain("fileRef");
    }
  });

  it("[control] a message stamped to another tenant is not returned even for a matching entity id", async () => {
    // Belt-and-braces on the `tenant_id = :tenantId` predicate: mail_messages has no RLS, so this is
    // the only thing standing between a mis-stamped row and a cross-tenant read.
    const strayLog = await seedMailLog(coB, "pipeline_run", runA);
    await seedMessage({ mailLogId: strayLog, tenantId: coB, entityType: "pipeline_run", entityId: runA });
    const res = await thread(coA, "pipeline_run", runA, adminA);
    // Still only the coA message, even though a coB row shares the entity id.
    expect((res.json() as { messages: unknown[] }).messages).toHaveLength(1);
    await withTenants([coB], (c) => c.query(`SELECT 1`)); // no-op; keeps the import honest
  });
});
