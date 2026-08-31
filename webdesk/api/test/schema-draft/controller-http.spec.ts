// WSK-32 — controller-level wiring: route/param/body validation + the guard, driven over real
// HTTP (`app.inject`, this project's established Fastify-injection test pattern — see
// test/control-jobs.spec.ts). `SchemaDraftService` is overridden with a fake so this file proves
// ROUTING/GUARD/VALIDATION only (no Postgres needed) — the actual draft/validate/diff logic is
// covered by schema-draft-service.spec.ts and validator-and-diff.spec.ts.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { SchemaDraftController } from "../../src/schema-draft/schema-draft.controller";
// WSK-32 (coordinator edit) — this suite used to register SchemaDraftAuthGuard, a stub that
// accepted ANY non-empty x-webdesk-control-principal and wrote it straight into an audit row.
// The controller is now gated by the REAL ControlAuthGuard. Its dependency
// (CONTROL_CHANNEL_AUTHENTICATOR) is bound environment-conditionally in ControlModule, so this
// test binds the dev-mode authenticator explicitly — the same header contract WSK-21's own
// suites use — rather than importing ControlModule and dragging in Postgres.
import { ControlAuthGuard } from "../../src/control/auth/control-auth.guard";
import { CONTROL_CHANNEL_AUTHENTICATOR } from "../../src/control/auth/control-channel-authenticator";
import { DevModeControlChannelAuthenticator } from "../../src/control/auth/dev-mode-control-channel-authenticator";
// WSK-33 FIX — the route now also runs CommandAuthorizationGuard (§03 Layer 3). Its collaborators
// must be bound here or the module fails to compile at boot.
import { Reflector } from "@nestjs/core";
import { CommandAuthorizationGuard } from "../../src/control/policy/command-authorization.guard";
import { POLICY_DECISION_POINT } from "../../src/control/policy/policy-decision-point";
import { DevModePolicyDecisionPoint } from "../../src/control/policy/dev-mode-policy-decision-point";
import { SchemaDraftService } from "../../src/schema-draft/schema-draft.service";

class FakeSchemaDraftService {
  calls: unknown[] = [];
  async draftFromPrd(input: unknown) {
    this.calls.push(input);
    return { collectionKey: "landing", proposedSchema: { blocks: ["hero"] }, currentSchema: null, validation: { valid: true, issues: [] }, diff: { destructive: false }, persisted: false };
  }
}

let app: NestFastifyApplication;
let fake: FakeSchemaDraftService;
const SITE_ID = "11111111-1111-1111-1111-111111111111";

beforeAll(async () => {
  fake = new FakeSchemaDraftService();
  const moduleRef = await Test.createTestingModule({
    controllers: [SchemaDraftController],
    providers: [
      ControlAuthGuard,
      { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: DevModeControlChannelAuthenticator },
      CommandAuthorizationGuard,
      { provide: POLICY_DECISION_POINT, useClass: DevModePolicyDecisionPoint },
      Reflector,
      { provide: SchemaDraftService, useValue: fake },
    ],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe("SchemaDraftController — POST .../schema/ai-draft", () => {
  it("401s with no x-webdesk-control-principal header — the guard runs before the handler", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      payload: { prd: "a landing page with a hero" },
    });
    expect(res.statusCode).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it("400s on a missing prd body field", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "human:qa", "x-webdesk-control-scopes": "webdesk:read" },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it("400s on a malformed siteId (not a uuid)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/not-a-uuid/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "human:qa", "x-webdesk-control-scopes": "webdesk:read" },
      payload: { prd: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("200s with the header + a valid body, and forwards actor + params to the service", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "human:qa", "x-webdesk-control-scopes": "webdesk:read" },
      payload: { prd: "a landing page with a hero" },
    });
    expect(res.statusCode).toBe(201);
    expect(fake.calls).toEqual([{ tenantSlug: "acme", siteId: SITE_ID, collectionKey: "landing", prd: "a landing page with a hero", actor: "human:qa" }]);
    const body = res.json();
    expect(body.persisted).toBe(false);
  });
});
