// Google Drive upload — FREE personal account via an OAuth refresh token (personal Gmail can't use
// a Workspace service account / domain-wide delegation, so we use a dedicated account's own Drive +
// a shared folder). Files go INTO config.drive.folderId, inheriting that folder's team sharing.
// Resumable upload with a streamed PUT so large meeting videos don't sit in memory. No external deps.
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { config, driveConfigured } from "./config.mjs";

let cached = { token: "", exp: 0 };

async function accessToken() {
  const now = Date.now();
  if (cached.token && now < cached.exp - 60_000) return cached.token;
  const d = config.drive;
  const body = new URLSearchParams({
    client_id: d.clientId,
    client_secret: d.clientSecret,
    refresh_token: d.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`drive oauth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: now + (Number(j.expires_in ?? 3600) * 1000) };
  return cached.token;
}

/**
 * Upload a local file into the configured Drive folder. Returns { fileId, webViewLink }.
 * Uses resumable upload (single streamed PUT) — fine for large A/V files.
 */
export async function uploadToDrive(file, displayName) {
  if (!driveConfigured()) throw new Error("Drive not configured — run `npm run drive-token` and set DRIVE_* in .env");
  const token = await accessToken();
  const size = statSync(file).size;
  const name = displayName || basename(file);

  // 1) Start a resumable session with the file metadata (folder placement).
  const init = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,webViewLink", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size),
    },
    body: JSON.stringify({ name, parents: [config.drive.folderId] }),
  });
  if (!init.ok) throw new Error(`drive resumable init ${init.status}: ${(await init.text()).slice(0, 200)}`);
  const session = init.headers.get("location");
  if (!session) throw new Error("drive: no resumable session URI returned");

  // 2) Stream the bytes in one PUT (duplex half-stream — Node 20+ undici).
  const put = await fetch(session, {
    method: "PUT",
    headers: { "content-length": String(size) },
    body: createReadStream(file),
    duplex: "half",
  });
  if (!put.ok) throw new Error(`drive upload ${put.status}: ${(await put.text()).slice(0, 200)}`);
  const j = await put.json();
  const fileId = j.id;
  const webViewLink = j.webViewLink ?? (fileId ? `https://drive.google.com/file/d/${fileId}/view` : null);
  return { fileId, webViewLink };
}
