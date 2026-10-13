"use client";
import { useEffect, useRef } from "react";
import { THREAD_POLL_MS } from "@/lib/conversation";

// PV4-09 — keep an open thread fresh. There is no staff live channel (design decision 6), so the thread asks.
//
//   - every `intervalMs` while the page is VISIBLE;
//   - once on window focus, and once when the tab becomes visible again;
//   - NOTHING while the page is hidden: no timer is left running behind a background tab.
//
// `refresh` is read through a ref so a re-render with a new closure never restarts the timer, and a refresh that
// is still in flight is never overlapped by the next tick (a slow server must not stack requests).
export function useThreadPolling(refresh: () => Promise<void> | void, opts: { intervalMs?: number; enabled?: boolean } = {}): void {
  const { intervalMs = THREAD_POLL_MS, enabled = true } = opts;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;
    const visible = () => document.visibilityState !== "hidden";

    const tick = async () => {
      if (inFlight || !visible()) return;
      inFlight = true;
      try { await refreshRef.current(); } finally { inFlight = false; }
    };
    const start = () => { if (timer === null && visible()) timer = setInterval(() => { void tick(); }, intervalMs); };
    const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };

    const onVisibility = () => {
      if (visible()) { start(); void tick(); } else stop();
    };
    const onFocus = () => { start(); void tick(); };

    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [intervalMs, enabled]);
}
