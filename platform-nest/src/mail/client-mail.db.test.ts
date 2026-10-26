// PGL-09 (PV-D47) — mail to client contacts for the things they must act on, over HTTP against real Postgres (RLS) and Cerbos.
//   * a contract to sign (`contract.sent`): the contacts who can SIGN that contract, by the portal's own rule; a viewer gets none
//   * an issued invoice (`invoice.issued`): the contacts who can SEE it in the portal (invoices carry no project: every active contact)
//   * the sign-off gate and the Conversation staff message keep working, now under the one flag
//   * the flag: OFF means no mail_log row and no enqueue for every client type (the in-app notice still lands); the old
//     CONVERSATION_CLIENT_MAIL_ENABLED alias alone turns it on; the staff type is unaffected
//   * each template renders through GET /api/admin/mail/log/:id/preview, with the plain portal deep link and nothing like a token
//
// WHY THE PORTAL IS THE ORACLE. "Who should be mailed" is checked two ways: against the literal list the fixtures say, and
// against what the PORTAL itself answers for each contact (`GET /portal/contracts/:id` -> `canSign`, `GET /portal/invoices/:id`).
// A mail that points a contact at a page the portal 404s, or asks a viewer to sign, fails here whichever rule moved.
//
// Every claim is checked against the STORED rows through adminPool (RLS bypassed), by user id, never inferred from a 2xx.
// Needs DATABASE_URL_TEST + a Cerbos loaded with the current policies. Runs on the Linux gate; skipped elsewhere, and a skip
// is not a pass. Emails are `.test` fixtures: nothing here can reach a real inbox (no mail is ever SENT; the sender loop is not started).
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config, readClientMailEnabled } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { ensureBillingSetup } from "../seed/billing-setup";
import { notify } from "../core/http";
import { buildApp } from "../main";

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });

interface MailRow {
  user_id: string; to_email: string; template_key: string; stream: string; subject: string; status: string;
  entity_type: string | null; reply_token: string | null; payload: Record<string, unknown>; id: string;
}

