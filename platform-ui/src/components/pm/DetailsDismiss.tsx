"use client";
import { useEffect, useRef } from "react";

// Closes the `<details>` it is rendered inside on Escape or on a pointer press outside it.
//
// Native `<details>` only ever closes from its own summary. Inline that is fine — the panel is part
// of the page. Floating, it is not: a layer over the board that can only be dismissed by finding its
// trigger again is a papercut, and Escape is what a keyboard user will press first.
//
// Deliberately its own tiny client component rather than making `FacetFilters` one. That component is
// server-rendered by design (every chip and clear-all is a real `<a href>`, the picklist is a native
// GET form) and turning it client-side to add two listeners would put its whole option list into the
// browser bundle. This mounts INSIDE the details and walks up to it, so the disclosure itself stays
// server-rendered markup.
export function DetailsDismiss() {
  const anchor = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const details = anchor.current?.closest("details");
    if (!details) return;

    function close() {
      if (details instanceof HTMLDetailsElement && details.open) details.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      close();
      // Focus goes back to the summary, not to nowhere: dismissing a layer must not strand the
      // keyboard user at the top of the document.
      details.querySelector<HTMLElement>("summary")?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      if (!(details instanceof HTMLDetailsElement) || !details.open) return;
      // `composedPath`, not `contains(target)`: a press that starts on a checkbox label inside the
      // panel must not read as "outside" just because the event retargets.
      if (e.composedPath().includes(details)) return;
      close();
    }

    document.addEventListener("keydown", onKey);
    // Capture phase: a press on a board card navigates, and the listener has to have run first.
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);

  return <span ref={anchor} hidden aria-hidden="true" />;
}
