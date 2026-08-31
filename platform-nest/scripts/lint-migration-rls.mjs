#!/usr/bin/env node
// Migration-backfill RLS lint (senior-db estate-wide audit, 2026-07-30).
//
// CONFIRMED BUG CLASS this guards against: migrations run as `platform_owner`
// (MIGRATE_DATABASE_URL), which deliberately does NOT have BYPASSRLS (DB-topology role split,
// db-topology-roles memory, verified live: rolbypassrls=false). Tables under FORCE ROW LEVEL
// SECURITY gate every row on `tenant_id = ANY(app_current_tenants())`, reading the
// `app.current_tenant_ids` GUC. During a migration that GUC is unset -> NULL -> the policy's
// `= ANY(NULL)` is NULL (falsy) for every row. An UPDATE/DELETE against such a table then
// silently matches ZERO rows (no error — the WHERE clause is just AND'd with an always-false
// USING policy); an INSERT ... SELECT silently inserts zero rows for the same reason (the SELECT
// sub-query sees nothing). The migration's DDL still commits, the ledger still records the file
// as applied, and NOTHING in the runner or the CI test suite fails. Confirmed real instance:
// 0050_pm_short_codes.sql shipped, ran clean, and left every project's short_code NULL; fixed by
// 0051_pm_short_codes_backfill_fix.sql, which wraps the backfill per-tenant with
// `PERFORM set_config('app.current_tenant_ids', <company id>::text, true)` before touching rows
// (SET LOCAL semantics — scoped to the migration's own transaction, same mechanism
// src/db/index.ts `withTenants` uses for every ordinary request). See
// docs/superpowers/plans/2026-07-30-migration-backfill-rls-audit.md for the full audit.
//
// NOTE ON PLAIN INSERT ... VALUES: this WAS excluded, on the reasoning that a literal-values INSERT
// against a FORCE-RLS table fails LOUDLY (a WITH CHECK violation raises, rolling back the migration)
// and that "migrate.ts surfaces that as a startup/CI failure". The second half of that reasoning is
// FALSE in this repository, and it cost a live deploy on 2026-08-26.
//
// ★ CI RUNS MIGRATIONS AS A SUPERUSER, WHICH BYPASSES RLS. So a plain INSERT into a FORCE-RLS table
// is loud on the LIVE estate and completely silent in CI. `202608261100_activity_approval_
// attribution.sql` ended with a self-assertion block that INSERTed two probe rows to prove its new
// CHECK constraints reject; every shard passed, and the deploy of alpha-01.071.0172a then aborted
// with "new row violates row-level security policy for table activities". The failure mode is not
// "silent zero rows" — it is "green in every place you look, red in the only place that counts".
//
// So plain INSERT ... VALUES is now flagged too, under its own later cutoff (INSERT_VALUES_CUTOFF)
// because the older enforced migrations were written against the previous rule and cannot be edited
// (README rule 4). The two kinds are reported distinctly: UPDATE/DELETE/INSERT..SELECT fail SILENTLY
// and are the original bug class; INSERT..VALUES fails LOUDLY BUT ONLY ON LIVE.
//
// WHAT THIS LINT DOES: pure static analysis over migrations/*.sql (no DB connection needed — the
// whole point is to be loud at AUTHORING time, before a test DB or CI Postgres service is even
// available). For every migration file, in ledger (filename) order, it tracks:
//   - which tables have had `ALTER TABLE t ... FORCE ROW LEVEL SECURITY` applied, and in which
//     file (including the EXECUTE-wrapped dynamic-SQL form 0010_outbox_events.sql uses — matched
//     as a plain substring, since the literal SQL text is still present either way);
//   - which tables are CREATE TABLE'd in the CURRENT file (zero pre-existing rows by
//     construction — a same-file backfill on such a table is harmless no matter what, per the
//     audit's "tables created by that same migration" carve-out);
//   - whether a `set_config('app.current_tenant_ids', ...)` (or `SET LOCAL app.current_tenant_ids`)
//     call has appeared EARLIER IN THE SAME FILE than the DML statement under review.
// A finding fires when: the DML statement's target table already carries FORCE ROW LEVEL SECURITY
// (from a strictly-earlier file, OR from an ALTER in THIS file on a table NOT created in this
// file) AND no GUC-setting call appears earlier in the same file.
//
// LIMITATION (documented honestly, same spirit as lint-withtenants.mjs's own header): the
// "GUC appears earlier in the file" check is file-scoped, not block/loop-scoped. A migration that
// sets the GUC once for table A's backfill and then runs a SECOND, unguarded backfill against
// table B later in the same file would not be re-flagged for B, because a `set_config` call of
// ANY kind earlier in the file satisfies the heuristic. This trades a small false-negative surface
// for zero false-positive noise on the real 0051 pattern (one GUC-setting statement per DO-block
// iteration, backfills for multiple tables in sequence inside the SAME loop body — see 0051's own
// two DO blocks, each with its own FOR co IN ... LOOP). Tightening this to be loop-scoped would
// need a real SQL parser; a human reviewer reading the CI failure (which prints the exact line and
// surrounding statement) is the intended backstop for that residual gap, not a false sense of
// completeness from the tool. If this ever proves too permissive in practice, tighten it then.
//
// BASELINE: migrations already applied to a live database can never be edited (README rule 4), so
// everything on the ledger AS OF this lint's introduction is grandfathered — including
// 0050_pm_short_codes.sql, the one CONFIRMED violation, whose fix already shipped as a follow-up
// (0051), not an edit. Enforcement is for every migration filename added AFTER the baseline cutoff
// below. Run with SELFTEST=1 to prove the detector actually flags 0050's real content and clears
// 0051/0012/0024/0026's (see the audit doc for why each of those is CLEAR or a harmless no-op).

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");

