// IAM-VERIFY-02 — closing the testability gap IAM-VERIFY-01 reported: no fixture could drive a
// NAMED (real userId), low-assurance principal, and `notLow` gates 58 of 61 Cerbos resource kinds
// with zero end-to-end coverage as a result.
//
// ── PART 1 proves the MECHANISM live (docs report §1: "find out why, don't guess"). ──────────────
// ── PART 2 proves the RULE via `assemblePersonaPrincipal()` (personas.ts, additive), the real
//    `assemblePrincipal()` forced to "low" for an already-seeded, membership-bearing persona.
// ── PART 3 is the biggest finding: read PART 2's block comment before trusting any ALLOW/DENY
//    here as "this is what happens in production" — it mostly is NOT, and the file says exactly why.
//
// Needs live Postgres (DATABASE_URL_TEST) AND live Cerbos (CERBOS_URL) — skips without either.
// `gaiada-test-cerbos` was restarted immediately before this file was authored (2026-08-11) and
// confirmed healthy; per this program's own trap list, a healthy container can still serve stale
// policy, so a probe of a KNOWN-allow case opens Part 2 below before any DENY is trusted.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { ForbiddenException } from "@nestjs/common";
import { config } from "../config";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, TEST_URL } from "./setup";
import { seedPersonaTenant, assemblePersonaPrincipal } from "./personas";
import { linkIdentity } from "./fixtures";
import { authorize } from "../core/http";
import { check, type Resource } from "../rbac/cerbos";

const CERBOS_LIVE = !!(process.env.CERBOS_URL && process.env.CERBOS_URL.length > 0);

