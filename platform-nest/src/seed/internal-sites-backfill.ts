// M6-P3b — one-off backfill: the INTERNAL `webdev_sites` rows of one tenant get the internal sentinel client
// (`clients.is_internal`, M5-G0 / migration 202610111100) as their `client_id`.
//   node dist/seed/internal-sites-backfill.js --tenant-id <companyId> --domains-file <path> [--apply]
// (dev checkout: npx tsx scripts/internal-sites-backfill.ts <same arguments>)
//
// WHY A SCRIPT, NEVER A MIGRATION: `webdev_sites` is module-scoped FORCE-RLS; a migration runs with the tenant
// GUC unset and would silently touch zero rows (migration-backfill-rls-trap). The domain list is an owner input
// and lives in a gitignored `*.local.*` file, never in the repo. The sentinel is found by the `is_internal`
// marker, never by name or a constant id.
//
// DEFAULT IS A DRY RUN (reads only). `--apply` writes every `set` row in ONE transaction, each with a
// conditional `UPDATE … WHERE client_id IS NULL`, so a concurrent change is never clobbered (it aborts the
// whole transaction instead). A row already pointing at a DIFFERENT non-sentinel client is a REFUSAL: this
// script never overwrites a real client. Any REFUSE, or zero / more than one sentinel, writes nothing and
// exits 3. IDEMPOTENT: rows already on the sentinel are reported as `already`; a second --apply changes nothing.
//
// RLS: the transaction declares the `webdev` module scope. Without it the SELECT silently returns ZERO rows and
// every domain would plan as `missing` (the RLS zero-row trap).
import { readFileSync } from "fs";
import type { PoolClient } from "pg";
import { withTenants, closePool } from "../db";
import { emitEvent } from "../events/outbox.service";

export class BackfillRefusal extends Error {}

export interface BackfillOptions {
  tenantId: string;
  /** Lower-cased, trimmed, scheme-less hosts, as returned by parseDomainsFile. */
  domains: string[];
  apply: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: one domain per line. Blank lines and `#` comment lines are ignored; duplicates collapse. */
export function parseDomainsFile(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const d = line.toLowerCase();
    if (/\s/.test(d)) throw new BackfillRefusal(`domains file line ${i + 1} is not a bare domain: "${line}"`);
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  });
  if (out.length === 0) throw new BackfillRefusal("the domains file lists no domains");
  return out;
}

export function parseArgs(argv: string[]): { tenantId: string; domainsFile: string; apply: boolean } {
  const valued = new Set(["--tenant-id", "--domains-file"]);
  const got = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") got.set(a, true);
    else if (valued.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new BackfillRefusal(`${a} needs a value`);
      got.set(a, v);
    } else throw new BackfillRefusal(`unknown argument ${a}`);
  }
  for (const r of valued) if (typeof got.get(r) !== "string") throw new BackfillRefusal(`${r} is required`);
  const tenantId = got.get("--tenant-id") as string;
  if (!UUID_RE.test(tenantId)) throw new BackfillRefusal("--tenant-id must be a company uuid");
  return { tenantId, domainsFile: got.get("--domains-file") as string, apply: got.get("--apply") === true };
}

/** What the database holds today, read inside the tenant-scoped transaction. */
export interface BackfillState {
  /** Live `clients` rows with is_internal = true under the tenant. */
  sentinelIds: string[];
  /** Live `webdev_sites` rows under the tenant whose domain is in the requested list. */
  rows: { id: string; domain: string; clientId: string | null }[];
}

export type BackfillAction = "already" | "set" | "REFUSE" | "missing";

export interface BackfillLine {
  domain: string;
  action: BackfillAction;
  siteId?: string;
  currentClientId?: string | null;
}

export interface BackfillPlan {
  sentinelId: string | null;
  lines: BackfillLine[];
  refusals: string[];
  /** True when applying would write at least one row. */
  writes: boolean;
}

/** Pure: decides what to do from the state read. Never writes, never reads. */
export function planBackfill(state: BackfillState, domains: string[]): BackfillPlan {
  if (state.sentinelIds.length !== 1) {
    const refusal = state.sentinelIds.length === 0
      ? "no internal sentinel client exists under this tenant (clients.is_internal = true); run internal-sentinel first"
      : `${state.sentinelIds.length} live internal clients exist under this tenant (${state.sentinelIds.join(", ")}); resolve by hand`;
    return { sentinelId: null, lines: [], refusals: [refusal], writes: false };
  }
  const sentinelId = state.sentinelIds[0];
  const refusals: string[] = [];
  const lines: BackfillLine[] = [];

  for (const domain of domains) {
    const matches = state.rows.filter((r) => r.domain === domain);
    if (matches.length === 0) {
      lines.push({ domain, action: "missing" });
    } else if (matches.length > 1) {
      refusals.push(`${domain} matches ${matches.length} live webdev_sites rows; resolve by hand`);
      lines.push({ domain, action: "REFUSE" });
    } else {
      const r = matches[0];
      if (r.clientId === sentinelId) {
        lines.push({ domain, action: "already", siteId: r.id, currentClientId: r.clientId });
      } else if (r.clientId === null) {
        lines.push({ domain, action: "set", siteId: r.id, currentClientId: null });
      } else {
        refusals.push(`${domain} (${r.id}) already belongs to another client (${r.clientId}); this script never overwrites a real client`);
        lines.push({ domain, action: "REFUSE", siteId: r.id, currentClientId: r.clientId });
      }
    }
  }

  const writes = refusals.length === 0 && lines.some((l) => l.action === "set");
  return { sentinelId, lines, refusals, writes };
}

