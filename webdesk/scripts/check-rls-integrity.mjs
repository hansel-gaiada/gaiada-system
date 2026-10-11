#!/usr/bin/env node
/**
 * WSK-04 condition 1 — the RLS-integrity gate.
 *
 * WHY THIS EXISTS (WSK-00, reproduced twice — see
 * webdesk/spike-rls/payload/FINDINGS.md addendum):
 *
 *   A Payload dev schema push (`PAYLOAD_ALLOW_PUSH=true` — an ordinary dev boot)
 *   DISABLES row security on a table and DROPS its policy, while leaving
 *   `relforcerowsecurity = true` untouched.
 *
 * That combination is the worst possible one:
 *   - `relrowsecurity = false`  ⇒ RLS is not enforced at all ⇒ EVERY tenant's
 *     rows are readable by EVERY caller. Fail-OPEN, not fail-closed.
 *   - `relforcerowsecurity = true` survives ⇒ the table still LOOKS protected
 *     to any check that inspects only the FORCE flag.
 *
 * During the spike this silently disarmed a table and produced a confident
 * false-positive "jobs leak" several steps later. Nothing raised, nothing
 * logged, health checks green.
 *
 * So this gate asserts THREE facts per tenant-scoped table, not one:
 *   1. relrowsecurity      = true   (RLS actually ENFORCED — the one push turns off)
 *   2. relforcerowsecurity = true   (the table owner is not exempt)
 *   3. at least one policy exists   (forced + zero policies = deny-all: safe but broken)
 *
 * A gate checking only (2) and (3) would have PASSED the disarmed table. That is
 * the specific mistake this file is shaped to prevent.
 *
 * ROLE MODEL (WSK-68). FORCE RLS only holds while nobody who can read the tables bypasses it, so
 * the gate also asserts who may hold BYPASSRLS. Exactly ONE non-superuser role may: `webdesk_backup`,
 * the read-only role the nightly pg_dump uses (owner ruling WSK-D48 (6)), and only while it stays
 * read-only: no table privilege other than SELECT (incl. column-level, and UPDATE on sequences), not
 * a member of any role, rolsuper/rolcreaterole/rolcreatedb/rolreplication all false, and
 * `default_transaction_read_only=on` in its rolconfig. Any other BYPASSRLS role fails the gate.
 * Superusers bypass RLS by definition and are the cluster bootstrap identity, so they are not
 * counted. The role being ABSENT is allowed (a cluster that predates WSK-68), with a printed note.
 *
 * Run:  DATABASE_URL=postgres://... node scripts/check-rls-integrity.mjs
 *       node scripts/check-rls-integrity.mjs --selftest    (no DB needed)
 *
 * Exit 0 = every tenant-scoped table intact. Exit 1 = at least one is not.
 * Belongs in CI after EVERY schema operation, and in the Milestone-0 gate.
 */
import pg from 'pg';

/**
 * A table is "tenant-scoped" if it has a tenant_id column. That is the same
 * heuristic the estate's platform-nest RLS lint uses, and it is deliberately
 * mechanical: a human deciding which tables "need" RLS is how tables get
 * missed. Tables listed here are the known, intentional exceptions.
 */
const EXEMPT = new Set([
  'tenants',              // the tenant registry itself: keyed on id, not tenant_id
  'webdesk_migrations',   // ledger
]);

const SQL_TENANT_TABLES = `
  SELECT c.oid,
         c.relname                                   AS table_name,
         c.relrowsecurity                            AS rls_enabled,
         c.relforcerowsecurity                       AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND EXISTS (
       SELECT 1 FROM pg_attribute a
        WHERE a.attrelid = c.oid
          AND a.attname  = 'tenant_id'
          AND a.attnum > 0
          AND NOT a.attisdropped
     )
   ORDER BY c.relname
`;

export const BACKUP_ROLE = 'webdesk_backup';

/** Every BYPASSRLS role, plus webdesk_backup whether or not it bypasses (its attributes are checked either way). */
const SQL_BYPASS_ROLES = `
  SELECT r.rolname, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
         r.rolbypassrls, r.rolconfig,
         -- ::text[] — node-pg only parses text[]; a name[] arrives as the string '{}' and would silently read as "no memberships".
         ARRAY(SELECT g.rolname::text FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = r.oid ORDER BY g.rolname)::text[] AS memberships
    FROM pg_roles r
   WHERE r.rolbypassrls OR r.rolname = '${BACKUP_ROLE}'
   ORDER BY r.rolname
`;

