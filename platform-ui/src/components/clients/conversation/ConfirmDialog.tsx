"use client";
import { useId, type ReactNode } from "react";
import { Modal } from "@/components/overlay/Modal";

// PV4-09 — the confirm step for the two acts that reach a client and cannot be taken back: sending an agent's
// draft, and sharing meeting minutes. It names WHO will read it (the caller passes the client's name in `title`
// or `children`), traps focus, closes on Escape and returns focus to the control that opened it (Modal).
// The confirm button carries the verb and the client's name, never a bare "OK".
export function ConfirmDialog({
  open, title, children, confirmLabel, onConfirm, onCancel, busy = false, error = null,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const descId = useId();
  return (
    <Modal open={open} onClose={() => { if (!busy) onCancel(); }} title={title} size="sm" describedBy={descId}>
      <div id={descId} style={{ display: "grid", gap: 10, font: "400 13px/1.55 var(--font-body)" }}>{children}</div>
      {error && <p className="cv-error" role="alert" style={{ marginTop: 10 }}>{error}</p>}
      <div className="cv-row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="lux-btn lux-btn--sm" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
      </div>
    </Modal>
  );
}
