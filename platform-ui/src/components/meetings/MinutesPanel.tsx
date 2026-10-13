"use client";
import { useId, useRef, useState } from "react";
import {
  MAX_MINUTES_CHARS, canOfferShare, minutesFrozen, type MinutesResult, type MinutesView,
} from "@/lib/meetingMinutes";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { ConfirmDialog } from "@/components/clients/conversation/ConfirmDialog";
import { formatDateTime } from "@/lib/format";
import "@/components/clients/conversation/conversation.css";

// PV4-09 — the minutes of a meeting: written as a DRAFT, then shared with the meeting's client on purpose (BFF §29c).
//
//   - Save keeps it a draft however often it is saved; nothing reaches the client until "Share with client";
//   - Share names the client in a confirm, because the client's contacts are told and can read it at once;
//   - once shared the minutes are FROZEN: the editor is read-only and says "Shared on <date> by <name>". There is no
//     unshare (a client may already have read them), and the platform answers a later save with 409;
//   - a meeting with no client cannot be shared, so the control is not offered at all.
// The marker is the backend's `clientVisible`, rendered from the field only (trap 9).
export interface MinutesActions {
  save: (meetingId: string, bodyMd: string) => Promise<MinutesResult>;
  share: (meetingId: string) => Promise<MinutesResult>;
}

export function MinutesPanel({
  meetingId, clientName, initial, canWrite, actions,
}: {
  meetingId: string;
  clientName: string;
  initial: MinutesView;
  /** Cosmetic: the platform decides who may edit (`update`) and share (`share_minutes`). */
  canWrite: boolean;
  actions: MinutesActions;
}) {
  const id = useId();
  const [view, setView] = useState<MinutesView>(initial);
  const [body, setBody] = useState(initial.minutes?.bodyMd ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const m = view.minutes;
  const frozen = minutesFrozen(m);
  const saved = m?.bodyMd ?? "";
  const dirty = body !== saved;
  const over = body.length > MAX_MINUTES_CHARS;

  const apply = (r: MinutesResult, then?: () => void): boolean => {
    if (!r.ok) { setError(r.error); return false; }
    setView(r.view);
    setBody(r.view.minutes?.bodyMd ?? "");
    then?.();
    return true;
  };

  const save = async () => {
    if (over) { setError(`Minutes can be at most ${MAX_MINUTES_CHARS.toLocaleString("en-GB")} characters.`); return; }
    setBusy(true); setError(null); setNote(null);
    try { apply(await actions.save(meetingId, body), () => setNote("Draft saved. The client can't see it yet.")); }
    finally { setBusy(false); }
  };

  const share = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      const ok = apply(await actions.share(meetingId), () => setNote(`Shared with ${clientName}.`));
      if (ok) {
        setConfirming(false);
        // The editor went read-only: move focus to the status line so the next screen-reader stop is the outcome.
        requestAnimationFrame(() => statusRef.current?.focus());
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="cv-minutes">
      <div className="cv-row">
        <span style={{ font: "600 13px var(--font-body)" }}>{frozen ? "Shared minutes" : "Minutes (draft)"}</span>
        <ClientVisibilityMarker clientVisible={m?.clientVisible} />
      </div>

      {frozen && m ? (
        <p className="cv-frozen" tabIndex={-1} ref={statusRef}>
          Shared on {formatDateTime(m.sharedAt)} by {m.sharedByName ?? "a teammate"}. The client can read them in their portal, so they can no longer be edited.
        </p>
      ) : (
        <p className="cv-help" tabIndex={-1} ref={statusRef}>
          {view.clientId
            ? `Only our team sees a draft. Share it with ${clientName} when it is ready.`
            : "This meeting has no client, so its minutes stay internal."}
        </p>
      )}

      <div className="cv-field">
        <label className="cv-field__label" htmlFor={`${id}-body`}>Minutes</label>
        <textarea
          id={`${id}-body`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          readOnly={frozen || !canWrite || busy}
          aria-readonly={frozen || !canWrite}
          rows={12}
          placeholder="Decisions, who owns what, and what happens next."
        />
        {!frozen && (
          <span className={`cv-count${over ? " cv-count--over" : ""}`}>{body.length.toLocaleString("en-GB")} / {MAX_MINUTES_CHARS.toLocaleString("en-GB")}</span>
        )}
      </div>

      {error && <p className="cv-error" role="alert">{error}</p>}
      {note && <p className="cv-help" role="status">{note}</p>}

      {!frozen && canWrite && (
        <div className="cv-row">
          <button type="button" className="lux-btn lux-btn--sm" onClick={save} disabled={busy || !dirty}>Save draft</button>
          {canOfferShare(view, body) && (
            <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setError(null); setConfirming(true); }} disabled={busy || dirty}>
              Share with client
            </button>
          )}
          {dirty && canOfferShare(view, body) && <span className="cv-help">Save the draft before sharing it.</span>}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={`Share these minutes with ${clientName}?`}
        confirmLabel={`Share with ${clientName}`}
        onConfirm={share}
        onCancel={() => setConfirming(false)}
        busy={busy}
        error={error}
      >
        <p style={{ margin: 0 }}>
          {clientName}&apos;s contacts will be notified and can read these minutes in their portal straight away. Only the minutes are shared: never the recording, the transcript or the attendee list.
        </p>
        <p style={{ margin: 0 }}><strong>Once shared, the minutes can&apos;t be edited or taken back.</strong></p>
      </ConfirmDialog>
    </div>
  );
}
