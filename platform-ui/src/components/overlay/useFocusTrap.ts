"use client";
import { useEffect, type RefObject } from "react";

// The load-bearing focus-trap mechanics `AssistantDrawer.tsx`/`TaskDrawer.tsx` each hand-rolled
// once, extracted so `Drawer`/`Modal` (Phase 4, NEW per the component inventory) share ONE
// implementation instead of a third bespoke copy. Behaviour is verbatim what those two files
// already proved correct via a real Playwright run (see AssistantDrawer's own header comment):
// Escape closes, Tab/Shift+Tab wrap inside the panel rather than escaping to the page/shell
// behind the scrim. Re-queries the focusable set on every Tab press (not cached) because an
// overlay's content can change shape while open (a row expands, a field disables).
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== "Tab" || !ref.current) return;
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        // Nothing tabbable inside (a brief loading state) — keep focus pinned on the panel itself
        // rather than letting it escape to whatever sits behind the scrim.
        e.preventDefault();
        ref.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && (activeEl === first || activeEl === ref.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, ref, onEscape]);
}
