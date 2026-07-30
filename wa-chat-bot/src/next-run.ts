// 1b: "next scheduled run" for GET /admin/digests — the next wall-clock occurrence of each
// digest slot's fixed hour, in the configured schedule timezone. Mirrors the cron schedule
// wired in schedule.ts's startScheduler ("0 12 * * *" / "0 18 * * *"); if that schedule ever
// changes, update SLOT_HOURS to match.
import type { Slot } from "./window";

const SLOT_HOURS: Record<Slot, number> = { noon: 12, evening: 18 };

interface ZonedParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/** What wall-clock date/time `ms` (a UTC instant) reads as inside `timeZone`. Throws on an
 *  invalid IANA zone name — callers catch that to fail soft. */
function zonedParts(ms: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    y: Number(parts.year),
    mo: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour) % 24, // h23 can render midnight as "24"
    mi: Number(parts.minute),
    s: Number(parts.second),
  };
}

/** Convert a wall-clock date+time AS SEEN IN `timeZone` to a UTC epoch ms. Two iterations
 *  converge across a DST-offset change; the vast majority of zones (incl. the Asia/Singapore
 *  default, which has no DST) resolve on the first pass. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): number {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const seen = zonedParts(guess, timeZone);
    const seenAsUtc = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s);
    const offset = seenAsUtc - guess; // ms the zone is ahead of UTC at this instant
    const next = Date.UTC(y, mo - 1, d, h, mi, s) - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** Next occurrence (today or tomorrow) of `slot`'s fixed hour in `timezone`, strictly after
 *  `now`. Returns null on an invalid timezone — fail-soft, never throws into the route. */
export function nextSlotRun(slot: Slot, now: number, timezone: string): number | null {
  try {
    const hour = SLOT_HOURS[slot];
    const p = zonedParts(now, timezone);
    let candidate = zonedToUtc(p.y, p.mo, p.d, hour, 0, 0, timezone);
    if (candidate <= now) {
      // Date.UTC correctly rolls d+1 into the next month/year — no need to re-derive parts.
      candidate = zonedToUtc(p.y, p.mo, p.d + 1, hour, 0, 0, timezone);
    }
    return candidate;
  } catch {
    return null;
  }
}

export function nextRuns(now: number, timezone: string): { noon: number | null; evening: number | null } {
  return { noon: nextSlotRun("noon", now, timezone), evening: nextSlotRun("evening", now, timezone) };
}
