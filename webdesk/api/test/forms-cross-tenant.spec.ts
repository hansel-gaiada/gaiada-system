// WSK-10 — "cross-tenant probe on submissions" (ticket AC). This ticket builds no read-facing
// submissions endpoint (that is Sites-tab/console territory, WSK-23/24) — so the probe runs at the
// RLS layer directly, exactly like plaintext-dump-grep.spec.ts (WSK-05) and the WSK-04 cross-path
// suite do: as the RUNTIME role (webdesk_app, NOBYPASSRLS), with a REAL row this ticket's own HTTP
// endpoint wrote, under a DIFFERENT tenant's context.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { buildFormsTestApp, stopFormsTestApp } from "./forms-test-app";
import { createFixtureTenant, type FixtureTenant } from "./helpers/fixtures";
import { createFormDef, setEnvironmentDomain, probeCrossTenantSubmissionRead, readSubmission } from "./helpers/forms-fixtures";
import { turnstileConfig } from "../src/forms/forms.config";

const SCHEMA = { fields: [{ key: "name", type: "text", required: true, maxLength: 200 }] };

describe("WSK-10 — cross-tenant probe on submissions", () => {
  let app: NestFastifyApplication;
  let tenantA: FixtureTenant;
  let tenantB: FixtureTenant;
  const ALLOWED_DOMAIN = "cross-tenant.example.test";

  beforeAll(async () => {
    app = await buildFormsTestApp();
    tenantA = await createFixtureTenant("forms-xtenant-a");
    tenantB = await createFixtureTenant("forms-xtenant-b");
    await setEnvironmentDomain(tenantA, tenantA.productionEnvId, ALLOWED_DOMAIN);
  }, 30_000);

  afterAll(async () => {
    await stopFormsTestApp(app);
  });

  it("a submission written for tenant A is INVISIBLE under tenant B's context, and visible under its own", async () => {
    const form = await createFormDef(tenantA, { schema: SCHEMA });
    const res = await app.inject({
      method: "POST",
      url: `/v1/t/${tenantA.slug}/forms/${form.id}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.6.1",
      payload: { fields: { name: "Tenant A Submitter" }, consent: true, turnstileToken: turnstileConfig.stubPassToken },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json<{ id: string }>();

    // Same tenant: visible.
    const ownRow = await readSubmission(tenantA, id);
    expect(ownRow).not.toBeNull();

    // Wrong tenant, RUNTIME role, no BYPASSRLS anywhere in this database: zero rows, not an error
    // and not a "found but redacted" — the row simply does not exist from tenant B's vantage.
    const crossRows = await probeCrossTenantSubmissionRead(tenantB.tenantId, id);
    expect(crossRows).toHaveLength(0);
  });

  it("a wrong-tenant PUBLIC submit attempt against tenant A's form via tenant B's URL 404s (no existence oracle)", async () => {
    const form = await createFormDef(tenantA, { schema: SCHEMA });
    const res = await app.inject({
      method: "POST",
      // tenant B's slug, tenant A's real form id — form-lookup.service.ts's RLS-scoped lookup
      // returns nothing once the GUC is tenant B's, so this must 404, indistinguishable from a
      // genuinely nonexistent form id.
      url: `/v1/t/${tenantB.slug}/forms/${form.id}/submit`,
      headers: { origin: `https://${ALLOWED_DOMAIN}`, "content-type": "application/json" },
      remoteAddress: "10.0.6.2",
      payload: { fields: { name: "Cross Tenant Probe" }, consent: true, turnstileToken: turnstileConfig.stubPassToken },
    });
    expect(res.statusCode).toBe(404);
  });
});
