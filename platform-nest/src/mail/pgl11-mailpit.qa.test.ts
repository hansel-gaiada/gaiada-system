// PGL-11 QA GATE — the five client mails, delivered by the REAL sender over SMTP to a throwaway Mailpit sink, read back
// through Mailpit's HTTP API. Contract: docs/FRONTEND-BFF-CONTRACT.md §62 and §62.5.
//
// WHAT THIS PROVES: the real route fires the action, the real mail intake queues the row, the real sender
// (`sendDueMailOnce` -> `resolveAdapter` -> the nodemailer `smtp` adapter on the NOTIFY stream) hands the message to an
// SMTP relay, and what arrives renders, goes to exactly the right contacts, carries exactly one portal link with the
// right path, and (for the invitation) carries a one-time link that really accepts once.
//
// HONESTY RULE (mail design): a Mailpit catch proves RENDERING and WIRING. It proves nothing about DELIVERABILITY:
// SPF, DKIM, DMARC, the Google Workspace relay, reputation and spam placement are a MANUAL readiness item at cut-over.
//
// SKIPS unless PGL11_MAILPIT_URL is set (and DATABASE_URL_TEST, as every DB suite). It runs on the sumopod gate
// (`gate-pgl11.sh`) with: MAIL_ENABLED=1, CLIENT_MAIL_ENABLED=1, MAIL_STREAM_NOTIFY_RELAY_HOST/PORT -> the Mailpit
// container's SMTP port, MAIL_STREAM_NOTIFY_FROM on a `.test` domain, MAIL_LINK_BASE_URL, PGL11_MAILPIT_URL=http://<mailpit>:8025.
// The relay host MUST be the throwaway sink: the suite refuses to run if it is not the host of PGL11_MAILPIT_URL.
// Every address is a `.test` fixture. The Keycloak admin client is a test double (as in client-invite-mail.db.test.ts).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { newId, withTenants } from "../db";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient, createProject } from "../testing/fixtures";
import { ensureBillingSetup } from "../seed/billing-setup";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { buildApp } from "../main";
import { sendDueMailOnce } from "./sender";
import { resetSmtpTransporterCacheForTest } from "./provider";

const MAILPIT = (process.env.PGL11_MAILPIT_URL ?? "").replace(/\/$/, "");

// ---- the Keycloak doubles (the same wrapping client-invite-mail.db.test.ts uses) ----
const kc = vi.hoisted(() => ({ existing: new Set<string>(), created: [] as Array<[string, string | null | undefined]> }));
vi.mock("../core/keycloak-admin", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../core/keycloak-admin")>();
  return {
    ...orig,
    findUserByEmail: async (email: string) => (kc.existing.has(email) ? { id: `kc-${email}` } : null),
    createUser: async (input: { email: string; password?: string | null }) => {
      if (kc.existing.has(input.email)) throw new orig.KeycloakUserExistsError(input.email);
      kc.created.push([input.email, input.password]);
      kc.existing.add(input.email);
      return `kc-${input.email}`;
    },
    disableUser: async () => {},
    enableUser: async () => {},
    setPassword: async () => {},
  };
});

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const PASSWORD = "a-long-enough-password-123";

