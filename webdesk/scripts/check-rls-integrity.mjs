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
  'payload_migrations',   // Payload's own ledger
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

function report(findings, scanned) {
  if (!findings.length) {
    console.log(`[rls-integrity] OK — ${scanned} tenant-scoped table(s) intact (enabled + forced + >=1 policy).`);
    return 0;
  }
  console.error(`[rls-integrity] FAILED — ${findings.length} of ${scanned} tenant-scoped table(s) compromised:\n`);
  for (const f of findings) {
    console.error(`  ${f.table}`);
    for (const p of f.problems) console.error(`      - ${p}`);
  }
  console.error(
    '\n  A Payload dev schema push (PAYLOAD_ALLOW_PUSH=true) is the known cause: it disables row\n' +
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
  console.log(`\n  selftest: ${cases.length - fails} passed, ${fails} failed`);
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
    process.exit(report(evaluate(rows), rows.length));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[rls-integrity] ERROR', err.message);
  process.exit(2);
});
