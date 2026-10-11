"use client";
import { useEffect, useRef, type ReactNode } from "react";
import "./content.css";
import "./media.css";

/**
 * A modal dialog for the media library (the picker and the delete confirmation).
 *
 * A native <dialog> + `showModal()`, as `ConflictDialog` does: focus is trapped inside it, Escape closes it and the rest of
 * the page is inert, with no dependency. Two things are added here because the picker is opened from a field in a long form:
 *   * on close, focus returns to the element that opened it (the browser does this too, but it is done explicitly so it also
 *     holds where `showModal` is missing, as in jsdom, and when the opener re-rendered while the dialog was open);
 *   * Escape and the backdrop route through `onClose`, so the owner decides (a dialog with an upload running can refuse).
 * Where `showModal` is missing it falls back to the `open` attribute, so the component stays testable.
 */
export function MediaDialog({
  open, onClose, labelledBy, wide = false, testId, children,
}: {
  open: boolean;
  onClose: () => void;
  /** id of the element naming the dialog (its heading). */
  labelledBy: string;
  wide?: boolean;
  testId?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
      const back = opener.current;
      opener.current = null;
      if (back && back.isConnected) back.focus();
    }
  }, [open]);

  // Closing by unmount (the owner removed the dialog while open) must still give focus back.
  useEffect(() => () => {
    const back = opener.current;
    if (back && back.isConnected) back.focus();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`wc-dialog wm-dialog${wide ? " wm-dialog--wide" : ""}`}
      aria-labelledby={labelledBy}
      data-testid={testId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && <div className="wc-dialog__inner wm-dialog__inner">{children}</div>}
    </dialog>
  );
}
