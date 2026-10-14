// DW-7d: `seed:functional-departments` — the one-off backfill that gives every EXISTING company HR,
// Finance and IT departments in its org tree (owner ruling DW-D6), with a node id unique to each company.
//
// What it must prove: a dry run writes NOTHING; --apply appends exactly the three nodes (every other
// node stays byte-identical, including seed-built nodes that carry no assigneeId), rebuilds the closure
// through applyOrgStructure, and is a no-op the second time; a tree the sanitizer would rewrite is
// refused rather than rewritten; companies never share a node id; and the LMS courses/paths a company
// holds on the legacy `d-hr` / `d-it` ids move to its own nodes.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { withTenants } from "../db";
import { applyOrgStructure } from "../admin/org-structure.service";
import { functionalNodeId } from "../admin/functional-departments";
import { backfillFunctionalDepartments, type FunctionalDepartmentsReport } from "./functional-departments";
import { seedHrItCurriculum } from "./lms-hr-it-curriculum";

interface Node { id: string; name: string; kind: string; children?: Node[]; assigneeId?: string | null; assigneeName?: string | null }

const n = (id: string, name: string, kind: string, children: Node[] = [], extra: Partial<Node> = {}): Node =>
  ({ id, name, kind, children, ...extra });
const rootOf = (name: string, children: Node[]) => ({ root: n("root", name, "company", children) });

let A: string, B: string, C: string, D: string, E: string, F: string, G: string;
let person: string;

const ids = (node: Node, out: string[] = []): string[] => {
  out.push(node.id);
  for (const c of node.children ?? []) ids(c, out);
  return out;
};

async function blob(tenantId: string): Promise<{ structure: { root: Node }; updated_at: string } | undefined> {
  return (await adminPool().query(
    `SELECT structure, updated_at::text FROM company_org_structure WHERE tenant_id = $1`, [tenantId],
  )).rows[0];
}
async function snapshot() {
  const q = async (sql: string) => (await adminPool().query(sql)).rows;
  return {
    blobs: await q(`SELECT tenant_id, structure, updated_at::text FROM company_org_structure ORDER BY tenant_id`),
    closure: await q(`SELECT tenant_id, ancestor_id, descendant_id, depth FROM org_unit_closure ORDER BY 1,2,3`),
    memberships: await q(`SELECT * FROM org_unit_memberships ORDER BY tenant_id, user_id, unit_node_id`),
    events: await q(`SELECT id FROM outbox_events ORDER BY id`),
    lms: await q(`SELECT 'c' k, id, unit_node_id FROM lms_courses UNION ALL SELECT 'p', id, unit_node_id FROM lms_paths ORDER BY 1,2`),
  };
}
/** [courses, paths] per unit node id, read with the admin pool (RLS-free) so a zero-row UPDATE cannot hide. */
const lmsUnits = async (tenantId: string) =>
  (await adminPool().query<{ unit: string; courses: string; paths: string }>(
    `SELECT u AS unit,
            (SELECT count(*) FROM lms_courses WHERE tenant_id = $1 AND unit_node_id = u)::text AS courses,
            (SELECT count(*) FROM lms_paths WHERE tenant_id = $1 AND unit_node_id = u)::text AS paths
       FROM unnest($2::text[]) u`,
    [tenantId, ["d-hr", "d-it", functionalNodeId("hr", tenantId), functionalNodeId("it", tenantId)]],
  )).rows.reduce<Record<string, [number, number]>>((m, r) => ({ ...m, [r.unit]: [Number(r.courses), Number(r.paths)] }), {});

const byCompany = (rs: FunctionalDepartmentsReport[], id: string) => rs.find((r) => r.companyId === id)!;

