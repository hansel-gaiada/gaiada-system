"use client";
import { useEffect, useMemo, useState } from "react";
import { groupThreads, filterThreads, threadTitle, type AssistantThread } from "@/lib/assistant";

// ASST-07 — the left rail. Lifted from aivory's `components/sidebar/` (ConversationHistory +
// ConversationGroup + PinnedChats + SearchBar): pinned-first split, Today/Yesterday/Last 7 Days/
// Older date grouping. Deliberately DIVERGES from aivory's hover-context-menu for row actions —
// small always-tabbable icon buttons instead, because a right-click/long-press menu has no keyboard
// equivalent and this ticket's acceptance bar includes "keyboard-only drive of the whole flow works".
//
// Search is CLIENT-SIDE over the already-loaded thread list (see lib/assistant-data.ts's header for
// why: the rail loads the owner's full set — max 200, the backend's own cap — in one page, so a
// per-keystroke round trip buys nothing here that a local substring filter doesn't already give for
// free, and it avoids a whole class of "stale results while typing" races).
//
// DW-2h — ONE fallback on top of that: when the loaded list has no title match, ask the server's own
// list (`q`, already there) so a thread older than the loaded page is still findable. The local filter
// still answers first and for every keystroke; the server is asked only on a miss, after a pause, and
// only the answer to the CURRENT query is ever shown (each pending ask is dropped when the query moves).
export const SERVER_SEARCH_DEBOUNCE_MS = 300;

