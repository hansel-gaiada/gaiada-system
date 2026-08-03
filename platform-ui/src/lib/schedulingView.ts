// W1 — client-safe scheduling types/labels.
//
// Separate from schedulingActions.ts and from lib/meetings.ts for the reason documented in
// clientContactsView.ts: a client component may `import type` from a server-only module but a VALUE
// import drags `lib/platform.ts`'s `import "server-only"` into the client bundle. `tsc` and vitest
// both pass in that state; only `next build` catches it.
export type ParticipantSide = "internal" | "client";

export interface MeetingParticipant {
  user_id: string;
  side: ParticipantSide;
  email: string | null;
  name: string | null;
}

export const SIDE_LABEL: Record<ParticipantSide, string> = {
  internal: "Our team",
  client: "Client",
};

/** Format a scheduled time for display. Deliberately locale-formatted rather than ISO: this is read by
 *  a PM arranging a real meeting, and an ISO string is the wrong register for that. */
export function formatScheduled(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** True when a scheduled time has passed but the meeting was never started. Surfaced because a
 *  scheduled meeting that silently went by is the state a PM most needs to see — it means the capture
 *  never happened and nothing downstream will ever exist for it. */
export function isOverdue(scheduledAt: string | null, status: string): boolean {
  if (!scheduledAt || status !== "scheduled") return false;
  const t = new Date(scheduledAt).getTime();
  return Number.isFinite(t) && t < Date.now();
}

/** The local-datetime value an `<input type="datetime-local">` expects, defaulted to a sensible next
 *  slot rather than an empty field. Local, not UTC: a PM types the time they mean in their own zone,
 *  and the action converts to ISO on submit. */
export function defaultSlotValue(now: Date = new Date()): string {
  const d = new Date(now.getTime());
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
