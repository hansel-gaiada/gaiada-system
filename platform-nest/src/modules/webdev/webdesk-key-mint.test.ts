// The key.mint FILING route: `POST /api/:tenantId/modules/webdev/control/sites/:siteId/keys` (2026-10-11).
// Before it, WSK-66 could EXECUTE a key.mint at decide(), but nothing in the ERP could FILE one, so the
// production read key the gaiada.com site build needs could not be minted at all.
//
// Real: Postgres (RLS, the approval rows, the activities ledger, the outbox), Cerbos (the real
// resource_webdev_provisioned_site.yaml `promote` gate and the approvals policy), the full NestJS app,
// `controlRequestKeyMint`, WSK-66's real filer and in-band executor driven through the real
// `POST …/automation-approvals/:id/decide`. Stand-in: Zone B, as the in-process fake (`webdesk-content-testkit.ts`),
// whose `key.mint` follows WebDesk's keys-command.service (the env must be the tenant's; plaintext once).
//
// Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_ENV, GAIADA_SITE, GAIADA_SLUG, OTHER_ENV, OTHER_SITE, OTHER_SLUG, makeTestSigner } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!live)("key.mint filing: POST control/sites/:siteId/keys files ONE approval; a different user mints", () => {
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

  const keys = (co = A, siteId = GAIADA_SITE) => `/api/${co}/modules/webdev/control/sites/${siteId}/keys`;
  const file = (as: string, body: unknown, url = keys()) => app.inject({ method: "POST", url, headers: asUser(as), payload: body as never });
  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });
  const prodRead = { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.production, scope: "read" };

  async function row(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string | null; tool_args: Record<string, unknown>; origin: string;
      workflow_id: string; tool_name: string; impact: string; requested_by: string; reason: string;
    }>(
      `SELECT status, execution_status, tool_args, origin, workflow_id, tool_name, impact, requested_by, reason
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function pendingKeyMints(): Promise<number> {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_approvals WHERE tenant_id = $1 AND workflow_id = 'key.mint' AND status = 'pending' AND deleted_at IS NULL`,
      [A],
    );
    return Number(rows[0].n);
  }
  const zoneBWrites = () => zb.calls.filter((c) => c.command === "key.mint");

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("Key-mint Co A", ["webdev"]);
    B = await createCompany("Key-mint Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "keymint-admin-a@ex.test", "company_admin");
    adminA2 = await mk(A, "keymint-admin-a2@ex.test", "company_admin");
    editorA = await mk(A, "keymint-editor-a@ex.test", "webdev_staff");
    memberA = await mk(A, "keymint-member-a@ex.test", "member");
    adminB = await mk(B, "keymint-admin-b@ex.test", "company_admin");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    // Each test starts with no open key.mint request (the de-dup would otherwise hand back an earlier test's id).
    // A soft delete (the de-dup query, like every approvals reader, skips `deleted_at IS NOT NULL` rows).
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'key.mint' AND deleted_at IS NULL`, [A]);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  it("files ONE approval: 202 {approvalId}; the row carries exactly the key.mint args, names the environment, and nothing is sent to Zone B", async () => {
    const r = await file(adminA, prodRead);
    expect(r.statusCode).toBe(202);
    const { approvalId } = r.json<{ approvalId: string }>();
    expect(Object.keys(r.json())).toEqual(["approvalId"]); // a NEW filing carries no `alreadyPending`
    const a = await row(approvalId);
    expect(a).toMatchObject({ status: "pending", origin: "webdesk", workflow_id: "key.mint", tool_name: "webdesk.key.mint", impact: "high", requested_by: adminA });
    const { summary, commandHash, ...args } = a.tool_args;
    expect(args).toEqual({ command: "key.mint", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, envId: GAIADA_ENV.production, scope: "read" });
    expect(commandHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tool_args).not.toHaveProperty("rebuild"); // a key mint triggers no staging rebuild
    expect((summary as { title: string }).title).toBe(`Mint a production read API key for ${GAIADA_SLUG} (site "Main")`);
    expect(a.reason).toBe((summary as { title: string }).title);
    expect(zoneBWrites()).toHaveLength(0);
  });

  it("another company's site is a 404 site-not-found (the wall), with no row; ✅ control: the caller's own site files", async () => {
    const r = await file(adminA, { tenantSlug: OTHER_SLUG, envId: OTHER_ENV.production, scope: "read" }, keys(A, OTHER_SITE));
    expect(r.statusCode).toBe(404);
    expect(r.json().type).toMatch(/\/site-not-found$/);
    expect(await pendingKeyMints()).toBe(0);
    expect((await file(adminA, prodRead)).statusCode).toBe(202);
  });

  it("an environment that is not THIS site's is a 404 environment-not-found (another tenant's env, a random uuid)", async () => {
    for (const envId of [OTHER_ENV.production, "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f"]) {
      const r = await file(adminA, { ...prodRead, envId });
      expect(r.statusCode, envId).toBe(404);
      expect(r.json().type).toMatch(/\/environment-not-found$/);
    }
    expect(await pendingKeyMints()).toBe(0);
  });

  it("a malformed body is a typed 400 invalid_request and files nothing (unknown key, bad scope, missing/non-uuid envId, missing tenantSlug, non-object)", async () => {
    for (const body of [
      { ...prodRead, extra: 1 },
      { ...prodRead, scope: "admin" },
      { tenantSlug: GAIADA_SLUG, scope: "read" },
      { ...prodRead, envId: "production" },
      { envId: GAIADA_ENV.production, scope: "read" },
      ["not", "an", "object"],
    ]) {
      const r = await file(adminA, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ reason: "invalid_request" });
    }
    expect(await pendingKeyMints()).toBe(0);
  });

  it("🔴 a member and a webdev editor are 403 (the promote gate is FIRST: a valid body, and an invalid one, both 403); ✅ control: company_admin files", async () => {
    for (const who of [memberA, editorA]) {
      expect((await file(who, prodRead)).statusCode).toBe(403);
      expect((await file(who, { nonsense: true })).statusCode).toBe(403);
    }
    expect(await pendingKeyMints()).toBe(0);
    expect((await file(adminA, prodRead)).statusCode).toBe(202);
  });

  it("de-dup: filing the same (site, env, scope) again returns the SAME pending approval, by anyone; another env or scope is a new one; once decided, a new filing is a new one", async () => {
    const first = (await file(adminA, prodRead)).json<{ approvalId: string }>().approvalId;
    const dup = await file(adminA, prodRead);
    expect(dup.statusCode).toBe(202);
    expect(dup.json()).toEqual({ approvalId: first, alreadyPending: true });
    expect((await file(adminA2, { ...prodRead, envId: GAIADA_ENV.production.toUpperCase() })).json()).toEqual({ approvalId: first, alreadyPending: true });
    expect(await pendingKeyMints()).toBe(1);

    const write = (await file(adminA, { ...prodRead, scope: "write" })).json().approvalId;
    const staging = (await file(adminA, { ...prodRead, envId: GAIADA_ENV.staging })).json().approvalId;
    expect(new Set([first, write, staging]).size).toBe(3);
    expect(await pendingKeyMints()).toBe(3);

    expect((await decide(first, adminA2, "rejected")).statusCode).toBe(200);
    const again = (await file(adminA, prodRead)).json();
    expect(again.approvalId).not.toBe(first);
    expect(again).not.toHaveProperty("alreadyPending");
  });

  it("approve by a DIFFERENT company_admin → exactly one key.mint to Zone B with WS4; the plaintext is in the decide response ONCE and nowhere else (approval row, activities, outbox, logs)", async () => {
    const id = (await file(adminA, prodRead)).json<{ approvalId: string }>().approvalId;

    const captured: string[] = [];
    const outWrite = process.stdout.write.bind(process.stdout);
    const errWrite = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (outWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(String(chunk));
      return (errWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
        captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
      }),
    );
    let r: Awaited<ReturnType<typeof decide>>;
    try {
      r = await decide(id, adminA2);
    } finally {
      process.stdout.write = outWrite as typeof process.stdout.write;
      process.stderr.write = errWrite as typeof process.stderr.write;
      consoleSpies.forEach((s) => s.mockRestore());
    }

    expect(r.statusCode).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
    expect(zoneBWrites()[0]).toMatchObject({ hadWs4: true, params: { tenantSlug: GAIADA_SLUG }, body: { envId: GAIADA_ENV.production, scope: "read" } });
    expect(zoneBWrites()[0].editorialAssertion).toBeUndefined();
    expect(zb.mintedKeys).toHaveLength(1);
    const plaintext = zb.mintedKeys[0];
    const body = r.json() as { webdesk: { command: string; executionStatus: string; plaintextOnce: string; apiKeyId: string } };
    expect(body.webdesk).toMatchObject({ command: "key.mint", executionStatus: "executed", plaintextOnce: plaintext, envId: GAIADA_ENV.production, scope: "read" });
    expect(r.body.split(plaintext)).toHaveLength(2); // exactly once

    const scan = async (table: string) =>
      (await adminPool().query<{ t: string | null }>(`SELECT string_agg(x::text, E'\\n') AS t FROM ${table} x`)).rows[0].t ?? "";
    const approvals = await scan("automation_approvals");
    const activities = await scan("activities");
    const outbox = await scan("outbox_events");
    expect(approvals).toContain(id); // the scans see the row …
    expect(activities).toContain(body.webdesk.apiKeyId); // … and the key-id activity …
    expect(approvals).not.toContain(plaintext); // … and none holds the secret
    expect(activities).not.toContain(plaintext);
    expect(outbox).not.toContain(plaintext);
    expect(captured.join("\n")).not.toContain(plaintext);
    expect(await row(id)).toMatchObject({ status: "approved", execution_status: "executed" });

    // Single use: a second decide sends nothing.
    expect((await decide(id, adminA2)).statusCode).toBe(404);
    expect(zoneBWrites()).toHaveLength(1);
  });

  it("🔴 the requester cannot approve their own key.mint (WSK-66's in-code maker ≠ checker for key.mint): 403, zero Zone B calls, row stays pending; ✅ control: another admin → executed", async () => {
    const id = (await file(adminA, prodRead)).json<{ approvalId: string }>().approvalId;
    const self = await decide(id, adminA);
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain("a key mint may not be approved by the principal who requested it");
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
    expect((await decide(id, adminA2)).statusCode).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
  });

  it("company B's admin cannot decide company A's key.mint (another company's approval is not theirs): no Zone B call", async () => {
    const id = (await file(adminA, prodRead)).json<{ approvalId: string }>().approvalId;
    const r = await decide(id, adminB);
    expect([403, 404]).toContain(r.statusCode);
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
  });
});
