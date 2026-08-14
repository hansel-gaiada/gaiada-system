// A1 detective control (architect gate, pre-flip) — the reconciler-mint bug class.
//
// INVARIANT: user_roles.managed_by / company_memberships.managed_by is a marker that means
// "reconciler-owned" (0026_service_layer.sql §D). If any OTHER write path could set it, a client
// could forge a reconciler-owned grant that (a) bypasses the human-adoption rules in
// admin-identity.controller.ts's A14 hooks, and (b) would make service-scopes.ts's candidate
// query (user_roles.managed_by IS NOT NULL) treat an attacker-controlled row as a legitimate
// service grant. This test is the runtime detective control: it exercises every currently-live
// non-reconciler write path into user_roles/company_memberships — including adversarial requests
// that try to smuggle a `managed_by` value through the request body — and asserts the resulting
// row's managed_by is always NULL, while confirming the reconciler's OWN path is the one path
// that legitimately sets it.
//
// Complements (not replaces) scripts/lint-withtenants.mjs's static-analysis style: part 4 below
// does the same "grep every non-test source file" sweep for managed_by appearing in an INSERT
// INTO user_roles/company_memberships statement, and asserts service-reconciler.ts is the only
// hit — so a FUTURE endpoint that adds `managed_by` to its own INSERT is caught even before a
// runtime test would ever reach it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withGlobal } from "../db";
import { buildApp } from "../main";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../testing/fixtures";
import { registerModule, resetModules } from "../modules/registry";
import { reconcileAssignment } from "./service-reconciler";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("A1 detective control — managed_by is reconciler-only", () => {
  let app: NestFastifyApplication;
  let A: string;
  let B: string; // service-assignment target, used for the reconciler contrast case
  let superadmin: string;
  let globalExec: string;
  let memberRoleId: string;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.serviceAssignmentsEnabled = true;
    registerModule({
      key: "mbi_hr", migrations: [], permissions: [], customFieldTargets: [], mcpTools: [], rollupProviders: [], uiManifest: [],
    });
    await createRole("mbi_hr_staff");
    await createRole("mbi_hr_manager");

    A = await createCompany("MBI Provider");
    B = await createCompany("MBI Target", [], A);
    superadmin = await createUser("mbi-super@a.test");
    globalExec = await createUser("mbi-exec@holding.test");
    await addMembership(A, superadmin);

    const paRole = await createRole("platform_admin");
    const execRole = await createRole("group_executive");
    memberRoleId = await createRole("member");
    await grantRole(superadmin, paRole, "global", null);
    await grantRole(globalExec, execRole, "global", null);

    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
    resetModules();
  });

  // ---- 1. inviteUser (POST /:tenantId/users) ----
  it("inviteUser never produces a managed_by-set row, even if the request tries to smuggle one", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/users`,
      headers: asUser(superadmin),
      // adversarial: attacker-supplied managed_by pointing at a real service_assignments-shaped
      // value has no field to land in at all (the DTO only reads name/email/title/roleId) — this
      // proves the endpoint ignores it outright, not merely that it happens to default right.
      payload: { name: "Invitee", email: "mbi-invitee@a.test", roleId: memberRoleId, managed_by: "00000000-0000-0000-0000-000000000000" },
    });
    expect(r.statusCode).toBe(201);
    const { id: userId } = r.json() as { id: string };

    const mem = await adminPool().query<{ managed_by: string | null }>(
      `SELECT managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [A, userId],
    );
    expect(mem.rows[0].managed_by).toBeNull();

    const role = await adminPool().query<{ managed_by: string | null }>(
      `SELECT managed_by FROM user_roles WHERE user_id = $1 AND role_id = $2`,
      [userId, memberRoleId],
    );
    expect(role.rows[0].managed_by).toBeNull();
  });

  // ---- 2. assignRole (POST /:tenantId/users/:userId/roles) ----
  it("assignRole never produces a managed_by-set row, even if the request tries to smuggle one", async () => {
    const plain = await createUser("mbi-assignrole@a.test");
    await addMembership(A, plain);
    const r = await app.inject({
      method: "POST",
      url: `/api/${A}/users/${plain}/roles`,
      headers: asUser(superadmin),
      payload: { roleId: memberRoleId, scopeType: "company", scopeId: A, managed_by: "00000000-0000-0000-0000-000000000000" },
    });
    expect(r.statusCode).toBe(201);

    const role = await adminPool().query<{ managed_by: string | null }>(
      `SELECT managed_by FROM user_roles WHERE user_id = $1 AND role_id = $2 AND scope_type = 'company' AND scope_id = $3`,
      [plain, memberRoleId, A],
    );
    expect(role.rows[0].managed_by).toBeNull();
  });

  // ---- 3. team lead promotion (POST /:tenantId/teams/:teamId/members) ----
  // ---- 3. (RETIRED) team-lead promotion ----
  //
  // HIER-3 (2026-08-11) deleted this case with the surface it tested. It drove
  // `POST /api/:t/teams` + `/teams/:id/members` (role: "lead") and asserted the resulting
  // `scope_type='team'` grant carried `managed_by IS NULL` — i.e. that promote-to-lead was a MANUAL
  // grant path, never a reconciler-managed one.
  //
  // All of it is gone: `core/teams.controller.ts` was deleted, `teams`/`team_memberships` dropped
  // (migration 0103), `team_lead` retired, and `scope_type='team'` removed from the CHECK. The
  // endpoint now 404s, so the test failed on `expected 404 to be 201` — a stale test, not a broken
  // invariant.
  //
  // NOT replaced with an `org_unit_lead` equivalent: that grant has no self-service promotion
  // endpoint (it is assigned through the normal admin role-assignment path), which case 2
  // ("assignRole never produces a managed_by-set row") already covers directly. The invariant this
  // file protects — `managed_by` is reconciler-only — remains pinned by cases 1, 2, 4, 5 and the
  // static sweep, including the one path that legitimately SETS it.

  // ---- 4. company creation (POST /companies) — creator's own membership ----
  it("creating a company never produces a managed_by-set membership row for the creator", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/companies`,
      headers: asUser(superadmin),
      payload: { name: "MBI New Co", type: "general" },
    });
    expect(r.statusCode).toBe(201);
    const { id } = r.json() as { id: string };
    const mem = await adminPool().query<{ managed_by: string | null }>(
      `SELECT managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [id, superadmin],
    );
    expect(mem.rows[0].managed_by).toBeNull();
  });

  // ---- 5. contrast: the reconciler's OWN path DOES set managed_by ----
  it("the reconciler's own materialization path is the one path that sets managed_by NOT NULL", async () => {
    const staffer = await createUser("mbi-staffer@a.test");
    await addMembership(A, staffer);
    await app.inject({
      method: "PUT",
      url: `/api/${A}/org-structure`,
      headers: asUser(superadmin),
      payload: {
        root: {
          id: "root", name: "P", kind: "company",
          children: [{ id: "d-hr", name: "HR", kind: "department", children: [
            { id: "p1", name: "SC", kind: "person", assigneeId: staffer },
          ] }],
        },
      },
    });
    const created = await app.inject({
      method: "POST",
      url: `/api/${A}/org-structure/units/d-hr/assignments`,
      headers: asUser(globalExec),
      payload: { targets: [B], module: "mbi_hr" },
    });
    const assignmentId = (created.json() as { assignments: Array<{ id: string }> }).assignments[0].id;
    await reconcileAssignment(assignmentId, A);

    const mem = await adminPool().query<{ managed_by: string | null }>(
      `SELECT managed_by FROM company_memberships WHERE tenant_id = $1 AND user_id = $2 AND kind = 'service'`,
      [B, staffer],
    );
    expect(mem.rows).toHaveLength(1);
    expect(mem.rows[0].managed_by).toBe(assignmentId);

    const role = await adminPool().query<{ managed_by: string | null }>(
      `SELECT ur.managed_by FROM user_roles ur JOIN roles r ON r.id = ur.role_id
       WHERE ur.user_id = $1 AND ur.scope_type = 'company' AND ur.scope_id = $2 AND r.name = 'mbi_hr_staff'`,
      [staffer, B],
    );
    expect(role.rows).toHaveLength(1);
    expect(role.rows[0].managed_by).toBe(assignmentId);
  });

  // ---- 6. static sweep: no source file OTHER than the two named below inserts managed_by ----
  //
  // ⚠ P2-04 (2026-08-13) — THE SUBJECT OF THIS SWEEP MOVED, THE INVARIANT DID NOT.
  //
  // This assertion used to read `["src/admin/service-reconciler.ts"]`. P2-04 routed every
  // production `user_roles` INSERT/DELETE into the ONE choke point (`grant-write.service.ts`,
  // design §6.1), so the SQL TEXT carrying the `managed_by` column now lives there — while the
  // reconciler keeps its own `company_memberships` INSERT, which P2-04 did not touch (this
  // ticket's remit was `user_roles`). Hence two legitimate hits instead of one.
  //
  // This is a source-text relocation, NOT a behavioural change, and the distinction is provable
  // rather than asserted: parts 1-5 of this very file are RUNTIME probes against the live app —
  // "assignRole never produces a managed_by-set row", "inviteUser never produces one", "the
  // reconciler's own path is the one path that sets it" — and all of them passed UNMODIFIED
  // across this refactor. Only this static sweep, which pins a FILE PATH, needed updating.
  //
  // The invariant is also now pinned TIGHTER than before, by the companion sweep below: the
  // choke point merely has a `managed_by` PARAMETER, and what actually matters is who fills it.
  // `insertGrantRow()` writes `spec.managedBy ?? null`, so a caller that omits it gets NULL —
  // and the companion test asserts `service-reconciler.ts` is the only file in `src/` that
  // supplies a value at all. A new endpoint that tried to forge a reconciler-owned grant would
  // have to pass `managedBy:`, and that is exactly what turns red.
  const MANAGED_BY_INSERT_FILES = [
    "src/admin/grant-write.service.ts", // user_roles — THE choke point (P2-04, design §6.1)
    "src/admin/service-reconciler.ts", // company_memberships — untouched by P2-04
  ];

  it("static sweep: only the choke point and the reconciler INSERT a managed_by value", () => {
    const ROOT = join(__dirname, "..", "..");
    const SRC = join(ROOT, "src");
    const offenders: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === "dist") continue;
          walk(p);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
          const rel = relative(ROOT, p).split("\\").join("/");
          const src = readFileSync(p, "utf8");
          // Match an INSERT INTO user_roles/company_memberships statement whose column list
          // contains managed_by (multi-line tolerant: scan the statement up to its closing paren
          // of the column list, i.e. up to the first `)` after `INSERT INTO`).
          const re = /INSERT INTO (user_roles|company_memberships)\s*\(([^)]*)\)/g;
          let m: RegExpExecArray | null;
          while ((m = re.exec(src))) {
            if (m[2].includes("managed_by")) offenders.push(rel);
          }
        }
      }
    }
    walk(SRC);

    const uniqueOffenders = [...new Set(offenders)].sort();
    expect(uniqueOffenders).toEqual(MANAGED_BY_INSERT_FILES);
  });

  // ---- 6b. P2-04 companion sweep: who FILLS the choke point's managed_by parameter ----
  //
  // Moving the SQL into one file means the old "which file writes this column" question is no
  // longer the sharp one. The sharp question is which file passes a VALUE for it. A grant is
  // reconciler-owned iff its caller said so, so this is the assertion that actually carries A1's
  // weight now: exactly one file in `src/` supplies `managedBy:` to the choke point.
  it("static sweep: service-reconciler.ts is the only caller that SUPPLIES a managed_by value", () => {
    const ROOT = join(__dirname, "..", "..");
    const SRC = join(ROOT, "src");
    const suppliers: string[] = [];

    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          if (entry === "node_modules" || entry === "dist") continue;
          walk(p);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
          const rel = relative(ROOT, p).split("\\").join("/");
          if (rel === "src/admin/grant-write.service.ts") continue; // the parameter's own declaration
          if (/\bmanagedBy:\s*(?!null\b)/.test(readFileSync(p, "utf8"))) suppliers.push(rel);
        }
      }
    }
    walk(SRC);

    expect(
      [...new Set(suppliers)].sort(),
      "a file other than the reconciler is passing `managedBy:` to GrantWriteService — that forges " +
        "a reconciler-owned grant, which bypasses the A14 human-adoption hooks and makes " +
        "service-scopes.ts treat the row as a legitimate service grant. This is the A1 bug class.",
    ).toEqual(["src/admin/service-reconciler.ts"]);
  });
});
