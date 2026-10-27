// SCP-Sb — prepare a database for the social simulator: find every row that would make boot REFUSE `SOCIAL_SIMULATION_ENABLED`,
// and mark the ones that are plainly mock seed as simulated.
//   node dist/seed/social-simulation-prepare.js            DRY RUN: reads only, lists, writes nothing
//   node dist/seed/social-simulation-prepare.js --apply    marks the rows classified MOCK SEED as simulated, in one transaction per company
// (dev checkout: npx tsx scripts/social-simulation-prepare.ts <same arguments>; operator steps: infra/runbooks/social-simulation.md)
//
// WHAT BOOT REFUSES (publisher/boot.ts, SCP-Sa errors 4 and 5), and so what this lists, in EVERY company (deleted ones too):
//   * every `social_accounts` row with `simulated = false`, SOFT-DELETED INCLUDED (a soft-deleted account is one upsert away from
//     live again, so boot counts it);
//   * every `social_oauth_tokens` row with `status = 'active'` (a connected LinkedIn/YouTube account can publish for real through
//     the `direct` driver).
// The exit code predicts the boot: 0 when nothing blocking would remain (after the marks, in a dry run too), 2 when something would.
//
// ── THE RULE: WHAT IS "PLAINLY MOCK SEED" ──────────────────────────────────────────────────────────────────────────────
// Only one thing writes a non-simulated account without ever talking to an engine: the CP-21 portal demo seed
// (`seed/portal-engagement.ts`). Its rows have a fingerprint no real connection can have, and this script marks an account
// ONLY when ALL of these hold:
//   1. its publisher org's `api_key_ref` is exactly `seed:portal-demo-no-key` (an alias that resolves to nothing, by design);
//   2. its publisher org's `postiz_org_id` is exactly `seed-<its client id>` (the whole client id, as that seed writes it);
//   3. the account has no `postiz_integration_id` (it was never connected to an engine) and no `connected_by`;
//   4. no `social_oauth_tokens` row of ANY status names it (a revoked grant is the trace of a real connection that existed);
//   5. no variant on it carries a provider post id, a `published_at`, or is a native import (real publishing happened, or
//      was recorded as having happened).
// Soft-deleted rows are classified by the same rule (a soft-deleted CP-21 seed row is as mock as a live one, and boot counts it).
// EVERYTHING ELSE IS UNCLASSIFIED: the script prints it with the reasons and the ids and touches nothing. That includes every
// account of a real-looking org, every account with an integration id, and every account with any grant or publishing history.
// A human decides those (connect nothing; either remove the row through the module's own tools, or do not turn the switch on).
// Live OAuth grants are NEVER touched: revoking one is a human act through the existing disconnect flow.
//
// ── WHAT IT NEVER DOES ─────────────────────────────────────────────────────────────────────────────────────────────────
// It never deletes a row, never changes a status, handle, org or integration id, never revokes or reads a token's ciphertext
// (the grant query selects ids and statuses only), never clears a soft-delete, and never writes anything without `--apply`.
// The only statement it can run is an UPDATE of social_accounts that sets simulated = true WHERE simulated = false AND id = ANY(<the
// classified ids>), and it checks the row count against the plan inside the transaction (a mismatch rolls the company back).
//
// ── FENCE 4, AND WHY THIS IS NOT BEHIND IT ─────────────────────────────────────────────────────────────────────────────
// `assertSimulatedWriteAllowed` refuses a simulated write while the switch is off. This script runs BEFORE the switch is turned
// on (boot would refuse the switch otherwise), so it cannot call it, and does not: a row marked simulated while the switch is
// off is inert (a simulated account's variant refuses `simulation_disabled` at dispatch; nothing registers the simulator).
// The static inventory in publisher/simulation.test.ts names this file as the ONE other writer of the mark and pins that it
// only ever sets it TRUE on a `simulated = false` row, inserts nothing and deletes nothing.
//
// RLS: every read and the write declare the `social` module scope and one company at a time (the third wall: an unset scope
// reads ZERO rows, which here would look exactly like a clean database).
import type { PoolClient } from "pg";
import { withGlobal, withTenants, closePool } from "../db";
import { writeActivity } from "../core/http";

/** The CP-21 demo seed's org fingerprint (`seed/portal-engagement.ts#ensurePublisherOrg`). */
export const CP21_API_KEY_REF = "seed:portal-demo-no-key";
export const cp21PostizOrgId = (clientId: string): string => `seed-${clientId}`;

const MODULES = { modules: ["social"] };

/** One `simulated = false` account with everything the rule reads. */
export interface PrepareAccount {
  id: string;
  clientId: string;
  clientName: string;
  network: string;
  handle: string;
  status: string;
  deleted: boolean;
  integrationId: string | null;
  connectedBy: string | null;
  orgApiKeyRef: string;
  orgPostizOrgId: string;
  /** A `social_oauth_tokens` row of any status names this account. */
  hasAnyGrant: boolean;
  /** A variant on this account carries a provider post id, a published_at, or is a native import. */
  hasPublishingHistory: boolean;
}

