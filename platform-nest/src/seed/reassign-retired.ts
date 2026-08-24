// Move the retired people's data onto the real staff who do those jobs now.
//
// The roster replaced 11 invented staff (`@gaia.test`) and left 6 seed ACTORS
// (`@gaiada-creative.test` + `exec@gaiada.test`). Between them they still own ~1,100 rows across ~30
// foreign keys: projects, task assignments, uploaded files, authored docs, approvals, check-ins,
// attendance, logged time. Retiring their HR files without moving that leaves a company whose work
// belongs to nobody.
//
// ⚠ OWNER DECISION 2026-08-24: MOVE EVERYTHING, INCLUDING PERSONAL HISTORY. I raised that moving
// `hr_attendance` / `report_checkins` / `report_work_facts` / `time_entries` / `hr_*.subject_user_id`
// fabricates history for a real employee — Edward inheriting 60 attendance rows he never worked, and
// check-ins he never submitted — and the owner chose to move them anyway. Recorded here rather than
// only in a commit message, because anyone later auditing Edward's attendance needs to know those
// rows were transferred from a seeded persona and are not evidence of anything.
//
// ── THREE CATEGORIES, HANDLED DIFFERENTLY, AND THE DIFFERENCE IS THE POINT ────────────────────────
//
// 1. MOVED — ownership, attribution, assignment, and (per the ruling above) personal history.
//    These are "the data under them" in the sense the request meant.
//
// 2. DELETED — `notifications`. 282 rows addressed TO retired personas. An inbox is not transferable
//    data: moving it would bury a real person's genuine notifications under 282 stale items about
//    work that was seeded, and nobody would ever read them. Deleting is the honest disposal of mail
//    sent to someone who does not exist.
//
// 3. NOT TOUCHED — `identity_links`, `user_roles`, `org_unit_memberships`, `position_assignments`.
//    These are IDENTITY and AUTHORIZATION, not data. Moving a `user_roles` row would grant a real
//    person a fake person's access, which is a privilege change wearing a data-migration costume.
//    The last two are already correct anyway: the org-structure refresh's membership sweep closed the
//    retired placements and opened the real ones.
import { withGlobal, withTenants, closePool } from "../db";

/** Retired identity -> the real person doing that job now. Mapped BY FUNCTION (owner decision), from
 *  the roster's own titles, so the work lands with whoever would actually pick it up today. */
const REASSIGN: Record<string, string> = {
  // Leadership / client-facing
  "owner@gaiada-creative.test": "edward@gaiada.com", // Ayu, Managing Director -> GM
  "approver@gaiada-creative.test": "edward@gaiada.com", // Eka, Client Lead -> GM
  "exec@gaiada.test": "edward@gaiada.com", // Gaiada Exec -> GM
  // Delivery. The Project Manager SEAT IS VACANT in the roster (the owner named the position but no
  // person), so Budi's work goes to the head of the department that owns delivery rather than to a
  // seat nobody holds.
  "pm@gaiada-creative.test": "azlan@gaiada.com",
  // Creative
  "design@gaiada-creative.test": "monic@gaiada.com", // Citra, Senior Designer
  "copy@gaiada-creative.test": "monic@gaiada.com", // Dewi, Copywriter — no copywriter in the roster
  "luh.ayu@gaia.test": "monic@gaiada.com", // Graphic Designer
  "wayan.krisna@gaia.test": "monic@gaiada.com", // Video Editor
  "kadek.sari@gaia.test": "ruli@gaiada.com", // UI/UX -> the medior UI/UX
  // Web dev / maintenance
  "gede@gaia.test": "reva@gaiada.com", // Frontend Developer
  "komang.adi@gaia.test": "reva@gaiada.com", // Backend Developer
  "putu.yoga@gaia.test": "gusde@gaiada.com", // Web Maintenance -> the senior on maintenance
  // SEO / SEM
  "nyoman.bagus@gaia.test": "rai@gaiada.com",
  "kadek.rai@gaia.test": "rai@gaiada.com",
  "putu.wira@gaia.test": "rai@gaiada.com",
  // Social
  "made.ayu@gaia.test": "radit@gaiada.com",
  "komang.dewi@gaia.test": "radit@gaiada.com",
};

