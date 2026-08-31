// GH-06 ops path — run the org crawl ONCE, on demand, and print what it did.
//
// WHY THIS FILE EXISTS: `syncGithubRepos()` shipped with only one caller — a bootstrap loop that is
// DARK BY DEFAULT (needs GITHUB_REPO_SYNC_ENABLED + GITHUB_REPO_SYNC_TENANT_ID). So after a deploy
// the registry stays empty, the UI honestly renders an empty state, and there is no way to tell
// "not configured" from "configured but never ran" from "ran and the org really is empty". This
// makes the first crawl an explicit, observable ops action with a printed result.
//
// Safe to re-run: the first call for a tenant is the initial crawl, every later call is the
// reconcile sweep — the same function, per GH-06's design. Upserts are idempotent.
//
// COST WARNING (measured against the live org, 2026-08-31): with detail enabled this is
// ~3-4 API calls PER REPO on top of the list call. At 221 repos that is roughly 650-850 requests
// against a shared installation bucket whose floor is 5,000/hr — about a fifth of the whole
// company's hourly budget in one command. Use --no-detail for a fast identity-only pass when you
// just want to know the crawl works; run the full pass deliberately, not in a loop.
//
// Usage (on the server, AFTER seed:github-apps):
//   DATABASE_URL=... npm run seed:github-sync [-- --company "Gaia Digital Agency"] [--no-detail]
import { withGlobal, closePool } from "../db";
import { syncGithubRepos } from "../core/github/repo-sync.service";
import { loadAppCredential } from "../core/github/credential-store";
import { githubAppIdentity } from "../core/github/apps";

const DEFAULT_COMPANY = "Gaia Digital Agency";

async function findTenant(name: string): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [name]),
  );
  return rows[0]?.id ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--company");
  const companyName = ci >= 0 ? args[ci + 1] : DEFAULT_COMPANY;
  const includeDetail = !args.includes("--no-detail");

  const tenantId = await findTenant(companyName);
  if (!tenantId) {
    console.error(`FAIL: company ${JSON.stringify(companyName)} not found.`);
    process.exit(1);
  }

  // Pre-flight both halves separately, so a failure names WHICH half is missing rather than
  // surfacing as an opaque GitHub error several layers down.
  const identity = githubAppIdentity("erp");
  if (!identity) {
    console.error("FAIL: GITHUB_ERP_APP_ID / GITHUB_ERP_INSTALLATION_ID not set — nothing can be minted.");
    process.exit(1);
  }
  const cred = await loadAppCredential(tenantId, "erp");
  if (!cred) {
    console.error(
      `FAIL: no sealed credential for tenant ${tenantId}. Run: npm run seed:github-apps\n` +
        "       (the identifiers are configured, but the private key was never sealed into the vault)",
    );
    process.exit(1);
  }

  console.log(`tenant:  ${companyName} = ${tenantId}`);
  console.log(`app:     ${identity.appId} / installation ${identity.installationId}`);
  console.log(`detail:  ${includeDetail ? "ON (~3-4 extra calls per repo)" : "OFF (identity only)"}`);
  console.log("crawling...\n");

  const started = Date.now();
  const r = await syncGithubRepos({ tenantId, role: "erp", includeDetail });
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`orgs seen:    ${r.orgsSeen.join(", ") || "(none)"}`);
  console.log(`fetched:      ${r.fetched}`);
  console.log(`inserted:     ${r.inserted}`);
  console.log(`updated:      ${r.updated}`);
  console.log(`soft-deleted: ${r.softDeleted}`);
  console.log(`synced at:    ${r.syncedAt}   (${secs}s)`);

  if (r.warnings.length) {
    // Warnings are per-repo sub-fetch failures that degraded to null rather than aborting the
    // crawl. They are NOT fatal, but a silent pile of them means the registry is quietly partial.
    console.log(`\nwarnings (${r.warnings.length}) — these rows are PARTIAL, not wrong:`);
    for (const w of r.warnings.slice(0, 20)) console.log(`  - ${w}`);
    if (r.warnings.length > 20) console.log(`  ... and ${r.warnings.length - 20} more`);
  }

  if (r.fetched === 0) {
    console.error(
      "\nFETCHED ZERO REPOS. That is almost certainly a configuration fault, not an empty org:\n" +
        "  - is the App installed on the org, with 'All repositories'?\n" +
        "  - does the installation id match the App id?\n" +
        "GH-06 deliberately SKIPS the soft-delete pass on a zero-repo result, so the registry was\n" +
        "not emptied by this run.",
    );
    process.exit(1);
  }

  console.log(`\ndone. The registry should now show ${r.fetched} repos at /systems/github.`);
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => closePool());
