// PRV-02 — the `webdev` module shell as an HTTP surface + its ModuleContract.
//
// Scope note, stated so the gap is visible rather than implied: the Cerbos policy for the NEW
// resource kind `webdev_provisioned_site` is PRV-03's, not this ticket's. Until it lands, Cerbos has
// no matching kind and DENIES — the correct fail-closed direction, but it means the authorization
// ARM of these endpoints cannot be positively exercised here. What CAN be proven now, and is:
//   - the routes exist and are mounted under the module prefix (not 404-as-unregistered);
//   - authentication is required (401 without a service token / user);
//   - the per-tenant module gate 404s a company that has not enabled `webdev`;
//   - the contributed MCP tool def carries the impact/write values the D14 gate keys on.
// The idempotency/adoption core itself is proven at the service layer in
// `provisioning-idempotency.test.ts`, against live Postgres and the mock over real sockets.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { webdevModule } from ".";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe("PRV-02 — webdev ModuleContract shape", () => {
  it("registers the provisionSite tool as a MEDIUM-impact WRITE (what the D14 gate keys on)", () => {
    expect(webdevModule.key).toBe("webdev");
    expect(webdevModule.migrations).toContain("0090_webdev_provisioned_sites.sql");
    const tool = webdevModule.mcpTools.find((t) => t.name === "webdev.provisionSite");
    expect(tool).toBeDefined();
    // `write: true` + `impact: "medium"` is what makes an automation principal's call SUSPEND into
    // WS4 instead of executing. Downgrading either value silently removes the human beat in front of
    // a call that creates a public repo and a public vhost — so both are pinned, not just asserted
    // to exist. (Standing D14 lesson: `low` never suspends; a registry entry is not a gate.)
    expect(tool!.write).toBe(true);
    expect(tool!.impact).toBe("medium");
    expect(tool!.method).toBe("POST");
    expect(tool!.pathTemplate).toBe("/api/:tenantId/modules/webdev/provision");
    expect(tool!.minAssurance).toBe("low");
  });

  it("advertises no tool it cannot serve", () => {
    for (const tool of webdevModule.mcpTools) {
      expect(tool.pathTemplate, `${tool.name} has no HTTP mapping`).toBeTruthy();
      expect(tool.pathTemplate!.startsWith("/api/:tenantId/modules/webdev/")).toBe(true);
    }
  });

  it("the tool schema documents the refusal, so an agent is not told to expect a downgrade", () => {
    const tool = webdevModule.mcpTools.find((t) => t.name === "webdev.provisionSite")!;
    const props = (tool.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(props.stack.description).toMatch(/REFUSED|refuse/i);
    expect(props.framework.description).toBeTruthy();
  });
});

describe.skipIf(!TEST_URL)("PRV-02 — webdev module shell (HTTP)", () => {
  let app: NestFastifyApplication;
  let tenant: string;      // webdev ENABLED
  let noModule: string;    // webdev NOT enabled
  let user: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    tenant = await createCompany("Agency Shell", ["webdev"]);
    noModule = await createCompany("No Webdev Co", ["pm"]);
    user = await createUser("shell-user@a.test", "Shell User");
    await addMembership(tenant, user);
    await addMembership(noModule, user);
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  it("requires authentication on every route", async () => {
    for (const [method, url] of [
      ["GET", `/api/${tenant}/modules/webdev/provisioned-sites`],
      ["POST", `/api/${tenant}/modules/webdev/provision`],
      ["POST", `/api/${tenant}/modules/webdev/provisioned-sites/some-id/reconcile`],
    ] as const) {
      const r = await app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("404s a company that has not enabled the webdev module (the per-tenant gate)", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/api/${noModule}/modules/webdev/provisioned-sites`,
      headers: asUser(user),
    });
    expect(r.statusCode).toBe(404);
    // This estate's error envelope is `{ error }`, not Nest's default `{ message }` — the
    // HttpErrorFilter rewrites it. Asserting the wrong key is a documented recurring mistake here.
    expect(r.json()).toMatchObject({ error: expect.stringContaining("webdev") });
  });

  it("the routes ARE mounted for an enabled company — the guard runs, not a routing miss", async () => {
    // Deliberately tolerant of 401/403: with PRV-03's Cerbos policy absent, an unlisted resource kind
    // is a DENY, which is the right fail-closed answer and would otherwise read as a logic bug. What
    // this pins is that the route EXISTS (a missing controller registration answers 404 here) and
    // that a decision is being made about it. When PRV-03 lands the policy, this stays green.
    const r = await app.inject({
      method: "GET",
      url: `/api/${tenant}/modules/webdev/provisioned-sites`,
      headers: asUser(user),
    });
    expect(r.statusCode).not.toBe(404);
    expect([200, 401, 403]).toContain(r.statusCode);
  });

  it("rejects a provision request with neither runId nor slug", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${tenant}/modules/webdev/provision`,
      headers: asUser(user),
      payload: {},
    });
    // 400 once authorized; 403 while the policy is missing. Either way, never a 500 and never a call
    // to the far side (there is no configured far side in this environment at all — see below).
    expect([400, 403]).toContain(r.statusCode);
  });

  it("FAIL-CLOSED: the test environment has no provision endpoint configured, and none is defaulted", () => {
    // The regression pin for "no silent no-op, no default endpoint". If someone ever gives
    // `PROVISION_BASE_URL` a fallback, this suite — which sets no provision env at all — starts
    // reporting a configured seam, and a CI run could reach a real host.
    expect(config.provision.baseUrl).toBe("");
    expect(config.provision.serviceEmail).toBe("");
    expect(config.provision.servicePassword).toBe("");
  });
});
