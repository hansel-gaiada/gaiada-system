// Retire the seeded personas as PRINCIPALS, so the ERP stops listing invented people.
//
// ⚠ THIS IS THE STEP THAT ACTUALLY FIXES THE ORIGINAL COMPLAINT, and the earlier ones did not. After
// the reassignment, the HR retirement and the history purge, `employees` held exactly 20 real staff
// and no business row referenced a persona — and `GET /api/:t/users` still returned 38 people, 16 of
// them ghosts. Driving the surface is what found that; every table-level check said the cleanup had
// succeeded, because it had, in the tables those checks looked at.
//
// The people surface reads `company_memberships JOIN users`, and the personas still had memberships
// and `users.kind = 'employee'`. Cleaning HR data was never going to remove them.
//
// ── WHY `users.deleted_at` AND NOT DELETING THE AUTHZ ROWS ────────────────────────────────────────
// The obvious alternative is to delete the 118 remaining identity rows (`user_roles` 69,
// `company_memberships` 19, `org_unit_memberships` 18, `identity_links` 6, `position_assignments` 6).
// This is better on every axis:
//
//   · It is the schema's OWN retirement mechanism. The people query already filters
//     `u.deleted_at IS NULL`, as does every other surface that lists principals, so one column
//     removes them everywhere at once instead of per-surface.
//   · It carries no privilege-change risk. Deleting `user_roles` rows one at a time is a sequence of
//     authorization edits, and a mistake in that sequence is a grant that should not exist.
//   · It cannot break the append-only ledger. `pm_task_assignment_events` still references these
//     users and forbids DELETE, so the `users` rows can never be hard-deleted anyway — 40 rows will
//     always point at them. A soft delete keeps that FK valid and honest: the event still records who
//     it recorded.
//
// The authz rows are deliberately left in place. They are unreachable — a soft-deleted principal
// cannot authenticate, and Cerbos is never asked about one — so deleting them buys nothing and each
// deletion is a chance to remove the wrong row.
//
// ── SCOPE IS AN EXPLICIT ALLOW-LIST, NOT A PATTERN ───────────────────────────────────────────────
// Retiring a principal by matching `%@gaia.test` would work today and would be a live hazard the
// moment someone seeds a real account on a `.test` domain. The targets are the keys of the
// reassignment map — the same seventeen identities whose work was just moved — plus a hard refusal on
// anything at the real company domain, so a bug in that map cannot retire a real employee.
//
// ⚠ DRY RUN BY DEFAULT. This makes people disappear from the ERP; `--confirm` is required.
import { withGlobal, withTenants, closePool } from "../db";
import { REASSIGN } from "./reassign-retired";

const REAL_DOMAIN = "@gaiada.com";

/** Tables checked for leftover ownership before retiring anyone. NOT exhaustive by design — these
 *  are the ones whose presence proves an earlier step did not run. A full FK sweep belongs in
 *  `seed:reassign-retired`, which already does one; duplicating it here would be a second, divergent
 *  implementation of the same census. */
const OWNERSHIP_PROBES: { tbl: string; col: string; modules: string[] }[] = [
  { tbl: "employees", col: "user_id", modules: ["hr"] },
  { tbl: "projects", col: "owner_id", modules: ["agency", "pm"] },
  { tbl: "report_checkins", col: "user_id", modules: ["reports"] },
  { tbl: "hr_attendance", col: "subject_user_id", modules: ["hr"] },
];

export interface RetirePrincipalsResult {
  dryRun: boolean;
  targets: { email: string; name: string; alreadyRetired: boolean }[];
  retired: number;
  /** Rows an earlier step should have handled. Any of these aborts the run. */
  stillOwned: { where: string; email: string; rows: number }[];
}

