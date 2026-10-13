// PV3-02c — three portal isolation fixes found while extracting the visibility predicates, against live
// Postgres + RLS + Cerbos (skips silently without DATABASE_URL_TEST; runs on the Linux server gate).
//
//   1. POST /portal/runs/:runId/scope-sign decided whatever gate `body.gateId` named. A client signer could
//      close an INTERNAL review gate on their own run. Now only the run's CLIENT-side `scope_signoff` gate is
//      decided. Teeth: drop `${gateClientVisible("")}` from the completion UPDATE in portal.controller.ts and
//      the internal gate test below ends `decided`; drop `kind = 'scope_signoff'` and the prd_sign test does.
//   2. ownsEntity.deliverable used the project's reach without `p.deleted_at IS NULL`, so a deleted project's
//      deliverable file stayed downloadable. Teeth: switch it back to `projectReach("p", ...)` and the
//      deleted-project download returns 200.
//   4. PV3-02d: an `approved` invoice (internal maker/checker step before send) is not shown to the client.
//   3. The timeline's payments and the receipt download reached a payment by its own client_id and never
//      looked at the parent invoice. Teeth: put the old `invoicePaymentInPortalScope(...)` back in either
//      place and a payment on a deleted invoice shows / downloads again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { createIssuedInvoice, ensureBillingSetup } from "../seed/billing-setup";
import { markInvoicesLegacy } from "../testing/invoice-fixtures";

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

  // PV5-04: a `sent` invoice is an ISSUED one (PV5-01b), so it is issued for real; an issued invoice cannot be
  // deleted (202610130400's freeze), so the "deleted invoice" cases use an unissued status the portal still shows.
  async function addInvoice(opts: { status: string; deleted?: boolean; dayOffset: number }): Promise<string> {
    if (opts.status === "sent") {
      if (opts.deleted) throw new Error("an issued invoice cannot be soft-deleted");
      return (await createIssuedInvoice(co, {
        clientId: clientA, actorId: admin, lines: [{ description: "Fixture work", amount: 1000 }],
        periodStart: null, periodEnd: null,
      })).id;
    }
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

  // PV5-F1: a `void` invoice in each of its three histories. A flagged-legacy row can only exist if the guard
  // trigger is stepped over (as the migration does), so it is inserted on a connection with triggers off
  // (testing/invoice-fixtures.ts).
  async function addVoid(kind: "unissued" | "issued" | "legacy", dayOffset: number, createdAt: Date | null = null): Promise<string> {
    if (kind === "issued") {
      const inv = await addInvoice({ status: "sent", dayOffset });
      await withTenants([co], (c) => c.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [inv]));
      return inv;
    }
    const id = newId();
    await adminPool().query(
      `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site, created_at)
       VALUES ($1, $2, $3, current_date - $4::int - 30, current_date - $4::int - 1, 'void', 'IDR', '[]', 1000, $5, COALESCE($6::timestamptz, now()))`,
      [id, co, clientA, dayOffset, site(), createdAt],
    );
    if (kind === "legacy") await markInvoicesLegacy([id]);
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
    await ensureBillingSetup(co);
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

    it("a client-side prd_sign gate id in the body stays pending, while the sign-off itself completes", async () => {
      const run = await addRun();
      const prd = await addGate(run, "prd_sign", "client");
      const res = await sign(run, prd);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ complete: true });
      expect(await gateStatus(prd)).toEqual({ status: "pending", decision: null });
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

  // ── 4. an approved-but-unsent invoice is not shown (PV3-02d) ────────────────────────────────────────
  // `approved` is the internal maker/checker step BEFORE the invoice is sent. Teeth: put `<> 'draft'` back
  // in `invoiceClientVisible` (portal-visibility.ts) and the approved invoice appears in the list.
  describe("an approved (not yet sent) invoice is hidden from the client", () => {
    it("is absent from the list, timeline and finance, its detail is 404, and its payment has no receipt; a sent invoice shows", async () => {
      const approved = await addInvoice({ status: "approved", dayOffset: 120 });
      const sent = await addInvoice({ status: "sent", dayOffset: 160 });
      const approvedPay = await addPayment(approved);
      const approvedReceipt = await addFile("invoice_payment", approvedPay, "approved-receipt.txt");

      const list = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices`, headers: asUser(signerA) });
      expect(list.statusCode).toBe(200);
      const ids = (list.json() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(sent);
      expect(ids).not.toContain(approved);

      expect((await app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${sent}`, headers: asUser(signerA) })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${approved}`, headers: asUser(signerA) })).statusCode).toBe(404);

      const timeline = await app.inject({ method: "GET", url: `/api/${co}/portal/timeline?limit=400`, headers: asUser(signerA) });
      const entries = (timeline.json() as Array<{ kind: string; id: string }>);
      expect(entries.some((e) => e.kind === "invoice" && e.id === sent)).toBe(true);
      expect(entries.some((e) => e.id === approved || e.id === approvedPay)).toBe(false);

      expect((await app.inject({ method: "GET", url: `/api/${co}/portal/files/${approvedReceipt}`, headers: asUser(signerA) })).statusCode).toBe(404);
    });
  });

  // ── 4b. a void invoice is shown only if it was ever issued (PV5-F1) ──────────────────────────────────
  // Teeth: drop the `(status <> 'void' OR issued_at IS NOT NULL OR pre_pv5_legacy)` arm from `invoiceClientVisible`
  // (portal-visibility.ts) and the unissued void appears in the list and its detail answers 200.
  describe("a void invoice that was never issued is hidden from the client", () => {
    it("an unissued void is absent and 404; an issued-then-voided and a pre-PV-5 void still show", async () => {
      const unissued = await addVoid("unissued", 200);
      const issued = await addVoid("issued", 210);
      const legacy = await addVoid("legacy", 220);

      const list = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices`, headers: asUser(signerA) });
      expect(list.statusCode).toBe(200);
      const ids = (list.json() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).not.toContain(unissued);
      expect(ids).toContain(issued);
      expect(ids).toContain(legacy);

      const detail = (id: string) => app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${id}`, headers: asUser(signerA) });
      expect((await detail(unissued)).statusCode).toBe(404);
      expect((await detail(issued)).statusCode).toBe(200);
      expect((await detail(legacy)).statusCode).toBe(200);
    });
  });

  // The migration's cutoff is the ledger's applied_at for 1850, never a filename stamp (PV5-F1). The migration is a
  // re-runnable DO block, so the test runs its real SQL against fixtures dated either side of that instant.
  // Teeth: hard-code a future literal cutoff in the migration and the "after" row is flagged, hence visible.
  describe("migration 202610132208 flags only voids created BEFORE the 1850 apply time", () => {
    it("a void created before the cutoff is flagged (visible); one created after stays unflagged (hidden)", async () => {
      const ledger = await adminPool().query<{ applied_at: Date }>(
        `SELECT applied_at FROM schema_migrations WHERE name = '202610131850_pv5_enforce_invoice_issued.sql'`,
      );
      expect(ledger.rowCount).toBe(1);
      const cutoff = ledger.rows[0]!.applied_at.getTime();
      const before = await addVoid("unissued", 300, new Date(cutoff - 24 * 3600_000));
      const after = await addVoid("unissued", 310, new Date(cutoff + 3600_000));

      const sql = readFileSync(join(__dirname, "../../migrations/202610132208_pv5_legacy_flag_unissued_void_invoices.sql"), "utf8");
      await adminPool().query(sql);

      const flag = async (id: string) =>
        (await adminPool().query<{ pre_pv5_legacy: boolean }>(`SELECT pre_pv5_legacy FROM invoices WHERE id = $1`, [id])).rows[0]!.pre_pv5_legacy;
      expect(await flag(before)).toBe(true);
      expect(await flag(after)).toBe(false);

      const list = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices`, headers: asUser(signerA) });
      const ids = (list.json() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toContain(before);
      expect(ids).not.toContain(after);
    });
  });

  // ── 3. a payment is reached through a visible invoice ─────────────────────────────────────────────
  describe("timeline payments and receipts follow the invoice", () => {
    it("a confirmed payment on a deleted invoice is absent from the timeline and its receipt is 404", async () => {
      const liveInv = await addInvoice({ status: "sent", dayOffset: 0 });
      // A pre-PV-5 `void` (flagged legacy): visible to the client and still deletable, so it carries the deleted-invoice case.
      const goneInv = await addVoid("legacy", 40);
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