export function ThreadRail({
  threads, activeThreadId, busy, collapsed = false, onToggleCollapsed, onSelect, onNew, onRename, onTogglePin, onToggleArchive, onDelete,
  searchServer,
}: {
  threads: AssistantThread[];
  activeThreadId: string | null;
  busy: boolean;
  /** 2026-08-07 owner fix — collapses the rail to a narrow icon strip so the conversation column
   *  can use the space instead. The collapse TOGGLE itself is always rendered regardless of this
   *  flag (see the render below) — a control that only reappears once you've already found some
   *  OTHER way to expand things would fail the "stays keyboard-reachable" bar outright. Persisted
   *  by the caller (`AssistantWorkspace`) into the `gaiada_prefs` cookie, not owned here. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onToggleArchive: (id: string, archived: boolean) => void;
  onDelete: (id: string) => void;
  /** Asks the server's list for threads whose title matches `q`; `null` when it could not answer. Must be
   *  a stable function (it is an effect dependency). Without it the rail only filters what is loaded. */
  searchServer?: (q: string) => Promise<AssistantThread[] | null>;
}) {
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState<{ q: string; items: AssistantThread[] } | null>(null);
  const [searching, setSearching] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const trimmed = query.trim();
  const local = useMemo(() => filterThreads(threads, query), [threads, query]);
  const localMiss = trimmed !== "" && local.length === 0;

  useEffect(() => {
    if (!localMiss || !searchServer) {
      setRemote(null);
      setSearching(false);
      return;
    }
    let dropped = false;
    setSearching(true);
    const timer = setTimeout(() => {
      searchServer(trimmed)
        .catch(() => null)
        .then((items) => {
          if (dropped) return; // the query moved on: never show an older query's answer
          setSearching(false);
          setRemote(items ? { q: trimmed, items } : null);
        });
    }, SERVER_SEARCH_DEBOUNCE_MS);
    return () => {
      dropped = true;
      clearTimeout(timer);
    };
  }, [localMiss, trimmed, searchServer]);

  // A row found by the server is not in `threads`, so the caller's optimistic updates never reach it:
  // mirror them onto the answer here, so a pin or rename on a found row shows at once.
  function patchRemote(id: string, patch: Partial<AssistantThread> | null) {
    setRemote((r) => (r ? { ...r, items: patch ? r.items.map((t) => (t.id === id ? { ...t, ...patch } : t)) : r.items.filter((t) => t.id !== id) } : r));
  }

  const remoteItems = remote && remote.q === trimmed ? remote.items : null;
  const visible = localMiss ? (remoteItems ?? []) : local;
  const grouped = useMemo(() => groupThreads(visible), [visible]);

  function startRename(t: AssistantThread) {
    setEditingId(t.id);
    setEditValue(threadTitle(t));
  }
  function commitRename() {
    const id = editingId;
    const title = editValue.trim();
    setEditingId(null);
    if (id && title) { patchRemote(id, { title }); onRename(id, title); }
  }

  function renderRow(t: AssistantThread) {
    const active = t.id === activeThreadId;
    const archived = t.status === "archived";
    return (
      <li key={t.id} className={`asst-rail__row${active ? " asst-rail__row--active" : ""}`}>
        {/* DW-2h — the pin leads the row, so it is the first thing a keyboard or pointer reaches and its
            state is visible at a glance (filled and accent-coloured when pinned), not buried among the
            row actions. Still the same PATCH (`onTogglePin`). */}
        <button
          type="button"
          className={`asst-rail__pin${t.pinned ? " asst-rail__pin--on" : ""}`}
          aria-label={t.pinned ? `Unpin "${threadTitle(t)}"` : `Pin "${threadTitle(t)}"`}
          title={t.pinned ? "Unpin" : "Pin"}
          onClick={() => { patchRemote(t.id, { pinned: !t.pinned }); onTogglePin(t.id, !t.pinned); }}
        >
          <span aria-hidden="true">{t.pinned ? "★" : "☆"}</span>
        </button>
        {editingId === t.id ? (
          <input
            className="asst-rail__rename-input"
            value={editValue}
            autoFocus
            aria-label={`Rename "${threadTitle(t)}"`}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); commitRename(); }
              if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <button
            type="button"
            className="asst-rail__title"
            onClick={() => onSelect(t.id)}
            aria-current={active ? "true" : undefined}
          >
            <span className="asst-rail__title-text">{threadTitle(t)}</span>
            {archived && <span className="asst-rail__chip">Archived</span>}
          </button>
        )}
        <div className="asst-rail__row-actions">
          <button
            type="button"
            className="asst-rail__icon-btn"
            aria-label={`Rename "${threadTitle(t)}"`}
            title="Rename"
            onClick={() => startRename(t)}
          >
            <span aria-hidden="true">&#9998;</span>
          </button>
          <button
            type="button"
            className="asst-rail__icon-btn"
            aria-label={archived ? `Unarchive "${threadTitle(t)}"` : `Archive "${threadTitle(t)}"`}
            title={archived ? "Unarchive" : "Archive"}
            onClick={() => { patchRemote(t.id, { status: archived ? "active" : "archived" }); onToggleArchive(t.id, !archived); }}
          >
            <span aria-hidden="true">{archived ? "↩" : "⬇"}</span>
          </button>
          {confirmDeleteId === t.id ? (
            <button
              type="button"
              className="asst-rail__icon-btn asst-rail__icon-btn--danger"
              onClick={() => { patchRemote(t.id, null); onDelete(t.id); setConfirmDeleteId(null); }}
              onBlur={() => setConfirmDeleteId(null)}
            >
              Confirm delete
            </button>
          ) : (
            <button
              type="button"
              className="asst-rail__icon-btn"
              aria-label={`Delete "${threadTitle(t)}"`}
              title="Delete"
              onClick={() => setConfirmDeleteId(t.id)}
            >
              <span aria-hidden="true">&#128465;</span>
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <nav className={`asst-rail${collapsed ? " asst-rail--collapsed" : ""}`} aria-label="Assistant sessions">
      <div className="asst-rail__head">
        <button
          type="button"
          className="asst-rail__collapse-btn"
          aria-expanded={!collapsed}
          aria-controls="asst-rail-body"
          aria-label={collapsed ? "Expand sessions sidebar" : "Collapse sessions sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapsed}
        >
          <span aria-hidden="true">{collapsed ? "»" : "«"}</span>
        </button>
        {!collapsed && (
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onNew} disabled={busy}>
            + New chat
          </button>
        )}
      </div>
      {collapsed ? (
        <button
          type="button"
          className="asst-rail__new-collapsed"
          aria-label="New chat"
          title="New chat"
          onClick={onNew}
          disabled={busy}
        >
          <span aria-hidden="true">+</span>
        </button>
      ) : (
        <div id="asst-rail-body" className="asst-rail__body">
          <div className="asst-rail__search">
            <label htmlFor="asst-rail-search" className="asst-sr-only">Search sessions</label>
            <input
              id="asst-rail-search"
              type="search"
              placeholder="Search sessions…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="asst-rail__list">
            {grouped.pinned.length > 0 && (
              <section aria-label="Pinned sessions">
                <h2 className="asst-rail__group-label">Pinned</h2>
                <ul>{grouped.pinned.map(renderRow)}</ul>
              </section>
            )}
            {grouped.groups.map((g) => g.threads.length > 0 && (
              <section key={g.label} aria-label={`${g.label} sessions`}>
                <h2 className="asst-rail__group-label">{g.label}</h2>
                <ul>{g.threads.map(renderRow)}</ul>
              </section>
            ))}
            {visible.length === 0 && (
              <p className="asst-rail__empty" role={searching ? "status" : undefined}>
                {searching ? "Searching older sessions…" : query ? "No sessions match your search." : "No sessions yet — start one above."}
              </p>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