// Frozen at the moment this lint was introduced (2026-07-30, WD-31 migration-backfill-rls audit).
// Every filename lexically <= this cutoff is grandfathered (already applied to real databases,
// rule 4 forbids editing them). New migrations sort after it and are fully enforced.
const BASELINE_CUTOFF = "0051_pm_short_codes_backfill_fix.sql";

// A SECOND, later cutoff for the INSERT ... VALUES rule only.
//
// That rule was added on 2026-08-26, after ~137 migrations had already been written and applied
// under the previous rule that deliberately permitted a bare INSERT. Those files cannot be edited
// (README rule 4), so enforcing the new rule over them would make this lint permanently red and
// therefore ignored — the worst outcome for a gate. Everything lexically at or below this cutoff is
// exempt from the INSERT..VALUES check ONLY; the original silent-no-op checks still apply to it.
const INSERT_VALUES_CUTOFF = "202608261100_activity_approval_attribution.sql";

function stripComments(raw) {
  const noLineComments = raw
    .split("\n")
    .map((l) => {
      const idx = l.indexOf("--");
      return idx >= 0 ? l.slice(0, idx) : l;
    })
    .join("\n");
  return noLineComments.replace(/\/\*[\s\S]*?\*\//g, "");
}

function lineOf(src, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (src[i] === "\n") line++;
  return line;
}

/**
 * Blank out the BODY of every `CREATE [OR REPLACE] FUNCTION|PROCEDURE ... AS $tag$ … $tag$`, replacing
 * it with spaces so every remaining match keeps its original byte offset (the whole scanner is
 * offset-ordered — see `detect`).
 *
 * ── WHY THIS IS NOT A WEAKENING (2026-08-19) ──────────────────────────────────────────────────────
 * This lint asks one question: "does this MIGRATION, running as platform_owner with no tenant GUC,
 * silently no-op against a FORCE-RLS table?" A statement inside a function body does not run during the
 * migration at all — `CREATE FUNCTION` only stores its text. It runs later, when something calls it,
 * under THAT caller's tenant context (or, for SECURITY DEFINER, deliberately as the owner). So the
 * question this lint asks is not applicable to those statements, and flagging them was a false positive.
 *
 * Found by `0119_monitoring_heartbeat_touch.sql` (MON-13), whose three UPDATEs are all inside a
 * SECURITY DEFINER function that exists precisely BECAUSE the unauthenticated heartbeat endpoint has no
 * tenant context. The lint was telling that migration to set a GUC for statements it does not execute.
 *
 * ⚠ `DO $$ … $$` IS DELIBERATELY NOT BLANKED. A DO block executes immediately, as part of the
 * migration, with exactly the privileges and (missing) GUC this lint is about — it is the single most
 * likely place to hide a real unguarded backfill. Only stored-routine bodies are skipped, and the
 * regex requires the `FUNCTION`/`PROCEDURE` keyword to reach them.
 *
 * A SECURITY DEFINER function is its own review surface (a deliberate RLS bypass, reviewed as such),
 * not something this filename-and-offset scanner can reason about. Skipping it here says "out of
 * scope", never "safe".
 */
function blankRoutineBodies(text) {
  // `AS $tag$ … $tag$` where the statement began with CREATE … FUNCTION/PROCEDURE. The tag is captured
  // so a body containing a DIFFERENT dollar-quote (nested `$inner$`) cannot terminate it early.
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)/gi;
  let out = text;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1];
    const bodyStart = m.index + m[0].length;
    const bodyEnd = text.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue; // unterminated — leave it scannable rather than blanking the rest
    // Replace with spaces, preserving newlines so `lineOf()` still reports the true line number of
    // anything AFTER the body.
    const body = out.slice(bodyStart, bodyEnd);
    out = out.slice(0, bodyStart) + body.replace(/[^\n]/g, " ") + out.slice(bodyEnd);
    re.lastIndex = bodyEnd;
  }
  return out;
}

