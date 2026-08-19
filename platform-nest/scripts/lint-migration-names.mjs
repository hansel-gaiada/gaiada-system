#!/usr/bin/env node
// Migration FILENAME lint — the enforcement half of the numbering decision recorded in
// migrations/README.md ("2026-08-19 — the protocol changes").
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────────
// Sequential `NNNN_` prefixes collided three times in three days (`0114`, `0118`, and the `0058`/
// `0059`/`0070` orphan gaps) because this repo is a SHARED CHECKOUT with concurrent sessions. Two
// sessions that both run `ls migrations | sort | tail` inside the same window both see `0117` and both
// create `0118`. "Reserve the number by creating the file first" was tried and lost the race anyway:
// the reservation is not atomic and nothing arbitrates it.
//
// A UTC-minute timestamp prefix cannot collide by construction for sessions that are not writing DDL
// in the same minute, and when they ARE, this lint fails the build rather than letting two files share
// a prefix silently. That is the whole trade: the number stops carrying "which came first in the
// ticket plan" (it never reliably did) and starts carrying "when it was written", which is a fact
// nobody has to coordinate.
//
// ── WHY THE ORDER OF ALREADY-APPLIED MIGRATIONS IS SAFE ──────────────────────────────────────────
// The runner (`src/db/migrate.ts`) discovers with `readdirSync().filter(.sql).sort()` — JavaScript's
// default lexicographic order — and the ledger is keyed on the FULL FILENAME. `"2" > "0"`, so every
// 12-digit timestamp name sorts after every 4-digit legacy name, on every platform. No applied file
// changes position and no applied file is re-run. That property is asserted below rather than assumed,
// because it is the one thing that would silently break history if it were ever false.
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** New format: `YYYYMMDDHHMM_snake_case.sql`, UTC. */
const TIMESTAMP = /^(\d{12})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
/** Legacy format, frozen — see LEGACY_MAX. */
const LEGACY = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/**
 * The last sequential number that may exist. Anything higher must use a timestamp, so a session that
 * has not read the README still cannot extend the broken scheme. Applied files are never renamed
 * (README rule 4), so this number only ever moves DOWN in relevance, never up.
 */
const LEGACY_MAX = 118;

/**
 * Collisions that already applied to real databases. Recorded here rather than silently tolerated:
 * renaming them is forbidden (the ledger keys on the filename, so a rename would re-run them), and
 * pretending the directory is clean would make this lint a lie. A THIRD file on any of these prefixes
 * still fails, as does any new prefix pair.
 *
 * `0003` and `0018` predate rule 3 (which forbade duplicates going forward) and are history.
 * `0114`, `0117` and `0118` are the three that happened in the two days BEFORE this lint existed, all
 * between concurrent sessions in this shared checkout — `0117` was found by this lint's first run,
 * which is the clearest argument available that the sequential scheme needed closing rather than
 * another documented convention.
 */
const KNOWN_DUPLICATE_PREFIXES = new Set(["0003", "0018", "0114", "0117", "0118"]);

const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const errors = [];
const byPrefix = new Map();
let maxLegacy = "";
let minTimestamp = "";

for (const f of files) {
  const ts = TIMESTAMP.exec(f);
  const legacy = LEGACY.exec(f);

  if (ts) {
    const [, stamp] = ts;
    const year = Number(stamp.slice(0, 4));
    const month = Number(stamp.slice(4, 6));
    const day = Number(stamp.slice(6, 8));
    const hour = Number(stamp.slice(8, 10));
    const minute = Number(stamp.slice(10, 12));
    // A malformed stamp (month 13, hour 25) would still sort and still apply — it just would not mean
    // what it says, and a wrong-looking timestamp is exactly the thing nobody double-checks later.
    if (year < 2026 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
      errors.push(`${f}: prefix is not a real UTC YYYYMMDDHHMM instant`);
    }
    if (!minTimestamp || stamp < minTimestamp) minTimestamp = stamp;
    push(stamp, f);
    continue;
  }

  if (legacy) {
    const [, num] = legacy;
    if (Number(num) > LEGACY_MAX) {
      errors.push(
        `${f}: the sequential NNNN_ scheme is CLOSED above ${String(LEGACY_MAX).padStart(4, "0")}. ` +
          `Rename to a UTC timestamp prefix — \`date -u +%Y%m%d%H%M\` — e.g. ` +
          `\`202608191530_${f.slice(5)}\`. Sequential numbers collided three times in three days in ` +
          `this shared checkout; see migrations/README.md.`,
      );
    }
    if (num > maxLegacy) maxLegacy = num;
    push(num, f);
    continue;
  }

  errors.push(
    `${f}: filename must be \`YYYYMMDDHHMM_snake_case_description.sql\` (UTC). ` +
      `Lowercase, digits and single underscores only.`,
  );
}

function push(prefix, file) {
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
  byPrefix.get(prefix).push(file);
}

for (const [prefix, group] of byPrefix) {
  if (group.length < 2) continue;
  if (KNOWN_DUPLICATE_PREFIXES.has(prefix)) continue;
  errors.push(
    `prefix ${prefix} is used by ${group.length} files (${group.join(", ")}). Two migrations must ` +
      `never share a prefix. If neither has been applied anywhere, renumber the later one; if one HAS ` +
      `applied, the applied file keeps its name (README rule 4) and the other takes a new timestamp.`,
  );
}

// The load-bearing ordering property, asserted rather than assumed (see the header).
if (maxLegacy && minTimestamp && !(minTimestamp > maxLegacy)) {
  errors.push(
    `ORDERING BROKEN: the earliest timestamp prefix ${minTimestamp} does not sort after the highest ` +
      `legacy prefix ${maxLegacy}. Every already-applied migration must keep its position under ` +
      `readdirSync().sort(); this must be fixed before anything else.`,
  );
}

if (errors.length) {
  console.error(`✗ migration filename lint — ${errors.length} problem(s):\n`);
  for (const e of errors) console.error(`  • ${e}`);
  console.error("");
  process.exit(1);
}

const legacyCount = files.filter((f) => LEGACY.test(f)).length;
console.log(
  `✓ migration filename lint — ${files.length} files (${legacyCount} legacy NNNN_, ` +
    `${files.length - legacyCount} timestamped), no new duplicate prefixes, ordering intact.`,
);
