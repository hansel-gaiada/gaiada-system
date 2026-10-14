// DW-8j (docs/FRONTEND-BFF-CONTRACT.md §48, ruling DW-D24) — email from the ERP through each employee's OWN Gmail: the connection, the reads and the
// send. The flow and the vault are here; the routes and every authorisation are in gmail.controller.ts. It is modelled on DW-6i's Drive service
// (core/google-drive/service.ts) and shares its OAuth state machine, vault and token client.
//
// ── BINDING RULES (DW-D24 and the mail design's §8C) ─────────────────────────────────────────────
//   * PER PERSON ONLY. Every function here takes the OWNER as the authenticated caller's own id; nothing takes it from a parameter. The
//     connection row is read by `owner_id = $caller`, so a forged row of someone else is never read.
//   * STORE NOTHING FROM THE MAILBOX. No message content, subject, body or address is written to the database, a log or an activity row. A
//     thread is fetched and decoded per request and returned; the list is not cached. The only things stored are the connection (the
//     person's own account email and, live, the sealed tokens: the vault's existing columns) and, per send, the activity row the controller
//     writes (actor, time, recipient COUNT, mode).
//   * TWO MODES (core/gmail/mode.ts). SIMULATED (the default) never builds the live client and never calls Google: the mailbox is the MAIL-16D
//     fixture corpus behind `SimulatedMailboxes`, sends land in the person's in-process Sent. LIVE builds the real Gmail client from the
//     person's own access token. System mail (the mail module's queue and sender) is NOT used.
//
// ── WHERE A TOKEN CAN GO (live) ──────────────────────────────────────────────────────────────────
//   * the ACCESS token: only into Gmail's `Authorization` header (integrations/gmail/api-client.ts); never in a response, unlike Drive's Picker;
//   * the REFRESH token: never out of this process; only into the token endpoint's request body;
//   * the ID token: read once in `completeConnect` for the account's email, then dropped;
//   * never a log line, an error message, an activity row or `meta`.
import { HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config, gmailLiveConfigured } from "../../config";
import { withTenants } from "../../db";
import { decryptSecret } from "../secret-box";
import { createConnection, patchConnection, revokeConnection, setConnectionTokens } from "../integrations.service";
import { GoogleOAuthNotConfiguredError, GoogleOAuthStateError, GoogleTokenEndpointError } from "../google-oauth/errors";
import { googleSurfaceFor } from "../google-oauth/registry";
import {
  attachConnectionToState, consumeAuthorizationState, createAuthorizationState, parseStateToken, type ConsumedAuthorizationState,
} from "../google-oauth/state";
import {
  buildAuthorizeUrl, exchangeAuthorizationCode, refreshAccessToken, revokeToken,
  type FetchImpl, type OAuthClientCredentials, type TokenResponse,
} from "../google-oauth/token-endpoint-client";
import { IdTokenError, readGoogleIdentity, type GoogleIdentity } from "../google-oauth/id-token";
import { createGmailApiClient, type GmailFetch } from "../../integrations/gmail/api-client";
import {
  GmailClientError, GmailInvalidMessageError, GmailNotFoundError, GmailRateLimitedError, GmailRevokedError, GmailUnauthorizedError,
} from "../../integrations/gmail/errors";
import { SimulatedMailboxes } from "../../integrations/gmail/simulated-mailboxes";
import { validateSendRequest } from "../../integrations/gmail/send-validation";
import type { GmailClient, GmailListLabel, GmailMessage, GmailSendRequest } from "../../integrations/gmail/types";
import { sanitizeInboundHeaderText, sanitizeInboundHtml, sanitizeInboundText } from "../../mail/inbound/html-sanitize";
import { gmailMode, type GmailMode } from "./mode";
import { SendRateLimiter } from "./rate-limit";
import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE, GMAIL_SCOPES, GOOGLE_GMAIL_SURFACE, registerGoogleGmailSurface } from "./surface";

export const GMAIL_PROVIDER = "google_gmail";
/** The access token is refreshed first when it expires within five minutes (the Drive rule). */
export const REFRESH_WITHIN_MS = 5 * 60 * 1000;
export const LIST_LABELS: readonly GmailListLabel[] = ["INBOX", "SENT"];

// ───────────────────────────────────────────── errors ─────────────────────────────────────────────

