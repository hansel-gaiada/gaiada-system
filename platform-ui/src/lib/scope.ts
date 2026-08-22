// The scope bar's state model (UI redesign §2.1/§3, "the scope axes as real controls"). Pure,
// client-safe, zero I/O: state lives entirely in the URL query string (per the hard constraint —
// no client store), so a scoped view is linkable and back/forward works for free. A page "opts in"
// by building a `ScopeAxisConfig[]` for the axes it actually supports and passing today's
// `searchParams` through; a page that builds none never renders a bar (see ScopeBar.tsx).
//
// Genuinely new axis, no prior art: "Entity" always gets an explicit default option (conventionally
// `"all"`, labelled "Whole group") rather than an unstated implied default — that IS the gap this
// whole surface exists to close (today a cross-company view is consolidated by default with no
// control surfacing that fact at all).

export interface ScopeAxisOption {
  value: string;
  label: string;
}

export interface ScopeAxisConfig {
  /** Stable React key + a11y label source — "entity" | "department" | "period" | "currency" | … */
  key: string;
  /** The query-string parameter name this axis reads/writes. */
  param: string;
  /** Shown as the axis's eyebrow in the bar. */
  label: string;
  options: ScopeAxisOption[];
  /** Explicit default value — the axis is "active" (non-default) whenever the current value differs. */
  defaultValue: string;
}

/** Next's `searchParams` shape (a plain object; a repeated key becomes an array). */
export type ScopeSearchParams = Record<string, string | string[] | undefined>;

function toStr(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** The axis's current value — the URL's value if present, else its declared default. */
export function currentAxisValue(sp: ScopeSearchParams, axis: ScopeAxisConfig): string {
  return toStr(sp[axis.param]) ?? axis.defaultValue;
}

/** True when the axis sits at its default (i.e. contributes nothing to the "N filters active" count). */
export function isAxisDefault(sp: ScopeSearchParams, axis: ScopeAxisConfig): boolean {
  return currentAxisValue(sp, axis) === axis.defaultValue;
}

/** How many of the given axes are off their default — the bar's "N filters active" badge. */
export function activeAxisCount(sp: ScopeSearchParams, axes: ScopeAxisConfig[]): number {
  return axes.filter((a) => !isAxisDefault(sp, a)).length;
}

/**
 * Builds a same-page href with `patch` applied over the current query string. A patch value of
 * `null` removes that param entirely (used for "set back to default" so the URL stays clean rather
 * than growing an explicit `?entity=all`). Every OTHER existing query param is preserved untouched
 * — the bar must never clobber page state it doesn't own (an existing filter, a pagination cursor).
 */
export function scopeHref(basePath: string, sp: ScopeSearchParams, patch: Record<string, string | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    const val = toStr(v);
    if (val != null) qs.set(k, val);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v == null) qs.delete(k);
    else qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `${basePath}?${s}` : basePath;
}

/** The href for "reset every given axis back to its default" — the bar's Reset affordance. */
export function resetScopeHref(basePath: string, sp: ScopeSearchParams, axes: ScopeAxisConfig[]): string {
  const patch: Record<string, string | null> = {};
  for (const a of axes) patch[a.param] = null;
  return scopeHref(basePath, sp, patch);
}

/** The href for setting one axis to `value` (collapses to a delete when `value` is the default). */
export function axisHref(basePath: string, sp: ScopeSearchParams, axis: ScopeAxisConfig, value: string): string {
  return scopeHref(basePath, sp, { [axis.param]: value === axis.defaultValue ? null : value });
}

/** Convenience builder for the Entity axis's required "Whole group" option (spec: always present). */
export function wholeGroupOption(label = "Whole group"): ScopeAxisOption {
  return { value: "all", label };
}
