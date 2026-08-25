#!/usr/bin/env node
// Asserts that ci.yml's sharded `platform-nest` matrix still covers the WHOLE suite.
//
// WHY THIS IS A GATE AND NOT A COMMENT. Sharding is the one CI change whose failure mode is
// invisible: if the shards stop covering the whole suite, the pipeline gets FASTER and STAYS GREEN
// while testing less. Nothing goes red, and there is no output to notice.
//
// WHAT IS ACTUALLY AT RISK. Vitest assigns shards by slicing the (hash-sorted) file list:
//   shardSize = ceil(files / count); slice(shardSize * (index - 1), shardSize * index)
// Those slices are contiguous and non-overlapping, and slices 1..count together span the whole
// list. So full coverage follows from ONE property: the matrix must be exactly the integers
// 1..count, where count is the denominator in `--shard=N/count`. Those two values live in two
// different places in ci.yml and are edited by hand, which is the realistic bug:
//
//   * a fifth entry added to `shard: [1, 2, 3, 4]` while the flag still says /4 — shard 5/4 slices
//     past the end of the list, runs nothing, and a quarter of the suite is dropped;
//   * the denominator bumped to /5 without extending the matrix — shard 5's files run nowhere.
//
// Both look harmless in review. Both are caught here.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It does not re-derive the file->shard assignment to prove the
// partition empirically. `vitest list` IGNORES `--shard` (verified against vitest 2.1.9: all four
// shards listed all 427 files), so it cannot serve as an oracle, and the only honest oracle —
// `vitest run` — means running the suite four times. Reimplementing the slice algorithm here would
// be worse than nothing: a local copy keeps agreeing with itself after vitest changes, which is
// exactly the case it would exist to catch. The algorithm's behaviour was instead verified by hand
// (8 files, `vitest run --shard=i/4` -> 2 + 2 + 2 + 2 = 8, no overlap) and is pinned by the vitest
// version in package-lock.json.
//
// Runs in nest-static-gates: pure file parsing, no vitest, no database, milliseconds.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CI_YML = join(HERE, "..", "..", ".github", "workflows", "ci.yml");

function fail(msg) {
  console.error(`check-shards: ${msg}`);
  process.exit(1);
}

const ci = readFileSync(CI_YML, "utf8");

// Parsed with regexes rather than a YAML dependency: these are two specific lines and platform-nest
// has no yaml package. Both patterns are anchored tightly enough that a miss fails loudly rather
// than silently matching something else.
const matrixMatch = ci.match(/^\s*shard:\s*\[([0-9,\s]+)\]\s*$/m);
if (!matrixMatch) fail("could not find the `shard: [...]` matrix in ci.yml — was the job renamed or unsharded?");

const flagMatch = ci.match(/--shard=\$\{\{\s*matrix\.shard\s*\}\}\/(\d+)/);
if (!flagMatch) fail("could not find the `--shard=${{ matrix.shard }}/N` flag in ci.yml");

const matrix = matrixMatch[1].split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
const count = Number(flagMatch[1]);
const expected = Array.from({ length: count }, (_, i) => i + 1);

if (matrix.length !== expected.length || matrix.some((v, i) => v !== expected[i])) {
  fail(
    `the shard matrix and the --shard denominator disagree, so part of the suite would not run.\n` +
      `  matrix in ci.yml:      [${matrix.join(", ")}]\n` +
      `  --shard=.../${count} implies: [${expected.join(", ")}]\n` +
      `  Fix BOTH: the matrix list must be exactly 1..${count}.`,
  );
}

console.log(`check-shards: OK — matrix [${matrix.join(", ")}] matches --shard=N/${count}; the ${count} shards span the suite.`);
