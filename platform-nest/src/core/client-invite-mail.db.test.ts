// PGL-10 (owner ruling PV-D47) — the client invitation email, over HTTP against real Postgres (RLS) and Cerbos.
// Contract: docs/FRONTEND-BFF-CONTRACT.md §62.5. Design: src/mail/invite-mail.ts.
//
// THE RULE UNDER TEST: an invite token is a bearer credential that creates a login, so the RAW token is never at rest:
// not in mail_log (payload or any other column), not in the outbox, not in any table, not in a log line. The mail
// sender mints it at send time and it exists only in the outgoing message.
//
// What runs here, every claim read back from the STORED rows through adminPool (RLS bypassed), never inferred from a 2xx:
//   * mailed invite: no token in the response; the queued row's payload is four reference fields; the sender mints at
//     send time and the link accepts ONCE (Keycloak created with the chosen password); revoke disables the login
//   * failed-then-retried send: a NEW token per attempt, the failed attempt's token is dead, last_error is scrubbed
//   * resend: the old link fails and the new one works; a resend while the first mail is queued drops that mail unsent;
//     a hand-forwarded link asked for after a mailed invite supersedes the mail
//   * expiry, revoke-while-queued, a suppressed address (falls back to a working link; the sender never mints)
//   * the flag: OFF (client flag or master gate) answers as today, says "not mailed", writes NO mail_log row;
//     the hand-forwarded path is unchanged
//   * the admin preview of an invite row shows no live token and never mints
//   * THE STRUCTURAL TEETH TEST: every mail_log row (every column), every outbox row, activities, notifications, the
//     invite and contact rows and every captured log line are scanned for any string that sha256-hashes to a stored
//     invite token, and for every raw token this suite ever saw. Zero. Then a positive control plants one and must see it.
//
// No mail leaves the process: the provider is replaced by a capture adapter (`.test` addresses only). Needs
// DATABASE_URL_TEST + Cerbos; runs on the Linux CI gate. A skip is not a pass.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../config";
import { buildApp } from "../main";
import { resetModules } from "../modules/registry";
import { resetCoreRollupProviders } from "../rollups/engine";
import { initTestDb, teardownTestDb, adminPool, TEST_URL } from "../testing/setup";
import { createCompany, createUser, addMembership, createRole, grantRole, createClient } from "../testing/fixtures";
import { sendDueMailOnce } from "../mail/sender";
import { INVITE_NOT_OPEN_REASON } from "../mail/invite-mail";
import { CLIENT_INVITE_LINK_PLACEHOLDER } from "../mail/templates";
import { hashToken } from "./client-invites";
import { findInviteTokenLeaks, type ScannedBlob } from "../testing/invite-token-leaks";
import type { OutboundMail } from "../mail/types";

// ---- the capture adapter: every outgoing mail is recorded, and the next N sends can be made to fail ----
const mailer = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; text: string; html: string }>, failNext: 0 }));
vi.mock("../mail/provider", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../mail/provider")>();
  return {
    ...orig,
    resolveAdapter: () => ({
      name: "capture",
      async send(m: OutboundMail) {
        mailer.sent.push({ to: m.to.email, subject: m.subject, text: m.text, html: m.html });
        if (mailer.failNext > 0) {
          mailer.failNext -= 1;
          // An adapter error that ECHOES the body, as a careless SMTP library might: last_error must still hold no token.
          throw new Error(`451 temporary failure, message was: ${m.text}`);
        }
        return { ok: true as const, providerMessageId: `capture-${mailer.sent.length}` };
      },
    }),
  };
});

// ---- the Keycloak doubles (the same wrapping client-contacts-http.test.ts uses) ----
const kc = vi.hoisted(() => ({
  existing: new Set<string>(),
  created: [] as Array<[string, string | null | undefined]>,
  disabled: [] as string[],
  enabled: [] as string[],
  setPassword: [] as string[],
}));
vi.mock("./keycloak-admin", async (importOriginal) => {
  const orig = await importOriginal<typeof import("./keycloak-admin")>();
  return {
    ...orig,
    findUserByEmail: async (email: string) => (kc.existing.has(email) ? { id: `kc-${email}` } : null),
    createUser: async (input: { email: string; password?: string | null }) => {
      if (kc.existing.has(input.email)) throw new orig.KeycloakUserExistsError(input.email);
      kc.created.push([input.email, input.password]);
      kc.existing.add(input.email);
      return `kc-${input.email}`;
    },
    disableUser: async (id: string) => { kc.disabled.push(id); },
    enableUser: async (id: string) => { kc.enabled.push(id); },
    setPassword: async (id: string) => { kc.setPassword.push(id); },
  };
});

