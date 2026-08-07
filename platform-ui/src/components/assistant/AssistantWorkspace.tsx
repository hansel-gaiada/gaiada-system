"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AssistantMessage, AssistantThread, PinnedPageContext } from "@/lib/assistant";
import { isPendingMessage, hasPendingProposalDecision, deriveThreadTitle } from "@/lib/assistant";
import { pageContextPrefix } from "@/lib/assistantContext";
import {
  createThreadAction, deleteThreadAction, refreshThreadAction, refreshThreadsAction,
  renameThreadAction, sendMessageAction, setThreadPinnedAction, setThreadStatusAction, stopStreamAction,
  type SendMessageOpts,
} from "@/lib/assistantActions";
import { setAssistantRailCollapsedAction } from "@/lib/prefsActions";
import { ThreadRail } from "./ThreadRail";
import { ThreadView } from "./ThreadView";
import { Composer } from "./Composer";
import { MemoryPanel } from "./MemoryPanel";
import { CapabilitiesPanel } from "./CapabilitiesPanel";
import { RosterPanel } from "./RosterPanel";
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

export function AssistantWorkspace({
  initialThreads, initialActiveThreadId, variant = "page", pageContext = null, initialRailCollapsed = false,
}: {
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
  /** 2026-08-07 — the left rail's persisted collapse state (`gaiada_prefs` cookie via
   *  `lib/prefs.ts`), read server-side by `assistant/page.tsx`. Page variant only: the drawer
   *  never renders `ThreadRail` at all (see `assistant-drawer.css`), so a collapse preference has
   *  nothing to apply to there — the drawer route simply doesn't pass this prop. */
  initialRailCollapsed?: boolean;
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
  // FE-verification gap #1 (2026-08-06) — a real race the new committed Playwright regression spec
  // caught: `loadThread(id)` is async, and NOTHING previously checked whether `id` was STILL the
  // active thread by the time its `GET thread` resolved. Switching threads twice in quick
  // succession (the exact "+ New chat" right after landing on the page" pattern the new spec
  // exercises) could let an EARLIER, slower `loadThread` call for the thread you just navigated
  // AWAY from resolve AFTER a newer switch already set `messages` to something else (a fresh
  // empty array from `handleNew`, or a different thread's history from `selectThread`) — silently
  // overwriting the current thread's messages with the stale one's. `activeThreadIdRef` is a
  // synchronously-updated mirror of `activeThreadId` (a `useEffect`-updated ref would still lag
  // one render behind the very state change this guard needs to observe): every place that changes
  // `activeThreadId` updates BOTH in the same synchronous call via `setActive`, so `loadThread`
  // can compare its OWN request's id against the CURRENT truth at resolve time, not a stale
  // closure over `activeThreadId` captured when the call started.
  const activeThreadIdRef = useRef(activeThreadId);
  function setActive(id: string | null) {
    activeThreadIdRef.current = id;
    setActiveThreadId(id);
  }
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
  // ASST-21 — the roster panel (registry + episodic history + hand-off/run-watch) joins the SAME
  // one-at-a-time right-rail slot as memory/capabilities (blueprint §8's context-inspector family).
  const [rosterOpen, setRosterOpen] = useState(false);
  // 2026-08-07 — the left rail's collapse state (owner complaint: no collapse affordance existed
  // at all). Only meaningful in "page" variant (the drawer never renders `ThreadRail`) — seeded
  // from the persisted cookie value, kept in sync with it on every toggle via
  // `setAssistantRailCollapsedAction` (fire-and-forget: this component's own state is already the
  // source of truth for THIS session, the write is only for the NEXT page load).
  const [railCollapsed, setRailCollapsed] = useState(variant === "page" && initialRailCollapsed);
  function toggleRailCollapsed() {
    setRailCollapsed((prev) => {
      const next = !prev;
      void setAssistantRailCollapsedAction(next);
      return next;
    });
  }
  // 2026-08-07 — the empty state's suggestion tiles (`EmptyStateSuggestions`, via `ThreadView`)
  // hand a prompt up through this rather than sending it directly — see `Composer`'s `prefill` prop
  // header for why. `seq` forces the effect to re-apply even when the SAME tile is clicked twice.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; seq: number } | null>(null);
  function openCapabilitiesPanel() {
    setCapabilitiesOpen(true);
    setMemoryOpen(false);
    setRosterOpen(false);
  }

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
    // Staleness guard (see `activeThreadIdRef`'s header above): always clear the busy flag — SOME
    // fetch resolved and nothing should stay disabled waiting on a request that will never apply —
    // but never let a request for a thread that is no longer active mutate `messages`/`threads`.
    const stale = activeThreadIdRef.current !== id;
    setLoadingThread(false);
    if (stale) return;
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

  // T4 (ASST-23) — the out-of-band-decision poll: a proposal card whose approval is decided
  // elsewhere (a `company_admin`/etc. on `/approvals/[id]`, in a different tab or session
  // entirely) never pushes anything into this thread — a re-`GET thread` is the only way to see it.
  // Deliberately NOT `loadThread` (which flips `loadingThread`, blanking the whole `ThreadView` per
  // its own `loading` prop — fine for an explicit thread switch, a very visible regression for a
  // silent background poll): a bare, silent re-fetch that only ever replaces `messages`/`threads`
  // in place. React only touches the DOM where the rendered output actually differs, so a poll that
  // finds nothing new causes no mutation at all — the SAME "no cost when nothing changed" property
  // `RosterPanel`'s own handoff poll already relies on.
  const refreshThreadSilently = useCallback(async (id: string) => {
    const r = await refreshThreadAction(id);
    if (!r.ok) return; // best-effort — a transient failure just tries again next tick
    setMessages(r.messages);
    setThreads((prev) => prev.map((t) => (t.id === id ? r.thread : t)));
  }, []);

  const PENDING_PROPOSAL_POLL_MS = 4000; // same cadence RosterPanel's handoff poll already uses
  useEffect(() => {
    // Never polls while a send/stream is in flight (avoid clobbering the optimistic user message +
    // placeholder this same component is about to append) — by construction, a proposal only ever
    // reaches a "pending decision" state AFTER its turn has already gone terminal and reloaded, so
    // this guard is a defensive belt, not the normal path.
    if (!activeThreadId || sending || stream.state.status === "streaming") return;
    if (!hasPendingProposalDecision(messages)) return;
    const t = setInterval(() => void refreshThreadSilently(activeThreadId), PENDING_PROPOSAL_POLL_MS);
    return () => clearInterval(t);
  }, [activeThreadId, messages, sending, stream.state.status, refreshThreadSilently]);

  function selectThread(id: string) {
    if (id === activeThreadId) return;
    stream.reset();
    setStreamingMessageId(null);
    setActive(id);
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
    setActive(r.id);
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
      setActive(next?.id ?? null);
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

  async function handleSend(text: string, opts: SendMessageOpts = {}) {
    if (!activeThreadId || !canSend) return;
    const isFirstMessage = messages.length === 0;
    setSending(true);
    const lastSeq = messages.length ? messages[messages.length - 1].seq : 0;
    // ASST-22 — the ONE place the pinned page context actually reaches the assistant: prefixed onto
    // the FIRST outgoing message of the thread only (mirrors aivory's `AivoryAssistant.tsx`
    // `contextPrefix`, applied only when `messages.length === 0`). Sent AND displayed identically
    // (never a hidden addition) — see `lib/assistantContext.ts::pageContextPrefix`'s header for why
    // this is composition over the existing `content` field rather than a new wire shape.
    const outgoing = isFirstMessage && pageContext ? pageContextPrefix(pageContext.label, pageContext.ref) + text : text;
    // 2026-08-07 owner fix — every thread in the rail used to read "New chat" forever, making the
    // list useless for finding anything. Auto-title from the RAW first message (never the
    // page-context-prefixed `outgoing`, which would title every pinned-page thread with the same
    // "Regarding X:" boilerplate) — see `deriveThreadTitle`'s header for why this is FE-derived
    // rather than a backend summary. Guarded on `activeThread.title` being null: the rename pencil
    // in `ThreadRail` always wins once a title exists (derived or explicit), and this never fires
    // a second time on the SAME thread once it does.
    if (isFirstMessage && activeThread && !activeThread.title) {
      const derivedTitle = deriveThreadTitle(text);
      if (derivedTitle) void handleRename(activeThreadId, derivedTitle);
    }
    const optimisticUser: AssistantMessage = {
      id: `local-user-${Date.now()}`, seq: lastSeq + 1, role: "user", content: outgoing, parts: null,
      provider: null, model: null, tokens: null, latencyMs: null, errorKind: null, createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticUser]);
    // T4 (ASST-23, §7.4) — the tools-mode affordance: `opts` came straight from the Composer's own
    // toggle/agent select, unchanged all the way down to `sendMessageAction`'s body-shaping.
    const r = await sendMessageAction(activeThreadId, outgoing, opts);
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

  const rightRailOpen = memoryOpen || capabilitiesOpen || rosterOpen;
  const railCollapsedActive = variant === "page" && railCollapsed;

  return (
    <div
      className={`asst-workspace${variant === "drawer" ? " asst-workspace--drawer" : ""}${rightRailOpen ? " asst-workspace--with-memory" : ""}${railCollapsedActive ? " asst-workspace--rail-collapsed" : ""}`}
    >
      <ThreadRail
        threads={threads}
        activeThreadId={activeThreadId}
        busy={loadingThread}
        collapsed={railCollapsedActive}
        onToggleCollapsed={toggleRailCollapsed}
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
              setRosterOpen(false);
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
              setRosterOpen(false);
            }}
          >
            Memory
          </button>
          <button
            type="button"
            className="asst-memory-toggle"
            aria-expanded={rosterOpen}
            aria-controls="asst-roster-panel"
            onClick={() => {
              setRosterOpen((v) => !v);
              setMemoryOpen(false);
              setCapabilitiesOpen(false);
            }}
          >
            Agents
          </button>
        </div>
        <ThreadView
          messages={messages}
          streamState={stream.state}
          streamingMessageId={streamingMessageId}
          loading={loadingThread}
          threadId={activeThreadId ?? ""}
          onSuggestionPick={(promptText) => setComposerPrefill({ text: promptText, seq: Date.now() })}
          onOpenCapabilities={openCapabilitiesPanel}
        />
        <Composer
          canSend={canSend}
          streaming={stream.state.status === "streaming"}
          onSend={handleSend}
          onStop={handleStop}
          prefill={composerPrefill}
        />
      </div>
      {capabilitiesOpen && <CapabilitiesPanel onClose={() => setCapabilitiesOpen(false)} />}
      {memoryOpen && <MemoryPanel activeThreadId={activeThreadId} onClose={() => setMemoryOpen(false)} />}
      {rosterOpen && <RosterPanel activeThreadId={activeThreadId} onClose={() => setRosterOpen(false)} />}
      {toastMsg && <Toast message={toastMsg} />}
    </div>
  );
}