/**
 * Anything webdesk_backup holds beyond SELECT. has_table_privilege also sees PUBLIC grants; the
 * column probes catch a column-scoped INSERT/UPDATE/REFERENCES; sequences count when UPDATE (nextval)
 * is granted. Only run when the role exists (the has_* functions raise on an unknown role). The
 * relation-generic has_table_privilege is used for sequences too: has_sequence_privilege RAISES on a
 * non-sequence (e.g. a pg_toast table) because the planner may evaluate it before the relkind filter.
 */
const SQL_BACKUP_WRITE_GRANTS = `
  SELECT n.nspname || '.' || c.relname AS object, p.priv AS privilege
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_table_privilege('${BACKUP_ROLE}', c.oid, p.priv)
  UNION ALL
  SELECT n.nspname || '.' || c.relname, 'column ' || p.priv
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   CROSS JOIN (VALUES ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(priv)
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND has_any_column_privilege('${BACKUP_ROLE}', c.oid, p.priv)
  UNION ALL
  SELECT n.nspname || '.' || c.relname, 'sequence UPDATE'
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND c.relkind = 'S'
     AND has_table_privilege('${BACKUP_ROLE}', c.oid, 'UPDATE')
  ORDER BY 1, 2
`;

/**
 * Pure. `roles` = rows of SQL_BYPASS_ROLES; `writeGrants` = rows of SQL_BACKUP_WRITE_GRANTS
 * ({ object, privilege }). Returns { findings, notes }; findings are shaped like evaluate()'s.
 */
