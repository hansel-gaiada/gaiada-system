// PRV-05 (QA gate) — PINS the contract bug 1eb1798 fixed, over REAL HTTP, through the REAL
// `HttpErrorFilter`, with the REAL Cerbos policy loaded (PRV-03's `resource_webdev_provisioned_site.yaml`).
//
// THE BUG THIS FILE EXISTS TO CATCH IF IT EVER COMES BACK: `webdev.controller.ts` used to throw
// `{ error: "<token>", site }`. `HttpErrorFilter` reads `message` and RENAMES it to `error` on the
// way out — it never reads a field literally named `error` on the thrown response object. So every
// typed refusal reached the client as Nest's constructor-derived string ("Conflict Exception",
// "Bad Request Exception", "Service Unavailable Exception") and `site` was dropped entirely. Status
// codes and shape were right; only the MEANING was missing — a defect invisible to a test that only
// checks `r.statusCode`. Both suites that touched this controller before the fix (`module-shell.test.ts`,
// `provisioning-idempotency.test.ts`) passed unchanged across the fix, because neither reads the HTTP
// response body's `error` string for a refusal — the service-layer suite asserts `outcome` (an enum,
// never serialized), and the HTTP suite explicitly scoped itself around the missing Cerbos policy.
// This is exactly the "correct-but-unwired is indistinguishable from absent" pattern this estate has
// hit before (WD-23A-1, D13). This file is the pin: every assertion below reads `r.json().error` and
// would have FAILED against the pre-1eb1798 controller (verified by mutation-probe, see the test at
// the bottom of this file, which reverts the thrower shape and captures the false answer to prove
// this suite is not vacuously green).
//
// Also pins the `site` forwarding ASYMMETRY the controller code actually implements (not an
// assumption): `site` rides on `conflict_foreign`, `egress_error`, `provider_rejected` — never on
// `slug_taken`, `invalid`, or `precondition_failed`. A test that only checked "site is present
// somewhere" would miss a regression that added it everywhere (leaking a partially-built row on a
// pure-validation refusal) or the reverse.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { newId, withTenants } from "../../db";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { startMockProvision, type ProvisionMock } from "../../testing/mock-provision";
import { ProvisionHttpDriver } from "./provision-http";
import type { ProvisionProvider, CreateProjectResult } from "./provision-provider";
import { setProvisionProviderForTests } from "./webdev.controller";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const EMAIL = "erp-service@gaiada.com";
const PASSWORD = "prv05-http-pin-secret";