export type Verdict = { kind: "mock_seed" } | { kind: "unclassified"; reasons: string[] };

/** PURE. The rule of the header. Every failed condition adds its reason: an unclassified row says WHY. */
export function classifyAccount(a: PrepareAccount): Verdict {
  const reasons: string[] = [];
  if (a.orgApiKeyRef !== CP21_API_KEY_REF) reasons.push(`its publisher org's api_key_ref is '${a.orgApiKeyRef}', not the CP-21 seed alias`);
  if (a.orgPostizOrgId !== cp21PostizOrgId(a.clientId)) reasons.push(`its publisher org id '${a.orgPostizOrgId}' is not 'seed-<client id>'`);
  if (a.integrationId !== null) reasons.push(`it carries an engine integration id ('${a.integrationId}'): it was connected to an engine`);
  if (a.connectedBy !== null) reasons.push("a person connected it (connected_by is set)");
  if (a.hasAnyGrant) reasons.push("an OAuth grant names it (live, revoked or expired): a real connection existed");
  if (a.hasPublishingHistory) reasons.push("a variant on it carries a provider post id, a published time or is a native import");
  return reasons.length === 0 ? { kind: "mock_seed" } : { kind: "unclassified", reasons };
}

export interface PrepareGrant { id: string; accountId: string; clientName: string; network: string }

export interface TenantReport {
  tenantId: string;
  company: string;
  markable: PrepareAccount[];
  unclassified: Array<{ account: PrepareAccount; reasons: string[] }>;
  grants: PrepareGrant[];
  /** Rows actually marked (always 0 in a dry run). */
  marked: number;
}

export interface PrepareResult {
  apply: boolean;
  tenants: TenantReport[];
  /** What would still make boot refuse the switch once every markable row is marked. */
  blockingAccounts: number;
  blockingGrants: number;
  totalMarkable: number;
  totalMarked: number;
}

/** Reads one company's blockers, in the caller's transaction. */
export async function readTenant(c: PoolClient, tenantId: string, company: string): Promise<TenantReport> {
  const accounts = await c.query<{
    id: string; client_id: string; client_name: string | null; network: string; handle: string; status: string; deleted: boolean;
    integration_id: string | null; connected_by: string | null; api_key_ref: string; postiz_org_id: string; has_grant: boolean; has_history: boolean;
  }>(
    `SELECT a.id, a.client_id, cl.name AS client_name, a.network, a.handle, a.status, a.deleted_at IS NOT NULL AS deleted,
            a.postiz_integration_id AS integration_id, a.connected_by, o.api_key_ref, o.postiz_org_id,
            EXISTS (SELECT 1 FROM social_oauth_tokens t WHERE t.tenant_id = a.tenant_id AND t.account_id = a.id) AS has_grant,
            EXISTS (SELECT 1 FROM social_post_variants v
                     WHERE v.tenant_id = a.tenant_id AND v.account_id = a.id
                       AND (v.provider_post_id IS NOT NULL OR v.published_at IS NOT NULL OR v.native_import)) AS has_history
       FROM social_accounts a
       JOIN social_publisher_orgs o ON o.id = a.publisher_org_id AND o.tenant_id = a.tenant_id
       LEFT JOIN clients cl ON cl.id = a.client_id AND cl.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.simulated = false
      ORDER BY cl.name, a.network, a.handle, a.id`,
    [tenantId],
  );
  // Ids and statuses only: the ciphertext columns are never selected.
  const grants = await c.query<{ id: string; account_id: string; client_name: string | null; network: string }>(
    `SELECT t.id, t.account_id, cl.name AS client_name, t.network
       FROM social_oauth_tokens t
       LEFT JOIN social_accounts a ON a.id = t.account_id AND a.tenant_id = t.tenant_id
       LEFT JOIN clients cl ON cl.id = a.client_id AND cl.tenant_id = t.tenant_id
      WHERE t.tenant_id = $1 AND t.status = 'active'
      ORDER BY cl.name, t.network, t.id`,
    [tenantId],
  );
  const report: TenantReport = {
    tenantId, company, markable: [], unclassified: [],
    grants: grants.rows.map((g) => ({ id: g.id, accountId: g.account_id, clientName: g.client_name ?? "(unknown client)", network: g.network })),
    marked: 0,
  };
  for (const r of accounts.rows) {
    const a: PrepareAccount = {
      id: r.id, clientId: r.client_id, clientName: r.client_name ?? "(unknown client)", network: r.network, handle: r.handle, status: r.status,
      deleted: r.deleted, integrationId: r.integration_id, connectedBy: r.connected_by, orgApiKeyRef: r.api_key_ref, orgPostizOrgId: r.postiz_org_id,
      hasAnyGrant: r.has_grant, hasPublishingHistory: r.has_history,
    };
    const v = classifyAccount(a);
    if (v.kind === "mock_seed") report.markable.push(a);
    else report.unclassified.push({ account: a, reasons: v.reasons });
  }
  return report;
}

