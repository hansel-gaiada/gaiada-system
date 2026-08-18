// SMM-09 — the publish gate's HTTP surface and its REFUSAL CONTRACT, end-to-end against live
// Postgres + Cerbos, driven through the REAL endpoint by real personas with all three walls in
// place (agentic bar criterion 7). Skips silently without DATABASE_URL_TEST.
//
// The registry entry, the six precondition stages, the executor integration, replay and the
// no-auto-retry rule are `src/core/d14-smm-09-social-publish-registry.test.ts`'s. This file covers
// what only an app can prove:
//
//   (1) the dry run answers with the SAME typed vocabulary the executor writes into
//       `automation_approvals.execution_error`, so a caller branches on one contract regardless of
//       which side it heard the refusal from;
//   (2) ⚠ THE `message`-vs-`error` TRAP. `src/http-error.filter.ts` RENAMES `message` to `error` on
//       the way out and never reads `error`. A token thrown as `error` is silently replaced by
//       Nest's constructor-derived string ("Bad Request Exception") and any sibling field is
//       dropped — status code right, shape right, meaning gone. This is the single highest-value
//       assertion in the file for SMM-10/17/22/31, because every one of them will throw one of
//       these tokens;
//   (3) the module contract declares the gate's READ tool and, deliberately, no publish tool.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ArgumentsHost, BadRequestException, ConflictException } from "@nestjs/common";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { HttpErrorFilter } from "../../http-error.filter";
import { SocialPublisherErrorFilter } from "./publisher-error.filter";
import { SocialPublisherError } from "./publisher/types";
import { variantArgsSha256 } from "./canonical-args";
import {
  PUBLISH_REFUSAL, PUBLISH_PRECONDITION_STAGES, SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_METERED_TOOL,
} from "./publish-precondition";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES: { modules: string[] } = { modules: ["social"] };
const IG_MEDIA = [{ fileId: "file-1", kind: "image", alt: "a photo", format: "jpeg" }];

let seq = 0;
const uniq = (label: string): string => `smm09gate-${label}-${++seq}`;

/** Minimal `ArgumentsHost` over a recording reply — enough for a filter, which only ever reaches
 *  `switchToHttp().getResponse()`. Cheaper and far more direct than routing a request through the
 *  app for every one of the sixteen tokens. */
function recordingHost(): { host: ArgumentsHost; sent: { status?: number; body?: Record<string, unknown> } } {
  const sent: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    status(code: number) { sent.status = code; return this; },
    send(body: Record<string, unknown>) { sent.body = body; return this; },
  };
  return { host: { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ArgumentsHost, sent };
}

