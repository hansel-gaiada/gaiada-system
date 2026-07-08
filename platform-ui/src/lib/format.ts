// Shared display formatters for the business pages.

// NOTE: assumes minor units are always /100 (cents). Wrong for zero-decimal
// currencies (e.g. IDR, JPY) — TODO make this currency-aware.
export function formatBudget(minor: number | null, currency: string | null): string {
  if (minor == null) return "—";
  return `${currency ?? ""} ${(minor / 100).toFixed(2)}`.trim();
}
