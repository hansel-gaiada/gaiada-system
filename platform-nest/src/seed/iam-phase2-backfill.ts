// P2-15 CLI — the operator's entry point for the IAM Phase 2 backfill.
//
//   node dist/seed/iam-phase2-backfill.js <tenantId>                      # dry run (default)
//   node dist/seed/iam-phase2-backfill.js <tenantId> --employees          # apply one piece
//   node dist/seed/iam-phase2-backfill.js <tenantId> --assignments --adoption
//   node dist/seed/iam-phase2-backfill.js --all-tenants                   # dry run, every company
//
// ── DRY RUN IS THE DEFAULT AND CANNOT BE MADE IMPLICIT ───────────────────────────────────────────
// There is no `--apply-everything` and no config file that could turn this into a write by accident.
// Each piece is a separate flag because they carry different risk (adoption is the only one that
// touches authorization), and an operator reviewing one piece at a time is the intended workflow, not
// a degraded one. `--all-tenants` deliberately REFUSES to combine with any apply flag: a blind
// estate-wide write is exactly the shape this ticket exists to avoid.
import { closePool, withGlobal } from "../db";
import { planTenantBackfill, applyTenantBackfill, formatReport } from "../admin/iam-phase2-backfill";

interface Args {
  tenantIds: string[];
  allTenants: boolean;
  employees: boolean;
  assignments: boolean;
  adoption: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const tenantIds = argv.filter((a) => !a.startsWith("--"));
  const unknown = [...flags].filter(
    (f) => !["--employees", "--assignments", "--adoption", "--all-tenants"].includes(f),
  );
  if (unknown.length) {
    // Fail on an unknown flag rather than ignoring it: a typo'd `--adoptions` that silently ran a dry
    // run would read, to the operator, as "adoption did nothing".
    throw new Error(`unknown flag(s): ${unknown.join(", ")}`);
  }
  return {
    tenantIds,
    allTenants: flags.has("--all-tenants"),
    employees: flags.has("--employees"),
    assignments: flags.has("--assignments"),
    adoption: flags.has("--adoption"),
  };
}

async function allCompanyIds(): Promise<string[]> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE deleted_at IS NULL ORDER BY name`),
  );
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const applying = args.employees || args.assignments || args.adoption;

  if (args.allTenants && applying) {
    throw new Error(
      "--all-tenants is dry-run only. Apply one tenant at a time, after reading its report: a blind " +
        "estate-wide write is the shape this ticket exists to avoid.",
    );
  }
  const tenantIds = args.allTenants ? await allCompanyIds() : args.tenantIds;
  if (!tenantIds.length) {
    throw new Error("usage: iam-phase2-backfill <tenantId> [--employees] [--assignments] [--adoption] | --all-tenants");
  }
  if (applying && tenantIds.length > 1) {
    throw new Error("apply targets exactly one tenant per run — pass a single tenantId with the apply flags");
  }

  for (const tenantId of tenantIds) {
    if (!applying) {
      console.log(formatReport(await planTenantBackfill(tenantId)));
      console.log("");
      console.log("DRY RUN — nothing was written. Re-run with --employees / --assignments / --adoption to apply.");
      console.log("");
      continue;
    }
    const pieces = [args.employees && "employees", args.assignments && "assignments", args.adoption && "adoption"]
      .filter(Boolean)
      .join(", ");
    console.log(`APPLYING [${pieces}] to tenant ${tenantId}`);
    const result = await applyTenantBackfill(tenantId, {
      employees: args.employees,
      assignments: args.assignments,
      adoption: args.adoption,
    });
    console.log(formatReport(result.report));
    console.log("");
    console.log(
      `APPLIED — employees ${result.employeesCreated} · assignments ${result.assignmentsCreated} · ` +
        `grants adopted ${result.grantsAdopted} (claims ${result.claimsCreated})`,
    );
    // Printed even on success, because "the count did not move" is the claim this run is making and an
    // operator should see the evidence rather than trust the exit code.
    console.log(`user_roles: ${result.userRolesBefore} before, ${result.userRolesAfter} after — asserted equal.`);
  }
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`[iam-phase2-backfill] ${(err as Error).message}`);
    await closePool().catch(() => undefined);
    process.exit(1);
  });
