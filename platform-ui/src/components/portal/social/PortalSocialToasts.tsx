"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { portalSocialUndo } from "@/lib/portalSocialActions";
import { UNDO_WINDOW_MS } from "@/lib/portalSocial";
import "./portalSocial.css";

// SCP-2 (BFF §63.9) — the toasts of the post approval page, and the UNDO the client has for ten seconds after a decision.
//
// One provider for the whole `/portal/social` tree (its layout mounts it), so a toast outlives the list refresh a decision causes and the move from the
// list to a post page. A toast is a polite live region (`role="status"`): it says what happened without taking focus from what the client is doing; an
// error is `role="alert"`. The Undo button is a real button with its own name, and the countdown is a bar only (the words never change under the reader).
//
// THE WINDOW is the server's: `undoUntil`. The page does not trust the client's clock to be the server's, so a time that is not within (0, 15 s] from now
// falls back to the ten seconds the contract gives, counted from the answer. A late click still meets the server's own refusal (409 `undo_window_passed`),
// which is shown in words. The server holds the staff notifications until the window has passed, and sends them only if the decision still stands.
export interface UndoTarget { decisionIds: string[]; postIds: string[]; until: number }
export interface ToastInput { message: string; undo?: UndoTarget; tone?: "info" | "error" }
interface Toast extends ToastInput { id: number }
interface Ctx { push: (t: ToastInput) => void }

const ToastContext = createContext<Ctx | null>(null);
/** The toast API. Outside the provider it is a no-op (a component rendered alone in a test or a story must not throw). */
export function useSocialToasts(): Ctx {
  return useContext(ToastContext) ?? { push: () => {} };
}

/** PURE. When an undo window ends, in epoch ms: the server's `undoUntil` when it is plausible, else ten seconds from `now`. */
export function undoDeadline(undoUntil: string | null | undefined, now: number): number {
  const t = undoUntil ? Date.parse(undoUntil) : Number.NaN;
  const left = t - now;
  return left > 0 && left <= 15_000 ? t : now + UNDO_WINDOW_MS;
}

const PLAIN_MS = 6_000;
const ERROR_MS = 10_000;

export function PortalSocialToasts({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const remove = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback((t: ToastInput) => {
    seq.current += 1;
    const id = seq.current;
    setToasts((all) => [...all, { ...t, id }]);
  }, []);
  const api = useMemo<Ctx>(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ps-toasts" role="region" aria-label="Notifications">
        {toasts.map((t) => <ToastItem key={t.id} toast={t} onDone={() => remove(t.id)} onPush={push} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDone, onPush }: { toast: Toast; onDone: () => void; onPush: (t: ToastInput) => void }) {
  const [undoing, setUndoing] = useState(false);
  // The window this toast shows, fixed when it appears (a re-render must not restart it).
  const deadline = useRef<number | null>(null);
  if (deadline.current === null) deadline.current = toast.undo ? toast.undo.until : Date.now() + (toast.tone === "error" ? ERROR_MS : PLAIN_MS);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (undoing) return;
    const ms = Math.max(0, (deadline.current as number) - Date.now());
    const timer = setTimeout(() => doneRef.current(), ms);
    return () => clearTimeout(timer);
  }, [undoing]);

  async function undo() {
    if (!toast.undo || undoing) return;
    setUndoing(true);
    const results = await Promise.all(
      toast.undo.decisionIds.map((id, i) =>
        portalSocialUndo(id, toast.undo?.postIds[i]).catch(() => ({ ok: false as const, error: "That did not work. Refresh the page and try again." })),
      ),
    );
    const failed = results.find((r) => !r.ok);
    onDone();
    onPush(failed
      ? { message: failed.error ?? "That could not be undone.", tone: "error" }
      : { message: toast.undo.decisionIds.length > 1 ? "Undone. Those posts are back with you." : "Undone. The post is back with you." });
  }

  const remaining = Math.max(0, (deadline.current as number) - Date.now());
  return (
    <div className={`ps-toast${toast.tone === "error" ? " ps-toast--error" : ""}`} role={toast.tone === "error" ? "alert" : "status"}>
      <span className="ps-toast__msg">{toast.message}</span>
      {toast.undo && (
        <button type="button" className="btn ps-btn" onClick={() => void undo()} disabled={undoing}>
          {undoing ? "Undoing…" : "Undo"}
        </button>
      )}
      <button type="button" className="ps-toast__x" onClick={onDone} aria-label="Dismiss this message">×</button>
      {toast.undo && !undoing && <span className="ps-toast__bar" aria-hidden="true" style={{ animationDuration: `${remaining}ms` }} />}
    </div>
  );
}
