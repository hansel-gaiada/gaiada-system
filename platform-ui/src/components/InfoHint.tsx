"use client";
import { useEffect, useId, useRef, useState } from "react";
import "./hint.css";

// A "?" affordance that explains what a number actually counts.
//
// Why a button and not `title=""`: the native tooltip has a ~1s delay, is invisible to keyboard
// users, never appears on touch, and cannot be styled. This is a real control — hover, focus and
// click all open it, Escape and outside-click close it, and the panel is wired to the button with
// aria-describedby so a screen reader announces the definition instead of just "question mark".
//
// The panel is the one place in this design system allowed to float, so it carries --elev-overlay
// (the sanctioned exception to the no-shadow rule); everything else stays hairline-flat.
export function InfoHint({ label, children }: {
  /** What is being explained, e.g. "Active". Used for the accessible name — a bare "?" is useless
   *  when a page has four of them. */
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <span
      className="erp-hint"
      ref={wrap}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="erp-hint__btn"
        aria-label={`What "${label}" counts`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        ?
      </button>
      {open && (
        <span role="tooltip" id={id} className="erp-hint__panel">
          {children}
        </span>
      )}
    </span>
  );
}