describe.skipIf(!TEST_URL)("SMM-09 · the publish gate over HTTP + the refusal contract", () => {
  let app: NestFastifyApplication;
  let A: string;
  let manager: string;
  let staff: string;
  let outsider: string;
  let clientId: string;
  let publisherOrgId: string;
  let igAccount: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SMM-09 Gate Agency", ["social"]);
    manager = await createUser("smm09-manager@gate.test");
    staff = await createUser("smm09-staff@gate.test");
    outsider = await createUser("smm09-outsider@gate.test");
    await addMembership(A, manager);
    await addMembership(A, staff);
    await addMembership(A, outsider);
    await grantRole(manager, await createRole("social_manager"), "company", A);
    await grantRole(staff, await createRole("social_staff"), "company", A);
    // `outsider` is a member of the tenant and holds NO social role — the persona that proves a
    // denial is a 403 rather than a bland empty answer.

    clientId = newId();
    await withTenants([A], (c) =>
      c.query(`INSERT INTO clients (id, tenant_id, name, origin_site) VALUES ($1,$2,'Brand One','central')`, [clientId, A]));
    publisherOrgId = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_publisher_orgs (id, tenant_id, client_id, driver, postiz_org_id, api_key_ref, status, origin_site)
         VALUES ($1,$2,$3,'postiz',$4,'default','active','central')`,
        [publisherOrgId, A, clientId, uniq("org")]), MODULES);
    igAccount = newId();
    await withTenants([A], (c) =>
      c.query(
        `INSERT INTO social_accounts
           (id, tenant_id, client_id, publisher_org_id, network, handle, postiz_integration_id, status, quota, origin_site)
         VALUES ($1,$2,$3,$4,'instagram',$5,$6,'connected','{}','central')`,
        [igAccount, A, clientId, publisherOrgId, uniq("@brand"), uniq("ig")]), MODULES);

    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  const get = (url: string, userId: string) => app.inject({ method: "GET", url, headers: asUser(userId) });
  const post = (url: string, body: unknown, userId: string) =>
    app.inject({ method: "POST", url, headers: asUser(userId), payload: body as never });

  async function makeVariant(opts: { engagementStatus?: string; networks?: Record<string, boolean>; status?: string } = {}) {
    const engagementId = newId();
    const postId = newId();
    const variantId = newId();
    const body = "A caption a human approved";
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'gate engagement',$4,$5,10,'central')`,
        [engagementId, A, clientId, opts.engagementStatus ?? "active",
          JSON.stringify({ networks: opts.networks ?? { instagram: true } })]);
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
                     VALUES ($1,$2,$3,'gate post','central')`, [postId, A, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,'central')`,
        [variantId, A, postId, igAccount, body, JSON.stringify(IG_MEDIA),
          variantArgsSha256({ tenantId: A, id: variantId, accountId: igAccount, body, media: IG_MEDIA }),
          opts.status ?? "approved"]);
    }, MODULES);
    return { variantId, engagementId };
  }

  const url = (variantId: string) => `/api/${A}/modules/social/variants/${variantId}/publish-preconditions`;

  // ── (1) the dry run ───────────────────────────────────────────────────────────────────────────

  it("reports a healthy variant as publishable, and names both halves of the D-14 split", async () => {
    const { variantId } = await makeVariant();
    const res = await get(url(variantId), manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      tool: SOCIAL_PUBLISH_TOOL,
      meteredTool: SOCIAL_PUBLISH_METERED_TOOL,
      stages: [...PUBLISH_PRECONDITION_STAGES],
    });
    // A pass carries no `reason`/`stage`: an absent refusal must not be renderable as an empty one.
    expect(res.json().reason).toBeUndefined();
    expect(res.json().stage).toBeUndefined();
  });

  it("reports a refusal as DATA with a 200, carrying the stage and the typed token", async () => {
    // "This variant is not currently publishable" is a successful answer to the question asked. The
    // token is the SAME one the executor writes after `precondition_failed: `, so a caller branches
    // on one vocabulary whichever side told it.
    const { variantId } = await makeVariant({ engagementStatus: "paused" });
    const res = await get(url(variantId), manager);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, stage: "scope", reason: PUBLISH_REFUSAL.engagementInactive });
  });

  it("reports the per-engagement network scope, which is the dial the composer cannot see", async () => {
    const { variantId } = await makeVariant({ networks: { instagram: false } });
    expect((await get(url(variantId), manager)).json()).toMatchObject({
      ok: false, stage: "scope", reason: PUBLISH_REFUSAL.networkNotInScope,
    });
  });

  it("reports an un-approved variant at the unconsumed stage rather than pretending it is publishable", async () => {
    const { variantId } = await makeVariant({ status: "draft" });
    expect((await get(url(variantId), manager)).json()).toMatchObject({
      ok: false, stage: "unconsumed", reason: PUBLISH_REFUSAL.variantNotApproved,
    });
  });

  it("404s an unknown variant instead of returning a 200 carrying variant_not_found", async () => {
    // Otherwise "no such variant" and "this variant exists and is blocked" would be the same answer.
    expect((await get(url(newId()), manager)).statusCode).toBe(404);
  });

  it("lets STAFF ask (asking whether a publish would be allowed is not publishing)", async () => {
    // The `publish` action itself stays manager-tier in resource_social_post.yaml. Staff author the
    // content and are exactly who needs to know why it will refuse.
    const { variantId } = await makeVariant();
    expect((await get(url(variantId), staff)).statusCode).toBe(200);
  });

  it("denies a principal with no social grant with a 403 — never an empty or 'ok:false' answer", async () => {
    // The bug the client portal already shipped once: folding a denial into a bland refusal body. A
    // 200 `{ok:false}` here would be indistinguishable from a real precondition failure.
    const { variantId } = await makeVariant();
    expect((await get(url(variantId), outsider)).statusCode).toBe(403);
  });

  // ── (2) ⚠ THE REFUSAL CONTRACT: tokens ride `message`, never `error` ──────────────────────────

  describe("the refusal contract", () => {
    it("⭐ every SMM-09 token survives HttpErrorFilter when thrown as `message`", () => {
      for (const token of Object.values(PUBLISH_REFUSAL)) {
        const { host, sent } = recordingHost();
        new HttpErrorFilter().catch(new ConflictException({ message: token }), host);
        expect(sent.status).toBe(409);
        expect(sent.body).toEqual({ error: token });
      }
    });

    it("⭐ THE TRAP, asserted in the failing direction: a token thrown as `error` is SILENTLY REPLACED", () => {
      // This is not a hypothetical. `social.controller.ts#refuse` had exactly this bug, and
      // `provisioning.controller`'s webdev sibling shipped it (see http-error.filter.ts's own
      // PRV-04 note). The filter reads `message` and never `error`, so the token vanishes and Nest's
      // constructor-derived string takes its place — status right, shape right, meaning gone.
      const { host, sent } = recordingHost();
      new HttpErrorFilter().catch(
        new BadRequestException({ error: PUBLISH_REFUSAL.budgetExceeded } as never), host,
      );
      expect(sent.body!.error).not.toBe(PUBLISH_REFUSAL.budgetExceeded);
      expect(String(sent.body!.error)).toMatch(/Bad Request/i);
    });

    it("the live endpoint proves the same rule end-to-end: `refuse()`'s token arrives as `error`", async () => {
      const res = await post(`/api/${A}/modules/social/publisher-orgs`, { clientId }, manager);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("missing_publisher_org_ref");
    });

    it("SocialPublisherError refusals keep BOTH the prose and the `code` discriminator — a different filter, a different shape, on purpose", () => {
      // publisher-error.filter.ts builds its own body, so the `message`→`error` rename does not
      // apply to it; the discriminator an agent branches on is `code`, not the prose. Pinned here so
      // SMM-10 does not "unify" the two shapes and silently drop one of them.
      const { host, sent } = recordingHost();
      new SocialPublisherErrorFilter().catch(
        new SocialPublisherError("cross_client_account", "refused: wrong client"), host,
      );
      expect(sent.status).toBe(409);
      expect(sent.body).toEqual({ error: "refused: wrong client", code: "cross_client_account" });
    });
  });

  // ── (3) the module contract ───────────────────────────────────────────────────────────────────

  it("declares the gate's READ tool with the endpoint that actually exists", async () => {
    const tool = socialModule.mcpTools.find((t) => t.name === "social.checkPublishPreconditions");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      method: "GET",
      pathTemplate: "/api/:tenantId/modules/social/variants/:variantId/publish-preconditions",
    });
    // Tool parity is only real if the declared path is a route the app actually serves.
    const { variantId } = await makeVariant();
    expect((await get(url(variantId), manager)).statusCode).toBe(200);
  });

  it("declares NO publish tool — neither the executable one nor the barred twin", () => {
    // `social.publishPost` is registered in the D14 executable registry, but its dispatch endpoint is
    // SMM-10's; declaring it here before that lands would publish a tool the hub cannot successfully
    // call to every agent in the estate. `social.publishPostMetered` is barred and must NEVER appear.
    const names = socialModule.mcpTools.map((t) => t.name);
    expect(names).not.toContain(SOCIAL_PUBLISH_TOOL);
    expect(names).not.toContain(SOCIAL_PUBLISH_METERED_TOOL);
    // Every declared tool still points at a real endpoint or is explicitly informational.
    for (const t of socialModule.mcpTools) {
      if (t.pathTemplate) expect(t.pathTemplate.startsWith("/api/:tenantId/modules/social")).toBe(true);
    }
  });
});