/** Marks the classified ids, inside the caller's transaction; throws (rolling the company back) if the row count differs from the plan. */
async function markSimulated(c: PoolClient, tenantId: string, ids: string[]): Promise<number> {
  const r = await c.query(
    `UPDATE social_accounts SET simulated = true, updated_at = now() WHERE tenant_id = $1 AND simulated = false AND id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  if ((r.rowCount ?? 0) !== ids.length) {
    throw new Error(`social-simulation-prepare: planned to mark ${ids.length} account(s) but ${r.rowCount ?? 0} matched. Rolled this company back.`);
  }
  return r.rowCount ?? 0;
}

/** `onlyTenantIds` is a TEST seam (a shared test database holds other suites' companies); the CLI never passes it, and a
 *  restricted run's totals say nothing about boot, which counts every company. */
export async function prepare(opts: { apply: boolean; onlyTenantIds?: readonly string[] }): Promise<PrepareResult> {
  // Every company, deleted ones included: boot counts every tenant.
  const all = await withGlobal((c) => c.query<{ id: string; name: string }>(`SELECT id, name FROM companies ORDER BY name`));
  const companies = { rows: opts.onlyTenantIds ? all.rows.filter((r) => opts.onlyTenantIds!.includes(r.id)) : all.rows };
  if (companies.rows.length === 0) throw new Error("social-simulation-prepare: no companies. Refusing to report a clean database on no data.");
  const tenants: TenantReport[] = [];
  for (const co of companies.rows) {
    const report = await withTenants(
      [co.id],
      async (c) => {
        const r = await readTenant(c, co.id, co.name);
        if (opts.apply && r.markable.length > 0) r.marked = await markSimulated(c, co.id, r.markable.map((a) => a.id));
        return r;
      },
      MODULES,
    );
    if (report.marked > 0) {
      await writeActivity(co.id, null, "marked_simulated", "social_account", null, {
        script: "social-simulation-prepare", accountIds: report.markable.map((a) => a.id), rule: "cp21_seed_fingerprint",
      });
    }
    tenants.push(report);
  }
  return {
    apply: opts.apply,
    tenants,
    blockingAccounts: tenants.reduce((n, t) => n + t.unclassified.length, 0),
    blockingGrants: tenants.reduce((n, t) => n + t.grants.length, 0),
    totalMarkable: tenants.reduce((n, t) => n + t.markable.length, 0),
    totalMarked: tenants.reduce((n, t) => n + t.marked, 0),
  };
}

/** PURE. The report, one line per fact. Nothing secret is ever in a row it prints. */
export function renderReport(r: PrepareResult): string[] {
  const out: string[] = [];
  out.push(r.apply ? "APPLY: marking the rows classified MOCK SEED as simulated" : "DRY RUN: nothing is written (add --apply to mark the MOCK SEED rows)");
  const acct = (a: PrepareAccount) =>
    `${a.id}  ${a.clientName}  ${a.network} ${a.handle}  status=${a.status}${a.deleted ? "  SOFT-DELETED" : ""}`;
  for (const t of r.tenants) {
    if (t.markable.length + t.unclassified.length + t.grants.length === 0) continue;
    out.push("", `COMPANY ${t.company} (${t.tenantId})`);
    for (const a of t.markable) out.push(`  ${r.apply ? "MARKED   " : "WOULD MARK"}  ${acct(a)}`);
    for (const u of t.unclassified) {
      out.push(`  UNCLASSIFIED  ${acct(u.account)}`);
      for (const why of u.reasons) out.push(`      - ${why}`);
    }
    for (const g of t.grants) out.push(`  LIVE OAUTH GRANT  ${g.id}  ${g.clientName}  ${g.network}  (account ${g.accountId})`);
  }
  out.push(
    "",
    `markable (CP-21 seed fingerprint): ${r.totalMarkable}${r.apply ? `, marked: ${r.totalMarked}` : ""}`,
    `still blocking boot after the marks: ${r.blockingAccounts} unclassified account(s), ${r.blockingGrants} live OAuth grant(s)`,
  );
  if (r.blockingAccounts + r.blockingGrants > 0) {
    out.push(
      "BOOT WOULD STILL REFUSE SOCIAL_SIMULATION_ENABLED. This script touches neither kind: a person decides each row above",
      "(an unclassified account is not plainly mock seed; a live grant is revoked through the module's own disconnect flow).",
    );
  } else if (!r.apply && r.totalMarkable > 0) {
    out.push("Re-run with --apply to mark them; then boot will accept SOCIAL_SIMULATION_ENABLED.");
  } else {
    out.push("Nothing blocks the switch.");
  }
  return out;
}

/** 0: nothing blocking would remain. 2: something would (or an error). */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const unknown = argv.filter((a) => a !== "--apply");
    if (unknown.length > 0) {
      console.error(`unknown argument(s): ${unknown.join(" ")}. Usage: social-simulation-prepare [--apply]`);
      return 2;
    }
    const r = await prepare({ apply: argv.includes("--apply") });
    for (const l of renderReport(r)) console.log(l);
    return r.blockingAccounts + r.blockingGrants > 0 ? 2 : 0;
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
