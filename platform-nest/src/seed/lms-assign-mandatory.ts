// CLI: enrol every active employee in every published mandatory path.
//
// DRY RUN BY DEFAULT. Pass `--execute` to write. A runner that enrols 23 people the first time
// somebody types its name is a runner people learn to be afraid of; one that prints exactly what it
// would do is one they will actually run before an audit.
//
// The sweep itself is `src/modules/lms/mandatory-assignment.ts` — this file is only the mouth.
import { closePool, withGlobal } from "../db";
import { runMandatoryAssignment } from "../modules/lms/mandatory-assignment";

const AGENCY_NAME = "Gaia Digital Agency";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const nameArg = process.argv.find((a) => a.startsWith("--company="));
  const companyName = nameArg ? nameArg.slice("--company=".length) : AGENCY_NAME;

  const company = await withGlobal((c) =>
    c.query<{ id: string; enabled_modules: string[] }>(
      `SELECT id, enabled_modules FROM companies WHERE name = $1 AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
      [companyName],
    ),
  );
  const tenantId = company.rows[0]?.id;
  if (!tenantId) throw new Error(`company not found: ${companyName}`);
  // Both scopes, both checked. Without `lms` the enrolment INSERTs write nothing; without `hr` the
  // employee SELECT returns nothing and the run reports "0 employees, nothing to do" — which is
  // indistinguishable from a fully-enrolled company. Refuse rather than report that.
  for (const mod of ["lms", "hr"]) {
    if (!company.rows[0].enabled_modules.includes(mod)) {
      throw new Error(
        `the '${mod}' module is NOT enabled for ${companyName}. The sweep would read or write zero ` +
        `rows and report success. Enable it in Settings → Modules first.`,
      );
    }
  }

  const r = await runMandatoryAssignment(tenantId, { dryRun: !execute });
  console.log(`[lms:assign-mandatory] ${companyName} · ${r.dryRun ? "DRY RUN" : "EXECUTED"}`);
  console.log(`  employees in scope: ${r.activeEmployees} (active + on_leave)`);
  if (r.unlinkedEmployees.length) {
    // Named, never a count. An employee with no `users` row cannot hold an enrolment at all, so
    // they are a real hole in coverage — and a hole reported as a number is one nobody closes.
    console.log(
      `  ⚠ ${r.unlinkedEmployees.length} employee(s) have NO user account and CANNOT be enrolled:\n` +
      r.unlinkedEmployees.map((n) => `      - ${n}`).join("\n"),
    );
  }
  if (!r.paths.length) {
    console.log("  no published mandatory paths — nothing to assign. Run `npm run seed:lms-general-track` first.");
  }
  for (const p of r.paths) {
    console.log(
      `  ${p.pathKey} (${p.appliesTo}, due in ${p.dueDays ?? "—"} days): ` +
      `${p.toEnrol.length} to enrol · ${p.alreadyEnrolled} open · ${p.completedOrWaived} completed/waived`,
    );
  }
  console.log(r.dryRun
    ? `\n  Nothing was written. Re-run with --execute to enrol ${r.paths.reduce((n, p) => n + p.toEnrol.length, 0)} person-path(s).`
    : `\n  Enrolled: ${r.enrolled}`);
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error("[lms:assign-mandatory] FAILED:", e instanceof Error ? e.message : e);
    await closePool();
    process.exit(1);
  });
