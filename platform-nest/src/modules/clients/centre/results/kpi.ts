// PV6-02 — small pure helpers shared by the builders: windows, the Kpi constructor, number coercion.
import type { Kpi } from "./types";

export interface DateWindow { from: string; to: string }

const DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The `days` days ending TODAY (UTC, inclusive) and the same-length window immediately before it. */
export function windows(now: Date, days: number): { current: DateWindow; previous: DateWindow } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const curFrom = today - (days - 1) * DAY;
  return {
    current: { from: iso(curFrom), to: iso(today) },
    previous: { from: iso(curFrom - days * DAY), to: iso(curFrom - DAY) },
  };
}

/** A Postgres numeric / bigint (a string over the wire) or a number, as a finite number; anything else is null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function round(n: number | null, places: number): number | null {
  if (n === null) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function kpi(
  key: string, label: string, unit: Kpi["unit"], value: number | null,
  extra: { period?: DateWindow | null; previous?: number | null; target?: number | null; asOf?: string | null } = {},
): Kpi {
  return {
    key, label, value, unit,
    period: extra.period ?? null,
    previous: extra.previous ?? null,
    target: extra.target ?? null,
    asOf: extra.asOf ?? null,
  };
}

/** `YYYY-MM-DD` of a Date or date-ish string, or null. */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** An engagement's lifecycle word, as the client reads it. `draft` is "setting up", `closed` is "ended". */
export function engagementStatus(s: string): "active" | "paused" | "setting_up" | "ended" {
  switch (s) {
    case "active": return "active";
    case "paused": return "paused";
    case "closed": return "ended";
    default: return "setting_up";
  }
}
