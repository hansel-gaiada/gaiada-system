// WSK-38 — erase proofs: the hard part. Verifies (a) submission rows are SCRUBBED not deleted and
// data_subject_ref is cleared, (b) the underlying MinIO object is ACTUALLY gone (HeadObject 404,
// not just "the media_assets row disappeared"), (c) double-fire under the SAME idempotency key
// produces exactly one effect, (d) cross-tenant isolation holds, and (e) THE AUDIT TRAIL SURVIVES
// THE ERASURE — dsr_requests + audit_entries rows for this erase remain readable, with correct
// counts, after the erasure they describe has completed and even after a second `find` call
// confirms the identifier no longer resolves to anything.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildPrivacyTestApp, stopPrivacyTestApp, privacyHeaders } from "./privacy-test-app";
import {
  createFixtureTenant,
  insertFormDef,
  insertSubmission,
  putFixtureAttachment,
  objectExistsInUploads,
  withTenantRaw,
  withTenantAsApp,
} from "./privacy-fixtures";

describe("privacy.erase", () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await buildPrivacyTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses without a WS4 assertion (HIGH impact, webdesk:promote scope)", async () => {
    const tenant = await createFixtureTenant("erase-noWs4");
    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], idempotencyKey: randomUUID() }),
      payload: { identifier: "nobody@example.com" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("scrubs the submission (payload={}, status='erased', data_subject_ref=NULL) and DELETES the real MinIO object", async () => {
    const tenant = await createFixtureTenant("erase-full");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `erase-${randomUUID().slice(0, 8)}@example.com`;
    const attachment = await putFixtureAttachment(tenant, { filename: "secret.txt", contentType: "text/plain", body: Buffer.from("erase me") });
    const submissionId = await insertSubmission(tenant, formDefId, {
      fields: { email, name: "Erase Me" },
      attachments: [attachment],
      dataSubjectRef: email.toLowerCase(),
    });

    // Prove the object exists BEFORE erase (otherwise a later 404 proves nothing).
    const objectKeySuffix = await withTenantRaw(tenant.tenantId, async (client) => {
      const { rows } = await client.query(`SELECT bucket_key FROM media_assets WHERE id = $1`, [attachment.mediaAssetId]);
      return (rows[0].bucket_key as string).replace(/^uploads\//, "");
    });
    expect(await objectExistsInUploads(tenant, objectKeySuffix)).toBe(true);

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
      payload: { identifier: email },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.submissionCount).toBe(1);
    expect(body.attachmentCount).toBe(1);

    // The row SURVIVES (scrub, not delete) but carries no PII any more.
    const row = await withTenantRaw(tenant.tenantId, async (client) => {
      const { rows } = await client.query(`SELECT id, status, payload, data_subject_ref, consent_notice_text FROM submissions WHERE id = $1`, [
        submissionId,
      ]);
      return rows[0];
    });
    expect(row).toBeTruthy();
    expect(row.status).toBe("erased");
    expect(row.payload).toEqual({});
    expect(row.data_subject_ref).toBeNull();
    // Consent evidence is DELIBERATELY preserved (design decision — see migrations/0007's header).
    expect(row.consent_notice_text).toBeTruthy();

    // The media_assets row is gone (no evidentiary purpose once the object is gone).
    const mediaRow = await withTenantRaw(tenant.tenantId, (client) => client.query(`SELECT id FROM media_assets WHERE id = $1`, [attachment.mediaAssetId]));
    expect(mediaRow.rows).toHaveLength(0);

    // THE REAL PROOF: the object is actually gone from storage, not just unreferenced.
    expect(await objectExistsInUploads(tenant, objectKeySuffix)).toBe(false);

    // A subsequent find no longer resolves the identifier — the correlator was actually cleared.
    const findAfter = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/find`,
      headers: privacyHeaders({ scopes: ["webdesk:operate"], ws4: randomUUID() }),
      payload: { identifier: email },
    });
    expect(findAfter.json().matches).toHaveLength(0);
  });

  it("THE AUDIT TRAIL SURVIVES THE ERASURE: dsr_requests + audit_entries rows for the erase remain readable, correct, and hold only a hash", async () => {
    const tenant = await createFixtureTenant("erase-audit");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `audit-survives-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenant, formDefId, { fields: { email }, dataSubjectRef: email.toLowerCase() });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
      payload: { identifier: email },
    });
    expect(res.statusCode).toBe(201);

    // Query AFTER the erasure — this is the load-bearing timing: the row must still be there once
    // the data it describes no longer is.
    const dsr = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT kind, subject_ref_hash, submission_count, attachment_count FROM dsr_requests WHERE tenant_id = $1 AND kind = 'erase'`, [
        tenant.tenantId,
      ]),
    );
    expect(dsr.rows).toHaveLength(1);
    expect(dsr.rows[0].submission_count).toBe(1);
    expect(dsr.rows[0].subject_ref_hash).not.toContain(email);
    expect(dsr.rows[0].subject_ref_hash).toMatch(/^[0-9a-f]{64}$/);

    const audit = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT action, args_hash, ws4_approval_id FROM audit_entries WHERE tenant_id = $1 AND action = 'control.privacy.erase'`, [tenant.tenantId]),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].args_hash).not.toContain(email);
    expect(audit.rows[0].ws4_approval_id).toBeTruthy();

    // Immutability: webdesk_app cannot UPDATE/DELETE either ledger row (0007's own REVOKE, mirrors
    // audit_entries' pre-existing one) — proven by attempting it as the ACTUAL RUNTIME ROLE
    // (webdesk_app), not the migrator (which owns the table and is never subject to the REVOKE).
    await expect(
      withTenantAsApp(tenant.tenantId, (client) => client.query(`DELETE FROM dsr_requests WHERE tenant_id = $1`, [tenant.tenantId])),
    ).rejects.toThrow();
    await expect(
      withTenantAsApp(tenant.tenantId, (client) => client.query(`UPDATE dsr_requests SET submission_count = 999 WHERE tenant_id = $1`, [tenant.tenantId])),
    ).rejects.toThrow();

    // And the row really is still there, unmodified, after both refused attempts.
    const stillThere = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT submission_count FROM dsr_requests WHERE tenant_id = $1 AND kind = 'erase'`, [tenant.tenantId]),
    );
    expect(stillThere.rows).toHaveLength(1);
    expect(stillThere.rows[0].submission_count).toBe(1);
  });

  it("double-fire with the SAME idempotency key produces exactly ONE erasure (no double-delete, no double dsr_requests row)", async () => {
    const tenant = await createFixtureTenant("erase-idem");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `idem-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenant, formDefId, { fields: { email }, dataSubjectRef: email.toLowerCase() });

    const idempotencyKey = randomUUID();
    const hdrs = privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey });
    const payload = { identifier: email };

    const first = await app.inject({ method: "POST", url: `/control/v1/tenants/${tenant.slug}/privacy/erase`, headers: hdrs, payload });
    const second = await app.inject({ method: "POST", url: `/control/v1/tenants/${tenant.slug}/privacy/erase`, headers: hdrs, payload });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().replayed).toBe(false);
    expect(second.json().replayed).toBe(true);
    expect(second.json().dsrRequestId).toBe(first.json().dsrRequestId);

    const dsrCount = await withTenantRaw(tenant.tenantId, (client) =>
      client.query(`SELECT count(*)::int AS n FROM dsr_requests WHERE tenant_id = $1 AND kind = 'erase'`, [tenant.tenantId]),
    );
    expect(dsrCount.rows[0].n).toBe(1);
  });

  it("re-running erase after a subject is already erased is a successful no-op (submissionCount=0), not an error", async () => {
    const tenant = await createFixtureTenant("erase-repeat");
    const formDefId = await insertFormDef(tenant, "contact");
    const email = `repeat-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenant, formDefId, { fields: { email }, dataSubjectRef: email.toLowerCase() });

    const first = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
      payload: { identifier: email },
    });
    expect(first.json().submissionCount).toBe(1);

    // A DIFFERENT idempotency key (simulating a genuinely new, later request from an operator who
    // does not know it was already handled) — must still succeed, finding nothing left to erase.
    const second = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenant.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
      payload: { identifier: email },
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().submissionCount).toBe(0);
    expect(second.json().attachmentCount).toBe(0);
  });

  it("cross-tenant isolation: erasing an identifier in tenant A never touches tenant B's matching row", async () => {
    const tenantA = await createFixtureTenant("erase-xtenant-a");
    const tenantB = await createFixtureTenant("erase-xtenant-b");
    const formDefA = await insertFormDef(tenantA, "contact");
    const formDefB = await insertFormDef(tenantB, "contact");
    const sharedEmail = `xtenant-erase-${randomUUID().slice(0, 8)}@example.com`;
    await insertSubmission(tenantA, formDefA, { fields: { email: sharedEmail }, dataSubjectRef: sharedEmail });
    const submissionBId = await insertSubmission(tenantB, formDefB, { fields: { email: sharedEmail }, dataSubjectRef: sharedEmail });

    const res = await app.inject({
      method: "POST",
      url: `/control/v1/tenants/${tenantA.slug}/privacy/erase`,
      headers: privacyHeaders({ scopes: ["webdesk:promote"], ws4: randomUUID(), idempotencyKey: randomUUID() }),
      payload: { identifier: sharedEmail },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().submissionCount).toBe(1);

    const rowB = await withTenantRaw(tenantB.tenantId, (client) => client.query(`SELECT status, data_subject_ref FROM submissions WHERE id = $1`, [submissionBId]));
    expect(rowB.rows[0].status).toBe("received");
    expect(rowB.rows[0].data_subject_ref).toBe(sharedEmail);
  });
});
