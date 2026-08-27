// WSK-38 — find/export proofs. Verification runbook: ../README.md's "WSK-38" section (throwaway
// Postgres + MinIO, port block 55530-55531).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildPrivacyTestApp, stopPrivacyTestApp, privacyHeaders } from "./privacy-test-app";
import { createFixtureTenant, insertFormDef, insertSubmission, putFixtureAttachment, withTenantRaw } from "./privacy-fixtures";

describe("privacy.find / privacy.export", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildPrivacyTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("find matches by the data_subject_ref correlator (email) and returns a summary, no field values", async () => {
    const tenant = await createFixtureTenant("find-email");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `jane-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenant, formDefId, { fields: { email, name: "Jane Doe", message: "hi" }, dataSubjectRef: email.toLowerCase() });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: email.toUpperCase() }, // case-insensitivity proof
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].status).toBe("received");
    // Summary only — no `fields`/`payload` key anywhere in a find response.
    expect(JSON.stringify(body)).not.toContain('"fields"');
  });

  it("find ALSO matches a form field VALUE that is not the email correlator (design §11: 'identifying fields a form actually collected — email/phone')", async () => {
    const tenant = await createFixtureTenant("find-phone");
    const formDefId = await insertFormDef(tenant, "contact");
    const phone = `+62812${randomUUID().slice(0, 6)}`;
    // No dataSubjectRef set — this form only collected a phone number, no email field.
    await insertSubmission(tenant, formDefId, { fields: { phone, name: "Budi" }, dataSubjectRef: null });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: phone },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().matches).toHaveLength(1);
  });

  it("find refuses without a WS4 assertion — HIGH impact, per this ticket's explicit gating decision", async () => {
    const tenant = await createFixtureTenant("find-noWs4");
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"] }), // no ws4
      payload: { identifier: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("find records a dsr_requests row carrying a HASH of the identifier, never the plaintext value", async () => {
    const tenant = await createFixtureTenant("find-audit");
    const email = `hash-proof-${randomUUID().slice(0, 8)}@example.com`;

    await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: email },
    });

    const rows = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT kind, subject_ref_hash, submission_count FROM dsr_requests WHERE tenant_id = $1`, [tenant.tenantId]),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].kind).toBe("find");
    expect(rows.rows[0].subject_ref_hash).not.toContain(email);
    expect(rows.rows[0].subject_ref_hash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex, not the raw value

    // The generic control-plane audit row must ALSO never carry the raw identifier.
    const auditRows = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT action, args_hash FROM audit_entries WHERE tenant_id = $1 AND action = 'control.privacy.find'`, [tenant.tenantId]),
    );
    expect(auditRows.rows).toHaveLength(1);
    expect(auditRows.rows[0].args_hash).not.toContain(email);
  });

  it("export returns full field values AND fetches the real attachment bytes from MinIO", async () => {
    const tenant = await createFixtureTenant("export-full");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `export-${randomUUID().slice(0, 8)}@example.com`;
    const fileBytes = Buffer.from("hello dsr export");
    const attachment = await putFixtureAttachment(tenant, { filename: "note.txt", contentType: "text/plain", body: fileBytes });
    await insertSubmission(tenant, formDefId, {
      fields: { email, name: "Export Test", message: "please export me" },
      attachments: [attachment],
      dataSubjectRef: email.toLowerCase(),
    });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/export`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: email },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.submissions).toHaveLength(1);
    expect(body.submissions[0].fields.email).toBe(email);
    expect(body.submissions[0].fields.message).toBe("please export me");
    expect(body.submissions[0].consent.text).toBeTruthy();
    expect(body.submissions[0].attachments).toHaveLength(1);
    expect(body.submissions[0].attachments[0].unavailableReason).toBeNull();
    const decoded = Buffer.from(body.submissions[0].attachments[0].contentBase64, "base64");
    expect(decoded.toString("utf8")).toBe("hello dsr export");
  });

  it("export refuses without a WS4 assertion", async () => {
    const tenant = await createFixtureTenant("export-noWs4");
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/export`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"] }),
      payload: { identifier: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("cross-tenant isolation: tenant B's matching identifier is invisible to tenant A's find", async () => {
    const tenantA = await createFixtureTenant("xtenant-a");
    const tenantB = await createFixtureTenant("xtenant-b");
    const formDefB = await insertFormDef(tenantB, "contact");
    const sharedEmail = `shared-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenantB, formDefB, { fields: { email: sharedEmail }, dataSubjectRef: sharedEmail });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenantA.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: sharedEmail },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().matches).toHaveLength(0);
  });
});