/** Identity/authorization columns. Never reassigned — see category 3 in the header. */
const NEVER_MOVE = new Set([
  "identity_links.user_id",
  "user_roles.user_id",
  "org_unit_memberships.user_id",
  "org_unit_memberships.created_by",
  "position_assignments.user_id",
  "position_assignments.assigned_by",
]);

/** Deleted rather than moved — see category 2. */
const DELETE_INSTEAD = new Set(["notifications.user_id"]);

const MODULES = [
  "agency", "pm", "it", "billing", "clients", "knowledge", "automation-console", "hr",
  "assistant", "search", "reports", "webdev", "social", "monitoring",
];

export interface ReassignResult {
  dryRun: boolean;
  moved: { where: string; rows: number }[];
  deleted: { where: string; rows: number }[];
  skippedCollisions: { where: string; rows: number }[];
  unmapped: string[];
}

export async function reassignRetired(opts: { dryRun: boolean }): Promise<ReassignResult> {
  const out: ReassignResult = { dryRun: opts.dryRun, moved: [], deleted: [], skippedCollisions: [], unmapped: [] };

  const emails = [...Object.keys(REASSIGN), ...new Set(Object.values(REASSIGN))];
  const users = await withGlobal((c) =>
    c.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE email = ANY($1)`, [emails]),
  );
  const idOf = new Map(users.rows.map((r) => [r.email, r.id]));
  for (const [from, to] of Object.entries(REASSIGN)) {
    if (!idOf.has(from)) out.unmapped.push(`${from} (retired user missing)`);
    if (!idOf.has(to)) out.unmapped.push(`${to} (TARGET missing — run seed:roster-access first)`);
  }
  if (out.unmapped.some((u) => u.includes("TARGET"))) {
    // Refuse: a missing target would silently skip that mapping and leave the work orphaned while
    // reporting success.
    throw new Error(`reassignRetired: target user(s) missing: ${out.unmapped.join("; ")}`);
  }

  const companies = (await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))).rows.map((r) => r.id);

  // Every FK column that points at users(id). Derived from pg_constraint rather than hand-listed:
  // a hand list silently misses the column a new migration adds, which is how orphaned work survives
  // a cleanup that reports success.
  const fks = await withGlobal((c) =>
    c.query<{ tbl: string; col: string }>(`
      SELECT src.relname AS tbl, a.attname AS col
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_class tgt ON tgt.oid = con.confrelid
      JOIN unnest(con.conkey) AS k(attnum) ON true
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
      WHERE con.contype = 'f' AND tgt.relname = 'users'
      ORDER BY 1, 2`),
  );

  await withTenants(
    companies,
    async (c) => {
      for (const { tbl, col } of fks.rows) {
        const where = `${tbl}.${col}`;
        if (NEVER_MOVE.has(where)) continue;

        if (DELETE_INSTEAD.has(where)) {
          const ids = [...idOf.entries()].filter(([e]) => e in REASSIGN).map(([, id]) => id);
          const n = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${tbl} WHERE ${col} = ANY($1::uuid[])`,
            [ids],
          );
          const rows = Number(n.rows[0].n);
          if (rows === 0) continue;
          if (!opts.dryRun) await c.query(`DELETE FROM ${tbl} WHERE ${col} = ANY($1::uuid[])`, [ids]);
          out.deleted.push({ where, rows });
          continue;
        }

        for (const [from, to] of Object.entries(REASSIGN)) {
          const fromId = idOf.get(from);
          const toId = idOf.get(to);
          if (!fromId || !toId) continue;

          const cnt = await c.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${tbl} WHERE ${col} = $1`,
            [fromId],
          );
          const rows = Number(cnt.rows[0].n);
          if (rows === 0) continue;

          if (opts.dryRun) {
            out.moved.push({ where: `${where}  ${from} -> ${to}`, rows });
            continue;
          }

          // ⚠ A BULK UPDATE CAN COLLIDE. Several of these tables carry a UNIQUE on (tenant, user,
          // date) or similar — one check-in per person per day, one leave balance per policy. Moving
          // a retired person's row onto someone who already has that day's row violates it. So the
          // bulk update runs inside a SAVEPOINT; on a unique violation it falls back to row-by-row
          // and reports how many could not move, rather than aborting the whole reassignment or
          // silently dropping them.
          await c.query("SAVEPOINT reassign_bulk");
          try {
            const r = await c.query(`UPDATE ${tbl} SET ${col} = $2 WHERE ${col} = $1`, [fromId, toId]);
            await c.query("RELEASE SAVEPOINT reassign_bulk");
            out.moved.push({ where: `${where}  ${from} -> ${to}`, rows: r.rowCount ?? 0 });
          } catch (err) {
            await c.query("ROLLBACK TO SAVEPOINT reassign_bulk");
            const msg = err instanceof Error ? err.message : String(err);
            if (!/duplicate key|unique constraint/i.test(msg)) throw err;

            const idsRes = await c.query<{ id: string }>(`SELECT id FROM ${tbl} WHERE ${col} = $1`, [fromId]);
            let ok = 0;
            let clash = 0;
            for (const row of idsRes.rows) {
              await c.query("SAVEPOINT reassign_one");
              try {
                await c.query(`UPDATE ${tbl} SET ${col} = $2 WHERE id = $1`, [row.id, toId]);
                await c.query("RELEASE SAVEPOINT reassign_one");
                ok++;
              } catch {
                await c.query("ROLLBACK TO SAVEPOINT reassign_one");
                clash++;
              }
            }
            if (ok) out.moved.push({ where: `${where}  ${from} -> ${to}`, rows: ok });
            if (clash) out.skippedCollisions.push({ where: `${where}  ${from} -> ${to}`, rows: clash });
          }
        }
      }
    },
    // ⚠ NO `crossRoot` HERE, DELIBERATELY. I had passed it "just in case" while writing this. The
    // estate has THREE companies and ONE distinct `root_company_id` (checked, not assumed), so
    // MON-00b's wall would never fire anyway — and a bypass flag that is unnecessary today is a
    // bypass flag nobody notices becoming load-bearing tomorrow. If a second root ever appears, this
    // script SHOULD fail loudly rather than quietly rewrite across a customer boundary.
    { modules: MODULES },
  );

  return out;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await reassignRetired({ dryRun });
  const total = (a: { rows: number }[]) => a.reduce((s, x) => s + x.rows, 0);

  console.log(`${dryRun ? "WOULD MOVE" : "MOVED"}: ${total(r.moved)} row(s) across ${r.moved.length} mapping(s)`);
  for (const m of r.moved) console.log(`  ${String(m.rows).padStart(5)}  ${m.where}`);
  console.log(`${dryRun ? "WOULD DELETE" : "DELETED"}: ${total(r.deleted)} row(s)`);
  for (const d of r.deleted) console.log(`  ${String(d.rows).padStart(5)}  ${d.where}  (notifications to a retired persona)`);
  if (r.skippedCollisions.length) {
    console.log(`COULD NOT MOVE (unique-constraint clash — the target already has that row): ${total(r.skippedCollisions)}`);
    for (const s of r.skippedCollisions) console.log(`  ${String(s.rows).padStart(5)}  ${s.where}`);
  }
  if (r.unmapped.length) console.log(`NOTE: ${r.unmapped.join("; ")}`);
  if (dryRun) {
    console.log("\nDRY RUN. Re-run with:  npm run seed:reassign-retired -- --confirm");
    console.log("⚠ Owner decision: personal history (attendance, check-ins, work facts, time) MOVES too,");
    console.log("  so real staff will show records transferred from seeded personas.");
  }
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
