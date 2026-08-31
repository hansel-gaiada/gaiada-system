// WSK-10 test fixtures — NEW file, additive only (does not edit helpers/app.ts or
// helpers/fixtures.ts, both WSK-05's files, or helpers/mail-fixtures.ts, WSK-11's). Mirrors
// fixtures.ts's own pattern: writes directly over a raw pg client as webdesk_migrator, setting the
// same GUCs the real control plane would.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import type { FixtureTenant } from "./fixtures";

const MIGRATOR_URL =
  process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk";
const APP_URL = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55450/webdesk";

export type FixtureFormDef = {
  id: string;
  key: string;
  siteId: string;
};

async function withMigrator<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Sets an environment's public domain — the CORS-allowlist source (form-lookup.service.ts). Pass
 *  a bare host (`"example.test"`), never a scheme — origins are derived from it at request time. */
export async function setEnvironmentDomain(tenant: FixtureTenant, envId: string, domain: string): Promise<void> {
  await withMigrator(async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(`UPDATE environments SET domain = $1 WHERE id = $2 AND tenant_id = $3`, [
      domain,
      envId,
      tenant.tenantId,
    ]);
    await client.query("COMMIT");
  });
}

export async function createFormDef(
  tenant: FixtureTenant,
  opts: {
    key?: string;
    siteId?: string;
    schema?: Record<string, unknown>;
    notify?: Record<string, unknown>;
    retentionDays?: number;
    consentNoticeVersion?: string | null;
  } = {},
): Promise<FixtureFormDef> {
  return withMigrator(async (client) => {
    const id = randomUUID();
    const key = opts.key ?? `form-${randomUUID().slice(0, 8)}`;
    const siteId = opts.siteId ?? tenant.siteId;
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO form_defs (id, tenant_id, site_id, key, schema, notify, retention_days, consent_notice_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
      [
        id,
        tenant.tenantId,
        siteId,
        key,
        JSON.stringify(opts.schema ?? {}),
        JSON.stringify(opts.notify ?? {}),
        opts.retentionDays ?? 180,
        opts.consentNoticeVersion ?? "v1",
      ],
    );
    await client.query("COMMIT");
    return { id, key, siteId };
  });
}

export async function createMailTemplateForForm(
  tenant: FixtureTenant,
  opts: { key: string; subject: string; bodyHtml: string; bodyText?: string },
): Promise<string> {
  return withMigrator(async (client) => {
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
  });
}

export async function readSubmission(tenant: FixtureTenant, submissionId: string): Promise<Record<string, unknown> | null> {
  return withMigrator(async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    const { rows } = await client.query(`SELECT * FROM submissions WHERE id = $1`, [submissionId]);
    await client.query("COMMIT");
    return rows[0] ?? null;
  });
}

export async function countSubmissionsForForm(tenant: FixtureTenant, formDefId: string): Promise<number> {
  return withMigrator(async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM submissions WHERE form_def_id = $1`,
      [formDefId],
    );
    await client.query("COMMIT");
    return Number(rows[0].count);
  });
}

/** Backdates a submission's `created_at` AND `expires_at` together into the past, for the
 *  retention-purge-walk test — the ONLY reason this ticket ever writes to these columns directly
 *  rather than through the app's own `now() + make_interval(...)` insert path. Both columns move
 *  together because `submissions_check` (0003_forms.sql: `CHECK (expires_at > created_at)`) would
 *  otherwise reject a row whose `expires_at` moved into the past while `created_at` stayed at "just
 *  now" — `expiresAt` must already be BEFORE now for the row to read as "due" to the purge sweep,
 *  so `created_at` has to move further back still to keep the CHECK satisfied. */
export async function backdateSubmissionExpiry(tenant: FixtureTenant, submissionId: string, expiresAt: Date): Promise<void> {
  const createdAt = new Date(expiresAt.getTime() - 60_000); // 1 minute before expiresAt — still satisfies the CHECK
  await withMigrator(async (client) => {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(`UPDATE submissions SET created_at = $1, expires_at = $2 WHERE id = $3`, [
      createdAt.toISOString(),
      expiresAt.toISOString(),
      submissionId,
    ]);
    await client.query("COMMIT");
  });
}

/** The cross-tenant RLS probe: as the RUNTIME role (webdesk_app, NOBYPASSRLS — never the
 *  migrator), set tenant B's context and attempt to read tenant A's submission by id. Proves
 *  submissions' `tenant_isolation` policy (0003_forms.sql) holds for rows THIS TICKET wrote,
 *  independent of any read-facing HTTP route (none exists yet — see submissions.repository.ts's
 *  header). */
export async function probeCrossTenantSubmissionRead(wrongTenantId: string, submissionId: string): Promise<Record<string, unknown>[]> {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, false)", [wrongTenantId]);
    const { rows } = await client.query(`SELECT * FROM submissions WHERE id = $1`, [submissionId]);
    await client.query("COMMIT");
    return rows;
  } finally {
    await client.end();
  }
}
