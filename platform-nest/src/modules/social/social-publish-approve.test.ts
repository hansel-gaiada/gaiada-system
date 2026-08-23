// SMM-40 — the publish "approve variant" endpoint. `docs/plans/smm-tracker.md`'s own named
// follow-up (found by SMM-17): nothing in this codebase ever MINTS the one-shot `automation_approvals`
// grant `social.publishPost` is already registered against (core/approval-executables.ts's SMM-09
// section — real lockKey, real precondition, neverAutoRetry, all pre-existing and untouched by this
// ticket). Owner's decision, restated and not relitigated: a D14 executable approval, never a bare
// state column.
//
// This file proves, end to end against live Postgres + Cerbos:
//   (A) the mint    — 403/404/409 refusals, the happy path, and the idempotent double-click.
//   (B) the wiring  — `social_post_variants.status` flips to the pre-existing 'approved' value the
//                     ALREADY-registered precondition's `unconsumed` stage requires; the minted row
//                     is decidable through the EXISTING generic decide() endpoint with NO code
//                     duplicated here, and `execution_status` moves to 'pending' (never
//                     'not_applicable') proving `getExecutable(social.publishPost)` finds the
//                     pre-existing registration.
//   (C) executes    — through the REAL executor (`executeApprovedAutomationWrite`), a decided row
//                     minted by THIS endpoint reaches "the hub" (a stubbed fetch, same convention as
//                     `core/approval-execute.test.ts`/`core/d14-smm-09-social-publish-registry.test.ts`
//                     — this file does not re-litigate the hub-transport contract, only that MY row
//                     participates in it identically to every other agent-origin one) when the filing
//                     principal holds a verified identity link, and refuses the pre-existing, typed
//                     `principal_unresolvable` when it does not — a real, named, NOT-fixed gap (see
//                     this file's own final block).
//   (D) invalidation — editing the variant AFTER a mint reverts it to 'draft' (the SAME code path
//                     `updateVariant` already uses for every other approved write) and the minted
//                     approval's snapshot hash stops matching, so the SAME executor refuses
//                     `precondition_failed: args_hash_mismatch` and the hub is asserted — not
//                     inferred — to have been called ZERO times. No new invalidation code exists in
//                     this ticket; this proves the pre-existing law reaches this new mint path too.
//   (E) module tool — `social.approvePostVariant` is declared with the pinned classification and a
//                     real, serving path.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { withTenants, newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, linkIdentity } from "../../testing/fixtures";
import { registerModule, resetModules } from "../registry";
import { socialModule } from "./index";
import { variantArgsSha256 } from "./canonical-args";
import { SOCIAL_PUBLISH_TOOL, SOCIAL_PUBLISH_TOOL_CLASSIFICATION } from "./publish-precondition";
import { executeApprovedAutomationWrite } from "../../core/approval-execute";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const MODULES: { modules: string[] } = { modules: ["social"] };
const IG_MEDIA = [{ fileId: "file-1", kind: "image", alt: "a photo", format: "jpeg" }];
const GRANT_SECRET = "smm40-test-secret-not-a-real-one";

let seq = 0;
const uniq = (label: string): string => `smm40-${label}-${++seq}`;

const realFetch = globalThis.fetch;
let hubCalls: Array<{ url: string; headers: Record<string, string> }> = [];
function installHubStub(): void {
  hubCalls = [];
  const stub = vi.fn(async (url: string, init: any) => {
    if (!String(url).startsWith("http://hub.smm40.test")) return realFetch(url as any, init);
    hubCalls.push({ url: String(url), headers: init.headers as Record<string, string> });
    // The `: Promise<string>` annotation is load-bearing. Without it, `text` is inferred through
    // `realFetch(...)` on the line above — which resolves back to this same stub — and tsc reports
    // TS7023 ("implicitly has return type 'any' ... referenced directly or indirectly in one of its
    // return expressions"). It compiles fine in isolation and fails in a full `tsc --noEmit`.
    return { ok: true, status: 200, text: async (): Promise<string> => "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"ok\"}]}}\n\n" };
  });
  vi.stubGlobal("fetch", stub as unknown as typeof fetch);
}

