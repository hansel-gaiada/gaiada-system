// CP-6 — the client-portal dashboard surface against live Postgres + RLS + Cerbos.
//
// The assertions are weighted toward ISOLATION and CAPABILITY rather than happy-path shape, because
// those are the properties that cannot be recovered after the fact: a wrong number on a dashboard is a
// bug report, and client B reading client A's contract is an incident. Specifically pinned here:
//   * cross-client refusal on every new addressable route (invoice, contract, file, project)
//   * 404-not-403 on someone else's id, so no route becomes an existence oracle
//   * a `viewer` contact cannot sign or countersign, but CAN pay and CAN give feedback
//   * a project-scoped contact cannot reach a sibling project — including through the WRITE paths,
//     which is the gap CP-1 found (projectIds was resolved and never applied on decide/scope-sign)
//   * a client-recorded payment lands 'pending' and does NOT move invoices.status
//   * overpayment past the tolerance is refused
//
// WRITTEN BLIND, THEN CORRECTED BY CI (2026-08-04). The dev Postgres/Cerbos pair is deliberately not
// running on this machine (owner decision — the server is the source of truth), so this suite was
// authored and typechecked without ever executing. CI — which provisions PG + migrations + Cerbos — was
// its first run, and it found FIVE defects in two passes, every one of them in the test rather than in
// the code under test:
//   1. `REF-${id.slice(0,8)}` collided — uuid v7 is time-ordered (see the fixture comment below).
//   2. the same truncation made a cross-client leak assertion match CLEAN data.
//   3. `progressPercent` expected 62; Postgres rounds 62.5 half-away-from-zero, so 63.
//   4/5. asserted `.message` on error bodies, but http-error.filter.ts reshapes every HttpException to
//      `{ error }` for parity with the old Fastify core — so `.message` read undefined and
//      `.toMatch()` was being handed nothing.
//   6. `app.inject()` cannot test the SSE route at all — it waits for a response that never completes.
// Recorded because it is the honest cost of writing DB-backed tests with no database: they typecheck,
// they read correctly, and they are wrong in ways only execution reveals.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { newId, withTenants } from "../db";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const site = () => config.originSite;

