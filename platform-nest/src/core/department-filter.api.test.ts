// DW-6d / DW-6g — `?departmentId=` on the clients, deliverables and projects lists
// (docs/FRONTEND-BFF-CONTRACT.md §33). Real Postgres + RLS + Cerbos. The org tree is saved through the
// REAL org save path (PUT /org-structure -> applyOrgStructure -> rebuildOrgUnitClosure), so the closure the
// filter reads is the one the product writes, never hand-inserted rows.
//
// The tree (company A):   root-a
//                           ├─ dept-a  (department)
//                           │    └─ div-a  (division)
//                           └─ dept-b  (department)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { withTenants } from "../db";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import {
  createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject,
} from "../testing/fixtures";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

type Named = { id: string; name: string };

describe.skipIf(!TEST_URL)("department filter on clients, deliverables and projects (DW-6d / DW-6g)", () => {
  let app: NestFastifyApplication;
  let coA: string;
  let coB: string;
  let coC: string;
  let admin: string;
  let member: string;
  let outsider: string;

  // company A
  const client: Record<string, string> = {};
  const project: Record<string, string> = {};
  const deliverable: Record<string, string> = {};
  // company B (same node id "dept-a", a tree with no division under it)
  let bClient: string;
  let bProject: string;
  let bDivProject: string;
  // company C (no org tree saved at all: no closure rows)
  let cClient: string;
  let cProject: string;

  const get = (co: string, path: string, as = member) =>
    app.inject({ method: "GET", url: `/api/${co}/${path}`, headers: asUser(as) });
  const names = async (co: string, path: string): Promise<string[]> => {
    const r = await get(co, path);
    expect(r.statusCode, `${path}: ${r.body}`).toBe(200);
    return (r.json() as Named[]).map((x) => x.name).sort();
  };

  async function putOrg(co: string, root: unknown): Promise<void> {
    const r = await app.inject({ method: "PUT", url: `/api/${co}/org-structure`, headers: asUser(admin), payload: { root } });
    expect(r.statusCode, r.body).toBe(200);
  }
  async function placeProject(co: string, projectId: string, departmentId: string | null): Promise<void> {
    await withTenants([co], (c) => c.query(`UPDATE projects SET department_id = $2 WHERE id = $1`, [projectId, departmentId]));
  }
  async function mkDeliverable(co: string, projectId: string, name: string, clientId?: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/deliverables`, headers: asUser(member),
      payload: { projectId, name, ...(clientId ? { clientId } : {}) },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();

    coA = await createCompany("Dept Filter A", ["clients"]);
    coB = await createCompany("Dept Filter B", ["clients"]);
    coC = await createCompany("Dept Filter C", ["clients"]);
    admin = await createUser("admin@df.test");
    member = await createUser("member@df.test");
    outsider = await createUser("outsider@df.test");
    for (const co of [coA, coB, coC]) {
      await addMembership(co, admin);
      await addMembership(co, member);
    }
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    for (const co of [coA, coB, coC]) {
      await grantRole(admin, adminRole, "company", co);
      await grantRole(member, memberRole, "company", co);
    }
    app = await buildApp();

    // ── company A: the tree is saved through the real route ──
    await putOrg(coA, {
      id: "root-a", name: "Dept Filter A", kind: "company",
      children: [
        { id: "dept-a", name: "Web Dev", kind: "department", children: [{ id: "div-a", name: "Front end", kind: "division", children: [] }] },
        { id: "dept-b", name: "SEO", kind: "department", children: [] },
      ],
    });
    // The closure the route wrote (self-inclusive, so dept-a -> dept-a and dept-a -> div-a).
    const closure = await withTenants([coA], (c) =>
      c.query<{ a: string; d: string }>(`SELECT ancestor_id AS a, descendant_id AS d FROM org_unit_closure WHERE tenant_id = $1`, [coA]),
    );
    expect(closure.rows).toContainEqual({ a: "dept-a", d: "dept-a" });
    expect(closure.rows).toContainEqual({ a: "dept-a", d: "div-a" });
    expect(closure.rows).not.toContainEqual({ a: "dept-b", d: "div-a" });

    for (const n of ["dept", "div", "other", "deleted", "both", "none"]) client[n] = await createClient(coA, `client-${n}`);
    project.dept = await createProject(coA, "proj-dept", undefined, client.dept);
    project.div = await createProject(coA, "proj-div", undefined, client.div);
    project.other = await createProject(coA, "proj-other", undefined, client.other);
    project.deleted = await createProject(coA, "proj-deleted", undefined, client.deleted);
    project.both1 = await createProject(coA, "proj-both-dept", undefined, client.both);
    project.both2 = await createProject(coA, "proj-both-div", undefined, client.both);
    project.nodept = await createProject(coA, "proj-nodept", undefined, client.none);
    await placeProject(coA, project.dept, "dept-a");
    await placeProject(coA, project.div, "div-a");
    await placeProject(coA, project.other, "dept-b");
    await placeProject(coA, project.deleted, "dept-a");
    await placeProject(coA, project.both1, "dept-a");
    await placeProject(coA, project.both2, "div-a");
    // `client-none` has a project, but one that no department owns.

    deliverable.dept = await mkDeliverable(coA, project.dept, "del-dept", client.dept);
    deliverable.div = await mkDeliverable(coA, project.div, "del-div", client.div);
    deliverable.other = await mkDeliverable(coA, project.other, "del-other", client.other);
    deliverable.deleted = await mkDeliverable(coA, project.deleted, "del-deleted", client.deleted);
    deliverable.both1 = await mkDeliverable(coA, project.both1, "del-both-dept", client.both);
    deliverable.both2 = await mkDeliverable(coA, project.both2, "del-both-div", client.both);
    deliverable.nodept = await mkDeliverable(coA, project.nodept, "del-nodept", client.none);
    // The project is deleted AFTER its deliverable exists (the deliverable route refuses a deleted project).
    await withTenants([coA], (c) => c.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [project.deleted]));

    // ── company B: the SAME node id "dept-a", but no division under it ──
    await putOrg(coB, {
      id: "root-b", name: "Dept Filter B", kind: "company",
      children: [{ id: "dept-a", name: "Their department", kind: "department", children: [] }],
    });
    bClient = await createClient(coB, "b-client");
    bProject = await createProject(coB, "b-proj", undefined, bClient);
    bDivProject = await createProject(coB, "b-proj-at-a's-division-id", undefined, bClient);
    await placeProject(coB, bProject, "dept-a");
    // B has no `div-a` node: its closure cannot link it to dept-a, whatever company A's tree says.
    await placeProject(coB, bDivProject, "div-a");
    await mkDeliverable(coB, bProject, "b-del", bClient);

    // ── company C: no org tree was ever saved (an unbuilt closure) ──
    cClient = await createClient(coC, "c-client");
    cProject = await createProject(coC, "c-proj", undefined, cClient);
    await placeProject(coC, cProject, "lonely-node");
    await mkDeliverable(coC, cProject, "c-del", cClient);
  });
  afterAll(async () => {
    await app.close();
    await teardownTestDb();
  });

  // ───────────────────────────────── clients ─────────────────────────────────
  it("clients: the department lists the clients of its own projects and of the division's, once each", async () => {
    expect(await names(coA, "clients?departmentId=dept-a")).toEqual(["client-both", "client-dept", "client-div"]);
  });

  it("clients: the division lists only its own; the other department only its own", async () => {
    expect(await names(coA, "clients?departmentId=div-a")).toEqual(["client-both", "client-div"]);
    expect(await names(coA, "clients?departmentId=dept-b")).toEqual(["client-other"]);
  });

  it("clients: never a client whose only project is deleted, a client with no project, or one whose project has no department", async () => {
    for (const q of ["dept-a", "div-a", "dept-b"]) {
      const got = await names(coA, `clients?departmentId=${q}`);
      expect(got).not.toContain("client-deleted");
      expect(got).not.toContain("client-none");
    }
  });

  it("clients: an id that names no node is an empty list, not a 404", async () => {
    const r = await get(coA, "clients?departmentId=no-such-node");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([]);
  });

  it("clients: absent, empty and whitespace give today's list, byte for byte", async () => {
    const all = await get(coA, "clients");
    expect(all.statusCode).toBe(200);
    expect((all.json() as Named[]).map((c) => c.name).sort()).toEqual(
      ["client-both", "client-deleted", "client-dept", "client-div", "client-none", "client-other"],
    );
    expect((await get(coA, "clients?departmentId=")).body).toBe(all.body);
    expect((await get(coA, "clients?departmentId=%20%20")).body).toBe(all.body);
  });

  it("clients: the row shape is unchanged by the filter", async () => {
    const all = (await get(coA, "clients")).json() as Array<Record<string, unknown>>;
    const filtered = (await get(coA, "clients?departmentId=dept-a")).json() as Array<Record<string, unknown>>;
    expect(Object.keys(filtered[0]).sort()).toEqual(Object.keys(all[0]).sort());
  });

  // ───────────────────────────────── deliverables ─────────────────────────────────
  it("deliverables: the department lists those on its own projects and on the division's", async () => {
    expect(await names(coA, "deliverables?departmentId=dept-a")).toEqual(["del-both-dept", "del-both-div", "del-dept", "del-div"]);
  });

  it("deliverables: the division lists only its own; nothing from the other department, a deleted project, or a project with no department", async () => {
    expect(await names(coA, "deliverables?departmentId=div-a")).toEqual(["del-both-div", "del-div"]);
    expect(await names(coA, "deliverables?departmentId=dept-b")).toEqual(["del-other"]);
    for (const q of ["dept-a", "div-a", "dept-b"]) {
      const got = await names(coA, `deliverables?departmentId=${q}`);
      expect(got).not.toContain("del-deleted");
      expect(got).not.toContain("del-nodept");
    }
  });

  it("deliverables: absent gives every deliverable (today's list), including those of a deleted project", async () => {
    const all = await get(coA, "deliverables");
    expect((all.json() as Named[]).map((d) => d.name).sort()).toEqual(
      ["del-both-dept", "del-both-div", "del-deleted", "del-dept", "del-div", "del-nodept", "del-other"],
    );
    expect((await get(coA, "deliverables?departmentId=")).body).toBe(all.body);
  });

  it("deliverables: combines with clientId and projectId (AND)", async () => {
    expect(await names(coA, `deliverables?departmentId=dept-a&clientId=${client.both}`)).toEqual(["del-both-dept", "del-both-div"]);
    expect(await names(coA, `deliverables?departmentId=div-a&clientId=${client.both}`)).toEqual(["del-both-div"]);
    expect(await names(coA, `deliverables?departmentId=dept-a&clientId=${client.other}`)).toEqual([]);
    expect(await names(coA, `deliverables?departmentId=dept-a&clientId=internal`)).toEqual([]);
    expect(await names(coA, `deliverables?departmentId=dept-a&projectId=${project.div}`)).toEqual(["del-div"]);
    expect(await names(coA, `deliverables?departmentId=dept-b&projectId=${project.div}`)).toEqual([]);
    expect(await names(coA, `deliverables?departmentId=dept-a&projectId=${project.both1}&clientId=${client.both}`)).toEqual(["del-both-dept"]);
  });

  it("deliverables: the row shape is unchanged, and the list keeps its own order", async () => {
    const filtered = (await get(coA, "deliverables?departmentId=dept-a")).json() as Array<Record<string, unknown>>;
    expect(Object.keys(filtered[0]).sort()).toEqual(
      ["clientVisible", "client_id", "custom_fields", "due_date", "id", "name", "project_id", "status"],
    );
    const all = (await get(coA, "deliverables")).json() as Named[];
    const inListOrder = all.filter((d) => filtered.some((f) => f.id === d.id)).map((d) => d.id);
    expect(filtered.map((f) => f.id)).toEqual(inListOrder);
  });

  // ───────────────────────────────── projects ─────────────────────────────────
  it("projects: the department lists its own and the division's live projects; the division only its own", async () => {
    expect(await names(coA, "projects?departmentId=dept-a")).toEqual(["proj-both-dept", "proj-both-div", "proj-dept", "proj-div"]);
    expect(await names(coA, "projects?departmentId=div-a")).toEqual(["proj-both-div", "proj-div"]);
    expect(await names(coA, "projects?departmentId=dept-b")).toEqual(["proj-other"]);
  });

  it("projects: absent gives today's list; combines with clientId (AND)", async () => {
    const all = await get(coA, "projects");
    expect((all.json() as Named[]).map((p) => p.name).sort()).toEqual(
      ["proj-both-dept", "proj-both-div", "proj-dept", "proj-div", "proj-nodept", "proj-other"],
    );
    expect((await get(coA, "projects?departmentId=")).body).toBe(all.body);
    expect(await names(coA, `projects?departmentId=dept-a&clientId=${client.both}`)).toEqual(["proj-both-dept", "proj-both-div"]);
    expect(await names(coA, `projects?departmentId=div-a&clientId=${client.both}`)).toEqual(["proj-both-div"]);
    expect(await names(coA, `projects?departmentId=dept-a&clientId=${client.other}`)).toEqual([]);
  });

  it("projects: the row shape is unchanged", async () => {
    const all = (await get(coA, "projects")).json() as Array<Record<string, unknown>>;
    const filtered = (await get(coA, "projects?departmentId=dept-a")).json() as Array<Record<string, unknown>>;
    expect(Object.keys(filtered[0]).sort()).toEqual(Object.keys(all[0]).sort());
  });

  // ───────────────────────────────── one company only ─────────────────────────────────
  it("the same node id in a second company matches only that company's own rows, and none of the first's", async () => {
    expect(await names(coB, "clients?departmentId=dept-a")).toEqual(["b-client"]);
    expect(await names(coB, "projects?departmentId=dept-a")).toEqual(["b-proj"]);
    expect(await names(coB, "deliverables?departmentId=dept-a")).toEqual(["b-del"]);
    // Company A's tree puts div-a under dept-a; company B's does not. B's project at "div-a" is not B's dept-a.
    expect(await names(coB, "projects?departmentId=dept-a")).not.toContain("b-proj-at-a's-division-id");
    // And company A never sees company B's rows.
    for (const path of ["clients", "projects", "deliverables"]) {
      const got = await names(coA, `${path}?departmentId=dept-a`);
      expect(got.some((n) => n.startsWith("b-"))).toBe(false);
    }
    expect(bDivProject).toBeTruthy();
  });

  it("a company whose closure was never built still matches a node's own projects (the equality arm)", async () => {
    expect(await names(coC, "projects?departmentId=lonely-node")).toEqual(["c-proj"]);
    expect(await names(coC, "clients?departmentId=lonely-node")).toEqual(["c-client"]);
    expect(await names(coC, "deliverables?departmentId=lonely-node")).toEqual(["c-del"]);
    expect(cClient).toBeTruthy();
  });

  // ───────────────────────────────── validation + authorization ─────────────────────────────────
  it("a malformed departmentId is a 400 naming the field, on all three lists", async () => {
    for (const bad of ["a".repeat(201), "a%0Ab", "a%09b"]) {
      for (const path of ["clients", "deliverables", "projects"]) {
        const r = await get(coA, `${path}?departmentId=${bad}`);
        expect(r.statusCode, `${path} ${bad}`).toBe(400);
        expect(r.json()).toMatchObject({ field: "departmentId" });
        expect(typeof r.json().error).toBe("string");
      }
    }
    // 200 characters is accepted (and matches nothing).
    expect((await get(coA, `clients?departmentId=${"a".repeat(200)}`)).statusCode).toBe(200);
    // A repeated parameter is ambiguous.
    expect((await get(coA, "clients?departmentId=dept-a&departmentId=dept-b")).statusCode).toBe(400);
  });

  it("a caller refused read gets 403 on all three lists, even with a malformed departmentId", async () => {
    for (const path of ["clients", "deliverables", "projects"]) {
      expect((await get(coA, `${path}?departmentId=${"a".repeat(201)}`, outsider)).statusCode, path).toBe(403);
      expect((await get(coA, `${path}?departmentId=a%0Ab`, outsider)).statusCode, path).toBe(403);
      expect((await get(coA, `${path}?departmentId=dept-a`, outsider)).statusCode, path).toBe(403);
    }
  });
});
