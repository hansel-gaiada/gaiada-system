"use client";
import { useEffect, useId, useRef, useState } from "react";
import { assistAction, type AssistScope } from "@/lib/webdeskAssistActions";
import {
  applyOptions, applySuggestion, assistFailureCopy, ASSIST_KIND_INFO, ASSIST_KINDS, copyTextOf, FIRST_DRAFT_NOTICE, suggestionTitle,
  type ApplyCtx, type AssistBody, type AssistFailure, type AssistKind, type AssistSuggestion, type DraftState,
} from "@/lib/webdeskAssistModel";
import type { ItemAllowed } from "@/lib/webdeskContentModel";
import "./assist.css";

// The editor's writing assistant (M5-W6, writers' room design §5). A drawer in the editor's side rail with five plain actions. It
// SUGGESTS; it never saves or publishes:
//   - the drawer is offered ONLY when the item read's `allowed.update` is true (absent = not offered, never guessed from a role);
//   - each suggestion has an explicit Apply, which hands the editor a NEW draft (`onApply`) to hold as an UNSAVED edit, and a Copy;
//   - a translated draft says "First draft — needs a human" and applies only where the editor already has that locale's field
//     (otherwise Copy only, with the reason beside it);
//   - every typed failure is said in words (`assistFailureCopy`); the call can be cancelled (the answer is then ignored: the request
//     itself cannot be recalled, and the words say so);
//   - suggestion text goes nowhere but the screen and, at the user's click, the clipboard: no logging, no analytics.
// The BFF checks `update` on the item again before it looks at the request; this file only decides what to OFFER.

type Run =
  | { s: "idle" }
  | { s: "running"; kind: AssistKind }
  | { s: "done"; kind: AssistKind; body: AssistBody; dirtyAtRun: boolean; seq: number }
  | { s: "failed"; kind: AssistKind; failure: AssistFailure }
  | { s: "cancelled"; kind: AssistKind };

export function AssistDrawer({
  scope, itemId, allowed, baseVersion, dirty, ctx, applyBlocked, onApply,
}: {
  scope: AssistScope;
  itemId: string;
  /** The item read's `allowed`. Absent, or without `update: true`, and nothing is rendered. */
  allowed: ItemAllowed | undefined;
  /** The version the editor is on (suggestions are made from the last SAVED head, never from unsaved edits). */
  baseVersion: number;
  /** The editor holds unsaved edits. */
  dirty: boolean;
  /** What a suggestion may change: the form's fields, the draft, the locale. */
  ctx: ApplyCtx;
  /** Why applying is off right now (read-only, stale, outcome unknown); null when it is on. */
  applyBlocked: string | null;
  /** Hand the editor the new draft. It is held as an unsaved edit; the drawer never saves. */
  onApply: (next: DraftState) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<Run>({ s: "idle" });
  const seqRef = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (allowed?.update !== true) return null;

  const start = async (kind: AssistKind) => {
    const seq = ++seqRef.current;
    const dirtyAtRun = dirty;
    setRun({ s: "running", kind });
    let r: Awaited<ReturnType<typeof assistAction>>;
    try {
      r = await assistAction(scope, itemId, kind);
    } catch {
      r = { ok: false, failure: { kind: "unreachable" } };
    }
    // A cancelled (or superseded, or unmounted) call's answer is dropped on the floor.
    if (!mounted.current || seqRef.current !== seq) return;
    setRun(r.ok ? { s: "done", kind, body: r.data, dirtyAtRun, seq } : { s: "failed", kind, failure: r.failure });
  };

  const cancel = () => {
    if (run.s !== "running") return;
    seqRef.current += 1;
    setRun({ s: "cancelled", kind: run.kind });
  };

  const running = run.s === "running";
  const panelId = `${uid}-panel`;

  return (
    <section className="wc-side-card wc-assist" aria-labelledby={`${uid}-h`} data-testid="assist-drawer">
      <h3 id={`${uid}-h`}>Assist</h3>
      <button
        type="button" className="lux-btn lux-btn--ghost lux-btn--sm" aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((o) => !o)} data-testid="assist-toggle"
      >
        {open ? "Close the writing assistant" : "Open the writing assistant"}
      </button>

      {open && (
        <div id={panelId} className="wc-assist__panel" role="region" aria-label="Writing assistant" data-testid="assist-panel">
          <p className="wc-publish__sub">
            Suggestions only. Nothing is applied or saved until you choose Apply, and then Save. They are made from the last saved version{dirty ? ", not from your unsaved edits" : ""}.
          </p>

          <ul className="wc-assist__kinds" aria-label="What to suggest">
            {ASSIST_KINDS.map((k) => (
              <li key={k}>
                <button
                  type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void start(k)} disabled={running}
                  aria-describedby={`${uid}-${k}-hint`} data-testid={`assist-run-${k}`}
                >
                  {ASSIST_KIND_INFO[k].label}
                </button>
                <span id={`${uid}-${k}-hint`} className="wc-assist__hint">{ASSIST_KIND_INFO[k].hint}</span>
              </li>
            ))}
          </ul>

          {run.s === "running" && (
            <div className="wc-banner wc-banner--info" role="status" data-testid="assist-running">
              <span className="wc-banner__body">Asking the assistant for {ASSIST_KIND_INFO[run.kind].label.toLowerCase()}…</span>
              <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={cancel} data-testid="assist-cancel">Cancel</button>
            </div>
          )}

          {run.s === "cancelled" && (
            <div className="wc-banner wc-banner--info" role="status" data-testid="assist-cancelled">
              <span className="wc-banner__body">Cancelled. Nothing was changed. The request may already have counted toward today&apos;s allowance.</span>
            </div>
          )}

          {run.s === "failed" && (
            <div className="wc-banner wc-banner--bad" role="alert" data-testid="assist-error" data-failure={run.failure.kind}>
              <span className="wc-banner__body">{assistFailureCopy(run.failure)}</span>
            </div>
          )}

          {run.s === "done" && (
            <Results
              key={run.seq} body={run.body} dirtyAtRun={run.dirtyAtRun} baseVersion={baseVersion} ctx={ctx} applyBlocked={applyBlocked} onApply={onApply}
            />
          )}
        </div>
      )}
    </section>
  );
}

