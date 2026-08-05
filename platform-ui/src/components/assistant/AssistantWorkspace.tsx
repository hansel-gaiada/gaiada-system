"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantMessage, AssistantThread } from "@/lib/assistant";
import { isPendingMessage } from "@/lib/assistant";
import {
  createThreadAction, deleteThreadAction, refreshThreadAction, refreshThreadsAction,
  renameThreadAction, sendMessageAction, setThreadPinnedAction, setThreadStatusAction, stopStreamAction,
} from "@/lib/assistantActions";
import { ThreadRail } from "./ThreadRail";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { useAssistantStream } from "./useAssistantStream";
import { Toast } from "@/components/ui";
import "./assistant.css";

// ASST-07 — the whole `/assistant` page is one client component tree (not a series of navigations):
// switching threads and streaming a reply are both fundamentally "update state, don't reload",
// exactly like aivory's `useChat` being the single engine both the page and its floating mount
// consume (per docs/blueprints/assistant-foundation.md §8 — the `@drawer` mount is future work, but
// this hook/component shape is what makes it "cheap once the page exists", per that doc).
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

export function AssistantWorkspace({ initialThreads, initialActiveThreadId }: {
  initialThreads: AssistantThread[];
  initialActiveThreadId: string | null;
}) {
  const [threads, setThreads] = useState<AssistantThread[]>(initialThreads);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(initialActiveThreadId ?? initialThreads[0]?.id ?? null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [loadingThread, setLoadingThread] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

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

  // ---- Send / stop --------------------------------------------------------------------------------
  const hasPendingMessage = messages.some(isPendingMessage);
  const canSend = !!activeThreadId && !loadingThread && !sending && !hasPendingMessage && stream.state.status !== "streaming";

  async function handleSend(text: string) {
    if (!activeThreadId || !canSend) return;
    setSending(true);
    const lastSeq = messages.length ? messages[messages.length - 1].seq : 0;
    const optimisticUser: AssistantMessage = {
      id: `local-user-${Date.now()}`, seq: lastSeq + 1, role: "user", content: text, parts: null,
      provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    const r = await sendMessageAction(activeThreadId, text);
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

  return (
    <div className="asst-workspace">
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
        <ThreadView
          messages={messages}
          streamState={stream.state}
          streamingMessageId={streamingMessageId}
          loading={loadingThread}
        />
        <Composer canSend={canSend} streaming={stream.state.status === "streaming"} onSend={handleSend} onStop={handleStop} />
      </div>
      {toastMsg && <Toast message={toastMsg} />}
    </div>
  );
}
