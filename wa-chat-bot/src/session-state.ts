// In-memory tracker for the WAHA session's lifecycle: last-known status + a bounded ring
// buffer of recent transitions. Fed by the normalized "session" event (gateway/events.ts,
// sourced from the WAHA `session.status` webhook); read by /admin/session/status (merged
// with the WAHA REST status) and /health. No PII — status strings + timestamps only, no
// identifiers (see design doc §2.2 / §4).
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

/** Record a session status transition. Warns (never throws) on WORKING -> FAILED|STOPPED
 *  — that's a ban/logout-style event operators need visibility into. */
export function recordSessionEvent(status: string, ts: number): void {
  if (lastStatus === "WORKING" && (status === "FAILED" || status === "STOPPED")) {
    console.warn(`[session-state] WhatsApp session WORKING -> ${status} at ${new Date(ts).toISOString()}`);
  }
  lastStatus = status;
  ring.push({ status, ts });
  if (ring.length > RING_SIZE) ring = ring.slice(-RING_SIZE);
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

/** Test-only reset — module state otherwise persists across tests within the same file. */
export function resetSessionState(): void {
  lastStatus = null;
  ring = [];
  selfJid = null;
}