describe.skipIf(!TEST_URL)("client portal dashboard (CP-2..CP-5)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;      // agency staff
  let signerA: string;    // client A, client-wide SIGNER
  let viewerA: string;    // client A, client-wide VIEWER
  let scopedA: string;    // client A, scoped to projectA1 only
  let contactB: string;   // client B — the isolation counterparty
  let clientA: string;
  let clientB: string;
  let projectA1: string;
  let projectA2: string;
  let projectB: string;
  let invoiceA: string;
  let invoiceB: string;
  let contractA: string;
  let contractB: string;
  let deliverableA1: string;

  /** Insert a client_contacts row directly: there is no fixture helper, and driving the whole
   *  invite/accept flow here would test client-contacts.controller rather than the portal. */
  async function addContact(
    clientId: string, userId: string, capability: "signer" | "viewer", projectId: string | null = null,
  ): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now(), $7)`,
        [newId(), co, clientId, userId, projectId, capability, site()],
      ),
    );
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    resetModules();
    resetCoreRollupProviders();
    // `billing` is NOT enabled on this company on purpose: the portal's invoice reads must work anyway
    // (see PortalCommerceController.listInvoices' header). Invoice rows are inserted directly below
    // rather than through the module-gated staff endpoint, which is also what makes that possible.
    co = await createCompany("Gaiada Creative");
    admin = await createUser("admin@cp.test");
    signerA = await createUser("signer@acme.test");
    viewerA = await createUser("viewer@acme.test");
    scopedA = await createUser("scoped@acme.test");
    contactB = await createUser("boss@rival.test");
    for (const u of [admin, signerA, viewerA, scopedA, contactB]) await addMembership(co, u);
    await grantRole(admin, await createRole("company_admin"), "company", co);
    const clientRole = await createRole("client");
    for (const u of [signerA, viewerA, scopedA, contactB]) await grantRole(u, clientRole, "company", co);

    clientA = await createClient(co, "Acme Inc");
    clientB = await createClient(co, "Rival Ltd");
    projectA1 = await createProject(co, "Acme site", admin);
    projectA2 = await createProject(co, "Acme campaign", admin);
    projectB = await createProject(co, "Rival site", admin);
    await withTenants([co], async (c) => {
      await c.query(`UPDATE projects SET client_id = $2, due_date = current_date + 30 WHERE id = $1`, [projectA1, clientA]);
      await c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectA2, clientA]);
      await c.query(`UPDATE projects SET client_id = $2 WHERE id = $1`, [projectB, clientB]);

      // Progress substrate: 2 of 4 done, one at 50% -> weighted 63 (not the 50 a done/total count gives).
      for (const [title, status, progress] of [
        ["a", "done", 0], ["b", "done", 100], ["c", "in_progress", 50], ["d", "todo", 0],
      ] as Array<[string, string, number]>) {
        await c.query(
          `INSERT INTO pm_tasks (id, tenant_id, project_id, title, status, progress, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [newId(), co, projectA1, title, status, progress, site()],
        );
      }
      await c.query(
        `INSERT INTO pm_milestones (id, tenant_id, project_id, name, due_date, status, origin_site)
         VALUES ($1, $2, $3, 'Launch', current_date + 14, 'open', $4)`,
        [newId(), co, projectA1, site()],
      );
      deliverableA1 = newId();
      await c.query(
        `INSERT INTO deliverables (id, tenant_id, project_id, client_id, name, status, due_date, origin_site)
         VALUES ($1, $2, $3, $4, 'Homepage design', 'pending', current_date + 7, $5)`,
        [deliverableA1, co, projectA1, null, site()],
      );

      invoiceA = newId();
      invoiceB = newId();
      for (const [id, client] of [[invoiceA, clientA], [invoiceB, clientB]] as Array<[string, string]>) {
        await c.query(
          `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site)
           VALUES ($1, $2, $3, current_date - 30, current_date - 1, 'sent', 'IDR',
                   '[{"description":"Design","hours":10,"rate":100,"amount":1000}]', 1000, $4)`,
          [id, co, client, site()],
        );
      }
      contractA = newId();
      contractB = newId();
      // References are EXPLICIT literals, not derived from the id.
      //
      // The first version of this fixture used `REF-${id.slice(0, 8)}` and CI caught it immediately:
      // `duplicate key value violates unique constraint "ix_contracts_reference_uniq"`. `newId()` is
      // uuid **v7**, which is time-ordered — its leading bits are a millisecond timestamp — so two ids
      // minted in the same millisecond share their first 8 hex characters. A slice of a v7 uuid is a
      // timestamp, not an identity, and truncating one to make a "unique" label produces collisions
      // exactly when rows are created together, which in a test fixture is always.
      //
      // Worth keeping as the comment rather than the fix alone: the constraint behaved perfectly (it
      // refused two identical references in one tenant at the same version, which is its whole job) and
      // the bug was in the fixture's assumption about uuid v7.
      for (const [id, client, project, reference] of [
        [contractA, clientA, projectA1, "REF-ACME-001"],
        [contractB, clientB, projectB, "REF-RIVAL-001"],
      ] as Array<[string, string, string, string]>) {
        await c.query(
          `INSERT INTO contracts (id, tenant_id, client_id, project_id, title, reference, status, value, currency,
                                  starts_on, ends_on, sent_at, created_by, origin_site)
           VALUES ($1, $2, $3, $4, 'Master Services Agreement', $5, 'sent', 25000, 'IDR',
                   current_date - 1, current_date + 365, now(), $6, $7)`,
          [id, co, client, project, reference, admin, site()],
        );
      }
    });

    await addContact(clientA, signerA, "signer");
    await addContact(clientA, viewerA, "viewer");
    await addContact(clientA, scopedA, "signer", projectA1);
    await addContact(clientB, contactB, "signer");

    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    await teardownTestDb();
  });

  // ── overview ────────────────────────────────────────────────────────────────────────────────────
  it("overview aggregates only the caller's own client", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.clients).toHaveLength(1);
    expect(b.client.name).toBe("Acme Inc");
    expect(b.progress.projects).toBe(2);
    expect(b.viewOnly).toBe(false);
    // Two projects: A1 at 62 (weighted, done counts as 100 regardless of stored progress) and A2 at 0.
    // Portfolio = mean of PROJECT means = 31, not the pooled task mean.
    expect(b.progress.percent).toBe(31);
    expect(b.nextMilestone.name).toBe("Launch");
    // 1000 invoiced, nothing confirmed yet, and period_end is in the past on a 'sent' invoice.
    expect(b.finance.primary).toMatchObject({ currency: "IDR", invoiced: 1000, paid: 0, outstanding: 1000, overdueCount: 1 });
  });

  it("a viewer is told they are view-only", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(viewerA) });
    expect(r.json().viewOnly).toBe(true);
  });

  it("a project-scoped contact sees only their project", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/projects`, headers: asUser(scopedA) });
    expect(r.statusCode).toBe(200);
    expect(r.json().map((p: { id: string }) => p.id)).toEqual([projectA1]);
  });

  it("refuses a non-client entirely", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/overview`, headers: asUser(admin) });
    // Staff hold `read` on the portal resource in Cerbos (support), so the refusal comes from the scope
    // resolver, not the policy — they are not a contact of any client.
    expect(r.statusCode).toBe(403);
  });

  // ── project detail ──────────────────────────────────────────────────────────────────────────────
  it("project detail carries milestones, deliverables and an aggregate workload — never task titles", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/projects/${projectA1}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    // 4 tasks: done/0, done/100, in_progress/50, todo/0. `done` counts as 100 regardless of its stored
    // progress, so avg = (100 + 100 + 50 + 0) / 4 = 62.5 — and Postgres `round()` on numeric rounds
    // HALF AWAY FROM ZERO, giving 63. (Expected 62 first time round; the SQL was right.)
    expect(b.progressPercent).toBe(63);
    expect(b.milestones).toHaveLength(1);
    expect(b.deliverables[0]).toMatchObject({ name: "Homepage design" });
    expect(b.workload).toMatchObject({ todo: 1, in_progress: 1, done: 2 });
    // The client-safe contract: no individual task ever appears in the payload.
    expect(JSON.stringify(b)).not.toContain("in_progress\",\"title");
    expect(b).not.toHaveProperty("tasks");
  });

  it("404s another client's project rather than 403ing it (no existence oracle)", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/projects/${projectB}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  it("404s a sibling project for a project-scoped contact", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/projects/${projectA2}`, headers: asUser(scopedA) });
    expect(r.statusCode).toBe(404);
  });

  // ── invoices + payments ─────────────────────────────────────────────────────────────────────────
  it("lists only the caller's invoices, with balance", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
    expect(r.json()[0]).toMatchObject({ id: invoiceA, total: 1000, paid: 0, balance: 1000, overdue: true });
  });

  it("404s another client's invoice", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${invoiceB}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  let paymentId: string;

  it("a VIEWER may record a payment (paying is not signing) and it lands pending", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/invoices/${invoiceA}/payments`, headers: asUser(viewerA),
      payload: { amount: 400, paidOn: new Date().toISOString().slice(0, 10), method: "bank_transfer", reference: "TRX-9001" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().status).toBe("pending");
    paymentId = r.json().id;
  });

  it("a pending payment does NOT move the balance or the invoice status", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${invoiceA}`, headers: asUser(signerA) });
    const b = r.json();
    expect(b.status).toBe("sent");            // rule 3: no status side effect
    expect(b.paid).toBe(0);                   // rule 2: a claim is not a payment
    expect(b.balance).toBe(1000);
    expect(b.payments[0]).toMatchObject({ id: paymentId, amount: 400, status: "pending" });
  });

  it("refuses an overpayment beyond the tolerance", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/invoices/${invoiceA}/payments`, headers: asUser(signerA),
      payload: { amount: 5000, paidOn: new Date().toISOString().slice(0, 10) },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/outstanding balance/i);
  });

  it("refuses a future-dated payment", async () => {
    const future = new Date(Date.now() + 86_400_000 * 3).toISOString().slice(0, 10);
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/invoices/${invoiceA}/payments`, headers: asUser(signerA),
      payload: { amount: 10, paidOn: future },
    });
    expect(r.statusCode).toBe(400);
  });

  it("refuses a payment against another client's invoice", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/invoices/${invoiceB}/payments`, headers: asUser(signerA),
      payload: { amount: 10, paidOn: new Date().toISOString().slice(0, 10) },
    });
    expect(r.statusCode).toBe(404);
  });

  it("a confirmed payment moves the balance", async () => {
    // Confirmation is staff's job and has no portal route by design, so it is simulated at the table.
    await withTenants([co], (c) =>
      c.query(
        `UPDATE invoice_payments SET status = 'confirmed', confirmed_by = $2, confirmed_at = now() WHERE id = $1`,
        [paymentId, admin],
      ),
    );
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/invoices/${invoiceA}`, headers: asUser(signerA) });
    expect(r.json()).toMatchObject({ paid: 400, balance: 600 });
  });

  // ── contracts ───────────────────────────────────────────────────────────────────────────────────
  it("lists the caller's contracts with per-party signature state", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toHaveLength(1);
    expect(r.json()[0]).toMatchObject({ id: contractA, status: "sent", clientSigned: false, providerSigned: false, termEnded: false });
  });

  it("404s another client's contract", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractB}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  it("a VIEWER cannot sign a contract", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractA}/sign`, headers: asUser(viewerA),
      payload: { signerName: "Vic Viewer", agree: true },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/view-only/i);
  });

  it("refuses a signature without the explicit attestation", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractA}/sign`, headers: asUser(signerA),
      payload: { signerName: "Sam Signer" },
    });
    expect(r.statusCode).toBe(400);
  });

  it("a signer signs; the contract stays 'sent' until the provider countersigns", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractA}/sign`, headers: asUser(signerA),
      payload: { signerName: "Sam Signer", signerTitle: "CEO", agree: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ complete: false, alreadySigned: false });
    const detail = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${contractA}`, headers: asUser(signerA) });
    expect(detail.json().status).toBe("sent");
    expect(detail.json().canSign).toBe(false);   // already signed by this side
    expect(detail.json().signatures).toHaveLength(1);
  });

  it("re-signing is idempotent, not an error", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${contractA}/sign`, headers: asUser(signerA),
      payload: { signerName: "Sam Signer", agree: true },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().alreadySigned).toBe(true);
  });

  it("flips to signed only when BOTH parties are present", async () => {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, origin_site)
         VALUES ($1, $2, $3, 'provider', $4, 'Agency Director', $5)`,
        [newId(), co, contractA, admin, site()],
      ),
    );
    // The transition is driven by a client signature, so a fresh contract is used: contractA's client
    // party is already in, and re-signing (correctly) does nothing.
    const c2 = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO contracts (id, tenant_id, client_id, title, status, currency, sent_at, created_by, origin_site)
         VALUES ($1, $2, $3, 'Addendum', 'sent', 'IDR', now(), $4, $5)`,
        [c2, co, clientA, admin, site()],
      ),
    );
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO contract_signatures (id, tenant_id, contract_id, party, signer, signer_name, origin_site)
         VALUES ($1, $2, $3, 'provider', $4, 'Agency Director', $5)`,
        [newId(), co, c2, admin, site()],
      ),
    );
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/contracts/${c2}/sign`, headers: asUser(signerA),
      payload: { signerName: "Sam Signer", agree: true },
    });
    expect(r.json().complete).toBe(true);
    const detail = await app.inject({ method: "GET", url: `/api/${co}/portal/contracts/${c2}`, headers: asUser(signerA) });
    expect(detail.json().status).toBe("signed");
    expect(detail.json().signedAt).toBeTruthy();
  });

  // ── files ───────────────────────────────────────────────────────────────────────────────────────
  it("streams a deliverable attachment the caller's client owns, as an attachment only", async () => {
    const fileId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                            content_type, byte_size, storage_key, origin_site)
         VALUES ($1, $2, $3, 'deliverable', $4, 'mock.txt', 'text/plain', 5, $5, $6)`,
        [fileId, co, admin, deliverableA1, `${co}/${fileId}`, site()],
      ),
    );
    // No bytes were put in storage, so the read itself fails — what this pins is that AUTHORIZATION
    // passed (a 404 here would mean the ownership walk refused it, which is the regression that matters).
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(signerA) });
    expect(r.statusCode).not.toBe(404);
    expect(r.statusCode).not.toBe(403);
  });

  it("404s a file whose parent entity kind is not client-downloadable", async () => {
    const fileId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                            content_type, byte_size, storage_key, origin_site)
         VALUES ($1, $2, $3, 'task', $4, 'internal.txt', 'text/plain', 5, $5, $6)`,
        [fileId, co, admin, projectA1, `${co}/${fileId}`, site()],
      ),
    );
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  it("404s another client's file", async () => {
    const fileId = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename,
                            content_type, byte_size, storage_key, origin_site)
         VALUES ($1, $2, $3, 'contract', $4, 'rival.pdf', 'application/pdf', 5, $5, $6)`,
        [fileId, co, admin, contractB, `${co}/${fileId}`, site()],
      ),
    );
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/files/${fileId}`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(404);
  });

  // ── timeline + deliverables ─────────────────────────────────────────────────────────────────────
  it("timeline mixes due and happened items, scoped to the caller", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/timeline`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    const kinds = new Set(r.json().map((e: { kind: string }) => e.kind));
    expect(kinds.has("milestone")).toBe(true);
    expect(kinds.has("contract")).toBe(true);
    expect(kinds.has("invoice")).toBe(true);
    // Client B's contract must not appear anywhere in client A's timeline. Asserted on the FULL id and
    // the reference literal — `contractB.slice(0, 8)` would have been worse than useless here: uuid v7
    // is time-ordered, so that prefix is also contractA's prefix, and the assertion would have failed
    // on correctly-scoped data (a false alarm) rather than catching a leak.
    const body = JSON.stringify(r.json());
    expect(body).not.toContain(contractB);
    expect(body).not.toContain("REF-RIVAL-001");
    expect(new Set(r.json().map((e: { tense: string }) => e.tense)).size).toBeGreaterThan(1);
  });

  it("deliverables list carries attachment metadata", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/deliverables`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    expect(r.json()[0]).toMatchObject({ name: "Homepage design", projectName: "Acme site" });
    expect(Array.isArray(r.json()[0].files)).toBe(true);
  });

  // ── profile ─────────────────────────────────────────────────────────────────────────────────────
  it("profile exposes the caller, their client, their fellow contacts and their own grants", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(signerA) });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.me.email).toBe("signer@acme.test");
    expect(b.clients[0]).toMatchObject({ name: "Acme Inc", projectCount: 2 });
    // Three contacts on client A; client B's contact must not be among them.
    expect(b.contacts).toHaveLength(3);
    expect(b.contacts.map((x: { email: string }) => x.email)).not.toContain("boss@rival.test");
    expect(b.access).toMatchObject({ canSign: true, wholeClient: true });
  });

  it("updates the caller's own name, and nothing else", async () => {
    const r = await app.inject({
      method: "PATCH", url: `/api/${co}/portal/profile`, headers: asUser(signerA),
      payload: { name: "Samuel Signer", title: "Chief Executive", email: "hijack@evil.test", status: "disabled" },
    });
    expect(r.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(signerA) });
    expect(after.json().me).toMatchObject({ name: "Samuel Signer", title: "Chief Executive", email: "signer@acme.test" });
  });

  it("records a profile change request without mutating the client row", async () => {
    const r = await app.inject({
      method: "POST", url: `/api/${co}/portal/profile/change-request`, headers: asUser(signerA),
      payload: { message: "Please update our billing address to Jl. Sudirman 5." },
    });
    expect(r.statusCode).toBe(202);
    const after = await app.inject({ method: "GET", url: `/api/${co}/portal/profile`, headers: asUser(signerA) });
    expect(after.json().clients[0].name).toBe("Acme Inc");
  });

  // ── stream ──────────────────────────────────────────────────────────────────────────────────────
  it("the SSE endpoint opens with a hello frame and declares its mode", async () => {
    // ⚠ `app.inject()` CANNOT test this route, and the first CI run proved it by timing out at 20s.
    // inject resolves when the response COMPLETES; an SSE handler deliberately never completes one —
    // it writes frames and holds the socket open until the client leaves or the 30-minute rotation
    // fires. So this needs a real socket: listen, read the FIRST chunk, then abort as a browser would.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.getHttpServer().address() as { port: number };
    const ctrl = new AbortController();
    try {
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/${co}/portal/stream`, {
        headers: asUser(signerA),
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      // The header that makes SSE survive nginx. Regressing it produces a stream that looks dead
      // rather than broken, which is the hardest failure of this feature to get reported accurately.
      expect(res.headers.get("x-accel-buffering")).toBe("no");

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      // Guarded read: if the handler ever stopped flushing its opening frames, fail with a message that
      // says so instead of hanging until the suite-level timeout kills the whole file.
      const first = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("no SSE frame within 5s — the opening frames are not being flushed")), 5_000),
        ),
      ]);
      const text = new TextDecoder().decode(first.value);
      expect(text).toContain("event: hello");
      expect(text).toMatch(/"mode":"(live|poll)"/);
      // `retry:` sets the browser's own reconnect backoff — without it a server restart produces a
      // thundering herd from every open portal tab.
      expect(text).toContain("retry:");
      await reader.cancel();
    } finally {
      // Abort like a closing tab, which is also what exercises the server's cleanup path (unsubscribe
      // + clear the heartbeat and rotation timers).
      ctrl.abort();
    }
  });

  it("refuses a stream for a non-client", async () => {
    const r = await app.inject({ method: "GET", url: `/api/${co}/portal/stream`, headers: asUser(admin) });
    expect(r.statusCode).toBe(403);
  });
});