/** Scans one migration file's (comment-stripped) text and returns:
 *   - createdTables: Set<string> of tables CREATE TABLE'd in this file
 *   - forceRlsEvents: [{ table, index }] in the order ALTER ... FORCE ROW LEVEL SECURITY appears
 *   - gucEvents: [index] positions where the tenant GUC is set
 *   - dmlEvents: [{ table, index, line, kind, snippet }] for UPDATE / DELETE FROM / INSERT INTO
 *     ... SELECT statements (the silently-no-opable shapes; plain INSERT ... VALUES is excluded
 *     per the header note — it fails loudly instead of silently).
 */
function scanFile(text) {
  const createdTables = new Set();
  const forceRlsEvents = [];
  const gucEvents = [];
  const dmlEvents = [];

  const createRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi;
  for (const m of text.matchAll(createRe)) createdTables.add(m[1].toLowerCase());

  const forceRe = /\bALTER\s+TABLE\s+"?(\w+)"?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi;
  for (const m of text.matchAll(forceRe)) {
    forceRlsEvents.push({ table: m[1].toLowerCase(), index: m.index });
  }

  // The dynamic-loop idiom used throughout this ledger (0001_core.sql's D5 setup, 0018_pm.sql,
  // etc.): `FOREACH t IN ARRAY ARRAY['a','b',...] LOOP ... EXECUTE format('ALTER TABLE %I ...
  // FORCE ROW LEVEL SECURITY', t); ... END LOOP`. The literal table names never appear next to
  // the literal words "FORCE ROW LEVEL SECURITY" in this form (it's built via format(%I) at
  // runtime), so the plain regex above misses every table onboarded this way -- which is most of
  // them. Extract the ARRAY[...] literal's quoted identifiers and, if the loop body (up to the
  // first END LOOP) contains the FORCE ROW LEVEL SECURITY phrase at all, treat every one of those
  // tables as force-RLS'd as of this loop's END LOOP position.
  const foreachRe = /\bFOREACH\s+\w+\s+IN\s+ARRAY\s+ARRAY\s*\[([^\]]*)\][\s\S]*?\bLOOP\b([\s\S]*?)\bEND\s+LOOP\b/gi;
  for (const m of text.matchAll(foreachRe)) {
    const [, arrayLiteral, body] = m;
    if (!/FORCE\s+ROW\s+LEVEL\s+SECURITY/i.test(body)) continue;
    const endLoopIndex = m.index + m[0].length;
    const idRe = /'([a-zA-Z_][a-zA-Z0-9_]*)'/g;
    for (const idm of arrayLiteral.matchAll(idRe)) {
      forceRlsEvents.push({ table: idm[1].toLowerCase(), index: endLoopIndex });
    }
  }

  const gucRe = /set_config\s*\(\s*'app\.current_tenant_ids'|SET\s+LOCAL\s+app\.current_tenant_ids|SET\s+app\.current_tenant_ids/gi;
  for (const m of text.matchAll(gucRe)) gucEvents.push(m.index);

  // UPDATE <table> ... (statement-leading form; matches both bare `UPDATE t` and `UPDATE t AS x`)
  const updateRe = /\bUPDATE\s+"?(\w+)"?/gi;
  for (const m of text.matchAll(updateRe)) {
    dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "UPDATE" });
  }
  // DELETE FROM <table>
  const deleteRe = /\bDELETE\s+FROM\s+"?(\w+)"?/gi;
  for (const m of text.matchAll(deleteRe)) {
    dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "DELETE" });
  }
  // INSERT INTO <table> ... SELECT (only the SELECT-sourced form is in the silent-no-op class —
  // require a SELECT keyword to appear before the next semicolon-ish statement boundary).
  const insertRe = /\bINSERT\s+INTO\s+"?(\w+)"?\s*(\([^)]*\))?\s*/gi;
  for (const m of text.matchAll(insertRe)) {
    const tail = text.slice(m.index, m.index + 2000);
    const stmtEnd = tail.search(/;/);
    const stmt = stmtEnd >= 0 ? tail.slice(0, stmtEnd) : tail;
    const selectAt = stmt.search(/\bSELECT\b/i);
    const valuesAt = stmt.search(/\bVALUES\b/i);
    if (selectAt >= 0 && !(valuesAt >= 0 && valuesAt < selectAt)) {
      dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "INSERT...SELECT" });
    } else if (valuesAt >= 0) {
      // The literal-values form. Loud on live, invisible in CI (superuser bypasses RLS) — see the
      // header. Reported as its own kind so the message can say WHICH failure it prevents.
      dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "INSERT...VALUES" });
    }
  }

  return { createdTables, forceRlsEvents, gucEvents, dmlEvents };
}

