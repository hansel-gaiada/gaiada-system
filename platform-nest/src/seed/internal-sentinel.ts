// M5-G0 — the internal sentinel client (WSK-D36) and an internal site's `search_properties` row.
//   node dist/seed/internal-sentinel.js --tenant-id <companyId> --name "<display name>" --domain <domain> [--apply]
// (dev checkout: npx tsx scripts/internal-sentinel.ts <same arguments>)
//
// WHY A SCRIPT, NEVER A MIGRATION: `clients` and `search_properties` are tenant-scoped FORCE-RLS tables; a
// migration runs with the tenant GUC unset and would silently touch zero rows (migration-backfill-rls-trap),
// and the display name is an owner decision. See docs/plans/2026-09-04-site-consolidation-ledger.md.
//
// "INTERNAL NOW, SAAS LATER": nothing about our group is hard-wired. The tenant, the display name and the
// domain are all arguments; the sentinel is found by the `clients.is_internal` marker (migration
// 202610111100), never by name or by a constant id.
//
// DEFAULT IS A DRY RUN (reads only). `--apply` writes both rows in ONE transaction. IDEMPOTENT and
// NON-DESTRUCTIVE: an existing row is reported and left untouched, never updated or renamed. Anything
// ambiguous (two candidates, a name clash with a real client, the domain already owned by another client)
// is a REFUSAL with nothing written.
//
// RLS: `clients` is core (tenant GUC only); `search_properties` is module-sliced, so the transaction
// declares the `search` scope. Without it the SELECT silently returns ZERO rows and the plan would say
// "insert" for a row that exists (the insert would then hit the unique index).
import type { PoolClient } from "pg";
import { newId, withTenants, closePool } from "../db";
import { config } from "../config";

export class SentinelRefusal extends Error {}

export interface SentinelOptions {
  tenantId: string;
  name: string;
  /** Lower-cased, scheme-less host, e.g. `example.com`. */
  domain: string;
  apply: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(raw: string): string {
  const d = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(d)) throw new SentinelRefusal(`--domain "${raw}" is not a bare host name (no scheme, path or port)`);
  return d;
}

export function parseArgs(argv: string[]): SentinelOptions {
  const valued = new Set(["--tenant-id", "--name", "--domain"]);
  const got = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") got.set(a, true);
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new SentinelRefusal(`${a} needs a value`);
      got.set(a, v);
    } else throw new SentinelRefusal(`unknown argument ${a}`);
  }
  for (const r of valued) if (typeof got.get(r) !== "string") throw new SentinelRefusal(`${r} is required`);
  const tenantId = got.get("--tenant-id") as string;
  if (!UUID_RE.test(tenantId)) throw new SentinelRefusal("--tenant-id must be a company uuid");
  const name = (got.get("--name") as string).trim();
  if (!name) throw new SentinelRefusal("--name must not be empty");
  return { tenantId, name, domain: normalizeDomain(got.get("--domain") as string), apply: got.get("--apply") === true };
}

/** What the database holds today, as read inside the tenant-scoped transaction. */
export interface SentinelState {
  companyExists: boolean;
  /** Live `clients` rows with is_internal = true under the tenant. */
  internalClients: { id: string; name: string }[];
  /** Live NON-internal clients carrying the requested name. */
  sameNameClients: { id: string }[];
  /** The live search_properties row for lower(domain) under the tenant, if any. */
  property: { id: string; clientId: string; verifiedAt: string | null } | null;
}

export type SentinelStep =
  | { kind: "client"; action: "insert"; name: string }
  | { kind: "client"; action: "found"; id: string; name: string }
  | { kind: "property"; action: "insert"; domain: string; siteUrl: string }
  | { kind: "property"; action: "found"; id: string; domain: string; note?: string };

export interface SentinelPlan {
  steps: SentinelStep[];
  refusals: string[];
  /** True when applying would write at least one row. */
  writes: boolean;
}

/** Pure: decides what to do from the state read. Never writes, never reads. */
export function planSentinel(state: SentinelState, opts: Pick<SentinelOptions, "name" | "domain">): SentinelPlan {
  const steps: SentinelStep[] = [];
  const refusals: string[] = [];

  if (!state.companyExists) {
    return { steps, refusals: ["--tenant-id does not name an existing company"], writes: false };
  }

  let sentinelId: string | null = null;
  if (state.internalClients.length > 1) {
    refusals.push(`${state.internalClients.length} live internal clients exist under this tenant (${state.internalClients.map((c) => c.id).join(", ")}); resolve by hand`);
  } else if (state.internalClients.length === 1) {
    const c = state.internalClients[0];
    sentinelId = c.id;
    steps.push({ kind: "client", action: "found", id: c.id, name: c.name });
  } else if (state.sameNameClients.length > 0) {
    refusals.push(`a NON-internal client named "${opts.name}" already exists (${state.sameNameClients.map((c) => c.id).join(", ")}); this script never adopts a real client - choose another --name`);
  } else {
    steps.push({ kind: "client", action: "insert", name: opts.name });
  }

  if (state.property) {
    if (sentinelId !== null && state.property.clientId === sentinelId) {
      steps.push({
        kind: "property", action: "found", id: state.property.id, domain: opts.domain,
        note: state.property.verifiedAt === null ? "verified_at is NULL; left unchanged, so it will not be probed until set" : undefined,
      });
    } else {
      refusals.push(`domain ${opts.domain} already has a search_properties row (${state.property.id}) owned by another client (${state.property.clientId}); this script never reassigns one`);
    }
  } else if (refusals.length === 0) {
    steps.push({ kind: "property", action: "insert", domain: opts.domain, siteUrl: `https://${opts.domain}/` });
  }

  const writes = refusals.length === 0 && steps.some((s) => s.action === "insert");
  return { steps, refusals, writes };
}

