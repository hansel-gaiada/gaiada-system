// Shared display formatters. Centralized so locale/currency/timezone handling
// lives in one place (today: en-GB + a zero-decimal-aware money formatter).
// TODO(i18n): make locale/timezone user-preference driven.

const LOCALE = "en-GB";

// A FIXED display zone, not the runtime's. Server components render in the container's zone (UTC)
// while the browser re-renders in the visitor's — so any timestamp formatted without an explicit
// timeZone produces different text on each side and React bails out with hydration error #418,
// discarding the server HTML for that subtree. Reading it from a NEXT_PUBLIC_ var keeps the value
// byte-identical on both sides (inlined at build time); the default matches the operating zone the
// rest of the stack already assumes (the bot's 12:00/18:00 Asia/Singapore digests).
const DISPLAY_TZ = process.env.NEXT_PUBLIC_DISPLAY_TZ || "Asia/Singapore";
// Currencies with no minor unit (amount is NOT /100).
const ZERO_DECIMAL = new Set(["IDR", "JPY", "KRW", "VND", "CLP", "ISK"]);

// Money from MINOR units (cents) — currency-aware, unlike the old assumption.
export function formatBudget(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null) return "—";
  const cur = (currency ?? "").toUpperCase();
  const amount = ZERO_DECIMAL.has(cur) ? minor : minor / 100;
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency: cur || "USD" }).format(amount);
  } catch {
    return `${cur} ${amount.toLocaleString(LOCALE)}`.trim();
  }
}

// Money from MAJOR units (e.g. a rate of 120.00).
export function money(amount: number | null | undefined, currency = "USD"): string {
  if (amount == null) return "—";
  try {
    return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString(LOCALE)}`;
  }
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(LOCALE, { day: "2-digit", month: "short", year: "numeric", timeZone: DISPLAY_TZ });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(LOCALE, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TZ,
  });
}

/**
 * Timestamp WITH the year — for machine/ops surfaces (Systems consoles: workflow last-run,
 * execution start, egress audit, hub decisions) where "which day was this" matters and the
 * record can be months old. Same fixed zone as everything else here, so it is hydration-safe;
 * the bare `new Date(x).toLocaleString()` these call sites used before was not.
 */
export function formatTimestamp(iso: string | number | null | undefined): string {
  if (iso == null || iso === "") return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(LOCALE, {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: DISPLAY_TZ,
  });
}

export function hoursFromMinutes(minutes: number | null | undefined): string {
  if (!minutes) return "0h";
  return `${(minutes / 60).toFixed(1)}h`;
}
