// DW-6i UI: Google Drive (docs/FRONTEND-BFF-CONTRACT.md §42). Pure and client-safe: the answer shapes as the backend sends them
// (§42.8), the normalisers that refuse a malformed answer, the URL builders for the routes, and every sentence a person reads.
// The reader is in `drive-data.ts`, the writes in `driveActions.ts`, the Google script loader in `drivePicker.ts`.
//
// THE RULE THIS FILE KEEPS: the Picker answer carries a short-lived access token. `normalizeStatus` DROPS it (the connection
// block and the attach-button gate only need the booleans and the email), and only `normalizeCredentials` keeps it, for the one
// action that opens the Picker. Nothing here logs, stores or echoes a token.

import { sanitizeReturnTo } from "./returnTo";

export const DRIVE_ATTACH_TARGET = "task" as const;

/** The status half of `GET …/google-drive/picker`: what the connection block and the attach button need. No token. */
export interface DriveStatus {
  /** The ERP has the Drive OAuth client and Picker keys. False is the normal state until DW-11 item 6. */
  configured: boolean;
  connected: boolean;
  /** The connection exists but Google refused it. `connected` is false then. */
  needsReconnect: boolean;
  accountEmail: string | null;
}

/** What the browser needs to open Google's Picker. Held in memory for the one call, never stored. */
export interface PickerCredentials {
  accessToken: string;
  apiKey: string;
  appId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The Picker answer reduced to its status (token dropped), or null when it is not the documented shape. */
export function normalizeStatus(raw: unknown): DriveStatus | null {
  if (!isObj(raw)) return null;
  if (typeof raw.configured !== "boolean" || typeof raw.connected !== "boolean") return null;
  return {
    configured: raw.configured,
    connected: raw.configured && raw.connected,
    needsReconnect: raw.configured && raw.needsReconnect === true,
    accountEmail: str(raw.accountEmail),
  };
}

/** The Picker answer's credentials, or null unless it is a connected answer carrying all three values. */
export function normalizeCredentials(raw: unknown): PickerCredentials | null {
  if (!isObj(raw) || raw.configured !== true || raw.connected !== true) return null;
  const accessToken = str(raw.accessToken);
  const apiKey = str(raw.apiKey);
  const appId = str(raw.appId);
  return accessToken && apiKey && appId ? { accessToken, apiKey, appId } : null;
}

/** The attach button is offered only when the person is connected and the feature is configured. */
export const canAttachFromDrive = (s: DriveStatus | null | undefined): boolean => !!s && s.configured && s.connected;

// ── The routes (the tenant is the caller's active company) ────────────────────────────────────────
const base = (t: string) => `/api/${encodeURIComponent(t)}/integrations/google-drive`;
export const pickerPath = (t: string): string => `${base(t)}/picker`;
export const startPath = (t: string): string => `${base(t)}/oauth/start`;
export const disconnectPath = (t: string): string => base(t);
export const attachPath = (t: string): string => `${base(t)}/attach`;
/** The tenant-agnostic backend callback. `code` and `state` are Google's own, passed through untouched. */
export const callbackPath = (code: string, state: string): string =>
  `/api/google-drive/oauth/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

/** The one fixed UI path Google redirects to: the value the owner registers as `GOOGLE_DRIVE_REDIRECT_URI` (with the ERP origin). */
export const DRIVE_CALLBACK_UI_PATH = "/api/google-drive/callback";

// ── Error tokens ──────────────────────────────────────────────────────────────────────────────────
const TOKEN_TEXT = {
  drive_not_configured: "Google Drive isn't set up for this ERP yet.",
  drive_not_connected: "Connect your Google Drive first.",
  drive_needs_reconnect: "Google no longer accepts the saved Drive connection. Reconnect Google Drive to continue.",
  drive_state_invalid: "The Google Drive connection couldn't be verified. Start connecting again.",
  drive_exchange_failed: "Google didn't complete the connection. Try connecting again.",
  drive_consent_denied: "Google Drive wasn't connected, because access was declined.",
  drive_file_not_found: "That file couldn't be found in your Google Drive, or it wasn't shared with this app when you picked it.",
  drive_unavailable: "Google Drive couldn't be reached. Try again in a moment.",
  drive_already_attached: "That file is already attached to this task.",
  target_not_found: "That task no longer exists. Reload the page.",
  unsupported_target_type: "Files can only be attached to tasks for now.",
  bad_drive_file_id: "That doesn't look like a Google Drive file. Pick it again.",
  user_required: "Sign in as a person to use Google Drive.",
} as const;

export type DriveErrorToken = keyof typeof TOKEN_TEXT;

export const isDriveErrorToken = (v: unknown): v is DriveErrorToken =>
  typeof v === "string" && Object.prototype.hasOwnProperty.call(TOKEN_TEXT, v);

/** The token a refusal carries: `reason` when it is one we know, else the one at the START of `error` (the backend's own rule). */
export function driveErrorToken(error?: string | null, reason?: string | null): DriveErrorToken | null {
  if (isDriveErrorToken(reason)) return reason;
  const lead = /^[a-z_]+/.exec((error ?? "").trim());
  return lead && isDriveErrorToken(lead[0]) ? lead[0] : null;
}

/** A refusal or failure in plain words. A 403 is a calm sentence about permission, whatever the message says. */
export function driveErrorText(e: { status?: number; error?: string | null; reason?: string | null }): string {
  if (e.status === 401) return "Your session expired. Sign in again.";
  if (e.status === 403) return "You don't have permission to do that. Ask a manager.";
  const token = driveErrorToken(e.error, e.reason);
  if (token) return TOKEN_TEXT[token];
  if (e.status === 404) return "That wasn't found. Reload the page.";
  return "That didn't work, and the reason wasn't one we recognise. Try again in a moment.";
}

// ── The OAuth landing's outcome flag ──────────────────────────────────────────────────────────────
export const DRIVE_OUTCOMES = ["connected", "denied", "error"] as const;
export type DriveOutcome = (typeof DRIVE_OUTCOMES)[number];
export const isDriveOutcome = (v: unknown): v is DriveOutcome => (DRIVE_OUTCOMES as readonly unknown[]).includes(v);

/** The calm one-line notice for the `driveOAuth` flag, or null for no flag (or one we do not know: never invented). */
export function driveOutcomeText(outcome: string | undefined | null, reason?: string | null): string | null {
  if (outcome === "connected") return "Google Drive is connected.";
  if (outcome === "denied") return TOKEN_TEXT.drive_consent_denied;
  if (outcome === "error") {
    return isDriveErrorToken(reason) ? TOKEN_TEXT[reason] : "Google Drive couldn't be connected. Try again in a moment.";
  }
  return null;
}

// ── Links ─────────────────────────────────────────────────────────────────────────────────────────
const DRIVE_HOSTS = new Set(["drive.google.com", "docs.google.com"]);

/** True for an https link on Google Drive or Google Docs (which also serves Sheets and Slides): it earns the Drive mark. */
export function isDriveUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && DRIVE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** The pending-flow cookie's value: only where to send the person back to, never a provider or a token. */
export interface DrivePending {
  returnPath: string;
}

/** Parses that cookie's value. Missing or malformed is `null`; `returnPath` always comes back through the shared return-path
 *  validator (`returnTo.ts`), so an outside target degrades to `/` and is never followed. */
export function parseDrivePending(raw: string | undefined | null): DrivePending | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { returnPath?: unknown };
    if (typeof parsed.returnPath !== "string") return null;
    return { returnPath: sanitizeReturnTo(parsed.returnPath) };
  } catch {
    return null;
  }
}
