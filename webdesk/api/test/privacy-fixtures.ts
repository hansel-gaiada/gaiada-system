// WSK-38 test fixtures — a NEW file (this ticket does not edit test/helpers/fixtures.ts, which
// belongs to WSK-05/others), same raw-pg-as-migrator approach that file's own header documents:
// provisioning a tenant/site/form_def is control-plane/forms-service territory this ticket does
// not own, so fixtures go in directly, setting the same GUCs the real app would. Every fixture
// uses a fresh random slug/id per call so test files never collide with each other or with another
// concurrent session's own throwaway database.
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { S3Client, PutObjectCommand, CreateBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const MIGRATOR_URL = process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55530/webdesk";
const STORAGE_ENDPOINT = process.env.STORAGE_ENDPOINT || "http://localhost:55531";
const STORAGE_ACCESS_KEY_ID = process.env.STORAGE_ACCESS_KEY_ID || "webdesk_minio";
const STORAGE_SECRET_ACCESS_KEY = process.env.STORAGE_SECRET_ACCESS_KEY || "changeme_minio_password";
const UPLOADS_BUCKET = process.env.MINIO_BUCKET_UPLOADS || "uploads";

export type FixtureTenant = { tenantId: string; slug: string; siteId: string };

export async function createFixtureTenant(label: string): Promise<FixtureTenant> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const slug = `wsk38-${label}-${randomUUID().slice(0, 8)}`;
    const tenantId = randomUUID();
    const siteId = randomUUID();

    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    await client.query(`INSERT INTO tenants (id, slug, company_ref, status) VALUES ($1, $2, $3, 'active')`, [
      tenantId,
      slug,
      randomUUID(),
    ]);
    await client.query("SET LOCAL webdesk.platform_ctx = ''");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    await client.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [siteId, tenantId, `${label} site`]);
    await client.query("COMMIT");

    return { tenantId, slug, siteId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

export async function insertFormDef(tenant: FixtureTenant, key: string): Promise<string> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO form_defs (id, tenant_id, site_id, key, schema, notify, retention_days, consent_notice_version)
       VALUES ($1, $2, $3, $4, '{}'::jsonb, '{}'::jsonb, 180, 'v1')`,
      [id, tenant.tenantId, tenant.siteId, key],
    );
    await client.query("COMMIT");
    return id;
  } finally {
    await client.end();
  }
}

export type FixtureAttachment = { mediaAssetId: string; filename: string; mime: string; sizeBytes: number };

export async function insertSubmission(
  tenant: FixtureTenant,
  formDefId: string,
  opts: {
    fields: Record<string, unknown>;
    attachments?: FixtureAttachment[];
    dataSubjectRef?: string | null;
    status?: string;
    consentText?: string;
    consentVersion?: string;
    expiresInDays?: number;
  },
): Promise<string> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    const payload = { fields: opts.fields, attachments: opts.attachments ?? [] };
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO submissions (
         id, tenant_id, site_id, form_def_id, payload, status,
         consent_notice_text, consent_notice_version, consent_accepted_at,
         data_subject_ref, expires_at
       )
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, now(), $9, now() + make_interval(days => $10))`,
      [
        id,
        tenant.tenantId,
        tenant.siteId,
        formDefId,
        JSON.stringify(payload),
        opts.status ?? "received",
        opts.consentText ?? "By submitting this form you consent to processing.",
        opts.consentVersion ?? "v1",
        opts.dataSubjectRef ?? null,
        opts.expiresInDays ?? 180,
      ],
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

/** Puts a real object into the throwaway MinIO's `uploads` bucket AND records the media_assets row
 *  that points at it — the exact `<bucket>/<objectKey>` encoding media/bucket-key-codec.ts uses,
 *  reproduced here (read-only reference to that module's documented format, not an import, so this
 *  fixture has no compile-time dependency on media/** internals beyond the format it already
 *  documents publicly in its own header). */
export async function putFixtureAttachment(
  tenant: FixtureTenant,
  opts: { filename: string; contentType: string; body: Buffer },
): Promise<FixtureAttachment> {
  const s3 = new S3Client({
    endpoint: STORAGE_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: STORAGE_ACCESS_KEY_ID, secretAccessKey: STORAGE_SECRET_ACCESS_KEY },
  });
  await s3.send(new CreateBucketCommand({ Bucket: UPLOADS_BUCKET })).catch(() => {});
  const objectKey = `${tenant.tenantId}/${tenant.siteId}/${randomUUID()}-${opts.filename}`;
  await s3.send(new PutObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKey, Body: opts.body, ContentType: opts.contentType }));

  const bucketKey = `uploads/${objectKey}`;
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    const id = randomUUID();
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenant.tenantId]);
    await client.query(
      `INSERT INTO media_assets (id, tenant_id, site_id, bucket_key, mime, size_bytes, scan_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'clean')`,
      [id, tenant.tenantId, tenant.siteId, bucketKey, opts.contentType, opts.body.length],
    );
    await client.query("COMMIT");
    return { mediaAssetId: id, filename: opts.filename, mime: opts.contentType, sizeBytes: opts.body.length };
  } finally {
    await client.end();
  }
}

/** Proves an object was ACTUALLY deleted from storage, not just that the DB row is gone — the
 *  erasure test's own load-bearing assertion. */
export async function objectExistsInUploads(tenant: FixtureTenant, objectKeySuffix: string): Promise<boolean> {
  const s3 = new S3Client({
    endpoint: STORAGE_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: STORAGE_ACCESS_KEY_ID, secretAccessKey: STORAGE_SECRET_ACCESS_KEY },
  });
  try {
    await s3.send(new HeadObjectCommand({ Bucket: UPLOADS_BUCKET, Key: objectKeySuffix }));
    return true;
  } catch {
    return false;
  }
}

/** Raw read helper — connects as migrator, never trusts the app's own read path to prove the
 *  app's own write path (same discipline test/control-commands.spec.ts's withPlatform/withTenant
 *  helpers use). */
export async function withTenantRaw<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

/** Connects as `webdesk_app` (APP_DATABASE_URL), NOT the migrator — the immutability proof
 *  (0007_privacy_dsr.sql's `REVOKE UPDATE, DELETE ON dsr_requests FROM webdesk_app`) is a claim
 *  about the RUNTIME role, and withTenantRaw above deliberately connects as the migrator (which
 *  owns every table and is never subject to that REVOKE) for every other raw-verification query in
 *  this suite — using it for an immutability check would prove nothing. */
export async function withTenantAsApp<T>(tenantId: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const appUrl = process.env.APP_DATABASE_URL || "postgres://webdesk_app:throwaway_app@localhost:55530/webdesk";
  const client = new Client({ connectionString: appUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}

export async function withPlatformRaw<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: MIGRATOR_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL webdesk.platform_ctx = 'true'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    await client.end();
  }
}
