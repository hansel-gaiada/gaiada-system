// GH-01 ops path — seal the GitHub App private keys into the credential vault.
//
// WHY THIS FILE EXISTS: `credential-store.ts` could seal a PEM from the day GH-01 shipped, but
// NOTHING CALLED IT. There was no seed, no admin endpoint, no ops command — so the App credential
// could never reach the database, and every GitHub call failed regardless of deployment. That gap
// is why the repo registry showed nothing after a successful build: the code was deployable and
// non-functional at the same time.
//
// WHY A SEED AND NOT AN ADMIN ENDPOINT: an HTTP endpoint would carry the PEM in a request body,
// which puts the estate's most powerful GitHub credential on the wire and into any request log that
// happens to be verbose. This runs ON the box, reads the PEM from a local file, and seals it
// straight into the vault. The PEM never becomes a request payload and never becomes a log line.
//
// Idempotent: `sealAppCredential` → `createConnection` upserts on
// UNIQUE (tenant_id, owner_kind='github_app', owner_id, provider='github'), so re-running this is
// also the KEY ROTATION runbook — it replaces the sealed PEM rather than duplicating a row.
//
// Usage (on the server, after a deploy):
//   GITHUB_ERP_PEM_FILE=/etc/gaiada/gaiada-erp.private-key.pem \
//   GITHUB_AGENTS_PEM_FILE=/etc/gaiada/gaiada-agents.private-key.pem \
//   DATABASE_URL=... npm run seed:github-apps [-- --company "Gaia Digital Agency"]
//
// Requires, per role, the identifiers already read by config.githubApps[role]:
//   GITHUB_ERP_APP_ID / GITHUB_ERP_INSTALLATION_ID
//   GITHUB_AGENTS_APP_ID / GITHUB_AGENTS_INSTALLATION_ID
// and INTEGRATION_TOKEN_KEY (the vault key — encryptSecret() throws 503 without it, fail-closed).
//
// A role with no PEM file set is SKIPPED, not failed: sealing the erp App alone is a legitimate
// intermediate state (the agents App only matters once mcp-hub is cut over, GH-12).
import fs from "node:fs";
import { withGlobal, closePool } from "../db";
import { sealAppCredential, loadAppCredential } from "../core/github/credential-store";
import { GITHUB_APP_ROLES, GITHUB_APPS, githubAppIdentity, type GithubAppRole } from "../core/github/apps";

/** §2.3(c) / §5.2 ruling: org-wide GitHub credentials belong to the OPERATING COMPANY that owns the
 *  GitHub org — not to a client tenant, whatever client's work passes through them. */
const DEFAULT_COMPANY = "Gaia Digital Agency";

const PEM_ENV: Record<GithubAppRole, string> = {
  erp: "GITHUB_ERP_PEM_FILE",
  agents: "GITHUB_AGENTS_PEM_FILE",
};

async function findTenant(name: string): Promise<string | null> {
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE name = $1 AND deleted_at IS NULL`, [name]),
  );
  return rows[0]?.id ?? null;
}

function readPem(path: string): string {
  const pem = fs.readFileSync(path, "utf8");
  // Fail loudly on a wrong file rather than sealing junk that only fails much later at JWT-signing
  // time, where the error reads as "GitHub rejected our token" instead of "we stored garbage".
  if (!pem.includes("PRIVATE KEY")) {
    throw new Error(`${path} does not look like a PEM private key (no "PRIVATE KEY" marker)`);
  }
  return pem;
}

async function main() {
  const args = process.argv.slice(2);
  const ci = args.indexOf("--company");
  const companyName = ci >= 0 ? args[ci + 1] : DEFAULT_COMPANY;

  const tenantId = await findTenant(companyName);
  if (!tenantId) {
    console.error(`FAIL: company ${JSON.stringify(companyName)} not found. Run the agency seed first.`);
    process.exit(1);
  }
  console.log(`tenant: ${companyName} = ${tenantId}`);

  let sealed = 0;
  let skipped = 0;

  for (const role of GITHUB_APP_ROLES) {
    const def = GITHUB_APPS[role];
    const pemPath = process.env[PEM_ENV[role]];

    if (!pemPath) {
      console.log(`  ${def.slug.padEnd(16)} SKIP — ${PEM_ENV[role]} not set`);
      skipped++;
      continue;
    }

    const identity = githubAppIdentity(role);
    if (!identity) {
      // Deliberately a hard failure, not a skip: a half-configured role (app id without
      // installation id) can mint nothing, and silently skipping it would look like success.
      console.error(
        `  ${def.slug.padEnd(16)} FAIL — a PEM file is set but appId/installationId are not ` +
          `(need both GITHUB_${role.toUpperCase()}_APP_ID and GITHUB_${role.toUpperCase()}_INSTALLATION_ID)`,
      );
      process.exit(1);
    }

    const existing = await loadAppCredential(tenantId, role);
    const pem = readPem(pemPath);

    // Never log the PEM, its length, or any prefix of it — only the path it came from.
    const res = await sealAppCredential(tenantId, role, {
      appId: identity.appId,
      installationId: identity.installationId,
      privateKeyPem: pem,
      createdBy: null,
    });

    console.log(
      `  ${def.slug.padEnd(16)} ${existing ? "ROTATED" : "SEALED "} — connection ${res.id}, ` +
        `app ${identity.appId}, installation ${identity.installationId}, ` +
        `hasToken=${res.hasToken}, readOnly=${def.readOnly}`,
    );
    sealed++;
  }

  console.log(`\ndone: ${sealed} sealed/rotated, ${skipped} skipped.`);
  if (sealed === 0) {
    console.error("NOTHING WAS SEALED — set at least GITHUB_ERP_PEM_FILE, or GitHub stays unconfigured.");
    process.exit(1);
  }
  console.log("Next: npm run seed:github-sync   (populates github_repos; the registry is empty until then)");
}

main()
  .catch((e) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => closePool());
