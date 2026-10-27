// WSK-40 — done-when (4) and (5): the END-TO-END PAIRING, run inside the Linux gate against a REAL
// WebDesk api. Nothing on the WebDesk side is a stub:
//
//   ERP (this process)                                      WebDesk (a separate container)
//   ─────────────────────                                   ──────────────────────────────
//   real NestJS app, real Postgres, real Cerbos              webdesk/api `node dist/main.js`, NODE_ENV≠test,
//   WSK-66 decide() → executeApprovedWebdeskCommand          so EVERY real layer is bound:
//   the REAL Ed25519 signer, registered by the boot            L1 mTLS (pinned CA, CN allow-list)
//     function main.ts calls (wireWebdeskEditorialSigner)      L2 Keycloak-shaped token, verified offline (JWKS)
//   the REAL egress client (webdesk-control-client.ts)          L3 scopes · L4 WS4 HMAC + single use
//     over mTLS to an nginx-equivalent edge that verifies      L2e WSK-40's verifier: pinned JWKS FILE + Redis jti
//     the client cert and forwards $ssl_client_escaped_cert    WSK-41's content commands on real Postgres
//
// The edge and the token issuer are the gate's stand-ins for host nginx (WSK-63a) and Keycloak; both
// are infrastructure the live channel already has. Everything is configured by env (the gate script
// sets it); without it this file SKIPS, so the ordinary suite is unaffected.
//
//   WSK40_E2E_PHASE                pairing | rotation-overlap | rotation-removed
//   WSK40_E2E_BASE_URL             https://control.webdesk.internal:8443
//   WSK40_E2E_PKI_DIR              client.crt, client.key, ca.crt
//   WSK40_E2E_TOKEN_URL            the token endpoint
//   WSK40_E2E_WS4_KEY              = WebDesk's WEBDESK_APPROVAL_ASSERTION_KEY
//   WSK40_E2E_SIGNING_KEY_FILE / WSK40_E2E_SIGNING_KID          the CURRENT ERP key
//   WSK40_E2E_OLD_SIGNING_KEY_FILE / WSK40_E2E_OLD_SIGNING_KID  rotation phases: the retiring key
//   WSK40_E2E_WEBDESK_MIGRATOR_URL WebDesk's Postgres (seed the tenant; read back what landed)
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { assemblePrincipal } from "../../rbac/principal";
import { WebdeskControlClient } from "./webdesk-control-client";
import { commandArgsAsZoneBSeesThem, computeCommandHash } from "./webdesk-ws4-assertion";
import { fileWebdeskCommandApproval, setWebdeskApprovedCommandDepsForTests, type EditorialAssertionRequest } from "./webdesk-approved-command";
import { loadWebdeskEditorialSigner, wireWebdeskEditorialSigner } from "./webdesk-editorial-signer";

const E = {
  phase: process.env.WSK40_E2E_PHASE ?? "",
  baseUrl: process.env.WSK40_E2E_BASE_URL ?? "",
  pki: process.env.WSK40_E2E_PKI_DIR ?? "",
  tokenUrl: process.env.WSK40_E2E_TOKEN_URL ?? "",
  ws4Key: process.env.WSK40_E2E_WS4_KEY ?? "",
  keyFile: process.env.WSK40_E2E_SIGNING_KEY_FILE ?? "",
  kid: process.env.WSK40_E2E_SIGNING_KID ?? "",
  oldKeyFile: process.env.WSK40_E2E_OLD_SIGNING_KEY_FILE ?? "",
  oldKid: process.env.WSK40_E2E_OLD_SIGNING_KID ?? "",
  webdeskDb: process.env.WSK40_E2E_WEBDESK_MIGRATOR_URL ?? "",
};
const channel = !!(E.baseUrl && E.pki && E.tokenUrl && E.ws4Key && E.keyFile && E.kid && E.webdeskDb);
const pairing = channel && E.phase === "pairing" && !!TEST_URL && !!process.env.CERBOS_URL;
const rotation = channel && (E.phase === "rotation-overlap" || E.phase === "rotation-removed") && !!(E.oldKeyFile && E.oldKid);

const PAGE_COMPOSITION = { fields: [{ name: "url", primitive: "text", required: true }, { name: "h1", primitive: "text" }], blocks: [] };

