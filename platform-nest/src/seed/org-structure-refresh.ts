// Rebuild `company_org_structure` from the REAL roster.
//
// ⚠ THIS IS THE REASON THE ERP STILL SHOWED INVENTED PEOPLE. Everything else about the roster landed
// — 20 users, memberships, role grants, seats, HR files — and the app still rendered "Gede Pratama",
// "Komang Adi", "Putu Yoga". The org tree is a single JSON blob in `company_org_structure`, written
// once on 2026-08-04 from the OLD placeholder roster, and every org/people surface reads it.
//
// ⚠ AND `seed:agency` WOULD NOT HAVE FIXED IT. Its insert is:
//
//     INSERT INTO company_org_structure (...) VALUES (...) ON CONFLICT (tenant_id) DO NOTHING
//     -- "Insert-if-absent: seed a starting tree but NEVER overwrite edits made in the org builder."
//
// That comment is right — the blob is user-editable, so a seed must not clobber it. The consequence
// is that the stale tree is STICKY: re-running the seed, on any schedule, would have changed nothing.
// A rename in the roster reaches the app only through a deliberate rebuild, which is what this is.
//
// ── WHY IT REFUSES RATHER THAN JUST OVERWRITING ───────────────────────────────────────────────────
// The same property that makes the blob stale makes it precious: if someone has arranged the tree in
// the org builder, replacing it destroys work no seed can reconstruct. So this script decides whether
// the tree on disk is SEED-SHAPED (only node ids the seed itself emits, and only people who are in
// the roster or the retired placeholder set) and refuses when it is not, unless `--force` is passed.
//
// Detecting "hand-edited" by shape rather than by a flag is deliberate: there is no column recording
// who last wrote the blob, and `updated_at` moves for both cases.
import { withGlobal, withTenants, closePool } from "../db";
import { config } from "../config";
import { STAFF, AGENCY_DEPTS } from "./roster";

const AGENCY_NAME = "Gaia Digital Agency";

/** Node ids the seed's own tree builder emits: the root, one per department, one per division, and
 *  `p-<first 8 of a user id>` per person. Anything else means a human added a node. */
const SEED_NODE_IDS = new Set<string>([
  "root",
  ...AGENCY_DEPTS.map((d) => d.id),
  ...AGENCY_DEPTS.flatMap((d) => d.divisions.map(([vid]) => vid)),
]);

/** The invented roster this replaces. Present so a tree containing ONLY these people still counts as
 *  seed-shaped — otherwise the very state we are fixing would be treated as hand-edited. */
const RETIRED_PLACEHOLDERS = new Set([
  "Gede Pratama", "Komang Adi", "Putu Yoga", "Kadek Sari", "Citra (Design)", "Luh Ayu",
  "Wayan Krisna", "Nyoman Bagus", "Kadek Rai", "Dewi (Copy)", "Putu Wira", "Made Ayu",
  "Komang Dewi", "Ayu (Owner)", "Budi (PM)", "Eka (Client Lead)", "Gaiada Exec", "Clement Hansel",
]);

interface Node {
  id: string;
  name: string;
  kind: string;
  assigneeId?: string;
  assigneeName?: string;
  children?: Node[];
}

function walk(n: Node, fn: (n: Node) => void): void {
  fn(n);
  for (const c of n.children ?? []) walk(c, fn);
}

export interface OrgRefreshResult {
  tenantId: string;
  hadBlob: boolean;
  looksHandEdited: boolean;
  unknownNodes: string[];
  peopleBefore: string[];
  peopleAfter: string[];
  written: boolean;
}

