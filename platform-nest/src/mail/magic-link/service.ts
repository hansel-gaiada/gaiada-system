// MAIL-10 — magic-link mint + consume (design §9; M8/M11 locked).
//
// ── M11 HARD NON-GOAL (restated here, at the minting site, per the ticket's explicit demand) ───
// A magic link is a bearer credential sitting in an inbox. It is a LOW-RISK CONVENIENCE LOGIN
// mechanism ONLY and must NEVER become an approval mechanism — approval/warning mail (§7.5) keeps
// carrying a plain entity URL with no token, forever, regardless of anything built here. Nothing
// in this file may be reused, imported, or copied by an approval/notification send path. Pinned by
// `m11-non-goal.test.ts` (asserts no approval/warning-rendered template body ever contains a
// magic-link URL shape), re-asserted end to end by MAIL-11/MAIL-18.
//
// ── WHY THE RAW TOKEN NEVER TOUCHES `mail_log.payload` (the ticket's other hard line) ───────────
// The rest of this module's mail is deliberately safe to queue-and-defer: `enqueueMail()` persists
// `payload`, and the async sender worker re-renders `{subject,html,text}` from
// `(template_key, payload)` possibly seconds later (sender.ts). That is fine for approval mail
// because its `href` carries no secret. A magic link's `href` IS the secret — persisting it in
// `mail_log.payload` would put a live, usable login credential in a queryable, admin-readable,
// backup-included row, which is exactly what "store only hashes, never a usable token, never in a
// log line" forbids. So `mintAndSend` below renders and sends INLINE (the raw token lives only in
// local variables, never assigned to anything that reaches a `JSON.stringify`/`c.query` call), and
// writes a REDACTED `mail_log` audit row (no href, no token) that starts at `status='sending'` —
// deliberately outside the standard sender loop's `WHERE status='queued'` claim, so the
// payload-driven re-render path can never be asked to reconstruct this mail from a hash it cannot
// reverse. The send itself is fire-and-forget from the caller's perspective (never awaited by
// `requestMagicLink`), because awaiting a real SMTP round-trip inside the HTTP handler would
// reopen the exact timing oracle the "202 body+timing identical for existing vs unknown address"
// requirement exists to close.
//
// ── AUTH-STREAM SENDS ARE SINGLE-ATTEMPT BY DESIGN (MAIL-24, Finding 4) ─────────────────────────
// `sendNow` below is fire-and-forget, awaited by nothing, and retried by NOTHING — a failure there
// flips the audit row straight to `mail_log.status='failed'` and stops. This is NOT an oversight;
// it falls directly out of the constraint two paragraphs up. The standard sender's backoff/retry
// loop (`sender.ts`) works by re-rendering `{subject,html,text}` from `(template_key, payload)` on
// each attempt — and this module's `payload` is deliberately redacted (no href, no token), so a
// retry attempt would have nothing to re-render and nothing to send. Persisting the raw token so a
// retry COULD reconstruct it is the one fix explicitly ruled out (MAIL-11 verified zero token
// leakage in DB/logs; re-opening that is a regression, not a resilience improvement). A bounded
// re-mint-and-resend path (issue a brand NEW token on a detected failure) is a real design option
// but a NEW feature with its own replay/enumeration surface, not something to improvise inside a
// QA-closure ticket — flag it for an architect design call if the alert below proves failures are
// not actually rare.
//
// So the compensating control is making the failure LOUD instead of silently retried: every
// `sendNow` catch already calls `recordFailed("auth")` (`mail_failed_total{stream="auth"}`,
// src/mail/metrics.ts), and `infra/observability/prometheus/rules/alerts.yml`'s
// `MailAuthStreamSendFailed` rule fires on ANY increase of that counter (not a rate threshold —
// design §11 lists "any auth-stream `failed` row" as its own alert condition, separately from the
// generic notify-stream failure-RATE alert, precisely because there is no retry safety net here).
// An operator seeing that page knows: a real user got a 202 and never got their sign-in link, and
// must be told to request a fresh one — there is nothing to "retry" from this side.
//
// ── ACTIVITIES AUDIT — why this does NOT write to the `activities` table ────────────────────────
// The ticket asks for "an activities audit row per mint and per consume". `activities.tenant_id`
// is NOT NULL (0001_core.sql) and every call site in this codebase resolves a real `:tenantId`
// route param before calling `writeActivity()` — there is zero precedent for a tenant-less write,
// and inventing a tenant attribution for a pre-tenant-context auth event (which tenant, for a user
// in N companies? none, for an unknown address?) would be exactly the kind of guess this ticket
// says to avoid. The codebase's OWN precedent for a global-scope event is
// `src/rbac/principal.ts`'s `auditDecision`: `if (!tenantId) return; // global-scope decisions
// have no tenant feed (logged by caller)`. This file follows that precedent literally: mint/consume
// are logged by the caller (`logMagicLinkAudit`, structured console output — no token, ever) AND
// durably recorded as the mail_log audit row (mint) / the `auth_magic_links` row's own
// `consumed_at`/`consumed_ip` columns (consume) — the row IS the audit trail, the same convention
// `mail_log` already uses for every other kind of mail (A5).
import type { PoolClient } from "pg";
import { config } from "../../config";
import { newId, withGlobal, withMailContext } from "../../db";
import { normalizeEmail } from "../sanitize";
import { isSuppressed } from "../suppressions";
import { renderTemplate } from "../templates";
import { resolveAdapter } from "../provider";
import { recordEnqueued, recordSent, recordFailed, recordSendDuration } from "../metrics";
import type { RenderedMail } from "../types";
import { generateRawToken, hashToken } from "./tokens";
import { checkHourlyRate } from "./rate-limit";

