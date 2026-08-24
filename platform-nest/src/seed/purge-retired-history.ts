// Dispose of the personal history that could NOT be transferred, because the real employee already
// had that day's row.
//
// `seed:reassign-retired` moved everything movable and reported 269 rows it could not: one check-in
// per person per day, one attendance row per person per day, one leave balance per policy-year. Where
// two retired personas mapped onto the same real employee — Luh Ayu and Wayan Krisna both to Monic —
// the second one's row collides on a UNIQUE and stays with a persona who does not exist. Re-running
// the reassignment will report those same 269 forever; they are not a backlog, they are a dead end.
//
// ⚠ OWNER DECISION 2026-08-24: DELETE THEM. "All of these data are mock and only the last seeded gaia
// is real, and even so it is not real operational data." Leaving them means HR and reporting surfaces
// keep attendance and check-ins for invented people, which is the complaint that started this whole
// cleanup. Recorded here rather than only in a commit message, because deleting HR history is the
// kind of thing someone later needs to find a reason for.
//
// ── THE SAFETY PROPERTY, WHICH IS THE POINT OF THIS FILE ──────────────────────────────────────────
// A script that deleted every history row belonging to a retired identity would be one typo in the
// reassignment away from destroying history that SHOULD have been transferred, and the difference is
// invisible afterwards. So this script never deletes a row on the grounds that it belongs to a
// persona. It deletes a row only when it can PROVE the row is redundant: the mapped real employee
// already holds the equivalent row, matched on the table's own UNIQUE key.
//
// If a row is not a duplicate, that means the reassignment did not move something it could have. This
// refuses the whole run in that case rather than deleting it — a row that could still move must be
// moved, not disposed of.
//
// ⚠ `report_work_facts`'s unique index is `NULLS NOT DISTINCT`, so its nullable key columns are
// compared with `IS NOT DISTINCT FROM`. Plain `=` would evaluate NULL = NULL as unknown, the EXISTS
// would fail, and every fact row with a null project would be reported as "should have moved" —
// turning a correct run into a refusal for a reason nobody would guess.
import { withGlobal, withTenants, closePool } from "../db";
import { REASSIGN } from "./reassign-retired";

/** The four tables that reported unique-constraint clashes, with the key each one collides on.
 *  `tenant_id` is part of every key and is added by the query, not listed here.
 *
 *  ⚠ HAND-LISTED ON PURPOSE, which is the opposite of the choice made elsewhere in this cleanup. A
 *  discovered list is right when the risk is MISSING a table (an FK that a new migration adds); it is
 *  wrong when the operation is DELETE, because then discovery means "delete from a table nobody
 *  reviewed". These four are named because a human decided each one holds disposable mock history. */
const HISTORY: { tbl: string; userCol: string; keyCols: string[]; nullableKey: boolean }[] = [
  { tbl: "report_checkins", userCol: "user_id", keyCols: ["checkin_date"], nullableKey: false },
  { tbl: "hr_attendance", userCol: "subject_user_id", keyCols: ["day"], nullableKey: false },
  { tbl: "hr_leave_balances", userCol: "subject_user_id", keyCols: ["year", "leave_type"], nullableKey: false },
  // NULLS NOT DISTINCT on (tenant_id, fact_date, user_id, project_id, unit_node_id).
  { tbl: "report_work_facts", userCol: "user_id", keyCols: ["fact_date", "project_id", "unit_node_id"], nullableKey: true },
];

const MODULES = ["hr", "reports", "pm", "agency"];

export interface PurgeResult {
  dryRun: boolean;
  duplicates: { where: string; rows: number }[];
  /** Rows that are NOT duplicates — the reassignment could still move these. Any of these aborts. */
  movable: { where: string; rows: number }[];
  deleted: number;
}

