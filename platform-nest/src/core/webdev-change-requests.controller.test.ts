// MI-03 — the STAFF half of webdev maintenance intake: authz, the plain-wall decision, the
// dispositions, and the mini-run spawner's row/event shapes. The raced double-convert and the
// fault-injection rollback live in `webdev-cr-race.test.ts` (they need a different harness).
//
// Standard applied throughout: a 200 is not a pass. Every "notified" claim is a `notifications` row
// read back through `adminPool()` (bypassing RLS, so what is asserted is what actually committed),
// every refusal additionally asserts the STORED row is unchanged, and the two policy/DDL invariants
// this feature can silently lose (§4.1's client-role exclusion, D-2a's absent module wall) are
// asserted against the files themselves, because a future edit that breaks them would otherwise turn
// a deliberate decision into an unexplained DENY or a silently-empty portal.
//
// ⚠ Cerbos does NOT hot-reload here: `gaiada-test-cerbos` (which owns :3592 — NOT `gaiada-cerbos-1`)
// was restarted after `resource_webdev_change_request.yaml` landed and BEFORE this suite was run. An
// unlisted kind/action is a silent DENY that reads exactly like a logic bug.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { newId, withTenants } from "../db";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const POLICY_PATH = join(__dirname, "..", "..", "cerbos", "policies", "resource_webdev_change_request.yaml");
const MIGRATION_PATH = join(__dirname, "..", "..", "migrations", "0088_webdev_change_requests.sql");

async function addContact(
  tenantId: string,
  clientId: string,
  userId: string,
  opts: { status?: string; capability?: string; projectId?: string | null } = {},
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), tenantId, clientId, userId, opts.projectId ?? null, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
    ),
  );
}

interface CrListRow {
  id: string; status: string; kind: string; title: string; route: string | null;
  clientId: string | null; projectId: string | null; pipelineRunId: string | null; pmTaskId: string | null;
  requestedBy: string | null; declinedReason: string | null; createdAt: string;
}

