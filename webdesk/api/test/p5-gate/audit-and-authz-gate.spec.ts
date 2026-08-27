// WSK-33 (P5 QA gate) — audit attribution + authorization-boundary battery for
// SchemaDraftController. Drives real HTTP via Fastify `app.inject` (this project's established
// pattern — test/schema-draft/controller-http.spec.ts, test/control-jobs.spec.ts) with the REAL
// ControlAuthGuard + DevModeControlChannelAuthenticator (the dev-mode stub the ticket brief says
// IS the correct thing to test against under NODE_ENV=test — the header contract is not itself a
// vulnerability). What this file checks is what the brief calls out as worth checking: whether the
// authenticated subject is what actually lands in the audit row, whether a caller can forge or
// corrupt that row, and — a static/behavioral check this file adds beyond WSK-32's own suite —
// whether this route enforces the SAME Layer-3 scope check every other control-plane command does.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { Reflector } from "@nestjs/core";
import { SchemaDraftController } from "../../src/schema-draft/schema-draft.controller";
import { SchemaController } from "../../src/control/schema/schema.controller";
import { ControlAuthGuard } from "../../src/control/auth/control-auth.guard";
import { CONTROL_CHANNEL_AUTHENTICATOR } from "../../src/control/auth/control-channel-authenticator";
import { DevModeControlChannelAuthenticator } from "../../src/control/auth/dev-mode-control-channel-authenticator";
import { CommandAuthorizationGuard } from "../../src/control/policy/command-authorization.guard";
import { POLICY_DECISION_POINT } from "../../src/control/policy/policy-decision-point";
import { DevModePolicyDecisionPoint } from "../../src/control/policy/dev-mode-policy-decision-point";
import { COMMAND_META_KEY } from "../../src/control/command.decorator";
import { COMMAND_REGISTRY } from "../../src/control/command-types";
import { SchemaDraftService } from "../../src/schema-draft/schema-draft.service";

const SITE_ID = "11111111-1111-1111-1111-111111111111";

class RecordingSchemaDraftService {
  calls: unknown[] = [];
  async draftFromPrd(input: unknown) {
    this.calls.push(input);
    return {
      collectionKey: "landing",
      proposedSchema: { blocks: ["hero"] },
      currentSchema: null,
      validation: { valid: true, issues: [] },
      diff: { destructive: false },
      persisted: false,
    };
  }
}

let app: NestFastifyApplication;
let fake: RecordingSchemaDraftService;

beforeAll(async () => {
  fake = new RecordingSchemaDraftService();
  const moduleRef = await Test.createTestingModule({
    controllers: [SchemaDraftController],
    providers: [
      ControlAuthGuard,
      { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: DevModeControlChannelAuthenticator },
      // WSK-33 FIX — the route now runs the Layer-3 scope check too, so its collaborators must be
      // present here or DI fails at boot rather than at request time.
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

describe("P5 audit attribution — the actor that lands in the request is the authenticated subject, never caller-corrupted", () => {
  it("the actor forwarded to the service is EXACTLY the x-webdesk-control-principal value — proves attribution flows from the guard's resolved principal, not a body field", async () => {
    fake.calls = [];
    await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "svc:zoneb-intake", "x-webdesk-control-scopes": "webdesk:read" },
      // Attempt to override the actor via the body — the handler must never read this field.
      payload: { prd: "a landing page", actor: "human:someone-else" },
    });
    expect(fake.calls).toEqual([
      { tenantSlug: "acme", siteId: SITE_ID, collectionKey: "landing", prd: "a landing page", actor: "svc:zoneb-intake" },
    ]);
  });

  it("a second, DIFFERENT x-webdesk-control-principal in the same run produces a DIFFERENT recorded actor — no sticky/cached principal from a prior request", async () => {
    fake.calls = [];
    await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "human:reviewer-one", "x-webdesk-control-scopes": "webdesk:read" },
      payload: { prd: "x" },
    });
    await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "human:reviewer-two", "x-webdesk-control-scopes": "webdesk:read" },
      payload: { prd: "x" },
    });
    expect((fake.calls[0] as { actor: string }).actor).toBe("human:reviewer-one");
    expect((fake.calls[1] as { actor: string }).actor).toBe("human:reviewer-two");
  });

  it("audit/log-injection probe: a principal value containing CRLF-style and embedded-quote content is forwarded VERBATIM as a single opaque string, never split/re-interpreted into extra fields", async () => {
    fake.calls = [];
    // Raw CR/LF cannot travel in an HTTP header value (the transport itself forbids it), but the
    // realistic injection surface — quotes, backslashes, unicode line-separator U+2028 — can. If
    // this ever gets interpreted (e.g. templated into a log line without escaping) rather than
    // treated as an opaque string, this is where that would first show up.
    const hostileSubject = 'human:qa" }, {"forged":"row';
    await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": hostileSubject, "x-webdesk-control-scopes": "webdesk:read" },
      payload: { prd: "x" },
    });
    expect((fake.calls[0] as { actor: string }).actor).toBe(hostileSubject);
  });

  it("an EMPTY principal header (not absent — an empty string) is refused, matching the fail-closed doctrine, not silently defaulted", async () => {
    fake.calls = [];
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "" },
      payload: { prd: "x" },
    });
    expect(res.statusCode).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });
});

