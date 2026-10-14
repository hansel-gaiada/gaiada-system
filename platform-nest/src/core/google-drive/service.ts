// DW-6i (docs/FRONTEND-BFF-CONTRACT.md §42) — Google Drive: connect, pick and attach. The persistence and flow half; the routes and
// every authorisation are in google-drive.controller.ts. Google sits behind ONE seam (`setDriveHttpForTests`): the shared token
// client (core/google-oauth/token-endpoint-client.ts) and the Drive client (./client.ts) are both handed the same `fetch`, so a test
// stubs Google at `fetch` and still runs every line of both clients.
//
// ── THE VAULT IS THE EXISTING ONE ────────────────────────────────────────────────────────────────
// Tokens are sealed in `integration_connections` through `createConnection` / `setConnectionTokens` (core/integrations.service.ts):
// AES-256-GCM at rest, `token_key_version` stamped, the masked `ConnectionResponse` the only shape that ever leaves. ONE row per
// person (`owner_kind='user'`, `owner_id`=the person, provider `google_drive`): the table's UNIQUE (tenant, owner_kind, owner_id,
// provider) is what makes "the manual row is upgraded in place" true. The only plaintext reads are `readSecrets` below, which hands
// a string straight to a token-endpoint call or an Authorization header and nowhere else.
//
// ── WHERE A TOKEN CAN GO ─────────────────────────────────────────────────────────────────────────
//   * the ACCESS token: out in exactly one HTTP response, `pickerAnswer` (the Picker runs in the browser and needs it, §42.4);
//     otherwise only into Drive's `Authorization` header (./client.ts);
//   * the REFRESH token: never out of this process; only into the token endpoint's request body;
//   * the ID token: read once in `completeConnect` for the account's email, then dropped (never stored, never returned);
//   * never a log line, an error message, an activity row or `meta`. Errors here carry a token string like `drive_needs_reconnect`
//     and fixed prose; DriveApiError and GoogleTokenEndpointError carry a kind and a status, by construction.
import { HttpException } from "@nestjs/common";
import type { PoolClient } from "pg";
import { config, googleDriveConfigured } from "../../config";
import { withTenants } from "../../db";
import { decryptSecret } from "../secret-box";
import {
  createConnection, patchConnection, revokeConnection, setConnectionTokens, type ConnectionResponse,
} from "../integrations.service";
import {
  GoogleOAuthNotConfiguredError, GoogleOAuthStateError, GoogleTokenEndpointError,
} from "../google-oauth/errors";
import { googleSurfaceFor } from "../google-oauth/registry";
import {
  attachConnectionToState, consumeAuthorizationState, createAuthorizationState, parseStateToken, type ConsumedAuthorizationState,
} from "../google-oauth/state";
import {
  buildAuthorizeUrl, exchangeAuthorizationCode, refreshAccessToken, revokeToken,
  type FetchImpl, type OAuthClientCredentials, type TokenResponse,
} from "../google-oauth/token-endpoint-client";
import { IdTokenError, readGoogleIdentity, type GoogleIdentity } from "../google-oauth/id-token";
import { insertReferenceFile, type ReferenceFileRow } from "../file-reference";
import { DriveApiError, getDriveFile, isDriveFileId, type DriveFile, type FetchLike } from "./client";
import { DRIVE_FILE_SCOPE, GOOGLE_DRIVE_SURFACE, registerGoogleDriveSurface } from "./surface";

export const DRIVE_PROVIDER = "google_drive";
/** §42.4: the access token is refreshed first when it expires within five minutes. */
export const REFRESH_WITHIN_MS = 5 * 60 * 1000;
/** §42.5: the files route checks `targetType` against a list of one. */
export const ATTACH_TARGET_TYPES = ["task"] as const;

// ───────────────────────────────────────────── errors ─────────────────────────────────────────────

/** A refusal with its token at the START of `message` (the error filter turns `message` into `{ error }`), repeated in `reason`. */
export function driveError(status: number, token: string, text: string): HttpException {
  return new HttpException({ message: `${token}: ${text}`, reason: token }, status);
}
export const notConfigured = () =>
  driveError(503, "drive_not_configured", "Google Drive is not set up for this ERP yet (the Drive OAuth client and the Picker key are not configured).");
