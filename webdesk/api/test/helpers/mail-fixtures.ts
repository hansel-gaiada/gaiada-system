// WSK-11 test fixtures — NEW file, additive only (does not edit helpers/app.ts or
// helpers/fixtures.ts, both WSK-05's files). Mirrors fixtures.ts's own pattern: writes directly
// over a raw pg client as webdesk_migrator, setting the same GUCs the real control plane would.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import type { FixtureTenant } from "./fixtures";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";

export async function createMailTemplate(
  tenant: FixtureTenant,
  opts: { key: string; subject: string; bodyHtml: string; bodyText?: string },
): Promise<string> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO mail_templates (id, tenant_id, site_id, key, subject, body_html, body_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, tenant.tenantId, tenant.siteId, opts.key, opts.subject, opts.bodyHtml, opts.bodyText ?? null],
    );
    await client.query("COMMIT");
    return id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function insertSuppression(
  tenant: FixtureTenant,
  address: string,
  reason: "bounce" | "complaint" | "manual" | "unsubscribe" = "manual",
): Promise<void> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO suppressions (tenant_id, address, reason) VALUES ($1, lower($2), $3)
       ON CONFLICT (tenant_id, address) DO NOTHING`,
      [tenant.tenantId, address, reason],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function readMailLogRow(
  tenant: FixtureTenant,
  mailLogId: string,
): Promise<Record<string, unknown> | null> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    const { rows } = await client.query(`SELECT * FROM mail_log WHERE id = $1`, [mailLogId]);
    await client.query("COMMIT");
    return rows[0] ?? null;
  } finally {
    await client.end();
  }
}

/** As webdesk_app (the runtime role, NOBYPASSRLS) — proves the DELETE claw-back
 * (`REVOKE DELETE ON mail_log FROM webdesk_app`, 0004_mail.sql) at the grant level, independent
 * of whether MailLogRepository ever issues one. */
export async function attemptDeleteMailLogAsAppRole(
  tenant: FixtureTenant,
  mailLogId: string,
): Promise<{ ok: boolean; error?: string }> {
  // Same variable name every other file in this ticket reads (APP_DATABASE_URL) — deliberately
  // NOT WSK05_TEST_DATABASE_URL (that name is WSK-05's own override, for a different test app
  // bootstrap this ticket does not use; mixing the two here was the exact bug that broke the
  // coordinator's first reproduction attempt).
  const appUrl =
    process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(`DELETE FROM mail_log WHERE id = $1`, [mailLogId]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await client.end();
  }
}
