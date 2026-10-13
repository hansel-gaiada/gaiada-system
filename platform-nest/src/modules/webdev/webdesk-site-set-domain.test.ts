// The site.setDomain FILING route and its in-band execution (M6-P6i): `POST /api/:tenantId/modules/webdev/control/sites/:siteId/domain`
// used to be an always-501 stub (WSK-31). Now it FILES one WSK-66 approval (202 {approvalId}); a DIFFERENT authorised user approves it
// at `POST …/automation-approvals/:id/decide`, and decide() sends the one WS4-asserted `site.setDomain` to Zone B. HIGH, always WS4,
// never self-approvable. Modelled on webdesk-site-archive.test.ts.
//
// Real: Postgres (RLS, the approval rows, the activities ledger, the registry), Cerbos (the real resource_webdev_provisioned_site.yaml
// `promote` gate and the approvals policy), the full NestJS app, `controlRequestSiteDomain`, WSK-66's real filer and in-band executor
// driven through the real decide route. Stand-in: Zone B, the in-process fake (`webdesk-content-testkit.ts`), whose `site.setDomain`
// follows WebDesk's lifecycle.service#setSiteDomain (env must be the site's, a no-op and a clash are 409, the answer names the
// previous domain). The REAL WebDesk command and its CORS effect are WebDesk's own suite (webdesk/api/test/site-set-domain.spec.ts).
//
// What it proves:
//   - filing: one approval, the exact args and hash, a title that says what changes, nothing sent; the gate is first; a closed,
//     typed body; the wall; the claim check (a domain must be on the company's registry, for the SAME environment, and not linked
//     to another WebDesk tenant); a clear needs no claim; one open request per (site, environment);
//   - execution: exactly ONE WS4 command with params {tenantSlug, siteId} and body {envId, domain}; never self-approvable; another
//     company cannot decide it; a refusal is recorded, never resent; an ambiguous failure is RECONCILED BY READING (applied: executed,
//     reconciled; not applied: failed), and is still never resent;
//   - the ROLLBACK, run on a test domain: set A, set B, set A back from the answer's previousDomain, then clear.
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
import { createWebdevSite } from "./site-registry.service";
import { FakeZoneB, GAIADA_ENV, GAIADA_SITE, GAIADA_SLUG, OTHER_ENV, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

const PROD = "shop.example.test"; // claimed on A's registry as a production row
const PROD2 = "shop2.example.test"; // claimed on A's registry as a production row (the rollback's second domain)
const STAGING_ONLY = "stg-only.example.test"; // claimed on A's registry, but as a STAGING row
const OTHER_TENANT_LINKED = "linked-elsewhere.example.test"; // a provisioned production row linked to ANOTHER WebDesk tenant
const B_HELD = "b-held.example.test"; // claimed by company B, not A

describe.skipIf(!live)("site.setDomain filing: POST control/sites/:siteId/domain files ONE approval; a different user applies it", () => {
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

  const domainUrl = (co = A, siteId = GAIADA_SITE) => `/api/${co}/modules/webdev/control/sites/${siteId}/domain`;
  const prodBody = (domain: string | null) => ({ tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.production, domain });
  const file = (as: string, body: unknown, url = domainUrl()) => app.inject({ method: "POST", url, headers: asUser(as), payload: body as never });
  const decide = (id: string, as: string, decision: "approved" | "rejected" = "approved") =>
    app.inject({ method: "POST", url: `/api/${A}/automation-approvals/${id}/decide`, headers: asUser(as), payload: { decision } });

  async function row(id: string) {
    const { rows } = await adminPool().query<{
      status: string; execution_status: string | null; execution_error: string | null; execution_result: unknown;
      tool_args: Record<string, unknown>; origin: string; workflow_id: string; tool_name: string; impact: string; requested_by: string; reason: string;
    }>(
      `SELECT status, execution_status, execution_error, execution_result, tool_args, origin, workflow_id, tool_name, impact, requested_by, reason
         FROM automation_approvals WHERE id = $1`,
      [id],
    );
    return rows[0];
  }
  async function pendingDomainRequests(): Promise<number> {
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_approvals WHERE tenant_id = $1 AND workflow_id = 'site.setDomain' AND status = 'pending' AND deleted_at IS NULL`,
      [A],
    );
    return Number(rows[0].n);
  }
  const zoneBWrites = () => zb.calls.filter((c) => c.command === "site.setDomain");
  const prodDomain = () => zb.envDomains.get(GAIADA_ENV.production) ?? null;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("Set-domain Co A", ["webdev"]);
    B = await createCompany("Set-domain Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "setdomain-admin-a@ex.test", "company_admin");
    adminA2 = await mk(A, "setdomain-admin-a2@ex.test", "company_admin");
    editorA = await mk(A, "setdomain-editor-a@ex.test", "webdev_staff");
    memberA = await mk(A, "setdomain-member-a@ex.test", "member");
    adminB = await mk(B, "setdomain-admin-b@ex.test", "company_admin");

    // The registry: what the P4c2 claim and the P6g production command leave behind.
    await createWebdevSite(A, { domain: PROD, environment: "production" }, null);
    await createWebdevSite(A, { domain: PROD2, environment: "production" }, null);
    await createWebdevSite(A, { domain: STAGING_ONLY, environment: "staging" }, null);
    const linked = await createWebdevSite(A, { domain: OTHER_TENANT_LINKED, environment: "production", origin: "provisioned" }, null);
    await adminPool().query(
      `INSERT INTO webdev_provisioned_sites (id, tenant_id, provider, provider_ref, slug, framework, status, requested_by, origin_site, webdev_site_id, webdesk_tenant_slug)
       VALUES (gen_random_uuid(), $1, 'erp_repo', gen_random_uuid()::text, 'linked-elsewhere', 'astro', 'pending', $2, 'main', $3, 'someother')`,
      [A, adminA, linked.id],
    );
    await createWebdevSite(B, { domain: B_HELD, environment: "production" }, null);

    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    // Each test starts with no open site.setDomain request (the de-dup would otherwise hand back an earlier test's id).
    await adminPool().query(`UPDATE automation_approvals SET deleted_at = now() WHERE tenant_id = $1 AND workflow_id = 'site.setDomain' AND deleted_at IS NULL`, [A]);
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── filing ──────────────────────────────────────────────────────────────────────────────────────────────────

  it("files exactly ONE approval: 202 {approvalId}; HIGH, origin webdesk, the row carries exactly the args and the hash, the title says what changes; nothing is sent to Zone B", async () => {
    const r = await file(adminA, prodBody(PROD));
    expect(r.statusCode, r.body).toBe(202);
    const { approvalId } = r.json<{ approvalId: string }>();
    expect(Object.keys(r.json())).toEqual(["approvalId"]); // a NEW filing carries no `alreadyPending`
    expect(await pendingDomainRequests()).toBe(1);
    const a = await row(approvalId);
    expect(a).toMatchObject({ status: "pending", origin: "webdesk", workflow_id: "site.setDomain", tool_name: "webdesk.site.setDomain", impact: "high", requested_by: adminA });
    const { summary, commandHash, ...args } = a.tool_args;
    expect(args).toEqual({ command: "site.setDomain", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, envId: GAIADA_ENV.production, domain: PROD });
    expect(commandHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.tool_args).not.toHaveProperty("rebuild"); // a domain change triggers no staging rebuild
    expect((summary as { title: string }).title).toBe(
      `Set the production domain of site "Main" of ${GAIADA_SLUG} to ${PROD} (none set today): browsers on it will be allowed to call this site's WebDesk endpoints`,
    );
    expect(a.reason).toBe((summary as { title: string }).title);
    expect(zoneBWrites()).toHaveLength(0);
  });

  it("a clear files with `domain: null`, needs NO registry claim, and its title names the domain that stops being answered", async () => {
    // The staging environment has a domain today (the fake's default `staging.gaiada.test`).
    const r = await file(adminA, { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.staging, domain: null });
    expect(r.statusCode, r.body).toBe(202);
    const a = await row(r.json<{ approvalId: string }>().approvalId);
    expect(a.tool_args).toMatchObject({ command: "site.setDomain", envId: GAIADA_ENV.staging, domain: null });
    expect((a.tool_args.summary as { title: string }).title).toBe(
      `Clear the staging domain of site "Main" of ${GAIADA_SLUG} (was staging.gaiada.test): browsers on it will no longer be allowed to call this site's WebDesk endpoints`,
    );
  });

  it("another company's site is a 404 site-not-found (the wall), with no row; ✅ control: the caller's own site files", async () => {
    const r = await file(adminA, { tenantSlug: OTHER_SLUG, envId: OTHER_ENV.production, domain: PROD }, domainUrl(A, OTHER_SITE));
    expect(r.statusCode).toBe(404);
    expect(r.json().type).toMatch(/\/site-not-found$/);
    expect(await pendingDomainRequests()).toBe(0);
    expect((await file(adminA, prodBody(PROD))).statusCode).toBe(202);
  });

  it("an environment that is not THIS site's (another company's) is a 404 environment-not-found, with no row", async () => {
    const r = await file(adminA, { tenantSlug: GAIADA_SLUG, envId: OTHER_ENV.production, domain: PROD });
    expect(r.statusCode).toBe(404);
    expect(r.json().type).toMatch(/\/environment-not-found$/);
    expect(await pendingDomainRequests()).toBe(0);
  });

  it("a malformed or non-canonical body is a typed 400 invalid_request and files nothing (unknown key, missing keys, a scheme, a port, a path, upper case, a look-alike, a non-string)", async () => {
    const bodies: unknown[] = [
      { ...prodBody(PROD), extra: 1 },
      { tenantSlug: GAIADA_SLUG, domain: PROD },
      { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.production },
      { envId: GAIADA_ENV.production, domain: PROD },
      { tenantSlug: "", envId: GAIADA_ENV.production, domain: PROD },
      { tenantSlug: GAIADA_SLUG, envId: "prod", domain: PROD },
      prodBody("https://shop.example.test"),
      prodBody("shop.example.test:8443"),
      prodBody("shop.example.test/"),
      prodBody("Shop.Example.test"),
      prodBody("shop.example.test."),
      prodBody("*.example.test"),
      prodBody("shop.exаmple.test"), // a Cyrillic "а"
      prodBody("acme.provisioned.invalid"),
      prodBody(""),
      { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.production, domain: 42 },
      { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.production, domain: [PROD] },
      ["not", "an", "object"],
    ];
    for (const body of bodies) {
      const r = await file(adminA, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json(), JSON.stringify(body)).toMatchObject({ reason: "invalid_request" });
    }
    expect(await pendingDomainRequests()).toBe(0);
  });

  it("🔴 a member and a webdev editor are 403 (the promote gate is FIRST: a valid body, and an invalid one, both 403); ✅ control: company_admin files", async () => {
    for (const who of [memberA, editorA]) {
      expect((await file(who, prodBody(PROD))).statusCode).toBe(403);
      expect((await file(who, { nonsense: true })).statusCode).toBe(403);
    }
    expect(await pendingDomainRequests()).toBe(0);
    expect((await file(adminA, prodBody(PROD))).statusCode).toBe(202);
  });

  it("the claim check: an unclaimed domain, a domain on ANOTHER environment's row, a domain linked to another WebDesk tenant, and another company's domain are each a typed 409 and file nothing", async () => {
    const unclaimed = await file(adminA, prodBody("unclaimed.example.test"));
    expect(unclaimed.statusCode).toBe(409);
    expect(unclaimed.json().type).toMatch(/\/domain-not-claimed$/);

    const wrongEnv = await file(adminA, prodBody(STAGING_ONLY)); // claimed, but as a staging row
    expect(wrongEnv.statusCode).toBe(409);
    expect(wrongEnv.json().type).toMatch(/\/domain-environment-mismatch$/);

    const elsewhere = await file(adminA, prodBody(OTHER_TENANT_LINKED));
    expect(elsewhere.statusCode).toBe(409);
    expect(elsewhere.json().type).toMatch(/\/domain-site-mismatch$/);

    const foreign = await file(adminA, prodBody(B_HELD)); // company B's registry row is invisible to A (RLS): not claimed
    expect(foreign.statusCode).toBe(409);
    expect(foreign.json().type).toMatch(/\/domain-not-claimed$/);

    expect(await pendingDomainRequests()).toBe(0);
    // ✅ control: a staging row's domain IS acceptable on the staging environment.
    expect((await file(adminA, { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.staging, domain: STAGING_ONLY })).statusCode).toBe(202);
  });

  it("a no-op is a 409 domain-unchanged and costs no approval: the same domain again, and a clear of an environment with no domain", async () => {
    const same = await file(adminA, { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.staging, domain: "staging.gaiada.test" });
    expect(same.statusCode).toBe(409);
    expect(same.json().type).toMatch(/\/domain-unchanged$/);
    const clearEmpty = await file(adminA, prodBody(null)); // production has no domain
    expect(clearEmpty.statusCode).toBe(409);
    expect(clearEmpty.json().type).toMatch(/\/domain-unchanged$/);
    expect(await pendingDomainRequests()).toBe(0);
  });

  it("de-dup: the same request again returns the SAME pending approval, by anyone; a DIFFERENT domain for the environment is 409 domain-request-pending; once decided, a new filing is a new one", async () => {
    const first = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    const dup = await file(adminA2, prodBody(PROD));
    expect(dup.statusCode).toBe(202);
    expect(dup.json()).toEqual({ approvalId: first, alreadyPending: true });
    expect(await pendingDomainRequests()).toBe(1);
    const other = await file(adminA2, prodBody(PROD2));
    expect(other.statusCode).toBe(409);
    expect(other.json().type).toMatch(/\/domain-request-pending$/);
    // The staging environment of the same site is its own unit.
    expect((await file(adminA, { tenantSlug: GAIADA_SLUG, envId: GAIADA_ENV.staging, domain: null })).statusCode).toBe(202);
    expect((await decide(first, adminA2, "rejected")).statusCode).toBe(200);
    const again = (await file(adminA, prodBody(PROD))).json();
    expect(again.approvalId).not.toBe(first);
    expect(again).not.toHaveProperty("alreadyPending");
  });

  // ── execution ───────────────────────────────────────────────────────────────────────────────────────────────

  it("approve by a DIFFERENT company_admin → exactly one WS4 site.setDomain to Zone B (no editorial assertion); the row is executed; Zone B holds the domain; single use", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    const r = await decide(id, adminA2);
    expect(r.statusCode, r.body).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
    expect(zoneBWrites()[0]).toMatchObject({
      hadWs4: true,
      params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE },
      body: { envId: GAIADA_ENV.production, domain: PROD },
      idempotencyKey: `ws4:${id}`,
    });
    expect(zoneBWrites()[0].editorialAssertion).toBeUndefined(); // site.setDomain is not an EDITORIAL_COMMAND
    expect(signer.calls).toHaveLength(0);
    expect(r.json()).toMatchObject({
      id, status: "approved",
      webdesk: { command: "site.setDomain", executionStatus: "executed", siteId: GAIADA_SITE, envId: GAIADA_ENV.production, domain: PROD, previousDomain: null, reconciled: false },
    });
    expect(prodDomain()).toBe(PROD);

    const after = await row(id);
    expect(after).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
    expect(JSON.stringify(after.execution_result)).toContain(PROD);
    const { rows } = await adminPool().query<{ outcome: string; domain: string | null }>(
      `SELECT metadata->>'outcome' AS outcome, metadata->>'domain' AS domain FROM activities WHERE target_entity_id = $1 AND verb = 'webdesk.site.setDomain' ORDER BY occurred_at, id`,
      [id],
    );
    expect(rows.map((x) => x.outcome)).toEqual(["attempted", "succeeded"]);
    expect(rows.every((x) => x.domain === PROD)).toBe(true);

    // Single use: a second decide sends nothing.
    expect((await decide(id, adminA2)).statusCode).toBe(404);
    expect(zoneBWrites()).toHaveLength(1);

    // The wall's next answer reports the new domain: filing the same change is now a typed 409 and files nothing.
    webdeskZoneB.clearSiteCache();
    const refile = await file(adminA, prodBody(PROD));
    expect(refile.statusCode).toBe(409);
    expect(refile.json().type).toMatch(/\/domain-unchanged$/);
    expect(await pendingDomainRequests()).toBe(0);
  });

  it("🔴 the requester cannot approve their own site.setDomain (maker ≠ checker, in code): 403, zero Zone B calls, row stays pending; ✅ control: another admin → executed", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    const self = await decide(id, adminA);
    expect(self.statusCode).toBe(403);
    expect(self.body).toContain("a site domain change may not be approved by the principal who requested it");
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
    expect((await decide(id, adminA2)).statusCode).toBe(200);
    expect(zoneBWrites()).toHaveLength(1);
  });

  it("company B's admin cannot decide company A's site.setDomain (another company's approval is not theirs): no Zone B call", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    const r = await decide(id, adminB);
    expect([403, 404]).toContain(r.statusCode);
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
  });

  it("a STORED row edited after filing to a non-canonical domain is refused at decide (400 webdesk_args_invalid), the row stays pending and nothing is sent", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    await adminPool().query(`UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{domain}', '"EVIL.example.test"') WHERE id = $1`, [id]);
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain("webdesk_args_invalid");
    expect(zoneBWrites()).toHaveLength(0);
    expect(await row(id)).toMatchObject({ status: "pending" });
  });

  it("a STORED row whose domain was swapped for ANOTHER canonical one fails the filed-hash check, unsent (webdesk_args_tampered)", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    await adminPool().query(`UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{domain}', '"evil.example.test"') WHERE id = $1`, [id]);
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(200); // the decision stands; the outcome is data
    expect(r.json()).toMatchObject({ webdesk: { command: "site.setDomain", executionStatus: "failed" } });
    expect((await row(id)).execution_error).toMatch(/^webdesk_args_tampered:/);
    expect(zoneBWrites()).toHaveLength(0);
  });

  it("a Zone B refusal is recorded as a typed failure (webdesk_refused) and never resent", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    zb.nextWriteResponse = problem(409, "conflict", { detail: "domain-in-use" });
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ webdesk: { command: "site.setDomain", executionStatus: "failed" } });
    expect((await row(id)).execution_error).toMatch(/^webdesk_refused: 409 conflict/);
    expect(zoneBWrites()).toHaveLength(1);
    expect(prodDomain()).toBeNull();
  });

  it("an ambiguous failure AFTER the apply is RECONCILED BY READING: executed (reconciled), and the command is never resent", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    zb.dropAfterApply = true; // Zone B applied it, then the link died
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ webdesk: { command: "site.setDomain", executionStatus: "executed", reconciled: true, envId: GAIADA_ENV.production, domain: PROD, previousDomain: null } });
    expect(await row(id)).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null });
    expect(zoneBWrites()).toHaveLength(1); // never resent
    expect(zb.calls.filter((c) => c.command === "tenant.list").length).toBeGreaterThanOrEqual(1);
    expect(prodDomain()).toBe(PROD);
  });

  it("an ambiguous failure that did NOT apply is read as such: failed webdesk_ambiguous, the environment does not have the domain, and nothing is resent", async () => {
    const id = (await file(adminA, prodBody(PROD))).json<{ approvalId: string }>().approvalId;
    zb.dropBeforeApply = true; // the request may have been delivered (as far as the client can tell) and was not applied
    const r = await decide(id, adminA2);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ webdesk: { command: "site.setDomain", executionStatus: "failed" } });
    expect((await row(id)).execution_error).toMatch(/^webdesk_ambiguous: the answer was lost and the environment does NOT have the requested domain; nothing was resent/);
    expect(zoneBWrites()).toHaveLength(1);
    expect(prodDomain()).toBeNull();
  });

  // ── the rollback ────────────────────────────────────────────────────────────────────────────────────────────

  it("ROLLBACK on a test domain: set A, set B, set A back from the answer's previousDomain, then clear; each step is its own approval and one WS4 command", async () => {
    const step = async (domain: string | null) => {
      webdeskZoneB.clearSiteCache(); // the wall's cache is 60 s; a console re-reads after a decision
      const filed = await file(adminA, prodBody(domain));
      expect(filed.statusCode, filed.body).toBe(202);
      const id = filed.json<{ approvalId: string }>().approvalId;
      const decided = await decide(id, adminA2);
      expect(decided.statusCode, decided.body).toBe(200);
      return decided.json<{ webdesk: { executionStatus: string; domain: string | null; previousDomain: string | null } }>().webdesk;
    };

    const a = await step(PROD);
    expect(a).toMatchObject({ executionStatus: "executed", domain: PROD, previousDomain: null });
    expect(prodDomain()).toBe(PROD);

    const b = await step(PROD2);
    expect(b).toMatchObject({ executionStatus: "executed", domain: PROD2, previousDomain: PROD });
    expect(prodDomain()).toBe(PROD2);

    // The rollback: the previous value the last answer reported.
    const back = await step(b.previousDomain);
    expect(back).toMatchObject({ executionStatus: "executed", domain: PROD, previousDomain: PROD2 });
    expect(prodDomain()).toBe(PROD);

    // ...or a clear.
    const cleared = await step(null);
    expect(cleared).toMatchObject({ executionStatus: "executed", domain: null, previousDomain: PROD });
    expect(prodDomain()).toBeNull();

    expect(zoneBWrites()).toHaveLength(4);
    expect(zoneBWrites().every((c) => c.hadWs4 && c.editorialAssertion === undefined)).toBe(true);
    expect(zoneBWrites().map((c) => (c.body as { domain: string | null }).domain)).toEqual([PROD, PROD2, PROD, null]);
    // Four distinct approvals, each executed once.
    const { rows } = await adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM automation_approvals WHERE tenant_id = $1 AND workflow_id = 'site.setDomain' AND execution_status = 'executed' AND deleted_at IS NULL`,
      [A],
    );
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(4);
  });
});
