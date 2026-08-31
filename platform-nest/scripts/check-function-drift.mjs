#!/usr/bin/env node
// Compare the functions an ESTATE is actually running against what the migrations define.
//
// ── WHY THIS IS SEPARATE FROM THE LINT ────────────────────────────────────────────────────────
// `lint:migration-immutable` prevents the cause (editing an applied migration) at authoring time,
// from git alone, which is all CI can see. This answers the other question — "is any estate ALREADY
// diverged?" — and needs a database, so it is an operator tool rather than a CI gate.
//
// Both are necessary. The lint cannot tell you which past edits mattered: eleven migrations in this
// repo have been touched by more than one commit, and only TWO had actually diverged, because the
// rest were edited before they were ever deployed. Only the database knows which.
//
// ── WHAT IT FOUND THE FIRST TIME IT RAN (2026-08-26) ──────────────────────────────────────────
//   90 functions defined in migrations and present on live
//   88 identical
//    2 DIVERGED — finance_treasury_reconcile, finance_eliminate_intercompany
//
// Both had been fixed by editing an already-applied migration. Every test and CI shard passed on
// the corrected code; production had been running the original for weeks. The second one silently
// eliminated against the wrong counterparty in a consolidated trial balance.
//
// ── USAGE ─────────────────────────────────────────────────────────────────────────────────────
//   DATABASE_URL=postgres://... node scripts/check-function-drift.mjs
//
// Point it at whichever estate you want to audit. It READS ONLY — no DDL, no writes, safe against
// production. Exit 1 on any divergence so it can be wired into a deploy pipeline as a post-deploy
// assertion, which is the natural place for it: after migrations run, live should match the repo by
// definition, and anything that does not is a bug worth stopping on.
//
// ⚠ COMPARISON IS ON THE FUNCTION BODY, whitespace-normalised. That is deliberate: reformatting is
// not divergence, but a changed default, a changed WHERE clause or a changed sign is. It does NOT
// compare argument lists or return types — a signature change forces a new function anyway, and
// Postgres would keep both.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("check-function-drift: DATABASE_URL is required — point it at the estate to audit.");
  process.exit(2);
}

/** The definition each function would END UP with if every migration ran in filename order. */
function definitionsFromMigrations() {
  const defs = new Map();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)\s*\(/gi;
    let m;
    while ((m = re.exec(sql))) {
      const rest = sql.slice(re.lastIndex);
      // The body is the first $$-delimited block after the signature. Functions in this repo all
      // use $$; a dollar-tagged variant ($fn$) would need widening here, and would show up as a
      // MISSED function rather than a false positive.
      const a = rest.indexOf("$$");
      if (a < 0) continue;
      const b = rest.indexOf("$$", a + 2);
      if (b < 0) continue;
      // Last definition wins — later migrations legitimately CREATE OR REPLACE earlier ones.
      defs.set(m[1], { file, body: rest.slice(a + 2, b) });
    }
  }
  return defs;
}

const norm = (s) => createHash("md5").update(s.replace(/\s+/g, " ").trim()).digest("hex");

const client = new pg.Client({ connectionString: url });
await client.connect();
const { rows } = await client.query(
  `SELECT p.proname, p.prosrc
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'`,
);
await client.end();

const live = new Map(rows.map((r) => [r.proname, norm(r.prosrc)]));
const defs = definitionsFromMigrations();

const diverged = [];
let matched = 0;
let absent = 0;
for (const [name, { file, body }] of [...defs].sort()) {
  if (!live.has(name)) { absent++; continue; }
  if (live.get(name) === norm(body)) matched++;
  else diverged.push({ name, file });
}

console.log(`check-function-drift: ${defs.size} function(s) defined across the migrations`);
console.log(`  present on this estate and IDENTICAL : ${matched}`);
console.log(`  present and DIVERGED                 : ${diverged.length}`);
// Not an error. A function may be defined in a migration this estate has not reached yet, and
// reporting that as drift would make the check cry wolf on any estate mid-rollout.
console.log(`  defined but not present here         : ${absent}  (migrations not yet applied here)`);

if (diverged.length) {
  console.error("\nDIVERGED — this estate is running code the migrations do not describe:\n");
  for (const d of diverged) console.error(`  ${d.name}   (last defined in ${d.file})`);
  console.error(
    "\nThe usual cause is a migration that was EDITED after it had already been applied. The fix " +
      "reaches every fresh database and never reaches this one. Write a new migration re-applying " +
      "the corrected definition, copying the body verbatim — see 202608261900 and 202608261930.\n",
  );
  process.exit(1);
}
console.log("\nNo drift: every function this estate runs matches what the migrations define.");