describe.skipIf(!TEST_URL)("SMM-40 · the publish 'approve variant' endpoint mints the D14 grant", () => {
  let app: NestFastifyApplication;
  let A: string;
  let manager: string; // social_manager: may mint (holds `publish`)
  let linklessManager: string; // a SEPARATE social_manager, deliberately given NO identity link ever
  let staff: string; // social_staff: may NOT mint (Cerbos denies `publish`)
  let outsider: string; // tenant member, no social grant at all
  let admin: string; // company_admin: the DECIDER for the automation_approval row
  let clientId: string;
  let publisherOrgId: string;
  let igAccount: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.approvalGrantSecret = GRANT_SECRET;
    config.services.hub = { url: "http://hub.smm40.test", token: "hub-token", assuranceToken: "" };
    resetModules();
    registerModule(socialModule);

    A = await createCompany("SMM-40 Approve Agency", ["social"]);
    manager = await createUser("smm40-manager@gate.test");
    linklessManager = await createUser("smm40-manager-nolink@gate.test");
    staff = await createUser("smm40-staff@gate.test");
    outsider = await createUser("smm40-outsider@gate.test");
    admin = await createUser("smm40-admin@gate.test");
    await addMembership(A, manager);
    await addMembership(A, linklessManager);
    await addMembership(A, staff);
    await addMembership(A, outsider);
    await addMembership(A, admin);
    const socialManagerRole = await createRole("social_manager");
    await grantRole(manager, socialManagerRole, "company", A);
    await grantRole(linklessManager, socialManagerRole, "company", A);
    await grantRole(staff, await createRole("social_staff"), "company", A);
    await grantRole(admin, await createRole("company_admin"), "company", A);

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

  beforeEach(() => installHubStub());
  afterEach(() => vi.restoreAllMocks());

  const post = (url: string, body: unknown, userId: string) =>
    app.inject({ method: "POST", url, headers: asUser(userId), payload: body as never });

  async function makeVariant(opts: { status?: string; body?: string } = {}) {
    const engagementId = newId();
    const postId = newId();
    const variantId = newId();
    const body = opts.body ?? "A caption awaiting approval";
    await withTenants([A], async (c) => {
      await c.query(
        `INSERT INTO social_engagements (id, tenant_id, client_id, name, status, tool_scope, usage_budget_usd, origin_site)
         VALUES ($1,$2,$3,'gate engagement','active',$4,10,'central')`,
        [engagementId, A, clientId, JSON.stringify({ networks: { instagram: true } })]);
      await c.query(`INSERT INTO social_posts (id, tenant_id, engagement_id, title, origin_site)
                     VALUES ($1,$2,$3,'gate post','central')`, [postId, A, engagementId]);
      await c.query(
        `INSERT INTO social_post_variants
           (id, tenant_id, post_id, account_id, body, media, settings, args_sha256, status, origin_site)
         VALUES ($1,$2,$3,$4,$5,$6,'{}',$7,$8,'central')`,
        [variantId, A, postId, igAccount, body, JSON.stringify(IG_MEDIA),
          variantArgsSha256({ tenantId: A, id: variantId, accountId: igAccount, body, media: IG_MEDIA }),
          opts.status ?? "draft"]);
    }, MODULES);
    return { variantId, engagementId };
  }

  const approveUrl = (variantId: string) => `/api/${A}/modules/social/variants/${variantId}/approve`;
  const decideUrl = (approvalId: string) => `/api/${A}/automation-approvals/${approvalId}/decide`;

  async function variantRow(variantId: string) {
    const r = await withTenants([A], (c) =>
      c.query<{ status: string; approval_id: string | null; args_sha256: string | null }>(
        `SELECT status, approval_id, args_sha256 FROM social_post_variants WHERE id = $1`, [variantId],
      ), MODULES);
    return r.rows[0];
  }

  async function approvalRow(id: string) {
    const r = await adminPool().query(
      `SELECT status, execution_status, origin, tool_name, tool_args, workflow_id, requested_by
         FROM automation_approvals WHERE id = $1`, [id],
    );
    return r.rows[0];
  }

  // ══ (A) THE MINT ══════════════════════════════════════════════════════════════════════════════

  describe("(A) the mint", () => {
    it("(A1) 404s an unknown variant", async () => {
      expect((await post(approveUrl(newId()), {}, manager)).statusCode).toBe(404);
    });

    it("(A2) denies a social_staff principal with 403 — `publish` stays manager-tier, never widened for this mint", async () => {
      const { variantId } = await makeVariant();
      expect((await post(approveUrl(variantId), {}, staff)).statusCode).toBe(403);
    });

    it("(A3) denies a tenant member with no social grant at all with 403", async () => {
      const { variantId } = await makeVariant();
      expect((await post(approveUrl(variantId), {}, outsider)).statusCode).toBe(403);
    });

    it("(A4) refuses a variant already past drafting (e.g. 'cancelled') with a typed 409 conflict, never a silent mint", async () => {
      const { variantId } = await makeVariant({ status: "cancelled" });
      const res = await post(approveUrl(variantId), {}, manager);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "variant_not_approvable:cancelled" });
    });

    it("(A5) the happy path: flips the variant to 'approved' and mints a real, single, correctly-shaped automation_approval row", async () => {
      const { variantId } = await makeVariant();
      const res = await post(approveUrl(variantId), {}, manager);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({ variantId, status: "pending" });
      expect(body.alreadyPending).toBeUndefined();
      expect(body.decideVia).toBe(`/api/${A}/automation-approvals/${body.id}/decide`);

      const v = await variantRow(variantId);
      expect(v.status).toBe("approved");
      expect(v.approval_id).toBeNull(); // D-15: only stamped at actual dispatch, never at mint

      const a = await approvalRow(body.id);
      expect(a).toMatchObject({
        // execution_status stays the DB default until a decider actually decides — see (B1) below
        // for the moment `getExecutable(social.publishPost)` gets consulted at all.
        status: "pending", execution_status: "not_applicable", origin: "agent", tool_name: SOCIAL_PUBLISH_TOOL,
        requested_by: manager,
      });
      expect(a.tool_args).toMatchObject({ variantId, tenantId: A, accountId: igAccount });
    });

    it("(A6) idempotent double-click: a live (undecided) mint for the same variant returns the SAME row, never a sibling", async () => {
      const { variantId } = await makeVariant();
      const first = (await post(approveUrl(variantId), {}, manager)).json();
      const second = await post(approveUrl(variantId), {}, manager);
      expect(second.statusCode).toBe(201);
      const secondBody = second.json();
      expect(secondBody).toMatchObject({ id: first.id, variantId, status: "pending", alreadyPending: true });

      const count = await adminPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM automation_approvals
           WHERE tenant_id = $1 AND tool_name = $2 AND tool_args @> $3::jsonb AND deleted_at IS NULL`,
        [A, SOCIAL_PUBLISH_TOOL, JSON.stringify({ variantId })],
      );
      expect(count.rows[0].n).toBe("1");
    });

    it("(A7) a variant already 'approved' with no live grant (e.g. a prior mint's approval already reached a terminal state) mints a FRESH one rather than refusing", async () => {
      const { variantId } = await makeVariant({ status: "approved" });
      const res = await post(approveUrl(variantId), {}, manager);
      expect(res.statusCode).toBe(201);
      expect(res.json().alreadyPending).toBeUndefined();
      const v = await variantRow(variantId);
      expect(v.status).toBe("approved");
    });
  });

  // ══ (B) THE WIRING: decidable through the EXISTING generic decide() endpoint ═════════════════

  describe("(B) the minted row is decidable through the pre-existing decide() endpoint", () => {
    it("(B1) decide('approved') moves execution_status to 'pending' — proving getExecutable(social.publishPost) finds the PRE-EXISTING SMM-09 registration, never 'not_applicable'", async () => {
      const { variantId } = await makeVariant();
      const minted = (await post(approveUrl(variantId), {}, manager)).json();

      const decide = await post(decideUrl(minted.id), { decision: "approved" }, admin);
      expect(decide.statusCode).toBe(200);
      expect(decide.json()).toMatchObject({ id: minted.id, status: "approved" });

      const a = await approvalRow(minted.id);
      expect(a.status).toBe("approved");
      expect(a.execution_status).toBe("pending"); // NOT 'not_applicable' — the registry entry exists
    });

    it("(B2) decide('rejected') leaves execution_status 'not_applicable' — a rejected mint never auto-executes", async () => {
      const { variantId } = await makeVariant();
      const minted = (await post(approveUrl(variantId), {}, manager)).json();
      await post(decideUrl(minted.id), { decision: "rejected" }, admin);
      const a = await approvalRow(minted.id);
      expect(a.status).toBe("rejected");
      expect(a.execution_status).toBe("not_applicable");
    });
  });

  // ══ (C) THROUGH THE REAL EXECUTOR — "approving EXECUTES" ═════════════════════════════════════

  describe("(C) through the real executor", () => {
    it("(C1) a decided mint, filed by a principal with a VERIFIED identity link, reaches the hub exactly once — 'approving executes'", async () => {
      await linkIdentity(manager, "telegram", `tg:${uniq("linked")}`, true);
      const { variantId } = await makeVariant();
      const minted = (await post(approveUrl(variantId), {}, manager)).json();
      await post(decideUrl(minted.id), { decision: "approved" }, admin);

      const outcome = await executeApprovedAutomationWrite(A, minted.id);
      expect(outcome.status).toBe("executed");
      expect(hubCalls).toHaveLength(1);
      const a = await approvalRow(minted.id);
      expect(a.execution_status).toBe("executed");
    });

    it("(C2) a decided mint filed by a principal with NO verified identity link refuses 'principal_unresolvable' — never re-driven as the approver or a service token, and the hub is called ZERO times", async () => {
      // The realistic default today: an ordinary Keycloak/OIDC staff login has no identity_links
      // row at all (only the WhatsApp/Telegram dual-proof ceremony creates one). Named plainly in
      // this ticket's report, not fixed here — see this file's own header.
      const { variantId } = await makeVariant();
      const minted = (await post(approveUrl(variantId), {}, linklessManager)).json();
      await post(decideUrl(minted.id), { decision: "approved" }, admin);

      const outcome = await executeApprovedAutomationWrite(A, minted.id);
      expect(outcome.status).toBe("failed");
      expect((outcome as { error: string }).error).toContain("principal_unresolvable");
      expect(hubCalls).toHaveLength(0);
    });
  });

  // ══ (D) EDIT INVALIDATES THE MINTED APPROVAL — the SAME pre-existing law, reused ════════════

  describe("(D) editing after a mint invalidates it, through the SAME code path every other write uses", () => {
    it("(D1) PATCH the variant after minting reverts it to 'draft' and clears approval linkage state (`approvalInvalidated: true`)", async () => {
      const { variantId } = await makeVariant();
      await post(approveUrl(variantId), {}, manager);
      expect((await variantRow(variantId)).status).toBe("approved");

      const patch = await app.inject({
        method: "PATCH", url: `/api/${A}/modules/social/variants/${variantId}`,
        headers: asUser(manager), payload: { body: "an edited caption after approval" },
      });
      expect(patch.statusCode).toBe(200);
      expect(patch.json()).toMatchObject({ approvalInvalidated: true });
      expect((await variantRow(variantId)).status).toBe("draft");
    });

    it("(D2) an edit-then-dispatch attempt refuses precondition_failed: args_hash_mismatch through the REAL executor, and the hub is asserted to have been called ZERO times", async () => {
      await linkIdentity(manager, "telegram", `tg:${uniq("linked-d2")}`, true);
      const { variantId } = await makeVariant();
      const minted = (await post(approveUrl(variantId), {}, manager)).json();
      await post(decideUrl(minted.id), { decision: "approved" }, admin);

      // Edit AFTER minting, BEFORE the executor ever runs — the exact race this state law exists
      // to close: a human approved content that no longer exists by the time anything executes.
      const patch = await app.inject({
        method: "PATCH", url: `/api/${A}/modules/social/variants/${variantId}`,
        headers: asUser(manager), payload: { body: "content the approver never saw" },
      });
      expect(patch.statusCode).toBe(200);

      const outcome = await executeApprovedAutomationWrite(A, minted.id);
      expect(outcome.status).toBe("failed");
      expect((outcome as { error: string }).error).toBe("precondition_failed: args_hash_mismatch");
      expect(hubCalls).toHaveLength(0);
    });

    it("(D3) a fresh approve() after the edit mints a SECOND, independent grant against the NEW content — the recovery path, not a second bug", async () => {
      const { variantId } = await makeVariant();
      const first = (await post(approveUrl(variantId), {}, manager)).json();
      await post(decideUrl(first.id), { decision: "approved" }, admin);
      await app.inject({
        method: "PATCH", url: `/api/${A}/modules/social/variants/${variantId}`,
        headers: asUser(manager), payload: { body: "revised after the first approval" },
      });
      expect((await variantRow(variantId)).status).toBe("draft");

      const second = await post(approveUrl(variantId), {}, manager);
      expect(second.statusCode).toBe(201);
      const secondBody = second.json();
      expect(secondBody.id).not.toBe(first.id);
      expect((await variantRow(variantId)).status).toBe("approved");
      const a2 = await approvalRow(secondBody.id);
      expect(a2.tool_args.body).toBe("revised after the first approval");
    });
  });

  // ══ (E) THE MODULE CONTRACT ═══════════════════════════════════════════════════════════════════

  it("(E) declares social.approvePostVariant from the pinned classification, pointing at the real, serving route", async () => {
    const tool = socialModule.mcpTools.find((t) => t.name === "social.approvePostVariant");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      method: "POST",
      pathTemplate: "/api/:tenantId/modules/social/variants/:variantId/approve",
      write: SOCIAL_PUBLISH_TOOL_CLASSIFICATION.write,
      impact: SOCIAL_PUBLISH_TOOL_CLASSIFICATION.impact,
    });
    // Tool parity: the declared path is a route the app actually serves, not an aspirational one.
    const { variantId } = await makeVariant();
    expect((await post(approveUrl(variantId), {}, manager)).statusCode).toBe(201);
  });
});
