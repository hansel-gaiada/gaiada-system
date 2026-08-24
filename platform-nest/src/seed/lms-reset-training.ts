// CLI: reset the training tenant between cohorts.
//
// ⚠ THIS DELETES ROWS FROM A LIVE DATABASE. Read `src/modules/lms/training-tenant-reset.ts` before
//   running it — the four structural properties that make it safe are stated there, and the
//   important one is that this command takes NO tenant argument. The company is resolved from
//   `companies.is_training`, of which a partial unique index permits exactly one.
//
// DRY RUN BY DEFAULT, and the confirmation for a real run is not a y/n prompt: `--execute` must be
// accompanied by `--i-have-read-the-plan`. A single flag is one shell-history arrow-up away from
// being run by accident, and this is the one command in the estate where that matters most.
import { closePool } from "../db";
import { planTrainingReset, runTrainingReset } from "../modules/lms/training-tenant-reset";

async function main(): Promise<void> {
  const execute = process.argv.includes("--execute");
  const confirmed = process.argv.includes("--i-have-read-the-plan");
  const cohortArg = process.argv.find((a) => a.startsWith("--cohort="));
  const cohortId = cohortArg ? cohortArg.slice("--cohort=".length) : null;

  const plan = await planTrainingReset(cohortId);
  console.log(`[lms:reset-training] target: ${plan.companyName} (${plan.tenantId})`);
  console.log(`  resolved from companies.is_training — NOT from any argument.`);
  if (cohortId) console.log(`  cohort: ${cohortId}`);
  console.log(`  cohort members still holding access: ${plan.liveMembers}`);
  console.log("\n  Tables in the allow-list, and what is in them right now:");
  let total = 0;
  for (const t of plan.tables) {
    const n = plan.rowCounts[t.tableName] ?? 0;
    total += n;
    console.log(`    ${String(n).padStart(6)}  ${t.tableName.padEnd(24)} scope=${t.moduleScope ?? "—"}`);
  }
  console.log(`    ${String(total).padStart(6)}  TOTAL`);
  console.log(
    "\n  Everything NOT listed above survives: the fake staff, the org chart, the course material " +
    "and every hr_record. That is the baseline, and resetting is not rebuilding.",
  );

  if (!execute) {
    console.log("\n  DRY RUN — nothing deleted. To run it for real:");
    console.log("    npm run lms:reset-training -- --execute --i-have-read-the-plan" +
                (cohortId ? ` --cohort=${cohortId}` : ""));
    await runTrainingReset({ execute: false, cohortId });
    return;
  }
  if (!confirmed) {
    throw new Error(
      "--execute requires --i-have-read-the-plan. Two flags, deliberately: one is an arrow-up away " +
      "from being run by accident, and this command deletes rows from the live database.",
    );
  }

  const r = await runTrainingReset({ execute: true, cohortId });
  console.log(`\n[lms:reset-training] EXECUTED · run ${r.resetRunId}`);
  console.log(`  grants revoked: ${r.grantsRevoked}`);
  for (const t of r.tables) {
    const planned = r.rowCounts[t.tableName] ?? 0;
    const actual = r.deleted[t.tableName] ?? 0;
    // A mismatch is the RLS zero-row trap announcing itself. Planned 400, deleted 0 means the
    // delete ran under a scope that saw nothing — and it would otherwise report as success.
    const flag = planned !== actual ? "  ⚠ PLANNED/ACTUAL MISMATCH" : "";
    console.log(`    ${String(actual).padStart(6)}  ${t.tableName.padEnd(24)} (planned ${planned})${flag}`);
  }
  console.log("\n  Re-seed the baseline before the next cohort starts.");
}

main()
  .then(() => closePool())
  .catch(async (e) => {
    console.error("[lms:reset-training] FAILED:", e instanceof Error ? e.message : e);
    await closePool();
    process.exit(1);
  });
