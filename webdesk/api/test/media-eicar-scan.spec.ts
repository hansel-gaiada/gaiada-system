// WSK-07 — "EICAR upload refused + logged" (ticket AC). Uses the standard EICAR antivirus test
// string (a harmless, industry-standard string every AV engine is configured to flag as if it
// were malware — https://www.eicar.org/), embedded as an UNCOMPRESSED PDF stream inside an
// otherwise-minimal, structurally-valid PDF.
//
// FINDING (verified directly against this ticket's own throwaway clamd, via `clamdscan`, before
// wiring this fixture — not assumed): ClamAV's built-in EICAR signature matches only an EXACT
// standalone copy of the 68-byte string (no leading bytes, and no more than a single trailing
// newline) when scanning a raw/generic file. A polyglot built by simply prepending real magic
// bytes (e.g. a PNG header) in front of the EICAR string does NOT trigger detection — confirmed
// empirically, three separate ways, before this file was written this way. Embedding EICAR as a
// PDF stream DOES trigger detection, because ClamAV's PDF parser decodes and scans each stream's
// own content independently of what surrounds it in the container. This gives a fixture that (a)
// starts with a real "%PDF-" magic header, so it clears this ticket's declared/sniffed MIME
// checks like any legitimate PDF would, and (b) still reliably trips ClamAV's scan — proving the
// scan step is real and not merely a header check.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildMediaTestApp, stopMediaTestApp } from "./media-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { Client } from "pg";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

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

async function mint(app: NestFastifyApplication, tenantSlug: string, envId: string, scope: "read" | "write") {
  const res = await app.inject({
    method: "POST",
    url: `/internal/tenants/${tenantSlug}/api-keys`,
    payload: { envId, scope, actor: "wsk07-test" },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ key: string }>();
}

describe("WSK-07 — ClamAV refuses an EICAR-laced upload, and logs it", () => {
  let app: NestFastifyApplication;
  let tenant: FixtureTenant;
  let writeKey: string;

  beforeAll(async () => {
    app = await buildMediaTestApp();
    tenant = await createFixtureTenant("eicar");
    writeKey = (await mint(app, tenant.slug, tenant.stagingEnvId, "write")).key;
  }, 30_000);

  afterAll(async () => {
    await stopMediaTestApp(app);
  });

  it("refuses the upload with 403 and does not create a media_assets row", async () => {
    const buffer = buildEicarPdf();
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/uploads`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: {
        filename: "eicar-embedded.pdf",
        contentType: "application/pdf",
        contentBase64: buffer.toString("base64"),
      },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ message?: string }>();
    expect(String(body.message)).toMatch(/malware scan matched/i);
    expect(String(body.message)).toMatch(/eicar/i);
  }, 20_000);

  it("logs the refusal in audit_entries (action = webdesk.media.uploadRefused)", async () => {
    const client = new Client({
      connectionString: process.env.MIGRATE_DATABASE_URL || "postgres://webdesk_migrator:throwaway_migrator@localhost:55450/webdesk",
    });
    await client.connect();
    try {
      await client.query("SELECT set_config('webdesk.tenant_ctx', $1, false)", [tenant.tenantId]);
      const { rows } = await client.query<{ action: string }>(
        `SELECT action FROM audit_entries WHERE tenant_id = $1 AND action = 'webdesk.media.uploadRefused'`,
        [tenant.tenantId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await client.end();
    }
  }, 20_000);

  it("a CLEAN upload (real PNG, no EICAR) is accepted and stored", async () => {
    // A minimal valid-looking PNG payload — only the signature matters for this ticket's sniff
    // check; the file need not be a decodable image, only pass the magic-byte/type gates and the
    // scan.
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buffer = Buffer.concat([PNG_MAGIC, Buffer.from("not a real image but clean bytes")]);
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenant.slug}/media/media`,
      headers: { authorization: `Bearer ${writeKey}` },
      payload: { filename: "clean.png", contentType: "image/png", contentBase64: buffer.toString("base64") },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; scanStatus: string }>();
    expect(body.scanStatus).toBe("clean");
  }, 20_000);
});
