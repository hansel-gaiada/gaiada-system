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
// ── FOUR CATEGORIES, HANDLED DIFFERENTLY, AND THE DIFFERENCE IS THE POINT ─────────────────────────
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
//
// 4. LEFT IN PLACE AND REPORTED — two append-only audit ledgers whose UPDATE the database refuses
//    outright (see IMMUTABLE_HISTORY). This is the one place the "move everything" ruling is not
//    honoured, because honouring it would mean forging an audit trail rather than transferring work.
//    The run prints what it left, so the exception is visible rather than inferred from a total.
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
  // ⚠ ADDED AFTER THE LIVE RUN, AND IT IS THE MOST SERIOUS OMISSION THIS SCRIPT HAD. A
  // `company_memberships` row is WHICH COMPANY a person belongs to, and it carries
  // `primary_role_id` — so moving one would hand a real employee a retired persona's company
  // access and primary role. Exactly the privilege-change-as-data-migration this file's header
  // warns about, and it was in the move set for the whole first live run.
  //
  // Nothing leaked, and that was verified rather than assumed: all 18 rows are still on the
  // retired identities, and no `@gaiada.com` account holds a membership it should not. The only
  // reason is luck — `UNIQUE (tenant_id, user_id)` meant every single move collided, because the
  // real staff already had their memberships. If one target had been missing a membership, the
  // ghost's would have transferred silently and been reported as a success.
  "company_memberships.user_id",
  "org_unit_memberships.user_id",
  "org_unit_memberships.created_by",
  "position_assignments.user_id",
  "position_assignments.assigned_by",
]);

/** Deleted rather than moved — see category 2. */
const DELETE_INSTEAD = new Set(["notifications.user_id"]);

/** Owned by a DIFFERENT script, so this one must not touch it.
 *
 *  A ghost's `employees` row is an HR FILE for a person who never existed. Moving it onto a real
 *  employee would not transfer employment — it would create a SECOND HR file for them, or (because
 *  of `UNIQUE (tenant_id, user_id)`) collide and be reported as an un-movable row forever. The
 *  correct disposal is deletion, which is `seed:retire-placeholder-hr`'s entire job and which that
 *  script does with its own refuse-on-empty-read guard. Two scripts writing the same table by
 *  different rules is how a cleanup ends up half-applied. */
const HANDLED_ELSEWHERE: Record<string, string> = {
  "employees.user_id": "seed:retire-placeholder-hr deletes these",
};

/** Append-only AUDIT LEDGERS. The database refuses UPDATE *and* DELETE on these tables with a
 *  `RAISE EXCEPTION` trigger, so there is no version of this script that can move them.
 *
 *  ⚠ THIS IS A DELIBERATE DEVIATION FROM THE OWNER'S "MOVE EVERYTHING" DECISION, and it is the
 *  right one. An audit ledger row says "at time T, this person changed that assignment". Rewriting
 *  it would not transfer work — it would forge the record of who did what. The schema is stating
 *  that as an invariant, and the correct response is to leave the ledger alone and REPORT what was
 *  left, rather than to strip the trigger. The retired personas therefore remain named in these two
 *  tables, which is honest: those events really were recorded against them.
 *
 *  Censused the same way as MIRRORED, not discovered one failure at a time — every UPDATE trigger on
 *  a users-FK table. Three exist; `service_assignments`'s
 *  `trg_service_assignments_freeze_identity` only freezes provider/target tenant and module_key, so
 *  its four user columns move normally and are absent below. */
const IMMUTABLE_HISTORY = new Set([
  "pm_task_assignment_events.changed_by",
  "pm_task_assignment_events.responsible_id",
  "report_appraisal_acks.actor_user_id",
]);