export async function refreshOrgStructure(opts: { force: boolean }): Promise<OrgRefreshResult> {
  const site = config.originSite;
  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!t.rows[0]) throw new Error(`refreshOrgStructure: no company named "${AGENCY_NAME}"`);
  const tenantId = t.rows[0].id;

  // ── who is actually in the roster, by user id ────────────────────────────────────────────────────
  const emails = STAFF.map((s) => s.email);
  const users = await withGlobal((c) =>
    c.query<{ id: string; email: string; name: string }>(
      `SELECT id, email, name FROM users WHERE email = ANY($1)`,
      [emails],
    ),
  );
  const byEmail = new Map(users.rows.map((r) => [r.email, r]));
  const missing = STAFF.filter((s) => !byEmail.has(s.email)).map((s) => s.email);
  if (missing.length) {
    // Refuse rather than build a tree with holes in it — a silently short org chart is exactly the
    // class of problem this script exists to fix.
    throw new Error(
      `refreshOrgStructure: ${missing.length} roster member(s) have no users row: ${missing.join(", ")}. ` +
        `Run seed:roster-access first.`,
    );
  }

  // ── inspect what is there now ───────────────────────────────────────────────────────────────────
  const existing = await withTenants([tenantId], (c) =>
    c.query<{ structure: { root: Node } }>(`SELECT structure FROM company_org_structure WHERE tenant_id = $1`, [
      tenantId,
    ]),
  );
  const hadBlob = existing.rows.length > 0;
  const peopleBefore: string[] = [];
  const unknownNodes: string[] = [];
  if (hadBlob) {
    walk(existing.rows[0].structure.root, (n) => {
      if (n.kind === "person") peopleBefore.push(n.name);
      else if (!SEED_NODE_IDS.has(n.id)) unknownNodes.push(`${n.kind}:${n.id}`);
    });
  }
  const rosterNames = new Set(STAFF.map((s) => s.name));
  const unexpectedPeople = peopleBefore.filter((p) => !rosterNames.has(p) && !RETIRED_PLACEHOLDERS.has(p));
  const looksHandEdited = unknownNodes.length > 0 || unexpectedPeople.length > 0;

  if (hadBlob && looksHandEdited && !opts.force) {
    throw new Error(
      `refreshOrgStructure: this tree does not look seed-shaped — ` +
        `${unknownNodes.length} unrecognised node(s) [${unknownNodes.slice(0, 5).join(", ")}] and ` +
        `${unexpectedPeople.length} unrecognised person/people [${unexpectedPeople.slice(0, 5).join(", ")}]. ` +
        `Somebody may have arranged this in the org builder, and overwriting it destroys work no seed ` +
        `can reconstruct. Re-run with --force if you are sure.`,
    );
  }

  // ── build the tree from the roster ──────────────────────────────────────────────────────────────
  // Same shape the seed emits, so a later `seed:agency` on a fresh database produces an identical
  // tree and this script stays a REFRESH rather than a second, divergent definition.
  const placements = new Map<string, { id: string; name: string }[]>();
  for (const s of STAFF) {
    const u = byEmail.get(s.email)!;
    const arr = placements.get(s.target) ?? [];
    arr.push({ id: u.id, name: s.name });
    placements.set(s.target, arr);
  }
  const people = (nodeId: string): Node[] =>
    (placements.get(nodeId) ?? []).map((p) => ({
      id: "p-" + p.id.slice(0, 8),
      name: p.name,
      kind: "person",
      assigneeId: p.id,
      assigneeName: p.name,
      children: [],
    }));
  const div = (id: string, name: string): Node => ({ id, name, kind: "division", children: people(id) });
  const dept = (id: string, name: string, divisions: [string, string][]): Node => ({
    id,
    name,
    kind: "department",
    children: [...divisions.map(([vid, vname]) => div(vid, vname)), ...people(id)],
  });
  const structure = {
    root: {
      id: "root",
      name: AGENCY_NAME,
      kind: "company",
      children: AGENCY_DEPTS.map((d) => dept(d.id, d.name, d.divisions)),
    } as Node,
  };

  const peopleAfter: string[] = [];
  walk(structure.root, (n) => {
    if (n.kind === "person") peopleAfter.push(n.name);
  });

  // ⚠ UPSERT, not insert-if-absent. That is the whole difference from `seed:agency`, and the reason
  // this is a separate, deliberately-invoked script rather than part of it.
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO company_org_structure (tenant_id, structure, origin_site)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET structure = EXCLUDED.structure, updated_at = now()`,
      [tenantId, JSON.stringify(structure), site],
    ),
  );

  return { tenantId, hadBlob, looksHandEdited, unknownNodes, peopleBefore, peopleAfter, written: true };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const r = await refreshOrgStructure({ force });
  console.log(`tenant:            ${r.tenantId}`);
  console.log(`had an org tree:   ${r.hadBlob}`);
  console.log(`people BEFORE (${r.peopleBefore.length}): ${r.peopleBefore.join(", ") || "(none)"}`);
  console.log(`people AFTER  (${r.peopleAfter.length}): ${r.peopleAfter.join(", ")}`);
  const gone = r.peopleBefore.filter((p) => !r.peopleAfter.includes(p));
  if (gone.length) console.log(`removed (retired placeholders): ${gone.join(", ")}`);
  console.log("\nThe org tree now matches roster.ts. Every org/people surface reads this blob.");
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
