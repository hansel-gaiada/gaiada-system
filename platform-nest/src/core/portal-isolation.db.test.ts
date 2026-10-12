// PV3-02c — three portal isolation fixes found while extracting the visibility predicates, against live
// Postgres + RLS + Cerbos (skips silently without DATABASE_URL_TEST; runs on the Linux server gate).
//
//   1. POST /portal/runs/:runId/scope-sign decided whatever gate `body.gateId` named. A client signer could
//      close an INTERNAL review gate on their own run. Now only a CLIENT-side gate is decided.
//      Teeth: drop `${gateClientVisible("")}` from the completion UPDATE in portal.controller.ts and the
//      internal gate test below ends `decided`.
//   2. ownsEntity.deliverable used the project's reach without `p.deleted_at IS NULL`, so a deleted project's
//      deliverable file stayed downloadable. Teeth: switch it back to `projectReach("p", ...)` and the
//      deleted-project download returns 200.
//   3. The timeline's payments and the receipt download reached a payment by its own client_id and never
//      looked at the parent invoice. Teeth: put the old `invoicePaymentInPortalScope(...)` back in either
//      place and a payment on a deleted invoice shows / downloads again.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";
import { setStorageForTest, localStorage as localStorageBackend, type StorageBackend } from "./storage";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;