/** A refusal with its token at the START of `message` (the error filter turns `message` into `{ error }`), repeated in `reason`. `extra`
 *  may carry `field` or `retryAfterSeconds`, which the filter forwards. */
export function gmailError(status: number, token: string, text: string, extra: Record<string, unknown> = {}): HttpException {
  return new HttpException({ message: `${token}: ${text}`, reason: token, ...extra }, status);
}
export const notConfigured = () =>
  gmailError(503, "gmail_not_configured", "Gmail is not set up for this ERP yet (the Gmail OAuth client is not configured).");
const notConnected = () => gmailError(409, "gmail_not_connected", "Gmail is not connected for this account; connect it first.");
const needsReconnect = () => gmailError(409, "gmail_needs_reconnect", "Gmail refused this account's access; reconnect Gmail.");
const unavailable = () => gmailError(502, "gmail_unavailable", "Gmail can't be reached right now; try again shortly.");
const stateInvalid = () => gmailError(400, "gmail_state_invalid", "the Gmail connection could not be verified; start connecting again.");
const exchangeFailed = () => gmailError(502, "gmail_exchange_failed", "Google did not complete the Gmail connection; start connecting again.");
export const requestInvalid = (field: string, text: string) => gmailError(400, "gmail_request_invalid", `${field}: ${text}`, { field });
/** The 400 for a malformed outgoing message: `field` names the part that failed. */
export const sendInvalid = (field: string, text: string) => gmailError(400, "gmail_send_invalid", `${field}: ${text}`, { field });

/** A client-seam error as the HTTP refusal of §48. Anything that is not a seam error is returned as is (a bug is a 500, never hidden). */
export function mapClientError(e: unknown): unknown {
  if (e instanceof HttpException) return e;
  if (e instanceof GmailInvalidMessageError) return sendInvalid(e.field, e.message.replace(/^[^:]*: /, ""));
  if (e instanceof GmailRateLimitedError) {
    return gmailError(429, "gmail_rate_limited", "Gmail is limiting this account right now; wait and try again.", { retryAfterSeconds: e.retryAfterSeconds });
  }
  if (e instanceof GmailNotFoundError) return gmailError(404, "gmail_not_found", "Gmail has no such thread or message for this account.");
  if (e instanceof GmailUnauthorizedError || e instanceof GmailRevokedError) return needsReconnect();
  if (e instanceof GmailClientError) return unavailable();
  return e;
}

// ───────────────────────────────────────────── the seams ─────────────────────────────────────────────

let httpOverride: FetchImpl | null = null;
/** TEST ONLY: the `fetch` every Google call here goes through (the token client and the Gmail client). Null restores the real one. */
export function setGmailHttpForTests(f: FetchImpl | null): void {
  httpOverride = f;
}
const tokenHttp = (): FetchImpl | undefined => httpOverride ?? undefined;
const gmailHttp = (): GmailFetch | undefined => (httpOverride ?? undefined) as unknown as GmailFetch | undefined;

/** The ONE in-process home of every person's simulated Sent. Instance-owned, so it is lost on restart and shared with no one. */
export const simulatedMailboxes = new SimulatedMailboxes();
/** The ONE per-person send limiter (30 an hour). Replaced in tests so the 31st send needs no clock. */
let sendLimiter = new SendRateLimiter();
export function setSendLimiterForTests(l: SendRateLimiter | null): void {
  sendLimiter = l ?? new SendRateLimiter();
}
export const currentSendLimiter = (): SendRateLimiter => sendLimiter;

function gmailClientCreds(): OAuthClientCredentials {
  return { clientId: config.gmail.clientId, clientSecret: config.gmail.clientSecret };
}
function surface() {
  return googleSurfaceFor(GMAIL_PROVIDER) ?? (registerGoogleGmailSurface(), GOOGLE_GMAIL_SURFACE);
}
/** The address a person's simulated mailbox sends from: derived from their id, never from anything in a request. */
export const simulatedAccount = (userId: string): string => `me.${userId.slice(0, 8)}@simulated.invalid`;

// ───────────────────────────────────────────── the person's row ─────────────────────────────────────────────

interface GmailRow {
  id: string;
  status: string;
  external_account: string | null;
  scopes: string[];
  meta: Record<string, unknown>;
  token_expires_at: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
}
const NEEDS_RECONNECT_FLAG = "gmailNeedsReconnect";
const MODE_KEY = "gmailMode";