export function evaluateRoles(roles, writeGrants = []) {
  const findings = [];
  const notes = [];
  const backup = roles.find((r) => r.rolname === BACKUP_ROLE);

  for (const r of roles) {
    if (r.rolname === BACKUP_ROLE) continue;
    if (r.rolsuper) continue; // bootstrap identity; bypasses RLS by definition
    if (r.rolbypassrls) {
      findings.push({
        table: `role ${r.rolname}`,
        problems: [
          `BYPASSRLS on a non-superuser role other than ${BACKUP_ROLE} — it reads every tenant's rows ` +
            'through FORCE RLS. Only the read-only backup role may hold BYPASSRLS (WSK-D48 (6)).',
        ],
      });
    }
  }

  if (!backup) {
    notes.push(
      `role ${BACKUP_ROLE} is absent (this cluster predates WSK-68) — no BYPASSRLS role present; ` +
        'run webdesk/ops/scripts/ensure-backup-role.sh to create it',
    );
    return { findings, notes };
  }

  const problems = [];
  for (const [flag, label] of [
    ['rolsuper', 'SUPERUSER'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolreplication', 'REPLICATION'],
  ]) {
    if (backup[flag]) problems.push(`${label} — the backup role must be a plain read-only identity`);
  }
  const cfg = Array.isArray(backup.rolconfig) ? backup.rolconfig : [];
  if (!cfg.includes('default_transaction_read_only=on')) {
    problems.push('rolconfig lacks default_transaction_read_only=on (ALTER ROLE ... SET default_transaction_read_only = on)');
  }
  const memberships = Array.isArray(backup.memberships) ? backup.memberships : [];
  if (memberships.length) {
    problems.push(`member of role(s) ${memberships.join(', ')} — SET ROLE would hand it their privileges`);
  }
  for (const g of writeGrants) {
    problems.push(`holds ${g.privilege} on ${g.object} — the backup role may hold SELECT only`);
  }
  if (problems.length) findings.push({ table: `role ${BACKUP_ROLE}`, problems });
  else notes.push(`role ${BACKUP_ROLE} present and read-only (BYPASSRLS=${Boolean(backup.rolbypassrls)})`);
  return { findings, notes };
}

/** Pure, so it can be self-tested without a database. */
export function evaluate(rows, exempt = EXEMPT) {
  const findings = [];
  for (const r of rows) {
    if (exempt.has(r.table_name)) continue;
    const problems = [];
    // Order matters for the human reading the output: the fail-OPEN case first.
    if (!r.rls_enabled) {
      problems.push(
        'RLS DISABLED (relrowsecurity=false) — FAIL-OPEN: every tenant\'s rows are readable by every caller',
      );
    }
    if (!r.rls_forced) {
      problems.push('RLS not FORCED (relforcerowsecurity=false) — the table owner bypasses the policy');
    }
    if (Number(r.policy_count) === 0) {
      problems.push('ZERO policies — with RLS on this denies all access; with RLS off it denies nothing');
    }
    if (problems.length) findings.push({ table: r.table_name, problems });
  }
  return findings;
}

function report(findings, scanned, notes = []) {
  for (const n of notes) console.log(`[rls-integrity] note: ${n}`);
  if (!findings.length) {
    console.log(
      `[rls-integrity] OK — ${scanned} tenant-scoped table(s) intact (enabled + forced + >=1 policy); ` +
        `role model intact (no BYPASSRLS role other than a read-only ${BACKUP_ROLE}).`,
    );
    return 0;
  }
  console.error(`[rls-integrity] FAILED — ${findings.length} finding(s) across ${scanned} tenant-scoped table(s) and the role model:\n`);
  for (const f of findings) {
    console.error(`  ${f.table}`);
    for (const p of f.problems) console.error(`      - ${p}`);
  }
  console.error(
    '\n  For a "role ..." finding: only webdesk_backup may hold BYPASSRLS, and only read-only. Revoke the\n' +
      '  extra grant / drop the extra BYPASSRLS (or re-run webdesk/ops/scripts/ensure-backup-role.sh, which\n' +
      '  REFUSES a widened role rather than silently narrowing it) and find out who widened it.\n' +
      '\n  For a table finding the known historical cause was a Payload dev schema push (Payload is deleted, WSK-48b): it disables row\n' +
      '  security and drops policies while leaving relforcerowsecurity=true, so the table still looks\n' +
      '  protected. Re-apply the policies, then re-run this gate.\n' +
      '  See webdesk/spike-rls/payload/FINDINGS.md (addendum).',
  );
  return 1;
}

/** Proves the gate can actually fail — a check that cannot fail is decoration. */
function selftest() {
  const cases = [
    {
      name: 'intact table passes',
      rows: [{ table_name: 'sites', rls_enabled: true, rls_forced: true, policy_count: 1 }],
      expect: 0,
    },
    {
      name: 'THE REGRESSION: push-disarmed table (rls off, force still true, no policy) is caught',
      rows: [{ table_name: 'pages', rls_enabled: false, rls_forced: true, policy_count: 0 }],
      expect: 1,
    },
    {
      name: 'rls off but policy present is still caught (force-flag-only checks miss this)',
      rows: [{ table_name: 'pages', rls_enabled: false, rls_forced: true, policy_count: 1 }],
      expect: 1,
    },
    {
      name: 'forced but zero policies is caught',
      rows: [{ table_name: 'submissions', rls_enabled: true, rls_forced: true, policy_count: 0 }],
      expect: 1,
    },
    {
      name: 'not forced is caught (owner would bypass)',
      rows: [{ table_name: 'submissions', rls_enabled: true, rls_forced: false, policy_count: 1 }],
      expect: 1,
    },
    {
      name: 'exempt table is skipped',
      rows: [{ table_name: 'tenants', rls_enabled: false, rls_forced: false, policy_count: 0 }],
      expect: 0,
    },
  ];
  let fails = 0;
  for (const c of cases) {
    const got = evaluate(c.rows).length ? 1 : 0;
    const ok = got === c.expect;
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }

  // WSK-68 role-model cases (evaluateRoles). `app` is an ordinary NOBYPASSRLS role: the SQL never
  // returns those, so they are absent from the inputs; `postgres` stands for the bootstrap superuser.
  const base = {
    rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false,
    rolbypassrls: true, rolconfig: ['default_transaction_read_only=on'], memberships: [],
  };
  const backupOk = { rolname: BACKUP_ROLE, ...base };
  const superuser = { rolname: 'postgres', ...base, rolsuper: true };
  const roleCases = [
    { name: 'role model: webdesk_backup present, read-only, BYPASSRLS -> passes (positive case)', roles: [backupOk], grants: [], expect: 0 },
    { name: 'role model: backup role + bootstrap superuser -> passes (superusers are not counted)', roles: [superuser, backupOk], grants: [], expect: 0 },
    { name: 'role model: webdesk_backup ABSENT -> passes with a note (cluster predates WSK-68)', roles: [], grants: [], expect: 0, note: /absent/ },
    { name: 'NEGATIVE CONTROL: a planted second BYPASSRLS role is caught', roles: [backupOk, { rolname: 'planted_bypass', ...base }], grants: [], expect: 1 },
    { name: 'NEGATIVE CONTROL: a lone BYPASSRLS role other than webdesk_backup is caught (backup absent)', roles: [{ rolname: 'planted_bypass', ...base }], grants: [], expect: 1 },
    { name: 'NEGATIVE CONTROL: webdesk_backup granted INSERT on a table is caught', roles: [backupOk], grants: [{ object: 'public.sites', privilege: 'INSERT' }], expect: 1 },
    { name: 'NEGATIVE CONTROL: webdesk_backup with a column-level UPDATE is caught', roles: [backupOk], grants: [{ object: 'public.sites', privilege: 'column UPDATE' }], expect: 1 },
    { name: 'role model: webdesk_backup that is SUPERUSER is caught', roles: [{ ...backupOk, rolsuper: true }], grants: [], expect: 1 },
    { name: 'role model: webdesk_backup with CREATEROLE is caught', roles: [{ ...backupOk, rolcreaterole: true }], grants: [], expect: 1 },
    { name: 'role model: webdesk_backup with CREATEDB is caught', roles: [{ ...backupOk, rolcreatedb: true }], grants: [], expect: 1 },
    { name: 'role model: webdesk_backup with REPLICATION is caught', roles: [{ ...backupOk, rolreplication: true }], grants: [], expect: 1 },
    { name: 'role model: webdesk_backup without default_transaction_read_only=on is caught', roles: [{ ...backupOk, rolconfig: null }], grants: [], expect: 1 },
    { name: 'role model: webdesk_backup that is a member of webdesk_app is caught', roles: [{ ...backupOk, memberships: ['webdesk_app'] }], grants: [], expect: 1 },
  ];
  for (const c of roleCases) {
    const { findings, notes } = evaluateRoles(c.roles, c.grants);
    const ok = (findings.length ? 1 : 0) === c.expect && (!c.note || notes.some((n) => c.note.test(n)));
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  }
  const total = cases.length + roleCases.length;
  console.log(`\n  selftest: ${total - fails} passed, ${fails} failed`);
  return fails === 0 ? 0 : 1;
}

async function main() {
  if (process.argv.includes('--selftest')) process.exit(selftest());

  const url = process.env.DATABASE_URL || process.env.OWNER_DATABASE_URL || process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    console.error('[rls-integrity] no DATABASE_URL / OWNER_DATABASE_URL / MIGRATE_DATABASE_URL set');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(SQL_TENANT_TABLES);
    if (rows.length === 0) {
      // Not a pass. An empty scan means the heuristic found nothing, which on a
      // migrated Zone B database means something is wrong with the connection or
      // the schema — not that everything is safe.
      console.error('[rls-integrity] FAILED — no tenant_id-bearing tables found. Wrong database, or migrations not applied.');
      process.exit(1);
    }
    // Role model (WSK-68): who may bypass the policies we just proved are armed.
    const { rows: roles } = await client.query(SQL_BYPASS_ROLES);
    const hasBackup = roles.some((r) => r.rolname === BACKUP_ROLE);
    const { rows: writeGrants } = hasBackup ? await client.query(SQL_BACKUP_WRITE_GRANTS) : { rows: [] };
    const roleResult = evaluateRoles(roles, writeGrants);
    process.exit(report([...evaluate(rows), ...roleResult.findings], rows.length, roleResult.notes));
  } finally {
    await client.end();
  }
}

// WSK-04 (this ticket, condition 3): guarded like migrations/migrate.mjs's own pattern, so this
// file's `evaluate` export can be imported by another script (scripts/reapply-and-verify-rls.mjs
// does exactly this, to make check-rls-integrity.mjs "the enforcing gate" for the condition-3
// re-apply step, per that ticket's own requirement) WITHOUT also running this CLI's `main()` as
// an unwanted side effect of the import. Direct invocation (`node scripts/check-rls-integrity.mjs
// [--selftest]`) is unchanged.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[rls-integrity] ERROR', err.message);
    process.exit(2);
  });
}