describe.skipIf(!TEST_URL)("PGL-09: client mail for contracts to sign and invoices to pay (flag, recipients, templates)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;          // company_admin: sends contracts, issues invoices (the actor, never a recipient)
  let recorder: string;       // company_admin: the invoice's maker
  let platformAdmin: string;  // global platform_admin: the mail preview
  let staffMember: string;    // a member: the staff-type control
  let clientA: string;
  let clientB: string;
  let p1: string;             // clientA's projects
  let p2: string;

  // contacts of clientA
  let wideSigner: string;
  let wideAdmin: string;      // capability `admin` implies signer (WSK-49f)
  let wideViewer: string;
  let p1Signer: string;       // signer, limited to p1
  let p1Viewer: string;       // viewer, limited to p1
  let p2Signer: string;       // signer, limited to p2
  let revokedSigner: string;
  let invitedSigner: string;
  // other people
  let otherSigner: string;    // a signer of clientB, nothing on clientA
  let viewerASignerB: string; // a VIEWER of clientA and a SIGNER of clientB: signing is per client

  const linkBase = () => config.mail.linkBaseUrl;
  const base = () => `/api/${co}`;
  const fmtEmail = (name: string) => `${name}@pgl09-client.test`;

  async function addContact(
    client: string, userId: string,
    opts: { status?: string; capability?: string; projectId?: string | null } = {},
  ): Promise<void> {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [newId(), co, client, userId, opts.projectId ?? null, opts.capability ?? "signer", opts.status ?? "active", config.originSite],
      ),
    );
  }

  async function mailFor(templateKey: string, entityId: string): Promise<MailRow[]> {
    return (await adminPool().query<MailRow>(
      `SELECT id, user_id, to_email, template_key, stream, subject, status, entity_type, reply_token, payload
         FROM mail_log WHERE tenant_id = $1 AND template_key = $2 AND payload->>'entityId' = $3 ORDER BY to_email`,
      [co, templateKey, entityId],
    )).rows;
  }
  async function notifiedUsers(type: string, entityId: string): Promise<string[]> {
    const r = await adminPool().query<{ user_id: string }>(
      `SELECT user_id FROM notifications WHERE tenant_id = $1 AND type = $2 AND payload->>'entityId' = $3`,
      [co, type, entityId],
    );
    return r.rows.map((x) => x.user_id).sort();
  }
  const sorted = (...ids: string[]) => [...ids].sort();

  async function draftContract(title: string, clientId: string, projectId?: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `${base()}/contracts`, headers: asUser(admin),
      payload: { clientId, title, bodyMd: "ZZ-CLAUSE-TEXT-9f3a: the terms.", ...(projectId ? { projectId } : {}) },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function sendContract(id: string) {
    const r = await app.inject({ method: "POST", url: `${base()}/contracts/${id}/send`, headers: asUser(admin) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  }
  /** An APPROVED invoice (the stage issue starts from), inserted directly, as the invoice suites do. */
  async function approvedInvoice(clientId: string, amount: number): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, tax_code, service_line_key)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', 'IDR', $4, $5, 'test', $6, $6, $7, now(), NULL, 'services')`,
        [id, co, clientId, JSON.stringify([{ description: "ZZ-LINE-DESC-7c1d", hours: 1, rate: amount, amount }]), amount, recorder, admin],
      ),
    );
    return id;
  }
  const issueInvoice = (id: string) =>
    app.inject({ method: "POST", url: `${base()}/invoices/${id}/issue`, headers: asUser(admin) });

  async function portalContract(userId: string, contractId: string) {
    const r = await app.inject({ method: "GET", url: `${base()}/portal/contracts/${contractId}`, headers: asUser(userId) });
    return { status: r.statusCode, canSign: r.statusCode === 200 ? (r.json().canSign as boolean) : null };
  }
  async function portalInvoiceStatus(userId: string, invoiceId: string): Promise<number> {
    return (await app.inject({ method: "GET", url: `${base()}/portal/invoices/${invoiceId}`, headers: asUser(userId) })).statusCode;
  }
  async function preview(mailLogId: string) {
    const r = await app.inject({ method: "GET", url: `/api/admin/mail/log/${mailLogId}/preview`, headers: asUser(platformAdmin) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { templateKey: string; subject: string; html: string; text: string; renderedFromCurrentTemplate: boolean };
  }

  /** The rendered mail has the ONE plain portal link and nothing token-like. */
  function expectPlainPortalLink(rendered: { subject: string; html: string; text: string }, expectedHref: string) {
    const all = [rendered.subject, rendered.text, rendered.html].join("\n");
    const urls = [...all.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
    expect(new Set(urls)).toEqual(new Set([expectedHref]));
    const u = new URL(expectedHref);
    expect(u.search).toBe("");
    expect(u.hash).toBe("");
    expect(u.pathname.startsWith("/portal/")).toBe(true);
    expect(all).not.toMatch(/token\s*=/i);
    expect(all).not.toMatch(/[?&][a-z_]+=/i);
    expect(all).not.toMatch(/reply\+/i);
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    co = await createCompany("PGL-09 Agency", ["agency", "clients", "invoice"]);
    const adminRole = await createRole("company_admin");
    const memberRole = await createRole("member");
    const clientRole = await createRole("client");

    admin = await createUser("pgl09-admin@agency.test");
    recorder = await createUser("pgl09-recorder@agency.test");
    staffMember = await createUser("pgl09-member@agency.test");
    platformAdmin = await createUser("pgl09-platform@agency.test");
    for (const u of [admin, recorder, staffMember, platformAdmin]) await addMembership(co, u);
    await grantRole(admin, adminRole, "company", co);
    await grantRole(recorder, adminRole, "company", co);
    await grantRole(staffMember, memberRole, "company", co);
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    for (const u of [admin, recorder, staffMember]) {
      await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);
    }

    clientA = await createClient(co, "PGL09 Client A");
    clientB = await createClient(co, "PGL09 Client B");
    p1 = await createProject(co, "PGL09 A Project 1", undefined, clientA);
    p2 = await createProject(co, "PGL09 A Project 2", undefined, clientA);

    const contact = async (name: string, client: string, opts: Parameters<typeof addContact>[2] = {}) => {
      const u = await createUser(fmtEmail(name));
      await addContact(client, u, opts);
      await grantRole(u, clientRole, "company", co);
      return u;
    };
    wideSigner = await contact("wide-signer", clientA, { capability: "signer" });
    wideAdmin = await contact("wide-admin", clientA, { capability: "admin" });
    wideViewer = await contact("wide-viewer", clientA, { capability: "viewer" });
    p1Signer = await contact("p1-signer", clientA, { capability: "signer", projectId: p1 });
    p1Viewer = await contact("p1-viewer", clientA, { capability: "viewer", projectId: p1 });
    p2Signer = await contact("p2-signer", clientA, { capability: "signer", projectId: p2 });
    revokedSigner = await contact("revoked-signer", clientA, { capability: "signer", status: "revoked" });
    invitedSigner = await contact("invited-signer", clientA, { capability: "signer", status: "invited" });
    otherSigner = await contact("other-signer", clientB, { capability: "signer" });
    viewerASignerB = await contact("viewer-a-signer-b", clientA, { capability: "viewer" });
    await addContact(clientB, viewerASignerB, { capability: "signer" });

    await ensureBillingSetup(co, { prefix: "PGL" });
    app = await buildApp();
  }, 180_000);

  afterAll(async () => {
    config.mail.enabled = false;
    config.mail.clientMailEnabled = false;
    await app?.close();
    await teardownTestDb();
  });

  afterEach(async () => {
    config.mail.enabled = false;
    config.mail.clientMailEnabled = false;
    await adminPool().query(`DELETE FROM mail_log`);
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // contract.sent
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  describe("a contract to sign (contract.sent)", () => {
    it("mails the contacts who can SIGN that contract, and nobody else: no viewer, no other client, no revoked or invited contact, not the actor", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Services Agreement (project one)", clientA, p1);
      const sent = await sendContract(id);

      // a signer or an admin of the client who can reach the contract: client-wide ones, and the one limited to THIS project
      const expected = sorted(wideSigner, wideAdmin, p1Signer);
      expect(await notifiedUsers("contract.sent", id)).toEqual(expected);
      expect(sent.notified).toBe(expected.length);

      const rows = await mailFor("contract.sent", id);
      expect(rows.map((r) => r.user_id).sort()).toEqual(expected);
      expect(rows.map((r) => r.to_email).sort()).toEqual([fmtEmail("p1-signer"), fmtEmail("wide-admin"), fmtEmail("wide-signer")]);

      // the people who must NOT be mailed, named: the viewers (no "to sign" mail), the other project's signer, a contact of
      // another client, a signer of clientB who only VIEWS clientA (signing is per client), revoked, invited, the actor
      const mailed = new Set(rows.map((r) => r.user_id));
      for (const [who, id2] of Object.entries({ wideViewer, p1Viewer, p2Signer, otherSigner, viewerASignerB, revokedSigner, invitedSigner, admin, recorder })) {
        expect(mailed.has(id2), `${who} must not be mailed`).toBe(false);
      }
      // …and not notified in-app either: a viewer is never asked to sign
      const notified = await notifiedUsers("contract.sent", id);
      for (const v of [wideViewer, p1Viewer, viewerASignerB]) expect(notified).not.toContain(v);

      // what the row is: a pointer. Fixed subject, no reply token, the plain portal link, the title, nothing else
      for (const r of rows) {
        expect(r).toMatchObject({ stream: "notify", status: "queued", entity_type: null, reply_token: null });
        expect(r.subject).toBe("A contract is ready for you to review and sign");
        expect(r.payload.href).toBe(`${linkBase()}/portal/contracts/${id}`);
        expect(r.payload.contractTitle).toBe("PGL-09 Services Agreement (project one)");
        expect(Object.keys(r.payload).sort()).toEqual(["contractTitle", "entityId", "href", "subjectTitle"]);
        expect(JSON.stringify(r.payload)).not.toContain("ZZ-CLAUSE-TEXT-9f3a");
      }
    });

    it("PARITY WITH THE PORTAL: a contact is mailed iff the portal shows them this contract AND says canSign", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Parity Agreement", clientA, p1);
      await sendContract(id);
      const mailed = new Set((await mailFor("contract.sent", id)).map((r) => r.user_id));
      const everyone: Record<string, string> = {
        wideSigner, wideAdmin, wideViewer, p1Signer, p1Viewer, p2Signer, revokedSigner, invitedSigner, otherSigner, viewerASignerB,
      };
      const mailedByPortalRule: string[] = [];
      for (const [name, uid] of Object.entries(everyone)) {
        const seen = await portalContract(uid, id);
        const portalSaysSign = seen.status === 200 && seen.canSign === true;
        expect(mailed.has(uid), `${name}: mailed=${mailed.has(uid)} but the portal answers ${seen.status} canSign=${String(seen.canSign)}`).toBe(portalSaysSign);
        if (portalSaysSign) mailedByPortalRule.push(name);
      }
      // the control: the oracle is not vacuous (three people can sign it) and a viewer can read it yet is not mailed
      expect(mailedByPortalRule.sort()).toEqual(["p1Signer", "wideAdmin", "wideSigner"]);
      expect((await portalContract(wideViewer, id)).status).toBe(200);
      expect((await portalContract(wideViewer, id)).canSign).toBe(false);
    });

    it("a master agreement (no project) reaches the signers limited to a project too, exactly as the portal shows it to them", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Master Agreement", clientA);
      await sendContract(id);
      const rows = await mailFor("contract.sent", id);
      expect(rows.map((r) => r.user_id).sort()).toEqual(sorted(wideSigner, wideAdmin, p1Signer, p2Signer));
      for (const uid of [p1Signer, p2Signer]) expect(await portalContract(uid, id)).toEqual({ status: 200, canSign: true });
      // still no viewer, and still no contact of another client
      const mailed = new Set(rows.map((r) => r.user_id));
      for (const uid of [wideViewer, p1Viewer, otherSigner, viewerASignerB, revokedSigner, invitedSigner]) expect(mailed.has(uid)).toBe(false);
    });

    it("a contract for ANOTHER client reaches only that client's signers", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Client B Agreement", clientB);
      await sendContract(id);
      const rows = await mailFor("contract.sent", id);
      // otherSigner (signer of B) and viewerASignerB (signer of B), and nobody who is only a contact of A
      expect(rows.map((r) => r.user_id).sort()).toEqual(sorted(otherSigner, viewerASignerB));
    });

    it("FLAG OFF: the signers still get the in-app notice, and there is NO mail_log row at all", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = false;
      const id = await draftContract("PGL-09 Flag Off Agreement", clientA, p1);
      await sendContract(id);
      expect(await notifiedUsers("contract.sent", id)).toEqual(sorted(wideSigner, wideAdmin, p1Signer));
      expect(await mailFor("contract.sent", id)).toEqual([]);
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log`)).rows[0].n).toBe(0);
    });

    it("the old CONVERSATION_CLIENT_MAIL_ENABLED alias ALONE turns it on; neither variable leaves it off", async () => {
      config.mail.enabled = true;
      // what the config read gives for a box that only ever set the alias
      config.mail.clientMailEnabled = readClientMailEnabled({ CONVERSATION_CLIENT_MAIL_ENABLED: "1" });
      const on = await draftContract("PGL-09 Alias On Agreement", clientA, p1);
      await sendContract(on);
      expect((await mailFor("contract.sent", on)).map((r) => r.user_id).sort()).toEqual(sorted(wideSigner, wideAdmin, p1Signer));

      config.mail.clientMailEnabled = readClientMailEnabled({});
      const off = await draftContract("PGL-09 Alias Off Agreement", clientA, p1);
      await sendContract(off);
      expect(await mailFor("contract.sent", off)).toEqual([]);
    });

    it("the master MAIL_ENABLED gate off: nothing, even with the client flag on", async () => {
      config.mail.enabled = false;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Master Off Agreement", clientA, p1);
      await sendContract(id);
      expect(await mailFor("contract.sent", id)).toEqual([]);
      expect(await notifiedUsers("contract.sent", id)).toEqual(sorted(wideSigner, wideAdmin, p1Signer));
    });

    it("renders through the admin preview: the portal deep link, the title, no token, no contract text", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await draftContract("PGL-09 Preview Agreement", clientA, p1);
      await sendContract(id);
      const [row] = await mailFor("contract.sent", id);
      const p = await preview(row.id);
      expect(p).toMatchObject({ templateKey: "contract.sent", subject: "A contract is ready for you to review and sign", renderedFromCurrentTemplate: true });
      expect(p.text).toContain("PGL-09 Preview Agreement");
      expect(p.text).toContain(`${linkBase()}/portal/contracts/${id}`);
      expectPlainPortalLink(p, `${linkBase()}/portal/contracts/${id}`);
      expect([p.subject, p.text, p.html].join("\n")).not.toContain("ZZ-CLAUSE-TEXT-9f3a");
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // invoice.issued
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  describe("an issued invoice (invoice.issued)", () => {
    // every ACTIVE contact of clientA: invoices carry no project, so reach is by client only (project-limited ones, viewers too)
    const reach = () => sorted(wideSigner, wideAdmin, wideViewer, p1Signer, p1Viewer, p2Signer, viewerASignerB);

    it("mails every active contact who can see the invoice in the portal, and nobody of another client, revoked or invited", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await approvedInvoice(clientA, 2_500_000);
      const res = await issueInvoice(id);
      expect(res.statusCode, res.body).toBe(200);
      const issued = res.json();
      expect(issued.alreadyIssued).toBe(false);

      expect(await notifiedUsers("invoice.issued", id)).toEqual(reach());
      const rows = await mailFor("invoice.issued", id);
      expect(rows.map((r) => r.user_id).sort()).toEqual(reach());
      const mailed = new Set(rows.map((r) => r.user_id));
      for (const [who, uid] of Object.entries({ otherSigner, revokedSigner, invitedSigner, admin, recorder })) {
        expect(mailed.has(uid), `${who} must not be mailed`).toBe(false);
      }
      // a project-limited contact IS mailed: an invoice is not project-scoped, so the portal shows it to them
      expect(mailed.has(p1Viewer)).toBe(true);
      expect(mailed.has(p2Signer)).toBe(true);

      // PARITY WITH THE PORTAL: the contacts the portal serves this invoice to are exactly the contacts mailed
      const everyone: Record<string, string> = {
        wideSigner, wideAdmin, wideViewer, p1Signer, p1Viewer, p2Signer, revokedSigner, invitedSigner, otherSigner, viewerASignerB,
      };
      for (const [name, uid] of Object.entries(everyone)) {
        const status = await portalInvoiceStatus(uid, id);
        expect(mailed.has(uid), `${name}: mailed=${mailed.has(uid)} but the portal answers ${status}`).toBe(status === 200);
      }

      // what the row is: a pointer with the number and the total, and nothing else about the money
      for (const r of rows) {
        expect(r).toMatchObject({ stream: "notify", status: "queued", entity_type: null, reply_token: null });
        expect(r.subject).toBe(`Invoice ${issued.invoiceNo} is ready`);
        expect(r.payload.href).toBe(`${linkBase()}/portal/invoices/${id}`);
        expect(r.payload).toMatchObject({ invoiceNo: issued.invoiceNo, currency: "IDR", entityId: id });
        expect(String(r.payload.total)).toMatch(/^2500000(\.0+)?$/);
        expect(Object.keys(r.payload).sort()).toEqual(["currency", "entityId", "href", "invoiceNo", "subjectTitle", "total"]);
        expect(JSON.stringify(r.payload)).not.toContain("ZZ-LINE-DESC-7c1d");
      }
    });

    it("renders through the admin preview: the number, the total, the portal deep link, no token, no line detail", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await approvedInvoice(clientA, 1_234_567);
      const issued = (await issueInvoice(id)).json();
      const [row] = await mailFor("invoice.issued", id);
      const p = await preview(row.id);
      expect(p).toMatchObject({ templateKey: "invoice.issued", subject: `Invoice ${issued.invoiceNo} is ready`, renderedFromCurrentTemplate: true });
      expect(p.text).toContain(`Invoice ${issued.invoiceNo}`);
      expect(p.text).toMatch(/total IDR 1,234,567(\.\d+)?,/);
      expect(p.text).toContain(`${linkBase()}/portal/invoices/${id}`);
      expectPlainPortalLink(p, `${linkBase()}/portal/invoices/${id}`);
      const all = [p.subject, p.text, p.html].join("\n");
      expect(all).not.toContain("ZZ-LINE-DESC-7c1d");
      expect(all).not.toMatch(/\breply\b/i);
    });

    it("FLAG OFF: the contacts still get the in-app notice, and there is NO mail_log row at all", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = false;
      const id = await approvedInvoice(clientA, 100_000);
      expect((await issueInvoice(id)).statusCode).toBe(200);
      expect(await notifiedUsers("invoice.issued", id)).toEqual(reach());
      expect(await mailFor("invoice.issued", id)).toEqual([]);
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log`)).rows[0].n).toBe(0);
    });

    it("the alias alone turns it on for invoices as well", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = readClientMailEnabled({ CONVERSATION_CLIENT_MAIL_ENABLED: "1" });
      const id = await approvedInvoice(clientA, 100_000);
      expect((await issueInvoice(id)).statusCode).toBe(200);
      expect((await mailFor("invoice.issued", id)).map((r) => r.user_id).sort()).toEqual(reach());
    });

    it("IDEMPOTENT: issuing again answers alreadyIssued and mails nobody twice; a repeated notification is deduplicated per contact", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await approvedInvoice(clientA, 300_000);
      const first = await issueInvoice(id);
      expect(first.json().alreadyIssued).toBe(false);
      expect((await mailFor("invoice.issued", id)).length).toBe(reach().length);

      const again = await issueInvoice(id);
      expect(again.json().alreadyIssued).toBe(true);
      expect((await mailFor("invoice.issued", id)).length).toBe(reach().length);

      // an event that fires twice: the same notification handed to the intake again adds no mail for that contact
      await notify(co, wideSigner, admin, "invoice.issued", {
        title: "again", href: `/portal/invoices/${id}`, entityType: "invoice", entityId: id, invoiceNo: "X", total: "1.00", currency: "IDR",
      });
      const rows = await mailFor("invoice.issued", id);
      expect(rows.length).toBe(reach().length);
      expect(rows.filter((r) => r.user_id === wideSigner).length).toBe(1);
    });

    it("an invoice for another client reaches only that client's contacts", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const id = await approvedInvoice(clientB, 50_000);
      expect((await issueInvoice(id)).statusCode).toBe(200);
      // otherSigner, and viewerASignerB (who is a contact of B too); not one contact who is only on A
      expect((await mailFor("invoice.issued", id)).map((r) => r.user_id).sort()).toEqual(sorted(otherSigner, viewerASignerB));
    });

    it("a notification with no entity id is never mailed (there would be no way to deduplicate it)", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      await notify(co, wideSigner, admin, "invoice.issued", { title: "no entity", href: "/portal/invoices/x" });
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE user_id = $1`, [wideSigner])).rows[0].n).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════════════════
  // the two types that already mailed, and the staff type, under the one flag
  // ═══════════════════════════════════════════════════════════════════════════════════════════

  describe("the existing types under the one flag", () => {
    async function openSignGate(): Promise<{ runId: string; gateId: string }> {
      const run = await app.inject({ method: "POST", url: `${base()}/pipeline/runs`, headers: asUser(admin), payload: { title: "PGL-09 run", clientId: clientA } });
      expect([200, 201], run.body).toContain(run.statusCode);
      const runId = run.json().id as string;
      const gate = await app.inject({ method: "POST", url: `${base()}/pipeline/gates`, headers: asUser(admin), payload: { runId, kind: "prd_sign", actorSide: "client" } });
      expect(gate.statusCode, gate.body).toBe(201);
      return { runId, gateId: gate.json().id as string };
    }

    it("sign-off gate, flag ON: mailed to the client-wide signers and admins only, with the unchanged wording and portal link", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      const { runId, gateId } = await openSignGate();
      // the gate row carries its id on the entity columns (the thread-authz kind), not in payload.entityId
      const gateRows = (await adminPool().query<MailRow>(
        `SELECT id, user_id, to_email, template_key, stream, subject, status, entity_type, reply_token, payload
           FROM mail_log WHERE tenant_id = $1 AND entity_type = 'pipeline_gate' AND entity_id = $2 ORDER BY to_email`,
        [co, gateId],
      )).rows;
      expect(gateRows.map((r) => r.user_id).sort()).toEqual(sorted(wideSigner, wideAdmin));
      for (const r of gateRows) {
        expect(r.template_key).toBe("approval.actionable");
        expect(r.payload.href).toBe(`${linkBase()}/portal/approvals/${runId}`);
        expect(r.reply_token).not.toBeNull(); // unchanged behaviour: the gate mail still mints its reply token
      }
      const p = await preview(gateRows[0].id);
      expect(p.templateKey).toBe("approval.actionable");
      expectPlainPortalLink(p, `${linkBase()}/portal/approvals/${runId}`);
    });

    it("sign-off gate, flag OFF: the in-app notice lands, NO mail_log row", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = false;
      const { gateId } = await openSignGate();
      expect(await notifiedUsers("pipeline.gate.opened", gateId)).toEqual(sorted(wideSigner, wideAdmin));
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE entity_id = $1`, [gateId])).rows[0].n).toBe(0);
    });

    it("conversation staff message, flag ON: one pointer mail, throttled per thread; flag OFF: none", async () => {
      const threadId = newId();
      const send = () =>
        notify(co, wideViewer, admin, "conversation.message.staff", {
          title: "You have a new message", href: `/portal/conversation/${threadId}`, entityType: "conversation", entityId: threadId,
        });
      const count = async () =>
        (await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE user_id = $1 AND template_key = 'conversation.message.staff'`, [wideViewer])).rows[0].n as number;

      config.mail.enabled = true;
      config.mail.clientMailEnabled = false;
      await send();
      expect(await count()).toBe(0);

      config.mail.clientMailEnabled = true;
      await send();
      await send(); // the throttle: still one until the contact reads the thread
      expect(await count()).toBe(1);
      const [row] = (await adminPool().query<MailRow>(
        `SELECT id, payload, reply_token FROM mail_log WHERE user_id = $1 AND template_key = 'conversation.message.staff'`, [wideViewer],
      )).rows;
      expect(row.reply_token).toBeNull();
      const p = await preview(row.id);
      expect(p.subject).toBe("You have a new message");
      expectPlainPortalLink(p, `${linkBase()}/portal/conversation/${threadId}`);
    });

    it("the STAFF type is unchanged: approval.requested mails a staff member with the client flag OFF and ON", async () => {
      config.mail.enabled = true;
      for (const flag of [false, true]) {
        config.mail.clientMailEnabled = flag;
        await adminPool().query(`DELETE FROM mail_log WHERE user_id = $1`, [staffMember]);
        await notify(co, staffMember, admin, "approval.requested", { title: "Approve a thing", href: "/approvals", origin: "hr" });
        const rows = (await adminPool().query(`SELECT template_key FROM mail_log WHERE user_id = $1`, [staffMember])).rows;
        expect(rows, `client flag ${String(flag)}`).toEqual([{ template_key: "approval.actionable" }]);
      }
    });

    it("types that are not on the allow-list never mail, flag on or off (the control for every probe above)", async () => {
      config.mail.enabled = true;
      config.mail.clientMailEnabled = true;
      await notify(co, wideSigner, admin, "invoice.payment.confirmed", { title: "paid", href: "/portal/invoices/x", entityType: "invoice", entityId: newId() });
      await notify(co, wideSigner, admin, "contract.signed", { title: "signed", href: "/portal/contracts/x", entityType: "contract", entityId: newId() });
      await notify(co, wideSigner, admin, "report.published", { title: "report", href: "/portal/reports", entityType: "report", entityId: newId() });
      expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log WHERE user_id = $1`, [wideSigner])).rows[0].n).toBe(0);
    });
  });
});