describe.skipIf(!TEST_URL)("seed:functional-departments (DW-7d)", () => {
  let seededA: Node;

  beforeAll(async () => {
    await initTestDb();
    person = await createUser("fd-person@a.test", "Placed Person");
    A = await createCompany("FD Seeded Co");
    B = await createCompany("FD No Tree Co");
    C = await createCompany("FD Human Resources Co");
    D = await createCompany("FD Conflict Co");
    E = await createCompany("FD Drift Co");
    F = await createCompany("FD Legacy Dept Co", ["lms", "hr"]);
    G = await createCompany("FD Legacy LMS Co", ["lms", "hr"]);

    // A: a seed-shaped tree (no assigneeId / assigneeName on department or division nodes), one placed person.
    seededA = n("root", "FD Seeded Co", "company", [
      n("d-web", "Web Dev", "department", [
        n("v-web", "Web Dev", "division", [n("p-1", "Placed Person", "person", [], { assigneeId: person, assigneeName: "Placed Person" })]),
      ]),
      n("d-gm", "GM", "department"),
    ]);
    const write = (t: string, s: unknown) => withTenants([t], (c) => applyOrgStructure(c, t, s as never));
    await write(A, { root: seededA });
    await write(C, rootOf("FD Human Resources Co", [n("d-people", "Human Resources", "department")]));
    await write(D, rootOf("FD Conflict Co", [n("d-hr", "People", "division")]));
    // E: a tree the sanitizer would rewrite (untrimmed name), written raw as a seed's direct INSERT would.
    await withTenants([E], (c) =>
      c.query(`INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'test')`,
        [E, JSON.stringify(rootOf("FD Drift Co", [n("d-ops", "  Ops  ", "department")]))]));
    // F holds a LEGACY plain-id HR department; G holds no HR/IT node at all.
    await write(F, rootOf("FD Legacy Dept Co", [n("d-hr", "HR", "department")]));
    await write(G, rootOf("FD Legacy LMS Co", [n("d-ops", "Ops", "department")]));
    for (const [t, name] of [[F, "FD Legacy Dept Co"], [G, "FD Legacy LMS Co"]] as const) {
      await seedHrItCurriculum(name);
      // Simulate an estate seeded before DW-7d: the courses and paths sit on the shared legacy ids.
      for (const table of ["lms_courses", "lms_paths"]) {
        for (const slug of ["hr", "it"]) {
          await adminPool().query(
            `UPDATE ${table} SET unit_node_id = $3 WHERE tenant_id = $1 AND unit_node_id = $2`,
            [t, functionalNodeId(slug, t), `d-${slug}`],
          );
        }
      }
    }
  }, 180_000);

  afterAll(async () => { await teardownTestDb(); });

  it("a dry run writes nothing: blobs, closure, memberships, events and LMS rows are unchanged", async () => {
    expect((await lmsUnits(G))["d-hr"]).toEqual([3, 2]);
    expect((await lmsUnits(G))["d-it"]).toEqual([3, 2]);
    const before = await snapshot();
    const rs = await backfillFunctionalDepartments({ apply: false });
    expect(await snapshot()).toEqual(before);

    const a = byCompany(rs, A);
    expect(a.written).toBe(false);
    expect(a.added).toEqual([]);
    expect(a.wouldAdd).toEqual([functionalNodeId("hr", A), functionalNodeId("finance", A), functionalNodeId("it", A)]);
    expect(a.existingDepartments).toEqual(["Web Dev", "GM"]);
    expect(byCompany(rs, G).lmsRepointed).toEqual({ courses: 6, paths: 4 });
    expect(byCompany(rs, B).hadTree).toBe(false);
    // A "Human Resources" department is not HR: it is listed as existing and HR is still to be added.
    expect(byCompany(rs, C).existingDepartments).toEqual(["Human Resources"]);
    expect(byCompany(rs, C).wouldAdd).toContain(functionalNodeId("hr", C));
  });

  it("--apply appends exactly the three nodes; everything else stays byte-identical; the closure covers them", async () => {
    const before = await snapshot();
    const rs = await backfillFunctionalDepartments({ apply: true });
    const a = byCompany(rs, A);
    expect(a.written).toBe(true);
    expect(a.added).toEqual([functionalNodeId("hr", A), functionalNodeId("finance", A), functionalNodeId("it", A)]);

    const after = (await blob(A))!.structure.root;
    expect(after.children!.slice(0, 2)).toEqual(seededA.children); // seed-built nodes: no assigneeId added
    expect(after.children!.slice(2)).toEqual([
      n(functionalNodeId("hr", A), "HR", "department"),
      n(functionalNodeId("finance", A), "Finance", "department"),
      n(functionalNodeId("it", A), "IT", "department"),
    ]);
    expect({ ...after, children: [] }).toEqual({ ...seededA, children: [] });

    const closure = await adminPool().query<{ descendant_id: string }>(
      `SELECT descendant_id FROM org_unit_closure WHERE tenant_id = $1 AND ancestor_id = 'root'`, [A]);
    for (const f of ["hr", "finance", "it"]) {
      expect(closure.rows.map((r) => r.descendant_id)).toContain(functionalNodeId(f, A));
    }
    const mine = (rows: unknown[]) => rows.filter((r) => (r as { tenant_id: string }).tenant_id === A);
    const memberships = mine((await snapshot()).memberships);
    expect(memberships).toEqual(mine(before.memberships));
    expect(memberships).toHaveLength(1);
  });

  it("a company with no tree gets the starting tree", async () => {
    const b = (await blob(B))!.structure.root;
    expect(b.name).toBe("FD No Tree Co");
    expect(b.children!.map((c) => [c.id, c.name, c.kind])).toEqual([
      [functionalNodeId("hr", B), "HR", "department"],
      [functionalNodeId("finance", B), "Finance", "department"],
      [functionalNodeId("it", B), "IT", "department"],
    ]);
  });

  it('a "Human Resources" department keeps its place and HR is added after it', async () => {
    const c = (await blob(C))!.structure.root;
    expect(c.children!.map((x) => x.name)).toEqual(["Human Resources", "HR", "Finance", "IT"]);
  });

  it("refuses a conflict and a tree the sanitizer would rewrite, and leaves both untouched", async () => {
    const d = await blob(D);
    const e = await blob(E);
    const rs = await backfillFunctionalDepartments({ apply: true });
    expect(byCompany(rs, D).conflicts.map((x) => x.id)).toEqual(["d-hr"]);
    expect(byCompany(rs, D).written).toBe(false);
    expect(byCompany(rs, E).conflicts.map((x) => x.id)).toEqual(["(tree)"]);
    expect(byCompany(rs, E).written).toBe(false);
    expect(await blob(D)).toEqual(d);
    expect(await blob(E)).toEqual(e);
  });

  it("a second --apply writes nothing: no new event, updated_at unchanged", async () => {
    const before = await snapshot();
    const rs = await backfillFunctionalDepartments({ apply: true });
    expect(rs.filter((r) => r.written)).toEqual([]);
    expect(rs.filter((r) => r.added.length)).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("two companies get DIFFERENT ids for the same department, and no id appears in another company's tree", async () => {
    const trees = new Map<string, string[]>();
    for (const t of [A, B, C, F, G]) trees.set(t, ids((await blob(t))!.structure.root));
    expect(functionalNodeId("hr", A)).not.toBe(functionalNodeId("hr", B));
    for (const [t, own] of trees) {
      for (const slug of ["finance", "it"]) expect(own).toContain(functionalNodeId(slug, t));
      for (const [other, otherIds] of trees) {
        if (other === t) continue;
        for (const id of own.filter((x) => x.startsWith("d-") && x.includes(t))) expect(otherIds).not.toContain(id);
      }
    }
    // The shared legacy plain id is never minted: F's own pre-existing node is the only one anywhere.
    const legacy = [...trees].filter(([, own]) => own.includes("d-hr")).map(([t]) => t);
    expect(legacy).toEqual([F]);
  });

  it("a legacy plain-id HR department counts as present: no second HR is added beside it", async () => {
    const f = (await blob(F))!.structure.root;
    expect(f.children!.filter((c) => c.name === "HR")).toHaveLength(1);
    expect(f.children!.map((c) => c.id)).toEqual(["d-hr", functionalNodeId("finance", F), functionalNodeId("it", F)]);
  });

  it("re-points LMS courses and paths from the legacy unit ids to the company's own nodes, proven by the rows", async () => {
    // G holds neither legacy node: all HR and IT rows moved (3 courses + 2 paths each).
    const g = await lmsUnits(G);
    expect(g["d-hr"]).toEqual([0, 0]);
    expect(g["d-it"]).toEqual([0, 0]);
    expect(g[functionalNodeId("hr", G)]).toEqual([3, 2]);
    expect(g[functionalNodeId("it", G)]).toEqual([3, 2]);
    // F's tree HAS the legacy `d-hr` node, so its HR rows stay; `d-it` is not in the tree, so IT moved.
    const f = await lmsUnits(F);
    expect(f["d-hr"]).toEqual([3, 2]);
    expect(f[functionalNodeId("hr", F)]).toEqual([0, 0]);
    expect(f["d-it"]).toEqual([0, 0]);
    expect(f[functionalNodeId("it", F)]).toEqual([3, 2]);
  });
});
