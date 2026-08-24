// Remove the HR files of people who never existed.
//
// The roster replaced nine invented Balinese names (`@gaia.test`) and kept five `@gaiada-creative.test`
// seed ACTORS. Their `employees` rows — 17 on the live estate, written 2026-08-20 — are still there
// beside the 20 real staff, so every HR surface lists ghosts.
//
// ── WHY DELETE RATHER THAN MARK THEM TERMINATED ───────────────────────────────────────────────────
// `employment_status = 'terminated'` is the honest thing for a real person who left. It is a LIE for
// a person who never worked here: it asserts an employment that ended. It also does not solve the
// problem — HR views legitimately show terminated employees, so the ghosts would remain visible,
// just relabelled.
//
// Deletion is safe here and that was CHECKED, not assumed: no foreign key anywhere references
// `employees` (queried `information_schema` on the live estate — the referencing-table list came back
// empty). If that ever changes, this script will fail on the FK rather than cascade, which is the
// correct direction to fail in.
//
// ── WHY IT WILL NOT TOUCH THE ORG TREE OR MEMBERSHIPS ─────────────────────────────────────────────
// It does not need to. `org_unit_memberships` are DERIVED from the org blob, and
// `diffMembershipSweep` emits a `remove` op (closing `valid_to`) for anyone open in memberships but
// absent from the tree — so `seed:org-structure-refresh` retires the placeholders' memberships on its
// own. Duplicating that here would be a second, divergent implementation of a sweep that already
// works.
//
// ── THE 18TH ROW IS AN AI AGENT, AND IT IS IN SCOPE ───────────────────────────────────────────────
// The live dry run listed 18 candidates, not the 17 ghosts: the extra is `zedano@gaiada.com`,
// "Zedano (Hermes agent)", title "AI Agent". It is caught because the roster has no such person,
// and it SHOULD be caught — an agent principal is not an employee, and an HR file for one makes
// every HR surface list an AI as staff.
//
// Checked before deleting rather than after: its `users` row dates from 2026-07-31 and survives
// untouched (this script only ever writes `employees`); the `employees` row was written 2026-08-20
// by the department seed as a side effect; `agent_registry` holds no row pointing at it; and no
// foreign key anywhere references `employees`. So nothing reads what is being removed.
//
// Noted separately: that `users` row carries `kind = 'employee'`, which is the wrong discriminator
// for an agent principal. Out of scope here — this script does not touch `users` — but it is why
// the agent was indistinguishable from staff in the first place.
//
// ⚠ DRY RUN BY DEFAULT. This deletes rows from an HR table on a live estate; `--confirm` is required.
import { withGlobal, withTenants, closePool } from "../db";
import { STAFF } from "./roster";

const AGENCY_NAME = "Gaia Digital Agency";

/** Real staff are the roster's `@gaiada.com` addresses. Everything else in `employees` for this
 *  tenant is a placeholder or a seed actor — but the set is computed from the ROSTER rather than from
 *  a domain check alone, so a future real hire on another domain is not silently deleted. */
const REAL_EMAILS = new Set(STAFF.filter((s) => s.level !== "fixture").map((s) => s.email));

export interface RetireResult {
  tenantId: string;
  candidates: { email: string; name: string }[];
  deleted: number;
  dryRun: boolean;
}

export async function retirePlaceholderHr(opts: { dryRun: boolean }): Promise<RetireResult> {
  const t = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [AGENCY_NAME]),
  );
  if (!t.rows[0]) throw new Error(`retirePlaceholderHr: no company named "${AGENCY_NAME}"`);
  const tenantId = t.rows[0].id;

  // ⚠ `employees` is FORCE RLS *and* module-gated on `hr`. Without `{ modules: ["hr"] }` this reads
  // ZERO rows and reports "nothing to do" — which for a cleanup script is the most dangerous possible
  // false negative, because "0 candidates" looks like success.
  const rows = await withTenants(
    [tenantId],
    (c) =>
      c.query<{ id: string; work_email: string | null; display_name: string }>(
        `SELECT id, work_email, display_name FROM employees WHERE tenant_id = $1 ORDER BY work_email`,
        [tenantId],
      ),
    { modules: ["hr"] },
  );

  if (rows.rows.length === 0) {
    throw new Error(
      "retirePlaceholderHr: read ZERO employees rows. That is almost certainly a missing module scope " +
        "rather than an empty table — refusing to report a clean sweep on no data.",
    );
  }

  const candidates = rows.rows.filter((r) => !r.work_email || !REAL_EMAILS.has(r.work_email));
  const result: RetireResult = {
    tenantId,
    candidates: candidates.map((r) => ({ email: r.work_email ?? "(no work_email)", name: r.display_name })),
    deleted: 0,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun || candidates.length === 0) return result;

  result.deleted = await withTenants(
    [tenantId],
    async (c) => {
      const r = await c.query(`DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
        tenantId,
        candidates.map((x) => x.id),
      ]);
      return r.rowCount ?? 0;
    },
    { modules: ["hr"] },
  );

  // A silent partial delete would leave ghosts behind while reporting success.
  if (result.deleted !== candidates.length) {
    throw new Error(
      `retirePlaceholderHr: expected to delete ${candidates.length} row(s) but deleted ${result.deleted}. ` +
        `Refusing to report a clean sweep.`,
    );
  }
  return result;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await retirePlaceholderHr({ dryRun });
  console.log(`tenant: ${r.tenantId}`);
  console.log(`${dryRun ? "would remove" : "removed"}: ${r.candidates.length} placeholder HR file(s)`);
  for (const c of r.candidates) console.log(`  - ${c.email}  (${c.name})`);
  if (dryRun) {
    console.log("\nDRY RUN — this deletes rows from an HR table on a live estate.");
    console.log("Re-run with:  npm run seed:retire-placeholder-hr -- --confirm");
  } else {
    console.log(
      "\nTheir org-unit memberships are NOT touched here: those are derived from the org blob and\n" +
        "`seed:org-structure-refresh`'s sweep closes them for anyone absent from the tree.",
    );
  }
  await closePool();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
if (require.main === module) void main();