const notConnected = () => driveError(409, "drive_not_connected", "Google Drive is not connected for this account; connect it first.");
const needsReconnect = () => driveError(409, "drive_needs_reconnect", "Google Drive refused this account's access; reconnect Google Drive.");
const unavailable = (why = "Google Drive could not be reached; try again shortly.") => driveError(502, "drive_unavailable", why);

// ───────────────────────────────────────────── the Google seam ─────────────────────────────────────────────

let httpOverride: FetchImpl | null = null;
/** TEST ONLY: the `fetch` every Google call here goes through. Null restores the real one. */
export function setDriveHttpForTests(f: FetchImpl | null): void {
  httpOverride = f;
}
const tokenHttp = (): FetchImpl | undefined => httpOverride ?? undefined;
const driveHttp = (): FetchLike | undefined => (httpOverride ?? undefined) as FetchLike | undefined;

function driveClientCreds(): OAuthClientCredentials {
  return { clientId: config.googleDrive.clientId, clientSecret: config.googleDrive.clientSecret };
}
function surface() {
  // Registered at import (surface.ts); re-registered if a test reset the registry, so the surface is the single source of truth.
  return googleSurfaceFor(DRIVE_PROVIDER) ?? (registerGoogleDriveSurface(), GOOGLE_DRIVE_SURFACE);
}

// ───────────────────────────────────────────── the person's row ─────────────────────────────────────────────

interface DriveRow {
  id: string;
  status: string;
  external_account: string | null;
  scopes: string[];
  meta: Record<string, unknown>;
  token_expires_at: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
}
const NEEDS_RECONNECT_FLAG = "driveNeedsReconnect";

/** The caller's OWN google_drive row (live, not deleted), or null. Tenant-scoped; the owner is the caller, never a parameter. */
async function loadOwnRow(tenantId: string, userId: string): Promise<DriveRow | null> {
  const r = await withTenants([tenantId], (c: PoolClient) =>
    c.query<DriveRow>(
      `SELECT id, status, external_account, scopes, meta, token_expires_at, access_token_enc, refresh_token_enc
         FROM integration_connections
        WHERE owner_kind = 'user' AND owner_id = $1 AND provider = $2 AND deleted_at IS NULL`,
      [userId, DRIVE_PROVIDER],
    ),
  );
  const row = r.rows[0] ?? null;
  if (!row) return null;
  // node-pg hands a timestamptz back as a Date (no type parser is registered); the rest of this file wants an ISO string.
  const exp = row.token_expires_at as unknown as string | Date | null;
  return {
    ...row, meta: row.meta ?? {}, scopes: row.scopes ?? [],
    token_expires_at: exp ? new Date(exp).toISOString() : null,
  };
}

const flagged = (row: DriveRow) => row.meta[NEEDS_RECONNECT_FLAG] === true;
/** Linked with an access token, and not flagged: the row a Picker or attach can use. */
const usable = (row: DriveRow | null): row is DriveRow => !!row && row.status !== "revoked" && !!row.access_token_enc;

function readSecrets(row: DriveRow): { access: string | null; refresh: string | null } {
  return {
    access: row.access_token_enc ? decryptSecret(row.access_token_enc) : null,
    refresh: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : null,
  };
}

/** Marks the row "needs reconnect": status `error` (the vault's own state for a credential that stopped working) plus a flag in
 *  `meta`, so the UI can say "Reconnect". The tokens are NOT destroyed: a read path must not be able to shred a credential.
 *  Best effort: the refusal being reported must still propagate if this write fails. */
async function markNeedsReconnect(tenantId: string, row: DriveRow): Promise<void> {
  try {
    await patchConnection(tenantId, row.id, { status: "error", meta: { ...row.meta, [NEEDS_RECONNECT_FLAG]: true } });
  } catch {
    /* secondary-failure template: the primary outcome is the refusal */
  }
}

// ───────────────────────────────────────────── 1 · start ─────────────────────────────────────────────

/** Mints the signed, single-use state row and returns Google's consent URL (`access_type=offline`, `prompt=consent`, so a refresh
 *  token comes back). Fails CLOSED first: any of the five settings missing is `drive_not_configured` before any write. */
