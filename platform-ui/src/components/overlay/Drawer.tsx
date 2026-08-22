"use client";
import { useEffect, useRef, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";
import "./overlay.css";

// Generic edge-anchored slide-over (Phase 4, NEW — §6), generalizing the pattern
// `AssistantDrawer.tsx`/`TaskDrawer.tsx` already established (intercepting-route drawers keep
// using their own `router.back()`-driven close — this is for a NEW slide-over that isn't backed
// by a parallel route, e.g. a column-visibility or bulk-action detail panel). Same scrim, same
// focus trap, same named-trigger refocus discipline (§4.3/§7.7): pass `triggerId` for the id of
// the element that opened this drawer so focus returns there on close, exactly like
// AssistantDrawer returns focus to `asst-fab-trigger`.
export function Drawer({
  open,
  onClose,
  children,
  title,
  labelledBy,
  label,
  triggerId,
  side = "right",
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Rendered as a heading with a close button in the drawer's own bar. Omit for a caller that
   *  supplies its own header inside `children`. */
  title?: string;
  labelledBy?: string;
  label?: string;
  triggerId?: string;
  side?: "left" | "right";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, open, onClose);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (triggerId) document.getElementById(triggerId)?.focus();
    };
  }, [open, triggerId]);

  if (!open) return null;

  const hasOwnLabel = Boolean(labelledBy || label || title);

  return (
    <div className="ov-drawer-layer">
      <button type="button" className="ov-scrim" aria-label="Close panel" onClick={onClose} />
      <div
        className={`ov-drawer ov-drawer--${side}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? (title ? "ov-drawer-title" : undefined)}
        aria-label={hasOwnLabel ? undefined : (label ?? "Panel")}
        tabIndex={-1}
        ref={panelRef}
      >
        {title && (
          <div className="ov-drawer__bar">
            <h2 id="ov-drawer-title" className="ov-drawer__title">{title}</h2>
            <button type="button" className="ov-drawer__close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        )}
        <div className="ov-drawer__body">{children}</div>
      </div>
    </div>
  );
}