function Results({
  body, dirtyAtRun, baseVersion, ctx, applyBlocked, onApply,
}: {
  body: AssistBody; dirtyAtRun: boolean; baseVersion: number; ctx: ApplyCtx; applyBlocked: string | null; onApply: (next: DraftState) => void;
}) {
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<Record<string, boolean>>({});
  const [picked, setPicked] = useState<Record<string, string>>({});
  const copyTimers = useRef<number[]>([]);
  useEffect(() => () => { for (const t of copyTimers.current) window.clearTimeout(t); }, []);

  const info = ASSIST_KIND_INFO[body.kind];
  const stale: string[] = [];
  if (body.version !== null && body.headVersion !== null && body.headVersion > body.version) {
    stale.push(`These suggestions were made from v${body.version}, but the latest saved version is v${body.headVersion}. Check them against the current text.`);
  }
  if (body.version !== null && body.version !== baseVersion && !(body.headVersion !== null && body.headVersion > body.version)) {
    stale.push(`These suggestions were made from v${body.version}; this editor is on v${baseVersion}. Check them against your text.`);
  }
  if (dirtyAtRun) stale.push("You had unsaved edits when you asked, and the assistant does not see them. Check the suggestions against your current text.");

  const apply = (s: AssistSuggestion, targetKey: string) => {
    const out = applySuggestion(s, targetKey, ctx);
    if (!out.ok) { setErrors((e) => ({ ...e, [s.id]: out.message })); return; }
    setErrors((e) => { const { [s.id]: _gone, ...rest } = e; return rest; });
    setApplied((a) => new Set(a).add(s.id));
    onApply(out.draft);
  };

  const copy = async (s: AssistSuggestion) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(copyTextOf(s));
    } catch {
      ok = false;
    }
    setCopied((c) => ({ ...c, [s.id]: ok }));
    if (ok) copyTimers.current.push(window.setTimeout(() => setCopied((c) => { const { [s.id]: _gone, ...rest } = c; return rest; }), 2500));
  };

  const notice = body.kind === "translate_draft" ? (body.notice ?? FIRST_DRAFT_NOTICE) : body.notice;

  return (
    <div className="wc-assist__results" data-testid="assist-results" data-kind={body.kind}>
      <h4 className="wc-assist__h">{info.label}: {body.suggestions.length} suggestion{body.suggestions.length === 1 ? "" : "s"}</h4>
      {notice && <p className="wc-assist__notice" role="note" data-testid="assist-notice">{notice}</p>}
      {stale.map((t, i) => <p key={i} className="wc-assist__why" role="note" data-testid="assist-stale">{t}</p>)}
      {body.usage && body.usage.callsUsed !== null && body.usage.callsLimit !== null && (
        <p className="wc-assist__hint" data-testid="assist-usage">Today: {body.usage.callsUsed} of {body.usage.callsLimit} suggestion requests used (resets at 00:00 UTC).</p>
      )}

      <ol className="wc-assist__list">
        {body.suggestions.map((s) => {
          const opts = applyOptions(s, ctx);
          const target = picked[s.id] && opts.targets.some((t) => t.key === picked[s.id]) ? picked[s.id] : opts.targets[0]?.key;
          const done = applied.has(s.id);
          return (
            <li key={s.id} className="wc-assist__item" data-testid={`suggestion-${s.id}`} data-kind={s.kind}>
              <p className="wc-assist__title">{suggestionTitle(s)}</p>
              {s.kind === "translate_draft" && <p className="wc-assist__notice" data-testid={`first-draft-${s.id}`}>{s.notice || FIRST_DRAFT_NOTICE}</p>}
              <SuggestionBody s={s} />

              <div className="wc-assist__actions">
                {opts.targets.length > 1 && (
                  <select
                    className="lux-field__control wc-assist__where" aria-label="Where to add it" value={target}
                    onChange={(e) => setPicked((p) => ({ ...p, [s.id]: e.target.value }))} data-testid={`apply-target-${s.id}`}
                  >
                    {opts.targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                  </select>
                )}
                {opts.targets.length > 0 && target !== undefined && (
                  <button
                    type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => apply(s, target)}
                    disabled={applyBlocked !== null || done} data-testid={`apply-${s.id}`}
                  >
                    {opts.targets.length === 1 ? opts.targets[0].label : "Apply"}
                  </button>
                )}
                <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => void copy(s)} data-testid={`copy-${s.id}`}>Copy</button>
              </div>

              {opts.targets.length === 0 && opts.why && <p className="wc-assist__why" role="note" data-testid={`apply-why-${s.id}`}>{opts.why}</p>}
              {opts.targets.length > 0 && applyBlocked && !done && <p className="wc-assist__why" role="note" data-testid={`apply-blocked-${s.id}`}>{applyBlocked}</p>}
              {done && <p className="wc-assist__done" role="status" data-testid={`applied-${s.id}`}>Applied to the form. Not saved yet: review it, then Save.</p>}
              {errors[s.id] && <p className="wc-assist__fail" role="alert" data-testid={`apply-error-${s.id}`}>{errors[s.id]}</p>}
              {copied[s.id] === true && <p className="wc-assist__done" role="status" data-testid={`copied-${s.id}`}>Copied.</p>}
              {copied[s.id] === false && <p className="wc-assist__fail" role="alert" data-testid={`copy-failed-${s.id}`}>Couldn&apos;t copy. Select the text above and copy it yourself.</p>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SuggestionBody({ s }: { s: AssistSuggestion }) {
  switch (s.kind) {
    case "meta_description":
      return <p className="wc-assist__text" data-testid="suggestion-text">{s.text}</p>;
    case "outline":
      return (
        <ul className="wc-assist__outline" data-testid="suggestion-text">
          {s.headings.map((h, i) => <li key={i} className={`wc-assist__h${h.level === 3 ? "3" : "2"}`}><span className="wc-assist__lvl">H{h.level}</span> {h.text}</li>)}
        </ul>
      );
    case "faq":
      return <p className="wc-assist__text" data-testid="suggestion-text">{s.answer}</p>;
    case "translate_draft":
      return <p className="wc-assist__text" data-testid="suggestion-text">{s.text}</p>;
    case "alt_text":
      return <p className="wc-assist__text" data-testid="suggestion-text">{s.alt}</p>;
  }
}
