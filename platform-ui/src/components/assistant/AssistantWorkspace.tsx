"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantMessage, AssistantThread, PinnedPageContext } from "@/lib/assistant";
import { isPendingMessage } from "@/lib/assistant";
import { pageContextPrefix } from "@/lib/assistantContext";
import {
  createThreadAction, deleteThreadAction, refreshThreadAction, refreshThreadsAction,
  renameThreadAction, sendMessageAction, setThreadPinnedAction, setThreadStatusAction, stopStreamAction,
} from "@/lib/assistantActions";
import { ThreadRail } from "./ThreadRail";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { MemoryPanel } from "./MemoryPanel";
import { CapabilitiesPanel } from "./CapabilitiesPanel";
import { BrainPicker } from "./BrainPicker";
import { PageContextChip } from "./PageContextChip";
import { useAssistantStream } from "./useAssistantStream";
import { Toast } from "@/components/ui";
import "./assistant.css";

// ASST-07 — the whole `/assistant` page is one client component tree (not a series of navigations):
// switching threads and streaming a reply are both fundamentally "update state, don't reload",
// exactly like aivory's `useChat` being the single engine both the page and its floating mount
// consume (per docs/blueprints/assistant-foundation.md §8).
//
// ASST-22 — this component IS the `@drawer` mount now, unmodified: the intercepted route
// (`app/(app)/@drawer/(.)assistant/page.tsx`) renders this exact same tree inside `AssistantDrawer`
// chrome, passing `variant="drawer"` and a resolved `pageContext`. No second copy of the reducer,
// the stream hook, or any of `ThreadRail`/`ThreadView`/`Composer`/`MemoryPanel`/`CapabilitiesPanel`
// exists anywhere — exactly the "cheap once the page exists" claim `AivoryAssistant.tsx`/
// `AiraFloatingAssistant.tsx` prove in aivory (both consume the SAME `useChat`).
//
// ── ONE DELIBERATE PHASE-1 TRADE-OFF, WORTH STATING EXPLICITLY ──────────────────────────────────────
// Switching away from a thread that is actively streaming (or closing the tab) aborts THIS browser's
// fetch to our own proxy, which aborts the proxy's fetch to the platform, which the platform treats
// exactly like any other client disconnect (`raw.on("close")`) and cancels the generation. There is
// no "keep generating in the background while I look at another thread" in Phase 1 — the backend
// only supports one open stream reader at a time per generation, and this UI never re-attaches to an
// abandoned one. Explicit Stop and "switch away" therefore both end a generation; they are simply
// reported differently (`stopped` vs the backend's own `client_disconnected`).
//
// ── WHY THE ACTIVE THREAD ALSO LIVES IN THE URL (`?thread=<id>`) ───────────────────────────────────
// `page.tsx` is a single route (no `/assistant/[id]`), so a hard reload has to recover "which
// thread was I on" from somewhere durable. `setActiveThread` below writes it via a plain
// `history.replaceState` — deliberately NOT `router.replace`, which would re-run the server
// component (a real network round trip + flicker) on every thread switch. The URL is therefore
// read on the NEXT real navigation (page.tsx's `searchParams`), never on this one.
function setUrlThreadParam(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("thread", id);
  else url.searchParams.delete("thread");
  window.history.replaceState(null, "", url.toString());
}

