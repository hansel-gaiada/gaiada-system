#!/usr/bin/env node
// webdesk/scripts/check-determinism-crossmachine.mjs
//
// WSK-18 condition 1 — "determinism double-run + cross-machine ... byte-identical across TWO
// SEPARATELY SPAWNED processes (not one process run twice in-memory), with pinned tool versions
// and canonical JSON."
//
// WSK-15's own `codegen:gate` (double-run-gate.mts) already proves the "two separately spawned
// processes" half — but both processes are spawned as children of the SAME node runtime, on the
// SAME filesystem, inside the SAME container/OS. This script proves the half that gate does not
// cover: byte-identical output across two INDEPENDENT Linux containers (no shared process tree,
// no shared filesystem, no shared env beyond what is explicitly passed), each running its own
// fresh `node`/`tsx`/`openapi-typescript`, with the tool versions actually used recorded and
// compared (not merely assumed pinned because package.json says so).
//
// Uses `webdesk/qa/p3-gate/generate-fixture-artifacts.mts` (this ticket's own file) instead of
// WSK-15's `generate-single.mts`, because the latter requires a live, shared Postgres — which
// would make "two separate machines" actually "two separate machines reading one shared fact",
// a weaker claim. The fixture generator's input is static data baked into the fixture file, so
// determinism here is attributable ONLY to `buildContractArtifacts` (WSK-15's own unmodified
// code) and the pinned toolchain — nothing else can explain a mismatch.
//
// Run for real:
//   node webdesk/scripts/check-determinism-crossmachine.mjs --tenants acme,globex
//     (spawns two throwaway `node:22-bookworm-slim` containers via the Bash tool's docker, see
//     the p3-gate README for the exact commands this script assumes are already prepared, OR
//     run --docker to have this script do it itself)
//   node webdesk/scripts/check-determinism-crossmachine.mjs --docker --tenants acme,globex
//     (this script drives docker itself: two containers, MSYS_NO_PATHCONV-safe docker cp, byte
//     compare, teardown)
//
// Selftest (no docker needed — proves the COMPARE logic itself can fail, per this program's
// "a check that cannot fail is decoration" bar):
//   node webdesk/scripts/check-determinism-crossmachine.mjs --selftest

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const ARTIFACT_FILES = ['openapi.v1.json', 'sdk.d.ts', 'CONTENT-CONTRACT.md', 'hash-manifest.json']

function compareArtifactSets(tenant, dirA, dirB, readFn) {
  const read = readFn ?? ((_side, dir, file) => readFileSync(join(dir, file)))
  const mismatches = []
  for (const file of ARTIFACT_FILES) {
    const a = read('A', dirA, file)
    const b = read('B', dirB, file)
    if (Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0) {
      mismatches.push(`tenant "${tenant}": "${file}" differs between machine A (${a.length} bytes) and machine B (${b.length} bytes)`)
    }
  }
  return mismatches
}

function compareToolVersions(tenant, versionsA, versionsB) {
  const mismatches = []
  const keys = new Set([...Object.keys(versionsA), ...Object.keys(versionsB)])
  for (const k of keys) {
    if (versionsA[k] !== versionsB[k]) {
      mismatches.push(`tenant "${tenant}": tool version "${k}" differs — machine A="${versionsA[k]}" vs machine B="${versionsB[k]}" (NOT pinned identically, even if artifacts happen to match)`)
    }
  }
  return mismatches
}

