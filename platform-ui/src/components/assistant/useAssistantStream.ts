"use client";
// ASST-07 — the SSE consumer + reducer wiring + typewriter smoother. Lifted shapes (see
// docs/blueprints/assistant-foundation.md §8's reference-implementation table):
//   - aivory's `lib/streaming.ts::streamConsoleResponse` — real SSE as an async generator, with a
//     client-side idle timeout (120s) driving an `AbortController`.
//   - aivory's `lib/agenticReducer.ts` shape — a pure reducer with guards, consumed here via
//     `streamReducer` (lib/assistant.ts). This file does not reimplement reducer logic; it only
//     feeds events into it and layers presentation-only smoothing on top (see that file's header
//     for why the split is there).
//   - aivory's `typewriterStream` — re-implemented as `useTypewriter` below rather than as a second
//     async-generator stage, because React state (not a generator) is what the render layer can
//     actually consume smoothly; see its own comment for the reasoning.
//
// Deliberately uses `fetch` + a stream reader, NOT `EventSource` (unlike the portal's realtime
// indicator): `EventSource` has no `AbortController` integration and can't be used to distinguish a
// non-2xx response from a real event stream before it starts trying to "parse" an error body as SSE.
// Both properties are load-bearing here — the idle timeout needs a controller to abort, and a 404/502
// from our own proxy (thread/message not found, backend unreachable) needs to surface as a real error
// immediately rather than EventSource's silent infinite-retry loop.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CLIENT_IDLE_TIMEOUT_MS,
  decodeAssistantEvent,
  initialStreamState,
  parseSSEBuffer,
  streamReducer,
  type ClientStreamEvent,
  type StreamState,
} from "@/lib/assistant";

export interface AssistantStreamHandle {
  events: AsyncGenerator<ClientStreamEvent>;
  abort: () => void;
}

/** Opens the stream and returns both the event generator and a way to abort it independent of the
 *  generator's own idle timer — a manual Stop click and a 120s silence both need to end the same
 *  underlying fetch, through the same AbortController, without one having to know about the other. */
export function openAssistantStream(threadId: string, messageId: string): AssistantStreamHandle {
  const controller = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleAborted = false;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAborted = true;
      controller.abort();
    }, CLIENT_IDLE_TIMEOUT_MS);
  };

  async function* run(): AsyncGenerator<ClientStreamEvent> {
    let sawTerminal = false;
    try {
      armIdleTimer();
      const url = `/api/assistant/threads/${encodeURIComponent(threadId)}/stream?messageId=${encodeURIComponent(messageId)}`;
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok || !res.body) {
        let message = `The assistant stream failed to start (${res.status}).`;
        try {
          const j = (await res.json()) as { error?: string };
          if (j?.error) message = j.error;
        } catch {
          // non-JSON error body — keep the default message.
        }
        yield { type: "error", error: message, errorKind: "client_error" };
        sawTerminal = true;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          armIdleTimer(); // any activity at all — including the final `done` chunk — resets idle.
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSSEBuffer(buffer);
          buffer = parsed.rest;
          for (const block of parsed.blocks) {
            const event = decodeAssistantEvent(block);
            if (!event) continue; // guard: malformed/unrecognised block, see lib/assistant.ts
            if (event.type === "done" || event.type === "error") sawTerminal = true;
            yield event;
            if (sawTerminal) return;
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released — nothing to do.
        }
      }

      // The connection closed with NEITHER `done` NOR `error` — the client-side analog of the
      // backend's own `abnormal_drop` (docs/FRONTEND-BFF-CONTRACT.md §18's explicit mandate: stream
      // end without `done` is an error, never a success). This is the "auto-complete when the
      // terminal event never arrives" guard, applied here (outside the pure reducer, see its header)
      // because only the consumer can observe that the TRANSPORT ended, not just that no more bytes
      // arrived in a given read.
      if (!sawTerminal) {
        yield { type: "error", error: "The connection ended before the reply finished.", errorKind: "client_abnormal_drop" };
      }
    } catch (err) {
      if (!sawTerminal) {
        const aborted = err instanceof Error && err.name === "AbortError";
        yield {
          type: "error",
          error: aborted
            ? (idleAborted ? "No response for 2 minutes — the connection was closed." : "Stopped.")
            : "A network error interrupted the reply.",
          errorKind: aborted ? (idleAborted ? "client_idle_timeout" : "stopped") : "transport_error",
        };
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  }

  return { events: run(), abort: () => controller.abort() };
}

