"use client";
// SCP-5 W5-C5 (BFF §63.30.5) — one section of the company rules: the current values beside the defaults, what changed and who changed it, Save, "Reset to default", and the section's short history.
//
//   - The panel edits a DRAFT of one section and saves it whole with `expectedVersion` (`PUT rules/:section`). A save answers the read, and the page refreshes with it.
//   - On 409 `rules_changed` it says someone else saved first, reloads, and lists what the person had changed, so nothing they did is kept silently.
//   - A 400 `invalid_field` is said in words under the control the field points to (`RulesErrorContext`), the control is focused, and the same words sit under the buttons.
//   - A person who may not edit (`canEdit` false) sees the values read-only: no Save, no Reset, no history, and the reason in words. The server's 403 is the boundary, not this.
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/overlay/Modal";
import { RulesErrorContext, type FieldError } from "@/components/social/RulesFields";
import { formatDateTime } from "@/lib/format";
import { PLAN_REFUSAL_REASON } from "@/lib/socialCycles";
import { loadRulesHistory, resetRules, saveRules } from "@/lib/socialRulesActions";
import { cloneJson, diffRows, historyWords, sameJson, type RulesAnswer, type RulesDoc, type RulesHistoryItem, type RulesSection } from "@/lib/socialRules";
import "@/components/social/cycles.css";
import "@/components/social/rules.css";

export interface PanelContext<S extends RulesSection> {
  draft: RulesDoc[S];
  setDraft: (next: RulesDoc[S] | ((d: RulesDoc[S]) => RulesDoc[S])) => void;
  defaults: RulesDoc[S];
  canEdit: boolean;
}

type Said = { tone: "ok" | "error"; text: string; lost?: string[] } | null;

export function RulesPanel<S extends RulesSection>({ section, title, intro, answer, children, preview }: {
  section: S;
  title: string;
  intro: ReactNode;
  answer: RulesAnswer;
  /** The editor: the draft's controls. */
  children: (c: PanelContext<S>) => ReactNode;
  /** The section's previews (they need `plan`, so they are drawn only for a person who can edit). */
  preview?: (c: PanelContext<S>) => ReactNode;
}) {
  const router = useRouter();
  const root = useRef<HTMLElement>(null);
  const current = answer.rules[section];
  const defaults = answer.defaults[section];
  const state = answer.sections[section];
  const canEdit = answer.canEdit;
  const [draft, setDraftState] = useState<RulesDoc[S]>(() => cloneJson(current));
  const [seen, setSeen] = useState(answer.version);
  const [said, setSaid] = useState<Said>(null);
  const [error, setError] = useState<FieldError | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, start] = useTransition();
  // A newer version arrived (a save, or the reload after someone else's): the draft starts again from it.
  if (seen !== answer.version) { setSeen(answer.version); setDraftState(cloneJson(current)); setError(null); }

  const dirty = !sameJson(draft, current);
  const setDraft: PanelContext<S>["setDraft"] = (next) => { setError(null); setDraftState((d) => (typeof next === "function" ? (next as (d: RulesDoc[S]) => RulesDoc[S])(d) : next)); };
  const differs = diffRows(defaults, draft, section);

  // The refused field's own control takes focus, so a keyboard user lands where the words are.
  useEffect(() => {
    if (pending || !error?.field || !root.current) return; // a disabled control cannot take focus, so wait for the save to settle
    const el = Array.from(root.current.querySelectorAll<HTMLElement>("[data-rule-field]")).find((n) => n.getAttribute("data-rule-field") === error.field);
    el?.focus();
  }, [error, pending]);

  function onSave() {
    setSaid(null); setError(null);
    start(async () => {
      const r = await saveRules(section, answer.version, draft);
      if (r.ok) { setSaid({ tone: "ok", text: `Saved as version ${r.answer.version}. It applies to new periods and new records only; what was made before keeps the rules it was made under.` }); router.refresh(); return; }
      if (r.refusal.error === "rules_changed") {
        const now = (r.refusal.detail as { currentVersion?: unknown } | undefined)?.currentVersion;
        const mine = diffRows(current, draft, section).map((d) => `${d.words}: ${d.wasOrDefault} to ${d.now}`);
        setSaid({ tone: "error", text: `Someone else saved the rules first${typeof now === "number" ? ` (now version ${now})` : ""}, so nothing was saved. This section has been reloaded with their values.`, lost: mine });
        router.refresh();
        return;
      }
      setError({ field: r.refusal.error === "invalid_field" ? r.refusal.field ?? null : null, message: r.message });
      setSaid({ tone: "error", text: `Not saved. ${r.message}` });
    });
  }
  function onReset() {
    start(async () => {
      const r = await resetRules(section, answer.version);
      setConfirmReset(false);
      if (r.ok) { setSaid({ tone: "ok", text: `Set back to the default, as version ${r.answer.version}. It applies to new periods and new records only.` }); setError(null); router.refresh(); return; }
      if (r.refusal.error === "rules_changed") { setSaid({ tone: "error", text: "Someone else saved the rules first, so nothing was reset. This section has been reloaded with their values." }); router.refresh(); return; }
      setSaid({ tone: "error", text: `Not reset. ${r.message}` });
    });
  }

  const ctx: PanelContext<S> = { draft, setDraft, defaults, canEdit };
  const heading = `rules-${section}-title`;
  return (
    <section ref={root} className="rules__panel" aria-labelledby={heading} data-rules-section={section}>
      <div className="rules__head">
        <h4 className="rules__title" id={heading}>{title}</h4>
        <span className={`rules__state${state.changed ? " rules__state--changed" : ""}`}>{state.changed ? "Changed from the default" : "Using the default"}</span>
      </div>
      <p className="scp-note" style={{ margin: 0 }}>{intro}</p>
      <p className="scp-note" style={{ margin: 0 }}>
        {state.editedBy && state.effectiveFrom
          ? `Last saved by ${state.editedBy.name || "a person who is no longer listed"} on ${formatDateTime(state.effectiveFrom)} (version ${state.version}).`
          : "Nobody has saved this section yet: the company is on the defaults."}
      </p>
      {!canEdit && <p className="scp-note scp-note--reason" style={{ margin: 0 }}>{PLAN_REFUSAL_REASON} You can read the values here.</p>}

      <RulesErrorContext.Provider value={error}>
        <fieldset className="rules__fields" disabled={!canEdit || pending}>
          <legend className="rules__sr">{title}</legend>
          {children(ctx)}
        </fieldset>
      </RulesErrorContext.Provider>

      <details className="rules__details">
        <summary>{differs.length === 0 ? "These values match the default" : `What differs from the default (${differs.length})`}</summary>
        {differs.length > 0 && (
          <ul className="rules__diff">
            {differs.map((d) => <li key={d.path}>{d.words}: {d.now} (default: {d.wasOrDefault})</li>)}
          </ul>
        )}
      </details>

      {canEdit && preview?.(ctx)}

      {said && (
        <div role={said.tone === "error" ? "alert" : "status"}>
          <p className={`scp-msg scp-msg--${said.tone}`} style={{ margin: 0 }}>{said.text}</p>
          {said.lost && said.lost.length > 0 && (
            <>
              <p className="scp-note" style={{ marginBottom: 0 }}>Your edits, so you can make them again:</p>
              <ul className="rules__diff">{said.lost.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </>
          )}
        </div>
      )}

      {canEdit && (
        <div className="rules__buttons">
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onSave} disabled={pending || !dirty}>{pending ? "Working…" : `Save ${title.toLowerCase()}`}</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setDraftState(cloneJson(current)); setError(null); setSaid(null); }} disabled={pending || !dirty}>Discard changes</button>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmReset(true)} disabled={pending || !state.changed}>Reset to default</button>
        </div>
      )}
      {canEdit && <History section={section} version={answer.version} />}

      {confirmReset && (
        <Modal
          open onClose={() => setConfirmReset(false)} title={`Reset ${title.toLowerCase()} to the default?`} size="sm"
          footer={
            <>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setConfirmReset(false)} disabled={pending}>Keep my values</button>
              <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={onReset} disabled={pending}>{pending ? "Working…" : "Reset to default"}</button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            Every setting in this section goes back to the default, and any edit you have not saved is dropped. It applies to new periods and new records only: what was already made keeps the rules it was made under.
            The change is saved as a new version, so it stays in the history.
          </p>
        </Modal>
      )}
    </section>
  );
}

