#!/usr/bin/env node
// WebDesk (Zone B) migration-backfill RLS lint — WSK-01.
//
// Ported from platform-nest/scripts/lint-migration-rls.mjs (its own header carries the full
// audit trail and worked example — read that one for the deep "why"). This is the same
// detector, re-pointed at Zone B's own ledger and its own tenant GUC:
//
// CONFIRMED BUG CLASS this guards against: migrations run as `webdesk_migrator`
// (MIGRATE_DATABASE_URL), which is deliberately NOBYPASSRLS (design §04's owner/migrator/app
// role split). Tables under FORCE ROW LEVEL SECURITY gate every row on the `webdesk.tenant_ctx`
// GUC. During a migration that GUC is unset -> NULL -> the policy's tenant predicate is NULL
// (falsy) for every row. An UPDATE/DELETE against such a table then silently matches ZERO rows
// (no error); an INSERT ... SELECT silently inserts zero rows for the same reason. The
// migration's DDL still commits, the ledger still records the file as applied, and nothing in
// the runner fails. This is the exact platform-nest bug class (their 0050/0051 pair is the
// confirmed real instance) — porting the guard before this ledger ever ships a backfill is
// cheaper than discovering it the way they did.
//
// NOTE ON PLAIN INSERT ... VALUES: not in this bug class — it fails LOUDLY (a WITH CHECK
// violation raises a hard error, rolling back the whole migration transaction). The silent-
// zero-rows mode is specific to statements whose row-set is determined by a SELECT/WHERE
// evaluated under RLS: UPDATE, DELETE, and INSERT ... SELECT. Those are what this lint flags.
//
// WHAT THIS LINT DOES: pure static analysis over migrations/*.sql (no DB connection needed — the
// point is to be loud at AUTHORING time). For every migration file, in ledger (filename) order,
// it tracks:
//   - which tables have had `ALTER TABLE t ... FORCE ROW LEVEL SECURITY` applied, and in which
//     file (including a `FOREACH ... ARRAY[...] LOOP ... EXECUTE format(...)` dynamic-SQL form);
//   - which tables are CREATE TABLE'd in the CURRENT file (zero pre-existing rows by
//     construction — a same-file backfill on such a table is harmless);
//   - whether a `set_config('webdesk.tenant_ctx', ...)` (or `SET LOCAL webdesk.tenant_ctx`) call
//     has appeared EARLIER IN THE SAME FILE than the DML statement under review.
// A finding fires when: the DML statement's target table already carries FORCE ROW LEVEL
// SECURITY (from a strictly-earlier file, OR from an ALTER in THIS file on a table NOT created
// in this file) AND no GUC-setting call appears earlier in the same file.
//
// LIMITATION (same as the platform-nest original, carried honestly): the "GUC appears earlier in
// the file" check is file-scoped, not block/loop-scoped, trading a small false-negative surface
// for zero false-positive noise on the one real-world pattern this exists to catch. A human
// reviewer reading the CI failure (which prints the exact line and surrounding statement) is the
// intended backstop for that residual gap.
//
// BASELINE: none. This ledger has zero applied migrations as of WSK-01 — there is nothing to
// grandfather. Every migration ever added to this directory is fully enforced from file 0001
// onward. (Contrast platform-nest's BASELINE_CUTOFF, which exists only because it had ~50
// already-applied files before the lint was introduced.)

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "migrations");

// The GUC this ledger's FORCE-RLS policies compose on (design §04). Kept as a literal here (not
// read from .env) so the lint has zero runtime dependencies — same posture as the original.
const TENANT_GUC = "webdesk.tenant_ctx";

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
 * Blank out the BODY of every `CREATE [OR REPLACE] FUNCTION|PROCEDURE ... AS $tag$ … $tag$`,
 * replacing it with spaces so every remaining match keeps its original byte offset. A statement
 * inside a function body does not run during the migration — it runs later, under whatever GUC
 * the caller set — so this lint's question does not apply to it.
 *
 * `DO $$ … $$` IS DELIBERATELY NOT BLANKED. A DO block executes immediately, as part of the
 * migration, with exactly the privileges and (missing) GUC this lint is about.
 */
