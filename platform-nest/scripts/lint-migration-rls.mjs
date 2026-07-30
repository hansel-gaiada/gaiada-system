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
// NOTE ON PLAIN INSERT ... VALUES: a literal-values INSERT against a FORCE-RLS table without the
// GUC set is NOT in this bug class — it fails LOUDLY (a WITH CHECK violation raises a hard error,
// rolling back the whole migration transaction; migrate.ts surfaces that as a startup/CI failure).
// The silent-zero-rows failure mode is specific to statements whose row-set is determined by a
// SELECT/WHERE evaluated under RLS: UPDATE, DELETE, and INSERT ... SELECT. Those are what this
// lint flags; a bare `INSERT INTO t (...) VALUES (...)` is left alone.
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
    if (/\bSELECT\b/i.test(stmt) && !/\bVALUES\b/i.test(stmt.slice(0, stmt.search(/\bSELECT\b/i)))) {
      dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "INSERT...SELECT" });
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
    text: stripComments(readFileSync(join(dir, file), "utf8")),
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
  report(`0026_service_layer.sql (roles, not FORCE-RLS at all) is CLEAN`, on0026.length === 0);

  console.log(ok ? "\n[lint-migration-rls] SELFTEST OK" : "\n[lint-migration-rls] SELFTEST FAILED");
  process.exit(ok ? 0 : 1);
}

function main() {
  if (process.env.SELFTEST === "1") return selftest();

  const migrations = loadMigrations(MIGRATIONS_DIR);
  const allFindings = detect(migrations);

  // Baseline: grandfather everything at/under the cutoff (already applied, rule 4 forbids edits).
  const findings = allFindings.filter((f) => f.file > BASELINE_CUTOFF);

  if (findings.length > 0) {
    console.error(
      `[lint-migration-rls] FAIL: ${findings.length} new migration statement(s) write to a ` +
        `FORCE-RLS table without setting app.current_tenant_ids first in the same file.\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.kind} on "${f.table}"`);
    }
    console.error(
      "\nMigrations run as platform_owner (NOBYPASSRLS) -- see " +
        "docs/superpowers/plans/2026-07-30-migration-backfill-rls-audit.md. Any UPDATE / DELETE / " +
        "INSERT...SELECT that touches a FORCE-RLS table's EXISTING rows must wrap that statement " +
        "with `PERFORM set_config('app.current_tenant_ids', <tenant>::text, true)` per tenant first " +
        "-- see 0051_pm_short_codes_backfill_fix.sql for the reference pattern. If the table was " +
        "CREATE TABLE'd in this SAME migration, there are zero pre-existing rows and this lint " +
        "won't flag it -- if you believe this IS such a case and it's still flagging, check the " +
        "CREATE TABLE regex actually matched your table name.",
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

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