export async function startConnect(tenantId: string, userId: string): Promise<{ authUrl: string }> {
  if (!googleDriveConfigured()) throw notConfigured();
  const s = surface();
  const d = config.googleDrive;
  try {
    const state = await createAuthorizationState({
      tenantId, ownerKind: s.ownerKind, ownerId: userId, module: s.module, provider: "google_drive",
      redirectUri: d.redirectUri, scopes: s.scopes, authorizeUrl: config.google.authorizeUrl, createdBy: userId,
    });
    const authUrl = buildAuthorizeUrl({
      scopes: s.scopes, state: state.stateToken, codeChallenge: state.codeChallenge, redirectUri: d.redirectUri,
      client: driveClientCreds(),
    });
    return { authUrl };
  } catch (e) {
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured(); // the vault key is unset: same deployment state
    throw e;
  }
}

// ───────────────────────────────────────────── 2 · callback ─────────────────────────────────────────────

export type CompleteOutcome =
  | { status: "connected"; accountEmail: string; connectionId: string }
  | { status: "denied"; reason: "drive_consent_denied" };

/** The tenant id inside a state token, verified (signature only; nothing is consumed). 400 `drive_state_invalid` when it does not
 *  verify. The controller needs it to run the surface's Cerbos check BEFORE the state is spent. */
export function verifiedStateTenant(stateToken: string): string {
  try {
    return parseStateToken(stateToken).tenantId;
  } catch (e) {
    if (e instanceof GoogleOAuthStateError) throw stateInvalid();
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured();
    throw e;
  }
}
const stateInvalid = () =>
  driveError(400, "drive_state_invalid", "the Google Drive connection could not be verified; start connecting again.");
const exchangeFailed = () =>
  driveError(502, "drive_exchange_failed", "Google did not complete the Drive connection; start connecting again.");

/** Spends the state (single use), exchanges the code, reads the account email from the ID token, and seals the tokens in the
 *  person's single `google_drive` row (upgrading a manual row in place). The caller is the principal who started the flow; the
 *  tenant and the person come ONLY from the verified state. */