// ---------------------------------------------------------------------------------------------
// selftest — proves the gate can actually fail, using synthetic bytes (no docker, no generation).
// ---------------------------------------------------------------------------------------------
function selftest() {
  const cases = [
    {
      name: 'byte-identical artifacts across two machines pass',
      readFn: () => 'same-bytes-on-both-sides',
      versionsA: { node: 'v22.9.0', tsx: '4.19.0', 'openapi-typescript': '7.13.0' },
      versionsB: { node: 'v22.9.0', tsx: '4.19.0', 'openapi-typescript': '7.13.0' },
      expectArtifactFails: 0,
      expectVersionFails: 0,
    },
    {
      name: 'THE REGRESSION: a single-byte artifact difference between machines is caught',
      readFn: (side) => (side === 'A' ? 'run-a-body' : 'run-b-BODY'),
      versionsA: { node: 'v22.9.0' },
      versionsB: { node: 'v22.9.0' },
      expectArtifactFails: 4, // every ARTIFACT_FILES entry differs under this scheme
      expectVersionFails: 0,
    },
    {
      name: 'a pinned tool drifting between machines is caught even if bytes still match',
      readFn: () => 'identical-body',
      versionsA: { node: 'v22.9.0', tsx: '4.19.0' },
      versionsB: { node: 'v22.9.0', tsx: '4.20.1' }, // drifted, unpinned
      expectArtifactFails: 0,
      expectVersionFails: 1,
    },
    {
      name: 'a length-only difference (truncation) is caught — Buffer.compare, not === on a coerced type',
      readFn: (side) => (side === 'A' ? 'abcdef' : 'abcde'),
      versionsA: {},
      versionsB: {},
      expectArtifactFails: 4,
      expectVersionFails: 0,
    },
  ]

  let fails = 0
  for (const c of cases) {
    const artifactMismatches = compareArtifactSets('selftest', 'A', 'B', (side) => c.readFn(side))
    const versionMismatches = compareToolVersions('selftest', c.versionsA, c.versionsB)
    const ok = artifactMismatches.length === c.expectArtifactFails && versionMismatches.length === c.expectVersionFails
    if (!ok) fails++
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}  (artifact mismatches=${artifactMismatches.length}, version mismatches=${versionMismatches.length})`)
  }
  console.log(`\n  selftest: ${cases.length - fails} passed, ${fails} failed`)
  return fails === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------------------------
// real cross-machine run
// ---------------------------------------------------------------------------------------------
function sh(cmd, opts = {}) {
  return execFileSync('bash', ['-lc', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts })
}

function dockerRun(cmd) {
  // MSYS_NO_PATHCONV=1 is load-bearing on Windows/Git-Bash — see this repo's
  // docs/...gitbash-docker-path-mangling.md. Harmless on real Linux.
  return sh(`MSYS_NO_PATHCONV=1 ${cmd}`)
}

function runOnFreshContainer(containerName, repoRoot, tenant, outSubdir) {
  dockerRun(`docker rm -f ${containerName} >/dev/null 2>&1 || true`)
  dockerRun(`docker run -d --name ${containerName} -w /work node:22-bookworm-slim sleep 3600`)
  try {
    dockerRun(`docker exec ${containerName} mkdir -p /work/webdesk/api /work/webdesk/payload /work/webdesk/qa`)

    // node_modules is NEVER copied from this (Windows) checkout — esbuild/tsx ship native
    // platform binaries, and a Windows-built node_modules copied verbatim into a Linux container
    // fails with a wrong-platform binary error (confirmed: this script's first real run hit
    // exactly that). Each container installs its OWN node_modules from package.json +
    // package-lock.json, pinned by the lockfile — which is the correct, and honestly stronger,
    // proof: it demonstrates the PINNED VERSIONS (not a copied binary) are what make the two
    // machines agree.
    dockerRun(`docker cp "${repoRoot}/webdesk/api/package.json" ${containerName}:/work/webdesk/api/package.json`)
    dockerRun(`docker cp "${repoRoot}/webdesk/api/package-lock.json" ${containerName}:/work/webdesk/api/package-lock.json`)
    dockerRun(`docker exec -w /work/webdesk/api ${containerName} npm ci --no-audit --no-fund`)

    dockerRun(`docker cp "${repoRoot}/webdesk/api/src" ${containerName}:/work/webdesk/api/src`)
    // payload/package.json (`"type": "module"`) MUST come along with vocabulary/ — Node resolves
    // a bare .ts file's module system (CJS vs ESM) from the NEAREST ancestor package.json, and
    // without this file present the vocabulary's .ts files silently resolve as CommonJS under
    // tsx, producing "does not provide an export named ..." for every named import. Confirmed:
    // this script's first real container run hit exactly that, on Linux only — the Windows smoke
    // run never surfaced it because the real package.json is on disk there.
    dockerRun(`docker cp "${repoRoot}/webdesk/payload/package.json" ${containerName}:/work/webdesk/payload/package.json`)
    dockerRun(`docker cp "${repoRoot}/webdesk/payload/vocabulary" ${containerName}:/work/webdesk/payload/vocabulary`)
    dockerRun(`docker cp "${repoRoot}/webdesk/qa/p3-gate" ${containerName}:/work/webdesk/qa/p3-gate`)
    dockerRun(
      `docker exec -w /work/webdesk/api ${containerName} node --import tsx ../qa/p3-gate/generate-fixture-artifacts.mts --tenant ${tenant} --out /work/out/${tenant}`,
    )
    const localOut = join(outSubdir)
    mkdirSync(localOut, { recursive: true })
    dockerRun(`docker cp ${containerName}:/work/out/${tenant}/. "${localOut}/"`)
  } finally {
    dockerRun(`docker rm -f ${containerName} >/dev/null 2>&1 || true`)
  }
}

async function realRun(tenants, repoRoot) {
  const root = mkdtempSync(join(tmpdir(), 'wsk18-crossmachine-'))
  const allMismatches = []
  try {
    for (const tenant of tenants) {
      const dirA = join(root, tenant, 'machineA')
      const dirB = join(root, tenant, 'machineB')
      console.log(`-- ${tenant}: machine A (container 1, independent node_modules copy) --`)
      runOnFreshContainer(`wsk18-machA-${randomUUID().slice(0, 8)}`, repoRoot, tenant, dirA)
      console.log(`-- ${tenant}: machine B (container 2, independent node_modules copy) --`)
      runOnFreshContainer(`wsk18-machB-${randomUUID().slice(0, 8)}`, repoRoot, tenant, dirB)

      const artifactMismatches = compareArtifactSets(tenant, dirA, dirB)
      const versionsA = JSON.parse(readFileSync(join(dirA, 'tool-versions.json'), 'utf8'))
      const versionsB = JSON.parse(readFileSync(join(dirB, 'tool-versions.json'), 'utf8'))
      const versionMismatches = compareToolVersions(tenant, versionsA, versionsB)

      if (artifactMismatches.length === 0 && versionMismatches.length === 0) {
        console.log(`-- ${tenant}: byte-identical across 2 independent containers (${ARTIFACT_FILES.length} artifacts), tool versions pinned identically: ${JSON.stringify(versionsA)} --`)
      } else {
        allMismatches.push(...artifactMismatches, ...versionMismatches)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  if (allMismatches.length > 0) {
    console.error('CROSS-MACHINE DETERMINISM GATE FAILED:')
    for (const m of allMismatches) console.error(`  - ${m}`)
    return 1
  }
  console.log(`CROSS-MACHINE DETERMINISM GATE PASSED — ${tenants.length} tenant(s), 2 independent containers each.`)
  return 0
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--selftest')) process.exit(selftest())

  const tenantsIdx = argv.indexOf('--tenants')
  const tenants = tenantsIdx >= 0 ? argv[tenantsIdx + 1].split(',').map((t) => t.trim()) : ['acme', 'globex']
  const repoRoot = process.env.WSK18_REPO_ROOT || fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]+$/, '')

  process.exit(await realRun(tenants, repoRoot))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