/** Core detector: given the ordered list of {file, text} migrations, returns findings:
 *  [{ file, line, table, kind }]. Pure function, no baseline filtering — callers apply the
 *  baseline cutoff themselves so this can be exercised directly in SELFTEST mode against files
 *  that are normally grandfathered. */
export function detect(migrations) {
  const findings = [];
  // table -> file index (order) where FORCE ROW LEVEL SECURITY was first applied
  const forceRlsAsOf = new Map();

  migrations.forEach(({ file, text }, fileOrder) => {
    const { createdTables, forceRlsEvents, gucEvents, dmlEvents } = scanFile(text);

    // Tables that become FORCE-RLS strictly BEFORE this file (already active at file start).
    const forceRlsBeforeThisFile = new Set(
      [...forceRlsAsOf.entries()].filter(([, order]) => order < fileOrder).map(([t]) => t),
    );

    for (const dml of dmlEvents) {
      const { table, index, kind } = dml;
      const createdHere = createdTables.has(table);

      // Is this table FORCE-RLS *at the point of this statement*?
      let activeAtThisPoint = forceRlsBeforeThisFile.has(table);
      if (!activeAtThisPoint) {
        // Or forced earlier IN THIS SAME FILE, before this statement's position?
        activeAtThisPoint = forceRlsEvents.some((e) => e.table === table && e.index < index);
      }
      if (!activeAtThisPoint) continue; // table isn't FORCE-RLS yet — DML is safe DDL-adjacent work
      if (createdHere) continue; // fresh table this same file -> zero pre-existing rows, harmless

      const gucSeenEarlier = gucEvents.some((gi) => gi < index);
      if (gucSeenEarlier) continue; // heuristic pass — see LIMITATION note in the header

      findings.push({ file, line: lineOf(text, index), table, kind });
    }

    // Record this file's FORCE RLS grants for subsequent files.
    for (const e of forceRlsEvents) {
      if (!forceRlsAsOf.has(e.table)) forceRlsAsOf.set(e.table, fileOrder);
    }
  });

  return findings;
}