/** The section's last changes, read when it is opened ("Changed by … on …: what changed"). */
function History({ section, version }: { section: RulesSection; version: number }) {
  const [items, setItems] = useState<RulesHistoryItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(-1);
  const [pending, start] = useTransition();

  function load(cursor: string | null, reset: boolean) {
    setProblem(null);
    start(async () => {
      const r = await loadRulesHistory(section, cursor);
      if (!r.ok) { setProblem(r.message); return; }
      setItems((prev) => (reset || !prev ? r.items : [...prev, ...r.items]));
      setNext(r.nextCursor);
      setLoaded(version);
    });
  }
  // Opened once, and read again when a newer version exists.
  const stale = items !== null && loaded !== version;
  return (
    <details className="rules__details" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open && (items === null || stale) && !pending) load(null, true); }}>
      <summary>History of this section</summary>
      {problem && <p className="scp-msg scp-msg--error" role="alert">The history cannot be shown right now. {problem}</p>}
      {items === null && !problem && <p className="scp-note" role="status">{pending ? "Loading…" : ""}</p>}
      {items !== null && items.length === 0 && <p className="scp-note" role="status">Nobody has changed this section yet.</p>}
      {items !== null && items.length > 0 && (
        <ol className="rules__history">
          {items.map((i) => (
            <li key={i.version}>
              Version {i.version}. Changed by {i.editedBy.name || "a person who is no longer listed"} on {formatDateTime(i.effectiveFrom)}: {historyWords(i)}
            </li>
          ))}
        </ol>
      )}
      {next && <button type="button" className="scp-link" onClick={() => load(next, false)} disabled={pending}>{pending ? "Loading…" : "Show older changes"}</button>}
    </details>
  );
}