export class MagicLinkNotEnabledError extends Error {
  readonly status = 404;
  constructor() {
    super("magic links are not enabled");
    this.name = "MagicLinkNotEnabledError";
  }
}

/** ONE generic error for every unusable-consume path (unknown token, already-consumed/replayed,
 *  expired) — deliberately no `.reason` field of any kind, so there is nothing for a future
 *  caller to accidentally leak into a response and turn back into a distinguishing oracle. */
export class MagicLinkConsumeError extends Error {
  readonly status = 400;
  readonly code = "magic_link_invalid";
  constructor() {
    super("this sign-in link is not usable — request a new one");
    this.name = "MagicLinkConsumeError";
  }
}

function logMagicLinkAudit(event: string, detail: Record<string, unknown>): void {
  // Structured, token-free by construction: every call site below passes only ids (`userId`,
  // `linkId`, `mailLogId`) — never `rawToken`/`tokenHash`. `auditDecision`'s "logged by caller"
  // precedent (see this file's header) is what this line implements.
  // eslint-disable-next-line no-console
  console.log(`[magic-link:audit] ${event}`, JSON.stringify(detail));
}

/** Thrown ONLY to unwind `withMailContext`'s own transaction to a ROLLBACK for the decoy
 *  `mail_log` write in `dummyEquivalentWork` below — `withMailContext` (`src/db/index.ts`) rolls
 *  back on ANY thrown error, so this reuses that existing guarantee instead of hand-rolling a
 *  second transaction-abort path. Never surfaced past `dummyEquivalentWork`, never logged, carries
 *  no data. */
class DecoyAbort extends Error {}

/** Equivalent-COST decoy work for the unknown-address / rate-limited early returns (MAIL-24,
 *  Finding 1 — closing QA's timing-enumeration oracle). This REPLACES v1's three `SELECT 1`s,
 *  which QA measured (N=30/branch, real DB) at a 3.25x gap against the real branch: known median
 *  13ms (IQR 13-15) vs unknown median 4ms (IQR 4-5) — reproducible, not noise. `SELECT 1` touches
 *  no table, no index, no WAL, so it structurally cannot approximate a branch whose real cost is
 *  one suppression SELECT + two INSERTs into indexed, constraint-checked tables + a template
 *  render. A sleep was considered and rejected (per the ticket): a fixed delay is itself a
 *  fingerprintable signature (it has zero variance where the real branch has DB-driven jitter) and
 *  taxes every legitimate unknown-address caller by the same fixed amount for no protective gain.
 *
 *  So this pays a REAL, equivalent-shape cost instead, mirroring the real branch's four
 *  round-trips one-for-one:
 *   1. the SAME suppression query the known branch runs (`isSuppressed`, byte-for-byte) against a
 *      decoy address that can never collide with a real suppression row;
 *   2. a decoy INSERT into `auth_magic_links` — that table's `user_id` is `NOT NULL REFERENCES
 *      users(id)` (0080's migration), so a real row is borrowed via a cheap `SELECT id FROM users
 *      LIMIT 1` rather than inventing one (a fabricated id would fail the FK and either throw or
 *      require weakening the check just for this decoy — neither is acceptable on an auth-critical
 *      table). If the table is genuinely empty — a brand-new deploy with zero accounts — there is
 *      no "known address" scenario to protect timing for either, so this decoy write is skipped
 *      rather than faked. The INSERT is followed by a DELETE of the same row, and the whole thing
 *      runs inside a transaction this function opens and ALWAYS rolls back (`finally`), so nothing
 *      is ever left behind even if the DELETE itself never runs;
 *   3. the SAME `renderTemplate("auth.magic_link", …)` CPU call the real branch makes (result
 *      discarded, never sent, never logged);
 *   4. a decoy INSERT+DELETE into `mail_log`, aborted via the `DecoyAbort` sentinel above so
 *      `withMailContext`'s existing rollback-on-throw guarantee applies.
 *
 *  Re-measured with QA's own methodology after this change (N=30/branch, medians + IQRs) — see
 *  MAIL-24's report for the resulting numbers. This closes the gross application-level
 *  branch-skip oracle; it is still NOT a cryptographic constant-time claim (same framing as this
 *  function's original comment, restated because the claim is now stronger, not because the
 *  caveat changed — network jitter over real HTTP still dominates any sub-millisecond residual). */