export function AssistantWorkspace({ initialThreads, initialActiveThreadId, variant = "page", pageContext = null }: {
  initialThreads: AssistantThread[];
  initialActiveThreadId: string | null;
  /** "drawer" trims chrome that doesn't fit a narrow slide-over (see `assistant-drawer.css`) and
   *  renders the "Open in full page" promotion — everything ELSE (rail, streaming, memory,
   *  capabilities) behaves identically in both variants. */
  variant?: "page" | "drawer";
  /** ASST-22 — the entity the CURRENT app page resolved to, already server-verified to still exist
   *  (`resolvePageContextRef`, called by the drawer route). `null` on a page with no resolvable
   *  entity, or on the full `/assistant` page (which has no "current page" to pin against). */
  pageContext?: PinnedPageContext | null;
}) {
  const [threads, setThreads] = useState<AssistantThread[]>(initialThreads);
  // ASST-22 — the full page falls back to the most-recent thread (`initialThreads[0]`, per
  // `listThreads`' pinned-then-recent ordering) when no `?thread=` was requested — that fallback is
  // deliberately NOT applied in drawer variant: reusing an unrelated pre-existing thread would
  // silently defeat "the drawer opens with a thread pinned to THIS page's context" (the mount
  // effect below creates a fresh one instead whenever the drawer opens with no explicit thread).
  const [activeThreadId, setActiveThreadId] = useState<string | null>(
    initialActiveThreadId ?? (variant === "page" ? initialThreads[0]?.id ?? null : null),
  );
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // ASST-19 — the right-rail memory drawer (blueprint §8's collapsible "context inspector" family;
  // memory is the first panel built into it). Owned here, not inside MemoryPanel itself, because
  // the grid-column layout it drives (`.asst-workspace--with-memory`) lives on this component's
  // own root element.
  const [memoryOpen, setMemoryOpen] = useState(false);
  // ASST-18 — the capabilities panel occupies the SAME right-rail slot as memory, one at a time
  // (opening one closes the other) — a third simultaneous grid column would need its own layout
  // math the design doesn't call for; blueprint §8 lists both as members of one collapsible
  // "context inspector" family, not two independent panes.
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);

  const stream = useAssistantStream();
  const stateRef = useRef(stream.state);
  stateRef.current = stream.state;

  const toast = useCallback((msg: string) => setToastMsg(msg), []);
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToastMsg(null), 4000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  // ---- Load the active thread's transcript whenever selection changes -------------------------
  const loadThread = useCallback(async (id: string) => {
    setLoadingThread(true);
    const r = await refreshThreadAction(id);
    setLoadingThread(false);
    if (!r.ok) {
      toast(r.error);
      return;
    }
    setMessages(r.messages);
    setThreads((prev) => prev.map((t) => (t.id === id ? r.thread : t)));
  }, [toast]);

  useEffect(() => {
    if (activeThreadId) void loadThread(activeThreadId);
    // Intentionally runs once per mount for the auto-selected first thread too — the initial
    // `initialThreads` list carries no messages (list vs. detail are different backend calls).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectThread(id: string) {
    if (id === activeThreadId) return;
    stream.reset();
    setStreamingMessageId(null);
    setActiveThreadId(id);
    setUrlThreadParam(id);
    void loadThread(id);
  }

  // ---- Rail mutations (optimistic, reconciled on failure) --------------------------------------
  async function handleNew() {
    const r = await createThreadAction();
    if (!r.ok) {
      toast(r.error);
      return;
    }
    const optimistic: AssistantThread = {
      id: r.id, ownerUserId: "", title: null, brainProvider: null, brainModel: null, hermesSessionId: null,
      status: "active", pinned: false, lastMessageAt: null, totalTokens: 0, totalCostUsd: "0.00",
      compactionSummary: null, compactionSummaryUptoSeq: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setThreads((prev) => [optimistic, ...prev]);
    stream.reset();
    setStreamingMessageId(null);
    setActiveThreadId(r.id);
    setUrlThreadParam(r.id);
    setMessages([]);
  }

  // ASST-22 — the drawer hides `ThreadRail` entirely (see assistant.css's `.asst-workspace--drawer`
  // header note: a multi-thread list doesn't fit a slide-over, "Open in full page" is what that's
  // for), which also removes the ONLY affordance for starting a first thread. A first-time drawer
  // open with zero existing threads therefore auto-creates one — the full page never does this
  // (its rail's own "New chat" button is reachable there), so this is gated on `variant` alone, not
  // a change to the page's own empty-thread behaviour.
  //
  // `autoCreatedRef` is load-bearing, not defensive boilerplate: Next dev runs React 18 Strict
  // Mode, which deliberately double-invokes every mount effect (run → cleanup → run again) on the
  // SAME component instance/state to surface exactly this class of bug. `handleNew()` is NOT
  // idempotent (each call is a real `POST .../threads`) — an unguarded `useEffect(() => {
  // handleNew() }, [])` created TWO threads on every drawer open, and the SECOND call's
  // `setActiveThreadId` silently overwrote the first (whichever create request's response arrived
  // last), so the id captured for "Open in full page" could point at the empty twin instead of the
  // one the user actually chatted in — caught by this ticket's own Playwright spec, not by
  // inspection. The ref persists across Strict Mode's extra effect pass (same component instance,
  // no re-render in between), so it makes the second invocation a no-op.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (variant === "drawer" && !activeThreadId && !autoCreatedRef.current) {
      autoCreatedRef.current = true;
      void handleNew();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleRename(id: string, title: string) {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
    const r = await renameThreadAction(id, title);
    if (!r.ok) {
      toast(r.error);
      void reconcileThreads();
    }
  }

  async function handleTogglePin(id: string, pinned: boolean) {
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, pinned } : t)));
    const r = await setThreadPinnedAction(id, pinned);
    if (!r.ok) {
      toast(r.error);
      void reconcileThreads();
    }
  }

  async function handleToggleArchive(id: string, archived: boolean) {
    const status = archived ? "archived" : "active";
    setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
    const r = await setThreadStatusAction(id, status);
    if (!r.ok) {
      toast(r.error);
      void reconcileThreads();
    }
  }

  async function handleDelete(id: string) {
    const wasActive = id === activeThreadId;
    const prevThreads = threads;
    setThreads((prev) => prev.filter((t) => t.id !== id));
    const r = await deleteThreadAction(id);
    if (!r.ok) {
      toast(r.error);
      setThreads(prevThreads);
      return;
    }
    if (wasActive) {
      const next = prevThreads.find((t) => t.id !== id) ?? null;
      stream.reset();
      setStreamingMessageId(null);
      setActiveThreadId(next?.id ?? null);
      setUrlThreadParam(next?.id ?? null);
      setMessages([]);
      if (next) void loadThread(next.id);
    }
  }

  async function reconcileThreads() {
    const r = await refreshThreadsAction();
    if (r.ok) setThreads(r.items);
  }

  // ASST-16 — the active thread, for the brain picker. `patchActiveThread` is BrainPicker's own
  // optimistic-update/rollback channel (same shape as handleRename/handleTogglePin above, just
  // generalized to an arbitrary partial patch since the picker needs to set two fields at once —
  // brainProvider AND the hermesSessionId reset — atomically in local state).
  const activeThread = threads.find((t) => t.id === activeThreadId) ?? null;
  function patchActiveThread(patch: Partial<AssistantThread>) {
    if (!activeThreadId) return;
    setThreads((prev) => prev.map((t) => (t.id === activeThreadId ? { ...t, ...patch } : t)));
  }

  // ---- Send / stop --------------------------------------------------------------------------------
  const hasPendingMessage = messages.some(isPendingMessage);
  const canSend = !!activeThreadId && !loadingThread && !sending && !hasPendingMessage && stream.state.status !== "streaming";

  async function handleSend(text: string) {
    if (!activeThreadId || !canSend) return;
    setSending(true);
    const lastSeq = messages.length ? messages[messages.length - 1].seq : 0;
    // ASST-22 — the ONE place the pinned page context actually reaches the assistant: prefixed onto
    // the FIRST outgoing message of the thread only (mirrors aivory's `AivoryAssistant.tsx`
    // `contextPrefix`, applied only when `messages.length === 0`). Sent AND displayed identically
    // (never a hidden addition) — see `lib/assistantContext.ts::pageContextPrefix`'s header for why
    // this is composition over the existing `content` field rather than a new wire shape.
    const outgoing = messages.length === 0 && pageContext ? pageContextPrefix(pageContext.label, pageContext.ref) + text : text;
    const optimisticUser: AssistantMessage = {
      id: `local-user-${Date.now()}`, seq: lastSeq + 1, role: "user", content: outgoing, parts: null,
      provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    const r = await sendMessageAction(activeThreadId, outgoing);
    setSending(false);
    if (!r.ok) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id));
      toast(r.status === 409 ? "A reply is already generating for this chat." : r.error);
      return;
    }
    const placeholder: AssistantMessage = {
      id: r.messageId, seq: lastSeq + 2, role: "assistant", content: null, parts: null,
      provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, placeholder]);
    setStreamingMessageId(r.messageId);
    stream.start(activeThreadId, r.messageId);
  }

  async function handleStop() {
    if (!activeThreadId) return;
    const r = await stopStreamAction(activeThreadId);
    if (!r.ok) toast(r.error);
    // Backstop: if the open stream hasn't resolved shortly after asking the backend to stop (e.g.
    // it never reached the SSE loop yet), abort locally so the UI never hangs waiting on it.
    setTimeout(() => {
      if (stateRef.current.status === "streaming") stream.stopLocal();
    }, 4000);
  }

  // ---- Resolve the terminal outcome: refetch the authoritative transcript, then go idle ----------
  useEffect(() => {
    if (!streamingMessageId) return;
    if (stream.state.status === "done" || stream.state.status === "error" || stream.state.status === "stopped") {
      const threadId = activeThreadId;
      setStreamingMessageId(null); // guard: prevents this effect from re-firing for the same terminal event
      if (threadId) void loadThread(threadId);
      const t = setTimeout(() => stream.reset(), 1200); // brief pause so "finished"/"error" is legible before it clears
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.state.status, streamingMessageId, activeThreadId]);

  const rightRailOpen = memoryOpen || capabilitiesOpen;

  return (
    <div className={`asst-workspace${variant === "drawer" ? " asst-workspace--drawer" : ""}${rightRailOpen ? " asst-workspace--with-memory" : ""}`}>
      <ThreadRail
        threads={threads}
        activeThreadId={activeThreadId}
        busy={loadingThread}
        onSelect={selectThread}
        onNew={handleNew}
        onRename={handleRename}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleToggleArchive}
        onDelete={handleDelete}
      />
      <div className="asst-main">
        <div className="asst-main__toolbar">
          {pageContext && <PageContextChip context={pageContext} />}
          <BrainPicker
            thread={activeThread}
            disabled={stream.state.status === "streaming"}
            onChanged={patchActiveThread}
          />
          {variant === "drawer" && activeThreadId && (
            // ASST-22 — a plain `<a>`, deliberately NOT `next/link`: this route's own segment
            // (`/assistant`) is what the intercepted drawer route matches, so a client-side
            // navigation to it — including via `next/link` or `router.push` — stays intercepted and
            // the drawer never promotes. A bare anchor forces a real browser navigation, which is
            // the documented way to escape an intercepting route, and lands on the untouched
            // `app/(app)/assistant/page.tsx`, which reads `?thread=` and reselects this EXACT
            // thread — same id, and its full history loads straight from the backend (never from
            // anything this component holds in memory), so "history intact" holds even though this
            // component itself unmounts on the hard navigation.
            <a className="asst-promote-link" href={`/assistant?thread=${encodeURIComponent(activeThreadId)}`}>
              Open in full page ↗
            </a>
          )}
          <button
            type="button"
            className="asst-cap-toggle"
            aria-expanded={capabilitiesOpen}
            aria-controls="asst-capabilities-panel"
            onClick={() => {
              setCapabilitiesOpen((v) => !v);
              setMemoryOpen(false);
            }}
          >
            Capabilities
          </button>
          <button
            type="button"
            className="asst-memory-toggle"
            aria-expanded={memoryOpen}
            aria-controls="asst-memory-panel"
            onClick={() => {
              setMemoryOpen((v) => !v);
              setCapabilitiesOpen(false);
            }}
          >
            Memory
          </button>
        </div>
        <ThreadView
          messages={messages}
          streamState={stream.state}
          streamingMessageId={streamingMessageId}
          loading={loadingThread}
        />
        <Composer canSend={canSend} streaming={stream.state.status === "streaming"} onSend={handleSend} onStop={handleStop} />
      </div>
      {capabilitiesOpen && <CapabilitiesPanel onClose={() => setCapabilitiesOpen(false)} />}
      {memoryOpen && <MemoryPanel activeThreadId={activeThreadId} onClose={() => setMemoryOpen(false)} />}
      {toastMsg && <Toast message={toastMsg} />}
    </div>
  );
}
