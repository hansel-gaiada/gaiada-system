"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import "./overlay.css";

export interface MenuRenderState {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

// Generic trigger + positioned panel (Phase 4, NEW/unify — §6): `UserMenu`, `NewMenu` and
// `RailCategory`'s flyout are three independent outside-click + Escape + role="menu"
// implementations in `components/shell/` (out of this pass's reach — shell is frozen through
// Phase 2/3). This is the ONE shared primitive for every new call site: same
// outside-click-or-Escape-closes contract those three already use, expressed once.
export function Menu({
  trigger,
  children,
  align = "start",
  label,
  panelRole = "menu",
}: {
  trigger: (state: MenuRenderState) => ReactNode;
  children: ReactNode | ((state: MenuRenderState) => ReactNode);
  align?: "start" | "end";
  label: string;
  panelRole?: "menu" | "dialog" | "listbox";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  const toggle = () => setOpen((o) => !o);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const state: MenuRenderState = { open, toggle, close };

  return (
    <div className="ov-menu" ref={ref}>
      {trigger(state)}
      {open && (
        <div className={`ov-menu__panel ov-menu__panel--${align}`} role={panelRole} aria-label={label}>
          {typeof children === "function" ? children(state) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
  checked,
}: {
  children: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  /** Renders as a checkable item (aria-checked + a ✓ glyph) for a toggle menu, e.g. column
   *  visibility — omit for a plain command item. */
  checked?: boolean;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      className={`ov-menu__item${danger ? " ov-menu__item--danger" : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
