"use server";
// DW-6i UI: the writes (and the one token read) behind Google Drive (BFF §42). The platform is the authority on every one of
// them (Cerbos: the person's own connection row; `file` create then `task` read for an attach). Every action RETURNS a value,
// never a thrown refusal, so the UI says what happened in words. The tenant is the caller's ACTIVE company, never a value from
// the browser. The Picker's access token crosses this file once, outward, to open the Picker; it is never logged or stored.
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { setDrivePending } from "./drive-pending";
import {
  DRIVE_ATTACH_TARGET, attachPath, disconnectPath, driveErrorText, normalizeCredentials, pickerPath, startPath,
  type PickerCredentials,
} from "./drive";

export type DriveResult<T> = ({ ok: true } & T) | { ok: false; error: string };

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof PlatformError) return { ok: false, error: driveErrorText({ status: e.status, error: e.message, reason: e.reason }) };
  throw e;
}

const BROKEN = { ok: false as const, error: "The platform answered in a way we couldn't read. Reload the page to see where things stand." };

/** Google's consent screen is Google's: an https URL, nothing else, is ever navigated to. */
const isHttpsUrl = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};

/** `GET oauth/start` → `{ authUrl }`. Remembers where to come back to (a path on this site only), then the caller navigates to `authUrl`. */
export async function startDriveConnectAction(returnPath: string): Promise<DriveResult<{ authUrl: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<{ authUrl?: unknown }>(startPath(c.tenant), c.userId);
    if (!isHttpsUrl(raw?.authUrl)) return BROKEN;
    await setDrivePending(returnPath);
    return { ok: true, authUrl: raw.authUrl };
  } catch (e) {
    return fail(e);
  }
}

/** `DELETE integrations/google-drive`: revokes at Google (best effort) and clears the sealed tokens. Attachments already made stay: they are links. */
export async function disconnectDriveAction(): Promise<DriveResult<object>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch<unknown>(disconnectPath(c.tenant), c.userId, { method: "DELETE" });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** A fresh Picker answer, for the click that opens the Picker. The token goes to the browser for that one call and nowhere else. */
export async function loadPickerCredentialsAction(): Promise<DriveResult<{ credentials: PickerCredentials }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const raw = await platformFetch<unknown>(pickerPath(c.tenant), c.userId);
    const credentials = normalizeCredentials(raw);
    if (credentials) return { ok: true, credentials };
    const o = (raw ?? {}) as Record<string, unknown>;
    if (o.configured === false) return { ok: false, error: driveErrorText({ error: "drive_not_configured" }) };
    if (o.needsReconnect === true) return { ok: false, error: driveErrorText({ error: "drive_needs_reconnect" }) };
    if (o.connected === false) return { ok: false, error: driveErrorText({ error: "drive_not_connected" }) };
    return BROKEN;
  } catch (e) {
    return fail(e);
  }
}

/** `POST attach` `{ targetType: "task", targetId, fileId }`: one picked file becomes a link on the task. */
export async function attachDriveFileAction(taskId: string, fileId: string): Promise<DriveResult<object>> {
  if (!taskId) return { ok: false, error: driveErrorText({ error: "target_not_found" }) };
  if (!fileId) return { ok: false, error: driveErrorText({ error: "bad_drive_file_id" }) };
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch<unknown>(attachPath(c.tenant), c.userId, {
      method: "POST",
      body: JSON.stringify({ targetType: DRIVE_ATTACH_TARGET, targetId: taskId, fileId }),
    });
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
