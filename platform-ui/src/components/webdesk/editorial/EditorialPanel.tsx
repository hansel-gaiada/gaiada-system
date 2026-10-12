"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addCommentAction, approveAction, assignAction, loadEditorialStateAction, requestChangesAction, resolveCommentAction, seoSignoffAction,
  submitForReviewAction, withdrawFromReviewAction, type EditorialAck, type EditorialScope,
} from "@/lib/webdeskEditorialActions";
import { authorLabel, type ItemEditorial, type WdResult } from "@/lib/webdeskContentModel";
import {
  doneWords, editorialActionsFor, editorialRefusalCopy, eventWords, lastEvent, reviewStateInfo,
  type EditorialCommand, type EditorialInitial, type EditorialState,
} from "@/lib/webdeskEditorialModel";
import { formatDateTime } from "@/lib/format";
import { EditorialComments } from "./EditorialComments";
import { ReviewStateChip } from "./ReviewStateChip";
import "./editorial.css";

// The editor's review panel (M5-W2e, writers' room design §8): the item's review state in words, who has it, the versions in play, and
// the review actions. EVERY action comes from `editorialActionsFor(editorial, allowed)`: the item read's `allowed` is the only source
// of "may I", never a role. With no `allowed` the panel offers nothing and says why. Each refusal is shown in words
// (`editorialRefusalCopy`), the state is re-read after a write and after a refusal that means "it moved", and a re-read that fails
// is said, not hidden.

const NOTE_MAX = 2000;

/** A fresh idempotency key: one per user intent (the same intent retried reuses it, so a lost answer cannot double a write). */
function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

const dayOf = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "");
const isoOfDay = (day: string): string | null => (day === "" ? null : `${day}T00:00:00.000Z`);

