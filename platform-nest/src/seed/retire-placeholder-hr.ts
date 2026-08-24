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
// ── EVERY COMPANY, NOT JUST THE AGENCY (owner decision 2026-08-24) ────────────────────────────────
// This was agency-only, and the residue was real: `Viceroy Bali` held three placeholder HR files —
// `exec@gaiada.test`, `owner@gaiada-creative.test`, and `gm@sanur-resort.test`, a resort GM persona
// that was never in the agency roster at all — beside one real `@gaiada.com` employee.
//
// I left them, on the grounds that deleting them would strip a company to one employee and no GM with
// nothing to replace them. The owner resolved it: all of this is mock, none of it is operational data,
// and an ERP listing invented employees is the actual problem. Scope is now ALL companies.
//
// ⚠ THE REAL-STAFF TEST HAD TO CHANGE WITH IT, and this is the part to read before touching this
// file. `REAL_EMAILS` comes from the AGENCY roster, so a multi-company sweep measures every company
// against the agency's staff list. That is safe only while no other company has a roster of its own.
// The moment one does — a Viceroy hire, a Bali Catering hire — their HR file would look like a
// placeholder here. The domain half of the test is what stops that being silent today, and a
// per-company roster is what has to replace it then.
//
// ⚠ DRY RUN BY DEFAULT. This deletes rows from an HR table on a live estate; `--confirm` is required.
import { withGlobal, withTenants, closePool } from "../db";
import { STAFF } from "./roster";

/** Real staff are the roster's `@gaiada.com` addresses. Everything else in `employees` is a
 *  placeholder or a seed actor — but the set is computed from the ROSTER rather than from a domain
 *  check alone, so a future real hire on another domain is not silently deleted. */
const REAL_EMAILS = new Set(STAFF.filter((s) => s.level !== "fixture").map((s) => s.email));
const REAL_DOMAIN = "@gaiada.com";

/** A row is a candidate if it is not a known person, OR if it is not a PERSON at all.
 *
 *  Two independent tests, and the second one exists because the first one broke something. Adding the
 *  domain clause (so a future `@viceroybali.com` hire is not deleted by an agency-roster check) also
 *  spares anything sitting on `@gaiada.com` — including `zedano@gaiada.com`, the Hermes orchestrator
 *  whose HR file is the whole reason this script's candidate count was 18 instead of 17. The domain
 *  clause would have quietly restored that bug.
 *
 *  So non-person principals are caught on `users.kind` instead, which is what PK-01 built the
 *  discriminator FOR. That is strictly better than the email heuristic it replaces: an HR file for a
 *  bot, an n8n workflow or a client contact is wrong regardless of its address, and `kind` says so
 *  without guessing from a name or a job title. */
function isPlaceholder(workEmail: string | null, principalKind: string | null): boolean {
  if (principalKind !== null && principalKind !== "employee") return true;
  if (!workEmail) return true; // an HR file with no work email is not a person we can account for
  return !REAL_EMAILS.has(workEmail) && !workEmail.endsWith(REAL_DOMAIN);
}

export interface RetireResult {
  /** Per company, so a partial sweep is visible instead of hidden inside a total. */
  perCompany: { tenantId: string; company: string; candidates: { email: string; name: string }[]; deleted: number }[];
  candidates: { email: string; name: string }[];
  deleted: number;
  dryRun: boolean;
}

export async function retirePlaceholderHr(opts: { dryRun: boolean }): Promise<RetireResult> {
  const companies = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`),
  );
  if (companies.rows.length === 0) {
    throw new Error("retirePlaceholderHr: no companies — refusing to report a clean sweep on no data.");
  }

  const result: RetireResult = { perCompany: [], candidates: [], deleted: 0, dryRun: opts.dryRun };
  let rowsReadAcrossEstate = 0;

  for (const co of companies.rows) {
    // ⚠ `employees` is FORCE RLS *and* module-gated on `hr`. Without `{ modules: ["hr"] }` this reads
    // ZERO rows and reports "nothing to do" — which for a cleanup script is the most dangerous
    // possible false negative, because "0 candidates" looks exactly like success.
    const rows = await withTenants(
      [co.id],
      (c) =>
        c.query<{ id: string; work_email: string | null; display_name: string; principal_kind: string | null }>(
          // LEFT JOIN, not an inner one: an `employees` row whose `user_id` is NULL or dangling is
          // itself a placeholder, and an inner join would drop it from the read entirely — leaving a
          // ghost behind while reporting a clean sweep.
          `SELECT e.id, e.work_email, e.display_name, u.kind AS principal_kind
             FROM employees e
             LEFT JOIN users u ON u.id = e.user_id
            WHERE e.tenant_id = $1
            ORDER BY e.work_email`,
          [co.id],
        ),
      { modules: ["hr"] },
    );
    rowsReadAcrossEstate += rows.rows.length;

    // ⚠ THE refuse-on-empty GUARD MOVED, and dropping it per company was necessary rather than
    // careless. A company with no HR files at all is now an ordinary case — `D & A Syrowatka` has
    // none — so throwing here would abort the sweep on correct data. The guard now applies to the
    // WHOLE RUN (below): zero rows across every company is what a missing module scope looks like,
    // whereas zero rows in one company is just a company with no employees.
    const candidates = rows.rows.filter((r) => isPlaceholder(r.work_email, r.principal_kind));
    const entry = {
      tenantId: co.id,
      company: co.name,
      candidates: candidates.map((r) => ({ email: r.work_email ?? "(no work_email)", name: r.display_name })),
      deleted: 0,
    };

    if (!opts.dryRun && candidates.length > 0) {
      entry.deleted = await withTenants(
        [co.id],
        async (c) => {
          const r = await c.query(`DELETE FROM employees WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [
            co.id,
            candidates.map((x) => x.id),
          ]);
          return r.rowCount ?? 0;
        },
        { modules: ["hr"] },
      );
      // A silent partial delete would leave ghosts behind while reporting success.
      if (entry.deleted !== candidates.length) {
        throw new Error(
          `retirePlaceholderHr: ${co.name} — expected to delete ${candidates.length} row(s) but deleted ` +
            `${entry.deleted}. Refusing to report a clean sweep.`,
        );
      }
    }

    result.perCompany.push(entry);
    result.candidates.push(...entry.candidates);
    result.deleted += entry.deleted;
  }

  if (rowsReadAcrossEstate === 0) {
    throw new Error(
      "retirePlaceholderHr: read ZERO employees rows across EVERY company. That is almost certainly a " +
        "missing module scope rather than an estate with no employees — refusing to report a clean sweep.",
    );
  }

  return result;
}

async function main(): Promise<void> {
  const dryRun = !process.argv.includes("--confirm");
  const r = await retirePlaceholderHr({ dryRun });
  console.log(`${dryRun ? "would remove" : "removed"}: ${r.candidates.length} placeholder HR file(s)`);
  for (const co of r.perCompany) {
    console.log(`  ${co.company} — ${co.candidates.length} candidate(s)`);
    for (const c of co.candidates) console.log(`    - ${c.email}  (${c.name})`);
  }
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