export async function completeConnect(args: {
  stateToken: string;
  code: string;
  principalUserId: string;
}): Promise<CompleteOutcome> {
  if (!googleDriveConfigured()) throw notConfigured();
  const d = config.googleDrive;
  const s = surface();

  let state: ConsumedAuthorizationState;
  try {
    state = await consumeAuthorizationState(args.stateToken, {
      redirectUri: d.redirectUri, principalUserId: args.principalUserId, provider: "google_drive", module: s.module,
    });
  } catch (e) {
    if (e instanceof GoogleOAuthStateError) throw stateInvalid();
    if (e instanceof GoogleOAuthNotConfiguredError) throw notConfigured();
    throw e;
  }
  // The row must describe a person's OWN connection, and that person must be the caller: defence in depth over the
  // `created_by` check inside consume (a state minted for someone else's row can never seal into it).
  if (state.ownerKind !== "user" || state.ownerId !== args.principalUserId) throw stateInvalid();
  const tenantId = state.tenantId;

  let tokens: TokenResponse;
  try {
    tokens = await exchangeAuthorizationCode(
      { code: args.code, codeVerifier: state.codeVerifier, redirectUri: state.redirectUri, client: driveClientCreds() },
      tokenHttp(),
    );
  } catch (e) {
    if (e instanceof GoogleTokenEndpointError || e instanceof GoogleOAuthNotConfiguredError) throw exchangeFailed();
    throw e;
  }

  // Granular consent: the person can untick Drive access on Google's screen and still grant `email`. That token cannot power the
  // Picker, so it is not stored; it is the same outcome as pressing Cancel.
  const granted = tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : state.scopes;
  if (!granted.includes(DRIVE_FILE_SCOPE)) return { status: "denied", reason: "drive_consent_denied" };

  let identity: GoogleIdentity;
  try {
    if (!tokens.idToken) throw new IdTokenError("malformed");
    identity = readGoogleIdentity(tokens.idToken, d.clientId);
  } catch (e) {
    if (e instanceof IdTokenError) throw exchangeFailed();
    throw e;
  }

  const existing = await loadOwnRow(tenantId, state.ownerId);
  const priorMeta = { ...(existing?.meta ?? {}) };
  delete priorMeta[NEEDS_RECONNECT_FLAG];
  const mapping = await createConnection(tenantId, {
    ownerKind: "user",
    ownerId: state.ownerId,
    provider: DRIVE_PROVIDER,
    externalAccount: identity.email,
    scopes: granted,
    meta: {
      ...priorMeta,
      googleIssuerHost: state.issuerHost,
      googleIssuerIsGoogle: !state.simulated,
      googleLinkedAt: new Date().toISOString(),
      googleSub: identity.sub,
      googleEmailVerified: identity.emailVerified,
    },
    createdBy: state.createdBy,
  });
  const sealed: ConnectionResponse = await setConnectionTokens(tenantId, mapping.id, {
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

/** Revokes at Google (best effort, the result is REPORTED, never fatal: forgetting a credential must not wait on a remote
 *  endpoint), then clears the sealed tokens (soft revoke: status `revoked`, tokens nulled, the row kept). Attachments already
 *  made stay: they are links. `disconnected:false` when there was nothing to clear. */
export async function disconnect(
  tenantId: string,
  userId: string,
): Promise<{ disconnected: boolean; revokedAtGoogle: boolean | null; connectionId: string | null }> {
  const row = await loadOwnRow(tenantId, userId);
  if (!row || (!row.access_token_enc && !row.refresh_token_enc)) {
    return { disconnected: false, revokedAtGoogle: null, connectionId: row?.id ?? null };
  }
  const { access, refresh } = readSecrets(row);
  const target = refresh ?? access; // the long-lived credential is the one whose revocation ends the grant
  let revokedAtGoogle = false;
  if (target) {
    try {
      revokedAtGoogle = (await revokeToken(target, tokenHttp(), googleDriveConfiguredCreds())).revoked;
    } catch {
      revokedAtGoogle = false; // reported below; the local clear still happens
    }
  }
  await revokeConnection(tenantId, row.id);
  return { disconnected: true, revokedAtGoogle, connectionId: row.id };
}
/** Credentials for the revoke call, which only needs them on a non-Google (dev issuer) endpoint. Undefined when unset. */
function googleDriveConfiguredCreds(): OAuthClientCredentials | undefined {
  const d = config.googleDrive;
  return d.clientId && d.clientSecret ? driveClientCreds() : undefined;
}

// ───────────────────────────────────────────── 4 · a live access token ─────────────────────────────────────────────

/** True when a token expiring at `expiresAt` must be refreshed first (inside the 5-minute window). No recorded expiry means
 *  nothing to pre-empt: a 401 from Drive is then the signal. `now` is injectable for tests. */
export function needsRefresh(expiresAt: string | null, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - now <= REFRESH_WITHIN_MS;
}

class NeedsReconnect extends Error {}

/** A usable access token for the person's row, refreshing first when it is inside the window (or `force`). A refusal by Google's
 *  token endpoint (4xx: `invalid_grant`, a revoked or expired grant) marks the row needs-reconnect and throws NeedsReconnect; an
 *  outage (network, 5xx) throws `drive_unavailable` WITHOUT marking it, since the grant may be fine. */
async function liveToken(
  tenantId: string,
  row: DriveRow,
  force = false,
): Promise<{ accessToken: string; expiresAt: string | null }> {
  const { access, refresh } = readSecrets(row);
  if (!force && access && !needsRefresh(row.token_expires_at)) return { accessToken: access, expiresAt: row.token_expires_at };
  if (!refresh) {
    await markNeedsReconnect(tenantId, row);
    throw new NeedsReconnect();
  }
  let fresh: TokenResponse;
  try {
    fresh = await refreshAccessToken(refresh, tokenHttp(), driveClientCreds());
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
  // Rotation: a NEW refresh token is stored when one arrives; none keeps the existing one (setConnectionTokens COALESCEs).
  await setConnectionTokens(tenantId, row.id, {
    accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, tokenExpiresAt: fresh.expiresAt,
  });
  return { accessToken: fresh.accessToken, expiresAt: fresh.expiresAt };
}

// ───────────────────────────────────────────── 5 · pick ─────────────────────────────────────────────

export interface PickerAnswer {
  configured: boolean;
  connected: boolean;
  /** Additive to §42.4 (see §42.8): true when the connection exists but Google refused it, so the UI shows "Reconnect". */
  needsReconnect: boolean;
  accountEmail: string | null;
  /** The ONE secret any Drive route returns: a short-lived `drive.file` access token, only when connected and live. */
  accessToken: string | null;
  expiresAt: string | null;
  apiKey: string | null;
  appId: string | null;
}
const EMPTY_PICKER: PickerAnswer = {
  configured: false, connected: false, needsReconnect: false, accountEmail: null, accessToken: null, expiresAt: null, apiKey: null, appId: null,
};

/** The Picker read, for the caller only (§42.4). Never throws for "not configured", "not connected" or "needs reconnect": those
 *  are answers the UI renders. A token-endpoint outage is `502 drive_unavailable`. */
export async function pickerAnswer(tenantId: string, userId: string): Promise<PickerAnswer> {
  if (!googleDriveConfigured()) return { ...EMPTY_PICKER };
  const row = await loadOwnRow(tenantId, userId);
  const base: PickerAnswer = { ...EMPTY_PICKER, configured: true };
  if (!row || row.status === "revoked" || (!row.access_token_enc && !row.refresh_token_enc)) return base;
  if (flagged(row)) return { ...base, needsReconnect: true, accountEmail: row.external_account };
  try {
    const t = await liveToken(tenantId, row);
    return {
      ...base, connected: true, accountEmail: row.external_account, accessToken: t.accessToken, expiresAt: t.expiresAt,
      apiKey: config.googleDrive.pickerApiKey, appId: config.googleDrive.pickerAppId,
    };
  } catch (e) {
    if (e instanceof NeedsReconnect) return { ...base, needsReconnect: true, accountEmail: row.external_account };
    throw e;
  }
}

// ───────────────────────────────────────────── 6 · attach ─────────────────────────────────────────────

export const isFileId = isDriveFileId;

/** The task must exist in this tenant: another tenant's task (RLS hides it), a deleted one or an unknown id is `target_not_found`. */
export async function taskExists(tenantId: string, taskId: string): Promise<boolean> {
  const r = await withTenants([tenantId], (c) =>
    c.query(`SELECT 1 FROM tasks WHERE id = $1 AND deleted_at IS NULL`, [taskId]),
  );
  return r.rows.length > 0;
}

/** Reads the file's metadata from Drive with the person's own token (proving they can reach it) and writes the reference row
 *  through the SAME path `POST /files` uses. The caller has authorised and validated the target and the file id. */
export async function attachDriveFile(args: {
  tenantId: string;
  userId: string;
  targetType: (typeof ATTACH_TARGET_TYPES)[number];
  targetId: string;
  fileId: string;
}): Promise<ReferenceFileRow> {
  if (!googleDriveConfigured()) throw notConfigured();
  const row = await loadOwnRow(args.tenantId, args.userId);
  if (!usable(row)) throw notConnected();
  if (flagged(row)) throw needsReconnect();

  let file: DriveFile;
  try {
    file = await readDriveFile(args.tenantId, row, args.fileId);
  } catch (e) {
    if (e instanceof NeedsReconnect) throw needsReconnect();
    throw e;
  }

  const out = await insertReferenceFile({
    tenantId: args.tenantId,
    uploaderId: args.userId,
    targetType: args.targetType,
    targetId: args.targetId,
    filename: file.name.slice(0, 255) || file.id,
    contentType: file.mimeType,
    url: file.webViewLink,
    rejectDuplicateUrl: true,
    activityExtra: { source: "google_drive", driveFileId: file.id },
  });
  if (out.duplicate) {
    throw driveError(409, "drive_already_attached", "this Google Drive file is already attached to this task.");
  }
  return out.file;
}

/** `files.get` with the person's token. A 401 earns exactly one forced refresh and one retry (the token may have been revoked or
 *  rotated since we stored it); a second 401 marks the row needs-reconnect. Maps Drive's refusals to §42.5's tokens. */
async function readDriveFile(tenantId: string, row: DriveRow, fileId: string): Promise<DriveFile> {
  let tok = await liveToken(tenantId, row);
  for (let attempt = 0; ; attempt++) {
    try {
      return await getDriveFile(tok.accessToken, fileId, driveHttp());
    } catch (e) {
      if (!(e instanceof DriveApiError)) throw e;
      if (e.kind === "not_found") throw driveError(404, "drive_file_not_found", "Google Drive has no file this account can reach with that id.");
      if (e.kind === "unavailable") throw unavailable();
      // kind === "auth"
      if (attempt >= 1) {
        await markNeedsReconnect(tenantId, row);
        throw new NeedsReconnect();
      }
      tok = await liveToken(tenantId, row, true);
    }
  }
}