/** Columns that MIRROR a user id elsewhere in the same row, with a CHECK enforcing the two agree.
 *  Rewriting the FK alone violates the CHECK, so the mirror must move in the SAME statement.
 *
 *  ⚠ THIS IS A CENSUS, NOT A REACTION TO ONE FAILURE. The first `--confirm` run aborted on
 *  `pm_task_assignees_ref_matches_user`. Patching that one table would have left the next mirror to
 *  be discovered the same way — by a failed run against a live estate — so instead the estate was
 *  asked for EVERY check constraint on a users-FK table whose definition mentions the FK column.
 *  Five exist. Four cannot be broken by changing *which* user id is present, because they only
 *  constrain the row's SHAPE and this script never nulls a column:
 *
 *    agent_registry_enabled_requires_evidence   NOT enabled OR (eval_suite AND identity_user_id) NOT NULL
 *    pm_task_assignees_person_user              (assignee_kind = 'person') = (user_id IS NOT NULL)
 *    spcr_decision_is_complete                  status/decided_by/decided_at agree
 *    wcr_portal_has_requester                   portal source implies client_id + requested_by
 *
 *  The fifth is a genuine denormalised mirror and is the entry below:
 *    CHECK (assignee_kind <> 'person' OR assignee_ref = user_id::text)
 *
 *  Value is a SQL fragment appended to the SET list. `$2` is the TARGET user id in both the bulk
 *  and the row-by-row statement, so one fragment serves both. The CASE is not decoration: rows with
 *  `assignee_kind <> 'person'` carry a non-user ref (a team, a placeholder) that must be left alone
 *  — though the sibling `pm_task_assignees_person_user` check means such a row has a NULL user_id
 *  and cannot match our WHERE in the first place. Belt and braces on a live rewrite. */
const MIRRORED: Record<string, string> = {
  // `($2::uuid)::text`, not `$2::text`: the SET list also contains `user_id = $2`, so Postgres
  // deduces uuid there and text here and rejects the whole statement with "inconsistent types
  // deduced for parameter $2". Casting FROM uuid keeps one deduced type across both clauses.
  "pm_task_assignees.user_id":
    "assignee_ref = CASE WHEN assignee_kind = 'person' THEN ($2::uuid)::text ELSE assignee_ref END",
};

const MODULES = [
  "agency", "pm", "it", "billing", "clients", "knowledge", "automation-console", "hr",
  "assistant", "search", "reports", "webdev", "social", "monitoring",
];

export interface ReassignResult {
  dryRun: boolean;
  moved: { where: string; rows: number }[];
  deleted: { where: string; rows: number }[];
  skippedCollisions: { where: string; rows: number }[];
  /** Left in place because the table is an append-only ledger — see IMMUTABLE_HISTORY. Reported so
   *  the deviation from "move everything" is visible in the run output instead of invisible. */
  immutableHistory: { where: string; rows: number }[];
  /** Skipped because another seed owns the disposal — see HANDLED_ELSEWHERE. */
  handledElsewhere: { where: string; rows: number; by: string }[];
  unmapped: string[];
}

/** Collapse per-company rows into one entry per label, preserving first-seen order. */
function sumByLabel<T extends { where: string; rows: number }>(rows: T[]): T[] {
  const byLabel = new Map<string, T>();
  for (const r of rows) {
    const seen = byLabel.get(r.where);
    if (seen) seen.rows += r.rows;
    else byLabel.set(r.where, { ...r });
  }
  return [...byLabel.values()];
}

