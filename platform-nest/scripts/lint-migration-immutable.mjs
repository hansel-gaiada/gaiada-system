#!/usr/bin/env node
// Refuse a change that EDITS a migration already present on the deploy branch.
//
// ── THE FAILURE THIS EXISTS TO CATCH, WHICH REACHED PRODUCTION TWICE ───────────────────────────
// Migrations run ONCE. Editing one that has already been applied changes what a FRESH database
// gets and changes nothing about the estate that already ran it. So:
//
//   fresh databases (every test run, every CI shard)  ->  the corrected code
//   the live estate                                   ->  the original, forever
//
// Nothing in the existing gates can see that. The suites build their schema from the migration
// files, so they exercise the corrected version and pass; live diverges silently. On 2026-08-26 two
// finance functions were found running pre-fix code on the live estate for exactly this reason:
//
//   finance_treasury_reconcile      fixed by editing 202608251830 (467150f4)
//   finance_eliminate_intercompany  fixed by editing 202608251530 (5c16c130)
//
// The first produced a permanently red tie-out — annoying but visible. The second eliminated
// against the WRONG counterparty on a group with more than two members: the consolidated trial
// balance still balanced, still looked like a finished working paper, and was simply wrong in the
// one artefact that goes to a bank. A silently wrong number is the worst thing a gate can miss.
//
// ── WHY GIT HISTORY, AND NOT THE DATABASE ─────────────────────────────────────────────────────
// CI has no route to the production estate, so it cannot compare `pg_proc` to anything. But it does
// not need to: what makes a post-apply edit dangerous is that the file was ALREADY ON THE DEPLOY
// BRANCH, and that is a pure git question. `npm run check:function-drift` does the database-side
// comparison for an operator who can reach an estate; this runs at authoring time, where the fix is
// free.
//
// ⚠ Git history alone is NOT sufficient to identify a divergence after the fact — eleven migrations
// in this repo have been touched by more than one commit, and only two actually diverged, because
// the others were edited before they were ever deployed. This lint is therefore deliberately
// PREVENTIVE (it refuses the edit) rather than diagnostic (it cannot tell you which past edits
// mattered). The drift check answers that question.
//
// ── THE ESCAPE HATCH, AND WHY IT IS NARROW ────────────────────────────────────────────────────
// A comment-only edit is harmless: comments do not change what the database does. Those are
// allowed, because forbidding them would push people to leave migrations undocumented rather than
// to write a new migration. Everything else must be a NEW migration — including a "tiny" fix to a
// function body, which is exactly how both production divergences happened.
import { execFileSync } from "node:child_process";

const BASE = process.env.MIGRATION_BASE_REF || "origin/main";
const DIR = "platform-nest/migrations/";

// ⚠ EVERY git call is anchored to the REPO ROOT with `-C`, and DIR below is root-relative.
//
// Without this the lint is INERT and passes vacuously. `npm run lint:migration-immutable` executes
// with cwd = platform-nest/, and a git pathspec is resolved relative to CWD — so
// `-- platform-nest/migrations/` became `platform-nest/platform-nest/migrations/`, matched nothing,
// and the script cheerfully reported "0 migration file(s) touched; no already-deployed migration had
// its executable SQL changed". A gate that examines zero files always passes.
//
// Found 2026-08-27, one day after this file was written, by noticing it claimed 0 touched files in a
// commit that added three migrations. CI runs it exactly this way (`- run: npm run
// lint:migration-immutable` inside the platform-nest job), so it had never actually guarded a build.
// The OK message now prints the file count for precisely this reason: a gate should say what it
// looked at, or "OK" cannot be told apart from "I looked at nothing".
const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/** Strip SQL comments and collapse whitespace — what remains is what the database will execute. */
function executable(sql) {
  return sql
    .replace(/--[^\n]*/g, " ")           // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")   // block comments
    .replace(/\s+/g, " ")
    .trim();
}

let base;
try {
  base = git("merge-base", "HEAD", BASE).trim();
} catch {
  // No base ref (a shallow clone, or a fork with no upstream). Refusing to run is wrong — this
  // would block every build in that situation — so it passes and says why.
  console.log(`[lint-migration-immutable] SKIPPED — cannot resolve ${BASE}; nothing to compare against.`);
  process.exit(0);
}

const changed = git("diff", "--name-status", `${base}..HEAD`, "--", DIR)
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => {
    const [status, ...rest] = l.split(/\s+/);
    return { status, file: rest[rest.length - 1] };
  });

const violations = [];
for (const { status, file } of changed) {
  // Only MODIFIED files matter. A new migration (A) is the correct thing to do, and a deletion (D)
  // is caught by the ledger lint, not this one.
  if (!status.startsWith("M")) continue;

  // Was it on the deploy branch already? If it arrived in this same change, editing it is fine —
  // nothing has applied it yet.
  let onBase = true;
  try {
    git("cat-file", "-e", `${base}:${file}`);
  } catch {
    onBase = false;
  }
  if (!onBase) continue;

  const before = executable(git("show", `${base}:${file}`));
  const after = executable(git("show", `HEAD:${file}`));
  if (before !== after) violations.push(file);
}

if (violations.length) {
  console.error(
    `\n[lint-migration-immutable] FAIL: ${violations.length} already-deployed migration(s) were edited ` +
      `in a way that changes what the database executes.\n`,
  );
  for (const f of violations) console.error(`  ${f}`);
  console.error(
    "\nMigrations run ONCE. Editing an applied migration changes what a FRESH database gets and " +
      "changes NOTHING about an estate that already ran it — so the fix reaches every test and CI " +
      "shard, passes, and never reaches production. Two finance functions were found live in " +
      "exactly this state on 2026-08-26, one of them silently consolidating against the wrong " +
      "counterparty.\n\n" +
      "Write a NEW migration that re-applies the corrected definition (CREATE OR REPLACE is fine — " +
      "see 202608261900 and 202608261930 for the shape: copy the body VERBATIM, do not retype it).\n\n" +
      "Comment-only edits are permitted and are not reported here — this compares the SQL with " +
      "comments stripped.\n",
  );
  process.exit(1);
}

console.log(
  `[lint-migration-immutable] OK — ${changed.length} migration file(s) touched vs ${BASE}; ` +
    "no already-deployed migration had its executable SQL changed.",
);
