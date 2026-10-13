// PV5-07 — formatting for the document print routes. Exact: works on the decimal STRING, never through a float, and
// imports nothing from React (the components and their tests use it on both sides).

// ── formatting (exact: from the decimal string, never through a float) ──────────────────────────────

/** "1234567.5" with 2 decimals -> "1,234,567.50". Amounts arrive already rounded to the currency's minor unit by the
 *  ledger, so a digit beyond it is cut, never rounded (rounding money is the ledger's job, not a template's). */
export function formatAmount(amount: string | null | undefined, minorUnit: number): string {
  if (amount === null || amount === undefined || amount === "") return "";
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) return amount;
  const [, sign, int, frac = ""] = m;
  const grouped = int.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const digits = Math.max(0, Math.min(6, minorUnit));
  const f = digits > 0 ? `.${(frac + "0".repeat(digits)).slice(0, digits)}` : "";
  return `${sign}${grouped}${f}`;
}

export function formatMoney(amount: string | null | undefined, currency: string, minorUnit: number): string {
  const a = formatAmount(amount, minorUnit);
  return a ? `${currency} ${a}` : "";
}

/** A numeric quantity or rate without trailing zeros ("12.50" -> "12.5", "11.0000" -> "11"). */
export function formatDecimal(v: string | null | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  if (!/^-?\d+(\.\d+)?$/.test(v)) return v;
  return v.includes(".") ? v.replace(/\.?0+$/, "") : v;
}

/** ISO instant -> "2026-10-13 04:05:06 UTC" (documents state their time zone). */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