function blankRoutineBodies(text) {
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b[\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)/gi;
  let out = text;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tag = m[1];
    const bodyStart = m.index + m[0].length;
    const bodyEnd = text.indexOf(tag, bodyStart);
    if (bodyEnd === -1) continue; // unterminated — leave it scannable rather than blanking the rest
    const body = out.slice(bodyStart, bodyEnd);
    out = out.slice(0, bodyStart) + body.replace(/[^\n]/g, " ") + out.slice(bodyEnd);
    re.lastIndex = bodyEnd;
  }
  return out;
}

/** Scans one migration file's (comment-stripped) text. See header for the returned shape. */
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

  // Dynamic-loop idiom: FOREACH t IN ARRAY ARRAY['a','b',...] LOOP ... EXECUTE format('ALTER
  // TABLE %I ... FORCE ROW LEVEL SECURITY', t); ... END LOOP. The literal table names never
  // appear next to "FORCE ROW LEVEL SECURITY" in this form, so extract the ARRAY[...] literal's
  // quoted identifiers and, if the loop body contains the phrase at all, treat every one of
  // those tables as force-RLS'd as of the loop's END LOOP position.
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

  const gucPattern = TENANT_GUC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gucRe = new RegExp(
    `set_config\\s*\\(\\s*'${gucPattern}'|SET\\s+LOCAL\\s+${gucPattern}|SET\\s+${gucPattern}`,
    "gi",
  );
  for (const m of text.matchAll(gucRe)) gucEvents.push(m.index);

  const updateRe = /\bUPDATE\s+"?(\w+)"?/gi;
  for (const m of text.matchAll(updateRe)) {
    dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "UPDATE" });
  }
  const deleteRe = /\bDELETE\s+FROM\s+"?(\w+)"?/gi;
  for (const m of text.matchAll(deleteRe)) {
    dmlEvents.push({ table: m[1].toLowerCase(), index: m.index, kind: "DELETE" });
  }
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

/** Core detector: given the ordered list of {file, text} migrations, returns findings. Pure
 * function, no baseline filtering — exercised directly by SELFTEST. */
export function detect(migrations) {
  const findings = [];
  const forceRlsAsOf = new Map();

  migrations.forEach(({ file, text }, fileOrder) => {
    const { createdTables, forceRlsEvents, gucEvents, dmlEvents } = scanFile(text);

    const forceRlsBeforeThisFile = new Set(
      [...forceRlsAsOf.entries()].filter(([, order]) => order < fileOrder).map(([t]) => t),
    );

    for (const dml of dmlEvents) {
      const { table, index, kind } = dml;
      const createdHere = createdTables.has(table);

      let activeAtThisPoint = forceRlsBeforeThisFile.has(table);
      if (!activeAtThisPoint) {
        activeAtThisPoint = forceRlsEvents.some((e) => e.table === table && e.index < index);
      }
      if (!activeAtThisPoint) continue;
      if (createdHere) continue;

      const gucSeenEarlier = gucEvents.some((gi) => gi < index);
      if (gucSeenEarlier) continue;

      findings.push({ file, line: lineOf(text, index), table, kind });
    }

    for (const e of forceRlsEvents) {
      if (!forceRlsAsOf.has(e.table)) forceRlsAsOf.set(e.table, fileOrder);
    }
  });

  return findings;
}

function loadMigrations(dir) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return files.map((file) => ({
    file,
    text: blankRoutineBodies(stripComments(readFileSync(join(dir, file), "utf8"))),
  }));
}

