"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import type { PaletteEntry } from "@/lib/palette";
import "./command-palette.css";

// The command palette (Cmd/Ctrl-K) — UI redesign §4. Hand-rolled, no dependency: an ARIA combobox
// (§4.4) built from a text input (`role="combobox"`) + a `role="listbox"` results list, tracked with
// `aria-activedescendant` rather than moving real DOM focus into the list (so the single input stays
// the one focusable control the whole time it's open — the simplest correct focus trap for this
// shape, matching §4.3's "same scrim, same focus trap" without a second bespoke trap implementation).
//
// Tiers 1+2 (`entries`) are server-computed props — same request that renders the sidebar, per
// §4.1/§4.2, so typing filters them with zero network cost. Tier 3 (live records) is the one
// keystroke-driven network read and goes through `/api/search/palette` (single-egress route
// handler) — see that file's header for why this needs no new backend contract.
//
// Opens two ways, both funnelled through the same state here: the global Cmd/Ctrl-K listener
// (mounted once, same scope as AssistantFab per §4.3), and a `gaiada:palette:open` DOM event any
// trigger button elsewhere in the shell (TopBar's visible affordance) can dispatch without needing
// React context across the server/client boundary — the same "attribute/event on a shared ancestor"
// idiom NavToggle already uses for the mobile drawer.
interface PaletteOption { id: string; label: string; sublabel?: string; href?: string }
interface PaletteGroup { label: string; options: PaletteOption[] }

interface LiveSearchHit { label: string; sublabel?: string; href?: string }
interface LiveSearchGroup { key: string; label: string; hits: LiveSearchHit[] }

const DEBOUNCE_MS = 220;
const STATIC_LIMIT = 8;

export function CommandPalette({ entries }: { entries: PaletteEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [liveGroups, setLiveGroups] = useState<PaletteGroup[]>([]);
  const [liveLoading, setLiveLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const listboxId = useId();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        triggerRef.current = document.activeElement as HTMLElement | null;
        setOpen(true);
      }
    }
    function onOpenEvent() {
      triggerRef.current = document.activeElement as HTMLElement | null;
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("gaiada:palette:open", onOpenEvent);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("gaiada:palette:open", onOpenEvent);
    };
  }, []);

  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
    setQuery("");
    setLiveGroups([]);
    setActiveId(null);
    const trigger = triggerRef.current;
    if (trigger && document.contains(trigger)) trigger.focus();
  }, [open]);

  function close() {
    setOpen(false);
  }

  // Tier 3: debounced live search. Skipped entirely under 2 characters — matches globalSearch's own
  // floor (lib/search.ts), so the palette never fires a request the route would just no-op anyway.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setLiveGroups([]);
      setLiveLoading(false);
      return;
    }
    let cancelled = false;
    setLiveLoading(true);
    const timer = window.setTimeout(() => {
      fetch(`/api/search/palette?q=${encodeURIComponent(q)}`)
        .then((res) => (res.ok ? res.json() : { groups: [] }))
        .then((data: { groups: LiveSearchGroup[] }) => {
          if (cancelled) return;
          setLiveGroups(
            (data.groups ?? []).map((g) => ({
              label: g.label,
              options: g.hits.map((h, i) => ({ id: `live:${g.key}:${i}`, label: h.label, sublabel: h.sublabel, href: h.href })),
            })),
          );
        })
        .catch(() => { if (!cancelled) setLiveGroups([]); })
        .finally(() => { if (!cancelled) setLiveLoading(false); });
    }, DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, open]);

  const q = query.trim().toLowerCase();
  const staticGroups = useMemo<PaletteGroup[]>(() => {
    const matches = q ? entries.filter((e) => e.label.toLowerCase().includes(q)) : entries;
    const bySection = new Map<string, PaletteOption[]>();
    for (const e of matches.slice(0, 40)) {
      const arr = bySection.get(e.section) ?? [];
      if (arr.length < STATIC_LIMIT) arr.push({ id: e.id, label: e.label, href: e.href });
      bySection.set(e.section, arr);
    }
    return [...bySection.entries()].map(([label, options]) => ({ label, options }));
  }, [entries, q]);

  const groups: PaletteGroup[] = q.length >= 2 ? [...staticGroups, ...liveGroups] : staticGroups;
  const flatOptions = useMemo(() => groups.flatMap((g) => g.options), [groups]);

  useEffect(() => {
    if (flatOptions.length === 0) { setActiveId(null); return; }
    if (!flatOptions.some((o) => o.id === activeId)) setActiveId(flatOptions[0].id);
  }, [flatOptions, activeId]);

  function move(delta: number) {
    if (flatOptions.length === 0) return;
    const at = flatOptions.findIndex((o) => o.id === activeId);
    const next = flatOptions[(at + delta + flatOptions.length) % flatOptions.length];
    setActiveId(next.id);
    // jsdom (unit tests) has no layout engine and doesn't implement scrollIntoView at all.
    document.getElementById(`cmdk-opt-${next.id}`)?.scrollIntoView?.({ block: "nearest" });
  }

  function commit(id: string | null) {
    const opt = flatOptions.find((o) => o.id === id);
    if (!opt?.href) return;
    close();
    router.push(opt.href);
  }

  function onInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") { e.preventDefault(); commit(activeId); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { e.preventDefault(); } // single-field dialog — nothing else to tab to
  }

  if (!open) return null;

  return (
    <div
      className="cmdk-scrim"
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk__field">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-haspopup="listbox"
            aria-autocomplete="list"
            aria-activedescendant={activeId ? `cmdk-opt-${activeId}` : undefined}
            autoComplete="off"
            className="cmdk__input"
            placeholder="Search pages, departments, records…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
          />
          <kbd className="cmdk__esc">Esc</kbd>
        </div>
        <ul className="cmdk__list" role="listbox" id={listboxId} aria-label="Results">
          {flatOptions.length === 0 && (
            <li className="cmdk__empty" role="presentation">
              {liveLoading ? "Searching…" : q.length >= 2 ? "No matches." : "Type to search pages, departments and records."}
            </li>
          )}
          {groups.map((g) =>
            g.options.length === 0 ? null : (
              <li key={g.label} role="presentation" className="cmdk__group">
                <div className="cmdk__group-label" role="presentation">{g.label}</div>
                <ul role="presentation" className="cmdk__group-list">
                  {g.options.map((o) => (
                    <li
                      key={o.id}
                      id={`cmdk-opt-${o.id}`}
                      role="option"
                      aria-selected={activeId === o.id}
                      className={`cmdk__opt${activeId === o.id ? " cmdk__opt--active" : ""}`}
                      onMouseEnter={() => setActiveId(o.id)}
                      onMouseDown={(e) => { e.preventDefault(); commit(o.id); }}
                    >
                      <span className="cmdk__opt-label">{o.label}</span>
                      {o.sublabel && <span className="cmdk__opt-sub">{o.sublabel}</span>}
                    </li>
                  ))}
                </ul>
              </li>
            ),
          )}
        </ul>
      </div>
    </div>
  );
}
