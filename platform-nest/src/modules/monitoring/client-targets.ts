// M6-P3d — the ERP renders the MON-01 probe-target file (Prometheus file_sd for client properties).
//
// ── WHY THIS LIVES HERE ─────────────────────────────────────────────────────────────────────────
// infra/observability/scripts/gen-client-property-targets.mjs was the designed producer, but it
// needs Node and a database login that reads `search_properties` across tenants (FORCE RLS), and
// gda-aicenter has neither. The platform already has both, so the platform renders the file and
// sumopod pulls it over a one-file forced-command SSH key (infra/scripts/pull-client-property-targets.sh).
// No new DB role: the read goes through the app role exactly as the monitoring runner's does.
//
// ── PARITY ──────────────────────────────────────────────────────────────────────────────────────
// isProbeableUrl()/toFileSd() are a TypeScript port of the generator's functions of the same name,
// and the generator remains the specification. They cannot be one file (the platform image is built
// from platform-nest/ alone; infra/ must not depend on platform-nest), so
// client-targets-parity.test.ts imports the generator and runs the same fixtures through both.
//
// ── THE CONSENT GATE ────────────────────────────────────────────────────────────────────────────
// Only verified + active + not-deleted properties become targets (the SQL below is the enforcement),
// and private/loopback/link-local hosts are refused: a property row is client-supplied data and a
// generator that probes 169.254.169.254 because a row said so is an SSRF with a cron attached.
//
// ── READING ACROSS TENANTS (the RLS trap) ───────────────────────────────────────────────────────
// `search_properties` RLS is `tenant_id = ANY(app_current_tenants()) AND app_module_allowed('search')`.
// `withGlobal` sets neither GUC, so under the NOBYPASSRLS app role it reads ZERO rows with no error
// (the same trap that made the monitoring sweep read nothing). So, like runSweep(), this enumerates
// `companies` (no RLS) and reads ONE TENANT PER TRANSACTION declaring `{ modules: ["search"] }`.
// Per-tenant also keeps MON-00b's cross-root wall intact without a `crossRoot` waiver.
// No isModuleEnabled() gate: the generator's rule was "every verified property", not "every
// property of a tenant with monitoring on".
//
// ── AN EMPTY LIST IS A CLAIM ────────────────────────────────────────────────────────────────────
//   * any read error  -> throw, the previous file is left untouched;
//   * zero companies  -> treated as a read failure (a real estate has companies);
//   * empty over a NON-EMPTY file is held back until EMPTY_CONFIRMATIONS consecutive runs agree,
//     because an RLS scope regression returns zero rows without an error and must not wipe probing.
import { promises as fs } from "node:fs";
import path from "node:path";
import { withGlobal, withTenants } from "../../db";

export interface PropertyRow {
  id?: string;
  tenant_id: string;
  client_id: string;
  domain: string;
  site_url: string;
  hosting_provider?: string | null;
  control_panel?: string | null;
  stack?: string | null;
  is_internal?: boolean | null;
}

export interface FileSdEntry {
  targets: string[];
  labels: Record<string, string>;
}

/** Hosts we refuse to probe regardless of what a row says. Keep in step with the generator. */
const PRIVATE_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /\.internal$/i,
  /\.local$/i,
];

export function isProbeableUrl(siteUrl: string): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(siteUrl);
  } catch {
    return { ok: false, reason: "not a parseable URL" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `refusing protocol ${u.protocol}` };
  }
  if (PRIVATE_PATTERNS.some((re) => re.test(u.hostname))) {
    return { ok: false, reason: `refusing private/loopback host ${u.hostname}` };
  }
  return { ok: true };
}

export function toFileSd(rows: PropertyRow[]): { targets: FileSdEntry[]; skipped: { domain: string; reason: string }[] } {
  const targets: FileSdEntry[] = [];
  const skipped: { domain: string; reason: string }[] = [];
  for (const r of rows) {
    const verdict = isProbeableUrl(r.site_url);
    if (!verdict.ok) {
      skipped.push({ domain: r.domain, reason: verdict.reason });
      continue;
    }
    targets.push({
      targets: [r.site_url],
      labels: {
        property_domain: r.domain,
        tenant_id: String(r.tenant_id),
        client_id: String(r.client_id),
        internal: r.is_internal === true ? "true" : "false",
        ...(r.hosting_provider ? { hosting_provider: r.hosting_provider } : {}),
        ...(r.control_panel ? { control_panel: r.control_panel } : {}),
        ...(r.stack ? { stack: r.stack } : {}),
      },
    });
  }
  return { targets, skipped };
}

