// IAM-SEC-02 — `platform_admin` / `group_executive` may only be granted at GLOBAL scope.
//
// THE DEFECT THIS PINS (found by IAM-04-ROLLOUT-B12, 2026-08-11; fixed at the source in
// `admin-identity.controller.ts`'s `GLOBAL_ONLY_ROLES` guard):
//
// Both roles' Cerbos derived roles match ONLY `g.scopeType == "global"`, so a company-scoped grant
// of either confers nothing through the ROLE arm. But `assemblePrincipal()` resolves `perms` from
// `role_permissions` carrying the GRANT's own scope — so `platform_admin @ company:X` yields all
// 215 grantable permissions AT COMPANY X, which the `perm_*` derived roles honour. That is the
// permission arm granting what the role arm denies: the same defect class the IAM-04 pilot caught
// for `team_lead`×`pm_task`, but arising from a wildcard/unconditional rule rather than same-rule
// mixing — a shape `permission-arm-hazard-scan.test.ts` structurally cannot see.
//
// It was REACHABLE, not theoretical: `assignRole` is authorized by `user:create`, which
// `company_admin` holds — so a company admin could mint `platform_admin@their-own-company` and pick
// up the permissions their own bundle lacks, inside their own tenant. That also breaks D-9's
// no-self-escalation safeguard.
//
// Both directions are pinned below: the refusal, AND that legitimate grants still work — a guard
// that over-refuses would be its own outage.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildApp } from "../main";
import { config } from "../config";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole } from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("IAM-SEC-02 — elevated roles are global-scope-only", () => {
  let app: NestFastifyApplication;
  let tenant: string;
  let admin: string;
  let target: string;
  let platformAdminRole: string;
  let groupExecRole: string;
  let managerRole: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";

    tenant = await createCompany("IAMSEC02 Co", ["agency"]);
    admin = await createUser("iamsec02-admin@a.test");
    target = await createUser("iamsec02-target@a.test");
    await addMembership(tenant, admin);
    await addMembership(tenant, target);

    // The caller is a PLATFORM ADMIN, deliberately: the strongest possible caller. If even they
    // cannot mint a scoped elevated grant, no weaker caller can either.
    platformAdminRole = await createRole("platform_admin");
    groupExecRole = await createRole("group_executive");
    managerRole = await createRole("manager");
    await (await import("../testing/fixtures")).grantRole(admin, platformAdminRole, "global", null);

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  const assign = (roleId: string, scopeType: string, scopeId?: string | null) =>
    app.inject({
      method: "POST",
      url: `/api/${tenant}/users/${target}/roles`,
      headers: asUser(admin),
      payload: { roleId, scopeType, scopeId },
    });

  // ── the refusal: both elevated roles, every non-global scope ──────────────────────────────
  it("refuses platform_admin at company scope with a clean 400, never a 500 and never a grant", () => {
    return assign(platformAdminRole, "company", tenant).then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("global scope");
    });
  });

  it("refuses group_executive at company scope", () =>
    assign(groupExecRole, "company", tenant).then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("global scope");
    }));

  it("refuses platform_admin at project scope", () =>
    assign(platformAdminRole, "project", "11111111-1111-1111-1111-111111111111").then((res) => {
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain("global scope");
    }));

  // ── the other direction: the guard must not over-refuse ───────────────────────────────────
  it("still permits an elevated role at GLOBAL scope", () =>
    assign(platformAdminRole, "global", null).then((res) => {
      expect([200, 201]).toContain(res.statusCode);
    }));

  it("still permits a NON-elevated role at company scope", () =>
    assign(managerRole, "company", tenant).then((res) => {
      expect([200, 201]).toContain(res.statusCode);
    }));
});