async function readState(c: PoolClient, opts: SentinelOptions): Promise<SentinelState> {
  const col = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'clients' AND column_name = 'is_internal'`,
  );
  if (col.rowCount === 0) throw new SentinelRefusal("clients.is_internal does not exist: migration 202610111100 has not been applied on this database");
  const company = await c.query(`SELECT 1 FROM companies WHERE id = $1`, [opts.tenantId]);
  const internal = await c.query<{ id: string; name: string }>(
    `SELECT id, name FROM clients WHERE tenant_id = $1 AND is_internal AND deleted_at IS NULL ORDER BY created_at`, [opts.tenantId]);
  const same = await c.query<{ id: string }>(
    `SELECT id FROM clients WHERE tenant_id = $1 AND name = $2 AND NOT is_internal AND deleted_at IS NULL`, [opts.tenantId, opts.name]);
  const prop = await c.query<{ id: string; client_id: string; verified_at: Date | null }>(
    `SELECT id, client_id, verified_at FROM search_properties
      WHERE tenant_id = $1 AND lower(domain) = $2 AND deleted_at IS NULL`, [opts.tenantId, opts.domain]);
  return {
    companyExists: (company.rowCount ?? 0) > 0,
    internalClients: internal.rows,
    sameNameClients: same.rows,
    property: prop.rows[0]
      ? { id: prop.rows[0].id, clientId: prop.rows[0].client_id, verifiedAt: prop.rows[0].verified_at ? prop.rows[0].verified_at.toISOString() : null }
      : null,
  };
}

export interface SentinelResult {
  plan: SentinelPlan;
  applied: boolean;
  lines: string[];
  clientId?: string;
  propertyId?: string;
}

export async function runSentinel(opts: SentinelOptions): Promise<SentinelResult> {
  return withTenants([opts.tenantId], async (c) => {
    const state = await readState(c, opts);
    const plan = planSentinel(state, opts);
    const lines: string[] = [`${opts.apply ? "APPLY" : "DRY RUN"} tenant=${opts.tenantId} domain=${opts.domain}`];
    let clientId = state.internalClients.length === 1 ? state.internalClients[0].id : undefined;
    let propertyId = state.property && clientId && state.property.clientId === clientId ? state.property.id : undefined;

    if (plan.refusals.length > 0) {
      for (const r of plan.refusals) lines.push(`REFUSED: ${r}`);
      return { plan, applied: false, lines, clientId, propertyId };
    }

    const doWrite = opts.apply && plan.writes;
    for (const s of plan.steps) {
      if (s.kind === "client" && s.action === "found") lines.push(`client   found    ${s.id}  "${s.name}" (internal) - unchanged`);
      if (s.kind === "client" && s.action === "insert") {
        if (doWrite) {
          clientId = newId();
          await c.query(
            `INSERT INTO clients (id, tenant_id, name, origin_site, is_internal) VALUES ($1, $2, $3, $4, true)`,
            [clientId, opts.tenantId, s.name, config.originSite],
          );
          lines.push(`client   inserted ${clientId}  "${s.name}" (internal)`);
        } else lines.push(`client   would insert  "${s.name}" (is_internal = true)`);
      }
      if (s.kind === "property" && s.action === "found") lines.push(`property found    ${s.id}  ${s.domain} - unchanged${s.note ? ` (${s.note})` : ""}`);
      if (s.kind === "property" && s.action === "insert") {
        if (doWrite) {
          propertyId = newId();
          await c.query(
            `INSERT INTO search_properties (id, tenant_id, client_id, domain, site_url, umami_site_id, verified_at, origin_site)
             VALUES ($1, $2, $3, $4, $5, NULL, now(), $6)`,
            [propertyId, opts.tenantId, clientId, s.domain, s.siteUrl, config.originSite],
          );
          lines.push(`property inserted ${propertyId}  ${s.domain} site_url=${s.siteUrl} verified_at=now umami_site_id=null`);
        } else lines.push(`property would insert  ${s.domain} site_url=${s.siteUrl} verified_at=now umami_site_id=null`);
      }
    }
    if (!plan.writes) lines.push("Nothing to change.");
    else if (!doWrite) lines.push("DRY RUN: nothing was written. Re-run with --apply to write.");
    return { plan, applied: doWrite, lines, clientId, propertyId };
  }, { modules: ["search"] });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const r = await runSentinel(parseArgs(argv));
    for (const l of r.lines) console.log(l);
    if (r.clientId) console.log(`sentinel client id: ${r.clientId}`);
    if (r.propertyId) console.log(`search property id: ${r.propertyId}`);
    return r.plan.refusals.length > 0 ? 3 : 0;
  } catch (err) {
    if (err instanceof SentinelRefusal) { console.error(`REFUSED: ${err.message}`); return 3; }
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