/** Drives one thread's in-flight generation: opens the stream, folds every event through the pure
 *  `streamReducer`, and exposes a `stop()` that both tells the backend to cancel (best-effort — the
 *  caller is expected to also call the `stop` server action) and immediately aborts local reading so
 *  the UI never waits on a slow network round trip to stop showing "streaming". */
export function useAssistantStream(): {
  state: StreamState;
  start: (threadId: string, messageId: string) => void;
  stopLocal: () => void;
  reset: () => void;
} {
  const [state, setState] = useState<StreamState>(initialStreamState());
  const handleRef = useRef<AssistantStreamHandle | null>(null);
  const generationRef = useRef(0);

  const start = useCallback((threadId: string, messageId: string) => {
    handleRef.current?.abort();
    const myGeneration = ++generationRef.current;
    setState(initialStreamState());
    const handle = openAssistantStream(threadId, messageId);
    handleRef.current = handle;
    (async () => {
      for await (const event of handle.events) {
        // Guard: a stale generation (a newer send/thread-switch already started a fresh stream)
        // must never resurrect its bubble via a late-arriving event from the old one.
        if (generationRef.current !== myGeneration) return;
        setState((s) => streamReducer(s, event));
      }
    })();
  }, []);

  const stopLocal = useCallback(() => {
    handleRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    handleRef.current?.abort();
    generationRef.current++;
    setState(initialStreamState());
  }, []);

  useEffect(() => () => handleRef.current?.abort(), []);

  return { state, start, stopLocal, reset };
}

// ============================================================== Typewriter smoother (render layer) =
// Deliberately NOT the reducer's job (see lib/assistant.ts's header). `trueText` always equals the
// reducer's real, instant accumulation; this hook owns a SEPARATE, slower-revealed `display` state
// so chunky bursts (a fast local echo, or several buffered SSE blocks arriving in one `read()`) still
// paint at an even pace instead of the page "jumping" — the same problem aivory's `typewriterStream`
// solves, ported to a render-time interpolation instead of a second generator stage.
const REVEAL_CHARS_PER_TICK = 3;
const REVEAL_TICK_MS = 16;

export function useTypewriter(trueText: string): string {
  const [display, setDisplay] = useState(trueText);
  const displayRef = useRef(trueText);
  const trueRef = useRef(trueText);
  trueRef.current = trueText;
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq?.matches ?? false;
    const onChange = () => { reducedMotionRef.current = mq?.matches ?? false; };
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);

  // A new message (or a reset) makes `trueText` shorter than — or not an extension of — what's
  // already displayed. Snap instantly rather than "typing backwards", which would look broken.
  useEffect(() => {
    if (!trueText.startsWith(displayRef.current)) {
      displayRef.current = trueText;
      setDisplay(trueText);
    }
  }, [trueText]);

  useEffect(() => {
    const id = setInterval(() => {
      const target = trueRef.current;
      if (reducedMotionRef.current) {
        if (displayRef.current !== target) {
          displayRef.current = target;
          setDisplay(target);
        }
        return;
      }
      if (displayRef.current.length < target.length) {
        displayRef.current = target.slice(0, displayRef.current.length + REVEAL_CHARS_PER_TICK);
        setDisplay(displayRef.current);
      }
    }, REVEAL_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return display;
}
