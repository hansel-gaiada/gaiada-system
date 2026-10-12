"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { readReplayPageAction } from "@/lib/replaysActions";
import { playRecording, stopWords, unavailableWords, type PageFetcher, type PageResult, type PlayStop, type ReplayEvent } from "@/lib/replaysModel";
import "rrweb-player/dist/style.css";
import "../content/content.css";
import "./visitors.css";

// The session-replay player (M5-V6-c, design 2026-10-12 §6.3). One Play = one opening: the first page is asked for without `from`,
// the opening id it returns is kept for the whole Play and sent with every later page (lib/replaysModel.ts `playRecording`). Every page
// goes through a server action and the BFF; the browser never talks to the collector. Nothing is played until every page is in.
//
// THE REPLAYER RUNS NO SCRIPTS. Layers, outermost first:
//   1. the replayed page lives in an iframe that rrweb creates sandboxed to `allow-same-origin` ONLY (no `allow-scripts`, no
//      `allow-forms`, no `allow-popups`, no `allow-top-navigation`): the browser itself refuses to run any script in it;
//   2. `UNSAFE_replayCanvas` is passed as `false` EXPLICITLY. It is the one switch that adds `allow-scripts` to that iframe (canvas
//      replay needs it), and the recorder does not record canvas (design §6.1), so nothing needs it;
//   3. rrweb turns every recorded <script> into a <noscript> before it reaches the iframe;
//   4. the page's own CSP admits images and media only from the site's domains (lib/replaysCsp.ts).
// `insertStyleRules` is not passed: the player needs no injected rules, and a rule is the only way for us to add CSS into the replayed
// document. `liveMode`, `plugins` and `unpackFn` are not passed either: the BFF returns plain events.
//
// NO DOWNLOAD, NO EXPORT. There is no save button, no link and no copy of the events anywhere in this component: they sit in this
// closure for one Play and are dropped with it. (They did cross the wire to get here, so this is not DRM; a person with devtools can
// see the responses. Export for a rights request is a separate, audited route, not this page.)

type View =
  | { phase: "idle" }
  | { phase: "loading"; pages: number; chunks: number }
  | { phase: "playing"; chunks: number }
  | { phase: "stopped"; stop: PlayStop };

/** The replayer's config as this app uses it: pinned here so a test can assert it, and no one adds a script switch by accident. */
export const REPLAYER_PROPS = {
  autoPlay: true,
  showController: true,
  skipInactive: true,
  UNSAFE_replayCanvas: false,
} as const;

interface PlayerLike { pause?: () => void; $destroy?: () => void }

export function ReplayPlayer({ propertyId, recordingId, backHref }: { propertyId: string; recordingId: string; backHref: string }) {
  const [view, setView] = useState<View>({ phase: "idle" });
  const stage = useRef<HTMLDivElement | null>(null);
  const events = useRef<ReplayEvent[] | null>(null);
  const player = useRef<PlayerLike | null>(null);
  const run = useRef(0); // which Play is current: a stale one's results are dropped

  const teardown = useCallback(() => {
    try { player.current?.pause?.(); player.current?.$destroy?.(); } catch { /* a player that cannot be destroyed is dropped with its node */ }
    player.current = null;
    if (stage.current) stage.current.replaceChildren();
    events.current = null;
  }, []);

  useEffect(() => () => { run.current += 1; teardown(); }, [teardown]);

  const start = async () => {
    const mine = ++run.current;
    teardown();
    setView({ phase: "loading", pages: 0, chunks: 0 });
    // A server action that throws (network, a deploy mid-Play) is a failed page, said in words, not an unhandled rejection.
    const failed: PageResult = { kind: "unavailable", reason: null, message: unavailableWords(null) };
    const fetchPage: PageFetcher = (from, opening) => readReplayPageAction(propertyId, recordingId, from, opening).catch(() => failed);
    const out = await playRecording(fetchPage, {
      isCancelled: () => run.current !== mine,
      onProgress: (p) => { if (run.current === mine) setView({ phase: "loading", pages: p.pages, chunks: p.chunks }); },
    });
    if (run.current !== mine) return;
    if (out.kind !== "ready") { setView({ phase: "stopped", stop: out }); return; }
    events.current = out.events;
    setView({ phase: "playing", chunks: out.chunks });
  };

  // Mount the player once the events are in and the stage exists. rrweb-player touches `document`, so it is only ever imported here.
  useEffect(() => {
    if (view.phase !== "playing" || !events.current || !stage.current) return;
    let cancelled = false;
    const host = stage.current;
    const evs = events.current;
    (async () => {
      try {
        const { default: Player } = await import("rrweb-player");
        if (cancelled) return;
        const width = Math.max(320, Math.min(1100, Math.floor(host.clientWidth || 800)));
        const p = new Player({ target: host, props: { events: evs as never, width, height: Math.round(width * 0.6), ...REPLAYER_PROPS } });
        player.current = p as unknown as PlayerLike;
      } catch {
        if (!cancelled) setView({ phase: "stopped", stop: { kind: "unavailable", reason: null, message: "The player could not start in this browser. Reload the page and try again." } });
      }
    })();
    return () => { cancelled = true; };
  }, [view.phase]);

  const stopped = view.phase === "stopped" ? view.stop : null;
  const busy = view.phase === "loading";
  return (
    <div className="wv-player" data-testid="replay-player">
      <div className="wv-actions">
        {view.phase === "idle" ? <button type="button" className="lux-btn" onClick={start} data-testid="replay-play">Play recording</button> : null}
        {/* 409: the opening expired. "Start again" is a NEW opening (a new activity row), said so in the words above. */}
        {stopped?.kind === "not_opened" ? <button type="button" className="lux-btn" onClick={start} data-testid="replay-restart">Start again</button> : null}
        {stopped && (stopped.kind === "unavailable" || stopped.kind === "drift") ? <button type="button" className="lux-btn" onClick={start} data-testid="replay-retry">Try again</button> : null}
        <a href={backHref} className="lux-btn lux-btn--ghost lux-btn--sm" data-testid="replay-back">Back to the visitor</a>
      </div>
      {view.phase === "idle" ? (
        <p className="wv-note" data-testid="replay-idle-note">Playing writes one entry in the activity log (who, which recording, when) and nothing about what it shows. The recording is loaded in full before it plays, and is not stored or offered for download here.</p>
      ) : null}
      {busy ? <p className="wv-note" role="status" data-testid="replay-loading">Loading the recording: {view.chunks} {view.chunks === 1 ? "part" : "parts"} so far.</p> : null}
      {stopped ? <p className="wv-err" role="alert" data-testid="replay-stop">{stopWords(stopped)}</p> : null}
      <div ref={stage} className="wv-player__stage" data-testid="replay-stage" />
    </div>
  );
}
