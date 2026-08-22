"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFocusTrap } from "./useFocusTrap";
import "./overlay.css";

// Generic, focus-trapped, Escape-closing, scroll-locked modal (Phase 4, NEW — §6). There was no
// true blocking/centred dialog anywhere in the app before this; confirmations were ad hoc
// (`window.confirm` or inline "are you sure" state) — this is the replacement. Shares
// `useFocusTrap` with `Drawer` rather than a third bespoke trap implementation (§7.7's rule).
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  labelledBy,
  describedBy,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  /** Rendered as the dialog's accessible name via aria-labelledby. Omit and pass `labelledBy`
   *  instead if the caller wants a custom heading element. */
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  labelledBy?: string;
  describedBy?: string;
  size?: "sm" | "md" | "lg";
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const genId = useId();
  const titleId = labelledBy ?? (title ? `${genId}-title` : undefined);

  useFocusTrap(panelRef, open, onClose);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevActive = document.activeElement as HTMLElement | null;
    // Move focus into the panel on open — same discipline AssistantDrawer/TaskDrawer already
    // established for the drawer family (§7.7).
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      // Restore focus to whatever opened the modal — a cleanup, not a `close()`-timed guess, for
      // the identical reason AssistantDrawer's own header comment gives: this runs exactly once,
      // synchronously, as part of the commit that unmounts the dialog, whichever of Escape/scrim
      // click/close button/caller-driven `open=false` triggered it.
      prevActive?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  return (
    <div className="ov-modal-layer">
      <button type="button" className="ov-scrim" aria-label="Close dialog" onClick={onClose} />
      <div
        className={`ov-modal ov-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        ref={panelRef}
      >
        {(title || !labelledBy) && title && (
          <div className="ov-modal__head">
            <h2 id={titleId} className="ov-modal__title">{title}</h2>
            <button type="button" className="ov-modal__close" onClick={onClose} aria-label="Close">✕</button>
          </div>
        )}
        <div className="ov-modal__body">{children}</div>
        {footer && <div className="ov-modal__foot">{footer}</div>}
      </div>
    </div>
  );
}
