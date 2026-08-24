// P4-J7 — adversarial authorization tests for the PM subsystem, driven end to end via app.inject().
//
// Target: the seams where PM's authorization layers (Cerbos resource policies, the in-app
// ball/ownership escalation in patchTask, and the in-app person-axis narrowing on /pm/productivity)
// were built at DIFFERENT times by different agents and could disagree with each other.
//
// Everything here is a real HTTP round-trip against a live NestJS app + Postgres (RLS) + Cerbos —
// never a call into an internal function or an assertion against a policy file. A failing test in
// this file is either a real defect (reported, never silently fixed here) or proof a boundary holds.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL } from "../../testing/setup";
import { newId } from "../../db";
import { createCompany, createUser, addMembership, createRole, grantRole, createProject } from "../../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

describe.skipIf(!TEST_URL)("PM adversarial authz (P4-J7)", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  // Fresh, fully-provisioned tenant per describe block — cheap (a handful of inserts) and avoids
  // any cross-test pollution on the tenant-wide list/productivity endpoints, which see everything
  // in their tenant regardless of project.
  async function freshTenant(label: string) {
    const t = await createCompany(`Adversarial PM ${label}`, ["agency", "pm"]);
    const companyAdmin = await createUser(`${newId()}@x.test`, `${label} CompanyAdmin`);
    const manager = await createUser(`${newId()}@x.test`, `${label} Manager`);
    const member = await createUser(`${newId()}@x.test`, `${label} Member`);
    const viewer = await createUser(`${newId()}@x.test`, `${label} Viewer`);
    await addMembership(t, companyAdmin);
    await addMembership(t, manager);
    await addMembership(t, member);
    await addMembership(t, viewer);
    await grantRole(companyAdmin, await createRole("company_admin"), "company", t);
    await grantRole(manager, await createRole("manager"), "company", t);
    await grantRole(member, await createRole("member"), "company", t);
    await grantRole(viewer, await createRole("viewer"), "company", t);
    const projectId = await createProject(t, `${label} project`, manager);
    return { t, companyAdmin, manager, member, viewer, projectId };
  }

  const own = (refId: string, responsibleId: string, kind = "person") =>
    ({ kind, refId, refName: "X", responsibleId, responsibleName: "Y" });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 1. THE BALL/OWNERSHIP SPLIT — the newest, least-exercised boundary (landed 6b2154d).
  //    pm.test.ts already covers: pure ball-pass allowed; responsibleId change/clear/unit-assign
  //    all denied for a member; a refused escalation writes nothing. This section hunts the edges
  //    that brief specifically calls out and that file does NOT cover: bootstrapping an unassigned
  //    task, and a subtly malformed/partial assignee payload that could sneak past the gate.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("ball/ownership boundary — untested edges", () => {
    it("a member CANNOT bootstrap an unassigned task (no current owner) — this is an ownership change, not a pass", async () => {
      const { t, manager, member, projectId } = await freshTenant("bootstrap");
      const create = await app.inject({
        method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Unowned" },
      });
      const id = (create.json() as { id: string }).id;

      // Confirm the fixture actually IS unassigned before trusting the 403 below.
      const before = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: unknown };
      expect(before.assignee).toBeNull();

      const attempt = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(member),
        payload: { assignee: own(member, member) },
      });
      expect(attempt.statusCode).toBe(403);

      // And the refusal left no trace — still unassigned, not silently bootstrapped.
      const after = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: unknown };
      expect(after.assignee).toBeNull();
    });

    it("a malformed/partial assignee (missing responsibleId) is REJECTED at the boundary — never read as a ball-pass, never as a silent clear", async () => {
      const { t, manager, member, projectId } = await freshTenant("malformed");
      const create = await app.inject({
        method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Owned" },
      });
      const id = (create.json() as { id: string }).id;
      // Give it a real owner first — the ball is genuinely IN PLAY, so a "pass" reading would be
      // structurally possible if the malformed-payload path were buggy.
      await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager), payload: { assignee: own(manager, manager) } });

      // P4-J7 fix: a non-null assignee that fails validation is now a 400 naming the problem,
      // parsed BEFORE the ownership escalation. It used to collapse to null and be treated as a
      // "clear the owner" request — denied for a member (403) but silently destructive for anyone
      // holding `manage` (see the sibling test). Malformed input and "clear this" are different
      // requests and now get different answers.
      const partial = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(member),
        payload: { assignee: { kind: "person", refId: member, refName: "Member" } }, // no responsibleId
      });
      expect(partial.statusCode).toBe(400);

      // A junk-typed assignee (string instead of object) takes the identical path.
      const junkType = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(member),
        payload: { assignee: "not-an-object" },
      });
      expect(junkType.statusCode).toBe(400);

      // An assignee with an unrecognized `kind` also nulls out via validAssignee -> same escalation.
      const badKind = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(member),
        payload: { assignee: { kind: "robot", refId: member, responsibleId: member } },
      });
      expect(badKind.statusCode).toBe(400);

      // The refused writes left the real owner untouched — a malformed payload must never sneak
      // through as a "clear the assignee" side effect just because it failed to parse as an object.
      const after = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: { responsibleId: string } };
      expect(after.assignee.responsibleId).toBe(manager);
    });

    it("REGRESSION (P4-J7 finding 2): a manager sending a malformed assignee gets a 400, not a silently wiped owner", async () => {
      // This was never a privilege hole — the caller already held `manage` and could have cleared
      // the owner deliberately. It was a data-loss footgun: a fat-fingered assignee shape wiped the
      // owner with a 200 and no explanation. An EXPLICIT `{assignee: null}` still clears (that is a
      // real operation); a malformed OBJECT is now a 400.
      const { t, manager, projectId } = await freshTenant("malformed-manager");
      const create = await app.inject({
        method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Owned2" },
      });
      const id = (create.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager), payload: { assignee: own(manager, manager) } });

      const r = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager),
        payload: { assignee: { kind: "person", refId: manager } }, // missing responsibleId
      });
      expect(r.statusCode).toBe(400);
      expect((r.json() as { error?: string }).error).toMatch(/assignee/i);
      const after = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: { responsibleId: string } | null };
      expect(after.assignee?.responsibleId).toBe(manager); // owner survived the bad request

      // The deliberate clear still works — the fix must not have broken the real operation.
      const cleared = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager), payload: { assignee: null },
      });
      expect(cleared.statusCode).toBe(200);
      const afterClear = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: unknown };
      expect(afterClear.assignee).toBeNull();
    });

    it("a UNIT-owned task's ball can be taken over by a PERSON via the member-level pass gate, as long as responsibleId is unchanged — kind is not part of the ballPassOnly equality check", async () => {
      // `ballPassOnly` checks `incoming.kind === 'person' && incoming.responsibleId ===
      // currentAssignee.responsibleId` — it never re-checks `currentAssignee.kind`. So converting
      // the BALL from a department to a person, while Responsible stays the same, reads as a pure
      // pass rather than an ownership change. Probing whether this is real, reproducible behaviour
      // (not a fixture mistake) — either it's an intentional generalization of "anyone can pass the
      // ball" to unit-owned work, or it's a boundary nobody actually decided.
      const { t, manager, member, projectId } = await freshTenant("unit-to-person");
      const create = await app.inject({
        method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Unit owned" },
      });
      const id = (create.json() as { id: string }).id;
      const deptId = newId();
      const setUnit = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager),
        payload: { assignee: own(deptId, manager, "department") },
      });
      expect(setUnit.statusCode).toBe(200);
      const before = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: { kind: string; refId: string; responsibleId: string } };
      expect(before.assignee.kind).toBe("department");
      expect(before.assignee.responsibleId).toBe(manager);

      const takeOver = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(member),
        payload: { assignee: own(member, manager, "person") }, // same responsibleId, but kind flips unit->person
      });
      // Whatever the boundary actually does, pin it here so a future change to `ballPassOnly` is a
      // deliberate, visible diff rather than a silent widening/narrowing of who may re-point a
      // unit's ball at themselves.
      expect(takeOver.statusCode).toBe(200);
      const after = (await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).json() as { assignee: { kind: string; refId: string; responsibleId: string } };
      expect(after.assignee.kind).toBe("person");
      expect(after.assignee.refId).toBe(member);
      expect(after.assignee.responsibleId).toBe(manager);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 2. CROSS-TENANT — a rival tenant's principal against every PM route, both on the real tenant's
  //    URL (must be denied outright) and on the rival's OWN URL carrying tenant A's real ids (RLS
  //    must make them invisible, never a 200 with tenant A's data and never a distinguishable
  //    403-vs-404 that leaks existence).
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("cross-tenant sweep", () => {
    it("a rival's principal is denied (403) on every PM route, hit against tenant A's real URL", async () => {
      const home = await freshTenant("xt-home");
      const rival = await freshTenant("xt-rival");

      // Populate tenant A with one of everything so a real id exists behind each route.
      const taskRes = await app.inject({
        method: "POST", url: `/api/${home.t}/pm/tasks`, headers: asUser(home.manager),
        payload: { projectId: home.projectId, title: "Home task", assignee: own(home.member, home.manager) },
      });
      const taskId = (taskRes.json() as { id: string }).id;
      const tagRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/tags`, headers: asUser(home.manager), payload: { label: "T", color: "bronze" } });
      const tagId = (tagRes.json() as { id: string }).id;
      const msRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/milestones`, headers: asUser(home.manager), payload: { name: "MS", dueDate: "2026-09-01" } });
      const milestoneId = (msRes.json() as { id: string }).id;
      const docRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/docs`, headers: asUser(home.manager), payload: { title: "D", body: "b" } });
      const docId = (docRes.json() as { id: string }).id;
      const stRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/statuses`, headers: asUser(home.manager), payload: { label: "Custom", color: "#111111" } });
      const statusId = (stRes.json() as { id: string }).id;
      const runRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/tasks/${taskId}/tracker/run`, headers: asUser(home.manager), payload: {} });
      const suggestionId = ((runRes.json() as { suggestions: Array<{ id: string }> }).suggestions[0])?.id;

      const asRival = asUser(rival.manager); // rival's OWN company_admin-equivalent, a full manager in ITS tenant

      // Every write carries a WELL-FORMED body for its route — a cross-tenant probe must be denied
      // on AUTHORIZATION, never accidentally "pass" because a malformed/empty body 400'd first
      // (MI-03 in this controller validates input before authz, so a lazy `{}` body would prove
      // nothing here).
      const denies: Array<[string, string, Record<string, unknown>?]> = [
        ["GET", `/api/${home.t}/pm/tasks`],
        ["GET", `/api/${home.t}/pm/tasks/${taskId}`],
        ["PATCH", `/api/${home.t}/pm/tasks/${taskId}`, { priority: "low" }],
        ["DELETE", `/api/${home.t}/pm/tasks/${taskId}`],
        ["POST", `/api/${home.t}/pm/tasks`, { projectId: home.projectId, title: "rival-forged task" }],
        ["GET", `/api/${home.t}/pm/tasks/${taskId}/assignment-history`],
        ["GET", `/api/${home.t}/pm/productivity`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/tasks`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/tags`],
        ["POST", `/api/${home.t}/pm/projects/${home.projectId}/tags`, { label: "rival-forged", color: "slate" }],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/statuses`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/milestones`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/docs`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/docs/${docId}`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/burndown`],
        ["GET", `/api/${home.t}/pm/projects/${home.projectId}/flow`],
        ["GET", `/api/${home.t}/pm/burndown`],
        ["GET", `/api/${home.t}/pm/flow`],
        ["GET", `/api/${home.t}/pm/tasks/${taskId}/suggestions`],
        ["POST", `/api/${home.t}/pm/tasks/${taskId}/tracker/run`, {}],
        ...(suggestionId ? [["POST", `/api/${home.t}/pm/suggestions/${suggestionId}/confirm`, {}] as [string, string, Record<string, unknown>]] : []),
        ["GET", `/api/${home.t}/pm/templates`],
      ];

      for (const [method, url, payload] of denies) {
        const r = await app.inject({ method: method as "GET" | "POST" | "PATCH" | "DELETE", url, headers: asRival, payload: method === "GET" || method === "DELETE" ? undefined : (payload ?? {}) });
        expect(r.statusCode, `${method} ${url} — expected 403 for a cross-tenant caller, got ${r.statusCode}: ${r.body}`).toBe(403);
      }
      // sanity: tagId/statusId/milestoneId were created but not separately probed above — assert
      // the fixture really has them, proving the setup succeeded rather than silently no-oping.
      expect(tagId).toBeTruthy();
      expect(statusId).toBeTruthy();
      expect(milestoneId).toBeTruthy();
    });

    it("the faceted tenant-wide list, hit on the RIVAL's own URL with every facet carrying tenant A's real ids at once, is RLS-invisible (200 empty), never a leak", async () => {
      const home = await freshTenant("facet-home");
      const rival = await freshTenant("facet-rival");

      const taskRes = await app.inject({
        method: "POST", url: `/api/${home.t}/pm/tasks`, headers: asUser(home.manager),
        payload: { projectId: home.projectId, title: "Facet victim", priority: "urgent", status: "todo", assignee: own(home.member, home.manager) },
      });
      const taskId = (taskRes.json() as { id: string }).id;
      const tagRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/tags`, headers: asUser(home.manager), payload: { label: "Facet", color: "olive" } });
      const tagId = (tagRes.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/api/${home.t}/pm/tasks/${taskId}`, headers: asUser(home.manager), payload: { tags: [tagId] } });
      const msRes = await app.inject({ method: "POST", url: `/api/${home.t}/pm/projects/${home.projectId}/milestones`, headers: asUser(home.manager), payload: { name: "Facet MS", dueDate: "2026-09-01" } });
      const milestoneId = (msRes.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/api/${home.t}/pm/tasks/${taskId}`, headers: asUser(home.manager), payload: { milestoneId } });

      // every facet at once, all values legitimately existing IN TENANT A, fired at the RIVAL's own
      // tenant-wide URL as a rival manager (who has every legitimate right to read THEIR OWN
      // tenant's task list — the test is whether tenant A's rows leak through, not whether the
      // rival may call the endpoint at all).
      const qs = `?status=todo&priority=urgent&tag=${tagId}&responsible=${home.manager}&ball=${home.member}&milestone=${milestoneId}&includeClosed=true&limit=200`;
      const r = await app.inject({ method: "GET", url: `/api/${rival.t}/pm/tasks${qs}`, headers: asUser(rival.manager) });
      expect(r.statusCode).toBe(200);
      const body = r.json() as { items: Array<{ id: string }> };
      expect(body.items.find((x) => x.id === taskId)).toBeUndefined();
      expect(body.items.length).toBe(0);

      // and a forged cross-tenant taskId on a single-task read 404s (RLS-invisible), never 200/403
      // in a way that would let a rival distinguish "doesn't exist" from "exists but is hidden".
      const single = await app.inject({ method: "GET", url: `/api/${rival.t}/pm/tasks/${taskId}`, headers: asUser(rival.manager) });
      expect(single.statusCode).toBe(404);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 3. TIER BOUNDARIES — viewer / member / manager / company_admin against the actions each is
  //    supposed to be able (or unable) to take.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("tier boundaries", () => {
    it("viewer: read-only everywhere — denied create/delete/manage, allowed read", async () => {
      const { t, manager, viewer, projectId } = await freshTenant("tier-viewer");
      const create = await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(viewer), payload: { projectId, title: "nope" } });
      expect(create.statusCode).toBe(403);

      const seeded = (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "seed", assignee: own(manager, manager) } })).json() as { id: string };

      const read = await app.inject({ method: "GET", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(viewer) });
      expect(read.statusCode).toBe(200);

      const del = await app.inject({ method: "DELETE", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(viewer) });
      expect(del.statusCode).toBe(403);

      // viewer CAN pass a ball that already exists (update-gated, same as member) but CANNOT
      // change ownership (manage-gated).
      const pass = await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(viewer), payload: { addSubtask: "x" } });
      expect(pass.statusCode).toBe(200);
      const ownershipChange = await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(viewer), payload: { assignee: own(viewer, viewer) } });
      expect(ownershipChange.statusCode).toBe(403);

      const tagCreate = await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/tags`, headers: asUser(viewer), payload: { label: "x", color: "slate" } });
      expect(tagCreate.statusCode).toBe(403);
      const statusCreate = await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/statuses`, headers: asUser(viewer), payload: { label: "x", color: "#111111" } });
      expect(statusCreate.statusCode).toBe(403);
    });

    it("member: same update/manage split as viewer for tag/status registries and delete, but IS allowed the base task-execution surface", async () => {
      const { t, manager, member, projectId } = await freshTenant("tier-member");
      const seeded = (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "seed" } })).json() as { id: string };

      // ── OWNER DECISION 2026-08-24 (PERMISSION-CONTRACT §16) ────────────────────────────────
      // `create` used to be 403 here, bundled into one Cerbos rule with `delete`/`manage`. It is
      // now member-level: raising a task is ordinary work. What did NOT move is naming somebody
      // else as responsible — that is still `manage`, and asserting BOTH in the same case is the
      // point, because the tier boundary this test guards is exactly the line between them.
      const create = await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(member), payload: { projectId, title: "member raises" } });
      expect(create.statusCode).toBe(201);
      const assignOther = await app.inject({
        method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(member),
        payload: {
          projectId, title: "nope",
          assignee: { kind: "person", refId: manager, refName: "Mgr", responsibleId: manager, responsibleName: "Mgr" },
        },
      });
      expect(assignOther.statusCode).toBe(403);
      const del = await app.inject({ method: "DELETE", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(member) });
      expect(del.statusCode).toBe(403);
      const tagCreate = await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/tags`, headers: asUser(member), payload: { label: "x", color: "slate" } });
      expect(tagCreate.statusCode).toBe(403);
      const suggestionConfirm = await app.inject({ method: "POST", url: `/api/${t}/pm/suggestions/${newId()}/confirm`, headers: asUser(member), payload: {} });
      expect(suggestionConfirm.statusCode).toBe(403); // manage-gated, denied before the (nonexistent) suggestion is even looked up

      // but a member DOES have the base "update" surface: status/priority/subtask edits, time log.
      const statusChange = await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(member), payload: { status: "in_progress" } });
      expect(statusChange.statusCode).toBe(200);
      const priorityChange = await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(member), payload: { priority: "urgent" } });
      expect(priorityChange.statusCode).toBe(200);
      const reschedule = await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${seeded.id}`, headers: asUser(member), payload: { dueDate: "2026-12-01" } });
      expect(reschedule.statusCode).toBe(200);
    });

    // HIER-3 (2026-08-11): the "REAL FINDING: a `team_lead` grant scoped to the COMPANY..." case
    // that used to sit here is REMOVED, not replaced. It pinned a routed-but-undecided finding
    // ("either PM resources need to carry `teamId`, or the rule text should drop the dead role
    // name") — HIER-3 IS that decision: `team_lead` is retired entirely (role, derived role, and
    // every writer that could mint the grant), so `resource_pm_task.yaml`/`resource_pm_project.yaml`
    // no longer list it at all, and there is nothing left to pin.

    it("manager: full authority — create/delete/reschedule/priority/status-change/tag+status registry edits/suggestion confirm", async () => {
      const { t, manager, projectId } = await freshTenant("tier-manager");
      const create = await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "mgr task" } });
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;

      expect((await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager), payload: { priority: "urgent", dueDate: "2026-11-01", status: "in_progress" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/tags`, headers: asUser(manager), payload: { label: "mgr", color: "dust" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/statuses`, headers: asUser(manager), payload: { label: "mgr status", color: "#222222" } })).statusCode).toBe(201);

      const run = await app.inject({ method: "POST", url: `/api/${t}/pm/tasks/${id}/tracker/run`, headers: asUser(manager), payload: {} });
      const sug = (run.json() as { suggestions: Array<{ id: string }> }).suggestions[0];
      if (sug) {
        expect((await app.inject({ method: "POST", url: `/api/${t}/pm/suggestions/${sug.id}/confirm`, headers: asUser(manager), payload: {} })).statusCode).toBe(200);
      }
      expect((await app.inject({ method: "DELETE", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(manager) })).statusCode).toBe(200);
    });

    it("company_admin: identical full authority to manager on the same surface", async () => {
      const { t, companyAdmin, projectId } = await freshTenant("tier-company-admin");
      const create = await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(companyAdmin), payload: { projectId, title: "admin task" } });
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;
      expect((await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(companyAdmin), payload: { priority: "low" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "POST", url: `/api/${t}/pm/projects/${projectId}/tags`, headers: asUser(companyAdmin), payload: { label: "admin", color: "clay" } })).statusCode).toBe(201);
      expect((await app.inject({ method: "DELETE", url: `/api/${t}/pm/tasks/${id}`, headers: asUser(companyAdmin) })).statusCode).toBe(200);
    });
  });

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 4. CHAIN ENFORCEMENT AS AN AUTHZ-ADJACENT SURFACE — a 409 (naming the blocker) must never be
  //    reachable by a caller the base `update` gate would otherwise have refused.
  // ════════════════════════════════════════════════════════════════════════════════════════════
  describe("dependency-chain enforcement never leaks past the authz gate", () => {
    it("a viewer (no `update`) attempting a blocked-task start gets 403 — the ordering means they never reach the 409 that would name the blocker", async () => {
      const { t, manager, viewer, projectId } = await freshTenant("chain-order");
      const blocker = (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Secret blocker title" } })).json() as { id: string };
      const dependent = (await app.inject({ method: "POST", url: `/api/${t}/pm/tasks`, headers: asUser(manager), payload: { projectId, title: "Dependent" } })).json() as { id: string };
      await app.inject({ method: "PATCH", url: `/api/${t}/pm/tasks/${dependent.id}`, headers: asUser(manager), payload: { addDependency: blocker.id } });

      // viewer legitimately CAN read the task (read is broad) — but let's remove that read grant's
      // relevance by attacking with a principal that would be 403'd on update. viewer has read+update
      // per the policy (viewer is in the update rule too) — so use a genuinely outside caller instead:
      // a rival-tenant principal with NO grant on this tenant at all is the cleanest proof that the
      // ordering holds even when a write is attempted.
      const outsider = await createUser(`${newId()}@x.test`, "Chain outsider (no grant at all)");
      const attempt = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${dependent.id}`, headers: asUser(outsider),
        payload: { status: "in_progress" },
      });
      expect(attempt.statusCode).toBe(403);
      expect(attempt.body).not.toContain("Secret blocker title");

      // sanity: the SAME transition, from an authorized caller, DOES 409 and DOES name the blocker
      // (proving the fixture is real and the enforcement gate itself works) — the point isn't that
      // the message is secret from an authorized reader (PM read has no per-task ACL, see report),
      // only that an unauthorized caller never gets far enough to see it.
      const authorizedAttempt = await app.inject({
        method: "PATCH", url: `/api/${t}/pm/tasks/${dependent.id}`, headers: asUser(manager),
        payload: { status: "in_progress" },
      });
      expect(authorizedAttempt.statusCode).toBe(409);
      expect(authorizedAttempt.body).toContain("Secret blocker title");
    });
  });
});