describe.skipIf(!TEST_URL)("MI-03: staff change-request surface, triage + mini-run spawner", () => {
  let app: NestFastifyApplication;
  let co: string;
  let co2: string;
  let admin: string;      // company_admin of co, with a membership
  let admin2: string;     // company_admin of co2 (for the cross-tenant probe)
  let exec: string;       // group_executive, GLOBAL grant, NO membership row anywhere — trap #4
  let plainMember: string;
  let webdevManager: string;
  let webdevStaff: string;
  let clientOnly: string; // holds ONLY the `client` grant — the §4.1 invariant probe
  let signerC: string;    // active signer contact of clientA (client-wide)
  let viewerC: string;    // active viewer contact of clientA (client-wide)
  let clientA: string;
  let clientOther: string; // a client of co2, for the composite-FK cross-tenant refusal
  let projX: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Gaiada Creative");
    co2 = await createCompany("Unrelated Holdings");

    const roleAdmin = await createRole("company_admin");
    const roleMember = await createRole("member");
    const roleClient = await createRole("client");
    const roleExec = await createRole("group_executive");
    const roleWebdevManager = await createRole("webdev_manager");
    const roleWebdevStaff = await createRole("webdev_staff");

    admin = await createUser("admin@cr-staff.test");
    await addMembership(co, admin);
    await grantRole(admin, roleAdmin, "company", co);

    admin2 = await createUser("admin2@cr-staff.test");
    await addMembership(co2, admin2);
    await grantRole(admin2, roleAdmin, "company", co2);

    // TRAP #4 fixture: a GLOBAL grant and DELIBERATELY no company_memberships row anywhere, so
    // `principal.companies` is empty and `variables.inTenant` is FALSE for every resource.
    exec = await createUser("owner@cr-staff.test");
    await grantRole(exec, roleExec, "global", null);

    plainMember = await createUser("member@cr-staff.test");
    await addMembership(co, plainMember);
    await grantRole(plainMember, roleMember, "company", co);

    webdevManager = await createUser("webdev-manager@cr-staff.test");
    await addMembership(co, webdevManager);
    await grantRole(webdevManager, roleWebdevManager, "company", co);

    webdevStaff = await createUser("webdev-staff@cr-staff.test");
    await addMembership(co, webdevStaff);
    await grantRole(webdevStaff, roleWebdevStaff, "company", co);

    clientA = await createClient(co, "Bali Beach Resort");
    clientOther = await createClient(co2, "Someone Else Ltd");
    projX = await createProject(co, "Rebrand X", admin);
    await withTenants([co], (c) => c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projX, clientA]));

    signerC = await createUser("signer@client.test");
    await addContact(co, clientA, signerC, { capability: "signer" });
    await grantRole(signerC, roleClient, "company", co);

    viewerC = await createUser("viewer@client.test");
    await addContact(co, clientA, viewerC, { capability: "viewer" });
    await grantRole(viewerC, roleClient, "company", co);

    // A client-role-only principal WITH a real contact row, so `inTenant` is genuinely TRUE for them:
    // the probe below then proves the DENY comes from the policy not naming `client`, not from the
    // principal having no tenant at all (which would be a probe that passes for the wrong reason).
    clientOnly = await createUser("client-only@client.test");
    await addContact(co, clientA, clientOnly, { capability: "signer" });
    await grantRole(clientOnly, roleClient, "company", co);

    app = await buildApp();
  }, 60000);

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  let seq = 0;
  const uniq = () => `cr-${++seq}-${Math.random().toString(36).slice(2, 8).replace(/[0-9]/g, "z")}`;

  /** An internal-source CR through the real endpoint. */
  async function internalCr(
    payload: Record<string, unknown> = {},
    actor = admin,
  ): Promise<{ id: string; title: string; res: Awaited<ReturnType<NestFastifyApplication["inject"]>> }> {
    const title = `internal ${uniq()}`;
    const res = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(actor),
      payload: { kind: "feature", title, clientId: clientA, projectId: projX, ...payload },
    });
    return { id: (res.json() as { id?: string }).id ?? "", title, res };
  }

  /** A portal-source CR, submitted by a real client contact, so `requested_by` is someone the staff
   *  actor is not — the only way the requester-notification assertions can mean anything
   *  (`notify()` skips self). */
  async function portalCr(actor = signerC, payload: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
    const title = `portal ${uniq()}`;
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/change-requests`, headers: asUser(actor),
      payload: { kind: "feature", title, body: "the hero image is stretched on mobile", ...payload },
    });
    expect(r.statusCode).toBe(201);
    return { id: (r.json() as { id: string }).id, title };
  }

  const triage = (crId: string, payload: Record<string, unknown>, actor = admin) =>
    app.inject({ method: "POST", url: `/api/${co}/webdev/change-requests/${crId}/triage`, headers: asUser(actor), payload });

  const crRow = async (id: string) =>
    (
      await adminPool().query(
        `SELECT status, route, pipeline_run_id, pm_task_id, kind, declined_reason, triaged_by, triaged_at, source, client_id, project_id, requested_by
           FROM webdev_change_requests WHERE id = $1`,
        [id],
      )
    ).rows[0];

  /** Notifications of `type` for `userId`, optionally narrowed to ONE change request.
   *
   *  The entityId narrowing is not cosmetic. Without it this helper counted every decline notice the
   *  whole suite had produced for that contact (3, not 1) — because a decline notifies the CLIENT's
   *  active contacts even when the change request was `source='internal'`, so unrelated earlier tests
   *  had already reached the same people. See the "internal-source decline" test below, which pins
   *  that behaviour as a REPORTED FINDING rather than letting it hide inside a loose count. */
  const notifsFor = async (userId: string, type: string, entityId?: string) =>
    (
      await adminPool().query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM notifications
          WHERE tenant_id = $1 AND user_id = $2 AND type = $3
            ${entityId ? "AND payload->>'entityId' = $4" : ""}
          ORDER BY created_at ASC`,
        entityId ? [co, userId, type, entityId] : [co, userId, type],
      )
    ).rows;

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // §4.1 / §4.2 — Cerbos. Probed POSITIVELY: the invariant is asserted, not assumed from a DENY.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("§4.1 INVARIANT (file-level): the `client` derived role appears in NO rule of the staff policy", async () => {
    const yaml = readFileSync(POLICY_PATH, "utf8");
    // Only the derivedRoles LISTS are inspected — the file's header comments discuss `client` at
    // length on purpose, and a naive substring search would flag its own documentation.
    const roleLists = [...yaml.matchAll(/derivedRoles:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
    expect(roleLists.length).toBeGreaterThan(0);
    const roles = roleLists.flatMap((l) => l.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")));
    expect(roles).not.toContain("client");
    // 0072's safety argument is "a client-grant-only principal satisfies exactly ONE policy". If a
    // future edit adds a client rule here, that argument silently retires — this is the tripwire.
    //
    // IAM-04-ROLLOUT-B12 (purely additive): added the three perm_webdev_change_request_* permission-
    // matching derived roles (read/create/triage), mirroring company_admin+manager+module_manager+
    // module_staff's combined reach per action — see derived_roles.yaml and
    // docs/superpowers/plans/2026-08-10-iam-04-rollout-b12-report.md. None of them is `client`; the
    // invariant this test exists to pin (line above: `roles` never contains "client") is unaffected.
    expect(new Set(roles)).toEqual(
      new Set([
        "platform_admin",
        "group_executive",
        "company_admin",
        "manager",
        "module_manager",
        "module_staff",
        "perm_webdev_change_request_read",
        "perm_webdev_change_request_create",
        "perm_webdev_change_request_triage",
      ]),
    );
  });

  it("a client-role-only principal is DENIED on all three actions (read, create, triage) — while its portal surface still works", async () => {
    const cr = await internalCr();
    // Positive control FIRST: this principal is a fully working portal client, so the three DENYs
    // below cannot be explained away as "the fixture was never authorized for anything".
    const portalOk = await app.inject({
      method: "POST", url: `/api/${co}/portal/change-requests`, headers: asUser(clientOnly),
      payload: { kind: "bug", title: `client can still submit ${uniq()}` },
    });
    expect(portalOk.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests`, headers: asUser(clientOnly) });
    expect(list.statusCode).toBe(403);
    const detail = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${cr.id}`, headers: asUser(clientOnly) });
    expect(detail.statusCode).toBe(403);
    const create = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(clientOnly),
      payload: { kind: "bug", title: "staff-side create attempt" },
    });
    expect(create.statusCode).toBe(403);
    const t = await triage(cr.id, { action: "decline", reason: "nope" }, clientOnly);
    expect(t.statusCode).toBe(403);
    // ...and the refused triage changed nothing.
    expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null });
  });

  it("TRAP #4: a group_executive with NO membership row is ALLOWED read AND triage (the exec rule is notLow-only)", async () => {
    // Proof the fixture really is membership-less: `inTenant` is `resource.tenantId in
    // principal.companies`, and `companies` is built only from company_memberships/client_contacts.
    const memberships = await adminPool().query(
      `SELECT 1 FROM company_memberships WHERE user_id = $1 UNION ALL SELECT 1 FROM client_contacts WHERE user_id = $1`,
      [exec],
    );
    expect(memberships.rowCount).toBe(0);

    const list = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests`, headers: asUser(exec) });
    expect(list.statusCode).toBe(200);

    const cr = await internalCr();
    const declined = await triage(cr.id, { action: "decline", reason: "the owner disposes of it" }, exec);
    expect(declined.statusCode).toBe(200);
    expect(await crRow(cr.id)).toMatchObject({ status: "declined", triaged_by: exec });
  });

  it("an exec converting to a mini_run gets an OWNER-LESS run (not a 400) — the trap-#4 interaction with assertOwnerIsStaff", async () => {
    const cr = await internalCr();
    const r = await triage(cr.id, { action: "convert", route: "mini_run" }, exec);
    expect(r.statusCode).toBe(200);
    const runId = (r.json() as { pipelineRunId: string }).pipelineRunId;
    const run = await adminPool().query(`SELECT owner_id, created_by FROM pipeline_runs WHERE id = $1`, [runId]);
    // NULL is the honest value: the policy deliberately admits a triager with no membership, so
    // demanding staff membership for `owner_id` would 400 exactly the principal it just allowed.
    expect(run.rows[0].owner_id).toBeNull();
    expect(run.rows[0].created_by).toBe(exec);
  });

  it("a plain member is DENIED read (the queue exposes every client's asks tenant-wide)", async () => {
    const list = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests`, headers: asUser(plainMember) });
    expect(list.statusCode).toBe(403);
  });

  it("module tiers: webdev_manager may read AND triage; webdev_staff may read but NOT triage or create", async () => {
    const forManager = await internalCr();
    expect((await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests`, headers: asUser(webdevManager) })).statusCode).toBe(200);
    expect((await triage(forManager.id, { action: "decline", reason: "dept manager declines" }, webdevManager)).statusCode).toBe(200);

    const forStaff = await internalCr();
    expect((await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests`, headers: asUser(webdevStaff) })).statusCode).toBe(200);
    expect((await triage(forStaff.id, { action: "decline", reason: "staff should not decide" }, webdevStaff)).statusCode).toBe(403);
    const create = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(webdevStaff),
      payload: { kind: "bug", title: "staff internal create" },
    });
    expect(create.statusCode).toBe(403);
    expect(await crRow(forStaff.id)).toMatchObject({ status: "new" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // TRAP #2 / D-2a — the plain tenant wall. Reads must work with AND without a declared module scope.
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("D-2a (file-level): migration 0088 carries NO app_module_allowed clause and no module column", async () => {
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const executable = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--")) // the header EXPLAINS the decision; don't match it
      .join("\n");
    expect(executable).not.toMatch(/app_module_allowed/);
    expect(executable).toMatch(/FORCE ROW LEVEL SECURITY/);
    // No per-row module column either (0076's pattern is for a table shared by many modules).
    expect(executable).not.toMatch(/^\s*module\s+text/m);
  });

  it("TRAP #2 regression guard: the same rows are readable with NO module scope, with ['webdev'], and with an UNRELATED scope", async () => {
    const cr = await internalCr();
    const count = (rows: { n: number }[]) => rows[0].n;
    const q = `SELECT count(*)::int AS n FROM webdev_change_requests WHERE id = $1`;

    const bare = await withTenants([co], (c) => c.query<{ n: number }>(q, [cr.id]));
    const declared = await withTenants([co], (c) => c.query<{ n: number }>(q, [cr.id]), { modules: ["webdev"] });
    // The third case is the one that makes this a real guard rather than a tautology: this company's
    // `enabled_modules` is EMPTY, so if the table were third-walled, declaring ['webdev'] would ALSO
    // read zero rows and a two-case test would "agree" at 0/0 and pass.
    const unrelated = await withTenants([co], (c) => c.query<{ n: number }>(q, [cr.id]), { modules: ["hr"] });

    expect(count(bare.rows)).toBe(1);
    expect(count(declared.rows)).toBe(1);
    expect(count(unrelated.rows)).toBe(1);
  });

  it("the plain tenant wall still isolates tenants: a co request is invisible under co2 (404, RLS)", async () => {
    const cr = await internalCr();
    const cross = await app.inject({
      method: "GET", url: `/api/${co2}/webdev/change-requests/${cr.id}`, headers: asUser(admin2),
    });
    expect(cross.statusCode).toBe(404);
    const crossList = await app.inject({ method: "GET", url: `/api/${co2}/webdev/change-requests`, headers: asUser(admin2) });
    expect(crossList.statusCode).toBe(200);
    expect((crossList.json() as CrListRow[]).map((r) => r.id)).not.toContain(cr.id);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Internal create (source='internal')
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("internal create stores source='internal', status='new', the acting staff member as requester — and ignores body status/route/source", async () => {
    const { id, res } = await internalCr({ status: "done", route: "mini_run", source: "portal", body: "internal note" });
    expect(res.statusCode).toBe(201);
    expect(await crRow(id)).toMatchObject({
      source: "internal", status: "new", route: null, requested_by: admin, client_id: clientA, project_id: projX,
    });
    const outbox = await adminPool().query<{ event_type: string }>(
      `SELECT event_type FROM outbox_events WHERE entity_type = 'webdev_change_request' AND entity_id = $1`, [id],
    );
    expect(outbox.rows.map((r) => r.event_type)).toEqual(["webdev.change_request.created"]);
  });

  it("internal create allows a client-less request (the ONE case the DDL permits a NULL client_id)", async () => {
    const { id, res } = await internalCr({ clientId: null, projectId: null });
    expect(res.statusCode).toBe(201);
    expect(await crRow(id)).toMatchObject({ source: "internal", client_id: null, project_id: null });
  });

  it("a cross-tenant clientId is refused 400 by the composite FK, not silently accepted", async () => {
    const { res } = await internalCr({ clientId: clientOther });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/belong to this tenant/i);
  });

  it("internal create rejects a bad kind and a missing title", async () => {
    const badKind = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(admin),
      payload: { kind: "urgent", title: "not a kind" },
    });
    expect(badKind.statusCode).toBe(400);
    const noTitle = await app.inject({
      method: "POST", url: `/api/${co}/webdev/change-requests`, headers: asUser(admin),
      payload: { kind: "bug", title: "   " },
    });
    expect(noTitle.statusCode).toBe(400);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Decline
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("a decline WITHOUT a reason is refused, and the request stays 'new'", async () => {
    const cr = await internalCr();
    const r = await triage(cr.id, { action: "decline" });
    expect(r.statusCode).toBe(400);
    expect(await crRow(cr.id)).toMatchObject({ status: "new", declined_reason: null, triaged_by: null });
  });

  it("a decline records the reason, carries NO route, and notifies the requester AND the viewer contact (asserted by row)", async () => {
    const cr = await portalCr(signerC);
    const r = await triage(cr.id, { action: "decline", reason: "out of the current maintenance contract" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: cr.id, status: "declined", route: null });

    expect(await crRow(cr.id)).toMatchObject({
      status: "declined", route: null, pipeline_run_id: null, pm_task_id: null,
      declined_reason: "out of the current maintenance contract", triaged_by: admin,
    });

    // The requester hears it, by ROW — and so does the viewer contact: a decline is `general`, and
    // §5.1's ruling is that viewers are participants in the conversation, only not in signing.
    const toRequester = await notifsFor(signerC, "webdev.change_request.declined", cr.id);
    expect(toRequester).toHaveLength(1);
    expect(toRequester[0].payload).toMatchObject({
      entityType: "webdev_change_request", entityId: cr.id, severity: "warning",
      href: "/portal/requests",
      body: "out of the current maintenance contract",
    });
    expect(await notifsFor(viewerC, "webdev.change_request.declined", cr.id)).toHaveLength(1);

    const acts = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM activities WHERE target_entity_type = 'webdev_change_request' AND target_entity_id = $1 AND verb = 'declined'`,
      [cr.id],
    );
    expect(acts.rows[0].n).toBe(1);
  });

  // ✅ F1 — RULED AND FIXED 2026-08-08 (owner adopted the recommendation). The behaviour described
  // below WAS the shipped behaviour and is now inverted: internal-source dispositions stay internal.
  // The fix is `dispositionClientRecipients()` in the controller, which gates the `kind:'general'`
  // audience on `source='portal'`. Deliberately NOT gated: the `kind:'signature'` audience on the
  // mini_run path — an internally-raised mini-run still opens a real `prd_sign` gate the client must
  // sign, and silencing that would strand the run the way the portal's own "waiting on client" bug did.
  // The rule is about AUTHORSHIP, not about the client's stake. Historical description follows, because
  // the reasoning is what makes the assertions below legible:
  //
  // Declining a `source='internal'` change request notified the named client's active contacts with
  // "Your change request was declined" AND the staff decline reason verbatim in `body`. Nobody on the
  // client side asked for that work: an internal CR is staff logging their own maintenance against a
  // client. `createInternal` already reasons its way to the opposite conclusion for the SUBMIT event
  // ("notifying the client's project owners about internal work would be the notification storm
  // portal-commerce.controller.ts:548–566 exists to avoid") — the disposition path just never applied
  // the same rule, because `resolveClientRecipients` is keyed on `client_id` alone and does not know
  // the CR's `source`. Design §5.3 row 2 says only "the requester + every active contact in scope",
  // which is written about the portal flow and is silent on internal-source rows.
  //
  it("F1: declining an INTERNAL-source request notifies the staff requester and NO client contact", async () => {
    const cr = await internalCr();
    // Declined by a DIFFERENT staff member than the requester, because `notify()` skips self — an
    // admin declining their own request would produce a vacuous zero for the requester assertion.
    const r = await triage(cr.id, { action: "decline", reason: "we are rebuilding this page next quarter anyway" }, exec);
    expect(r.statusCode).toBe(200);
    expect(await crRow(cr.id)).toMatchObject({ source: "internal", status: "declined" });

    // THE POSITIVE CONTROL COMES FIRST. Without it a zero below is satisfiable by a notify path that
    // is simply broken for everyone — which is the failure mode this estate has hit repeatedly ("a
    // missing field reads as null"; an empty list proves nothing). The staff requester receiving the
    // decline proves the notification machinery ran for THIS change request.
    expect(await notifsFor(admin, "webdev.change_request.declined", cr.id)).toHaveLength(1);

    // ...and only then is the silence meaningful: no client contact hears about staff-raised work,
    // and the internal triage note does not leave the company.
    expect(await notifsFor(signerC, "webdev.change_request.declined", cr.id)).toHaveLength(0);
    expect(await notifsFor(viewerC, "webdev.change_request.declined", cr.id)).toHaveLength(0);
  });

  it("F1 counter-case: a PORTAL-source request the client DID raise still reaches its contacts", async () => {
    // The other half of the ruling, and what stops the fix from being "clients are never notified".
    // If this ever goes silent, `dispositionClientRecipients` has over-reached from `source` to
    // `client_id` and the portal flow has lost its disposition messages entirely.
    const cr = await portalCr();
    const r = await triage(cr.id, { action: "decline", reason: "out of scope for the current retainer" }, exec);
    expect(r.statusCode).toBe(200);
    expect(await crRow(cr.id)).toMatchObject({ source: "portal", status: "declined" });

    const toSigner = await notifsFor(signerC, "webdev.change_request.declined", cr.id);
    expect(toSigner).toHaveLength(1);
    expect(toSigner[0].payload).toMatchObject({ body: "out of scope for the current retainer" });
  });

  it("an unknown change-request id is 404 (not a 500 and not a silent 200)", async () => {
    const r = await triage(newId(), { action: "decline", reason: "no such thing" });
    expect(r.statusCode).toBe(404);
  });

  it("a malformed action / route / kindOverride is refused 400 before anything is touched", async () => {
    const cr = await internalCr();
    for (const payload of [
      { action: "approve" },
      { action: "convert", route: "webhook" },
      { action: "convert", kindOverride: "urgent" },
      {},
    ]) {
      expect((await triage(cr.id, payload)).statusCode).toBe(400);
    }
    expect(await crRow(cr.id)).toMatchObject({ status: "new" });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Convert — routes
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("route 'control_plane' is refused 501 naming webdesk, and the request is left re-triageable", async () => {
    const cr = await internalCr({ kind: "content" });
    const r = await triage(cr.id, { action: "convert", route: "control_plane" });
    expect(r.statusCode).toBe(501);
    expect((r.json() as { error: string }).error).toMatch(/webdesk/i);
    // The refusal is thrown INSIDE the transaction, so nothing partial survives.
    expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null, triaged_by: null, triaged_at: null });
  });

  it("kind defaults route: content/bug -> pm_task, design/feature -> mini_run (a suggestion, overridable)", async () => {
    for (const [kind, route] of [["content", "pm_task"], ["bug", "pm_task"], ["design", "mini_run"], ["feature", "mini_run"]] as const) {
      const cr = await internalCr({ kind });
      const r = await triage(cr.id, { action: "convert" }); // NO route named -> the §2.3 default
      expect(r.statusCode).toBe(200);
      expect((r.json() as { route: string }).route).toBe(route);
    }
    // ...and the PM's explicit choice always wins over the suggestion (blueprint §07).
    const bug = await internalCr({ kind: "bug" });
    const overridden = await triage(bug.id, { action: "convert", route: "mini_run" });
    expect(overridden.statusCode).toBe(200);
    expect((overridden.json() as { route: string }).route).toBe("mini_run");
  });

  it("convert -> pm_task creates a REAL pm_task through the PM module and links it; kindOverride is recorded", async () => {
    const cr = await internalCr({ kind: "feature" });
    const r = await triage(cr.id, { action: "convert", route: "pm_task", kindOverride: "bug" });
    expect(r.statusCode).toBe(200);
    const taskId = (r.json() as { pmTaskId: string }).pmTaskId;

    const task = await adminPool().query(
      `SELECT project_id, title, description, priority, seq, tenant_id FROM pm_tasks WHERE id = $1`, [taskId],
    );
    expect(task.rows[0]).toMatchObject({ project_id: projX, title: cr.title, tenant_id: co });
    expect(task.rows[0].priority).toBe("high");            // kindOverride 'bug' -> high
    expect(task.rows[0].seq).not.toBeNull();               // WD-28 seq allocated by PM's own service
    expect(String(task.rows[0].description)).toContain(cr.title);

    expect(await crRow(cr.id)).toMatchObject({
      status: "in_progress", route: "pm_task", pm_task_id: taskId, pipeline_run_id: null, kind: "bug", triaged_by: admin,
    });
    // PM's own event fired from inside the shared transaction — proof the in-process service call was
    // used rather than a duplicated INSERT in core.
    const pmEvent = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox_events WHERE entity_type = 'pm_task' AND entity_id = $1 AND event_type = 'pm.task.created'`,
      [taskId],
    );
    expect(pmEvent.rows[0].n).toBe(1);
  });

  it("convert -> pm_task on a request that names NO project is refused 400 (there is nothing to guess)", async () => {
    const cr = await internalCr({ projectId: null });
    const r = await triage(cr.id, { action: "convert", route: "pm_task" });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toMatch(/names no project/i);
    expect(await crRow(cr.id)).toMatchObject({ status: "new", route: null, pm_task_id: null });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Convert -> mini_run: §3.1's row shapes, and what must NOT be pre-seeded
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("convert -> mini_run writes an ORDINARY run + two done extraction stages + exactly ONE client prd_sign gate", async () => {
    const cr = await portalCr(signerC, { kind: "design" });
    const r = await triage(cr.id, { action: "convert", route: "mini_run" });
    expect(r.statusCode).toBe(200);
    const runId = (r.json() as { pipelineRunId: string }).pipelineRunId;

    const run = await adminPool().query(
      `SELECT tenant_id, source_meeting_id, title, status, client_id, project_id, owner_id, created_by, mom_ref
         FROM pipeline_runs WHERE id = $1`, [runId],
    );
    expect(run.rows[0]).toMatchObject({
      tenant_id: co,
      source_meeting_id: null,      // a mini-run has no meeting — the honest value (§3.1 step 1)
      mom_ref: null,
      title: cr.title,
      status: "delivery_active",
      client_id: clientA,
      project_id: null,             // this portal CR is client-wide
      owner_id: admin,              // the triaging PM, who IS a staff member here
      created_by: admin,
    });

    const stages = await adminPool().query<{ track: string; name: string; status: string; artifact_ref: string; confidence: number | null }>(
      `SELECT track, name, status, artifact_ref, confidence FROM pipeline_stages WHERE run_id = $1 ORDER BY track`, [runId],
    );
    expect(stages.rows.map((s) => `${s.track}/${s.name}`)).toEqual(["delivery/prd_extract", "scope/scope_extract"]);
    expect(stages.rows.every((s) => s.status === "done")).toBe(true);
    expect(stages.rows.every((s) => s.confidence === null)).toBe(true);
    expect(stages.rows[0].artifact_ref).toContain(cr.title);
    expect(stages.rows[0].artifact_ref).toContain("the hero image is stretched on mobile");
    expect(stages.rows[1].artifact_ref).toContain("Scope —");
    // NO `report` track: there is no meeting to minute.
    expect(stages.rows.some((s) => s.track === "report")).toBe(false);

    const gates = await adminPool().query<{ kind: string; actor_side: string; status: string; stage_id: string | null; opened_by: string }>(
      `SELECT kind, actor_side, status, stage_id, opened_by FROM pipeline_gates WHERE run_id = $1`, [runId],
    );
    // EXACTLY ONE gate. The client `scope_signoff` gate is opened by the shipped `pipeline-fanout`
    // workflow off the event below — pre-seeding it here would forge a beat the client never reached,
    // and the hard build gate must only ever be satisfied by real signatures.
    expect(gates.rows).toHaveLength(1);
    expect(gates.rows[0]).toMatchObject({ kind: "prd_sign", actor_side: "client", status: "pending", stage_id: null, opened_by: admin });

    expect(await crRow(cr.id)).toMatchObject({ status: "in_progress", route: "mini_run", pipeline_run_id: runId, pm_task_id: null });
  });

  it("PAYLOAD PARITY: the mini-run's `pipeline.run.created` payload has the same key set as createRun's", async () => {
    // A meeting-born run through the shipped endpoint, for the comparison baseline.
    const meetingBorn = await app.inject({
      method: "POST", url: `/api/${co}/pipeline/runs`, headers: asUser(admin),
      payload: { sourceMeetingId: `parity-${uniq()}`, title: "meeting-born baseline", stages: [{ track: "delivery", name: "prd_extract", status: "done" }] },
    });
    expect(meetingBorn.statusCode).toBe(201);
    const baselineId = (meetingBorn.json() as { id: string }).id;

    const cr = await internalCr({ kind: "feature" });
    const spawned = await triage(cr.id, { action: "convert", route: "mini_run" });
    const runId = (spawned.json() as { pipelineRunId: string }).pipelineRunId;

    const payloadOf = async (entityId: string) =>
      (
        await adminPool().query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM outbox_events WHERE entity_type = 'pipeline_run' AND entity_id = $1 AND event_type = 'pipeline.run.created'`,
          [entityId],
        )
      ).rows;

    const baseline = await payloadOf(baselineId);
    const mini = await payloadOf(runId);
    expect(baseline).toHaveLength(1);
    expect(mini).toHaveLength(1);
    // Key-set parity is the contract the shipped `pipeline-fanout` workflow depends on: a mini-run
    // must be indistinguishable from a meeting-born run to every downstream consumer.
    expect(Object.keys(mini[0].payload).sort()).toEqual(Object.keys(baseline[0].payload).sort());
    expect(mini[0].payload).toMatchObject({ sourceMeetingId: null, title: cr.title, actorId: admin });

    // The gate-open event fires too, in openGate's shape, so anything watching gates sees this one.
    const gateEvents = await adminPool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM outbox_events WHERE entity_type = 'pipeline_gate' AND event_type = 'pipeline.gate.opened' AND payload->>'runId' = $1`,
      [runId],
    );
    expect(gateEvents.rows).toHaveLength(1);
    expect(gateEvents.rows[0].payload).toMatchObject({ runId, kind: "prd_sign", actorSide: "client" });
  });

  it("§5.3: the converted notice reaches viewer AND signer, but the prd_sign SIGNATURE request reaches SIGNERS ONLY", async () => {
    const cr = await portalCr(signerC, { kind: "feature" });
    const viewerGatesBefore = (await notifsFor(viewerC, "pipeline.gate.opened")).length;
    const r = await triage(cr.id, { action: "convert", route: "mini_run" });
    expect(r.statusCode).toBe(200);
    const runId = (r.json() as { pipelineRunId: string }).pipelineRunId;

    // 'converted' is a general progress notice: every active contact in scope, viewer included.
    const convertedToViewer = await notifsFor(viewerC, "webdev.change_request.converted", cr.id);
    expect(convertedToViewer).toHaveLength(1);
    expect(convertedToViewer[0].payload).toMatchObject({
      href: `/portal/approvals/${runId}`, entityType: "webdev_change_request", entityId: cr.id, severity: "info",
    });
    // The requester (a signer) hears it too.
    expect(await notifsFor(signerC, "webdev.change_request.converted", cr.id)).toHaveLength(1);

    // The SIGNATURE ask is capability-gated: a viewer asked to sign cannot sign, so must not be asked.
    // Asserted as a NEGATIVE beside a POSITIVE for the same event and the same transaction — "it did
    // not arrive" proves nothing on its own (a broken notify would satisfy it too).
    const signerGate = await notifsFor(signerC, "pipeline.gate.opened");
    expect(signerGate.length).toBeGreaterThanOrEqual(1);
    expect(signerGate[signerGate.length - 1].payload).toMatchObject({
      entityType: "pipeline_gate", severity: "warning", href: `/portal/approvals/${runId}`,
    });
    expect((await notifsFor(viewerC, "pipeline.gate.opened")).length).toBe(viewerGatesBefore);
  });

  it("the ux_wcr_run partial unique physically refuses linking a SECOND change request to one run", async () => {
    const cr = await internalCr({ kind: "design" });
    const runId = ((await triage(cr.id, { action: "convert", route: "mini_run" })).json() as { pipelineRunId: string }).pipelineRunId;
    await expect(
      adminPool().query(
        `INSERT INTO webdev_change_requests
           (id, tenant_id, source, kind, title, status, route, pipeline_run_id, client_id, project_id, origin_site)
         VALUES (gen_random_uuid(), $1, 'internal', 'design', 'a hand-written twin', 'in_progress', 'mini_run', $2, $3, $4, 'test')`,
        [co, runId, clientA, projX],
      ),
    ).rejects.toThrow(/ux_wcr_run|duplicate key/i);
    // ...and many NULLs are still fine (a partial unique over the non-null set — trap #6).
    const nulls = await adminPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM webdev_change_requests WHERE pipeline_run_id IS NULL`,
    );
    expect(nulls.rows[0].n).toBeGreaterThan(1);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Reads
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  it("the queue lists OLDEST-first and filters by status / kind / client / project", async () => {
    const first = await internalCr({ kind: "bug" });
    const second = await internalCr({ kind: "design" });

    const all = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests?status=new`, headers: asUser(admin) });
    expect(all.statusCode).toBe(200);
    const rows = all.json() as CrListRow[];
    expect(rows.every((r) => r.status === "new")).toBe(true);
    const iFirst = rows.findIndex((r) => r.id === first.id);
    const iSecond = rows.findIndex((r) => r.id === second.id);
    expect(iFirst).toBeGreaterThanOrEqual(0);
    // A triage queue is worked front-to-back: the request that has waited longest must come first.
    expect(iFirst).toBeLessThan(iSecond);

    const byKind = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests?kind=design`, headers: asUser(admin) });
    expect((byKind.json() as CrListRow[]).every((r) => r.kind === "design")).toBe(true);
    const byClient = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests?clientId=${clientA}`, headers: asUser(admin) });
    expect((byClient.json() as CrListRow[]).every((r) => r.clientId === clientA)).toBe(true);
    const byProject = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests?projectId=${projX}`, headers: asUser(admin) });
    expect((byProject.json() as CrListRow[]).every((r) => r.projectId === projX)).toBe(true);
  });

  it("a malformed uuid in a filter matches nothing instead of 500ing the request", async () => {
    const r = await app.inject({
      method: "GET", url: `/api/${co}/webdev/change-requests?clientId=not-a-uuid`, headers: asUser(admin),
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it("detail joins the linked run live, so the CR reflects run status without copying it", async () => {
    const cr = await internalCr({ kind: "design" });
    const runId = ((await triage(cr.id, { action: "convert", route: "mini_run" })).json() as { pipelineRunId: string }).pipelineRunId;

    const before = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${cr.id}`, headers: asUser(admin) });
    expect(before.json()).toMatchObject({ pipelineRunId: runId, runStatus: "delivery_active", runTitle: cr.title });

    // Park the run through its OWN surface; the CR detail must follow without any CR write.
    const parked = await app.inject({
      method: "PATCH", url: `/api/${co}/pipeline/runs/${runId}`, headers: asUser(admin), payload: { status: "blocked" },
    });
    expect(parked.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${cr.id}`, headers: asUser(admin) });
    expect(after.json()).toMatchObject({ runStatus: "blocked", status: "in_progress" });
  });

  it("detail 404s an unknown id and a soft-deleted row", async () => {
    expect((await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${newId()}`, headers: asUser(admin) })).statusCode).toBe(404);
    const cr = await internalCr();
    await adminPool().query(`UPDATE webdev_change_requests SET deleted_at = now() WHERE id = $1`, [cr.id]);
    expect((await app.inject({ method: "GET", url: `/api/${co}/webdev/change-requests/${cr.id}`, headers: asUser(admin) })).statusCode).toBe(404);
  });
});
