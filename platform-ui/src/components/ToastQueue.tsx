"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import "./ui.css";

// Toast QUEUE (Phase 4, EXTEND per §6/§7.4) — kept in its OWN client file rather than folded
// into `ui.tsx`, which every server component in the app imports for `Card`/`Button`/
// `StatusBadge`/`statusColor` etc. `ui.tsx` has no "use client" today and must stay that way: it
// is a plain, hook-free module so those server components can render its exports directly.
// Adding React state here would force "use client" onto the whole file and turn every plain
// helper function (`statusColor`, `humanizeStatus`, `normalizeStatus`) into a client reference —
// exactly the server/client boundary trap CLAUDE.md's own risk register names as the historical
// failure mode `tsc`/vitest both miss and only `next build` catches.
//
// The existing single-instance `<Toast message={…} />` (rendered inline, conditionally, by
// whatever page mounts it — dozens of call sites) is UNCHANGED and keeps working exactly as
// before. This is additive: a NEW opt-in queue for a caller that needs more than one toast able
// to appear in sequence without clobbering (the bulk-action bar's per-action feedback, optimistic
// rollback). A caller wraps its own subtree in `ToastQueueProvider` and calls `useToastQueue()`;
// nothing changes for existing standalone `<Toast>` call sites that never touch this file.
export interface QueuedToast {
  id: string;
  message: string;
  tone?: "default" | "error";
  onUndo?: () => void;
  undoLabel?: string;
}

interface ToastQueueContextValue {
  push: (toast: Omit<QueuedToast, "id">) => string;
  dismiss: (id: string) => void;
}

const ToastQueueContext = createContext<ToastQueueContextValue | null>(null);

/** How long a toast stays before auto-dismissing. Errors linger longer — they carry more to read. */
const AUTO_DISMISS_MS = 5000;
const AUTO_DISMISS_ERROR_MS = 8000;

export function ToastQueueProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<QueuedToast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((toast: Omit<QueuedToast, "id">) => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setItems((prev) => [...prev, { ...toast, id }]);
    return id;
  }, []);

  return (
    <ToastQueueContext.Provider value={{ push, dismiss }}>
      {children}
      <ToastQueueRegion items={items} onDismiss={dismiss} />
    </ToastQueueContext.Provider>
  );
}

export function useToastQueue(): ToastQueueContextValue {
  const ctx = useContext(ToastQueueContext);
  if (!ctx) throw new Error("useToastQueue must be called within a ToastQueueProvider");
  return ctx;
}

function ToastQueueRegion({ items, onDismiss }: { items: QueuedToast[]; onDismiss: (id: string) => void }) {
  useEffect(() => {
    if (items.length === 0) return;
    const timers = items.map((t) =>
      setTimeout(() => onDismiss(t.id), t.tone === "error" ? AUTO_DISMISS_ERROR_MS : AUTO_DISMISS_MS),
    );
    return () => timers.forEach(clearTimeout);
    // Re-arming on every items change is intentional and cheap (a handful of toasts, max):
    // a newly pushed toast needs its OWN timer without resetting the ones already running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  if (items.length === 0) return null;

  return (
    // A single polite live region, not one region per toast — screen readers announce each new
    // child as it's appended. `role="status"` (not "log", per the house note that a log region
    // reads as assertive spam) — polite, queued announcements are correct for a toast queue.
    <div className="lux-toast-stack" aria-live="polite" role="status">
      {items.map((t) => (
        <div key={t.id} className={`lux-toast${t.tone === "error" ? " lux-toast--error" : ""}`}>
          <span className="lux-toast__msg">{t.message}</span>
          {t.onUndo && (
            <button type="button" className="lux-toast__undo" onClick={() => { t.onUndo!(); onDismiss(t.id); }}>
              {t.undoLabel ?? "Undo"}
            </button>
          )}
          <button type="button" className="lux-toast__dismiss" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>✕</button>
        </div>
      ))}
    </div>
  );
}
