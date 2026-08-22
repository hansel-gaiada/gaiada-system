"use client";
import { useState, useTransition } from "react";
import { useToastQueue } from "@/components/ToastQueue";
import { Modal } from "@/components/overlay/Modal";
import "./data.css";

// Bulk-action bar (Phase 4, NEW — §6): row-selection state lives in the caller (a client
// wrapper around `DataTable`, via its `selection` prop); this is the floating affordance that
// appears once >=1 row is selected. Per §7.2's optimistic-write contract, `run` is expected to
// return `{ok, error?}` rather than throw for an EXPECTED failure (a partial batch failure, a
// capability refusal) — an unexpected throw is still caught and reported, never left to crash
// the page. A destructive action gets a `confirm` prompt rendered through the new `Modal`
// primitive rather than `window.confirm` — the exact ad hoc pattern §6's Modal entry names as
// the defect it replaces.
export interface BulkAction {
  key: string;
  label: string;
  run: (ids: string[]) => Promise<{ ok: boolean; error?: string; succeeded?: number }>;
  /** Renders as the ghost/destructive-styled variant and asks for confirmation first. */
  danger?: boolean;
  /** Confirmation copy shown in a Modal before `run` executes. Omit for a non-destructive action
   *  that should run immediately on click. */
  confirmMessage?: string;
}

export function BulkActionBar({
  selectedIds,
  actions,
  onClear,
  itemLabel = "row",
}: {
  selectedIds: string[];
  actions: BulkAction[];
  onClear: () => void;
  itemLabel?: string;
}) {
  const { push } = useToastQueue();
  const [pending, startTransition] = useTransition();
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BulkAction | null>(null);

  if (selectedIds.length === 0) return null;

  const execute = (action: BulkAction) => {
    setRunningKey(action.key);
    startTransition(async () => {
      try {
        const result = await action.run(selectedIds);
        const count = result.succeeded ?? selectedIds.length;
        if (result.ok) {
          push({ message: `${action.label}: done for ${count} ${itemLabel}${count === 1 ? "" : "s"}.` });
          onClear();
        } else {
          push({ message: result.error ?? `${action.label} failed.`, tone: "error" });
        }
      } catch {
        push({ message: `${action.label} failed unexpectedly.`, tone: "error" });
      } finally {
        setRunningKey(null);
      }
    });
  };

  const onActionClick = (action: BulkAction) => {
    if (action.confirmMessage) setConfirming(action);
    else execute(action);
  };

  return (
    <div className="bab" role="toolbar" aria-label="Bulk actions">
      <span className="bab__count">
        {selectedIds.length} {itemLabel}{selectedIds.length === 1 ? "" : "s"} selected
      </span>
      <div className="bab__actions">
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            className={`lux-btn lux-btn--${a.danger ? "ghost" : "solid"} lux-btn--sm`}
            disabled={pending && runningKey === a.key}
            onClick={() => onActionClick(a)}
          >
            {pending && runningKey === a.key ? "Working…" : a.label}
          </button>
        ))}
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClear}>Clear</button>
      </div>

      <Modal
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title={confirming?.label}
        footer={
          <>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirming(null)}>Cancel</button>
            <button
              type="button"
              className="lux-btn lux-btn--solid lux-btn--sm"
              onClick={() => {
                const action = confirming!;
                setConfirming(null);
                execute(action);
              }}
            >
              Confirm
            </button>
          </>
        }
      >
        {confirming?.confirmMessage}
      </Modal>
    </div>
  );
}
