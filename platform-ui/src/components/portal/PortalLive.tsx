"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PortalLiveFrame } from "@/lib/portal";

// CP-5 — keeps the portal's server-rendered pages current, and shows the client which mode it is in.
//
// ── WHAT THIS COMPONENT DOES *NOT* DO ─────────────────────────────────────────────────────────────
// It never renders data from the stream. A frame is `{topic, at}` and the only reaction is
// `router.refresh()`, which re-runs the server components — and therefore the ownership-enforcing BFF
// reads — from scratch. So the realtime path adds no new place where authorization could be wrong, and
// a frame that arrived for the wrong connection costs a wasted refetch rather than a disclosure. The
// backend's portal-live.service.ts header explains why the whole design hangs off that inversion.
//
// ── POLLING IS ALWAYS ARMED ───────────────────────────────────────────────────────────────────────
// SSE fails in ways that are invisible from the client: a proxy that buffers, a corporate network that
// kills long-lived connections, a backend running without Redis. So the poll is not a fallback that
// gets switched on after a detected failure — it runs unconditionally, just at a much slower cadence
// once frames are actually arriving. "Realtime, and also correct within a minute even when realtime is
// silently broken" is the only version of this worth shipping to someone outside the company.
const LIVE_POLL_MS = 120_000;   // frames are flowing: a slow safety net for anything the map misses
const IDLE_POLL_MS = 30_000;    // no stream (poll mode, or SSE never connected)
/** Frames arrive in bursts (one write emits several events). Refreshing per frame would fire several
 *  full re-renders for one logical change. */
const DEBOUNCE_MS = 700;
/** How long without a frame or heartbeat before the indicator stops claiming to be live. Must exceed
 *  the backend's 25s heartbeat with room for one missed beat, or a healthy connection flickers. */
const STALE_AFTER_MS = 70_000;

type Mode = "connecting" | "live" | "poll";

export function PortalLive({ topics }: {
  /** Refresh only when the frame's topic is one this page actually renders. Omit to refresh on any
   *  topic (the dashboard, which shows a bit of everything). A page that ignored the filter would
   *  re-render the invoice list every time a milestone moved. */
  topics?: PortalLiveFrame["topic"][];
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("connecting");
  const [stale, setStale] = useState(false);
  const lastSeen = useRef<number>(Date.now());
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `topics` is an array literal at most call sites, so a new identity on every render. Held in a ref
  // and read inside the handler rather than listed as an effect dependency — otherwise the EventSource
  // would be torn down and rebuilt on every parent render, which is both a reconnect storm and a
  // guaranteed way to never receive anything.
  const topicsRef = useRef(topics);
  topicsRef.current = topics;

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const refresh = (): void => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        if (!closed) router.refresh();
      }, DEBOUNCE_MS);
    };

    try {
      es = new EventSource("/api/portal/stream");
    } catch {
      // Some embedded browsers have no EventSource. Polling covers it.
      setMode("poll");
    }

    if (es) {
      es.addEventListener("hello", (e) => {
        try {
          const data = JSON.parse((e as MessageEvent).data) as { mode?: string };
          setMode(data.mode === "live" ? "live" : "poll");
        } catch {
          setMode("poll");
        }
        lastSeen.current = Date.now();
        setStale(false);
      });
      es.addEventListener("change", (e) => {
        lastSeen.current = Date.now();
        setStale(false);
        let frame: PortalLiveFrame | null = null;
        try {
          frame = JSON.parse((e as MessageEvent).data) as PortalLiveFrame;
        } catch {
          frame = null;
        }
        // A malformed frame still means SOMETHING changed. Refreshing is the safe reading: the cost is
        // one redundant re-render, and the alternative (ignore it) is a page that silently stops
        // updating because of a serialisation bug at the other end.
        const wanted = topicsRef.current;
        if (!frame || !wanted || wanted.includes(frame.topic)) refresh();
      });
      // The heartbeat arrives as an SSE COMMENT (`: ping`), which EventSource does not surface as any
      // event — so `onmessage`/`change` cannot be used to detect liveness. What a comment DOES do is
      // keep the connection open, which is its actual job; liveness is inferred from the staleness
      // timer below instead. Documented because "why isn't the heartbeat handled?" is the obvious
      // question to ask of this code.
      es.onerror = () => {
        // EventSource reconnects on its own (using the backend's `retry:` hint), so this is not a
        // teardown — only a demotion of the indicator. Closing here would DISABLE the built-in
        // reconnect and strand the portal on polling for the rest of the session.
        setMode((m) => (m === "live" ? "poll" : m));
        setStale(true);
      };
    }

    // Poll cadence follows the mode, and the interval is rebuilt when it changes.
    const interval = setInterval(() => {
      if (!closed) router.refresh();
    }, mode === "live" && !stale ? LIVE_POLL_MS : IDLE_POLL_MS);

    const staleTimer = setInterval(() => {
      if (Date.now() - lastSeen.current > STALE_AFTER_MS) setStale(true);
    }, 15_000);

    // A tab in the background has its timers throttled and may have missed everything. Refreshing on
    // return is what makes "come back to the tab and the number is right" true, which is how people
    // actually use a portal they check once a day.
    const onVisible = (): void => {
      if (document.visibilityState === "visible") {
        lastSeen.current = Date.now();
        router.refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(interval);
      clearInterval(staleTimer);
      if (debounce.current) clearTimeout(debounce.current);
      es?.close();
    };
    // `mode`/`stale` are dependencies so the poll interval is rebuilt at the right cadence. That also
    // reconnects the EventSource on a mode change, which is acceptable (it happens at most a couple of
    // times per session) and is why `topics` is deliberately NOT in this list.
  }, [router, mode, stale]);

  const cls = mode === "live" && !stale ? "cp-live cp-live--on" : stale ? "cp-live cp-live--stale" : "cp-live";
  const label = mode === "connecting" ? "Connecting" : mode === "live" && !stale ? "Live" : stale ? "Reconnecting" : "Auto-refresh";
  return (
    <span className={cls} title={
      mode === "live" && !stale
        ? "This page updates the moment something changes."
        : "This page refreshes itself every 30 seconds."
    }>
      <span className="cp-live__dot" aria-hidden="true" />
      {/* aria-live=polite: a screen-reader user should learn that the connection dropped, but never be
          interrupted mid-sentence for it. */}
      <span aria-live="polite">{label}</span>
    </span>
  );
}