export function EditorialPanel({
  scope, itemId, version, dirty, blocked, initial, authors, refreshKey,
}: {
  scope: EditorialScope;
  itemId: string;
  /** The version the editor is on (the saved head): what "submit" names. */
  version: number;
  /** Unsaved edits: submit, SEO sign-off and approve act on the SAVED version, so they wait until the edits are saved. */
  dirty: boolean;
  /** The editor cannot reach WebDesk (stale / unconfirmed / deleted): every command waits, with this reason. */
  blocked: string | null;
  initial: EditorialInitial;
  authors: Record<string, string>;
  /** Changes whenever the editor re-read the item (a refresh, or a save): the panel re-reads with it. */
  refreshKey: string;
}) {
  const [st, setSt] = useState<EditorialInitial>(initial);
  const [busy, setBusy] = useState<EditorialCommand | "refresh" | null>(null);
  const [form, setForm] = useState<null | "requestChanges" | "assign">(null);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [stale, setStale] = useState<string | null>(null);
  const keyRef = useRef<{ intent: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const reload = useCallback(async (): Promise<boolean> => {
    let r: WdResult<EditorialState>;
    try { r = await loadEditorialStateAction(scope, itemId); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (!mounted.current) return false;
    if (r.kind === "ok") {
      setSt({ editorial: r.data.editorial, allowed: r.data.allowed, history: r.data.history, historyProblem: r.data.historyProblem });
      setStale(null);
      return true;
    }
    setStale(r.kind === "forbidden" ? "You can no longer read this item's review state." : r.kind === "unavailable" ? "WebDesk can't be reached." : "The review state couldn't be read.");
    return false;
  }, [scope, itemId]);

  // The editor re-read the item (or saved a version): read the review state again. Skips the first render (the page loaded it).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    void reload();
  }, [refreshKey, reload]);

  const editorial = st.editorial;
  const set = editorialActionsFor(editorial, st.allowed);
  const frozen = blocked !== null || stale !== null;
  const frozenWhy = blocked ?? (stale !== null ? "Disabled until the review state can be read again." : null);
  const working = busy !== null;
  const submitted = editorial?.submittedVersion ?? null;

  const run = async (command: EditorialCommand, intent: string, call: (idem: string) => Promise<WdResult<EditorialAck>>): Promise<boolean> => {
    if (busy) return false;
    setBusy(command); setMsg(null);
    if (!keyRef.current || keyRef.current.intent !== intent) keyRef.current = { intent, key: newKey() };
    let r: WdResult<EditorialAck>;
    try { r = await call(keyRef.current.key); } catch { r = { kind: "unavailable", code: "network", reason: "network" }; }
    if (!mounted.current) return false;
    if (r.kind === "ok") {
      keyRef.current = null;
      setMsg({ tone: "ok", text: doneWords(command) });
      setForm(null); setNote("");
      await reload();
      if (mounted.current) setBusy(null);
      return true;
    }
    // A definite answer closes the intent; an unavailable (or unconfirmed) one keeps its key so a retry cannot double the write.
    if (r.kind !== "unavailable") keyRef.current = null;
    setMsg({ tone: "bad", text: editorialRefusalCopy(command, r) });
    // "It moved" or "it is gone": the buttons on screen may be wrong now, so read again.
    if (r.kind === "conflict" || r.kind === "not_found" || r.kind === "forbidden") await reload();
    if (mounted.current) setBusy(null);
    return false;
  };

  const doSubmit = () => run("submit", `submit:${version}`, (k) => submitForReviewAction(scope, itemId, version, k));
  const doWithdraw = () => run("withdraw", "withdraw", (k) => withdrawFromReviewAction(scope, itemId, k));
  const doSeo = () => submitted !== null && run("seoSignoff", `seo:${submitted}`, (k) => seoSignoffAction(scope, itemId, submitted, k));
  const doApprove = () => submitted !== null && run("approve", `approve:${submitted}`, (k) => approveAction(scope, itemId, submitted, k));
  const doRequestChanges = () => submitted !== null && run("requestChanges", `rc:${submitted}:${note.trim()}`, (k) => requestChangesAction(scope, itemId, submitted, note, k));

  const info = editorial ? reviewStateInfo(editorial.state) : null;
  const noteOk = note.trim().length > 0 && note.trim().length <= NOTE_MAX;

  // ── what to say when something blocks an action that IS allowed (words next to the button, never a silent disable) ──
  const lacksSubmitted = submitted === null;
  const needsSave = dirty && (set.submit || set.seoSignoff || set.approve);
  const blockWhy: string | null = set.why !== null ? null
    : frozenWhy
      ?? (needsSave ? (set.submit ? "Save your changes first: submitting sends the saved version." : "Save your changes first: this acts on the saved version.") : null)
      ?? set.approveBlockedWhy;

  const hist = st.history;
  const submitEv = hist ? lastEvent(hist.events, "review.submitted") : null;
  const assignEv = hist ? lastEvent(hist.events, "review.assigned") : null;
  const who = (sub: string | null | undefined): string => (sub ? authorLabel(sub, authors) : "nobody");

  return (
    <section className="wc-side-card" aria-labelledby="we-panel-h" data-testid="editorial-panel">
      <h3 id="we-panel-h">Review</h3>

      {editorial && info ? (
        <>
          <div>
            <ReviewStateChip state={editorial.state} />
            <p className="wc-publish__sub" data-testid="review-sentence">{editorial.reviewRequired ? info.sentence : `${info.sentence} Review is not turned on for this collection.`}</p>
          </div>

          <dl className="wc-kv" data-testid="review-facts">
            <dt>Author</dt><dd data-testid="review-author">{editorial.authorSub === undefined ? "unknown" : who(editorial.authorSub)}</dd>
            <dt>Submitted</dt>
            <dd data-testid="review-submitted">
              {submitted !== null ? `v${submitted}` : "not submitted"}
              {submitEv ? ` by ${who(submitEv.actorSub)}, ${formatDateTime(submitEv.createdAt)}` : ""}
            </dd>
            {editorial.seoSignoffRequired === true && (
              <>
                <dt>SEO sign-off</dt>
                <dd data-testid="review-seo">
                  {editorial.seoSignedVersion === null || editorial.seoSignedVersion === undefined
                    ? "required, not signed off"
                    : editorial.seoSignedCurrent === true
                      ? `signed off v${editorial.seoSignedVersion}${editorial.seoSignedBy ? ` by ${who(editorial.seoSignedBy)}` : ""}`
                      : `v${editorial.seoSignedVersion} was signed off, but v${submitted ?? "?"} is in review now: required again`}
                </dd>
              </>
            )}
            <dt>Approved</dt>
            <dd data-testid="review-approved">
              {editorial.approvedVersion === null ? "not approved" : `v${editorial.approvedVersion}`}
              {editorial.approvedVersion !== null && editorial.approvedBy ? ` by ${who(editorial.approvedBy)}` : ""}
              {editorial.approvedVersion !== null && editorial.approvedAt ? `, ${formatDateTime(editorial.approvedAt)}` : ""}
              {editorial.approvedVersion !== null && editorial.approvedIsHead === false ? ". Edited since: the draft is newer than the approved version" : ""}
            </dd>
            {assignEv && (<><dt>Assigned by</dt><dd data-testid="review-assigned-by">{who(assignEv.actorSub)}, {formatDateTime(assignEv.createdAt)}</dd></>)}
            {editorial.dueAt ? (<><dt>Due</dt><dd>{formatDateTime(editorial.dueAt)}</dd></>) : null}
            {editorial.plannedPublishAt ? (<><dt>Planned</dt><dd>{formatDateTime(editorial.plannedPublishAt)}</dd></>) : null}
            {editorial.briefRef ? (<><dt>Brief</dt><dd className="wc-mono">{editorial.briefRef}</dd></>) : null}
          </dl>
        </>
      ) : (
        <p className="we-why" role="note" data-testid="review-unknown">WebDesk did not report this item&apos;s review state. This is not a statement that it is a draft.</p>
      )}

      {stale !== null && (
        <div className="wc-banner wc-banner--warn" role="status" data-testid="review-stale">
          <span className="wc-banner__body"><strong>Couldn&apos;t refresh the review state.</strong> {stale} What you see may be out of date.</span>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={async () => { setBusy("refresh"); await reload(); if (mounted.current) setBusy(null); }} disabled={working} data-testid="review-refresh">Try again</button>
        </div>
      )}

      {msg && (
        <div className={`wc-banner wc-banner--${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"} data-testid={msg.tone === "bad" ? "review-refusal" : "review-done"}>
          <span className="wc-banner__body">{msg.text}</span>
        </div>
      )}

      {/* ── actions: exactly what `allowed` + the state allow, and nothing else ── */}
      {set.why !== null ? (
        <p className="we-why" role="note" data-testid="review-why">{set.why}</p>
      ) : (
        <div className="we-actions" role="group" aria-label="Review actions" data-testid="review-actions">
          {set.submit && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={doSubmit} disabled={working || frozen || dirty} aria-describedby={blockWhy ? "we-block-why" : undefined} data-testid="act-submit">
              {editorial?.state === "changes_requested" ? "Send for review again" : "Submit for review"}
            </button>
          )}
          {set.withdraw && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={doWithdraw} disabled={working || frozen} data-testid="act-withdraw">Withdraw from review</button>
          )}
          {set.requestChanges && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setForm(form === "requestChanges" ? null : "requestChanges")} disabled={working || frozen || lacksSubmitted} aria-expanded={form === "requestChanges"} data-testid="act-request-changes">Request changes…</button>
          )}
          {set.seoSignoff && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={doSeo} disabled={working || frozen || dirty || lacksSubmitted} aria-describedby={blockWhy ? "we-block-why" : undefined} data-testid="act-seo-signoff">Sign off SEO and AEO</button>
          )}
          {set.approve && (
            <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={doApprove} disabled={working || frozen || dirty || lacksSubmitted || set.approveBlockedWhy !== null} aria-describedby={blockWhy ? "we-block-why" : undefined} data-testid="act-approve">Approve v{submitted ?? "?"}</button>
          )}
          {set.assign && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setForm(form === "assign" ? null : "assign")} disabled={working || frozen} aria-expanded={form === "assign"} data-testid="act-assign">Assign…</button>
          )}
        </div>
      )}
      {blockWhy && <p id="we-block-why" className="wc-publish__sub" data-testid="review-block-why">{blockWhy}</p>}

      {form === "requestChanges" && set.requestChanges && (
        <form className="we-form" onSubmit={(e) => { e.preventDefault(); if (noteOk && !working) void doRequestChanges(); }} aria-label="Request changes" data-testid="rc-form">
          <div className="lux-field">
            <label className="lux-field__label lux-field__label--req" htmlFor="we-rc-note">What needs to change?</label>
            <textarea id="we-rc-note" className="lux-field__control lux-field__control--textarea" rows={4} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} data-testid="rc-note" />
            <span className="lux-field__hint">The author sees this note. {NOTE_MAX - note.length} characters left.</span>
          </div>
          <div className="we-actions">
            <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!noteOk || working || frozen} data-testid="rc-send">Send back to the author</button>
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setForm(null); setNote(""); }}>Cancel</button>
          </div>
        </form>
      )}

      {form === "assign" && set.assign && (
        <AssignForm
          editorial={editorial} authors={authors} busy={working || frozen}
          onSave={(input) => run("assign", `assign:${JSON.stringify(input)}`, (k) => assignAction(scope, itemId, input, k))}
          onCancel={() => setForm(null)}
        />
      )}

      <EditorialComments
        comments={hist ? hist.comments : null}
        truncated={hist?.commentsTruncated ?? false}
        problem={st.historyProblem}
        canAdd={set.comment}
        canResolve={set.comment}
        busy={working || frozen}
        authors={authors}
        onAdd={(body, anchor) => run("comment", `comment:${anchor ?? ""}:${body}`, (k) => addCommentAction(scope, itemId, submitted ?? version, body, anchor, k))}
        onResolve={(id) => { void run("resolve", `resolve:${id}`, (k) => resolveCommentAction(scope, itemId, id, k)); }}
      />

      {hist && hist.events.length > 0 && (
        <details className="we-details" data-testid="review-log">
          <summary>Review log ({hist.events.length}{hist.eventsTruncated ? "+" : ""})</summary>
          <ol className="we-log">
            {[...hist.events].reverse().map((e) => (
              <li key={e.id}>{formatDateTime(e.createdAt)}: {who(e.actorSub)} {eventWords(e.kind)}{e.version !== null ? ` (v${e.version})` : ""}{e.note ? ` — "${e.note}"` : ""}</li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

// ── Assign ───────────────────────────────────────────────────────────────────────────────────────

function AssignForm({
  editorial, authors, busy, onSave, onCancel,
}: {
  editorial: ItemEditorial | undefined;
  authors: Record<string, string>;
  busy: boolean;
  onSave: (input: { authorSub?: string; dueAt?: string | null; plannedPublishAt?: string | null; briefRef?: string | null }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [author, setAuthor] = useState(editorial?.authorSub ?? "");
  const [due, setDue] = useState(dayOf(editorial?.dueAt));
  const [planned, setPlanned] = useState(dayOf(editorial?.plannedPublishAt));
  const [brief, setBrief] = useState(editorial?.briefRef ?? "");

  const people = Object.entries(authors).sort((a, b) => a[1].localeCompare(b[1]));
  // Only what changed is sent (the BFF wants at least one member, and an unchanged one is noise); clearing a date or the brief sends null.
  const input: { authorSub?: string; dueAt?: string | null; plannedPublishAt?: string | null; briefRef?: string | null } = {};
  if (author !== "" && author !== (editorial?.authorSub ?? "")) input.authorSub = author;
  if (due !== dayOf(editorial?.dueAt)) input.dueAt = isoOfDay(due);
  if (planned !== dayOf(editorial?.plannedPublishAt)) input.plannedPublishAt = isoOfDay(planned);
  if (brief.trim() !== (editorial?.briefRef ?? "")) input.briefRef = brief.trim() === "" ? null : brief.trim();
  const changed = Object.keys(input).length > 0;

  return (
    <form className="we-form" onSubmit={(e) => { e.preventDefault(); if (changed && !busy) void onSave(input); }} aria-label="Assign" data-testid="assign-form">
      <div className="lux-field">
        <label className="lux-field__label" htmlFor="we-as-author">Assign to</label>
        <select id="we-as-author" className="lux-field__control" value={author} onChange={(e) => setAuthor(e.target.value)} data-testid="assign-author">
          <option value="">{editorial?.authorSub ? "Keep the current author" : "Nobody yet"}</option>
          {people.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>
      <div className="we-form__row">
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="we-as-due">Due</label>
          <input id="we-as-due" type="date" className="lux-field__control" value={due} onChange={(e) => setDue(e.target.value)} data-testid="assign-due" />
        </div>
        <div className="lux-field">
          <label className="lux-field__label" htmlFor="we-as-plan">Planned publish</label>
          <input id="we-as-plan" type="date" className="lux-field__control" value={planned} onChange={(e) => setPlanned(e.target.value)} data-testid="assign-planned" />
        </div>
      </div>
      <div className="lux-field">
        <label className="lux-field__label" htmlFor="we-as-brief">Brief reference</label>
        <input id="we-as-brief" className="lux-field__control" maxLength={200} value={brief} onChange={(e) => setBrief(e.target.value)} data-testid="assign-brief" />
      </div>
      <div className="we-actions">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={!changed || busy} data-testid="assign-save">Save assignment</button>
        <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
