// WSK-10 — file attachments MUST use WSK-07's PRIVATE `uploads` bucket + ClamAV (ticket brief).
// This file proves: (1) an EICAR-laced attachment is refused, exactly like a direct media upload
// would be — reusing MediaService.upload() in-process, not a bespoke scan path; (2) a clean
// attachment is accepted, stored in the PRIVATE bucket (never `media`/`video`, the CDN-exposed
// public ones), and is retrievable only via a presigned GET, never a public URL.
//
// The EICAR-in-a-PDF-stream fixture is the SAME construction media-eicar-scan.spec.ts (WSK-07)
// verified empirically against a real clamd — duplicated here rather than imported (spec files are
// not meant to be shared modules), same ~15 lines, same documented reasoning.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Client } from "pg";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, setEnvironmentDomain, readSubmission } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function buildEicarPdf(): Buffer {
  const stream = Buffer.from(EICAR, "ascii");
  const head = Buffer.from(
    "%PDF-1.4\n" +
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
      "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
      "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>\nendobj\n" +
      `4 0 obj\n<< /Length ${stream.length} >>\nstream\n`,
    "ascii",
  );
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF", "ascii");
  return Buffer.concat([head, stream, tail]);
}

const SCHEMA = {
  fields: [{ key: "name", type: "text", required: true, maxLength: 200 }],
  attachments: { allowed: true, maxCount: 3 },
};

describe("WSK-10 — form attachments use the PRIVATE uploads bucket + ClamAV", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let formId: string;
  const ALLOWED_DOMAIN = "attachments.example.test";

  beforeAll(async () => {
    app = await buildFormsTestApp();
    tenant = await createFixtureTenant("forms-attach");
    await setEnvironmentDomain(tenant, tenant.productionEnvId, ALLOWED_DOMAIN);
    const form = await createFormDef(tenant, { schema: SCHEMA });
    formId = form.id;
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
  });

  function submitWithAttachment(attachment: { filename: string; contentType: string; contentBase64: string }, remoteAddress: string) {
    return app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress,
      payload: {
        fields: { name: "Attacher" },
        consent: true,
        turnstileToken: turnstileConfig.stubPassToken,
        attachments: [attachment],
      },
    });
  }

  it("refuses an EICAR-laced attachment with 403 and does not create a submission row", async () => {
    const res = await submitWithAttachment(
      { filename: "resume.pdf", contentType: "application/pdf", contentBase64: buildEicarPdf().toString("base64") },
      "10.0.7.1",
    );
    expect(res.statusCode).toBe(403);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/malware scan matched/i);
  }, 20_000);

  it("accepts a clean attachment, stores it in the PRIVATE `uploads` bucket, and the submission payload references it by media_asset id only", async () => {
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("clean bytes, not a real image")]);
    const res = await submitWithAttachment(
      { filename: "photo.png", contentType: "image/png", contentBase64: buffer.toString("base64") },
      "10.0.7.2",
    );
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    const row = await readSubmission(tenant, id);
    const payload = (row as { payload: { attachments: { mediaAssetId: string; filename: string; mime: string }[] } }).payload;
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0].filename).toBe("photo.png");
    expect(payload.attachments[0].mediaAssetId).toBeTruthy();

    // Stored in `uploads` (PRIVATE), scan_status clean — direct DB check, since this ticket builds
    // no read endpoint for form attachments (WSK-07's own presigned-GET route is the only way one
    // is ever fetched back, and it requires an api key this public submit flow never has).
    const client = new Client({ connectionString: process.env.MIGRATE_DATABASE_URL });
    await client.connect();
    try {
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, false)", [tenant.tenantId]);
      const { rows } = await client.query<{ bucket_key: string; scan_status: string }>(
        `SELECT bucket_key, scan_status FROM media_assets WHERE id = $1`,
        [payload.attachments[0].mediaAssetId],
      );
      expect(rows[0].scan_status).toBe("clean");
      expect(rows[0].bucket_key.startsWith("uploads/")).toBe(true); // never media/ or video/ — never CDN-exposed
    } finally {
      await client.end();
    }
  }, 20_000);

  it("refuses more attachments than the form's configured maxCount", async () => {
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("x")]);
    const attachment = { filename: "a.png", contentType: "image/png", contentBase64: buffer.toString("base64") };
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/forms/${formId}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.7.3",
      payload: {
        fields: { name: "Too Many" },
        consent: true,
        turnstileToken: turnstileConfig.stubPassToken,
        attachments: [attachment, attachment, attachment, attachment],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.json<{ message?: string }>().message)).toMatch(/too many attachments/i);
  });
});