// ---- the Mailpit client ----
interface Caught { id: string; to: string[]; from: string; subject: string; text: string; html: string; replyTo: string[] }
async function mailpitClear(): Promise<void> {
  const r = await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  if (!r.ok) throw new Error(`mailpit clear: ${r.status}`);
}
async function mailpitCaught(): Promise<Caught[]> {
  const list = await (await fetch(`${MAILPIT}/api/v1/messages?limit=500`)).json() as { messages: Array<{ ID: string }> };
  const out: Caught[] = [];
  for (const m of list.messages) {
    const d = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json() as {
      ID: string; Subject: string; Text: string; HTML: string;
      From: { Address: string }; To: Array<{ Address: string }>; ReplyTo?: Array<{ Address: string }>;
    };
    out.push({
      id: d.ID, to: d.To.map((x) => x.Address), from: d.From.Address, subject: d.Subject, text: d.Text ?? "", html: d.HTML ?? "",
      replyTo: (d.ReplyTo ?? []).map((x) => x.Address),
    });
  }
  return out;
}
const urlsIn = (m: Caught): string[] => [...new Set([...[m.subject, m.text, m.html].join("\n").matchAll(/https?:\/\/[^\s"'<>]+/g)].map((x) => x[0]))];

describe.skipIf(!TEST_URL || !MAILPIT)("PGL-11: the five client mails delivered by the real sender to a Mailpit sink (rendering and wiring, NOT deliverability)", () => {
  let app: NestFastifyApplication;
  let co: string;
  let admin: string;
  let manager: string;
  let recorder: string;
  let clientA: string;
  let clientB: string;
  let p1: string;
  let p2: string;
  let wideSigner: string, wideAdmin: string, wideViewer: string, p1Signer: string, p1Viewer: string, p2Signer: string;
  let revokedSigner: string, invitedSigner: string, otherSigner: string, viewerASignerB: string;

  const email = (name: string) => `${name}@pgl11-client.test`;
  const base = () => `/api/${co}`;
  const linkBase = () => config.mail.linkBaseUrl;
  const sorted = (xs: string[]) => [...xs].sort();
  const fromAddress = () => /<([^>]+)>|^([^<\s]+)$/.exec(config.mail.streams.notify.from)!.slice(1).find(Boolean)!;

  async function addContact(client: string, userId: string, o: { status?: string; capability?: string; projectId?: string | null } = {}) {
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO client_contacts (id, tenant_id, client_id, user_id, project_id, capability, status, activated_at, origin_site)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)`,
        [newId(), co, client, userId, o.projectId ?? null, o.capability ?? "signer", o.status ?? "active", config.originSite],
      ),
    );
  }
  async function draftContract(title: string, clientId: string, projectId?: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `${base()}/contracts`, headers: asUser(admin),
      payload: { clientId, title, bodyMd: "ZZ-CLAUSE-TEXT-pgl11: the terms.", ...(projectId ? { projectId } : {}) },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id;
  }
  async function sendContract(id: string) {
    const r = await app.inject({ method: "POST", url: `${base()}/contracts/${id}/send`, headers: asUser(admin) });
    expect(r.statusCode, r.body).toBe(200);
  }
  async function approvedInvoice(clientId: string, amount: number): Promise<string> {
    const id = newId();
    await withTenants([co], (c) =>
      c.query(
        `INSERT INTO invoices (id, tenant_id, client_id, period_start, period_end, status, currency, lines, total, origin_site,
                               created_by, updated_by, approved_by, approved_at, tax_code, service_line_key)
         VALUES ($1, $2, $3, current_date - 30, current_date, 'approved', 'IDR', $4, $5, 'test', $6, $6, $7, now(), NULL, 'services')`,
        [id, co, clientId, JSON.stringify([{ description: "ZZ-LINE-DESC-pgl11", hours: 1, rate: amount, amount }]), amount, recorder, admin],
      ),
    );
    return id;
  }
  async function issueInvoice(id: string) {
    const r = await app.inject({ method: "POST", url: `${base()}/invoices/${id}/issue`, headers: asUser(admin) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { invoiceNo: string };
  }
  async function openSignGate(): Promise<{ runId: string }> {
    const run = await app.inject({ method: "POST", url: `${base()}/pipeline/runs`, headers: asUser(admin), payload: { title: "PGL-11 run", clientId: clientA } });
    expect([200, 201], run.body).toContain(run.statusCode);
    const runId = run.json().id as string;
    const gate = await app.inject({ method: "POST", url: `${base()}/pipeline/gates`, headers: asUser(admin), payload: { runId, kind: "prd_sign", actorSide: "client" } });
    expect(gate.statusCode, gate.body).toBe(201);
    return { runId };
  }
  async function staffOpenThread(clientId: string, projectId?: string): Promise<string> {
    const r = await app.inject({
      method: "POST", url: `${base()}/conversation`, headers: asUser(admin),
      payload: { clientId, body: "PGL-11 hello from staff", ...(projectId ? { projectId } : {}) },
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().threadId as string;
  }
  async function invite(addr: string, delivery?: string) {
    const r = await app.inject({
      method: "POST", url: `${base()}/clients/${clientA}/contacts`, headers: asUser(manager),
      payload: { email: addr, capability: "signer", ...(delivery ? { delivery } : {}) },
    });
    return { status: r.statusCode, body: r.json(), raw: r.body };
  }
  const accept = (token: string) => app.inject({ method: "POST", url: `/api/invites/accept`, payload: { token, password: PASSWORD } });

  /** Let the REAL sender deliver everything due, then return what Mailpit caught. */
  async function deliver(): Promise<Caught[]> {
    await sendDueMailOnce(500);
    return mailpitCaught();
  }
  const mailLog = async () =>
    (await adminPool().query<{ to_email: string; template_key: string; stream: string; status: string; provider: string | null }>(
      `SELECT to_email, template_key, stream, status, provider FROM mail_log ORDER BY to_email`,
    )).rows;

  /** The common shape of every one of the five: right recipients, sent over SMTP on the notify stream, From right,
   *  and exactly ONE link in the whole message, plain, with the expected path. Returns the messages. */
  function expectPointer(msgs: Caught[], o: { to: string[]; subject: string | RegExp; path: string }) {
    expect(sorted(msgs.flatMap((m) => m.to))).toEqual(sorted(o.to));
    expect(msgs).toHaveLength(o.to.length); // one message per recipient, no extras, no duplicates
    for (const m of msgs) {
      expect(m.from).toBe(fromAddress());
      expect(m.from.endsWith(".test")).toBe(true);
      if (typeof o.subject === "string") expect(m.subject).toBe(o.subject); else expect(m.subject).toMatch(o.subject);
      expect(m.text.length).toBeGreaterThan(20);
      expect(m.html).toContain("<a ");
      const urls = urlsIn(m);
      expect(urls, `links in the mail to ${m.to}`).toHaveLength(1);
      const u = new URL(urls[0]);
      expect(`${u.origin}`).toBe(linkBase());
      expect(u.pathname).toBe(o.path);
      expect(u.search).toBe("");
      expect(u.hash).toBe("");
      // no other link carries a token, and the message has no token-looking string at all
      const all = [m.subject, m.text, m.html].join("\n");
      expect(all).not.toMatch(/inv\d\.[A-Za-z0-9_-]{8,}/);
      expect(all).not.toMatch(/token\s*=/i);
    }
  }
  async function expectSentOnNotifyStream(templateKey: string, n: number) {
    const rows = (await mailLog()).filter((r) => r.template_key === templateKey);
    expect(rows).toHaveLength(n);
    for (const r of rows) expect(r, r.to_email).toMatchObject({ stream: "notify", status: "sent", provider: "smtp" });
  }

  beforeAll(async () => {
    // The relay MUST be the throwaway sink. Refuse to run anywhere else: this suite must never reach a real mailbox.
    const relay = config.mail.streams.notify.relay;
    if (config.mail.streams.notify.transport !== "relay" || !relay.host) throw new Error("PGL-11: MAIL_STREAM_NOTIFY_RELAY_HOST is not set; the sender would fall back to dev-log");
    if (relay.host !== new URL(MAILPIT).hostname) throw new Error(`PGL-11: relay host ${relay.host} is not the Mailpit host ${new URL(MAILPIT).hostname}`);
    if (!/\.test>?$/.test(config.mail.streams.notify.from)) throw new Error("PGL-11: MAIL_STREAM_NOTIFY_FROM must be on a .test domain");
    const up = await fetch(`${MAILPIT}/api/v1/info`);
    if (!up.ok) throw new Error(`PGL-11: Mailpit not reachable at ${MAILPIT}`);

    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    resetSmtpTransporterCacheForTest();
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("PGL-11 Agency", ["agency", "clients", "invoice", "social"]);
    const adminRole = await createRole("company_admin");
    const clientRole = await createRole("client");
    admin = await createUser("pgl11-admin@agency.test");
    recorder = await createUser("pgl11-recorder@agency.test");
    manager = await createUser("pgl11-manager@agency.test");
    for (const u of [admin, recorder, manager]) await addMembership(co, u);
    await grantRole(admin, adminRole, "company", co);
    await grantRole(recorder, adminRole, "company", co);
    await grantRole(manager, await createRole("manager"), "company", co);
    for (const u of [admin, recorder, manager]) await adminPool().query(`UPDATE users SET home_company_id = $1 WHERE id = $2`, [co, u]);

    clientA = await createClient(co, "PGL11 Client A");
    clientB = await createClient(co, "PGL11 Client B");
    p1 = await createProject(co, "PGL11 A Project 1", undefined, clientA);
    p2 = await createProject(co, "PGL11 A Project 2", undefined, clientA);

    const contact = async (name: string, client: string, opts: Parameters<typeof addContact>[2] = {}) => {
      const u = await createUser(email(name));
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
    void [revokedSigner, invitedSigner];

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
    await mailpitClear();
  });

  const on = () => { config.mail.enabled = true; config.mail.clientMailEnabled = true; };

  it("the setup is what the proof claims: the notify stream is a relay to the sink, with a .test From (so a green run is not the dev-log fallback)", () => {
    expect(config.mail.streams.notify.transport).toBe("relay");
    expect(config.mail.streams.notify.relay.host).toBe(new URL(MAILPIT).hostname);
    expect(config.mail.streams.notify.relay.user).toBe("");
    expect(fromAddress()).toMatch(/@[a-z0-9.-]+\.test$/);
    expect(fromAddress()).not.toContain("invalid");
  });

  // ═════════════════ contract.sent ═════════════════
  it("contract.sent (project contract): the signers who can reach it get it over SMTP; a viewer, the other project's signer and another client's contact get nothing", async () => {
    on();
    const id = await draftContract("PGL-11 Services Agreement (project one)", clientA, p1);
    await sendContract(id);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: [email("wide-signer"), email("wide-admin"), email("p1-signer")],
      subject: "A contract is ready for you to review and sign",
      path: `/portal/contracts/${id}`,
    });
    for (const m of msgs) {
      expect(m.text).toContain("PGL-11 Services Agreement (project one)");
      expect(m.text + m.html).not.toContain("ZZ-CLAUSE-TEXT-pgl11");
      expect(m.replyTo).toEqual([]); // no reply token on a contract mail
    }
    const got = new Set(msgs.flatMap((m) => m.to));
    for (const nobody of ["wide-viewer", "p1-viewer", "p2-signer", "other-signer", "viewer-a-signer-b", "revoked-signer", "invited-signer"]) {
      expect(got.has(email(nobody)), `${nobody} must not get a contract-to-sign mail`).toBe(false);
    }
    await expectSentOnNotifyStream("contract.sent", 3);
  });

  it("contract.sent (master agreement, no project): project-limited SIGNERS get it too; viewers still do not", async () => {
    on();
    const id = await draftContract("PGL-11 Master Agreement", clientA);
    await sendContract(id);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: [email("wide-signer"), email("wide-admin"), email("p1-signer"), email("p2-signer")],
      subject: "A contract is ready for you to review and sign",
      path: `/portal/contracts/${id}`,
    });
    const got = new Set(msgs.flatMap((m) => m.to));
    for (const v of ["wide-viewer", "p1-viewer", "viewer-a-signer-b", "other-signer"]) expect(got.has(email(v)), v).toBe(false);
  });

  it("contract.sent (another client's contract): only that client's signers; none of client A's contacts", async () => {
    on();
    const id = await draftContract("PGL-11 Client B Agreement", clientB);
    await sendContract(id);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: [email("other-signer"), email("viewer-a-signer-b")],
      subject: "A contract is ready for you to review and sign",
      path: `/portal/contracts/${id}`,
    });
  });

  // ═════════════════ invoice.issued ═════════════════
  it("invoice.issued: every active contact of that client (invoices carry no project), nobody of another client; subject, total and the one link render", async () => {
    on();
    const id = await approvedInvoice(clientA, 2_500_000);
    const issued = await issueInvoice(id);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: ["wide-signer", "wide-admin", "wide-viewer", "p1-signer", "p1-viewer", "p2-signer", "viewer-a-signer-b"].map(email),
      subject: `Invoice ${issued.invoiceNo} is ready`,
      path: `/portal/invoices/${id}`,
    });
    for (const m of msgs) {
      expect(m.text).toContain(`Invoice ${issued.invoiceNo}`);
      expect(m.text).toMatch(/IDR 2,500,000(\.00)?/);
      expect(m.text + m.html).not.toContain("ZZ-LINE-DESC-pgl11");
      expect(m.replyTo).toEqual([]);
    }
    const got = new Set(msgs.flatMap((m) => m.to));
    for (const nobody of ["other-signer", "revoked-signer", "invited-signer"]) expect(got.has(email(nobody)), nobody).toBe(false);
    await expectSentOnNotifyStream("invoice.issued", 7);
  });

  // ═════════════════ pipeline.gate.opened ═════════════════
  it("pipeline.gate.opened (a sign-off gate): the client-wide signers and admins get it, with the /portal/approvals/<run> link", async () => {
    on();
    const { runId } = await openSignGate();
    const msgs = await deliver();
    expectPointer(msgs, {
      to: [email("wide-signer"), email("wide-admin")],
      subject: /\S/,
      path: `/portal/approvals/${runId}`,
    });
    await expectSentOnNotifyStream("approval.actionable", 2);
    // OBSERVATION, not asserted as a defect: the gate mail still mints a Reply-To reply token (pinned by client-mail.db.test.ts).
    // It is a header, not a link in the body; recorded so the report can say so.
    console.log(`[pgl11] gate mail Reply-To: ${JSON.stringify(msgs.map((m) => m.replyTo))}`);
  });

  // ═════════════════ conversation.message.staff ═════════════════
  it("conversation.message.staff (project thread): client-wide contacts and that project's contacts only; the /portal/conversation/<thread> link", async () => {
    on();
    const threadId = await staffOpenThread(clientA, p1);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: ["wide-signer", "wide-admin", "wide-viewer", "viewer-a-signer-b", "p1-signer", "p1-viewer"].map(email),
      subject: "You have a new message",
      path: `/portal/conversation/${threadId}`,
    });
    const got = new Set(msgs.flatMap((m) => m.to));
    for (const nobody of ["p2-signer", "other-signer", "revoked-signer", "invited-signer"]) expect(got.has(email(nobody)), nobody).toBe(false);
    await expectSentOnNotifyStream("conversation.message.staff", 6);
  });

  it("conversation.message.staff (client-wide thread): only client-wide contacts, not the project-limited ones", async () => {
    on();
    const threadId = await staffOpenThread(clientA);
    const msgs = await deliver();
    expectPointer(msgs, {
      to: ["wide-signer", "wide-admin", "wide-viewer", "viewer-a-signer-b"].map(email),
      subject: "You have a new message",
      path: `/portal/conversation/${threadId}`,
    });
  });

  // ═════════════════ client.invite ═════════════════
  it("client.invite: one mail to the invitee only, one /invite/<token> link; the link accepts ONCE, a second accept fails", async () => {
    on();
    const addr = "invitee-one@pgl11-client.test";
    const r = await invite(addr, "mail");
    expect(r.status, r.raw).toBe(201);
    expect(r.body.mail).toMatchObject({ requested: true, mailed: true, reason: null });
    expect(r.raw).not.toMatch(/inv\d\./); // the PM never sees the token
    const msgs = await deliver();
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.to).toEqual([addr]);
    expect(m.from).toBe(fromAddress());
    expect(m.subject).toBe("PGL-11 Agency invited you to your client portal");
    expect(m.text).toContain("PGL-11 Agency");
    expect(m.text).toContain("PGL11 Client A");
    expect(m.html).toContain("<a ");
    const urls = urlsIn(m);
    expect(urls).toHaveLength(1);
    const u = new URL(urls[0]);
    expect(u.origin).toBe(linkBase());
    expect(u.search + u.hash).toBe("");
    const tok = /^\/invite\/(inv2\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3})$/.exec(u.pathname);
    expect(tok, u.pathname).not.toBeNull();
    const token = tok![1];
    await expectSentOnNotifyStream("client.invite", 1);
    const row = (await adminPool().query(`SELECT row_to_json(m)::text AS t FROM mail_log m WHERE template_key = 'client.invite'`)).rows[0].t as string;
    expect(row).not.toContain(token); // the raw token is in the mailbox only, never at rest

    const first = await accept(token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, email: addr, status: "active" });
    expect(kc.created).toContainEqual([addr, PASSWORD]);
    // it lands on the right contact: an active contact of client A, for this company
    const contact = (await adminPool().query(
      `SELECT cc.status, cc.client_id, cc.tenant_id FROM client_contacts cc JOIN users u ON u.id = cc.user_id WHERE u.email = $1`, [addr],
    )).rows;
    expect(contact).toEqual([{ status: "active", client_id: clientA, tenant_id: co }]);
    const second = await accept(token);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: "client_invite_invalid" });
  });

  it("client.invite (resend): the first MAILED link fails, the new MAILED link works", async () => {
    on();
    const addr = "invitee-resend@pgl11-client.test";
    expect((await invite(addr, "mail")).body.mail.mailed).toBe(true);
    const tokenOf = (m: Caught) => /\/invite\/(inv2\.[^\s"'<>]+)/.exec(m.text)![1];
    const first = tokenOf((await deliver())[0]);
    await mailpitClear();
    expect((await invite(addr, "mail")).body.mail.mailed).toBe(true);
    const second = await deliver();
    expect(second).toHaveLength(1);
    expect(second[0].to).toEqual([addr]);
    const fresh = tokenOf(second[0]);
    expect(fresh).not.toBe(first);
    expect((await accept(first)).statusCode).toBe(400);
    expect((await accept(fresh)).statusCode).toBe(200);
  });

  // ═════════════════ the flag ═════════════════
  it("FLAG OFF: the same five actions put NOTHING in Mailpit and write NO mail_log row; the control with the flag on does mail", async () => {
    config.mail.enabled = true;
    config.mail.clientMailEnabled = false;
    const cid = await draftContract("PGL-11 Flag Off Agreement", clientA, p1);
    await sendContract(cid);
    const inv = await approvedInvoice(clientA, 100_000);
    await issueInvoice(inv);
    await openSignGate();
    await staffOpenThread(clientA, p1);
    const off = await invite("invitee-flagoff@pgl11-client.test", "mail");
    expect(off.status, off.raw).toBe(201);
    expect(off.body.mail).toEqual({ requested: true, mailed: false, reason: "mail_off", mailLogId: null });

    expect(await deliver()).toEqual([]);
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM mail_log`)).rows[0].n).toBe(0);
    // the in-app notices still landed, so the silence is the flag and not a broken action
    expect((await adminPool().query(`SELECT count(*)::int AS n FROM notifications WHERE type IN ('contract.sent','invoice.issued','pipeline.gate.opened','conversation.message.staff')`)).rows[0].n).toBeGreaterThan(0);

    // control: the same kind of action with the flag on is caught (so an empty Mailpit above is not a dead sink)
    config.mail.clientMailEnabled = true;
    const cid2 = await draftContract("PGL-11 Flag On Control", clientA, p1);
    await sendContract(cid2);
    expect((await deliver()).length).toBeGreaterThan(0);
  });
});