describe.skipIf(!TEST_URL || !CERBOS_LIVE)("IAM-VERIFY-02 · driving assurance:\"low\" for a NAMED principal", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token-iam-verify-02";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PART 1 — THE MECHANISM, driven live over real HTTP (not inferred from reading the source).
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("Part 1 — why AuthGuard cannot mint a named, low-assurance principal (live proof, not a guess)", () => {
    it("dev x-user-id (what .as() uses) is ALWAYS assembled at \"high\" — no header lowers it", async () => {
      // hr.record.export requires assurance:"high" (resource_hr_record.yaml). A real member (not
      // hr_manager) is denied on ROLE grounds regardless, so this alone doesn't isolate assurance —
      // the isolating probe is Part 2's agent_run case. This one just proves the x-user-id branch
      // reaches a live app at all, as the control for the OBO probe below.
      const p = await seedPersonaTenant(["hr_manager"]);
      const res = await app.inject({
        method: "GET",
        url: `/api/${p.tenantId}/modules/hr/records/export`,
        headers: p.as("hr_manager"),
      });
      expect(res.statusCode, "hr_manager (assembled at hardcoded \"high\" by AuthGuard) export").toBe(200);
    });

    it("an OBO envelope naming a REAL user's UNVERIFIED identity_links row resolves to fully anonymous — the real user_id is DROPPED, not carried at assurance \"low\"", async () => {
      // This is the live proof behind personas.ts's `assemblePersonaPrincipal` doc comment.
      // `linkIdentity()` (testing/fixtures.ts) inserts the exact row shape a real, not-yet-confirmed
      // WhatsApp/Telegram identity has: a known user_id, verified_at = NULL.
      const p = await seedPersonaTenant(["member"]);
      const userId = p.users.member!;
      await linkIdentity(userId, "whatsapp-verify02", "+000000000", false);

      // Same PM task-list endpoint the "member" persona is normally ALLOWED to read (resource_pm_task
      // .yaml's role-arm grants member `read` unconditionally within their tenant) — chosen because a
      // DENY here can ONLY be explained by AuthGuard failing to recognize this caller as `userId`
      // (with SOME company in scope), not by any role/permission gap on the member role itself.
      const res = await app.inject({
        method: "GET",
        url: `/api/${p.tenantId}/pm/tasks`,
        headers: {
          authorization: `Bearer ${config.serviceToken}`,
          "x-obo-provider": "whatsapp-verify02",
          "x-obo-external-id": "+000000000",
        },
      });
      // DENIED — and for the reason the mechanism predicts: AuthGuard's OBO branch discards
      // `row.user_id` for an unverified row (`req.principal = { ...ANONYMOUS }`, no userId override),
      // so this request is authenticated as NOBODY, not as "member, but low-assurance". A principal
      // that actually carried this real user's membership at assurance "low" would still be denied
      // by `notLow` on some kinds, but pm_task's role-arm read rule carries no `notLow` at all — so
      // if AuthGuard preserved userId here the way `IdentityController.resolve()`'s sibling logic
      // does, this exact request would be a 200, not a 401/403. The denial proves erasure, not policy.
      expect([401, 403]).toContain(res.statusCode);
    });

    it("CONTRAST — IdentityController.resolve() (the sibling implementation of the SAME lookup, used by mcp-hub) does NOT drop the user_id for the identical unverified row", async () => {
      const p = await seedPersonaTenant(["member"]);
      const userId = p.users.member!;
      await linkIdentity(userId, "whatsapp-verify02b", "+111111111", false);

      const res = await app.inject({
        method: "POST",
        url: `/principal/resolve`,
        headers: { authorization: `Bearer ${config.serviceToken}` },
        payload: { provider: "whatsapp-verify02b", externalId: "+111111111" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { userId: string | null; assurance: string; companies: string[] };
      // THE ASYMMETRY, live: same "row exists, unverified" input, but this sibling code path
      // preserves the real user_id (AuthGuard's does not — see the test immediately above).
      expect(body.userId, "IdentityController.resolve() DID preserve userId for the unverified row").toBe(userId);
      expect(body.assurance).toBe("low");
      // AND — the other half of the "not a substitute for real access" finding: even the ONE real
      // code path that preserves userId at "low" returns it with EMPTY companies (principal.ts's own
      // doc comment: "'low' — unverified link ...: no company data at all"). It does not call
      // assemblePrincipal() for this branch, so this user's real company_admin/member/etc. grants
      // never load. A principal shaped exactly like this can never satisfy `variables.inTenant` on
      // ANY resource, so `notLow` is never even reached as the deciding conjunct for it.
      expect(body.companies).toEqual([]);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PART 2 — driving the `notLow` RULE via a REAL, DB-backed principal at assurance "low"
  // (`assemblePersonaPrincipal`, personas.ts). Read Part 3 below before treating a result here as
  // "this is what a real request experiences today" — it is the POLICY MECHANICS proof, run against
  // the real `assemblePrincipal()` output shape instead of a hand-typed Principal literal (which
  // `cerbos-agent-run.test.ts` and others already used for this same rule) — genuinely new value is
  // "the real function's output, not a literal, agrees with the policy", not "this shape is reachable
  // over HTTP today" (Part 1 already showed it structurally is not, for the reason principal.ts's own
  // doc comment states).
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("Part 2 — agent_run:read (IAM-SEC-01's notLow floor, added 2026-08-10)", () => {
    it("smoke: the owner IS allowed at \"high\" — proves the Cerbos check itself isn't stale/broken before trusting a DENY below", async () => {
      const p = await seedPersonaTenant(["company_admin"]);
      const principal = await assemblePersonaPrincipal(p, "company_admin", "high");
      await expect(
        authorize(principal, { kind: "agent_run", tenantId: p.tenantId, ownerId: principal.userId!, origin: "assistant_handoff" }, "read"),
      ).resolves.toBeUndefined();
    });

    it("DENY — the SAME real owner, assembled at \"low\", is denied (notLow floor holds for a REAL assemblePrincipal() output, not just a hand-built literal)", async () => {
      const p = await seedPersonaTenant(["company_admin"]);
      const principal = await assemblePersonaPrincipal(p, "company_admin", "low");
      expect(principal.userId).not.toBeNull(); // sanity: this really is a NAMED principal, not ANONYMOUS
      expect(principal.companies).toContain(p.tenantId); // and it really does carry real tenant access
      await expect(
        authorize(principal, { kind: "agent_run", tenantId: p.tenantId, ownerId: principal.userId!, origin: "assistant_handoff" }, "read"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("ALLOW — the same owner at \"linked\" (the floor excludes only \"low\", not \"linked\")", async () => {
      const p = await seedPersonaTenant(["company_admin"]);
      const principal = await assemblePersonaPrincipal(p, "company_admin", "linked");
      await expect(
        authorize(principal, { kind: "agent_run", tenantId: p.tenantId, ownerId: principal.userId!, origin: "assistant_handoff" }, "read"),
      ).resolves.toBeUndefined();
    });

    it("DENY — low assurance does not accidentally open a path for a NON-owner either (additive-restrictive, not a replacement of the owner condition)", async () => {
      const p = await seedPersonaTenant(["company_admin", "manager"]);
      const nonOwner = await assemblePersonaPrincipal(p, "manager", "low");
      await expect(
        authorize(nonOwner, { kind: "agent_run", tenantId: p.tenantId, ownerId: p.users.company_admin!, origin: "assistant_handoff" }, "read"),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe("Part 2 — hr_case (mainstream inTenant && notLow rule, driven for the first time with a REAL principal instead of a literal)", () => {
    it("ALLOW at \"high\": company_admin reads any hr_case in their tenant", async () => {
      const p = await seedPersonaTenant(["company_admin"]);
      const principal = await assemblePersonaPrincipal(p, "company_admin", "high");
      const resource: Resource = { kind: "hr_case", tenantId: p.tenantId, subjectUserId: "someone-else" };
      await expect(authorize(principal, resource, "read")).resolves.toBeUndefined();
    });

    it("DENY at \"low\": the SAME real company_admin, same tenant, same resource — only assurance changed", async () => {
      const p = await seedPersonaTenant(["company_admin"]);
      const principal = await assemblePersonaPrincipal(p, "company_admin", "low");
      const resource: Resource = { kind: "hr_case", tenantId: p.tenantId, subjectUserId: "someone-else" };
      await expect(authorize(principal, resource, "read")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // PART 2, continued — the two documented EXCEPTIONS from the ticket brief: kinds that deliberately
  // omit `notLow`.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("rollup:read — deliberately has NO notLow floor (role-only gate)", () => {
    it("ALLOW at \"low\": a real platform_admin is still allowed — proves the omission is real, not merely untested", async () => {
      const p = await seedPersonaTenant(["superadmin"]);
      const principal = await assemblePersonaPrincipal(p, "superadmin", "low");
      const resource: Resource = { kind: "rollup", tenantId: p.tenantId };
      await expect(authorize(principal, resource, "read")).resolves.toBeUndefined();
    });

    it("control — DENY at \"high\": a plain member (no platform_admin/group_executive role, no perm_rollup_read) is still denied regardless of assurance — the ALLOW above is the ROLE, not a blanket bypass", async () => {
      const p = await seedPersonaTenant(["member"]);
      const principal = await assemblePersonaPrincipal(p, "member", "high");
      const resource: Resource = { kind: "rollup", tenantId: p.tenantId };
      await expect(authorize(principal, resource, "read")).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // mcp_tool is NOT exercised here — it cannot be, from this file. `resource_mcp_tool.yaml`'s
  // `request.principal.attr.assurance` is mcp-hub's OWN three-tier vocabulary
  // ("anonymous"/"low"/"verified" — see the policy file's own header), evaluated against a
  // `hub_caller`-shaped principal mcp-hub itself builds (mcp-hub/src/principal.ts, a DIFFERENT
  // repository/service). platform-nest's `check()`/`authorize()` (this file's instrument) never
  // constructs or sends that principal shape, and platform-nest's `Principal.assurance`
  // ("low"/"linked"/"high") is not the same enum — a platform-nest test asserting anything about
  // `resource_mcp_tool.yaml` would be testing a policy file this service does not evaluate. Driving
  // this genuinely requires mcp-hub's own test suite (mcp-hub/src/cerbos.test.ts already exists per
  // that repo's own file list referenced in resource_mcp_tool.yaml's header) — out of reach from
  // platform-nest, not merely out of scope for this ticket.
  it.todo(
    "mcp_tool's assurance gate is UNDRIVABLE from platform-nest — different Cerbos principal schema, evaluated by mcp-hub, not this service's check()/authorize(). See the block comment above and the report.",
  );
});
