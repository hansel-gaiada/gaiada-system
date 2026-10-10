"use client";
import { useEffect, useRef } from "react";
import { formatDateTime } from "@/lib/format";
import "./content.css";

/**
 * The 409 `version-conflict` dialog (§10): "v13 was saved by … at …" with **Load theirs** or **Save mine
 * on top**. The user's local edits are NOT touched while this is open — they live in the editor's
 * state, and the dialog only reads them. "Keep editing" closes it and leaves everything as it was.
 *
 * A native <dialog> + showModal(): focus is trapped, Escape closes it, and the rest of the page is
 * inert, all without a dependency. Where `showModal` is missing (jsdom) it falls back to the `open`
 * attribute so the component is still testable.
 */
export function ConflictDialog({
  open, headVersion, savedBy, savedAt, mineBase, canSaveOnTop, theirsProblem, busy, onSaveMine, onLoadTheirs, onKeepEditing,
}: {
  open: boolean;
  /** The version someone else saved (null when the BFF did not say). */
  headVersion: number | null;
  /** Display name (or short id) of whoever saved it; null when unknown. */
  savedBy: string | null;
  savedAt: string | null;
  /** The version the user's edits were based on. */
  mineBase: number;
  /** False when we do not know the new head version, so "save on top" cannot be addressed. */
  canSaveOnTop: boolean;
  /** Set when "theirs" could not be fetched; "Load theirs" is then unavailable. */
  theirsProblem: string | null;
  busy: boolean;
  onSaveMine: () => void;
  onLoadTheirs: () => void;
  onKeepEditing: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    } else if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="wc-dialog"
      aria-labelledby="wc-conflict-title"
      data-testid="conflict-dialog"
      onCancel={(e) => { e.preventDefault(); onKeepEditing(); }}
    >
      {open && (
        <div className="wc-dialog__inner">
          <h2 id="wc-conflict-title">Someone saved a newer version</h2>
          <p>
            <strong>{headVersion !== null ? `v${headVersion}` : "A newer version"}</strong> was saved
            {savedBy ? <> by <strong>{savedBy}</strong></> : null}
            {savedAt ? <> at {formatDateTime(savedAt)}</> : null}
            , after the v{mineBase} you started from.
          </p>
          <p>Your edits are still here and have not been lost. Choose what happens to them:</p>
          {theirsProblem && <p className="lux-field__error">Their version couldn&apos;t be loaded ({theirsProblem}), so &ldquo;Load theirs&rdquo; is unavailable.</p>}
          <div className="wc-dialog__actions">
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onKeepEditing} disabled={busy}>Keep editing</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onLoadTheirs} disabled={busy || theirsProblem !== null} data-testid="load-theirs">Load theirs (discard mine)</button>
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onSaveMine} disabled={busy || !canSaveOnTop} data-testid="save-mine">{busy ? "Saving…" : "Save mine on top"}</button>
          </div>
        </div>
      )}
    </dialog>
  );
}
