"use client";
import { useMemo, useState } from "react";
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
export function ThreadRail({
  threads, activeThreadId, busy, collapsed = false, onToggleCollapsed, onSelect, onNew, onRename, onTogglePin, onToggleArchive, onDelete,
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
}) {
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const visible = useMemo(() => filterThreads(threads, query), [threads, query]);
  const grouped = useMemo(() => groupThreads(visible), [visible]);

  function startRename(t: AssistantThread) {
    setEditingId(t.id);
    setEditValue(threadTitle(t));
  }
  function commitRename() {
    const id = editingId;
    const title = editValue.trim();
    setEditingId(null);
    if (id && title) onRename(id, title);
  }

  function renderRow(t: AssistantThread) {
    const active = t.id === activeThreadId;
    const archived = t.status === "archived";
    return (
      <li key={t.id} className={`asst-rail__row${active ? " asst-rail__row--active" : ""}`}>
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
            aria-label={t.pinned ? `Unpin "${threadTitle(t)}"` : `Pin "${threadTitle(t)}"`}
            title={t.pinned ? "Unpin" : "Pin"}
            onClick={() => onTogglePin(t.id, !t.pinned)}
          >
            <span aria-hidden="true">{t.pinned ? "★" : "☆"}</span>
          </button>
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
            onClick={() => onToggleArchive(t.id, !archived)}
          >
            <span aria-hidden="true">{archived ? "↩" : "⬇"}</span>
          </button>
          {confirmDeleteId === t.id ? (
            <button
              type="button"
              className="asst-rail__icon-btn asst-rail__icon-btn--danger"
              onClick={() => { onDelete(t.id); setConfirmDeleteId(null); }}
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
              <p className="asst-rail__empty">{query ? "No sessions match your search." : "No sessions yet — start one above."}</p>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
