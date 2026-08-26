#!/usr/bin/env node
/**
 * WSK-04 condition 3 — the mandatory re-apply step, WITH the enforcing gate.
 *
 * DECISION (condition 3): Option B — "push forbidden against any real database plus a mandatory
 * re-apply step" (see webdesk/payload/src/reapply-tenant-rls.mjs's header for the full reasoning
 * on why Option A — a migration that reapplies policies — is the weaker choice here). This script
 * is that mandatory step, formalized as a single command instead of a convention someone has to
 * remember:
 *
 *   1. Runs the generic reapply routine (webdesk/payload/src/reapply-tenant-rls.mjs) against
 *      every tenant_id-bearing table Payload may have disarmed.
 *   2. Immediately re-queries live catalog state and runs it through
 *      webdesk/scripts/check-rls-integrity.mjs's OWN `evaluate()` — the exact function the
 *      standalone CI gate uses — so this script cannot report success by any path that the CI
 *      gate itself would not also accept. There is exactly one definition of "intact," reused by
 *      both the fixer and the checker.
 *
 * This is meant to run:
 *   - immediately after ANY Payload dev schema push (superseding the pages-only, hand-coded
 *     block at the end of webdesk/payload/scripts/setup-schema.mjs — see this ticket's report
 *     for why that file was not edited directly and what change it still needs);
 *   - as a required step in CI / the Milestone-0 gate, after every schema operation, per
 *     webdesk-design.md §12's WSK-04 row and the FINDINGS.md addendum's own instruction
 *     ("Run it after EVERY schema operation, and in the M0 gate").
 *
 * Usage:  OWNER_URI=postgres://webdesk_owner:...@host:port/webdesk \
 *         node scripts/reapply-and-verify-rls.mjs
 *
 * Exit 0 = reapplied cleanly AND the gate confirms every tenant-scoped table intact.
 * Exit 1 = the gate still finds a problem after reapplying (a table this routine's own
 *          tenant_id-column heuristic did not catch, or something else disarmed a table this
 *          same run did not touch) — this is the "the enforcing gate must be check-rls-
 *          integrity.mjs, not this file's own belief that it succeeded" requirement, made literal.
 */
import pg from 'pg';
import { reapplyTenantRlsOnPayloadTables } from '../payload/src/reapply-tenant-rls.mjs';
import { evaluate } from './check-rls-integrity.mjs';

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

async function main() {
  const ownerUri = process.env.OWNER_URI;
  if (!ownerUri) {
    console.error('[reapply-and-verify-rls] OWNER_URI is not set — refusing to run.');
    process.exit(2);
  }

  const touched = await reapplyTenantRlsOnPayloadTables(ownerUri);
  console.log(`[reapply-and-verify-rls] reapplied on: ${touched.join(', ') || '(no tenant_id-bearing tables found)'}`);

  const client = new pg.Client({ connectionString: ownerUri });
  await client.connect();
  let rows;
  try {
    ({ rows } = await client.query(SQL_TENANT_TABLES));
  } finally {
    await client.end();
  }

  const findings = evaluate(rows);
  if (findings.length === 0) {
    console.log(`[reapply-and-verify-rls] GATE OK — ${rows.length} tenant-scoped table(s) intact.`);
    process.exit(0);
  }

  console.error(`[reapply-and-verify-rls] GATE FAILED — ${findings.length} of ${rows.length} table(s) still compromised after reapply:`);
  for (const f of findings) {
    console.error(`  ${f.table}`);
    for (const p of f.problems) console.error(`      - ${p}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error('[reapply-and-verify-rls] ERROR', err);
  process.exit(2);
});