function newClient(): WebdeskControlClient {
  return new WebdeskControlClient({
    baseUrl: E.baseUrl,
    clientCertFile: join(E.pki, "client.crt"),
    clientKeyFile: join(E.pki, "client.key"),
    caFile: join(E.pki, "ca.crt"),
    tokenUrl: E.tokenUrl,
    clientId: "webdesk-control",
    clientSecret: "wsk40-gate-client-secret",
    ws4Key: E.ws4Key,
    retryAttempts: 1,
    timeoutMs: 15_000,
    breakerThreshold: 1000,
  });
}

/** A WebDesk tenant (en), a site with staging + production, and one `page` collection — as the migrator. */
async function seedWebdesk(label: string): Promise<{ slug: string; siteId: string; tenantId: string }> {
  const c = new Client({ connectionString: E.webdeskDb });
  await c.connect();
  try {
    const slug = `wsk40-${label}-${randomUUID().slice(0, 8)}`;
    const tenantId = randomUUID();
    const siteId = randomUUID();
    await c.query("BEGIN");
    await c.query("SET LOCAL webdesk.platform_ctx = 'true'");
    await c.query(`INSERT INTO tenants (id, slug, company_ref, status, default_locale, locales) VALUES ($1, $2, $3, 'active', 'en', ARRAY['en'])`, [tenantId, slug, randomUUID()]);
    await c.query("SET LOCAL webdesk.platform_ctx = ''");
    await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    await c.query(`INSERT INTO sites (id, tenant_id, kind, name) VALUES ($1, $2, 'astro', $3)`, [siteId, tenantId, `${label} site`]);
    for (const env of ["staging", "production"]) {
      await c.query(`INSERT INTO environments (id, site_id, tenant_id, name, status) VALUES ($1, $2, $3, $4, 'active')`, [randomUUID(), siteId, tenantId, env]);
    }
    await c.query(`INSERT INTO collections (id, tenant_id, site_id, key, schema) VALUES ($1, $2, $3, 'page', $4::jsonb)`, [randomUUID(), tenantId, siteId, JSON.stringify(PAGE_COMPOSITION)]);
    await c.query("COMMIT");
    return { slug, siteId, tenantId };
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

async function webdeskRows<T>(tenantId: string, sql: string, args: unknown[]): Promise<T[]> {
  const c = new Client({ connectionString: E.webdeskDb });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('webdesk.tenant_ctx', $1, true)", [tenantId]);
    const r = await c.query(sql, args);
    await c.query("COMMIT");
    return r.rows as T[];
  } finally {
    await c.end();
  }
}

/** content.create through the REAL client, signed by `sign`. */
/** M5-W1e: the assembled principal the signer reads `kind` from (an employee: no `xc`). */
const EMPLOYEE = { kind: "employee" } as const;

async function createDraft(
  client: WebdeskControlClient,
  site: { slug: string; siteId: string },
  sign: (r: EditorialAssertionRequest) => Promise<string>,
  sub: string,
) {
  const params = { tenantSlug: site.slug, siteId: site.siteId };
  const body = { collectionKey: "page", locale: "en", slug: `page.e2e-${randomUUID().slice(0, 8)}`, fields: { url: "/e2e/", h1: "WSK-40 end to end" } };
  const editorialAssertion = await sign({
    sub,
    pk: "human",
    ten: site.slug,
    site: site.siteId,
    // content.create is outside WSK-66's executor union; the signer itself signs any WebDesk command (WSK-59 will).
    cmd: "content.create" as EditorialAssertionRequest["cmd"],
    cmh: computeCommandHash("content.create", commandArgsAsZoneBSeesThem(params, body)),
  });
  const send = (assertion: string) =>
    client.send({
      command: "content.create",
      method: "POST",
      path: "/control/v1/tenants/:tenantSlug/sites/:siteId/content/items",
      params,
      body,
      idempotencyKey: `wsk40-e2e-${randomUUID()}`,
      editorialAssertion: assertion,
    });
  return { res: await send(editorialAssertion), body, resend: () => send(editorialAssertion) };
}

const slugOf = (json: unknown): string | undefined => {
  const t = (json as { type?: unknown } | null)?.type;
  return typeof t === "string" ? t.split("/").pop() : undefined;
};

// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!pairing)("WSK-40 END-TO-END: real ERP signer + WSK-66 executor → real WebDesk verifier + content commands", () => {
  let app: NestFastifyApplication;
  let client: WebdeskControlClient;
  let T: string;
  let editor: string;
  let approver: string;
  let site: { slug: string; siteId: string; tenantId: string };
  const savedEditorial = { ...config.webdeskEditorial };

  beforeAll(async () => {
    site = await seedWebdesk("pair");
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    T = await createCompany("WSK-40 E2E Co", ["webdev"]);
    const mk = async (email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(T, id);
      await grantRole(id, await createRole(role), "company", T);
      return id;
    };
    editor = await mk("wsk40-editor@ex.test", "webdev_staff");
    approver = await mk("wsk40-approver@ex.test", "company_admin");
    app = await buildApp();

    // The boot path main.ts runs, with the gate's key file: the REAL signer goes into WSK-66's seam.
    Object.assign(config.webdeskEditorial, { signingKeyFile: E.keyFile, signingKid: E.kid, ttlSec: 60 });
    expect(wireWebdeskEditorialSigner({ log: () => undefined, warn: () => undefined }).state).toBe("configured");
    client = newClient();
    setWebdeskApprovedCommandDepsForTests({ client }); // the client only: the registered signer stays
  }, 180_000);

  afterAll(async () => {
    client?.close();
    setWebdeskApprovedCommandDepsForTests(null);
    Object.assign(config.webdeskEditorial, savedEditorial);
    await app?.close();
    await teardownTestDb();
  });

  const headers = (userId: string) => ({ authorization: "Bearer svc-token", "x-user-id": userId });
  const decide = (id: string, as: string) =>
    app.inject({ method: "POST", url: `/api/${T}/automation-approvals/${id}/decide`, headers: headers(as), payload: { decision: "approved" } });
  async function fileAs(userId: string, items: Array<{ itemId: string; version: number }>): Promise<string> {
    const p = await assemblePrincipal(userId, "high");
    if (!p) throw new Error("no principal");
    const { approvalId } = await fileWebdeskCommandApproval(p, T, {
      command: "content.publish",
      tenantSlug: site.slug,
      siteId: site.siteId,
      args: { items },
      summary: { title: "WSK-40 e2e publish" },
    });
    return approvalId;
  }
  const signer = () => {
    const l = loadWebdeskEditorialSigner({ keyFile: E.keyFile, kid: E.kid, ttlSec: 60 });
    if (l.state !== "configured") throw new Error(l.reason);
    return l.signer;
  };

  let draftId = "";

  it("content.create: real signer → real client (mTLS, token, editorial header) → real WebDesk L1–L2e → 201, attributed to the ERP sub", async () => {
    const s = signer();
    const { res, body } = await createDraft(client, site, (r) => Promise.resolve(s.sign(r, EMPLOYEE)), editor);
    expect(res.status, res.bodyText).toBe(201);
    draftId = (res.json as { item: { itemId: string } }).item.itemId;
    const rows = await webdeskRows<{ created_by: string; attribution: unknown }>(
      site.tenantId,
      `SELECT cv.created_by, cv.attribution FROM content_versions cv JOIN content_items ci ON ci.id = cv.content_item_id WHERE ci.slug = $1`,
      [body.slug],
    );
    expect(rows).toEqual([{ created_by: editor, attribution: { pk: "human" } }]);
  });

  it("an APPROVED PUBLISH LANDS: editor files, company_admin decides → WSK-66 executes in-band → WebDesk publishes (WS4 + editorial verified)", async () => {
    expect(draftId).not.toBe("");
    const id = await fileAs(editor, [{ itemId: draftId, version: 1 }]);
    const r = await decide(id, approver);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "approved", webdesk: { command: "content.publish", executionStatus: "executed", reconciled: false } });

    const items = await webdeskRows<{ published_version: number | null; last_published_by: string | null; publish_state: string }>(
      site.tenantId,
      `SELECT published_version, last_published_by, publish_state FROM content_items WHERE id = $1`,
      [draftId],
    );
    expect(items).toEqual([{ published_version: 1, last_published_by: approver, publish_state: "published" }]);
    const audit = await webdeskRows<{ n: number }>(site.tenantId, `SELECT count(*)::int AS n FROM audit_entries WHERE ws4_approval_id = $1`, [id]);
    expect(audit[0].n).toBeGreaterThanOrEqual(1);
    const { rows } = await adminPool().query(`SELECT status, execution_status, execution_error, executed_by FROM automation_approvals WHERE id = $1`, [id]);
    expect(rows[0]).toMatchObject({ status: "approved", execution_status: "executed", execution_error: null, executed_by: approver });
  });

  it("tool_args edited after filing → the REAL WebDesk refuses 403 editorial-assertion-command-mismatch → row failed, nothing published", async () => {
    const s = signer();
    const { res } = await createDraft(client, site, (r) => Promise.resolve(s.sign(r, EMPLOYEE)), editor);
    expect(res.status, res.bodyText).toBe(201);
    const itemId = (res.json as { item: { itemId: string } }).item.itemId;
    const id = await fileAs(editor, [{ itemId, version: 1 }]);
    await adminPool().query(`UPDATE automation_approvals SET tool_args = jsonb_set(tool_args, '{items,0,version}', '2'::jsonb) WHERE id = $1`, [id]);
    const r = await decide(id, approver);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ webdesk: { executionStatus: "failed", error: "webdesk_refused: 403 editorial-assertion-command-mismatch" } });
    const items = await webdeskRows<{ published_version: number | null }>(site.tenantId, `SELECT published_version FROM content_items WHERE id = $1`, [itemId]);
    expect(items).toEqual([{ published_version: null }]);
  });

  it("a captured assertion replayed (new Idempotency-Key) → 401 editorial-assertion-replayed from the real Redis jti store", async () => {
    const s = signer();
    const { res, resend, body } = await createDraft(client, site, (r) => Promise.resolve(s.sign(r, EMPLOYEE)), editor);
    expect(res.status, res.bodyText).toBe(201);
    const again = await resend();
    expect(again.status).toBe(401);
    expect(slugOf(again.json)).toBe("editorial-assertion-replayed");
    const n = await webdeskRows<{ n: number }>(site.tenantId, `SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [body.slug]);
    expect(n[0].n).toBe(1);
  });

  it("the WSK-66 test-double signature (not Ed25519 by a pinned key) is refused by the real verifier: 401, nothing written", async () => {
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const { res, body } = await createDraft(client, site, async (r) => {
      const now = Math.floor(Date.now() / 1000);
      return `${b({ alg: "EdDSA", typ: "wd-editorial+jwt", kid: E.kid })}.${b({ iss: "urn:gaiada:erp:webdev", aud: "urn:gaiada:webdesk:control", ...r, iat: now, exp: now + 60, jti: randomUUID() })}.${Buffer.from("x".repeat(64)).toString("base64url")}`;
    }, editor);
    expect(res.status).toBe(401);
    expect(slugOf(res.json)).toBe("editorial-assertion-invalid-signature");
    const n = await webdeskRows<{ n: number }>(site.tenantId, `SELECT count(*)::int AS n FROM content_items WHERE slug = $1`, [body.slug]);
    expect(n[0].n).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// done-when (4): the rotation runbook, executed against the running WebDesk api. The gate script does
// the runbook's operator steps (keygen, JWKS append, api restart, removal, restart) between phases.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(!rotation)(`WSK-40 rotation runbook on the dev stack — phase ${E.phase}`, () => {
  let client: WebdeskControlClient;
  let site: { slug: string; siteId: string; tenantId: string };
  const load = (keyFile: string, kid: string) => {
    const l = loadWebdeskEditorialSigner({ keyFile, kid, ttlSec: 60 });
    if (l.state !== "configured") throw new Error(l.reason);
    return l.signer;
  };

  beforeAll(async () => {
    site = await seedWebdesk(E.phase);
    client = newClient();
  });
  afterAll(() => client?.close());

  if (E.phase === "rotation-overlap") {
    it(`overlap (JWKS holds ${E.oldKid} + ${E.kid}): BOTH kids are accepted`, async () => {
      for (const s of [load(E.oldKeyFile, E.oldKid), load(E.keyFile, E.kid)]) {
        const { res } = await createDraft(client, site, (r) => Promise.resolve(s.sign(r, EMPLOYEE)), "erp-user-rotation");
        expect(res.status, `${s.kid}: ${res.bodyText}`).toBe(201);
      }
    });
  } else {
    it(`after removal (JWKS holds ${E.kid} only): the OLD kid is refused 401 unknown-key, the new one is accepted`, async () => {
      const old = await createDraft(client, site, (r) => Promise.resolve(load(E.oldKeyFile, E.oldKid).sign(r, EMPLOYEE)), "erp-user-rotation");
      expect(old.res.status).toBe(401);
      expect(slugOf(old.res.json)).toBe("editorial-assertion-unknown-key");
      const cur = await createDraft(client, site, (r) => Promise.resolve(load(E.keyFile, E.kid).sign(r, EMPLOYEE)), "erp-user-rotation");
      expect(cur.res.status, cur.res.bodyText).toBe(201);
    });
  }
});