async function dummyEquivalentWork(): Promise<void> {
  const decoyEmail = `decoy-${newId()}@dev.gaiada.invalid`;

  await withMailContext((c) => isSuppressed(c, decoyEmail, "auth"));

  const borrowed = await withGlobal((c) => c.query<{ id: string }>(`SELECT id FROM users LIMIT 1`));
  const borrowedUserId = borrowed.rows[0]?.id;
  if (borrowedUserId) {
    await withGlobal(async (c) => {
      const decoyId = newId();
      await c.query("BEGIN");
      try {
        await c.query(
          `INSERT INTO auth_magic_links (id, user_id, email, token_hash, requested_ip, expires_at, origin_site)
           VALUES ($1,$2,$3,$4,$5, now() + interval '1 minute', $6)`,
          [decoyId, borrowedUserId, decoyEmail, hashToken(generateRawToken()), "0.0.0.0", config.originSite],
        );
        await c.query(`DELETE FROM auth_magic_links WHERE id = $1`, [decoyId]);
      } finally {
        await c.query("ROLLBACK");
      }
    });
  }

  const rendered = renderTemplate("auth.magic_link", {
    href: `${config.mail.linkBaseUrl}/auth/magic?token=decoy`,
    ttlMinutes: 15,
  });

  try {
    await withMailContext(async (c) => {
      const decoyId = newId();
      await c.query(
        `INSERT INTO mail_log (
           id, stream, tenant_id, user_id, to_email, template_key, subject, payload,
           entity_type, entity_id, status, origin_site
         ) VALUES ($1,'auth',NULL,NULL,$2,'auth.magic_link',$3,$4,'auth_magic_link',$5,'sending',$6)`,
        [decoyId, decoyEmail, rendered.subject, JSON.stringify({ ttlMinutes: 15 }), decoyId, config.originSite],
      );
      await c.query(`DELETE FROM mail_log WHERE id = $1`, [decoyId]);
      throw new DecoyAbort();
    });
  } catch (err) {
    if (!(err instanceof DecoyAbort)) throw err;
  }
}

export interface RequestMagicLinkInput {
  email: string;
  ip: string;
}

export type RequestMagicLinkResult = { status: "accepted" } | { status: "suppressed" };

/** Always resolves — never throws for "unknown address" or "rate limited" (both fold into
 *  `{status:"accepted"}`, the same shape/timing-budget as a real mint). The controller maps
 *  BOTH `"accepted"` and `"suppressed"` results per design §5.1: `"suppressed"` is the ONE
 *  documented, deliberate exception to the "identical for existing vs unknown" rule — a
 *  suppressed auth address must never look like a sent one, so it alone gets a different response.
 *  `MagicLinkNotEnabledError` is the only thrown path (feature-flag gate). */
export async function requestMagicLink(input: RequestMagicLinkInput): Promise<RequestMagicLinkResult> {
  if (!config.mail.magicLinksEnabled) throw new MagicLinkNotEnabledError();
  const email = normalizeEmail(input.email);
  const ip = input.ip || "unknown";

  const addrDecision = checkHourlyRate(`addr:${email}`, config.mail.magicLinkRatePerAddressHour);
  const ipDecision = checkHourlyRate(`ip:${ip}`, config.mail.magicLinkRatePerIpHour);
  if (!addrDecision.allowed || !ipDecision.allowed) {
    await dummyEquivalentWork();
    logMagicLinkAudit("mint.rate_limited", { ip });
    return { status: "accepted" };
  }

  const found = await withGlobal((c) =>
    c.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND status = 'active' AND deleted_at IS NULL`,
      [email],
    ),
  );
  const userId = found.rows[0]?.id ?? null;
  if (!userId) {
    await dummyEquivalentWork();
    logMagicLinkAudit("mint.unknown_address", {});
    return { status: "accepted" };
  }

  const suppressed = await withMailContext((c) => isSuppressed(c, email, "auth"));
  if (suppressed) {
    // Deliberately distinguishable per design §5.1 — see this function's own doc comment.
    logMagicLinkAudit("mint.suppressed", { userId });
    return { status: "suppressed" };
  }

  await mintAndSend({ userId, email, ip });
  return { status: "accepted" };
}

async function mintAndSend(input: { userId: string; email: string; ip: string }): Promise<void> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const linkId = newId();
  const expiresAt = new Date(Date.now() + config.mail.magicLinkTtlSeconds * 1000);

  await withGlobal((c) =>
    c.query(
      `INSERT INTO auth_magic_links (id, user_id, email, token_hash, requested_ip, expires_at, origin_site)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [linkId, input.userId, input.email, tokenHash, input.ip, expiresAt.toISOString(), config.originSite],
    ),
  );

  const href = `${config.mail.linkBaseUrl}/auth/magic?token=${rawToken}`;
  const ttlMinutes = Math.max(1, Math.round(config.mail.magicLinkTtlSeconds / 60));
  const rendered = renderTemplate("auth.magic_link", { href, ttlMinutes });

  const mailLogId = newId();
  await withMailContext((c) =>
    c.query(
      `INSERT INTO mail_log (
         id, stream, tenant_id, user_id, to_email, template_key, subject, payload,
         entity_type, entity_id, status, origin_site
       ) VALUES ($1,'auth',NULL,$2,$3,'auth.magic_link',$4,$5,'auth_magic_link',$6,'sending',$7)`,
      [mailLogId, input.userId, input.email, rendered.subject, JSON.stringify({ ttlMinutes }), linkId, config.originSite],
    ),
  );
  recordEnqueued("auth", "auth.magic_link");
  logMagicLinkAudit("mint", { userId: input.userId, linkId, mailLogId });

  // Fire-and-forget — see this file's header for why. `rawToken`/`href` are captured in this
  // closure only; nothing below writes either to any row.
  void sendNow(mailLogId, input.email, rendered).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[magic-link] send failed:", (err as Error).message);
  });
}