async function readState(c: PoolClient, opts: BackfillOptions): Promise<BackfillState> {
  const col = await c.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'clients' AND column_name = 'is_internal'`,
  );
  if (col.rowCount === 0) throw new BackfillRefusal("clients.is_internal does not exist: migration 202610111100 has not been applied on this database");
  const sentinels = await c.query<{ id: string }>(
    `SELECT id FROM clients WHERE tenant_id = $1 AND is_internal AND deleted_at IS NULL ORDER BY created_at`, [opts.tenantId]);
  const rows = await c.query<{ id: string; domain: string; client_id: string | null }>(
    `SELECT id, domain, client_id FROM webdev_sites
      WHERE tenant_id = $1 AND domain = ANY($2::text[]) AND deleted_at IS NULL ORDER BY domain, created_at`,
    [opts.tenantId, opts.domains]);
  return {
    sentinelIds: sentinels.rows.map((r) => r.id),
    rows: rows.rows.map((r) => ({ id: r.id, domain: r.domain, clientId: r.client_id })),
  };
}

export interface BackfillResult {
  plan: BackfillPlan;
  applied: boolean;
  /** Rows actually updated (0 on a dry run or a no-op second apply). */
  changed: number;
  lines: string[];
}

function formatLine(l: BackfillLine, sentinelId: string | null): string {
  const site = l.siteId ?? "-";
  switch (l.action) {
    case "already": return `already  ${l.domain}  ${site}  client=sentinel`;
    case "set": return `set      ${l.domain}  ${site}  client=NULL -> sentinel ${sentinelId}`;
    case "REFUSE": return `REFUSE   ${l.domain}  ${site}  client=${l.currentClientId ?? "NULL"} (not the sentinel)`;
    case "missing": return `missing  ${l.domain}  no live webdev_sites row`;
  }
}

export async function runBackfill(opts: BackfillOptions): Promise<BackfillResult> {
  return withTenants([opts.tenantId], async (c) => {
    const state = await readState(c, opts);
    const plan = planBackfill(state, opts.domains);
    const lines: string[] = [`${opts.apply ? "APPLY" : "DRY RUN"} tenant=${opts.tenantId} domains=${opts.domains.length}`];
    for (const l of plan.lines) lines.push(formatLine(l, plan.sentinelId));
    const count = (a: BackfillAction) => plan.lines.filter((l) => l.action === a).length;
    lines.push(`summary: already=${count("already")} set=${count("set")} missing=${count("missing")} refuse=${count("REFUSE")}`);
    for (const r of plan.refusals) lines.push(`REFUSED: ${r}`);

    if (plan.refusals.length > 0) return { plan, applied: false, changed: 0, lines };

    let changed = 0;
    if (opts.apply && plan.writes && plan.sentinelId) {
      for (const l of plan.lines) {
        if (l.action !== "set" || !l.siteId) continue;
        const upd = await c.query(
          `UPDATE webdev_sites SET client_id = $2, updated_at = now()
            WHERE id = $1 AND client_id IS NULL AND deleted_at IS NULL RETURNING id`,
          [l.siteId, plan.sentinelId]);
        // Zero rows means the row changed between the read and this write: abort the whole transaction.
        if (upd.rowCount !== 1) throw new BackfillRefusal(`${l.domain} changed while the backfill ran; nothing was written`);
        await emitEvent(c, opts.tenantId, "webdev_site", l.siteId, "webdev.site.client_backfilled", {
          domain: l.domain, clientId: plan.sentinelId,
        });
        changed++;
      }
    }

    const applied = opts.apply && plan.writes;
    if (!plan.writes) lines.push("Nothing to change.");
    else if (!opts.apply) lines.push("DRY RUN: nothing was written. Re-run with --apply to write.");
    else lines.push(`changed ${changed} row(s)`);
    return { plan, applied, changed, lines };
  }, { modules: ["webdev"] });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    const a = parseArgs(argv);
    const domains = parseDomainsFile(readFileSync(a.domainsFile, "utf8"));
    const r = await runBackfill({ tenantId: a.tenantId, domains, apply: a.apply });
    for (const l of r.lines) console.log(l);
    return r.plan.refusals.length > 0 ? 3 : 0;
  } catch (err) {
    if (err instanceof BackfillRefusal) { console.error(`REFUSED: ${err.message}`); return 3; }
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  } finally {
    await closePool();
  }
}

if (require.main === module) {
  void main().then((code) => process.exit(code));
}
