// MAIL-13 / design A13 — the committed adversarial corpus, driven end to end through the REAL
// endpoint against live Postgres. One `it()` per §7.6 corpus case, plus the auth cases (which are
// header-level and therefore have no fixture file of their own).
//
// WHAT MAKES THESE ASSERTIONS MEANINGFUL RATHER THAN CEREMONIAL: every content assertion reads the
// row back OUT OF POSTGRES (`adminPool()`), not out of the sanitizer's return value. The ticket AC is
// "XSS corpus inert AS STORED CONTENT, not just at render", and the only way to demonstrate that is to
// look at what is actually in the database.
import { randomBytes } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { config } from "../../config";
import { newId } from "../../db";
import { buildApp } from "../../main";
import { initTestDb, teardownTestDb, TEST_URL, adminPool } from "../../testing/setup";
import { createCompany, createUser, addMembership } from "../../testing/fixtures";
import { setStorageForTest, localStorage as localStorageBackend, type StorageBackend } from "../../core/storage";
import { loadFixture, fixtureNames } from "../__fixtures__/inbound";
import { signInboundPayload, INBOUND_SIGNATURE_HEADER, INBOUND_TOKEN_HEADER } from "./auth";
import { resetInboundRateLimitForTest } from "./rate-limit";
import { setScannerForTest, eicarBytes, type AttachmentScanner } from "./scanner";

const TOKEN = "inbound-corpus-token-value";
const REPLY_DOMAIN = "notify.gaiada.invalid";

/** In-memory storage so the corpus never writes quarantine bytes to a developer's disk, and so the
 *  test can assert on exactly which keys were written. */
function memoryStorage(): { backend: StorageBackend; files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    backend: {
      async put(key, data) {
        files.set(key, data);
      },
      async get(key) {
        const b = files.get(key);
        if (!b) throw new Error(`missing ${key}`);
        return b;
      },
      async del(key) {
        files.delete(key);
      },
    },
  };
}

