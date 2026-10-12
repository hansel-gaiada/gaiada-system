// M5-L1d — the ERP side of WebDesk form definitions: `PUT|PATCH …/content/sites/:tenantSlug/:siteId/forms/:formKey`
// (MCP webdesk.forms.define, MEDIUM), `GET …/forms` and `GET …/forms/:formKey` (MCP webdesk.forms.list / get).
//
// Real: Postgres (the activities ledger, RLS), Cerbos (the real `webdesk_collection` policy: read / apply_schema), the full
// NestJS app (`buildApp()`), the real `WebdeskZoneB`. Stand-in: Zone B, the in-process fake of webdesk-content-testkit.ts
// (its `forms.define` handler keeps the form id across a redefinition and refuses a changed notice text under an
// unchanged version, as WebDesk does). Needs DATABASE_URL_TEST + CERBOS_URL (skips otherwise): NEEDS the Linux gate.
//
// Doctrine ("validation pre-empts authz"): every denial sends a body that is VALID for the command and is paired with a
// positive control that sends the IDENTICAL request as an allowed principal; a denied call makes NO call to Zone B.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { buildApp } from "../../main";
import { resetModules } from "../registry";
import { resetCoreRollupProviders } from "../../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole } from "../../testing/fixtures";
import { setWebdeskApprovedCommandDepsForTests } from "./webdesk-approved-command";
import { webdeskZoneB } from "./webdesk-content.service";
import { FakeZoneB, GAIADA_SITE, GAIADA_SLUG, OTHER_SITE, OTHER_SLUG, makeTestSigner, problem } from "./webdesk-content-testkit";

const live = !!TEST_URL && !!process.env.CERBOS_URL;
const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const NOTICE = "We use this to reply to you. See /privacy-policy/";

const body = (over: Record<string, unknown> = {}) => ({
  schema: {
    fields: [
      { key: "name", type: "text", required: true, maxLength: 200 },
      { key: "email_address", type: "email", required: true },
      { key: "phone_number", type: "tel" },
      { key: "message", type: "textarea", required: true },
    ],
    honeypotField: "_hp",
    consentNotice: { text: NOTICE },
  },
  notify: {},
  retentionDays: 90,
  consentNoticeVersion: "site-2026-10-11",
  ...over,
});