/** The caller's OWN google_gmail row (live, not deleted), or null. Tenant-scoped; the owner is the caller, never a parameter. */
async function loadOwnRow(tenantId: string, userId: string): Promise<GmailRow | null> {
  const r = await withTenants([tenantId], (c: PoolClient) =>
    c.query<GmailRow>(
      `SELECT id, status, external_account, scopes, meta, token_expires_at, access_token_enc, refresh_token_enc
         FROM integration_connections
        WHERE owner_kind = 'user' AND owner_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [userId, GMAIL_PROVIDER],
    ),
  );
  const row = r.rows[0] ?? null;
  if (!row) return null;
  const exp = row.token_expires_at as unknown as string | Date | null;
  return { ...row, meta: row.meta ?? {}, scopes: row.scopes ?? [], token_expires_at: exp ? new Date(exp).toISOString() : null };
}

const flagged = (row: GmailRow) => row.meta[NEEDS_RECONNECT_FLAG] === true;
const hasCredential = (row: GmailRow) => !!(row.access_token_enc || row.refresh_token_enc);
/** The row is a link of THIS mode. A simulated row is never a live link and a live row never a simulated one: switching GMAIL_MODE means
 *  connecting again, and a marker written in one mode can never stand in for a credential in the other. */
function linkedFor(row: GmailRow | null, mode: GmailMode): row is GmailRow {
  if (!row || row.status === "revoked") return false;
  const simulatedRow = row.meta[MODE_KEY] === "simulated";
  return mode === "simulated" ? simulatedRow : !simulatedRow && hasCredential(row);
}

function readSecrets(row: GmailRow): { access: string | null; refresh: string | null } {
  return {
    access: row.access_token_enc ? decryptSecret(row.access_token_enc) : null,
    refresh: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
  };
}

/** Marks the row "needs reconnect": status `error` plus a flag in `meta`. The tokens are NOT destroyed (a read path must not be able to
 *  shred a credential). Best effort: the refusal being reported must still propagate if this write fails. */
async function markNeedsReconnect(tenantId: string, row: GmailRow): Promise<void> {
  try {
    await patchConnection(tenantId, row.id, { status: "error", meta: { ...row.meta, [NEEDS_RECONNECT_FLAG]: true } });
  } catch {
    /* secondary-failure template: the primary outcome is the refusal */
  }
}

// ───────────────────────────────────────────── status ─────────────────────────────────────────────

export interface GmailStatusAnswer {
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  accountEmail: string | null;
  mode: GmailMode;
}

/** The status read, for the caller only (§48.2): the row and nothing else. It never unseals a token and NEVER calls Google. */
export async function statusAnswer(tenantId: string, userId: string): Promise<GmailStatusAnswer> {
  const mode = gmailMode();
  const configured = mode === "simulated" ? true : gmailLiveConfigured();
  const base: GmailStatusAnswer = { configured, connected: false, needsReconnect: false, accountEmail: null, mode };
  if (!configured) return base;
  const row = await loadOwnRow(tenantId, userId);
  if (!linkedFor(row, mode)) return base;
  if (flagged(row)) return { ...base, needsReconnect: true, accountEmail: row.external_account };
  return { ...base, connected: true, accountEmail: row.external_account };
}

// ───────────────────────────────────────────── 1 · start ─────────────────────────────────────────────

export type StartAnswer =
  | { mode: "simulated"; linked: true; accountEmail: string; connectionId: string }
  | { mode: "live"; authUrl: string };

/** SIMULATED: links the person's simulated mailbox at once, with no Google round trip (and so no vault key and no client needed).
 *  LIVE: mints the signed, single-use state row and returns Google's consent URL. Fails CLOSED first: the client unset is `gmail_not_configured`. */
export async function startConnect(tenantId: string, userId: string): Promise<StartAnswer> {
  const mode = gmailMode();
  if (mode === "simulated") return { mode, linked: true, ...(await connectSimulated(tenantId, userId)) };
  if (!gmailLiveConfigured()) throw notConfigured();
  const s = surface();
  const g = config.gmail;
  try {
    const state = await createAuthorizationState({
      tenantId, ownerKind: s.ownerKind, ownerId: userId, module: s.module, provider: "google_gmail",
      redirectUri: g.redirectUri, scopes: s.scopes, authorizeUrl: config.google.authorizeUrl, createdBy: userId,
    });
    const authUrl = buildAuthorizeUrl({
      scopes: s.scopes, state: state.stateToken, codeChallenge: state.codeChallenge, redirectUri: g.redirectUri, client: gmailClientCreds(),
    });
    return { mode, authUrl };
  } catch (e) {
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured(); // the vault key is unset: the same deployment state
    throw e;
  }
}

async function connectSimulated(tenantId: string, userId: string): Promise<{ accountEmail: string; connectionId: string }> {
  const existing = await loadOwnRow(tenantId, userId);
  // A live link's tokens never ride into a simulated link: clear them locally first (the grant itself stays at Google until revoked there).
  if (existing && hasCredential(existing)) await revokeConnection(tenantId, existing.id);
  const accountEmail = simulatedAccount(userId);
  const mapping = await createConnection(tenantId, {
    ownerKind: "user", ownerId: userId, provider: GMAIL_PROVIDER, externalAccount: accountEmail, scopes: GMAIL_SCOPES,
    meta: { [MODE_KEY]: "simulated", gmailLinkedAt: new Date().toISOString() },
    createdBy: userId,
  });
  // The simulated link holds no credential, so the vault's own `linked` (reserved for the token path in the HTTP API) is set here directly.
  await patchConnection(tenantId, mapping.id, { status: "linked" });
  return { accountEmail, connectionId: mapping.id };
}

// ───────────────────────────────────────────── 2 · callback (live only) ─────────────────────────────────────────────

export type CompleteOutcome =
  | { status: "connected"; accountEmail: string; connectionId: string }
  | { status: "denied"; reason: "gmail_consent_denied" };

/** The tenant id inside a state token, verified (signature only; nothing is consumed). The controller needs it to run the surface's Cerbos
 *  check BEFORE the state is spent. */
export function verifiedStateTenant(stateToken: string): string {
  try {
    return parseStateToken(stateToken).tenantId;
  } catch (e) {
    if (e instanceof GoogleOAuthStateError) throw stateInvalid();
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured();
    throw e;
  }
}

/** Spends the state (single use), exchanges the code, reads the account email from the ID token, and seals the tokens in the person's
 *  single `google_gmail` row. The tenant and the person come ONLY from the verified state. */
export async function completeConnect(args: { stateToken: string; code: string; principalUserId: string }): Promise<CompleteOutcome> {
  if (gmailMode() !== "live") throw stateInvalid(); // no Google flow exists in simulated mode
  if (!gmailLiveConfigured()) throw notConfigured();
  const g = config.gmail;
  const s = surface();

  let state: ConsumedAuthorizationState;
  try {
    state = await consumeAuthorizationState(args.stateToken, {
      redirectUri: g.redirectUri, principalUserId: args.principalUserId, provider: "google_gmail", module: s.module,
    });
  } catch (e) {
    if (e instanceof GoogleOAuthStateError) throw stateInvalid();
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured();
    throw e;
  }
  // The row must describe a person's OWN connection, and that person must be the caller.
  if (state.ownerKind !== "user" || state.ownerId !== args.principalUserId) throw stateInvalid();
  const tenantId = state.tenantId;

  let tokens: TokenResponse;
  try {
    tokens = await exchangeAuthorizationCode(
      { code: args.code, codeVerifier: state.codeVerifier, redirectUri: state.redirectUri, client: gmailClientCreds() },
      tokenHttp(),
    );
  } catch (e) {
    if (e instanceof GoogleTokenEndpointError || e instanceof GoogleOAuthNotConfiguredError) throw exchangeFailed();
    throw e;
  }

  // Granular consent: the person can untick either Gmail permission on Google's screen. A token missing one cannot do the whole job (read
  // AND send), so it is not stored; it is the same outcome as pressing Cancel.
  const granted = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : state.scopes;
  if (!granted.includes(GMAIL_READONLY_SCOPE) || !granted.includes(GMAIL_SEND_SCOPE)) return { status: "denied", reason: "gmail_consent_denied" };

  let identity: GoogleIdentity;
  try {
    if (!tokens.idToken) throw new IdTokenError("malformed");
    identity = readGoogleIdentity(tokens.idToken, g.clientId);
  } catch (e) {
    if (e instanceof IdTokenError) throw exchangeFailed();
    throw e;
  }

  const existing = await loadOwnRow(tenantId, state.ownerId);
  const priorMeta = { ...(existing?.meta ?? {}) };
  delete priorMeta[NEEDS_RECONNECT_FLAG];
  const mapping = await createConnection(tenantId, {
    ownerKind: "user", ownerId: state.ownerId, provider: GMAIL_PROVIDER, externalAccount: identity.email, scopes: granted,
    meta: {
      ...priorMeta,
      [MODE_KEY]: "live",
      googleIssuerHost: state.issuerHost,
      googleIssuerIsGoogle: !state.simulated,
      googleLinkedAt: new Date().toISOString(),
      googleSub: identity.sub,
      googleEmailVerified: identity.emailVerified,
    },
    createdBy: state.createdBy,
  });
  const sealed = await setConnectionTokens(tenantId, mapping.id, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken, // null on a re-consent that returned none: COALESCE keeps the existing one
    tokenExpiresAt: tokens.expiresAt,
    scopes: granted,
    externalAccount: identity.email,
  });
  try {
    await attachConnectionToState(tenantId, state.stateId, sealed.id, s.module);
  } catch {
    /* audit link only: a credential already sealed must never be undone by it */
  }
  return { status: "connected", accountEmail: identity.email, connectionId: sealed.id };
}

// ───────────────────────────────────────────── 3 · disconnect ─────────────────────────────────────────────

/** SIMULATED: clears the local link and forgets the person's simulated Sent. LIVE: revokes at Google (best effort, REPORTED, never fatal:
 *  forgetting a credential must not wait on a remote endpoint), then clears the sealed tokens (soft revoke: status `revoked`, tokens nulled,
 *  the row kept). `disconnected:false` when there was nothing to clear. */
export async function disconnect(
  tenantId: string,
  userId: string,
): Promise<{ disconnected: boolean; revokedAtGoogle: boolean | null; connectionId: string | null; mode: GmailMode }> {
  const mode = gmailMode();
  const row = await loadOwnRow(tenantId, userId);
  if (!row || row.status === "revoked") return { disconnected: false, revokedAtGoogle: null, connectionId: row?.id ?? null, mode };
  let revokedAtGoogle: boolean | null = null;
  if (hasCredential(row)) {
    const { access, refresh } = readSecrets(row);
    const target = refresh ?? access; // the long-lived credential is the one whose revocation ends the grant
    revokedAtGoogle = false;
    if (target && row.meta[MODE_KEY] !== "simulated") {
      try {
        revokedAtGoogle = (await revokeToken(target, tokenHttp(), gmailLiveConfigured() ? gmailClientCreds() : undefined)).revoked;
      } catch {
        revokedAtGoogle = false; // reported; the local clear still happens
      }
    }
  }
  await revokeConnection(tenantId, row.id);
  if (row.meta[MODE_KEY] === "simulated") simulatedMailboxes.clear(userId);
  return { disconnected: true, revokedAtGoogle, connectionId: row.id, mode };
}

// ───────────────────────────────────────────── 4 · a live access token ─────────────────────────────────────────────

/** True when a token expiring at `expiresAt` must be refreshed first (inside the 5-minute window). `now` is injectable for tests. */
export function needsRefresh(expiresAt: string | null, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - now <= REFRESH_WITHIN_MS;
}

class NeedsReconnect extends Error {}

/** A usable access token for the person's row, refreshing first when it is inside the window (or `force`). A refusal by Google's token
 *  endpoint (4xx: `invalid_grant`) marks the row needs-reconnect and throws NeedsReconnect; an outage (network, 5xx) throws
 *  `gmail_unavailable` WITHOUT marking it, since the grant may be fine. */
async function liveToken(tenantId: string, row: GmailRow, force = false): Promise<{ accessToken: string; expiresAt: string | null }> {
  const { access, refresh } = readSecrets(row);
  if (!force && access && !needsRefresh(row.token_expires_at)) return { accessToken: access, expiresAt: row.token_expires_at };
  if (!refresh) {
    await markNeedsReconnect(tenantId, row);
    throw new NeedsReconnect();
  }
  let fresh: TokenResponse;
  try {
    fresh = await refreshAccessToken(refresh, tokenHttp(), gmailClientCreds());
  } catch (e) {
    if (e instanceof GoogleTokenEndpointError) {
      const st = Number(e.detail?.httpStatus ?? 0);
      if (st >= 400 && st < 500) {
        await markNeedsReconnect(tenantId, row);
        throw new NeedsReconnect();
      }
      throw unavailable();
    }
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured();
    throw e;
  }
  await setConnectionTokens(tenantId, row.id, { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, tokenExpiresAt: fresh.expiresAt });
  return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
}

// ───────────────────────────────────────────── 5 · the mailbox, opened for one call ─────────────────────────────────────────────

/** Opens the caller's OWN mailbox and runs `run` against it. The owner is `userId`, which the controller takes from the authenticated
 *  principal. `gate` runs once, after the connection checks and before anything is sent anywhere (the send limiter hangs here, so a person
 *  with no connection gets 409, not a rate-limit answer). A seam error becomes §48's refusal; a Gmail 401 earns exactly one forced refresh
 *  and one retry, and a second 401 (or a revoked grant) marks the row needs-reconnect. */
async function withMailbox<T>(
  tenantId: string,
  userId: string,
  run: (client: GmailClient) => Promise<T>,
  gate?: () => void,
): Promise<{ mode: GmailMode; value: T }> {
  const mode = gmailMode();
  const row = await loadOwnRow(tenantId, userId);
  if (!linkedFor(row, mode)) throw notConnected();
  if (flagged(row)) throw needsReconnect();
  gate?.();

  if (mode === "simulated") {
    const client = simulatedMailboxes.clientFor(userId, row.external_account ?? simulatedAccount(userId));
    try {
      return { mode, value: await run(client) };
    } catch (e) {
      throw mapClientError(e);
    }
  }

  if (!gmailLiveConfigured()) throw notConfigured();
  let tok: { accessToken: string; expiresAt: string | null };
  try {
    tok = await liveToken(tenantId, row);
  } catch (e) {
    if (e instanceof NeedsReconnect) throw needsReconnect();
    throw e;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return { mode, value: await run(createGmailApiClient({ accessToken: tok.accessToken, fetchImpl: gmailHttp() })) };
    } catch (e) {
      if (e instanceof GmailUnauthorizedError && attempt < 1) {
        try {
          tok = await liveToken(tenantId, row, true);
        } catch (re) {
          if (re instanceof NeedsReconnect) throw needsReconnect();
          throw re;
        }
        continue;
      }
      if (e instanceof GmailUnauthorizedError || e instanceof GmailRevokedError) {
        await markNeedsReconnect(tenantId, row);
        throw needsReconnect();
      }
      throw mapClientError(e);
    }
  }
}

// ───────────────────────────────────────────── 6 · read (render on demand, cache nothing) ─────────────────────────────────────────────

const PAGE_TOKEN_SHAPE = /^[\x21-\x7e]{1,512}$/;
const THREAD_ID_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

export const isThreadId = (v: unknown): v is string => typeof v === "string" && THREAD_ID_SHAPE.test(v);
export const isPageToken = (v: unknown): v is string => typeof v === "string" && PAGE_TOKEN_SHAPE.test(v);
export const isListLabel = (v: unknown): v is GmailListLabel => typeof v === "string" && (LIST_LABELS as readonly string[]).includes(v);

export interface ThreadRow {
  id: string;
  snippet: string;
  subject: string;
  from: string;
  lastMessageDate: string;
  unread: boolean;
}
export interface ThreadListAnswer {
  mode: GmailMode;
  threads: ThreadRow[];
  nextPageToken: string | null;
}

/** One page of the person's own threads, as list rows. The subject and sender come from each thread's last message (one read per row);
 *  nothing is cached, so the next call reads again. */
export async function listThreadsAnswer(
  tenantId: string,
  userId: string,
  args: { label: GmailListLabel; pageToken?: string },
): Promise<ThreadListAnswer> {
  const { mode, value } = await withMailbox(tenantId, userId, async (client) => {
    const page = await client.listThreads(args.pageToken, { label: args.label });
    const threads = await Promise.all(
      page.threads.map(async (t): Promise<ThreadRow> => {
        const lastId = t.messageIds[t.messageIds.length - 1];
        const last = lastId ? await client.getMessage(lastId) : null;
        return {
          id: t.id,
          snippet: sanitizeInboundHeaderText(t.snippet, 200) ?? "",
          subject: sanitizeInboundHeaderText(last?.headers.subject, 300) ?? "",
          from: sanitizeInboundHeaderText(last?.headers.from, 320) ?? "",
          lastMessageDate: t.lastMessageDate,
          unread: t.labelIds.includes("UNREAD"),
        };
      }),
    );
    return { threads, nextPageToken: page.nextPageToken ?? null };
  });
  return { mode, ...value };
}

export interface MessageView {
  id: string;
  threadId: string;
  labelIds: string[];
  from: string;
  to: string;
  cc: string | null;
  subject: string;
  date: string;
  inReplyTo: string | null;
  /** The plain-text part, control characters removed. */
  text: string | null;
  /** The HTML part through the mail module's allowlist sanitizer (the UI still shows it in a `sandbox=""` iframe). */
  html: string | null;
  /** Metadata only: attachment bytes are never fetched. */
  attachments: Array<{ attachmentId: string; filename: string; mimeType: string; sizeBytes: number }>;
}
export interface ThreadAnswer {
  mode: GmailMode;
  id: string;
  labelIds: string[];
  messages: MessageView[];
}

function viewOf(m: GmailMessage): MessageView {
  const text = m.parts.find((p) => p.mimeType === "text/plain");
  const html = m.parts.find((p) => p.mimeType === "text/html");
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds,
    from: sanitizeInboundHeaderText(m.headers.from, 320) ?? "",
    to: sanitizeInboundHeaderText(m.headers.to, 2000) ?? "",
    cc: sanitizeInboundHeaderText(m.headers.cc, 2000),
    subject: sanitizeInboundHeaderText(m.headers.subject, 300) ?? "",
    date: m.headers.date,
    inReplyTo: sanitizeInboundHeaderText(m.headers.inReplyTo, 512),
    text: text ? sanitizeInboundText(text.body).text : null,
    html: html ? sanitizeInboundHtml(html.body) : null,
    attachments: m.attachments.map((a) => ({ attachmentId: a.attachmentId, filename: sanitizeInboundHeaderText(a.filename, 255) ?? "", mimeType: a.mimeType, sizeBytes: a.sizeBytes })),
  };
}

/** One thread of the person's own mailbox, every message decoded through `getMessage`. */
export async function threadAnswer(tenantId: string, userId: string, threadId: string): Promise<ThreadAnswer> {
  const { mode, value } = await withMailbox(tenantId, userId, async (client) => {
    const thread = await client.getThread(threadId);
    const messages = await Promise.all(thread.messages.map((m) => client.getMessage(m.id)));
    return { id: thread.id, labelIds: thread.labelIds, messages: messages.map(viewOf) };
  });
  return { mode, ...value };
}

// ───────────────────────────────────────────── 7 · send ─────────────────────────────────────────────

/** A well-formed outgoing message from a request body, or the 400 `gmail_send_invalid` naming the field. Pure (no I/O): the controller
 *  calls it AFTER authorising, so validation never pre-empts a 403. */
export function parseSendRequest(body: unknown): GmailSendRequest {
  try {
    return validateSendRequest(body);
  } catch (e) {
    throw mapClientError(e);
  }
}

export interface SendAnswer {
  mode: GmailMode;
  messageId: string;
  threadId: string;
}

/** Sends as the caller. The connection is checked first (409), then the per-person limit (429 `gmail_send_rate_limited` with the wait),
 *  then the one call. A rejected attempt (validation, no connection) does not count against the limit; an attempt that reaches the
 *  client does, whether or not Gmail accepts it: a runaway script that keeps failing is exactly what the guard is for. */
export async function sendAnswer(tenantId: string, userId: string, req: GmailSendRequest): Promise<SendAnswer> {
  const { mode, value } = await withMailbox(
    tenantId,
    userId,
    (client) => client.sendMessage(req),
    () => {
      const d = sendLimiter.consume(userId);
      if (!d.ok) {
        throw gmailError(429, "gmail_send_rate_limited", "too many emails sent from this account in the last hour; wait and try again.", {
          retryAfterSeconds: d.retryAfterSeconds,
        });
      }
    },
  );
  return { mode, messageId: value.messageId, threadId: value.threadId };
}
