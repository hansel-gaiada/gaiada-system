// Shared display formatters. Centralized so locale/currency/timezone handling
// lives in one place (today: en-GB + a zero-decimal-aware money formatter).
// TODO(i18n): make locale/timezone user-preference driven.

const LOCALE = "en-GB";
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
  return d.toLocaleDateString(LOCALE, { day: "2-digit", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString(LOCALE, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function hoursFromMinutes(minutes: number | null | undefined): string {
  if (!minutes) return "0h";
  return `${(minutes / 60).toFixed(1)}h`;
}
