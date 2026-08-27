#!/usr/bin/env -S node --import tsx
// WSK-15 — the codegen pipeline's real CLI entrypoint (design §06: "every applySchema ... and
// every vocabulary release ... regenerates artifacts, bumps the contract version per §05 rules,
// stores the bundle in MinIO under the tenant prefix, and emits a contract.published fact").
//
// Usage (see ../../../README.md's WSK-15 section for the full runbook, exact ports, exact env
// var names):
//   APP_DATABASE_URL=postgres://... \
//   STORAGE_ENDPOINT=http://localhost:PORT STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
//     node --import tsx src/codegen/generator/run-codegen.mts --tenant <slug> [--emit-event]
//
// A currently-unwired trigger, by design: nothing in this ticket's scope calls this from
// `schema.apply` (WSK-21's `SchemaService` — out of this ticket's owned files) or from a
// scheduler. Flagged as a follow-up in the ticket report, matching the pattern
// WSK-10/11/12 each already used for their own "not wired into X" gaps.
import pg from "pg";
import { fetchTenantComposition } from "./fetch-composition.mts";
import { buildContractArtifacts } from "./build-artifacts.mts";
import { createGeneratorStorageAdapter, readLatestPointer, publishArtifacts } from "./storage-io.mts";
import type { TenantContractSnapshot } from "../../../../payload/vocabulary/breaking-change.ts";
// Resolved via `cjs-interop.mts` — see storage-io.mts's header comment for why (the `tsx` vs
// `vitest`/Vite CJS/ESM interop mismatch across the module-system boundary this ticket straddles).
import type * as ZoneBEventEmitterNs from "../../events/zoneb-event-emitter.service";
import * as zoneBEventEmitterModule from "../../events/zoneb-event-emitter.service";
import { namedExport } from "./cjs-interop.mts";
const ZoneBEventEmitterService = namedExport<typeof ZoneBEventEmitterNs.ZoneBEventEmitterService>(
  zoneBEventEmitterModule,
  "ZoneBEventEmitterService",
);

function parseArgs(argv: string[]): { tenant: string; emitEvent: boolean } {
  let tenant: string | undefined;
  let emitEvent = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenant") tenant = argv[++i];
    else if (argv[i] === "--emit-event") emitEvent = true;
  }
  if (!tenant) {
    console.error("usage: run-codegen.mts --tenant <slug> [--emit-event]");
    process.exit(2);
  }
  return { tenant, emitEvent };
}

async function main() {
  const { tenant: tenantSlug, emitEvent } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.APP_DATABASE_URL;
  if (!connectionString) {
    console.error("APP_DATABASE_URL is not set — refusing to start (see README's WSK-15 runbook).");
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString });
  const storage = createGeneratorStorageAdapter();

  try {
    const fetched = await fetchTenantComposition(pool, tenantSlug);
    if (!fetched) {
      console.error(`no active tenant found for slug "${tenantSlug}"`);
      process.exitCode = 1;
      return;
    }

    const previousPointer = await readLatestPointer(storage, tenantSlug);
    const previous = previousPointer
      ? { version: previousPointer.contractVersion, snapshot: previousPointer.compositionSnapshot as TenantContractSnapshot }
      : null;

    const built = await buildContractArtifacts({
      tenantSlug: fetched.tenantSlug,
      defaultLocale: fetched.defaultLocale,
      locales: fetched.locales,
      composition: fetched.composition,
      previous,
    });

    const pointer = await publishArtifacts(storage, tenantSlug, built);

    console.log(
      JSON.stringify(
        {
          tenantSlug,
          contractVersion: pointer.contractVersion,
          vocabularyVersion: pointer.vocabularyVersion,
          contentHash: pointer.contentHash,
          generatedAt: pointer.generatedAt,
          versionReasons: built.versionReasons,
          collectionCount: Object.keys(fetched.composition).length,
        },
        null,
        2,
      ),
    );

    if (emitEvent) {
      const emitter = new ZoneBEventEmitterService();
      // Slim projection only (§04: "never the raw blob") — correlators, never artifact bodies.
      await emitter.emit("contract.published", fetched.tenantId, {
        tenantSlug,
        contractVersion: pointer.contractVersion,
        vocabularyVersion: pointer.vocabularyVersion,
        contentHash: pointer.contentHash,
      });
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
