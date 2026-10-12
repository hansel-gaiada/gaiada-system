// The site.archive FILING route and its in-band execution (owner ruling 2026-10-12: archiving a WebDesk site TAKES
// an approval; HIGH, always WS4-gated, never self-approvable). `POST /api/:tenantId/modules/webdev/control/sites/:siteId/archive`
// used to be an always-501 stub (WSK-31). Now it FILES one WSK-66 approval (202 {approvalId}); a DIFFERENT authorised
// user approves it at `POST …/automation-approvals/:id/decide`, and decide() sends the one WS4-asserted `site.archive`
// to Zone B. Modelled on webdesk-key-mint.test.ts.
//
// Real: Postgres (RLS, the approval rows, the activities ledger), Cerbos (the real resource_webdev_provisioned_site.yaml
// `promote` gate and the approvals policy), the full NestJS app, `controlRequestSiteArchive`, WSK-66's real filer and
// in-band executor driven through the real decide route. Stand-in: Zone B, the in-process fake (`webdesk-content-testkit.ts`),
// whose `site.archive` follows WebDesk's lifecycle.service#archiveSite (terminal; a second archive is a 409).
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!live)("site.archive filing: POST control/sites/:siteId/archive files ONE approval; a different user archives", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string;
  let adminA: string; // files
  let adminA2: string; // decides (maker ≠ checker)
  let editorA: string;
  let memberA: string;
  let adminB: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const archiveUrl = (co = A, siteId = GAIADA_SITE) => `/api/${co}/modules/webdev/control/sites/${siteId}/archive`;
  const file = (as: string, body: unknown = { tenantSlug: GAIADA_SLUG }, url = archiveUrl()) =>
    app.inject({ method: "POST", url, headers: asUser(as), payload: body as never });
  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });

  async function row(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string | null; execution_error: string | null; execution_result: unknown;
      tool_args: Record<string, unknown>; origin: string; workflow_id: string; tool_name: string; impact: string;
      requested_by: string; reason: string;
    }>(
      `SELECT status, execution_status, execution_error, execution_result, tool_args, origin, workflow_id, tool_name, impact, requested_by, reason
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function pendingArchives(): Promise<number> {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_approvals WHERE tenant_id = $1 AND workflow_id = 'site.archive' AND status = 'pending' AND deleted_at IS NULL`,
      [A],
    );
    return Number(rows[0].n);
  }
  const zoneBWrites = () => zb.calls.filter((c) => c.command === "site.archive");

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("Site-archive Co A", ["webdev"]);
    B = await createCompany("Site-archive Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "sitearchive-admin-a@ex.test", "company_admin");
    adminA2 = await mk(A, "sitearchive-admin-a2@ex.test", "company_admin");
    editorA = await mk(A, "sitearchive-editor-a@ex.test", "webdev_staff");
    memberA = await mk(A, "sitearchive-member-a@ex.test", "member");
    adminB = await mk(B, "sitearchive-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    // Each test starts with no open site.archive request (the de-dup would otherwise hand back an earlier test's id).
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'site.archive' AND deleted_at IS NULL`, [A]);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("files exactly ONE approval: 202 {approvalId}; HIGH, origin webdesk, the row names the site and says it is irreversible; nothing is sent to Zone B", async () => {
    const r = await file(adminA);
    expect(r.statusCode).toBe(202);
    const { approvalId } = r.json<{ approvalId: string }>();
    expect(Object.keys(r.json())).toEqual(["approvalId"]); // a NEW filing carries no `alreadyPending`
    expect(await pendingArchives()).toBe(1);
    const a = await row(approvalId);
    expect(a).toMatchObject({ status: "pending", origin: "webdesk", workflow_id: "site.archive", tool_name: "webdesk.site.archive", impact: "high", requested_by: adminA });
    const { summary, commandHash, ...args } = a.tool_args;
    expect(args).toEqual({ command: "site.archive", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE });
    expect(commandHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tool_args).not.toHaveProperty("rebuild"); // an archive triggers no staging rebuild
    expect((summary as { title: string }).title).toBe(
      `Archive site "Main" of ${GAIADA_SLUG} (irreversible: it stops serving content and accepts no writes)`,
    );
    expect(a.reason).toBe((summary as { title: string }).title);
    expect(zoneBWrites()).toHaveLength(0);
  });

  it("another company's site is a 404 site-not-found (the wall), with no row; ✅ control: the caller's own site files", async () => {
    const r = await file(adminA, { tenantSlug: OTHER_SLUG }, archiveUrl(A, OTHER_SITE));
    expect(r.statusCode).toBe(404);
    expect(r.json().type).toMatch(/\/site-not-found$/);
    expect(await pendingArchives()).toBe(0);
    expect((await file(adminA)).statusCode).toBe(202);
  });

  it("a malformed body is a typed 400 invalid_request and files nothing (unknown key, missing tenantSlug, non-string, non-object)", async () => {
    for (const body of [{ tenantSlug: GAIADA_SLUG, extra: 1 }, {}, { tenantSlug: 42 }, { tenantSlug: "" }, ["not", "an", "object"]]) {
      const r = await file(adminA, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ reason: "invalid_request" });
    }
    expect(await pendingArchives()).toBe(0);
  });

  it("🔴 a member and a webdev editor are 403 (the promote gate is FIRST: a valid body, and an invalid one, both 403); ✅ control: company_admin files", async () => {
    for (const who of [memberA, editorA]) {
      expect((await file(who)).statusCode).toBe(403);
      expect((await file(who, { nonsense: true })).statusCode).toBe(403);
    }
    expect(await pendingArchives()).toBe(0);
    expect((await file(adminA)).statusCode).toBe(202);
  });

  it("de-dup: filing again returns the SAME pending approval, by anyone; once decided, a new filing is a new one", async () => {
    const first = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    const dup = await file(adminA2);
    expect(dup.statusCode).toBe(202);
    expect(dup.json()).toEqual({ approvalId: first, alreadyPending: true });
    expect(await pendingArchives()).toBe(1);
    expect((await decide(first, adminA2, "rejected")).statusCode).toBe(200);
    const again = (await file(adminA)).json();
    expect(again.approvalId).not.toBe(first);
    expect(again).not.toHaveProperty("alreadyPending");
  });

  it("approve by a DIFFERENT company_admin → exactly one WS4 site.archive to Zone B (no editorial assertion); the row is executed; the site reads as archived and cannot be filed again", async () => {
    const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
    expect(zoneBWrites()[0]).toMatchObject({ hadWs4: true, params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE }, body: {} });
    expect(zoneBWrites()[0].editorialAssertion).toBeUndefined(); // site.archive is not an EDITORIAL_COMMAND
    expect(signer.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({ id, status: "approved", webdesk: { command: "site.archive", executionStatus: "executed", siteId: GAIADA_SITE, status: "archived" } });

    const after = await row(id);
    expect(after).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
    expect(after.execution_result).toBeTruthy();
    // The ledger shows the attempt and the outcome, as the decider.
    const { rows } = await adminPool().query<{ outcome: string }>(
      `SELECT metadata->>'outcome' AS outcome FROM activities WHERE target_entity_id = $1 AND verb = 'webdesk.site.archive' ORDER BY occurred_at, id`,
      [id],
    );
    expect(rows.map((x) => x.outcome)).toEqual(["attempted", "succeeded"]);

    // Single use: a second decide sends nothing.
    expect((await decide(id, adminA2)).statusCode).toBe(404);
    expect(zoneBWrites()).toHaveLength(1);

    // The wall's next answer reports the site archived: filing is refused with a typed 409, and files nothing.
    webdeskZoneB.clearSiteCache();
    const refile = await file(adminA);
    expect(refile.statusCode).toBe(409);
    expect(refile.json().type).toMatch(/\/site-archived$/);
    expect(await pendingArchives()).toBe(0);
  });

  it("🔴 the requester cannot approve their own site.archive (maker ≠ checker, in code): 403, zero Zone B calls, row stays pending; ✅ control: another admin → executed", async () => {
    const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    const self = await decide(id, adminA);
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain("a site archive may not be approved by the principal who requested it");
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
    expect((await decide(id, adminA2)).statusCode).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
  });

  it("company B's admin cannot decide company A's site.archive (another company's approval is not theirs): no Zone B call", async () => {
    const id = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    const r = await decide(id, adminB);
    expect([403, 404]).toContain(r.statusCode);
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
  });

  it("a Zone B refusal is recorded as a typed failure (webdesk_refused) and never resent; an ambiguous failure fails webdesk_ambiguous and is NOT reconciled by reading", async () => {
    const refused = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    zb.nextWriteResponse = problem(403, "ws4-approval-already-used");
    const r1 = await decide(refused, adminA2);
    expect(r1.statusCode).toBe(200); // the decision stands; the outcome is data
    expect(r1.json()).toMatchObject({ webdesk: { command: "site.archive", executionStatus: "failed" } });
    expect((await row(refused)).execution_error).toMatch(/^webdesk_refused: 403 ws4-approval-already-used/);
    expect(zoneBWrites()).toHaveLength(1);

    zb.reset();
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'site.archive' AND deleted_at IS NULL`, [A]);
    const ambiguous = (await file(adminA)).json<{ approvalId: string }>().approvalId;
    zb.dropAfterApply = true;
    const r2 = await decide(ambiguous, adminA2);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toMatchObject({ webdesk: { command: "site.archive", executionStatus: "failed" } });
    expect((await row(ambiguous)).execution_error).toMatch(/^webdesk_ambiguous: the archive may have committed/);
    expect(zb.calls.filter((c) => c.command === "item.get")).toHaveLength(0); // no read-back
    expect(zoneBWrites()).toHaveLength(1); // never resent
  });
});