// WSK-33 found a REAL authorization hole here and wrote it up as observed behaviour rather than
// patching src/ — which is why it got fixed instead of disappearing. The gap: SchemaDraftController's
// route carried no @Command metadata, so CommandAuthorizationGuard was structurally never in its
// chain, and ANY authenticated control-channel principal — including one presenting ZERO scopes —
// could invoke AI schema drafting for ANY tenant. Authentication was fixed earlier (the real
// ControlAuthGuard replaced a stub that trusted a caller-supplied header); AUTHORIZATION was still
// missing, and those are not the same layer.
//
// Fixed: `schema.aiDraft` is now a registry command (impactClass "read", scope "webdesk:read",
// matching the sibling `schema.propose`) and the route runs CommandAuthorizationGuard.
// These two tests are KEPT, flipped from asserting the defect to asserting the fix, so they are now
// the regression guard for it.
describe("P5 authorization boundary — ai-draft runs the Layer-3 scope check (was a DEFECT, now fixed)", () => {
  it("the route is CLASSIFIED — @Command metadata is present, so CommandAuthorizationGuard can resolve a required scope", () => {
    const reflector = new Reflector();
    const handler = SchemaDraftController.prototype.aiDraft;
    const commandName = reflector.get(COMMAND_META_KEY, handler);
    // If this ever reads undefined again, the guard silently stops enforcing anything: it resolves
    // the command via Reflector, so missing metadata disarms it WITHOUT removing it from
    // @UseGuards. That is precisely how the original hole was invisible.
    expect(commandName, "no @Command metadata = CommandAuthorizationGuard is disarmed, not absent").toBe("schema.aiDraft");
  });

  it("REFUSES a control-channel principal presenting ZERO scopes (no x-webdesk-control-scopes header at all)", async () => {
    fake.calls = [];
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/ai-draft`,
      headers: { "x-webdesk-control-principal": "svc:no-scopes-at-all" /* deliberately no scopes header */ },
      payload: { prd: "x" },
    });
    // Authenticated is not authorized. A scopeless principal is refused at Layer 3, and — the part
    // that matters — the service is never reached, so no LLM budget is spent and no audit row is
    // written on behalf of a caller that had no right to ask.
    expect(res.statusCode).toBe(403);
    expect(fake.calls).toHaveLength(0);
  });

  it("CONTRAST (not a bug in THIS test, evidence for the finding above): schema.propose — the sibling read-only command on the SAME resource shape — DOES 403 a scopeless principal", async () => {
    // A minimal standalone Nest app for schema.propose, proving the registry's Layer-3 gate is
    // real and reachable, i.e. the omission on ai-draft is a genuine gap and not "nothing in this
    // codebase does scope checks."
    const { SchemaService } = await import("../../src/control/schema/schema.service");
    const { CommandAuthorizationGuard } = await import("../../src/control/policy/command-authorization.guard");
    const { DevModePolicyDecisionPoint } = await import("../../src/control/policy/dev-mode-policy-decision-point");
    const { POLICY_DECISION_POINT } = await import("../../src/control/policy/policy-decision-point");

    class FakeSchemaService {
      calls: unknown[] = [];
      async proposeSchema(input: unknown) {
        this.calls.push(input);
        return { ok: true };
      }
    }
    const fakeSchema = new FakeSchemaService();

    const moduleRef = await Test.createTestingModule({
      controllers: [SchemaController],
      providers: [
        ControlAuthGuard,
        CommandAuthorizationGuard,
        Reflector,
        { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: DevModeControlChannelAuthenticator },
        { provide: POLICY_DECISION_POINT, useClass: DevModePolicyDecisionPoint },
        { provide: SchemaService, useValue: fakeSchema },
      ],
    }).compile();
    const proposeApp = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: ["error"] });
    await proposeApp.init();
    await proposeApp.getHttpAdapter().getInstance().ready();

    try {
      const res = await proposeApp.inject({
        method: "POST",
        url: `/control/v1/tenants/acme/sites/${SITE_ID}/collections/landing/schema/propose`,
        headers: { "x-webdesk-control-principal": "svc:no-scopes-at-all" /* no scopes header, same as the ai-draft attack above */ },
        payload: { proposedSchema: { blocks: ["hero"] } },
      });
      expect(res.statusCode).toBe(403);
      expect(fakeSchema.calls).toHaveLength(0);
    } finally {
      await proposeApp.close();
    }
  });

  it("sanity: schema.propose IS registered with a scope, confirming the registry entry ai-draft should plausibly have had", () => {
    expect(COMMAND_REGISTRY["schema.propose"].scope).toBeDefined();
  });
});
