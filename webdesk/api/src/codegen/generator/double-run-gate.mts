#!/usr/bin/env -S node --import tsx
// WSK-15 — the determinism CI gate (design §05/§06: "a CI gate that runs codegen twice and fails
// on ANY byte difference"). For each named tenant, spawns `generate-single.mts` as TWO SEPARATE
// `node` child processes (not two in-process calls — see this directory's README for why that
// distinction matters for the "same input twice AND on a second machine/container" AC), then
// byte-compares (Buffer.compare, never string `===`, so an encoding difference cannot hide) every
// determinism-checked artifact. Exits non-zero on ANY mismatch in ANY tenant/file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GENERATE_SINGLE = fileURLToPath(new URL("./generate-single.mts", import.meta.url));
const ARTIFACT_FILES = ["openapi.v1.json", "sdk.d.ts", "CONTENT-CONTRACT.md", "hash-manifest.json"];

function parseArgs(argv: string[]): { tenants: string[] } {
  let tenantsArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tenants") tenantsArg = argv[++i];
  }
  if (!tenantsArg) {
    console.error("usage: double-run-gate.mts --tenants <slugA>,<slugB>,...");
    process.exit(2);
  }
  return { tenants: tenantsArg.split(",").map((t) => t.trim()).filter(Boolean) };
}

function runGenerateSingle(tenant: string, outDir: string): void {
  execFileSync(
    process.execPath,
    ["--import", "tsx", GENERATE_SINGLE, "--tenant", tenant, "--out", outDir],
    { stdio: "inherit", env: process.env },
  );
}

function diffOne(tenant: string, runADir: string, runBDir: string): string[] {
  const mismatches: string[] = [];
  for (const file of ARTIFACT_FILES) {
    const a = readFileSync(join(runADir, file));
    const b = readFileSync(join(runBDir, file));
    if (Buffer.compare(a, b) !== 0) {
      mismatches.push(`tenant "${tenant}": "${file}" differs between run 1 (${a.length} bytes) and run 2 (${b.length} bytes)`);
    }
  }
  return mismatches;
}

async function main() {
  const { tenants } = parseArgs(process.argv.slice(2));
  const root = mkdtempSync(join(tmpdir(), "wsk15-double-run-"));
  const allMismatches: string[] = [];

  try {
    for (const tenant of tenants) {
      const runA = join(root, tenant, "run1");
      const runB = join(root, tenant, "run2");
      console.log(`-- ${tenant}: run 1 (fresh process) --`);
      runGenerateSingle(tenant, runA);
      console.log(`-- ${tenant}: run 2 (fresh process) --`);
      runGenerateSingle(tenant, runB);
      const mismatches = diffOne(tenant, runA, runB);
      if (mismatches.length === 0) {
        console.log(`-- ${tenant}: byte-identical across both runs (${ARTIFACT_FILES.length} artifacts) --`);
      } else {
        allMismatches.push(...mismatches);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (allMismatches.length > 0) {
    console.error("DETERMINISM GATE FAILED:");
    for (const m of allMismatches) console.error(`  - ${m}`);
    process.exit(1);
  }

  console.log(`DETERMINISM GATE PASSED — ${tenants.length} tenant(s), ${ARTIFACT_FILES.length} artifact(s) each, byte-identical.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