function loadMigrations(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return files.map((file) => ({
    file,
    // Comments out first, then stored-routine BODIES blanked: a statement inside a CREATE FUNCTION
    // body does not execute during the migration, so this lint's question does not apply to it. DO
    // blocks are NOT blanked — see blankRoutineBodies.
    text: blankRoutineBodies(stripComments(readFileSync(join(dir, file), "utf8"))),
  }));
}

function selftest() {
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const findings = detect(migrations); // NO baseline filtering — exercise the real ledger raw

  const on0050 = findings.filter((f) => f.file === "0050_pm_short_codes.sql");
  const on0051 = findings.filter((f) => f.file === "0051_pm_short_codes_backfill_fix.sql");
  const on0012 = findings.filter((f) => f.file === "0012_outbox_hlc.sql");
  const on0024 = findings.filter((f) => f.file === "0024_module_backfill.sql");
  const on0026 = findings.filter((f) => f.file === "0026_service_layer.sql");

  let ok = true;
  const report = (label, cond) => {
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
    if (!cond) ok = false;
  };

  report(
    `0050_pm_short_codes.sql (the CONFIRMED bug) is flagged (${on0050.length} finding(s): ${on0050.map((f) => `${f.table}@L${f.line}`).join(", ")})`,
    on0050.length > 0,
  );
  report(
    `0051_pm_short_codes_backfill_fix.sql (the fix, per-tenant GUC wrapped) is CLEAN`,
    on0051.length === 0,
  );
  report(
    `0012_outbox_hlc.sql (FORCE-RLS table, no GUC, but table just created by 0010 with 0 rows -- ` +
      `still flagged by this heuristic since it doesn't do cross-file "was it actually empty" ` +
      `reasoning, only cross-file FORCE-RLS timing; documented as a known conservative ` +
      `over-flag -- see audit doc) is flagged: ${on0012.length > 0}`,
    on0012.length > 0,
  );
  report(`0024_module_backfill.sql (companies, not FORCE-RLS at all) is CLEAN`, on0024.length === 0);

  // 2026-08-19 — the function-body distinction, pinned in BOTH directions on synthetic input so it
  // cannot regress into either a false positive or a real miss.
  const fnBody = detect([
    {
      file: "9999_synthetic_function_body.sql",
      text: blankRoutineBodies(
        `ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
         ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
         CREATE OR REPLACE FUNCTION touch_widget(p uuid) RETURNS void LANGUAGE plpgsql AS $$
         BEGIN
           UPDATE widgets SET seen_at = now() WHERE id = p;
         END $$;`,
      ),
    },
  ]);
  report(
    `an UPDATE inside a CREATE FUNCTION body is NOT flagged (it never runs at migration time) ` +
      `-- got ${fnBody.length} finding(s)`,
    fnBody.length === 0,
  );

  const doBlock = detect([
    {
      file: "9999_synthetic_do_block.sql",
      text: blankRoutineBodies(
        `ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
         ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
         DO $$
         BEGIN
           UPDATE widgets SET seen_at = now();
         END $$;`,
      ),
    },
  ]);
  report(
    `an UPDATE inside a DO block IS still flagged (it executes during the migration) ` +
      `-- got ${doBlock.length} finding(s)`,
    doBlock.length > 0,
  );
  report(`0026_service_layer.sql (roles, not FORCE-RLS at all) is CLEAN`, on0026.length === 0);

  console.log(ok ? "\n[lint-migration-rls] SELFTEST OK" : "\n[lint-migration-rls] SELFTEST FAILED");
  process.exit(ok ? 0 : 1);
}

