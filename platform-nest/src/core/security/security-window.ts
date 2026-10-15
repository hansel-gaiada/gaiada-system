// DW-7h (FRONTEND-BFF-CONTRACT §52.6) — the `window` query parameter of the IT security reads. Pure.
export type SecurityWindow = "15m" | "24h" | "7d";

export const WINDOW_MS: Record<SecurityWindow, number> = {
  "15m": 15 * 60_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};

export type WindowCheck = { ok: true; window: SecurityWindow } | { ok: false; allowed: readonly SecurityWindow[] };

/** Absent or empty is the default (`24h`). Anything else must be one of `allowed`: a typo is a 400, never a silent default,
 *  because "last 7 days" quietly answered as "last 24 hours" is a security view lying about its range. */
export function parseWindow(
  raw: unknown,
  allowed: readonly SecurityWindow[] = ["15m", "24h", "7d"],
  fallback: SecurityWindow = "24h",
): WindowCheck {
  if (raw === undefined || raw === null || raw === "") return { ok: true, window: fallback };
  if (typeof raw === "string" && (allowed as readonly string[]).includes(raw)) return { ok: true, window: raw as SecurityWindow };
  return { ok: false, allowed };
}
