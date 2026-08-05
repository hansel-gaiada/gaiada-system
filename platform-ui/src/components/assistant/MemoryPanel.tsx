"use client";
import { useEffect, useMemo, useState } from "react";
import { groupMemory, MEMORY_SCOPE_LABEL, type AssistantMemory, type AssistantMemoryScope } from "@/lib/assistant";
import {
  confirmMemoryAction, deleteMemoryAction, proposeMemoryAction, refreshMemoryAction,
} from "@/lib/assistantActions";

// ASST-19 — the memory panel: blueprint §8's right-rail "memory (view/edit/delete/pin)" affordance
// for durable user memory (§4.1, memory #2 of 4). Self-contained (loads its own list on mount via
// a server action, like send/stop rather than page.tsx's SSR props — see assistantActions.ts's
// header on why memory writes carry no `revalidatePath`), so it can be dropped into the workspace
// without threading its state through AssistantWorkspace's own thread/stream state.
//
// ── THE QUARANTINE, RESTATED FOR THIS UI (do not "simplify" this away) ────────────────────────────
// A row with `confirmedAt === null` is a PROPOSAL: recorded, visible here for review, but INERT on
// the backend — context.ts's assembleContext() never reads it (see docs/FRONTEND-BFF-CONTRACT.md
// §18's "Memory panel backend" subsection). This panel must never imply a pending row is already
// "remembered" — the "Pending confirmation" section heading and its copy exist specifically to keep
// that distinction visible, not just enforced server-side.
//
// ── EDIT/PIN REUSE "CONFIRM" (no separate "update" action exists — ASST-02's Cerbos policy) ───────
// `confirmMemoryAction` is called for THREE different user intents here: confirming a proposal,
// editing an already-confirmed row's text, and toggling pin. All three are the same backend call
// with different fields set; see assistantActions.ts's confirmMemoryAction header.
export function MemoryPanel({ activeThreadId, onClose }: { activeThreadId: string | null; onClose: () => void }) {
  const [items, setItems] = useState<AssistantMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftScope, setDraftScope] = useState<AssistantMemoryScope>("user");
  const [proposing, setProposing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await refreshMemoryAction();
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setItems(r.items);
  }

  useEffect(() => {
    void load();
  }, []);

  const { pending, confirmed } = useMemo(() => groupMemory(items), [items]);

  async function handlePropose(e: React.FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setProposing(true);
    const r = await proposeMemoryAction(content, draftScope, activeThreadId ?? undefined);
    setProposing(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setDraft("");
    await load();
  }

  async function handleConfirm(id: string) {
    setBusyId(id);
    const r = await confirmMemoryAction(id);
    setBusyId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    await load();
  }

  async function handleTogglePin(m: AssistantMemory) {
    setBusyId(m.id);
    // Optimistic — the panel is small enough that a round-trip flicker on every pin click would
    // be noticeable, unlike the thread rail's larger list.
    setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, pinned: !m.pinned } : x)));
    const r = await confirmMemoryAction(m.id, { pinned: !m.pinned });
    setBusyId(null);
    if (!r.ok) {
      setError(r.error);
      setItems((prev) => prev.map((x) => (x.id === m.id ? { ...x, pinned: m.pinned } : x)));
    }
  }

  function startEdit(m: AssistantMemory) {
    setEditingId(m.id);
    setEditValue(m.content);
  }
  async function commitEdit() {
    const id = editingId;
    const content = editValue.trim();
    setEditingId(null);
    if (!id || !content) return;
    setBusyId(id);
    const r = await confirmMemoryAction(id, { content });
    setBusyId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    await load();
  }

  async function handleDelete(id: string) {
    setConfirmDeleteId(null);
    setBusyId(id);
    const r = await deleteMemoryAction(id);
    setBusyId(null);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  function renderRow(m: AssistantMemory, isPending: boolean) {
    const busy = busyId === m.id;
    return (
      <li key={m.id} className="asst-mem__row">
        {editingId === m.id ? (
          <textarea
            className="asst-mem__edit-input"
            value={editValue}
            autoFocus
            aria-label="Edit memory"
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitEdit(); }
              if (e.key === "Escape") setEditingId(null);
            }}
          />
        ) : (
          <p className="asst-mem__content">{m.content}</p>
        )}
        <div className="asst-mem__row-meta">
          <span className="asst-mem__scope-chip">{MEMORY_SCOPE_LABEL[m.scope]}</span>
          <div className="asst-mem__row-actions">
            {isPending && (
              <button
                type="button"
                className="asst-mem__action asst-mem__action--confirm"
                disabled={busy}
                onClick={() => handleConfirm(m.id)}
              >
                Confirm
              </button>
            )}
            {!isPending && (
              <button
                type="button"
                className="asst-mem__icon-btn"
                aria-label={m.pinned ? `Unpin memory` : `Pin memory`}
                title={m.pinned ? "Unpin" : "Pin"}
                disabled={busy}
                onClick={() => handleTogglePin(m)}
              >
                <span aria-hidden="true">{m.pinned ? "★" : "☆"}</span>
              </button>
            )}
            <button
              type="button"
              className="asst-mem__icon-btn"
              aria-label="Edit memory"
              title="Edit"
              disabled={busy}
              onClick={() => startEdit(m)}
            >
              <span aria-hidden="true">&#9998;</span>
            </button>
            {confirmDeleteId === m.id ? (
              <button
                type="button"
                className="asst-mem__icon-btn asst-mem__icon-btn--danger"
                onClick={() => handleDelete(m.id)}
                onBlur={() => setConfirmDeleteId(null)}
              >
                Confirm delete
              </button>
            ) : (
              <button
                type="button"
                className="asst-mem__icon-btn"
                aria-label="Delete memory"
                title="Delete"
                disabled={busy}
                onClick={() => setConfirmDeleteId(m.id)}
              >
                <span aria-hidden="true">&#128465;</span>
              </button>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <aside id="asst-memory-panel" className="asst-mem" aria-label="Assistant memory">
      <div className="asst-mem__head">
        <p className="type-eyebrow" style={{ color: "var(--erp-accent)" }}>Memory</p>
        <button type="button" className="asst-mem__close" aria-label="Close memory panel" onClick={onClose}>
          <span aria-hidden="true">&times;</span>
        </button>
      </div>

      <form className="asst-mem__propose" onSubmit={handlePropose}>
        <label htmlFor="asst-mem-draft" className="asst-sr-only">Add a memory</label>
        <textarea
          id="asst-mem-draft"
          className="asst-mem__propose-input"
          placeholder="Remember something for next time…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="asst-mem__propose-row">
          <label htmlFor="asst-mem-scope" className="asst-sr-only">Scope</label>
          <select
            id="asst-mem-scope"
            className="asst-mem__scope-select"
            value={draftScope}
            onChange={(e) => setDraftScope(e.target.value === "company" ? "company" : "user")}
          >
            <option value="user">{MEMORY_SCOPE_LABEL.user}</option>
            <option value="company">{MEMORY_SCOPE_LABEL.company}</option>
          </select>
          <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={proposing || !draft.trim()}>
            Propose
          </button>
        </div>
      </form>

      {error && <p className="asst-mem__error" role="alert">{error}</p>}

      <div className="asst-mem__list">
        {loading ? (
          <p className="asst-mem__empty">Loading memory…</p>
        ) : (
          <>
            {pending.length > 0 && (
              <section aria-label="Pending confirmation">
                <h2 className="asst-mem__group-label">Pending confirmation</h2>
                <p className="asst-mem__group-hint">Not yet remembered — confirm to have the assistant use it.</p>
                <ul>{pending.map((m) => renderRow(m, true))}</ul>
              </section>
            )}
            <section aria-label="Confirmed memory">
              <h2 className="asst-mem__group-label">Confirmed</h2>
              {confirmed.length > 0 ? (
                <ul>{confirmed.map((m) => renderRow(m, false))}</ul>
              ) : (
                <p className="asst-mem__empty">Nothing confirmed yet.</p>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
