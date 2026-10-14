// Zone-aware day maths for the calendar (DW-8g). Pure, client-safe, no date library.
//
// The calendar grids are YYYY-MM-DD cells (`lib/calendar.ts`, UTC arithmetic on plain dates). An event is an
// INSTANT in UTC, so which cell it lands in depends on the zone the person reads the calendar in. That zone is
// the fixed display zone (`DISPLAY_TZ`, `NEXT_PUBLIC_DISPLAY_TZ`), never the runtime's, so the server render and
// the browser agree. Everything here takes the zone as an argument (default: the display zone) so a test can pin
// a zone with a daylight-saving change.
import { DISPLAY_TZ } from "./format";

const PART_FMT = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = PART_FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    PART_FMT.set(tz, f);
  }
  return f;
}

/** The wall-clock fields of an instant in `tz`. */
function wall(ms: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) if (p.type !== "literal") o[p.type] = Number(p.value);
  // h23 never yields 24, but a runtime that ignores hourCycle can: fold it to 0.
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** Milliseconds to ADD to a UTC instant to get the wall clock of `tz` at that instant. */
export function zoneOffsetMs(ms: number, tz: string = DISPLAY_TZ): number {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `tz`. */
export function zoneDay(instant: string | number, tz: string = DISPLAY_TZ): string {
  const w = wall(typeof instant === "number" ? instant : Date.parse(instant), tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** The wall-clock time (`HH:mm`) of an instant in `tz`. */
export function zoneTime(instant: string | number, tz: string = DISPLAY_TZ): string {
  const w = wall(typeof instant === "number" ? instant : Date.parse(instant), tz);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The UTC instant (epoch ms) at which `tz`'s wall clock reads `date` `time`. NaN for text that is not a real date
 *  or time. A wall time that does not exist (the hour skipped by a clock change) moves forward by the gap; one that
 *  happens twice takes its first occurrence. */
export function zonedToMs(date: string, time: string, tz: string = DISPLAY_TZ): number {
  const dm = DATE_RE.exec(date), tm = TIME_RE.exec(time);
  if (!dm || !tm) return NaN;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const asUtc = Date.UTC(y, mo - 1, d, Number(tm[1]), Number(tm[2]));
  // Round-trip rejects 2026-02-30, which Date.UTC rolls to March.
  if (new Date(asUtc).toISOString().slice(0, 10) !== date) return NaN;
  const off1 = zoneOffsetMs(asUtc, tz);
  const guess = asUtc - off1;
  const off2 = zoneOffsetMs(guess, tz);
  if (off1 === off2) return guess;
  // The two offsets disagree: the wall time is near a clock change. If the second offset holds at its own answer it is
  // the real one; if not, the wall time falls in the skipped hour and the first guess (which lands after the gap) stands.
  const alt = asUtc - off2;
  return zoneOffsetMs(alt, tz) === off2 ? alt : guess;
}

/** `zonedToMs` as an ISO instant (`...Z`), or null. */
export function zonedToInstant(date: string, time: string, tz: string = DISPLAY_TZ): string | null {
  const ms = zonedToMs(date, time, tz);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The instant a day begins in `tz`. */
export function dayStartMs(date: string, tz: string = DISPLAY_TZ): number {
  return zonedToMs(date, "00:00", tz);
}

const addDay = (iso: string, n: number): string => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The read window `[from, to)` (ISO instants) covering the days `firstDay` to `lastDay` inclusive, in `tz`. */
export function windowForDays(firstDay: string, lastDay: string, tz: string = DISPLAY_TZ): { from: string; to: string } {
  return {
    from: new Date(dayStartMs(firstDay, tz)).toISOString(),
    to: new Date(dayStartMs(addDay(lastDay, 1), tz)).toISOString(),
  };
}

/** The days (`YYYY-MM-DD`, in `tz`) a timed event occupies: from its start's day to the day of its last instant. An
 *  event that ends exactly at midnight does not occupy the next day. */
export function timedEventDays(startsAt: string, endsAt: string, tz: string = DISPLAY_TZ): string[] {
  const s = Date.parse(startsAt), e = Date.parse(endsAt);
  const first = zoneDay(s, tz);
  const last = e > s ? zoneDay(e - 1, tz) : first;
  const out: string[] = [];
  for (let d = first, i = 0; i < 400; i++) {
    out.push(d);
    if (d >= last) break;
    d = addDay(d, 1);
  }
  return out;
}

/** The days an all-day event occupies, both ends inclusive. */
export function allDayEventDays(startsOn: string, endsOn: string): string[] {
  const out: string[] = [];
  for (let d = startsOn, i = 0; i < 400; i++) {
    out.push(d);
    if (d >= endsOn) break;
    d = addDay(d, 1);
  }
  return out;
}
