#!/usr/bin/env -S node --import tsx
// WSK-15 — narrow CLI used only by `double-run-gate.mts`. Fetches ONE tenant's real composition
// from Postgres, builds artifacts with `previous: null` ALWAYS (deliberately ignoring any stored
// `latest.json` — the gate's job is proving artifact-BYTE determinism for a given composition
// input, not exercising the live versioning ledger; both runs must therefore land on the same
// baseline `1.0.0` regardless of what has or has not been published before), and writes the four
// determinism-checked files to `--out`. No storage/event I/O — this script never touches MinIO or
// the event bridge.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { fetchTenantComposition } from "./fetch-composition.mts";
import { buildContractArtifacts } from "./build-artifacts.mts";

function parseArgs(argv: string[]): { tenant: string; out: string } {
  let tenant: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") tenant = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
  }
  if (!tenant || !out) {
    console.error("usage: generate-single.mts --tenant <slug> --out <dir>");
    process.exit(2);
  }
  return { tenant, out };
}

async function main() {
  const { tenant: tenantSlug, out } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    console.error("APP_DATABASE_URL is not set.");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const fetched = await fetchTenantComposition(pool, tenantSlug);
    if (!fetched) {
      console.error(`no active tenant found for slug "${tenantSlug}"`);
      process.exit(1);
    }

    const built = await buildContractArtifacts({
      tenantSlug: fetched!.tenantSlug,
      defaultLocale: fetched!.defaultLocale,
      locales: fetched!.locales,
      composition: fetched!.composition,
      previous: null,
    });

    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "openapi.v1.json"), built.openapiJson);
    writeFileSync(join(out, "sdk.d.ts"), built.sdkTs);
    writeFileSync(join(out, "sdk.php"), built.sdkPhp);
    writeFileSync(join(out, "CONTENT-CONTRACT.md"), built.contractMd);
    writeFileSync(join(out, "hash-manifest.json"), built.hashManifestJson);
    console.log(`wrote 5 artifacts to ${out} (contentHash ${built.contentHash})`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