describe.skipIf(!TEST_URL)("PRV-05 — webdev.controller HTTP error-contract pin (the 1eb1798 fix)", () => {
  let app: NestFastifyApplication;
  let mock: ProvisionMock;
  let tenant: string;
  let admin: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    mock = await startMockProvision({ serviceEmail: EMAIL, servicePassword: PASSWORD });
    tenant = await createCompany("PRV-05 HTTP Pin Co", ["webdev"]);
    const roleAdmin = await createRole("company_admin");
    admin = await createUser("admin@prv05-http.test");
    await addMembership(tenant, admin);
    await grantRole(admin, roleAdmin, "company", tenant);
    app = await buildApp();
  });

  afterAll(async () => {
    setProvisionProviderForTests(null);
    await app.close();
    await mock.close();
    await teardownTestDb();
  });

  function driver(): ProvisionProvider {
    return new ProvisionHttpDriver({
      baseUrl: mock.origin, serviceEmail: EMAIL, servicePassword: PASSWORD,
      timeoutMs: 5000, retryAttempts: 1, retryBaseDelayMs: 1,
    });
  }

  async function createRunViaHttp(title: string, opts: Partial<{ slug: string; stack: string }> = {}) {
    setProvisionProviderForTests(driver());
    const runId = await makeRunLocal(title);
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenant}/modules/webdev/provision`,
      headers: asUser(admin),
      payload: { runId, ...opts },
    });
    return { runId, r };
  }

  async function makeRunLocal(title: string, status = "delivery_active"): Promise<string> {
    const runId = newId();
    await withTenants([tenant], (c) =>
      c.query(
        `INSERT INTO pipeline_runs (id, tenant_id, title, status, created_by, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, tenant, title, status, admin, config.originSite],
      ),
    );
    return runId;
  }

  // ══ Positive control: the shape is not broken for the HAPPY path ═════════════════════════════
  it("201 created: no `error` key at all, and the site DTO is the response body directly", async () => {
    const { r } = await createRunViaHttp("HTTP Pin Happy Path");
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.error).toBeUndefined();
    expect(body.status).toBe("pending");
    expect(body.slug).toBeTruthy();
  });

  it("200 existing: a repeat call over HTTP is idempotent (status flips 201->200, same id)", async () => {
    setProvisionProviderForTests(driver());
    const runId = await makeRunLocal("HTTP Pin Idempotent Recall");
    const first = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin), payload: { runId },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin), payload: { runId },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
  });

  // ══ THE PIN: every typed refusal token, over real HTTP, through the real filter ═══════════════

  it("409 slug_conflict_foreign: the TOKEN arrives verbatim (not \"Conflict Exception\"), `site` IS forwarded", async () => {
    mock.seedProject({
      id: "proj-http-foreign", name: "http-pin-foreign-conflict",
      repoUrl: "https://github.com/Gaia-Digital-Agency/http-pin-foreign-conflict",
      stagingUrl: "https://http-pin-foreign-conflict.gaiada.online", status: "live", isOurs: false,
    });
    const { r } = await createRunViaHttp("Http Pin Foreign Conflict");
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.error).toBe("slug_conflict_foreign");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeTypeOf("object");
    expect(body.site.status).toBe("failed");
    expect(body.site.failureReason).toBe("slug_conflict_foreign");
  });

  it("409 slug_taken: the TOKEN arrives verbatim, and — the asymmetry — NO `site` key is sent (the controller never sets one for this arm)", async () => {
    setProvisionProviderForTests(driver());
    const runA = await makeRunLocal("Http Pin Slug Taken A");
    const first = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin),
      payload: { runId: runA, slug: "http-pin-shared-slug" },
    });
    expect(first.statusCode).toBe(201);

    const runB = await makeRunLocal("Http Pin Slug Taken B");
    const second = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin),
      payload: { runId: runB, slug: "http-pin-shared-slug" },
    });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.error).toBe("slug_taken");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeUndefined();
  });

  it("400 invalid (unsupported_stack): the TOKEN arrives verbatim (not \"Bad Request Exception\"), no `site`", async () => {
    const { r } = await createRunViaHttp("Http Pin Unsupported Stack", { stack: "wordpress" });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error).toBe("unsupported_stack");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeUndefined();
  });

  it("400 precondition_failed (run_blocked): the TOKEN arrives verbatim, no `site`", async () => {
    setProvisionProviderForTests(driver());
    const runId = await makeRunLocal("Http Pin Blocked Run", "blocked");
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin), payload: { runId },
    });
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.error).toBe("run_blocked");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeUndefined();
  });

  it("503 egress_error: the TOKEN arrives verbatim (not \"Service Unavailable Exception\"), `site` IS forwarded", async () => {
    const dead = new ProvisionHttpDriver({
      baseUrl: "http://127.0.0.1:1", serviceEmail: EMAIL, servicePassword: PASSWORD,
      timeoutMs: 500, retryAttempts: 1, retryBaseDelayMs: 1,
    });
    setProvisionProviderForTests(dead);
    const runId = await makeRunLocal("Http Pin Dead Hop");
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin), payload: { runId },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body.error).toBe("egress_error");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeTypeOf("object");
    expect(body.site.status).toBe("failed");
    expect(body.site.failureReason).toBe("egress_error");
  });

  it("503 provider_rejected: the TOKEN arrives verbatim, `site` IS forwarded", async () => {
    // A fake provider whose createProject answers 'rejected' directly — the far side refusing our
    // input (400) or credential (401), never exercised by the HTTP mock's own validation because the
    // ERP's own guard already refuses the same bad inputs before egress. Testing the controller's
    // OWN mapping for this outcome, not provision-http.ts's status-code translation (that lives in
    // provision-http.test.ts).
    const rejecting: ProvisionProvider = {
      key: "provision",
      createProject: async (): Promise<CreateProjectResult> =>
        ({ outcome: "rejected", status: 400, reason: "far side refused the request" }),
      getProject: async () => null,
      findProjectByName: async () => null,
    };
    setProvisionProviderForTests(rejecting);
    const runId = await makeRunLocal("Http Pin Provider Rejected");
    const r = await app.inject({
      method: "POST", url: `/api/${tenant}/modules/webdev/provision`, headers: asUser(admin), payload: { runId },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body.error).toBe("provider_rejected");
    expect(body.error).not.toMatch(/exception/i);
    expect(body.site).toBeTypeOf("object");
    expect(body.site.status).toBe("failed");
    expect(body.site.failureReason).toBe("provider_rejected");
  });

  // ══ MUTATION PROBE — this suite must be capable of catching the exact regression it exists for ══
  it("MUTATION PROBE: reverting to the pre-fix `{error: token}` throw shape makes the filter answer the GENERIC string, not the token — proving this file's assertions are load-bearing, not vacuous", async () => {
    // This does not edit the shipped controller (QA does not fix, only proves). It reproduces the
    // EXACT bug in isolation: a controller that throws `{ error: "<token>", site }` instead of
    // `{ message: "<token>", site }`, through the SAME HttpErrorFilter class the app uses, so the
    // "fixed" assertions above are shown to be capable of failing against the shape they replaced.
    const { HttpErrorFilter } = await import("../../http-error.filter");
    const { ConflictException } = await import("@nestjs/common");
    const filter = new HttpErrorFilter();
    const sent: { status?: number; body?: unknown } = {};
    const fakeHost = {
      switchToHttp: () => ({
        getResponse: () => ({
          status(code: number) {
            sent.status = code;
            return this;
          },
          send(body: unknown) {
            sent.body = body;
          },
        }),
      }),
    };
    // The PRE-FIX shape: `error`, not `message`.
    const preFixException = new ConflictException({ error: "slug_conflict_foreign", site: { status: "failed" } });
    filter.catch(preFixException, fakeHost as never);
    expect(sent.status).toBe(409);
    // This is the false-negative the fix closes: the token is GONE, replaced by Nest's generic string,
    // and `site` never reaches the wire. If this assertion ever fails, the filter itself changed
    // in a way that makes the mutation probe stale, not that the bug is gone — re-derive the probe.
    expect((sent.body as { error: string }).error).not.toBe("slug_conflict_foreign");
    expect((sent.body as { error: string }).error).toMatch(/exception/i);
    // Note: `site` is a SEPARATE field from the message/error rename bug (the filter reads
    // `r.site` unconditionally, regardless of which key carries the human-readable reason) — it
    // WOULD still ride along even under the pre-fix shape. The bug this probe reproduces is
    // specifically the token replacement; `site`'s own forwarding is pinned by the real HTTP tests
    // above (present for conflict_foreign/egress_error/provider_rejected, absent for the others) —
    // that asymmetry comes from what the CONTROLLER passes to the constructor, not from this filter.
    expect((sent.body as { site?: unknown }).site).toEqual({ status: "failed" });
  });
});