describe.skipIf(!live)("M5-L1d · WebDesk form definitions over the ERP BFF", () => {
  let app: NestFastifyApplication;
  let A: string; // owns the `gaiada` tenant
  let B: string; // owns the `othertenant` tenant
  let adminA: string, publisherA: string, editorA: string, memberA: string, adminB: string, writerHere: string, writerElsewhere: string;
  let zb: FakeZoneB;
  const signer = makeTestSigner();

  const site = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE) => `/api/${co}/modules/webdev/content/sites/${slug}/${siteId}`;
  const forms = (co = A, slug = GAIADA_SLUG, siteId = GAIADA_SITE, key?: string) => `${site(co, slug, siteId)}/forms${key ? `/${key}` : ""}`;
  const call = (method: "GET" | "PUT" | "PATCH", url: string, as: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method, url, headers: { ...asUser(as), ...headers }, ...(payload !== undefined ? { payload: payload as never } : {}) });
  const ledger = async (verb = "webdesk.forms.define") =>
    (await adminPool().query<{ verb: string; actor_id: string; metadata: Record<string, unknown> }>(
      `SELECT verb, actor_id, metadata FROM activities WHERE tenant_id = $1 AND verb = $2 ORDER BY occurred_at, id`,
      [A, verb],
    )).rows;
  const clearLedger = () => adminPool().query(`DELETE FROM activities WHERE tenant_id = $1 AND verb LIKE 'webdesk.%'`, [A]);
  const noEgress = () => expect(zb.calls.map((c) => c.command)).toEqual([]);

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    A = await createCompany("L1d Co A", ["webdev"]);
    B = await createCompany("L1d Co B", ["webdev"]);
    const mk = async (co: string, email: string, role: string) => {
      const id = await createUser(email);
      await addMembership(co, id);
      await grantRole(id, await createRole(role), "company", co);
      return id;
    };
    adminA = await mk(A, "l1d-admin-a@ex.test", "company_admin");
    publisherA = await mk(A, "l1d-publisher-a@ex.test", "webdev_manager");
    editorA = await mk(A, "l1d-editor-a@ex.test", "webdev_staff");
    memberA = await mk(A, "l1d-member-a@ex.test", "member");
    adminB = await mk(B, "l1d-admin-b@ex.test", "company_admin");
    // M5-W1c: writers' room grants (one scope row each), as webdesk-content-two-phase.test.ts builds them.
    const editorial = async (userId: string, siteId: string) => {
      const roleId = await createRole("webdesk_writer");
      await grantRole(userId, roleId, "company", A);
      const g = (await adminPool().query(`SELECT id FROM user_roles WHERE user_id = $1 AND role_id = $2`, [userId, roleId])).rows[0].id;
      await adminPool().query(
        `INSERT INTO user_role_editorial_scopes (user_role_id, tenant_id, webdesk_tenant_slug, site_id, all_collections, collections, all_locales, locales, origin_site)
         VALUES ($1, $2, $3, $4, true, '{}', true, '{}', $5)`,
        [g, A, GAIADA_SLUG, siteId, config.originSite],
      );
    };
    writerHere = await mk(A, "l1d-writer-here@ex.test", "member");
    writerElsewhere = await mk(A, "l1d-writer-else@ex.test", "member");
    await editorial(writerHere, GAIADA_SITE);
    await editorial(writerElsewhere, "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a");
    zb = new FakeZoneB(A, B);
    app = await buildApp();
  }, 120_000);

  beforeEach(async () => {
    zb.reset();
    signer.calls.length = 0;
    signer.configured = true;
    webdeskZoneB.clearSiteCache();
    setWebdeskApprovedCommandDepsForTests({ client: zb.asClient(), signer });
    await clearLedger();
  });
  afterEach(() => setWebdeskApprovedCommandDepsForTests(null));
  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  describe("golden cases", () => {
    it("webdesk.forms.define → PUT …/forms/:formKey: walled, ONE forms.define write to WebDesk with the Idempotency-Key, no editorial assertion, a two-row ledger without the notice text", async () => {
      const r = await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body(), { "idempotency-key": "idem-l1d-define-1" });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toMatchObject({ created: true, consentNoticeChanged: false, replayed: false, form: { key: "contact", retentionDays: 90, consentNoticeVersion: "site-2026-10-11" } });
      const w = zb.writes.at(-1)!;
      expect(w).toMatchObject({
        command: "forms.define",
        method: "PUT",
        path: "/control/v1/tenants/:tenantSlug/sites/:siteId/forms/:formKey",
        params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, formKey: "contact" },
        idempotencyKey: "idem-l1d-define-1",
        body: { retentionDays: 90, consentNoticeVersion: "site-2026-10-11" },
      });
      expect(w.editorialAssertion).toBeUndefined(); // not an editorial command, like schema.apply
      expect(w.hadWs4).toBe(false); // MEDIUM: no WS4
      const rows = await ledger();
      expect(rows.map((x) => x.metadata.outcome)).toEqual(["attempted", "succeeded"]);
      expect(rows[0].actor_id).toBe(adminA);
      expect(rows[0].metadata).toMatchObject({ command: "forms.define", tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, formKey: "contact", consentNoticeVersion: "site-2026-10-11" });
      expect(JSON.stringify(rows)).not.toContain("privacy-policy"); // the notice text never reaches the ledger
    });

    it("the PATCH alias (the MCP hub has no PUT) is the same command with the same body", async () => {
      const r = await call("PATCH", forms(A, GAIADA_SLUG, GAIADA_SITE, "audit"), adminA, body());
      expect(r.statusCode, r.body).toBe(200);
      expect(zb.writes.at(-1)).toMatchObject({ command: "forms.define", method: "PUT", params: { formKey: "audit" } });
    });

    it("without an Idempotency-Key header the BFF supplies one (8..200 chars)", async () => {
      await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body());
      expect(String(zb.writes.at(-1)!.idempotencyKey).length).toBeGreaterThanOrEqual(8);
    });

    it("redefining keeps the form id; webdesk.forms.list and webdesk.forms.get read it back", async () => {
      const first = (await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body())).json();
      const again = await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body({ retentionDays: 120 }));
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ created: false, form: { formId: first.form.formId, retentionDays: 120 } });
      await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "audit"), adminA, body());
      const list = await call("GET", forms(), editorA);
      expect(list.statusCode).toBe(200);
      expect(list.json().forms.map((f: { key: string }) => f.key)).toEqual(["audit", "contact"]);
      const one = await call("GET", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), editorA);
      expect(one.statusCode).toBe(200);
      expect(one.json().form.formId).toBe(first.form.formId);
      expect(zb.calls.at(-1)).toMatchObject({ command: "forms.def.get", params: { tenantSlug: GAIADA_SLUG, siteId: GAIADA_SITE, formKey: "contact" } });
      // reads write no ledger rows
      expect((await ledger("webdesk.forms.def.get")).length + (await ledger("webdesk.forms.def.list")).length).toBe(0);
    });
  });

  describe("typed problems pass through untouched", () => {
    it("409 consent-version-unchanged (the notice text moved, the version did not) is Zone B's own problem, byte for byte", async () => {
      await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body());
      const changed = body();
      (changed.schema.consentNotice as { text: string }).text = "A different notice.";
      const r = await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, changed);
      expect(r.statusCode).toBe(409);
      expect(r.json().type).toBe("https://webdesk.gaiada.online/errors/consent-version-unchanged");
      expect(r.headers["content-type"]).toContain("application/problem+json");
      expect((await ledger()).at(-1)!.metadata).toMatchObject({ outcome: "refused", status: 409, problem: "consent-version-unchanged" });
      // with a new version it goes through
      const ok = await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, { ...changed, consentNoticeVersion: "site-2026-11-01" });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().consentNoticeChanged).toBe(true);
    });

    it("422 form-definition-invalid keeps its `issues`", async () => {
      zb.nextWriteResponse = problem(422, "form-definition-invalid", { issues: [{ path: "retentionDays", message: "bad" }] });
      const r = await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), adminA, body());
      expect(r.statusCode).toBe(422);
      expect(r.json().issues).toEqual([{ path: "retentionDays", message: "bad" }]);
    });

    it("an unknown form key reads as Zone B's 404 form-not-found", async () => {
      const r = await call("GET", forms(A, GAIADA_SLUG, GAIADA_SITE, "no-such-form"), editorA);
      expect(r.statusCode).toBe(404);
      expect(r.json().type).toBe("https://webdesk.gaiada.online/errors/form-not-found");
    });
  });

  describe("authorization: Cerbos webdesk_collection (valid bodies; each denial has a positive control; a denial never reaches WebDesk)", () => {
    const define = (as: string, key = "contact") => call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, key), as, body());

    it("define needs apply_schema: webdev_staff and member are 403, the IDENTICAL request as webdev_manager and company_admin succeeds", async () => {
      for (const denied of [editorA, memberA]) {
        expect((await define(denied)).statusCode).toBe(403);
        noEgress();
      }
      expect((await define(publisherA)).statusCode).toBe(200);
      expect((await define(adminA, "audit")).statusCode).toBe(200);
      // the PATCH alias is gated identically
      expect((await call("PATCH", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), editorA, body())).statusCode).toBe(403);
    });

    it("M5-W1c two-phase: a writers' room grant on THIS site passes phase 1 (reads 200) but is denied the write's real action apply_schema (403, valid body, no egress); a grant on ANOTHER site cannot even read", async () => {
      const put = (as: string) => call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), as, body());
      expect((await call("GET", forms(), writerHere)).statusCode).toBe(200);
      zb.reset();
      expect((await put(writerHere)).statusCode).toBe(403);
      expect((await call("PATCH", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), writerHere, body())).statusCode).toBe(403);
      noEgress();
      expect((await call("GET", forms(), writerElsewhere)).statusCode).toBe(403);
      expect((await put(publisherA)).statusCode).toBe(200); // the identical request, allowed
    });

    it("the reads need read: a plain member is 403, webdev_staff and webdev_manager succeed", async () => {
      zb.reset();
      expect((await call("GET", forms(), memberA)).statusCode).toBe(403);
      expect((await call("GET", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), memberA)).statusCode).toBe(403);
      noEgress();
      expect((await call("GET", forms(), editorA)).statusCode).toBe(200);
      expect((await call("GET", forms(), publisherA)).statusCode).toBe(200);
    });

    it("authorization comes FIRST: a denied caller gets 403 even for a body that would be a 400 (and an invalid key)", async () => {
      expect((await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "contact"), memberA, { nonsense: true })).statusCode).toBe(403);
      expect((await call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, "Bad%20Key"), memberA, body())).statusCode).toBe(403);
      noEgress();
    });

    it("CROSS-COMPANY WALL: company B's admin naming A's tenant slug and site gets the uniform 404 on the write and both reads, and nothing reaches WebDesk; on B's own site it works", async () => {
      const w = await call("PUT", forms(B, GAIADA_SLUG, GAIADA_SITE, "contact"), adminB, body());
      expect(w.statusCode).toBe(404);
      expect(w.json().type).toBe("https://webdesk.gaiada.online/errors/site-not-found");
      expect((await call("GET", forms(B, GAIADA_SLUG, GAIADA_SITE), adminB)).statusCode).toBe(404);
      expect((await call("GET", forms(B, GAIADA_SLUG, GAIADA_SITE, "contact"), adminB)).statusCode).toBe(404);
      expect(zb.writes).toHaveLength(0);
      expect((await call("PUT", forms(B, OTHER_SLUG, OTHER_SITE, "contact"), adminB, body())).statusCode).toBe(200);
      // and company A's admin cannot use company B's route
      expect([403, 404]).toContain((await call("PUT", forms(B, OTHER_SLUG, OTHER_SITE, "contact"), adminA, body())).statusCode);
    });

    it("a client principal has no door: the client-portal roles hold neither action on webdesk_collection (Cerbos matrix: cerbos-webdev-matrix.test.ts)", async () => {
      // Pinned structurally: the BFF opens the STAFF gate (`authorizeContent`, never `openClient`), so a client editor
      // (`clientId` resource attribute) is never even asked for; the policy has no client rule for these two actions.
      const client = await createUser("l1d-client-a@ex.test");
      await addMembership(A, client);
      await grantRole(client, await createRole("client"), "company", A);
      expect((await define(client)).statusCode).toBe(403);
      expect((await call("GET", forms(), client)).statusCode).toBe(403);
      noEgress();
    });
  });

  describe("body shape (after authorization)", () => {
    it("refuses an unknown member, a missing retentionDays, a missing version and an invalid form key with 400, and calls WebDesk for none of them", async () => {
      const put = (b: unknown, key = "contact") => call("PUT", forms(A, GAIADA_SLUG, GAIADA_SITE, key), adminA, b);
      expect((await put({ ...body(), key: "contact" })).statusCode).toBe(400); // the key is the route's
      expect((await put({ ...body(), tenantSlug: GAIADA_SLUG })).statusCode).toBe(400);
      const { retentionDays: _r, ...noRetention } = body();
      void _r;
      expect((await put(noRetention)).statusCode).toBe(400);
      const { consentNoticeVersion: _v, ...noVersion } = body();
      void _v;
      expect((await put(noVersion)).statusCode).toBe(400);
      expect((await put({ ...body(), schema: [] })).statusCode).toBe(400);
      expect((await put(body(), "Bad%20Key")).statusCode).toBe(400);
      expect((await put(null as never)).statusCode).toBe(400);
      expect(zb.writes).toHaveLength(0);
    });
  });
});