// ---- captured log output: console AND the raw process streams ----
const logs: string[] = [];
const fmt = (a: unknown) => (typeof a === "string" ? a : a instanceof Error ? `${a.message} ${a.stack ?? ""}` : JSON.stringify(a));

const svc = { authorization: "Bearer svc-token" };
const asUser = (id: string) => ({ ...svc, "x-user-id": id });
const PASSWORD = "a-long-enough-password-123";
const TOKEN_IN_LINK = /\/invite\/(inv2\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){3})/;

describe.skipIf(!TEST_URL)("PGL-10: the client invitation email keeps the raw token out of every store and log", () => {
  let app: NestFastifyApplication;
  let co: string;
  let manager: string;
  let platformAdmin: string;
  let clientId: string;
  const seenTokens: string[] = [];
  const saved = { enabled: config.mail.enabled, client: config.mail.clientMailEnabled };
  const restoreFns: Array<() => void> = [];

  const contactsUrl = () => `/api/${co}/clients/${clientId}/contacts`;
  async function invite(email: string, delivery?: string) {
    const r = await app.inject({
      method: "POST",
      url: contactsUrl(),
      headers: asUser(manager),
      payload: { email, capability: "signer", ...(delivery ? { delivery } : {}) },
    });
    const body = r.json();
    if (body?.invite?.token) seenTokens.push(body.invite.token);
    return { status: r.statusCode, body, raw: r.body };
  }
  async function accept(token: string) {
    return app.inject({ method: "POST", url: `/api/invites/accept`, payload: { token, password: PASSWORD } });
  }
  async function mailRows(email: string) {
    return (await adminPool().query(
      `SELECT id, stream, tenant_id, user_id, template_key, subject, payload, status, attempts, last_error, reply_token, entity_type, entity_id
         FROM mail_log WHERE to_email = $1 ORDER BY created_at, id`,
      [email],
    )).rows;
  }
  async function inviteRows(email: string) {
    return (await adminPool().query(
      `SELECT id, delivery, token_hash, consumed_at, expires_at FROM client_invites WHERE email = $1 ORDER BY created_at, id`,
      [email],
    )).rows;
  }
  async function contactStatus(email: string) {
    return (await adminPool().query(
      `SELECT cc.status FROM client_contacts cc JOIN users u ON u.id = cc.user_id WHERE u.email = $1 AND cc.client_id = $2`,
      [email, clientId],
    )).rows[0]?.status;
  }
  const makeDue = () => adminPool().query(`UPDATE mail_log SET next_attempt_at = now() WHERE status = 'queued'`);
  /** Send what is due; return the mails captured during this call and record their tokens. */
  async function send(): Promise<Array<{ to: string; token: string | null; text: string; html: string; subject: string }>> {
    const before = mailer.sent.length;
    await sendDueMailOnce(50);
    return mailer.sent.slice(before).map((m) => {
      const token = TOKEN_IN_LINK.exec(m.text)?.[1] ?? null;
      if (token) seenTokens.push(token);
      return { ...m, token };
    });
  }

  beforeAll(async () => {
    for (const m of ["log", "info", "warn", "error", "debug"] as const) {
      const spy = vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(fmt).join(" ")); });
      restoreFns.push(() => spy.mockRestore());
    }
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      (stream as unknown as { write: unknown }).write = (chunk: unknown, ...rest: unknown[]) => {
        logs.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
        return (orig as (...a: unknown[]) => boolean)(chunk, ...rest);
      };
      restoreFns.push(() => { (stream as unknown as { write: unknown }).write = orig; });
    }

    await initTestDb();
    config.serviceToken = "svc-token";
    if (!config.integrationTokenKey) config.integrationTokenKey = Buffer.alloc(32, 7).toString("base64");
    config.mail.enabled = true;
    config.mail.clientMailEnabled = true;
    resetModules();
    resetCoreRollupProviders();

    co = await createCompany("Kuta Creative Agency");
    manager = await createUser("manager@pgl10.test");
    await addMembership(co, manager);
    await grantRole(manager, await createRole("manager"), "company", co);
    platformAdmin = await createUser("platform-admin@pgl10.test");
    await grantRole(platformAdmin, await createRole("platform_admin"), "global", null);
    clientId = await createClient(co, "Hubble Bali");

    app = await buildApp();
  });
  afterAll(async () => {
    config.mail.enabled = saved.enabled;
    config.mail.clientMailEnabled = saved.client;
    await app.close();
    await teardownTestDb();
    for (const f of restoreFns.reverse()) f();
  });

  // ---- the mailed invite ----

  const A = "mailed@hubble-bali.test";
  let aPayload: Record<string, unknown>;

  it("delivery 'mail' with both gates on: 201, mailed, NO token anywhere in the response, one queued row of four reference fields", async () => {
    const r = await invite(A, "mail");
    expect(r.status, r.raw).toBe(201);
    expect(r.body.mail).toMatchObject({ requested: true, mailed: true, reason: null });
    expect(r.body.mail.mailLogId).toBeTruthy();
    expect(r.body.invite).toEqual({ delivery: "mail", expiresAt: expect.any(String) });
    expect(r.raw).not.toMatch(/inv\d\./);
    expect(r.body.contact).toMatchObject({ email: A, status: "invited" });

    const rows = await mailRows(A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: r.body.mail.mailLogId, stream: "notify", tenant_id: co, template_key: "client.invite", status: "queued",
      reply_token: null, entity_type: null, entity_id: null,
      subject: "Kuta Creative Agency invited you to your client portal",
    });
    expect(Object.keys(rows[0].payload).sort()).toEqual(["clientName", "companyName", "expiresAt", "inviteId"]);
    expect(rows[0].payload).toMatchObject({ companyName: "Kuta Creative Agency", clientName: "Hubble Bali" });
    aPayload = rows[0].payload;

    const inv = await inviteRows(A);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ id: rows[0].payload.inviteId, delivery: "mail", consumed_at: null });
  });

  it("the sender mints the token at SEND time: one /invite/ link, the stored payload unchanged, the invite holds that token's hash", async () => {
    const out = await send();
    const mine = out.filter((m) => m.to === A);
    expect(mine).toHaveLength(1);
    const token = mine[0].token;
    expect(token).toBeTruthy();
    expect(mine[0].text).toContain(`${config.mail.linkBaseUrl}/invite/${token}`);
    expect(mine[0].subject).not.toContain(token!);
    const rows = await mailRows(A);
    expect(rows[0].status).toBe("sent");
    expect(rows[0].payload).toEqual(aPayload);
    const inv = await inviteRows(A);
    expect(inv[0].token_hash).toBe(hashToken(token!));
  });

  it("the mailed link accepts ONCE (the account is created with the chosen password); a second accept fails", async () => {
    const token = seenTokens[seenTokens.length - 1];
    const first = await accept(token);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ ok: true, email: A, status: "active", existingAccount: false });
    expect(kc.created).toContainEqual([A, PASSWORD]);
    expect(kc.setPassword).toEqual([]);
    expect(await contactStatus(A)).toBe("active");
    const second = await accept(token);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ code: "client_invite_invalid" });
  });

  it("regression (PV-6): revoking the mailed-and-accepted contact still disables the Keycloak login", async () => {
    const contactId = (await adminPool().query(
      `SELECT cc.id FROM client_contacts cc JOIN users u ON u.id = cc.user_id WHERE u.email = $1`, [A],
    )).rows[0].id;
    const r = await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${contactId}/revoke`, headers: asUser(manager) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "revoked", idpDisabled: true, idpError: null });
    expect(kc.disabled).toContain(`kc-${A}`);
  });

  // ---- failed, then retried ----

  const R = "retry@hubble-bali.test";
  it("a FAILED send is retried with a NEW token; the failed attempt's token is dead; last_error holds no token", async () => {
    expect((await invite(R, "mail")).body.mail.mailed).toBe(true);
    mailer.failNext = 1;
    const attempt1 = (await send()).filter((m) => m.to === R);
    expect(attempt1).toHaveLength(1);
    const t1 = attempt1[0].token!;
    expect(t1).toBeTruthy();

    const row = (await mailRows(R))[0];
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.last_error).toContain("[redacted invite token]");
    expect(row.last_error).not.toContain(t1);
    // Re-sealed: the attempt's token no longer matches the invite.
    expect((await inviteRows(R))[0].token_hash).not.toBe(hashToken(t1));
    expect((await accept(t1)).statusCode).toBe(400);
    expect(await contactStatus(R)).toBe("invited");
    expect((await inviteRows(R))[0].consumed_at).toBeNull(); // a dead token spends nothing

    await makeDue();
    const attempt2 = (await send()).filter((m) => m.to === R);
    expect(attempt2).toHaveLength(1);
    const t2 = attempt2[0].token!;
    expect(t2).not.toBe(t1);
    expect((await mailRows(R))[0]).toMatchObject({ status: "sent", attempts: 2 });
    expect((await accept(t1)).statusCode).toBe(400);
    expect((await accept(t2)).statusCode).toBe(200);
  });

  // ---- resend ----

  const S = "resend@hubble-bali.test";
  it("a RESEND issues a new token: after it, the old mailed link fails and the new one works", async () => {
    await invite(S, "mail");
    const old = (await send()).find((m) => m.to === S)!.token!;
    const again = await invite(S, "mail");
    expect(again.status).toBe(201);
    expect(again.body.mail.mailed).toBe(true);
    const fresh = (await send()).find((m) => m.to === S)!.token!;
    expect(fresh).not.toBe(old);
    expect((await inviteRows(S)).filter((i) => i.consumed_at === null)).toHaveLength(1);
    expect((await accept(old)).statusCode).toBe(400);
    expect((await accept(fresh)).statusCode).toBe(200);
  });

  const Q = "resend-queued@hubble-bali.test";
  it("a resend while the first mail is still QUEUED: that mail is dropped unsent, only the new one goes out", async () => {
    const first = await invite(Q, "mail");
    const second = await invite(Q, "mail");
    const out = (await send()).filter((m) => m.to === Q);
    expect(out).toHaveLength(1);
    const rows = await mailRows(Q);
    const dropped = rows.find((x) => x.id === first.body.mail.mailLogId);
    const sent = rows.find((x) => x.id === second.body.mail.mailLogId);
    expect(dropped).toMatchObject({ status: "failed", attempts: 0, last_error: INVITE_NOT_OPEN_REASON });
    expect(sent).toMatchObject({ status: "sent" });
    expect((await accept(out[0].token!)).statusCode).toBe(200);
  });

  const H = "link-after-mail@hubble-bali.test";
  it("the PM ALSO asks for a hand-forwarded link after a mailed invite: the link supersedes the mail (one live credential)", async () => {
    const mailed = await invite(H, "mail");
    const link = await invite(H); // default delivery: link
    expect(link.status).toBe(201);
    expect(link.body.invite).toMatchObject({ delivery: "link", token: expect.any(String) });
    expect(link.body.mail).toMatchObject({ requested: false, mailed: false, reason: "not_requested" });
    expect((await send()).filter((m) => m.to === H)).toHaveLength(0);
    expect((await mailRows(H)).find((x) => x.id === mailed.body.mail.mailLogId)).toMatchObject({ status: "failed", last_error: INVITE_NOT_OPEN_REASON });
    expect((await accept(link.body.invite.token)).statusCode).toBe(200);
  });

  // ---- expiry and revoke ----

  const E = "expired@hubble-bali.test";
  it("an EXPIRED mailed link fails; an invite that expires before its mail is sent is dropped, not mailed", async () => {
    await invite(E, "mail");
    const token = (await send()).find((m) => m.to === E)!.token!;
    await adminPool().query(`UPDATE client_invites SET expires_at = now() - interval '1 second' WHERE email = $1`, [E]);
    expect((await accept(token)).statusCode).toBe(400);
    expect(await contactStatus(E)).toBe("invited");

    const E2 = "expired-queued@hubble-bali.test";
    await invite(E2, "mail");
    await adminPool().query(`UPDATE client_invites SET expires_at = now() - interval '1 second' WHERE email = $1`, [E2]);
    expect((await send()).filter((m) => m.to === E2)).toHaveLength(0);
    expect((await mailRows(E2))[0]).toMatchObject({ status: "failed", last_error: INVITE_NOT_OPEN_REASON });
  });

  const V = "revoked-queued@hubble-bali.test";
  it("a contact REVOKED while its invite mail is queued: the mail is dropped and never sent", async () => {
    const r = await invite(V, "mail");
    await app.inject({ method: "POST", url: `/api/${co}/client-contacts/${r.body.contact.id}/revoke`, headers: asUser(manager) });
    expect((await send()).filter((m) => m.to === V)).toHaveLength(0);
    expect((await mailRows(V))[0]).toMatchObject({ status: "failed", last_error: INVITE_NOT_OPEN_REASON });
  });

  // ---- suppression ----

  const X = "suppressed@hubble-bali.test";
  it("a SUPPRESSED address: not mailed (reason 'suppressed'), the route falls back to a working link, the sender never mints", async () => {
    await adminPool().query(
      `INSERT INTO mail_suppressions (id, email, stream, reason) VALUES (gen_random_uuid(), $1, '*', 'manual')`,
      [X],
    );
    const r = await invite(X, "mail");
    expect(r.status).toBe(201);
    expect(r.body.mail).toMatchObject({ requested: true, mailed: false, reason: "suppressed", mailLogId: null });
    expect(r.body.invite).toMatchObject({ delivery: "link", token: expect.any(String), acceptPath: `/invite/${r.body.invite.token}` });
    const rows = await mailRows(X);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("suppressed");
    expect((await inviteRows(X))[0].delivery).toBe("link");
    expect((await send()).filter((m) => m.to === X)).toHaveLength(0);
    expect((await accept(r.body.invite.token)).statusCode).toBe(200);
  });

  // ---- the flag ----

  it("client flag OFF: delivery 'mail' answers as today (a link to forward), says 'not mailed', and writes NO mail_log row", async () => {
    config.mail.clientMailEnabled = false;
    try {
      const F = "flag-off@hubble-bali.test";
      const r = await invite(F, "mail");
      expect(r.status).toBe(201);
      expect(r.body.mail).toEqual({ requested: true, mailed: false, reason: "mail_off", mailLogId: null });
      expect(r.body.invite).toMatchObject({ delivery: "link", token: expect.any(String), acceptPath: `/invite/${r.body.invite.token}` });
      expect(await mailRows(F)).toHaveLength(0);
      expect((await inviteRows(F))[0].delivery).toBe("link");
      expect((await accept(r.body.invite.token)).statusCode).toBe(200);
    } finally {
      config.mail.clientMailEnabled = true;
    }
  });

  it("master gate OFF (client flag on): the same, no mail_log row", async () => {
    config.mail.enabled = false;
    try {
      const M = "master-off@hubble-bali.test";
      const r = await invite(M, "mail");
      expect(r.body.mail).toMatchObject({ mailed: false, reason: "mail_off" });
      expect(r.body.invite.token).toBeTruthy();
      expect(await mailRows(M)).toHaveLength(0);
    } finally {
      config.mail.enabled = true;
    }
  });

  it("the hand-forwarded path is unchanged with mail on: no delivery given -> token + acceptPath, not mailed, no mail_log row", async () => {
    const L = "hand-forwarded@hubble-bali.test";
    const r = await invite(L);
    expect(r.status).toBe(201);
    expect(r.body.invite).toMatchObject({ token: expect.any(String), expiresAt: expect.any(String), acceptPath: `/invite/${r.body.invite.token}` });
    expect(r.body.mail).toMatchObject({ requested: false, mailed: false, reason: "not_requested" });
    expect(await mailRows(L)).toHaveLength(0);
    expect((await accept(r.body.invite.token)).statusCode).toBe(200);
  });

  it("an unknown delivery is a 400 and creates nothing", async () => {
    const r = await invite("fax@hubble-bali.test", "fax");
    expect(r.status).toBe(400);
    expect((await adminPool().query(`SELECT 1 FROM users WHERE email = 'fax@hubble-bali.test'`)).rowCount).toBe(0);
  });

  // ---- the preview ----

  it("the admin PREVIEW of an invite row shows no live token and never mints (queued and sent rows alike)", async () => {
    const P = "preview@hubble-bali.test";
    const queued = await invite(P, "mail");
    const hashBefore = (await inviteRows(P))[0].token_hash;
    const sentRowId = (await mailRows(A))[0].id;
    for (const id of [queued.body.mail.mailLogId, sentRowId]) {
      const r = await app.inject({ method: "GET", url: `/api/admin/mail/log/${id}/preview`, headers: asUser(platformAdmin) });
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json();
      expect(body).toMatchObject({ templateKey: "client.invite", linkOmitted: true });
      expect(body.text).toContain(CLIENT_INVITE_LINK_PLACEHOLDER);
      expect(r.body).not.toMatch(/inv\d\./);
      expect(r.body).not.toContain("/invite/");
      for (const t of seenTokens) expect(r.body).not.toContain(t);
    }
    expect((await inviteRows(P))[0].token_hash).toBe(hashBefore); // the preview minted nothing
  });

  // ---- THE STRUCTURAL TEETH TEST ----

  async function collectBlobs(): Promise<ScannedBlob[]> {
    const q = async (label: string, sql: string) =>
      (await adminPool().query<{ t: string }>(sql)).rows.map((r, i) => ({ where: `${label}#${i}`, text: r.t }));
    return [
      // EVERY column of every mail_log row (payload, subject, last_error, provider ids, ...), as one text per row.
      ...(await q("mail_log", `SELECT row_to_json(m)::text AS t FROM mail_log m`)),
      ...(await q("outbox_events", `SELECT row_to_json(o)::text AS t FROM outbox_events o`)),
      ...(await q("activities", `SELECT row_to_json(a)::text AS t FROM activities a`)),
      ...(await q("notifications", `SELECT row_to_json(n)::text AS t FROM notifications n`)),
      ...(await q("client_invites", `SELECT row_to_json(ci)::text AS t FROM client_invites ci`)),
      ...(await q("client_contacts", `SELECT row_to_json(cc)::text AS t FROM client_contacts cc`)),
      ...logs.map((text, i) => ({ where: `log#${i}`, text })),
    ];
  }
  async function storedHashes(): Promise<Set<string>> {
    return new Set((await adminPool().query<{ h: string }>(`SELECT token_hash AS h FROM client_invites`)).rows.map((r) => r.h));
  }

  it("TEETH: after all of the above, NO stored row and NO log line holds a string that hashes to an invite token, or any raw token seen", async () => {
    // Not vacuous: the flows above really ran (mailed, retried, resent, accepted) and produced tokens and rows.
    expect(seenTokens.length).toBeGreaterThanOrEqual(10);
    expect((await adminPool().query(`SELECT 1 FROM mail_log WHERE template_key = 'client.invite'`)).rowCount).toBeGreaterThanOrEqual(9);
    expect((await adminPool().query(`SELECT 1 FROM outbox_events WHERE event_type LIKE 'client_contact.%'`)).rowCount).toBeGreaterThan(0);
    const blobs = await collectBlobs();
    expect(blobs.filter((b) => b.where.startsWith("log#")).length).toBeGreaterThan(0);
    expect(findInviteTokenLeaks(blobs, await storedHashes(), seenTokens)).toEqual([]);
  });

  it("TEETH positive control: plant ONE live token in a mail_log payload and the same scan must find it", async () => {
    const live = (await invite("control@hubble-bali.test")).body.invite.token as string;
    const rowId = (await mailRows(A))[0].id;
    await adminPool().query(`UPDATE mail_log SET payload = payload || jsonb_build_object('planted', $2::text) WHERE id = $1`, [rowId, live]);
    try {
      const found = findInviteTokenLeaks(await collectBlobs(), await storedHashes());
      expect(found.some((f) => f.startsWith("mail_log#"))).toBe(true);
    } finally {
      await adminPool().query(`UPDATE mail_log SET payload = payload - 'planted' WHERE id = $1`, [rowId]);
    }
  });
});
