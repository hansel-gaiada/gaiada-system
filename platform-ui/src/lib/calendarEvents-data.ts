import "server-only";
// DW-8g (BFF §47.3): the calendar-event readers. `listMyEvents` follows `lib/agenda.ts`: the cross-company envelope
// and an `unavailable` flag that is NOT the same as an empty window, so the calendar says "events couldn't be read"
// and never "no events". `getEvent` is a `ReadResult`.
import { platformFetch, PlatformError } from "./platform";
import { normalizeEnvelope, type Envelope } from "./envelope";
import type { ReadResult } from "./readResult";
import type { CalendarEventDetail, CalendarEventRow } from "./calendarEvents";

export interface ListMyEventsOptions {
  /** Window start, an ISO instant (the day's start in the display zone). */
  from: string;
  /** Window end, exclusive. At most 92 days after `from`, else the backend answers 400. */
  to: string;
  scope?: "all" | string;
}

export interface MyEventsResult {
  envelope: Envelope<CalendarEventRow>;
  /** True when the endpoint itself could not be read (not a per-company leg, which the envelope reports). */
  unavailable: boolean;
}

export async function listMyEvents(userId: string, opts: ListMyEventsOptions): Promise<MyEventsResult> {
  const p = new URLSearchParams({ from: opts.from, to: opts.to, scope: opts.scope ?? "all" });
  try {
    const raw = await platformFetch<unknown>(`/api/calendar/events/mine?${p.toString()}`, userId);
    return { envelope: normalizeEnvelope<CalendarEventRow>(raw), unavailable: false };
  } catch {
    return { envelope: { items: [], companies: [] }, unavailable: true };
  }
}

export const EVENT_NOT_FOUND = "This event doesn't exist or isn't visible to you.";

/** One event. A 404 is the backend's answer for both "no such event" and "not yours to read" (never an existence oracle),
 *  so it is one sentence. */
export async function getEvent(userId: string, tenantId: string, id: string): Promise<ReadResult<CalendarEventDetail>> {
  try {
    const data = await platformFetch<CalendarEventDetail>(`/api/${encodeURIComponent(tenantId)}/calendar/events/${encodeURIComponent(id)}`, userId);
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 404) return { kind: "unavailable", reason: EVENT_NOT_FOUND };
      if (e.status === 403) return { kind: "forbidden" };
      return { kind: "unavailable", reason: e.message };
    }
    return { kind: "unavailable", reason: (e as Error)?.message ?? "unknown error" };
  }
}
