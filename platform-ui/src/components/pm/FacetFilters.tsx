import type { ReactNode } from "react";
import { Card } from "@/components/ui";
import "./pm.css";

// Shared facet-filter panel — replaces the bare checkbox lists that used to be hand-rolled
// per surface (pm/page.tsx's Board/Ball tabs, the department Board tab, the single-project
// workspace) with ONE component. Owner complaint (2026-08-10): "the current ball/responsible
// facet is a checkbox list" — findable, clearable, and showing-what's-active were all missing.
// This fixes all three at once, everywhere it's used, instead of three separate patches:
//   - findable   — a `<details>` disclosure (native, keyboard-operable) groups every facet under
//                  one labelled summary that reports how many filters are active, rather than
//                  always-open checkbox walls competing with the board/timeline for attention.
//                  It opens itself automatically when a filter is already active (bookmarked link).
//   - clearable  — each active selection renders as its own removable chip (a plain link that
//                  drops just that one value) plus a single "Clear all", so undoing one filter
//                  never means reopening the whole picklist and hunting for the checked box.
//   - active     — the chip row IS the "what's on" readout; it's the first thing rendered,
//                  above the (often collapsed) picklist.
//
// Deliberately a plain server-safe component (no "use client", no JS): every chip/clear-all is a
// real `<a href>` reconstructing the query string server-side, and the picklist itself is a native
// GET form — same "no dependency, no client state" convention every other filter in this codebase
// already follows (department board's Focus/Group-by selects, the tag-filter Cards). This is an
// upgrade to the PRESENTATION of that existing convention, not a new mechanism.
//
// `hidden` carries every OTHER query param the caller's page needs preserved across an
// Apply/chip-remove/Clear-all navigation (e.g. `view`, `swimlane`, `focus`) — the same set each
// caller used to thread through by hand as a pile of `<input type="hidden">`s.

export interface FacetOption {
  id: string;
  label: string;
  /** Optional leading swatch (e.g. a `<TagChip>` color dot) rendered before the label. */
  swatch?: ReactNode;
}

export interface FacetGroupSpec {
  /** The query param name this group reads/writes (e.g. "tags", "ball", "responsible"). */
  key: string;
  label: string;
  options: FacetOption[];
  selected: string[];
}

function buildHref(basePath: string, hidden: Record<string, string | undefined>, groupValues: Record<string, string[]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(hidden)) if (v) p.set(k, v);
  for (const [k, vals] of Object.entries(groupValues)) for (const v of vals) p.append(k, v);
  const qs = p.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export function FacetFilters({
  basePath, hidden, groups, formLabel = "Filters",
}: {
  basePath: string;
  hidden: Record<string, string | undefined>;
  groups: FacetGroupSpec[];
  formLabel?: string;
}) {
  const visibleGroups = groups.filter((g) => g.options.length > 0);
  if (visibleGroups.length === 0) return null;
  const activeCount = visibleGroups.reduce((n, g) => n + g.selected.length, 0);

  // Every group's CURRENT selection, as a plain key->values map — the shape `buildHref` wants.
  // `without` optionally drops one value from one group (a single chip's own remove-link).
  const currentValues = (without?: { key: string; value: string }): Record<string, string[]> =>
    Object.fromEntries(
      visibleGroups.map((g) => [g.key, without && g.key === without.key ? g.selected.filter((v) => v !== without.value) : g.selected]),
    );
  const clearedValues = (): Record<string, string[]> => Object.fromEntries(visibleGroups.map((g) => [g.key, []]));

  return (
    <Card style={{ marginBottom: 16 }}>
      {activeCount > 0 && (
        <div className="pm-facets__chips">
          {visibleGroups.flatMap((g) =>
            g.selected.map((id) => {
              const opt = g.options.find((o) => o.id === id);
              return (
                <a
                  key={`${g.key}:${id}`}
                  className="pm-facets__chip"
                  href={buildHref(basePath, hidden, currentValues({ key: g.key, value: id }))}
                  aria-label={`Remove filter ${g.label}: ${opt?.label ?? id}`}
                >
                  {opt?.swatch}
                  <span>{g.label}: {opt?.label ?? id}</span>
                  <span className="pm-facets__chip-x" aria-hidden>×</span>
                </a>
              );
            }),
          )}
          <a className="pm-facets__clearall" href={buildHref(basePath, hidden, clearedValues())}>Clear all</a>
        </div>
      )}

      <details className="pm-facets" open={activeCount > 0 || undefined}>
        <summary className="pm-facets__summary">
          {formLabel}{activeCount > 0 ? ` (${activeCount})` : ""}
        </summary>
        <form className="pm-facets__body" method="get" action={basePath} aria-label={formLabel}>
          {Object.entries(hidden).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          {visibleGroups.map((g) => (
            <div className="pm-tagfilter" key={g.key}>
              <span className="pm-tagfilter__label">{g.label}</span>
              <div className="pm-tagfilter__options">
                {g.options.map((o) => (
                  <label key={o.id} className="pm-tagfilter__opt">
                    <input type="checkbox" name={g.key} value={o.id} defaultChecked={g.selected.includes(o.id)} />
                    {o.swatch}
                    {o.label}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="lux-filters__actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm">Apply</button>
          </div>
        </form>
      </details>
    </Card>
  );
}