export async function retirePersonaPrincipals(opts: { dryRun: boolean }): Promise<RetirePrincipalsResult> {
  const out: RetirePrincipalsResult = { dryRun: opts.dryRun, targets: [], retired: 0, stillOwned: [] };

  const emails = Object.keys(REASSIGN);
  const guarded = emails.filter((e) => e.endsWith(REAL_DOMAIN));
  if (guarded.length > 0) {
    // A real address in the retirement list means the reassignment map itself is wrong. Refusing here
    // is the difference between a bad map being a caught error and being a retired employee.
    throw new Error(
      `retirePersonaPrincipals: refusing to retire ${guarded.join(", ")} — these are on ${REAL_DOMAIN}. ` +
        `A real employee in the persona list means REASSIGN is wrong; fix that, not this guard.`,
    );
  }

  const users = await withGlobal((c) =>
    c.query<{ id: string; email: string; name: string; deleted_at: string | null; kind: string }>(
      `SELECT id, email, name, deleted_at, kind FROM users WHERE email = ANY($1)`,
      [emails],
    ),
  );
  if (users.rows.length === 0) {
    throw new Error(
      "retirePersonaPrincipals: found ZERO of the persona accounts. Refusing to report a clean sweep " +
        "on no data — this is what a wrong email list looks like.",
    );
  }

  out.targets = users.rows.map((r) => ({
    email: r.email,
    name: r.name,
    alreadyRetired: r.deleted_at !== null,
  }));

  // ⚠ ORDER MATTERS: prove nothing is still owned BEFORE retiring. Retiring first would hide the
  // evidence — a soft-deleted principal drops out of the surfaces you would use to notice that its
  // work never moved, so the data would be orphaned AND invisible.
  const companies = (
    await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL`))
  ).rows.map((r) => r.id);
  const ids = users.rows.map((r) => r.id);
  const emailOf = new Map(users.rows.map((r) => [r.id, r.email]));

  for (const tenantId of companies) {
    for (const probe of OWNERSHIP_PROBES) {
      const res = await withTenants(
        [tenantId],
        (c) =>
          c.query<{ uid: string; n: string }>(
            `SELECT ${probe.col} AS uid, count(*)::text AS n FROM ${probe.tbl}
              WHERE ${probe.col} = ANY($1::uuid[]) GROUP BY 1`,
            [ids],
          ),
        { modules: probe.modules },
      );
      for (const row of res.rows) {
        out.stillOwned.push({
          where: `${probe.tbl}.${probe.col}`,
          email: emailOf.get(row.uid) ?? row.uid,
          rows: Number(row.n),
        });
      }
    }
  }

  if (out.stillOwned.length > 0) {
    const total = out.stillOwned.reduce((n, s) => n + s.rows, 0);
    throw new Error(
      `retirePersonaPrincipals: ${total} row(s) are still owned by a persona — run seed:reassign-retired, ` +
        `seed:retire-placeholder-hr and seed:purge-retired-history first. Retiring now would orphan them ` +
        `AND hide them: ${out.stillOwned.map((s) => `${s.rows} ${s.where} (${s.email})`).join("; ")}`,
    );
  }

  if (opts.dryRun) return out;

  out.retired = await withGlobal(async (c) => {
    const r = await c.query(
      `UPDATE users SET deleted_at = now(), updated_at = now()
        WHERE email = ANY($1) AND deleted_at IS NULL`,
      [emails],
    );
    return r.rowCount ?? 0;
  });

  return out;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await retirePersonaPrincipals({ dryRun });
  const pending = r.targets.filter((t) => !t.alreadyRetired);

  console.log(`persona accounts found: ${r.targets.length}`);
  console.log(`${dryRun ? "would retire" : "retired"}: ${dryRun ? pending.length : r.retired}`);
  for (const t of pending) console.log(`  - ${t.email}  (${t.name})`);
  const already = r.targets.filter((t) => t.alreadyRetired);
  if (already.length) console.log(`already retired: ${already.length}`);

  if (dryRun) {
    console.log("\nThis sets `users.deleted_at`, the schema's own retirement mechanism. Their authz rows");
    console.log("are left alone deliberately — a soft-deleted principal cannot authenticate, so they are");
    console.log("unreachable, and each deletion would be a chance to remove the wrong row.");
    console.log("\nDRY RUN. Re-run with:  npm run seed:retire-persona-principals -- --confirm");
  }
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