describe.skipIf(!TEST_URL)("mail inbound corpus — POST /api/mail/inbound/brevo", () => {
  let app: NestFastifyApplication;
  let tenantId: string;
  let store: ReturnType<typeof memoryStorage>;

  const saved = {
    token: config.mail.inboundToken,
    signingKey: config.mail.inboundSigningKey,
    maxBytes: config.mail.inboundMaxBytes,
    maxAttBytes: config.mail.inboundMaxAttachmentBytes,
    maxAtts: config.mail.inboundMaxAttachments,
    rate: config.mail.inboundRatePerMin,
    scan: config.mail.inboundScan,
    replyDomain: config.mail.replyDomain,
  };

  /** MAIL-29: mints tokens the same way `queue.ts`'s real `newReplyToken()` does (128-bit CSPRNG,
   *  base64url), then FORCES alternating case onto whatever letters land in it. Before this fix, every
   *  test in this corpus called `seedMail`, which minted `` `tok${newId().replace(/-/g, "")}` `` —
   *  `newId()` is a UUIDv7 (lowercase hex) and `"tok"` is lowercase, so every token this suite ever
   *  used was ALL-LOWERCASE by construction. `extractAngleAddress()`'s blanket-lowercasing bug was
   *  therefore a no-op for every token this corpus exercised — the DB-level "threads onto the right
   *  entity" assertions below were always real assertions against real Postgres rows, they just never
   *  got to see the one input class (an uppercase character in the token) that broke production. Real
   *  tokens are ~40% uppercase letters by alphabet share; forcing alternating case here means this
   *  corpus can never again pass by accident the way it did for MAIL-29 — every threading case in this
   *  file now runs the mixed-case path on every run, not just the one dedicated regression case below. */
  function mixedCaseToken(): string {
    const raw = randomBytes(16).toString("base64url");
    return [...raw].map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c.toLowerCase())).join("");
  }

  /** Two live outbound mails, so the "wrong token" case can prove the token routes and the sender
   *  does not: mail A is the one whose RECIPIENT sends the replies, mail B is a different thread. */
  let mailA: { id: string; token: string; entityId: string };
  let mailB: { id: string; token: string; entityId: string };

  async function seedMail(toEmail: string): Promise<{ id: string; token: string; entityId: string }> {
    const id = newId();
    const token = mixedCaseToken();
    const entityId = newId();
    await adminPool().query(
      `INSERT INTO pipeline_runs (id, tenant_id, title, status, origin_site)
       VALUES ($1, $2, 'Corpus run', 'delivery_active', 'test')`,
      [entityId, tenantId],
    );
    await adminPool().query(
      `INSERT INTO mail_log (id, stream, tenant_id, to_email, template_key, subject, payload, status,
                             entity_type, entity_id, reply_token, origin_site)
       VALUES ($1, 'notify', $2, $3, 'approval.actionable', 'Approval needed', '{}'::jsonb, 'sent',
               'pipeline_run', $4, $5, 'test')`,
      [id, tenantId, toEmail, entityId, token],
    );
    return { id, token, entityId };
  }

  function body(fixture: string, run = newId().slice(0, 8)): string {
    const { payload } = loadFixture(fixture, { token: mailA.token, tokenB: mailB.token, replyDomain: REPLY_DOMAIN, run });
    return JSON.stringify(payload);
  }

  async function post(payload: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/mail/inbound/brevo",
      headers: { "content-type": "application/json", [INBOUND_TOKEN_HEADER]: TOKEN, ...headers },
      payload,
    });
  }

  async function messagesFor(mailLogId: string) {
    const r = await adminPool().query(
      `SELECT id, entity_type, entity_id, from_email, subject, body_text, body_html_sanitized,
              body_truncated, body_truncated_chars, attachments, size_bytes, tenant_id
         FROM mail_messages WHERE mail_log_id = $1 ORDER BY created_at ASC`,
      [mailLogId],
    );
    return r.rows as Array<Record<string, unknown>>;
  }

  beforeAll(async () => {
    await initTestDb();
    config.serviceToken = "svc-token";
    config.mail.inboundToken = TOKEN;
    config.mail.inboundSigningKey = "";
    config.mail.replyDomain = REPLY_DOMAIN;
    tenantId = await createCompany("Mail Inbound Corpus Co");
    const recipient = await createUser("corpus-recipient@a.test");
    await addMembership(tenantId, recipient);
    app = await buildApp();
  });

  afterAll(async () => {
    Object.assign(config.mail, {
      inboundToken: saved.token,
      inboundSigningKey: saved.signingKey,
      inboundMaxBytes: saved.maxBytes,
      inboundMaxAttachmentBytes: saved.maxAttBytes,
      inboundMaxAttachments: saved.maxAtts,
      inboundRatePerMin: saved.rate,
      inboundScan: saved.scan,
      replyDomain: saved.replyDomain,
    });
    setScannerForTest(null);
    setStorageForTest(localStorageBackend);
    await app.close();
    await teardownTestDb();
  });

  beforeEach(async () => {
    await adminPool().query(`DELETE FROM mail_messages`);
    await adminPool().query(`DELETE FROM mail_suppressions`);
    await adminPool().query(`DELETE FROM mail_log`);
    // Restore the knobs each case may have changed, so case order can never matter.
    Object.assign(config.mail, {
      inboundMaxBytes: 5 * 1024 * 1024,
      inboundMaxAttachmentBytes: 2 * 1024 * 1024,
      inboundMaxAttachments: 10,
      inboundRatePerMin: 0, // 0 = off; the rate case turns it on explicitly
      inboundScan: "off",
      inboundSigningKey: "",
    });
    resetInboundRateLimitForTest();
    setScannerForTest(null);
    store = memoryStorage();
    setStorageForTest(store.backend);
    mailA = await seedMail("corpus-recipient@a.test");
    mailB = await seedMail("other-thread@a.test");
  });

  // ── the corpus manifest itself ────────────────────────────────────────────────────────────────
  it("[A13] every committed fixture is loadable, provider-shaped and self-describing", () => {
    const names = fixtureNames();
    // A13: the corpus only ever grows. This lower bound is the guard against a future 'tidy-up' that
    // deletes cases; staging APPENDS real Brevo samples to it.
    expect(names.length).toBeGreaterThanOrEqual(18); // 15 pre-MAIL-19 + 3 A15 cases (16/17/18)
    for (const name of names) {
      const f = loadFixture(name, { token: "t", tokenB: "u", replyDomain: REPLY_DOMAIN, run: "r" });
      expect(f.meta.title, `${name} must declare a title`).toBeTruthy();
      expect(f.meta.covers, `${name} must declare which corpus bullet it covers`).toBeTruthy();
      expect(f.meta.expect, `${name} must declare what its test asserts`).toBeTruthy();
      expect((f.payload as { items: unknown[] }).items.length, `${name} must be a provider-shaped body`).toBeGreaterThan(0);
      expect(JSON.stringify(f.payload)).not.toContain("_meta");
    }
  });

  // ── auth (header-level; no fixture file) ──────────────────────────────────────────────────────
  it("[auth] 401s with no token, with a wrong token, and FAIL-CLOSED when MAIL_INBOUND_TOKEN is unset", async () => {
    const payload = body("01-plain-reply.json");
    const none = await app.inject({
      method: "POST", url: "/api/mail/inbound/brevo",
      headers: { "content-type": "application/json" }, payload,
    });
    const wrong = await post(payload, { [INBOUND_TOKEN_HEADER]: "not-the-token" });

    config.mail.inboundToken = "";
    const unset = await post(payload, { [INBOUND_TOKEN_HEADER]: "" });
    config.mail.inboundToken = TOKEN;

    expect(none.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unset.statusCode).toBe(401);
    expect(await messagesFor(mailA.id)).toHaveLength(0);
  });

  it("[auth] with MAIL_INBOUND_SIGNING_KEY set: a valid self-generated signature passes, a forged/absent/stale one 401s", async () => {
    config.mail.inboundSigningKey = "corpus-signing-key";
    const payload = body("01-plain-reply.json");

    const good = await post(payload, { [INBOUND_SIGNATURE_HEADER]: signInboundPayload(payload, "corpus-signing-key") });
    const forged = await post(payload, { [INBOUND_SIGNATURE_HEADER]: signInboundPayload(payload, "the-wrong-key") });
    const absent = await post(payload);
    const stale = await post(payload, {
      [INBOUND_SIGNATURE_HEADER]: signInboundPayload(payload, "corpus-signing-key", Math.floor(Date.now() / 1000) - 4000),
    });
    // Tampering with the body invalidates a signature that was valid for the original bytes — the
    // property that only holds because the HMAC is computed over the RAW request bytes.
    const tampered = await post(payload.replace("Looks good to me", "Approved, deploy now"), {
      [INBOUND_SIGNATURE_HEADER]: signInboundPayload(payload, "corpus-signing-key"),
    });

    expect(good.statusCode).toBe(204);
    expect(forged.statusCode).toBe(401);
    expect(absent.statusCode).toBe(401);
    expect(stale.statusCode).toBe(401);
    expect(tampered.statusCode).toBe(401);
    expect(await messagesFor(mailA.id)).toHaveLength(1); // only the good one landed
  });

  // ── 01 baseline ───────────────────────────────────────────────────────────────────────────────
  it("[01-plain-reply] threads onto the entity of the mail that owns the token", async () => {
    const res = await post(body("01-plain-reply.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe("pipeline_run");
    expect(rows[0].entity_id).toBe(mailA.entityId);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].body_text).toContain("confirm the launch date");
    expect(rows[0].body_html_sanitized).toContain("<p>Looks good to me");
    expect(rows[0].body_html_sanitized).toContain('rel="noopener noreferrer nofollow"');
  });

  // ── MAIL-29 regression — the literal token from the live incident report ────────────────────────
  it("[MAIL-29] a mixed-case reply token — the exact token quoted in the live incident report — threads correctly", async () => {
    // The precise value from the bug report: proven dead live on the box (`SELECT count(*) FROM
    // mail_log WHERE reply_token = lower('WxgfNc9SNTtwaKif2TnfBA')` -> 0). Pinning THIS literal string,
    // not just "a" mixed-case token, is what makes this a named regression test for the actual incident
    // rather than a generic property test.
    const literalToken = "WxgfNc9SNTtwaKif2TnfBA";
    expect(literalToken).not.toBe(literalToken.toLowerCase()); // sanity: genuinely mixed-case
    expect(literalToken).not.toBe(literalToken.toUpperCase());
    expect(literalToken).toMatch(/^[A-Za-z0-9_-]{8,128}$/); // shape VERP_LOCALPART_RE requires

    const mail = await seedMail("mail29-recipient@a.test");
    // Overwrite the randomly-minted token with the literal reported one, so the assertion below is
    // against THAT exact string, not a coincidentally-similar random one.
    await adminPool().query(`UPDATE mail_log SET reply_token = $2 WHERE id = $1`, [mail.id, literalToken]);

    const { payload } = loadFixture("01-plain-reply.json", {
      token: literalToken,
      tokenB: mailB.token,
      replyDomain: REPLY_DOMAIN,
      run: newId().slice(0, 8),
    });
    const res = await post(JSON.stringify(payload));
    expect(res.statusCode).toBe(204);

    // THE proof, read back out of Postgres, not out of the sanitizer's return value.
    const rows = await messagesFor(mail.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe("pipeline_run");
    expect(rows[0].entity_id).toBe(mail.entityId);
    expect(rows[0].tenant_id).toBe(tenantId);
    expect(rows[0].body_text).toContain("confirm the launch date");

    // And the deliberate MAIL-29 decision holds: the STORED token was never case-folded either —
    // matching is exact-case against the token as minted, not normalized on either side.
    const stored = await adminPool().query(`SELECT reply_token FROM mail_log WHERE id = $1`, [mail.id]);
    expect(stored.rows[0].reply_token).toBe(literalToken);

    // eslint-disable-next-line no-console
    console.log(
      "\n[MAIL-29 DB EVIDENCE] read back from Postgres after posting reply+" + literalToken + "@…:\n" +
        `  mail_messages.id=${rows[0].id} entity_type=${rows[0].entity_type} entity_id=${rows[0].entity_id} tenant_id=${rows[0].tenant_id}\n` +
        `  mail_log.reply_token (as stored) = ${JSON.stringify(stored.rows[0].reply_token)}\n`,
    );
  });

  // ── 02 forged sender ──────────────────────────────────────────────────────────────────────────
  it("[02-forged-sender] a spoofed From: still threads by token, and gains no authority from it", async () => {
    const res = await post(body("02-forged-sender.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    // from_email is stored verbatim as DISPLAY metadata...
    expect(rows[0].from_email).toBe("no-reply@notify.gaiada.invalid");
    // ...and the row is an ordinary inbound message: no status changed on the outbound mail, nothing
    // was decided, no suppression was written. A reply is conversation, never a decision (§7.5).
    const log = await adminPool().query(`SELECT status FROM mail_log WHERE id = $1`, [mailA.id]);
    expect(log.rows[0].status).toBe("sent");
    const supp = await adminPool().query(`SELECT count(*)::int AS n FROM mail_suppressions`);
    expect(supp.rows[0].n).toBe(0);
  });

  // ── 03 wrong token ────────────────────────────────────────────────────────────────────────────
  it("[03-wrong-token] routes to the TOKEN's thread, not the sender's thread", async () => {
    const res = await post(body("03-wrong-token.json"));
    expect(res.statusCode).toBe(204);
    // The sender is mail A's recipient; the token belongs to mail B. B wins.
    expect(await messagesFor(mailA.id)).toHaveLength(0);
    const onB = await messagesFor(mailB.id);
    expect(onB).toHaveLength(1);
    expect(onB[0].entity_id).toBe(mailB.entityId);
  });

  // ── 04 / 05 the A9 drop paths ─────────────────────────────────────────────────────────────────
  it("[04-absent-token] 204s and stores nothing", async () => {
    const res = await post(body("04-absent-token.json"));
    expect(res.statusCode).toBe(204);
    const all = await adminPool().query(`SELECT count(*)::int AS n FROM mail_messages`);
    expect(all.rows[0].n).toBe(0);
  });

  it("[05-unknown-token] 204s, stores nothing, and is INDISTINGUISHABLE from the matched case (no token oracle)", async () => {
    const unknown = await post(body("05-unknown-token.json"));
    const matched = await post(body("01-plain-reply.json"));
    expect(unknown.statusCode).toBe(matched.statusCode);
    expect(unknown.statusCode).toBe(204);
    expect(unknown.body).toBe(matched.body); // both empty
    expect(await messagesFor(mailA.id)).toHaveLength(1); // only the matched one
  });

  // ── 06 idempotency ────────────────────────────────────────────────────────────────────────────
  it("[06-replayed-provider-id] a replayed delivery yields exactly ONE row and re-stores no bytes", async () => {
    const payload = body("06-replayed-provider-id.json", "fixed");
    const first = await post(payload);
    const rowsAfterFirst = await messagesFor(mailA.id);
    const keysAfterFirst = [...store.files.keys()].sort();

    const second = await post(payload);
    const rowsAfterSecond = await messagesFor(mailA.id);

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(204);
    expect(rowsAfterFirst).toHaveLength(1);
    expect(rowsAfterSecond).toHaveLength(1);
    expect(rowsAfterSecond[0].id).toBe(rowsAfterFirst[0].id);
    // No second write to the quarantine area either — the UNIQUE index short-circuits before the
    // attachment work runs.
    expect([...store.files.keys()].sort()).toEqual(keysAfterFirst);
  });

  // ── 07 oversized body ─────────────────────────────────────────────────────────────────────────
  it("[07-oversized-body] 413s at the cap, before parsing, and stores nothing", async () => {
    config.mail.inboundMaxBytes = 16 * 1024; // scaled cap, not a 5 MB committed fixture
    const res = await post(body("07-oversized-body.json"));
    expect(res.statusCode).toBe(413);
    const all = await adminPool().query(`SELECT count(*)::int AS n FROM mail_messages`);
    expect(all.rows[0].n).toBe(0);

    // ...and the same payload is accepted once the cap is where it belongs, proving the refusal was
    // the CAP and not some other property of the fixture.
    config.mail.inboundMaxBytes = 5 * 1024 * 1024;
    const ok = await post(body("07-oversized-body.json"));
    expect(ok.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].body_text).length).toBeGreaterThan(1000);
  });

  // ── 08 / 09 attachment caps ───────────────────────────────────────────────────────────────────
  it("[08-oversized-attachment] drops the over-cap attachment, threads the message, stores the small sibling", async () => {
    config.mail.inboundMaxAttachmentBytes = 8 * 1024;
    const res = await post(body("08-oversized-attachment.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    const atts = rows[0].attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(2);
    expect(atts[0]).toMatchObject({ name: "note.txt", scanStatus: "skipped" });
    expect(atts[0].fileRef).toBeTruthy();
    expect(atts[1]).toMatchObject({ name: "huge-scan.tiff", fileRef: null, rejected: true, rejectReason: "too_large" });
    // Only the accepted attachment's bytes exist on disk.
    expect(store.files.size).toBe(1);
  });

  it("[09-too-many-attachments] keeps the cap's worth and records every one past it as rejected", async () => {
    config.mail.inboundMaxAttachments = 10;
    const res = await post(body("09-too-many-attachments.json"));
    expect(res.statusCode).toBe(204);
    // MAIL-27: assert the row exists BEFORE indexing into it. `[0].attachments` on a zero-length
    // result throws an opaque "Cannot read properties of undefined", not a named, diagnosable
    // assertion — the exact failure mode every sibling case (08, 13, ...) already guards against by
    // checking `toHaveLength(1)` first. Kept even though MAIL-27's investigation found no live
    // mechanism that drops this row (attachment processing is a single strictly-sequential,
    // index-preserving for-loop, fully awaited before the controller responds — see the ticket
    // report); this guard is cheap insurance against a future regression turning that loop into
    // something concurrent, and it makes a genuine miss legible instead of cryptic.
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    // Deliberately count/set-based, not positional: this proves the cap kept exactly 10 and rejected
    // exactly 5, without caring WHICH 10 of the 15 survived — so it stays true even if attachment
    // processing were ever parallelized (it is not today; see the diagnosis above).
    const atts = rows[0].attachments as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(15); // the count the sender sent is reported honestly
    expect(atts.filter((a) => a.fileRef)).toHaveLength(10);
    expect(atts.filter((a) => a.rejected && a.rejectReason === "too_many")).toHaveLength(5);
    expect(store.files.size).toBe(10);
  });

  // ── 10 hostile HTML — THE "inert as stored content" case ──────────────────────────────────────
  it("[10-hostile-html] the STORED html (read back out of Postgres) is inert", async () => {
    const res = await post(body("10-hostile-html.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    const stored = String(rows[0].body_html_sanitized);

    // Printed so the ticket report can quote the ACTUAL database content rather than an assertion.
    // eslint-disable-next-line no-console
    console.log("\n[MAIL-13 DB EVIDENCE] mail_messages.body_html_sanitized =\n" + stored + "\n");

    expect(stored).not.toMatch(/<script/i);
    expect(stored).not.toMatch(/<style/i);
    expect(stored).not.toMatch(/<img/i);
    expect(stored).not.toMatch(/<iframe/i);
    expect(stored).not.toMatch(/<svg/i);
    expect(stored).not.toMatch(/<math/i);
    expect(stored).not.toMatch(/<form|<button|<input/i);
    expect(stored).not.toMatch(/<object|<embed/i);
    expect(stored).not.toMatch(/\son[a-z]+\s*=/i);
    expect(stored).not.toMatch(/javascript:/i);
    expect(stored).not.toMatch(/data:/i);
    expect(stored).not.toMatch(/\sstyle\s*=/i);
    expect(stored).not.toMatch(/formaction/i);
    expect(stored).not.toContain("tracker.attacker.invalid");
    expect(stored).not.toContain("document.cookie");
    // The human-readable content and the one legitimate link survived.
    expect(stored).toContain("Approved, see the attached notes.");
    expect(stored).toContain('<a href="https://client-one.invalid/ok" rel="noopener noreferrer nofollow">');
    expect(stored).toContain("cell text survives");
  });

  // ── 11 encoding attacks ───────────────────────────────────────────────────────────────────────
  it("[11-encoding-attacks] the stored subject is one line with no control characters; encoded payloads are inert", async () => {
    const res = await post(body("11-encoding-attacks.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const subject = String(row.subject);
    const stored = String(row.body_html_sanitized);
    const text = String(row.body_text);

    // eslint-disable-next-line no-console
    console.log(`\n[MAIL-13 DB EVIDENCE] mail_messages.subject = ${JSON.stringify(subject)}\n` +
      `[MAIL-13 DB EVIDENCE] mail_messages.body_html_sanitized = ${JSON.stringify(stored)}\n`);

    expect(subject).not.toMatch(/[\r\n]/);
    expect([...subject].every((ch) => (ch.codePointAt(0) as number) >= 0x20)).toBe(true);
    expect(subject).toContain("Bcc: attacker@evil.invalid"); // present as inert TEXT, not as a header
    expect(text.includes(String.fromCharCode(0))).toBe(false);
    expect(stored).not.toMatch(/<script/i);
    expect(stored).not.toContain("attacker.invalid"); // the unterminated <script tail was dropped
    expect(stored).toContain("+ADw-script+AD4-"); // UTF-7 payload survives only as escaped text
    // The attachment filename's CR/LF is flattened before it could ever reach a header.
    const atts = row.attachments as Array<Record<string, unknown>>;
    expect(String(atts[0].name)).not.toMatch(/[\r\n]/);
  });

  // ── 12 quoted-reply bloat ─────────────────────────────────────────────────────────────────────
  it("[12-quoted-reply-bloat] threads, and does NOT lose the actual reply (this payload sits under the intake cap)", async () => {
    const res = await post(body("12-quoted-reply-bloat.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(String(row.body_text)).toContain("Approved.");
    expect(Number(row.size_bytes)).toBeGreaterThan(100_000);
    // Intake caps, it does not interpret: quoted history is still present (collapsing it is MAIL-20
    // render work — see the rationale in html-sanitize.ts's sanitizeInboundText). This particular
    // fixture is under the 128 KiB body_text cap (design A15/MAIL-19), so no truncation happens here
    // at all — the genuine over-cap head+tail cases live in 16/17 below.
    expect(String(row.body_text)).toContain("> ");
    // [MAIL-25] under-cap: the structured field agrees with the absence of a marker.
    expect(row.body_truncated).toBe(false);
    expect(Number(row.body_truncated_chars)).toBe(0);
  });

  // ── 16 / 17 / 18 — MAIL-19 / design A15: head+tail intake cap shape ──────────────────────────────
  it("[16-bottom-posted-oversize-quote] THE regression case: a bottom-posted reply under an over-cap quote survives", async () => {
    const res = await post(body("16-bottom-posted-oversize-quote.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const storedBodyText = String(row.body_text);

    // Printed so the ticket report can quote the ACTUAL database value, not just a passing assertion.
    // eslint-disable-next-line no-console
    console.log(
      "\n[MAIL-19 DB EVIDENCE] mail_messages.body_text (bottom-posted, over-cap) — length=" +
        storedBodyText.length +
        "\n--- first 200 chars ---\n" + storedBodyText.slice(0, 200) +
        "\n--- last 300 chars ---\n" + storedBodyText.slice(-300) + "\n",
    );

    // THE assertion this case exists to pin: the human's reply, sitting BELOW the whole quoted
    // thread, is present in what was actually written to Postgres. A head-only cap would have sliced
    // this away entirely (the raw body is ~145 KB; the reply is the last ~90 bytes of it).
    expect(storedBodyText).toContain("Approved. Please proceed with the milestone payment so we can move forward.");
    // Exactly one elision marker, heuristic-free (computed from length, not content).
    const markerMatches = storedBodyText.match(/\[truncated at intake: \d+ characters omitted here]/g) ?? [];
    expect(markerMatches).toHaveLength(1);
    // Some of the quoted history in the middle really was dropped — this is a CAP, not a no-op.
    expect(Number(row.size_bytes)).toBeGreaterThan(100_000);

    // [MAIL-25] THE structured signal — read back from Postgres, matching the marker's own N exactly.
    // This is what the UI's truncation notice must be driven by, per the ticket's whole point.
    const [, markerN] = /\[truncated at intake: (\d+) characters omitted here]/.exec(storedBodyText) ?? [];
    expect(row.body_truncated).toBe(true);
    expect(Number(row.body_truncated_chars)).toBe(Number(markerN));
    expect(Number(row.body_truncated_chars)).toBeGreaterThan(0);
  });

  it("[17-top-posted-oversize-quote] the A15 companion case: a top-posted reply above an over-cap quote still survives", async () => {
    const res = await post(body("17-top-posted-oversize-quote.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const storedBodyText = String(row.body_text);

    // eslint-disable-next-line no-console
    console.log(
      "\n[MAIL-19 DB EVIDENCE] mail_messages.body_text (top-posted, over-cap) — first 200 chars:\n" +
        storedBodyText.slice(0, 200) + "\n",
    );

    expect(storedBodyText).toContain("Approved. Please proceed with the milestone payment so we can move forward.");
    // Reply is at the very front, well inside the kept head.
    expect(storedBodyText.indexOf("Approved.")).toBeLessThan(100);
    const markerMatches = storedBodyText.match(/\[truncated at intake: \d+ characters omitted here]/g) ?? [];
    expect(markerMatches).toHaveLength(1);

    // [MAIL-25] structured field agrees with the top-posted marker too.
    const [, markerN] = /\[truncated at intake: (\d+) characters omitted here]/.exec(storedBodyText) ?? [];
    expect(row.body_truncated).toBe(true);
    expect(Number(row.body_truncated_chars)).toBe(Number(markerN));
  });

  it("[18-elision-marker-spoof] a forged elision marker cannot mislabel or hide behind the genuine one", async () => {
    const res = await post(body("18-elision-marker-spoof.json"));
    expect(res.statusCode).toBe(204);
    const rows = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows).toHaveLength(1);
    const row = rows[0];
    const storedBodyText = String(row.body_text);

    // eslint-disable-next-line no-console
    console.log(
      "\n[MAIL-19 DB EVIDENCE] mail_messages.body_text (elision-marker spoof) — first 260 chars:\n" +
        storedBodyText.slice(0, 260) + "\n",
    );

    // Both sender-forged decoys survive VERBATIM, as ordinary text, wherever they were planted —
    // proving intake never treats marker-shaped input specially.
    expect(storedBodyText).toContain("[truncated at intake: 999999999 characters omitted here]");
    expect(storedBodyText).toContain("[truncated at intake: 1 characters omitted here]");
    // The genuine reply the fixture also carries survives.
    expect(storedBodyText).toContain("Approved, proceed with deployment.");
    // Exactly ONE marker carries the mathematically correct count for this payload (18928 = raw
    // length minus the 128 KiB budget) — the two decoys' bogus counts (999999999 and 1) never equal
    // it, so a reader can always tell genuine from forged by the number alone.
    expect(storedBodyText).toContain("[truncated at intake: 18928 characters omitted here]");
    const allMarkerShaped = storedBodyText.match(/\[truncated at intake: \d+ characters omitted here]/g) ?? [];
    expect(allMarkerShaped).toHaveLength(3); // 2 decoys (verbatim content) + 1 genuine
    const genuineCount = allMarkerShaped.filter((m) => m === "[truncated at intake: 18928 characters omitted here]").length;
    expect(genuineCount).toBe(1);
    // The content planted in the dropped middle region never survives.
    expect(storedBodyText).not.toContain("DROPPED-MIDDLE-CANARY");
    // The tail content past the elision point is still present — this is a head+tail cap, not head-only.
    expect(storedBodyText).toContain("TAIL-CONTENT-MARKER-BEGIN");

    // [MAIL-25] THE pin for this ticket: the structured field carries the mathematically correct
    // count and is completely unmoved by either forged decoy (999999999, 1) planted in the content.
    // A forged marker has no way to write to this column — it is set from length arithmetic alone.
    expect(row.body_truncated).toBe(true);
    expect(Number(row.body_truncated_chars)).toBe(18928);
  });

  // ── 13 / 15 NDR classification ────────────────────────────────────────────────────────────────
  it("[13-ndr-hard-bounce] flips the log row to bounced, suppresses once, and stores the NDR with NO entity", async () => {
    const res = await post(body("13-ndr-hard-bounce.json"));
    expect(res.statusCode).toBe(204);
    const log = await adminPool().query(`SELECT status, last_error FROM mail_log WHERE id = $1`, [mailA.id]);
    expect(log.rows[0].status).toBe("bounced");
    expect(String(log.rows[0].last_error)).toContain("status=5.1.1");
    const supp = await adminPool().query(
      `SELECT count(*)::int AS n FROM mail_suppressions WHERE email = 'corpus-recipient@a.test' AND reason = 'hard_bounce'`,
    );
    expect(supp.rows[0].n).toBe(1);
    // Visible through the admin log thread (mail_log_id), never on the entity thread.
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBeNull();
    expect(rows[0].entity_id).toBeNull();
  });

  it("[13-ndr-hard-bounce] replayed: still exactly one suppression row and one message", async () => {
    const payload = body("13-ndr-hard-bounce.json", "fixed-ndr");
    await post(payload);
    await post(payload);
    const supp = await adminPool().query(`SELECT count(*)::int AS n FROM mail_suppressions`);
    const msgs = await messagesFor(mailA.id);
    expect(supp.rows[0].n).toBe(1);
    expect(msgs).toHaveLength(1);
  });

  it("[15-ndr-lookalike] a human reply that TALKS about a bounce is NOT classified as one", async () => {
    const res = await post(body("15-ndr-lookalike-human-reply.json"));
    expect(res.statusCode).toBe(204);
    const log = await adminPool().query(`SELECT status FROM mail_log WHERE id = $1`, [mailA.id]);
    expect(log.rows[0].status).toBe("sent"); // unchanged
    const supp = await adminPool().query(`SELECT count(*)::int AS n FROM mail_suppressions`);
    expect(supp.rows[0].n).toBe(0); // no mail-denial-of-service against a real recipient
    const rows = await messagesFor(mailA.id);
    expect(rows).toHaveLength(1); // MAIL-27: guard before indexing — see 09's comment
    expect(rows[0].entity_id).toBe(mailA.entityId); // threaded as an ordinary reply
  });

  // ── 14 EICAR / scan gate ──────────────────────────────────────────────────────────────────────
  it("[14-eicar-attachment] EICAR is stored as infected with its bytes DISCARDED; the clean sibling is stored", async () => {
    config.mail.inboundScan = "clamav";
    const eicar = eicarBytes().toString("utf8");
    // Stand-in for clamd (which runs on gda-aicenter under the `scan` profile, not on a dev box —
    // MAIL-14 proved the live EICAR path there). Same interface the real client implements.
    const fake: AttachmentScanner = {
      name: "fake-clamd",
      async scan(bytes) {
        return bytes.toString("utf8").includes(eicar) ? "infected" : "clean";
      },
    };
    setScannerForTest(fake);

    const res = await post(body("14-eicar-attachment.json"));
    expect(res.statusCode).toBe(204);
    const rows14 = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rows14).toHaveLength(1);
    const atts = rows14[0].attachments as Array<Record<string, unknown>>;
    expect(atts[0]).toMatchObject({ name: "signed-scope.txt", scanStatus: "clean" });
    expect(atts[0].fileRef).toBeTruthy();
    expect(atts[1]).toMatchObject({ name: "invoice-final.doc", scanStatus: "infected", fileRef: null });
    // The malicious bytes are not on disk at all.
    expect(store.files.size).toBe(1);
    for (const buf of store.files.values()) expect(buf.toString("utf8")).not.toContain(eicar);
  });

  it("[scan] an UNREACHABLE scanner leaves attachments 'pending' — unscannable stays quarantined", async () => {
    config.mail.inboundScan = "clamav";
    setScannerForTest({ name: "down", async scan() { return "pending"; } });
    const res = await post(body("06-replayed-provider-id.json"));
    expect(res.statusCode).toBe(204);
    const rowsPending = await messagesFor(mailA.id); // MAIL-27: guard before indexing — see 09's comment
    expect(rowsPending).toHaveLength(1);
    const atts = rowsPending[0].attachments as Array<Record<string, unknown>>;
    expect(atts[0].scanStatus).toBe("pending");
  });

  // ── flood control + malformed ─────────────────────────────────────────────────────────────────
  // MAIL-37: the limiter now runs BEFORE authentication (inbound.controller.ts), but every request
  // this case sends is authenticated (via `post()`'s default token header) — so this assertion is
  // unchanged by the reorder; it was never testing ordering, only the per-source cap itself.
  it("[rate] 429s past the per-source limit", async () => {
    config.mail.inboundRatePerMin = 2;
    resetInboundRateLimitForTest();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      codes.push((await post(body("04-absent-token.json"))).statusCode);
    }
    expect(codes.slice(0, 2)).toEqual([204, 204]);
    expect(codes.slice(2)).toEqual([429, 429]);
  });

  it("[malformed] a non-JSON / non-Brevo authenticated body 400s and stores nothing", async () => {
    const notJson = await post("this is not json at all");
    const wrongShape = await post(JSON.stringify({ hello: "world" }));
    expect(notJson.statusCode).toBe(400);
    expect(wrongShape.statusCode).toBe(400);
    const all = await adminPool().query(`SELECT count(*)::int AS n FROM mail_messages`);
    expect(all.rows[0].n).toBe(0);
  });

  // ── live-defect reproduction (2026-08-07): no/unrecognized content-type used to 500 ──────────────
  // Live evidence (production box; real domain deliberately not spelled out here — see A12's grep
  // gate, grep-gate.test.ts): `POST /api/mail/inbound/brevo` with no content-type header returned
  // 500, and the log showed `FastifyError: Unsupported Media Type: undefined`
  // escaping to `LastResortExceptionFilter`'s unconditional 500. Fastify raises that error from its
  // OWN content-type-parser selection step (`node_modules/fastify/lib/contentTypeParser.js`), which
  // runs BEFORE the `preParsing` raw-body hook's replacement body is ever handed to a parser and
  // BEFORE the controller (and therefore before `authenticateInbound`) ever runs — so this reproduces
  // with NO auth headers at all, deliberately not routed through this file's `post()` helper (which
  // always sets `content-type: application/json`). Brevo itself always sends JSON — this fixture
  // exists for the internet-facing scanner traffic the ticket described, not a real provider case.
  it("[malformed] (live-defect fix) no content-type header at all -> 415, not 500, and leaks nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/inbound/brevo",
      // No `content-type` header — `light-my-request` only infers one for object payloads, never for
      // a raw string, so this is the same "content-type: undefined" shape the live log captured.
      payload: JSON.stringify({ items: [] }),
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "unsupported media type", code: "unsupported_media_type" });
    // Never the raw Fastify error text ("Unsupported Media Type: undefined") or anything else
    // exception-derived — the fixed generic body from LastResortExceptionFilter's client-error table.
    expect(res.payload).not.toContain("Unsupported Media Type");
    expect(res.payload).not.toContain("FastifyError");
    const all = await adminPool().query(`SELECT count(*)::int AS n FROM mail_messages`);
    expect(all.rows[0].n).toBe(0);
  });

  it("[malformed] (live-defect fix) an unrecognized content-type (application/xml) also 415s cleanly, not 500", async () => {
    // NOT `text/plain` — Fastify registers a default parser for that (and for `application/json`)
    // out of the box (`contentTypeParser.js`), so it would parse successfully rather than reproduce
    // the "no matching parser" condition. `application/xml` has no registered parser anywhere in
    // this app, matching the "genuinely unrecognized" shape the live defect needs.
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/inbound/brevo",
      headers: { "content-type": "application/xml" },
      payload: "<not-brevo/>",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toEqual({ error: "unsupported media type", code: "unsupported_media_type" });
  });
});
