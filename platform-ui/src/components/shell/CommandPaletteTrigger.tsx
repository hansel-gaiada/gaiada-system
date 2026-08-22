"use client";
import { Icon } from "./icons";

// The top bar's visible palette affordance (icon + "⌘K" hint, §3.2). Deliberately a SEPARATE
// control from the existing `<form action="/search">` immediately to its left, not a replacement
// of it: the spec's intent is that the palette "subsumes" the plain-text form so there is exactly
// one search entry point, but that form's input carries `aria-label="Search"` and is the target of
// a pinned e2e test (`e2e/app.spec.ts`, "global search returns cross-entity results" — types into
// it and expects a real `/search?q=` navigation on Enter). Turning that input into a palette
// launcher would make it non-editable from the keyboard's point of view, breaking that test's
// `fill()`/`press("Enter")` flow. This trigger sits alongside it instead: same keyboard shortcut
// (Cmd/Ctrl-K, global, mounted in CommandPalette itself), same destination tiers, zero regression
// risk to the existing zero-JS fallback. See the Phase 2 report for the full trade-off.
//
// No React state here on purpose — this never needs to know whether the palette is open. It just
// asks for it, the same "attribute/event on a shared ancestor" idiom NavToggle already uses.
export function CommandPaletteTrigger() {
  return (
    <button
      type="button"
      className="erp-top__cmdk"
      aria-label="Open command palette"
      onClick={() => window.dispatchEvent(new Event("gaiada:palette:open"))}
    >
      <Icon name="search" size={15} />
      <span>Jump to…</span>
      <kbd>⌘K</kbd>
    </button>
  );
}