export async function purgeRetiredHistory(opts: { dryRun: boolean }): Promise<PurgeResult> {
  const out: PurgeResult = { dryRun: opts.dryRun, duplicates: [], movable: [], deleted: 0 };

  const emails = [...Object.keys(REASSIGN), ...new Set(Object.values(REASSIGN))];
  const users = await withGlobal((c) =>
    c.query<{ id: string; email: string }>(`SELECT id, email FROM users WHERE email = ANY($1)`, [emails]),
  );
  const idOf = new Map(users.rows.map((r) => [r.email, r.id]));

  const missingTargets = [...new Set(Object.values(REASSIGN))].filter((t) => !idOf.has(t));
  if (missingTargets.length > 0) {
    // Without the target there is nothing to compare against, so every row would look non-duplicate
    // and the run would abort anyway — but with a confusing message instead of this one.
    throw new Error(`purgeRetiredHistory: target user(s) missing: ${missingTargets.join(", ")}`);
  }

  const companies = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);

  // Pass 1 — CLASSIFY EVERY ROW BEFORE DELETING ANY. Deleting per company as we went would mean an
  // abort partway through had already destroyed rows in earlier companies, and the whole argument for
  // this script is that it does not delete anything it has not proven redundant.
  for (const tenantId of companies) {
    await withTenants(
      [tenantId],
      async (c) => {
        for (const { tbl, userCol, keyCols, nullableKey } of HISTORY) {
          for (const [from, to] of Object.entries(REASSIGN)) {
            const fromId = idOf.get(from);
            const toId = idOf.get(to);
            if (!fromId || !toId) continue;

            const cmp = nullableKey ? "IS NOT DISTINCT FROM" : "=";
            const keyMatch = keyCols.map((k) => `t.${k} ${cmp} r.${k}`).join(" AND ");
            const dupExists = `EXISTS (
              SELECT 1 FROM ${tbl} t
               WHERE t.tenant_id = r.tenant_id AND t.${userCol} = $2 AND ${keyMatch}
            )`;

            const counts = await c.query<{ dup: string; mov: string }>(
              `SELECT
                 count(*) FILTER (WHERE ${dupExists})::text     AS dup,
                 count(*) FILTER (WHERE NOT ${dupExists})::text AS mov
               FROM ${tbl} r WHERE r.${userCol} = $1`,
              [fromId, toId],
            );
            const dup = Number(counts.rows[0].dup);
            const mov = Number(counts.rows[0].mov);
            if (dup > 0) out.duplicates.push({ where: `${tbl}  ${from} -> ${to}`, rows: dup });
            if (mov > 0) out.movable.push({ where: `${tbl}  ${from} -> ${to}`, rows: mov });
          }
        }
      },
      { modules: MODULES },
    );
  }

  if (out.movable.length > 0) {
    const total = out.movable.reduce((n, m) => n + m.rows, 0);
    throw new Error(
      `purgeRetiredHistory: ${total} row(s) are NOT duplicates — the mapped employee does not hold the ` +
        `equivalent row, so the reassignment can still move them. Run seed:reassign-retired first. ` +
        `Refusing to delete history that has somewhere to go: ${out.movable.map((m) => `${m.rows} ${m.where}`).join("; ")}`,
    );
  }

  if (opts.dryRun) return out;

  // Pass 2 — delete, now that every row in scope is proven redundant. The predicate is rebuilt
  // identically rather than reusing collected ids: an id list read in pass 1 could be stale by pass 2,
  // and a DELETE keyed on a stale id list is how the wrong row goes.
  for (const tenantId of companies) {
    await withTenants(
      [tenantId],
      async (c) => {
        for (const { tbl, userCol, keyCols, nullableKey } of HISTORY) {
          for (const [from, to] of Object.entries(REASSIGN)) {
            const fromId = idOf.get(from);
            const toId = idOf.get(to);
            if (!fromId || !toId) continue;
            const cmp = nullableKey ? "IS NOT DISTINCT FROM" : "=";
            const keyMatch = keyCols.map((k) => `t.${k} ${cmp} r.${k}`).join(" AND ");
            const r = await c.query(
              `DELETE FROM ${tbl} r
                WHERE r.${userCol} = $1
                  AND EXISTS (
                    SELECT 1 FROM ${tbl} t
                     WHERE t.tenant_id = r.tenant_id AND t.${userCol} = $2 AND ${keyMatch}
                  )`,
              [fromId, toId],
            );
            out.deleted += r.rowCount ?? 0;
          }
        }
      },
      { modules: MODULES },
    );
  }

  return out;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await purgeRetiredHistory({ dryRun });
  const total = r.duplicates.reduce((n, d) => n + d.rows, 0);

  console.log(`${dryRun ? "WOULD DELETE" : "DELETED"}: ${dryRun ? total : r.deleted} redundant history row(s)`);
  for (const d of r.duplicates) console.log(`  ${String(d.rows).padStart(5)}  ${d.where}`);
  if (dryRun) {
    console.log("\nEvery row above is one the mapped employee ALREADY has an equivalent of — matched on");
    console.log("the table's own UNIQUE key. Nothing here has anywhere left to move.");
    console.log("\nDRY RUN. Re-run with:  npm run seed:purge-retired-history -- --confirm");
  } else if (r.deleted !== total) {
    // Not fatal — a concurrent write between the two passes could legitimately change the count — but
    // it must be visible, because a quiet mismatch is how a partial delete reads as a clean sweep.
    console.log(`\n⚠ classified ${total} but deleted ${r.deleted}. Re-run the dry run to see what is left.`);
  }
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
