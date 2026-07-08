export type Slot = "noon" | "evening";

export interface Window {
  start: number;
  end: number;
}

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

/**
 * The window a digest run covers: from the previous run of this slot up to now.
 * First run (no previous) caps the lookback at 12 hours. Gap-safe: if the bot was
 * down, the persisted last-run keeps the window continuous.
 */
export function computeWindow(lastRunTs: number | undefined, now: number): Window {
  const start = lastRunTs && lastRunTs < now ? lastRunTs : now - TWELVE_HOURS;
  return { start, end: now };
}