export async function reassignRetired(opts: { dryRun: boolean }): Promise<ReassignResult> {
  const out: ReassignResult = {
    dryRun: opts.dryRun, moved: [], deleted: [], skippedCollisions: [], immutableHistory: [],
    handledElsewhere: [], unmapped: [],
  };

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

  // ⚠ ONE TENANT PER `withTenants` CALL, NOT THE WHOLE LIST. `lint:withtenants` rejects a
  // multi-tenant argument outside the reconciler, and it is right to: a single call that opens RLS
  // to every company is exactly the shape that cannot be reviewed for scope creep. Passing the list
  // was how this was first written, and CI caught it.
  //
  // The cost is that atomicity is now PER COMPANY rather than across the estate. That is acceptable
  // and arguably better: this script is idempotent and reports what it did, so a failure in one
  // company no longer discards the completed work of the others — which is precisely what happened
  // twice while getting this right. Counts are summed across companies before returning, so the
  // report still reads as one run.
  for (const tenantId of companies) {
    await withTenants(
      [tenantId],
      async (c) => {
        for (const { tbl, col } of fks.rows) {
          const where = `${tbl}.${col}`;
          if (NEVER_MOVE.has(where)) continue;

          if (HANDLED_ELSEWHERE[where]) {
            const ids = [...idOf.entries()].filter(([e]) => e in REASSIGN).map(([, id]) => id);
            const n = await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${tbl} WHERE ${col} = ANY($1::uuid[])`,
              [ids],
            );
            const rows = Number(n.rows[0].n);
            if (rows > 0) out.handledElsewhere.push({ where, rows, by: HANDLED_ELSEWHERE[where] });
            continue;
          }

          if (IMMUTABLE_HISTORY.has(where)) {
            // Counted, not moved. A bare `continue` here would make the ledger rows vanish from the
            // report, and a run that leaves work behind while printing only successes is exactly the
            // failure mode this script is supposed to avoid.
            const ids = [...idOf.entries()].filter(([e]) => e in REASSIGN).map(([, id]) => id);
            const n = await c.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM ${tbl} WHERE ${col} = ANY($1::uuid[])`,
              [ids],
            );
            const rows = Number(n.rows[0].n);
            if (rows > 0) out.immutableHistory.push({ where, rows });
            continue;
          }

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
            //
            // ⚠ ONLY a unique violation is recoverable, and the narrowness is deliberate. A CHECK
            // violation means this column MIRRORS a user id somewhere else in the row (see MIRRORED)
            // and the mirror is not being moved with it. Falling back to row-by-row would "handle"
            // that by skipping every single row and reporting them as un-movable collisions — a
            // cleanup that reports partial success while leaving the work with a person who does not
            // exist. It must abort loudly instead, so the mirror gets added to the map.
            const setList = MIRRORED[where] ? `${col} = $2, ${MIRRORED[where]}` : `${col} = $2`;
            await c.query("SAVEPOINT reassign_bulk");
            try {
              const r = await c.query(`UPDATE ${tbl} SET ${setList} WHERE ${col} = $1`, [fromId, toId]);
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
                  await c.query(`UPDATE ${tbl} SET ${setList} WHERE id = $1`, [row.id, toId]);
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
      // ⚠ NO `crossRoot` HERE, DELIBERATELY. I had passed it "just in case" while writing this. A
      // bypass flag that is unnecessary today is a bypass flag nobody notices becoming load-bearing
      // tomorrow. With one tenant per call it is doubly unnecessary. If this ever needs to cross a
      // root, it SHOULD fail loudly rather than quietly rewrite across a customer boundary.
      { modules: MODULES },
    );
  }

  // Same (table.column, mapping) label can now appear once per company. Summed so the report reads
  // as one run rather than as N partial ones.
  out.moved = sumByLabel(out.moved);
  out.deleted = sumByLabel(out.deleted);
  out.skippedCollisions = sumByLabel(out.skippedCollisions);
  out.immutableHistory = sumByLabel(out.immutableHistory);
  out.handledElsewhere = sumByLabel(out.handledElsewhere.map((h) => ({ where: h.where, rows: h.rows })))
    .map((h) => ({ ...h, by: HANDLED_ELSEWHERE[h.where] ?? "" }));

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
  if (r.immutableHistory.length) {
    const t = total(r.immutableHistory);
    console.log(`LEFT IN PLACE — append-only audit ledger, the DB forbids UPDATE: ${t} row(s)`);
    for (const h of r.immutableHistory) console.log(`  ${String(h.rows).padStart(5)}  ${h.where}`);
    console.log("  These events really were recorded against the retired personas; rewriting them");
    console.log("  would forge the audit trail rather than transfer work.");
  }
  for (const h of r.handledElsewhere) {
    console.log(`SKIPPED — ${h.by}: ${h.rows} row(s)  ${h.where}`);
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