describe.skipIf(!TEST_URL)("PV3-02c — portal isolation fixes", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let signerA: string;
  let clientA: string;
  let projectLive: string;
  let projectGone: string;

  const store = new Map<string, Buffer>();
  const memBackend: StorageBackend = {
    async put(k, d) { store.set(k, d); },
    async get(k) { const b = store.get(k); if (!b) throw new Error("missing"); return b; },
    async del(k) { store.delete(k); },
  };

  async function addFile(targetType: string, targetId: string, name: string): Promise<string> {
    const id = newId();
    const key = `${co}/${id}`;
    store.set(key, Buffer.from(name));
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                            content_type, byte_size, storage_key, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'text/plain', 5, $7, $8)`,
        [id, co, admin, targetType, targetId, name, key, site()],
      ),
    );
    return id;
  }

  async function addInvoice(opts: { status: string; deleted?: boolean; dayOffset: number }): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, deleted_at, origin_site)
         VALUES ($1, $2, $3, current_date - $4::int - 30, current_date - $4::int - 1, $5, 'IDR', '[]', 1000, $6, $7)`,
        [id, co, clientA, opts.dayOffset, opts.status, opts.deleted ? new Date() : null, site()],
      ),
    );
    return id;
  }

  async function addPayment(invoiceId: string, status = "confirmed"): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO invoice_payments (id, tenant_id, invoice_id, client_id, amount, currency, paid_on, status, confirmed_at, origin_site)
         VALUES ($1, $2, $3, $4, 100, 'IDR', current_date, $5, now(), $6)`,
        [id, co, invoiceId, clientA, status, site()],
      ),
    );
    return id;
  }

  /** A client-actionable run of client A, one per test (scope-sign completes once per run). */
  async function addRun(): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, client_id, project_id, origin_site)
       VALUES ($1, $2, 'Isolation run', 'delivery_active', $3, $4, 'test')`,
      [id, co, clientA, projectLive],
    );
    // The provider already signed, so the client's signature COMPLETES the sign-off (the branch that
    // decides `body.gateId`).
    await adminPool().query(
      `INSERT INTO scope_signoffs (id, tenant_id, run_id, party, signer_name, origin_site)
       VALUES ($1, $2, $3, 'provider', 'Agency', 'test')`,
      [newId(), co, id],
    );
    return id;
  }

  async function addGate(runId: string, kind: string, actorSide: "client" | "internal"): Promise<string> {
    const id = newId();
    await adminPool().query(
      `INSERT INTO pipeline_gates (id, tenant_id, run_id, kind, actor_side, status, opened_by, origin_site)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6, 'test')`,
      [id, co, runId, kind, actorSide, admin],
    );
    return id;
  }

  const gateStatus = async (id: string) =>
    (await adminPool().query(`SELECT status, decision FROM pipeline_gates WHERE id = $1`, [id])).rows[0] as { status: string; decision: string | null };

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    setStorageForTest(memBackend);
    resetModules();
    resetCoreRollupProviders();
    co = await createCompany("Isolation Co");
    admin = await createUser("admin@iso.test");
    signerA = await createUser("signer@iso-client.test");
    for (const u of [admin, signerA]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    await grantRole(signerA, await createRole("client"), "company", co);

    clientA = await createClient(co, "Iso Client");
    projectLive = await createProject(co, "Live project", admin);
    projectGone = await createProject(co, "Soon deleted project", admin);
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET client_id = $2 WHERE id = ANY($1::uuid[])`, [[projectLive, projectGone], clientA]);
      await c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, NULL, 'signer', 'active', now(), $5)`,
        [newId(), co, clientA, signerA, site()],
      );
    });
    app = await buildApp();
  }, 120_000);

  afterAll(async () => {
    setStorageForTest(localStorageBackend);
    await app?.close();
    await teardownTestDb();
  });

  // ── 1. scope-sign only decides a client-side gate ─────────────────────────────────────────────────
  describe("scope-sign completion decides only a CLIENT-side gate", () => {
    const sign = (runId: string, gateId: string) =>
      app.inject({
        method: "POST", url: `/api/${co}/portal/runs/${runId}/scope-sign`, headers: asUser(signerA),
        payload: { signerName: "Client Signer", gateId },
      });

    it("an internal gate id in the body stays pending, while the sign-off itself completes", async () => {
      const run = await addRun();
      const internal = await addGate(run, "pm_review", "internal");
      const res = await sign(run, internal);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ complete: true });
      expect(await gateStatus(internal)).toEqual({ status: "pending", decision: null });
    });

    it("the client's own scope sign-off gate is still decided", async () => {
      const run = await addRun();
      const client = await addGate(run, "scope_signoff", "client");
      const res = await sign(run, client);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ complete: true });
      expect(await gateStatus(client)).toEqual({ status: "decided", decision: "signed" });
    });
  });

  // ── 2. a deleted project's deliverable file is not downloadable ───────────────────────────────────
  describe("deliverable file download follows the project's visibility", () => {
    async function deliverableOn(project: string): Promise<string> {
      const id = newId();
      await withTenants([co], (c) =>
        c.query(
          `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
           VALUES ($1, $2, $3, NULL, 'Design', 'pending', current_date + 7, $4)`,
          [id, co, project, site()],
        ),
      );
      return id;
    }
    const download = (fileId: string) =>
      app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(signerA) });

    it("a visible project's deliverable file downloads (control), a deleted project's is 404", async () => {
      const liveFile = await addFile("deliverable", await deliverableOn(projectLive), "live.txt");
      const goneFile = await addFile("deliverable", await deliverableOn(projectGone), "gone.txt");
      expect((await download(liveFile)).statusCode).toBe(200);
      expect((await download(goneFile)).statusCode).toBe(200); // project still live: control for the next line

      await withTenants([co], (c) => c.query(`UPDATE projects SET deleted_at = now() WHERE id = $1`, [projectGone]));
      expect((await download(goneFile)).statusCode).toBe(404);
      expect((await download(liveFile)).statusCode).toBe(200);
    });
  });

  // ── 3. a payment is reached through a visible invoice ─────────────────────────────────────────────
  describe("timeline payments and receipts follow the invoice", () => {
    it("a confirmed payment on a deleted invoice is absent from the timeline and its receipt is 404", async () => {
      const liveInv = await addInvoice({ status: "sent", dayOffset: 0 });
      const goneInv = await addInvoice({ status: "sent", dayOffset: 40 });
      const draftInv = await addInvoice({ status: "draft", dayOffset: 80 });
      const livePay = await addPayment(liveInv);
      const gonePay = await addPayment(goneInv);
      const draftPay = await addPayment(draftInv);
      const liveReceipt = await addFile("invoice_payment", livePay, "live-receipt.txt");
      const goneReceipt = await addFile("invoice_payment", gonePay, "gone-receipt.txt");
      const draftReceipt = await addFile("invoice_payment", draftPay, "draft-receipt.txt");
      await withTenants([co], (c) => c.query(`UPDATE invoices SET deleted_at = now() WHERE id = $1`, [goneInv]));

      const timeline = await app.inject({ method: "GET", url: `/api/${co}/portal/timeline?limit=400`, headers: asUser(signerA) });
      expect(timeline.statusCode).toBe(200);
      const payments = (timeline.json() as Array<{ kind: string; id: string }>).filter((e) => e.kind === "payment").map((e) => e.id);
      expect(payments).toContain(livePay);          // control: a payment on a visible invoice still shows
      expect(payments).not.toContain(gonePay);      // deleted invoice
      expect(payments).not.toContain(draftPay);     // draft invoice (the invoices branch hides it too)

      const get = (fileId: string) => app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(signerA) });
      const live = await get(liveReceipt);
      expect({ status: live.statusCode, body: live.statusCode === 200 ? "" : live.body }).toEqual({ status: 200, body: "" });
      expect((await get(goneReceipt)).statusCode).toBe(404);
      expect((await get(draftReceipt)).statusCode).toBe(404);
    });
  });
});