async function sendNow(mailLogId: string, toEmail: string, rendered: RenderedMail): Promise<void> {
  const adapter = resolveAdapter("auth");
  const startedAt = Date.now();
  try {
    const result = await adapter.send({
      stream: "auth",
      to: { email: toEmail },
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    recordSendDuration("auth", Date.now() - startedAt);
    await withMailContext((c) =>
      c.query(
        `UPDATE mail_log
            SET status = 'sent', provider = $2, provider_message_id = $3,
                provider_accepted_at = now(), attempts = 1, updated_at = now()
          WHERE id = $1`,
        [mailLogId, adapter.name, result.providerMessageId ?? null],
      ),
    );
    recordSent("auth");
  } catch (err) {
    recordSendDuration("auth", Date.now() - startedAt);
    // Single-attempt by design (this file's header, "AUTH-STREAM SENDS ARE SINGLE-ATTEMPT BY
    // DESIGN") — `recordFailed("auth")` is the compensating control: it feeds
    // `mail_failed_total{stream="auth"}`, which `infra/observability/prometheus/rules/alerts.yml`'s
    // `MailAuthStreamSendFailed` rule pages on for ANY increase, not a rate threshold, because
    // there is no retry loop behind this to absorb a transient blip.
    recordFailed("auth");
    await withMailContext((c) =>
      c.query(
        `UPDATE mail_log SET status = 'failed', attempts = 1, last_error = $2, updated_at = now() WHERE id = $1`,
        [mailLogId, ((err as Error).message ?? String(err)).slice(0, 2000)],
      ),
    );
    throw err;
  }
}

export interface ConsumeMagicLinkInput {
  token: string;
  ip: string;
}

export interface ConsumedMagicLink {
  userId: string;
}

/** Single-use consume. The atomic `UPDATE … WHERE consumed_at IS NULL AND expires_at > now()
 *  RETURNING` (client_invites.ts's proven shape) is the WHOLE anti-replay mechanism: one
 *  statement, so two concurrent presentations of the same token cannot both win — Postgres's
 *  row-level lock serializes them, the loser's WHERE clause sees the already-set `consumed_at`
 *  and matches zero rows. Unknown token, replayed token, and expired token are indistinguishable
 *  by construction: all three produce zero returned rows, and the single `MagicLinkConsumeError`
 *  below is the only thing ever thrown for any of them — no `.reason`, no distinguishing detail. */
export async function consumeMagicLink(input: ConsumeMagicLinkInput): Promise<ConsumedMagicLink> {
  if (!config.mail.magicLinksEnabled) throw new MagicLinkNotEnabledError();
  const raw = input.token ?? "";
  if (!raw) throw new MagicLinkConsumeError();
  const tokenHash = hashToken(raw);

  const claimed = await withGlobal((c: PoolClient) =>
    c.query<{ id: string; user_id: string }>(
      `UPDATE auth_magic_links
          SET consumed_at = now(), consumed_ip = $2
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING id, user_id`,
      [tokenHash, input.ip || null],
    ),
  );
  const row = claimed.rows[0];
  if (!row) {
    logMagicLinkAudit("consume.rejected", {});
    throw new MagicLinkConsumeError();
  }
  logMagicLinkAudit("consume.ok", { userId: row.user_id, linkId: row.id });
  return { userId: row.user_id };
}