function main() {
  if (process.env.SELFTEST === "1") return selftest();

  const migrations = loadMigrations(MIGRATIONS_DIR);
  const allFindings = detect(migrations);

  // Baseline: grandfather everything at/under the cutoff (already applied, rule 4 forbids edits).
  const findings = allFindings.filter(
    (f) =>
      f.file > BASELINE_CUTOFF
      // The INSERT..VALUES rule is newer than the lint itself and carries its own, later cutoff.
      && (f.kind !== "INSERT...VALUES" || f.file > INSERT_VALUES_CUTOFF),
  );

  if (findings.length > 0) {
    console.error(
      `[lint-migration-rls] FAIL: ${findings.length} new migration statement(s) write to a ` +
        `FORCE-RLS table without setting app.current_tenant_ids first in the same file.\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.kind} on "${f.table}"`);
    }
    console.error(
      "\nMigrations run as platform_owner / platform_app (NOBYPASSRLS) -- see " +
        "docs/superpowers/plans/2026-07-30-migration-backfill-rls-audit.md.\n\n" +
        "  UPDATE / DELETE / INSERT...SELECT  fail SILENTLY. The row-set is decided by a WHERE or " +
        "SELECT evaluated under RLS, so with no GUC set they match ZERO rows and report success -- " +
        "a backfill that did nothing looks exactly like one that had nothing to do.\n\n" +
        "  INSERT...VALUES  fails LOUDLY, but ONLY on the live estate. CI runs migrations as a " +
        "SUPERUSER, which BYPASSES RLS, so the statement inserts happily in every test and shard " +
        "and then aborts the DEPLOY with 'new row violates row-level security policy'. This kind " +
        "was added 2026-08-26 after exactly that cost a release (202608261100, whose self-assertion " +
        "block probed two CHECK constraints by inserting into a FORCE-RLS table).\n\n" +
        "FIX (both kinds): wrap the statement with `PERFORM set_config('app.current_tenant_ids', " +
        "<tenant>::text, true)` per tenant first -- see 0051_pm_short_codes_backfill_fix.sql for the " +
        "reference pattern. For a module-owned table add `PERFORM set_config('app.scopes', " +
        "'<module>', true)` as well; either GUC unset fails the policy on its own.\n\n" +
        "DO NOT 'fix' an INSERT...VALUES probe by widening its EXCEPTION handler to swallow the RLS " +
        "error. The row is then rejected by the POLICY and never reaches the CHECK the probe exists " +
        "to exercise, so the assertion passes while proving nothing.\n\n" +
        "If the table was CREATE TABLE'd in this SAME migration, there are zero pre-existing rows " +
        "and this lint won't flag it -- if you believe this IS such a case and it's still flagging, " +
        "check the CREATE TABLE regex actually matched your table name.",
    );
    process.exit(1);
  }

  console.log(
    `[lint-migration-rls] OK -- scanned ${migrations.length} migrations ` +
      `(${migrations.length - migrations.filter((m) => m.file > BASELINE_CUTOFF).length} baselined, ` +
      `${migrations.filter((m) => m.file > BASELINE_CUTOFF).length} enforced); no unguarded ` +
      `FORCE-RLS backfills found.`,
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) main();