function selftest() {
  let ok = true;
  const report = (label, cond) => {
    console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}`);
    if (!cond) ok = false;
  };

  const unguarded = detect([
    {
      file: "9999_synthetic_unguarded_backfill.sql",
      text: blankRoutineBodies(`
        ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
      `),
    },
    {
      file: "AAAA_synthetic_unguarded_backfill_2.sql",
      text: blankRoutineBodies(`UPDATE widgets SET seen_at = now();`),
    },
  ]);
  report(
    `an UPDATE against an already-FORCE-RLS table with no GUC set is FLAGGED (${unguarded.length} finding(s))`,
    unguarded.length > 0,
  );

  const guarded = detect([
    {
      file: "9999_synthetic_guarded.sql",
      text: blankRoutineBodies(`
        ALTER TABLE widgets ENABLE ROW LEVEL SECURITY;
        ALTER TABLE widgets FORCE ROW LEVEL SECURITY;
      `),
    },
    {
      file: "AAAA_synthetic_guarded_backfill.sql",
      text: blankRoutineBodies(`
        DO $$
        BEGIN
          PERFORM set_config('webdesk.tenant_ctx', 'some-tenant-id', true);
          UPDATE widgets SET seen_at = now();
        END $$;
      `),
    },
  ]);
  report(
    `the same UPDATE, GUC-wrapped first in the same file, is CLEAN (${guarded.length} finding(s))`,
    guarded.length === 0,
  );

  const sameFileCreate = detect([
    {
      file: "9999_synthetic_same_file_create.sql",
      text: blankRoutineBodies(`
        CREATE TABLE gizmos (id uuid PRIMARY KEY);
        ALTER TABLE gizmos ENABLE ROW LEVEL SECURITY;
        ALTER TABLE gizmos FORCE ROW LEVEL SECURITY;
        INSERT INTO gizmos (id) SELECT gen_random_uuid();
      `),
    },
  ]);
  report(
    `an INSERT...SELECT into a table CREATE TABLE'd in the SAME file is CLEAN (zero pre-existing rows) (${sameFileCreate.length} finding(s))`,
    sameFileCreate.length === 0,
  );

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
    `an UPDATE inside a CREATE FUNCTION body is NOT flagged (it never runs at migration time) (${fnBody.length} finding(s))`,
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
    `an UPDATE inside a bare DO block (no GUC) IS still flagged (it executes during the migration) (${doBlock.length} finding(s))`,
    doBlock.length > 0,
  );

  const notForceRls = detect([
    {
      file: "9999_synthetic_no_rls.sql",
      text: blankRoutineBodies(`
        CREATE TABLE plain_lookup (id uuid PRIMARY KEY);
      `),
    },
    {
      file: "AAAA_synthetic_no_rls_update.sql",
      text: blankRoutineBodies(`UPDATE plain_lookup SET id = id;`),
    },
  ]);
  report(
    `an UPDATE against a table that never carries FORCE RLS is CLEAN (${notForceRls.length} finding(s))`,
    notForceRls.length === 0,
  );

  console.log(ok ? "\n[lint-migration-rls] SELFTEST OK" : "\n[lint-migration-rls] SELFTEST FAILED");
  process.exit(ok ? 0 : 1);
}

function main() {
  if (process.env.SELFTEST === "1") return selftest();

  const migrations = loadMigrations(MIGRATIONS_DIR);
  const findings = detect(migrations); // no baseline — nothing applied yet in this ledger

  if (findings.length > 0) {
    console.error(
      `[lint-migration-rls] FAIL: ${findings.length} migration statement(s) write to a ` +
        `FORCE-RLS table without setting ${TENANT_GUC} first in the same file.\n`,
    );
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  ${f.kind} on "${f.table}"`);
    }
    console.error(
      `\nMigrations run as webdesk_migrator (NOBYPASSRLS). Any UPDATE / DELETE / INSERT...SELECT ` +
        `that touches a FORCE-RLS table's EXISTING rows must wrap that statement with ` +
        `PERFORM set_config('${TENANT_GUC}', <tenant>::text, true) per tenant first — see ` +
        "platform-nest's 0051_pm_short_codes_backfill_fix.sql for the reference pattern this " +
        "ports from. If the table was CREATE TABLE'd in this SAME migration, there are zero " +
        "pre-existing rows and this lint won't flag it.",
    );
    process.exit(1);
  }

  console.log(
    `[lint-migration-rls] OK — scanned ${migrations.length} migration(s); no unguarded ` +
      "FORCE-RLS backfills found.",
  );
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (invokedDirectly) main();
