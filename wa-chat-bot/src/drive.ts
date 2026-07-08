// Governed Google Drive connector (5a.11 / D8.4). Company-data flows to Drive go through
// ONE audited, DLP-scrubbed path — never an ungoverned side door. Captures are scrubbed
// (they already are before this is called) and appended to a per-owner Drive file; every
// write is audited. Disabled until DRIVE_ACCESS_TOKEN is configured (graceful no-op).
//
// TRIAL: a caller-supplied OAuth access token (Bearer) — user provides it. Target-state:
// tokens issued/refreshed by the platform's governed connector with per-user consent.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

export interface DriveResult {
  saved: boolean;
  reason?: string;
  fileId?: string;
}

function audit(event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(config.driveAuditFile), { recursive: true });
    appendFileSync(config.driveAuditFile, JSON.stringify({ ts: Date.now(), ...event }) + "\n");
  } catch {
    /* audit best-effort; never blocks */
  }
}

export function driveEnabled(): boolean {
  return config.driveAccessToken.length > 0;
}

/**
 * Append one capture to Drive as a small text file in the configured folder. `ownerRef`
 * is a pseudonymous owner tag (never raw PII) recorded in the audit, not sent to Drive.
 * Returns a status; callers treat Drive as best-effort (the capture is already stored).
 */
export async function saveCaptureToDrive(text: string, ownerRef: string): Promise<DriveResult> {
  if (!driveEnabled()) return { saved: false, reason: "drive not configured" };
  const metadata: Record<string, unknown> = {
    name: `gaiada-capture-${Date.now()}.txt`,
    mimeType: "text/plain",
    ...(config.driveFolderId ? { parents: [config.driveFolderId] } : {}),
  };
  const boundary = "gaiada-boundary-x";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--`;
  try {
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.driveAccessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      audit({ action: "drive.save", owner: ownerRef, ok: false, status: res.status });
      return { saved: false, reason: `drive ${res.status}` };
    }
    const fileId = ((await res.json()) as { id?: string }).id;
    audit({ action: "drive.save", owner: ownerRef, ok: true, fileId });
    return { saved: true, fileId };
  } catch (err) {
    audit({ action: "drive.save", owner: ownerRef, ok: false, error: (err as Error).message });
    return { saved: false, reason: (err as Error).message };
  }
}
