// WAHA session-lifecycle admin client (create/start/status/QR/stop/logout/restart).
// Separate from WahaGateway (messaging) in waha.ts, but the same conventions: base URL +
// X-Api-Key header. Operates ONLY on the configured session (config.wahaSession) — no
// function here takes a session name from a caller, so the ERP admin plane can never
// reach across to another WAHA session on this instance (see design doc §2.1).
//
// Engine-tolerant: WAHA status strings pass through verbatim (STOPPED|STARTING|
// SCAN_QR_CODE|WORKING|FAILED|…) — never enumerated-and-rejected. Every function
// degrades to a status/qr result rather than throwing, so route handlers never need to
// wrap these in try/catch.
import { config } from "./config";
import { setSelfJid, observeStatus } from "./session-state";

export interface SessionStatus {
  session: string;
  status: string;
  engine: string | null;
  me: { id: string; pushName?: string } | null;
}

export interface QrResult {
  /** data:image/png;base64,... or null when no QR is currently available (e.g. already
   *  paired, or the session hasn't reached SCAN_QR_CODE yet) — never an error. */
  qr: string | null;
  status: string;
}

function baseUrl(): string {
  return config.wahaUrl;
}

function session(): string {
  return config.wahaSession;
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h["Content-Type"] = "application/json";
  if (config.wahaApiKey) h["X-Api-Key"] = config.wahaApiKey;
  return h;
}

async function safeJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function engineOf(data: any): string | null {
  const e = data?.engine;
  if (!e) return null;
  return typeof e === "string" ? e : (e.engine ?? null);
}

function meOf(data: any): { id: string; pushName?: string } | null {
  const me = data?.me;
  if (!me?.id) return null;
  return { id: String(me.id), ...(me.pushName ? { pushName: String(me.pushName) } : {}) };
}

/** GET the configured session's current status from WAHA. Never throws — a network
 *  failure or a 404 (session never created) reports honestly rather than erroring. */
export async function getSessionStatus(): Promise<SessionStatus> {
  const s = session();
  try {
    const res = await fetch(`${baseUrl()}/api/sessions/${encodeURIComponent(s)}`, { headers: headers(false) });
    if (!res.ok) {
      const status = res.status === 404 ? "STOPPED" : "unreachable";
      observeStatus(status);
      return { session: s, status, engine: null, me: null };
    }
    const data = await safeJson(res);
    const status = String(data?.status ?? "unknown");
    // Feed every REST read into the timeline. WAHA's `session.status` webhook only fires on a
    // CHANGE, so without this a session that was already WORKING before the bot booted is never
    // recorded at all. De-duplicated inside observeStatus, so polling can't spam the ring.
    observeStatus(status);
    return { session: s, status, engine: engineOf(data), me: meOf(data) };
  } catch {
    observeStatus("unreachable");
    return { session: s, status: "unreachable", engine: null, me: null };
  }
}

/** Best-effort refresh of the bot's own JID (session `me`) into session-state, so real WhatsApp
 *  @mentions of the bot (which tag its JID, not the text "@bot") trigger a reply. Called at boot
 *  and when the session reaches WORKING; clears the JID if the session isn't paired. Never throws. */
export async function refreshSelfJid(): Promise<string | null> {
  const jid = (await getSessionStatus()).me?.id ?? null;
  setSelfJid(jid);
  return jid;
}

/** Create-or-start the configured session with the NOWEB store body (store MUST be
 *  enabled at creation time or chats/contacts stay invisible on the Baileys engine).
 *  On 409/422 ("already exists") falls back to POST /api/sessions/{s}/start. */
export async function startSession(): Promise<SessionStatus> {
  const s = session();
  try {
    const createRes = await fetch(`${baseUrl()}/api/sessions`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify({
        name: s,
        start: true,
        config: { noweb: { store: { enabled: true, fullSync: false } } },
      }),
    });
    if (!createRes.ok && (createRes.status === 409 || createRes.status === 422)) {
      await fetch(`${baseUrl()}/api/sessions/${encodeURIComponent(s)}/start`, {
        method: "POST",
        headers: headers(false),
      });
    }
  } catch {
    // Network failure: fall through to the status read below, which reports the true
    // post-attempt state (e.g. "unreachable") instead of fabricating success.
  }
  return getSessionStatus();
}

/** Stop the session (keeps auth; no re-scan needed on the next start). */
export async function stopSession(): Promise<SessionStatus> {
  const s = session();
  try {
    await fetch(`${baseUrl()}/api/sessions/${encodeURIComponent(s)}/stop`, { method: "POST", headers: headers(false) });
  } catch {
    // status read below reports reality
  }
  return getSessionStatus();
}

/** Logout (unpairs the number — the next start needs a fresh QR scan). */
export async function logoutSession(): Promise<SessionStatus> {
  const s = session();
  try {
    await fetch(`${baseUrl()}/api/sessions/${encodeURIComponent(s)}/logout`, { method: "POST", headers: headers(false) });
  } catch {
    // status read below reports reality
  }
  return getSessionStatus();
}

/** Restart; falls back to stop -> start when the /restart route is absent on this image
 *  (404/405) or unreachable. */
export async function restartSession(): Promise<SessionStatus> {
  const s = session();
  try {
    const res = await fetch(`${baseUrl()}/api/sessions/${encodeURIComponent(s)}/restart`, {
      method: "POST",
      headers: headers(false),
    });
    if (!res.ok && (res.status === 404 || res.status === 405)) {
      await stopSession();
      await startSession();
    }
  } catch {
    try {
      await stopSession();
      await startSession();
    } catch {
      // status read below reports reality
    }
  }
  return getSessionStatus();
}

/** QR pairing image as a base64 data URL. When the session is already paired or hasn't
 *  reached SCAN_QR_CODE yet, WAHA's QR endpoint 4xxs — that maps to {qr:null,status},
 *  never an error, with `status` reflecting the session's actual current state. */
export async function getQr(): Promise<QrResult> {
  const s = session();
  try {
    const res = await fetch(`${baseUrl()}/api/${encodeURIComponent(s)}/auth/qr?format=image`, {
      headers: headers(false),
    });
    if (!res.ok) {
      const st = await getSessionStatus();
      return { qr: null, status: st.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const st = await getSessionStatus();
    return { qr: `data:image/png;base64,${buf.toString("base64")}`, status: st.status };
  } catch {
    return { qr: null, status: "unreachable" };
  }
}