/**
 * The consent gate, as SQL (same predicate as the generator's PROBEABLE_WITH_INTERNAL_SQL). No
 * ORDER BY: rows arrive per tenant, and sortRows() gives the one deterministic order.
 */
export const PROBEABLE_SQL = `
  SELECT p.id, p.tenant_id, p.client_id, p.domain, p.site_url,
         p.hosting_provider, p.control_panel, p.stack,
         COALESCE(c.is_internal, false) AS is_internal
    FROM search_properties p
    LEFT JOIN clients c ON c.id = p.client_id
   WHERE p.verified_at IS NOT NULL
     AND p.status = 'active'
     AND p.deleted_at IS NULL`;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The generator orders by domain. A JS code-point compare (not the DB collation) plus an id
 *  tiebreak makes the order total, so the file never flaps between runs. */
export function sortRows<T extends { domain: string; id?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => cmp(a.domain, b.domain) || cmp(String(a.id ?? ""), String(b.id ?? "")));
}

/** Byte-identical to the generator's output: JSON.stringify(targets, null, 2) + newline. */
export function renderTargetsFile(targets: FileSdEntry[]): string {
  return JSON.stringify(targets, null, 2) + "\n";
}

/** One transaction per tenant, scope `search`. Throws on ANY failure (never a partial list). */
export async function readEligibleProperties(): Promise<PropertyRow[]> {
  const companies = await withGlobal((c) =>
    c.query<{ id: string }>(`SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY id`),
  );
  if (companies.rows.length === 0) {
    throw new Error("no companies visible: refusing to treat that as an empty estate");
  }
  const all: PropertyRow[] = [];
  for (const co of companies.rows) {
    const res = await withTenants(
      [co.id],
      (c) => c.query<PropertyRow>(PROBEABLE_SQL),
      { modules: ["search"] },
    );
    all.push(...res.rows);
  }
  return sortRows(all);
}

export type WriteOutcome = "written" | "unchanged";

/**
 * Atomic, change-only write: temp file in the SAME directory, then rename. Does not create the
 * directory (a missing bind mount must be an error, not a silent write into the container layer).
 */
export async function writeFileIfChanged(file: string, content: string): Promise<WriteOutcome> {
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing === content) return "unchanged";
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  try {
    await fs.writeFile(tmp, content, { mode: 0o644 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return "written";
}

export const EMPTY_CONFIRMATIONS = 3;

export interface TargetsState {
  consecutiveEmpty: number;
}

export interface RunDeps {
  read?: () => Promise<PropertyRow[]>;
}

export type RunResult =
  | { status: "written" | "unchanged"; count: number; skipped: number }
  | { status: "held-empty"; consecutive: number };

/** One render. Throws on a read or write failure; the previous file is then untouched. */
export async function renderClientTargetsOnce(
  file: string,
  state: TargetsState,
  deps: RunDeps = {},
): Promise<RunResult> {
  const rows = await (deps.read ?? readEligibleProperties)();
  const { targets, skipped } = toFileSd(rows);
  for (const s of skipped) console.warn(`[MON-01 targets] SKIPPED ${s.domain}: ${s.reason}`);

  if (targets.length === 0) {
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const existingNonEmpty = existing.trim() !== "" && existing.trim() !== "[]";
    if (existingNonEmpty) {
      state.consecutiveEmpty += 1;
      if (state.consecutiveEmpty < EMPTY_CONFIRMATIONS) {
        return { status: "held-empty", consecutive: state.consecutiveEmpty };
      }
    }
  }
  state.consecutiveEmpty = 0;
  const outcome = await writeFileIfChanged(file, renderTargetsFile(targets));
  return { status: outcome, count: targets.length, skipped: skipped.length };
}

/**
 * Chained setTimeout (never setInterval), same shape as the monitoring runner loop. A failed tick
 * logs and leaves the old file; the loop continues. Unset path = OFF (main.ts logs that once).
 */
export function startClientTargetsLoop(
  file: string,
  intervalMs: number,
  firstDelayMs = 15_000,
): { stop: () => void } {
  const state: TargetsState = { consecutiveEmpty: 0 };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let lastSig = "";

  const tick = async () => {
    if (stopped) return;
    try {
      const r = await renderClientTargetsOnce(file, state);
      // Quiet when nothing changed; anything else is worth one line (not repeated while identical).
      const sig = JSON.stringify(r);
      if (r.status !== "unchanged" && sig !== lastSig) {
        // eslint-disable-next-line no-console
        console.log("[MON-01 targets]", r);
      }
      lastSig = sig;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[MON-01 targets] render failed, previous file left in place:", (e as Error).message);
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, firstDelayMs);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
