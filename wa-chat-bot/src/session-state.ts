// In-memory tracker for the WAHA session's lifecycle: last-known status + a bounded ring
// buffer of recent transitions. Fed by the normalized "session" event (gateway/events.ts,
// sourced from the WAHA `session.status` webhook); read by /admin/session/status (merged
// with the WAHA REST status) and /health. No PII — status strings + timestamps only, no
// identifiers (see design doc §2.2 / §4).
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import type { InboundEvent } from "./gateway/events";

export interface SessionTransition {
  status: string;
  ts: number;
}

const RING_SIZE = 20;

let lastStatus: string | null = null;
let ring: SessionTransition[] = [];
// The bot's own WhatsApp JID (e.g. "628123...@c.us"), learned from the WAHA session `me` once paired.
// Used to detect real WhatsApp @mentions of the bot (which tag this JID, NOT the literal text "@bot").
let selfJid: string | null = null;

/** Set/clear the bot's own JID (from the WAHA session `me`). Idempotent. */
export function setSelfJid(jid: string | null): void {
  selfJid = jid && jid.trim() ? jid.trim() : null;
}

/** The bot's own JID, or null until the session is paired and `me` is known. */
export function getSelfJid(): string | null {
  return selfJid;
}

/** Atomically persist the timeline (tmp + rename). Best-effort — a read-only volume degrades
 *  to in-memory-only history rather than failing the webhook/admin path that triggered it. */
function persist(): void {
  const path = config.sessionEventsFile;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ lastStatus, events: ring })}\n`, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[session-state] could not persist session events to ${path}: ${(err as Error).message}`);
  }
}

/**
 * Hydrate the timeline from disk. Called once at boot (server start) — deliberately NOT lazy,
 * so tests and one-shot processes have fully deterministic state. Missing/corrupt file = start
 * empty, which is exactly the pre-existing behavior.
 */
export function loadSessionEvents(): void {
  let raw: { lastStatus?: unknown; events?: unknown } | null = null;
  try {
    raw = JSON.parse(readFileSync(config.sessionEventsFile, "utf8"));
  } catch {
    return;
  }
  const events = Array.isArray(raw?.events) ? raw.events : [];
  ring = events
    .map((e) => ({ status: String((e as SessionTransition)?.status ?? ""), ts: Number((e as SessionTransition)?.ts) }))
    .filter((e) => e.status && Number.isFinite(e.ts))
    .slice(-RING_SIZE);
  lastStatus = typeof raw?.lastStatus === "string" ? raw.lastStatus : (ring[ring.length - 1]?.status ?? null);
}

/** Record a session status transition. Warns (never throws) on WORKING -> FAILED|STOPPED
 *  — that's a ban/logout-style event operators need visibility into. */
export function recordSessionEvent(status: string, ts: number): void {
  if (lastStatus === "WORKING" && (status === "FAILED" || status === "STOPPED")) {
    console.warn(`[session-state] WhatsApp session WORKING -> ${status} at ${new Date(ts).toISOString()}`);
  }
  lastStatus = status;
  ring.push({ status, ts });
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
  persist();
}

/**
 * Record a status we POLLED from WAHA (boot seed, or an /admin/session/status read) rather
 * than one pushed by the `session.status` webhook.
 *
 * WAHA only fires that webhook on a CHANGE, so a session that has been WORKING since before
 * the bot started emits nothing at all — leaving the timeline empty and /health "unknown".
 * Polled observations close that gap, but must be de-duplicated: only a status DIFFERENT from
 * the last known one is a real event, otherwise every ERP poll would spam the ring.
 * Returns true iff a new entry was appended.
 */
export function observeStatus(status: string, ts: number = Date.now()): boolean {
  const clean = status.trim();
  // "unreachable" is this bot's own word for "WAHA didn't answer" — it says nothing about the
  // session, so it must never overwrite a real last-known status.
  if (!clean || clean === "unreachable" || clean === "unknown" || clean === lastStatus) return false;
  recordSessionEvent(clean, ts);
  return true;
}

/** Wire a normalized InboundEvent into the tracker. No-op for anything but kind:"session". */
export function handleSessionEvent(event: InboundEvent): void {
  if (event.kind !== "session") return;
  recordSessionEvent(event.status, event.ts);
}

/** The most recent transition, or null if none has been observed yet (fresh boot). */
export function lastEvent(): SessionTransition | null {
  return ring.length ? (ring[ring.length - 1] ?? null) : null;
}

/** Last known status string for /health; "unknown" until the first event arrives. */
export function lastKnownStatus(): string {
  return lastStatus ?? "unknown";
}

/** Up to the last 20 transitions, oldest first. Returns a copy — callers can't mutate state. */
export function transitions(): SessionTransition[] {
  return [...ring];
}

/** Test-only reset — in-memory only (never re-reads the file; see loadSessionEvents). */
export function resetSessionState(): void {
  lastStatus = null;
  ring = [];
  selfJid = null;
}
