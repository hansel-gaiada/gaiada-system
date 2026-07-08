// Scheduler state (5a.8): last-run watermark per slot + a per-slot/day idempotency claim
// so a double-fired cron (or two bot instances) runs a digest slot at most once per day.
// Postgres when DATABASE_URL is set (shared across instances); file fallback for dev.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import { config } from "./config";
import { withTenant } from "./store/pg";

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: config.databaseUrl });
  return pool;
}

async function ensureTables(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS schedule_state (
      tenant_id text NOT NULL DEFAULT 'trial',
      slot text NOT NULL,
      last_run_end bigint NOT NULL,
      PRIMARY KEY (tenant_id, slot)
    );
    CREATE TABLE IF NOT EXISTS schedule_claims (
      tenant_id text NOT NULL DEFAULT 'trial',
      slot text NOT NULL,
      day_key text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, slot, day_key)
    );
    ALTER TABLE schedule_state ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schedule_state FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON schedule_state;
    CREATE POLICY tenant_isolation ON schedule_state FOR ALL
      USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')))
      WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')));
    ALTER TABLE schedule_claims ENABLE ROW LEVEL SECURITY;
    ALTER TABLE schedule_claims FORCE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS tenant_isolation ON schedule_claims;
    CREATE POLICY tenant_isolation ON schedule_claims FOR ALL
      USING (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')))
      WITH CHECK (tenant_id = ANY(string_to_array(current_setting('app.current_tenant_ids', true), ',')));
  `);
}

// ---- file fallback ----
function fileLoad<T>(path: string, empty: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty;
}
function fileSave(path: string, v: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(v, null, 2));
}
const claimsFile = () => config.scheduleStateFile.replace(/\.json$/, "") + ".claims.json";

export async function loadLastRun(slot: string): Promise<number | undefined> {
  if (!config.databaseUrl) {
    return fileLoad<Record<string, number>>(config.scheduleStateFile, {})[slot];
  }
  await ensureTables();
  const rows = await withTenant(getPool(), [config.tenantId], (c) =>
    c.query<{ last_run_end: string }>(`SELECT last_run_end FROM schedule_state WHERE slot = $1`, [slot]),
  );
  return rows.rows[0] ? Number(rows.rows[0].last_run_end) : undefined;
}

export async function saveLastRun(slot: string, end: number): Promise<void> {
  if (!config.databaseUrl) {
    const s = fileLoad<Record<string, number>>(config.scheduleStateFile, {});
    s[slot] = end;
    fileSave(config.scheduleStateFile, s);
    return;
  }
  await withTenant(getPool(), [config.tenantId], (c) =>
    c.query(
      `INSERT INTO schedule_state (tenant_id, slot, last_run_end) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, slot) DO UPDATE SET last_run_end = $3`,
      [config.tenantId, slot, end],
    ),
  );
}

/** Claim this (slot, day). Returns true exactly once per day — the winner runs the digest. */
export async function claimSlot(slot: string, dayKey: string): Promise<boolean> {
  if (!config.databaseUrl) {
    const key = `${slot}:${dayKey}`;
    const claims = fileLoad<Record<string, true>>(claimsFile(), {});
    if (claims[key]) return false;
    claims[key] = true;
    fileSave(claimsFile(), claims);
    return true;
  }
  await ensureTables();
  const res = await withTenant(getPool(), [config.tenantId], (c) =>
    c.query(
      `INSERT INTO schedule_claims (tenant_id, slot, day_key) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING day_key`,
      [config.tenantId, slot, dayKey],
    ),
  );
  return (res.rowCount ?? 0) > 0;
}

export async function closeScheduleState(): Promise<void> {
  await pool?.end();
  pool = null;
}
