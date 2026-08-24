// `seed:org-structure-refresh` — the fix for "the ERP still shows invented people".
//
// ⚠ THE BUG THIS EXISTS FOR WAS INVISIBLE TO EVERY OTHER CHECK. The roster landed completely — 20
// users, memberships, role grants, seats, HR files, all verified by direct query — and the app still
// rendered "Gede Pratama" and "Komang Adi". The org tree is ONE JSON blob in
// `company_org_structure`, written once from the old placeholder roster, and every org/people surface
// reads it rather than the tables.
//
// ⚠ AND THE SEED CANNOT FIX IT. `seed:agency` inserts that blob `ON CONFLICT (tenant_id) DO NOTHING`
// — correctly, because a user can rearrange the tree in the org builder and a seed must not clobber
// that. The consequence is that the stale tree is STICKY: re-running the seed changes nothing, ever.
// So the suite's most important assertion is that this script UPSERTS where the seed does not.
//
// ⚠ Needs DATABASE_URL_TEST. Skips silently otherwise.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser } from "../testing/fixtures";
import { withTenants } from "../db";
import { refreshOrgStructure } from "./org-structure-refresh";
import { STAFF } from "./roster";

const AGENCY = "Gaia Digital Agency";
let tenantId: string;

interface Node { id: string; name: string; kind: string; children?: Node[] }

async function readTree(): Promise<Node> {
  const r = await withTenants([tenantId], (c) =>
    c.query<{ structure: { root: Node } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [
      tenantId,
    ]),
  );
  return r.rows[0].structure.root;
}
function names(n: Node, out: string[] = []): string[] {
  if (n.kind === "person") out.push(n.name);
  for (const c of n.children ?? []) names(c, out);
  return out;
}
/** Writes a blob the way `seed:agency` does — insert-if-absent — so the fixture reproduces the exact
 *  production state: a stale tree the seed will never replace. */
async function seedStaleTree(people: { id: string; name: string }[]): Promise<void> {
  const structure = {
    root: {
      id: "root", name: AGENCY, kind: "company",
      children: [{
        id: "d-webdev", name: "Web Dev", kind: "department",
        children: [{
          id: "v-webdev", name: "Web Dev", kind: "division",
          children: people.map((p) => ({ id: "p-" + p.id.slice(0, 8), name: p.name, kind: "person", assigneeId: p.id, children: [] })),
        }],
      }],
    },
  };
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site) VALUES ($1,$2,'test')
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, JSON.stringify(structure)],
    ),
  );
}

describe.skipIf(!TEST_URL)("seed:org-structure-refresh", () => {
  beforeAll(async () => {
    await initTestDb();
    tenantId = await createCompany(AGENCY, ["agency", "hr", "reports", "assistant"]);
    for (const s of STAFF) await createUser(s.email, s.name, s.title);
  }, 180_000);

  afterAll(async () => {
    await teardownTestDb();
  });

  it("🔴 REPLACES a stale seed-shaped tree — which `ON CONFLICT DO NOTHING` never would", async () => {
    const ghost = await createUser("gede@gaia.test", "Gede Pratama", "Frontend Developer");
    await seedStaleTree([{ id: ghost, name: "Gede Pratama" }]);
    expect(names(await readTree()), "fixture must start stale").toEqual(["Gede Pratama"]);

    const r = await refreshOrgStructure({ force: false });
    expect(r.hadBlob).toBe(true);
    expect(r.written).toBe(true);

    const after = names(await readTree());
    expect(after, "the placeholder must be gone").not.toContain("Gede Pratama");
    expect(after.length, "every roster member should be placed").toBe(STAFF.length);
    for (const s of STAFF) expect(after, `${s.name} missing from the tree`).toContain(s.name);
  });

  it("places people under the division/department their roster row names", async () => {
    const root = await readTree();
    const find = (id: string, n: Node = root): Node | undefined =>
      n.id === id ? n : (n.children ?? []).map((c) => find(id, c)).find(Boolean);
    // Spot-check the chain the owner actually described: Azlan heads Web Dev, Hansel sits in the AI
    // Manager division under it, Radit is in the no-division Social Media department.
    expect(names(find("d-webdev")!)).toContain("Azlan");
    expect(names(find("v-aimgr")!)).toEqual(["Clement Hansel"]);
    expect(names(find("d-social")!)).toContain("Radit");
  });

  it("🔴 REFUSES a tree that looks hand-edited, rather than destroying org-builder work", async () => {
    // A person nobody in the roster or the retired placeholder set accounts for = someone arranged
    // this by hand. Overwriting would destroy work no seed can reconstruct.
    const stranger = await createUser("stranger@elsewhere.test", "A Stranger", "Contractor");
    await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE company_org_structure SET structure = $2 WHERE tenant_id = $1`,
        [tenantId, JSON.stringify({ root: { id: "root", name: AGENCY, kind: "company", children: [
          { id: "d-webdev", name: "Web Dev", kind: "department", children: [
            { id: "p-" + stranger.slice(0, 8), name: "A Stranger", kind: "person", children: [] }] }] } })],
      ),
    );
    await expect(refreshOrgStructure({ force: false })).rejects.toThrow(/does not look seed-shaped/);
  });

  it("--force overrides the refusal, because sometimes you do mean it", async () => {
    const r = await refreshOrgStructure({ force: true });
    expect(r.looksHandEdited).toBe(true);
    expect(names(await readTree())).not.toContain("A Stranger");
  });

  it("🔴 refuses when a roster member has no users row — no tree with holes in it", async () => {
    // A silently short org chart is the exact class of failure this script was written to fix, so
    // producing one would be self-defeating.
    await adminPool().query(`UPDATE users SET email = 'parked@nowhere.test' WHERE email = $1`, ["radit@gaiada.com"]);
    await expect(refreshOrgStructure({ force: true })).rejects.toThrow(/have no users row/);
    await adminPool().query(`UPDATE users SET email = $1 WHERE email = 'parked@nowhere.test'`, ["radit@gaiada.com"]);
  });

  it("is idempotent — running twice leaves the same tree", async () => {
    const a = names(await readTree());
    await refreshOrgStructure({ force: true });
    expect(names(await readTree())).toEqual(a);
  });
});
