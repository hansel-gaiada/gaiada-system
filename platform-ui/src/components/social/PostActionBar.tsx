"use client";
// SCP-1e, 1g, 1j (BFF §63.6.5) — the post page's action bar and the small dialogs behind it.
//
// THE BAR IS THE READ'S `actions[]`. Every action the server lists is a button: an allowed one is live and `nextAction` is the primary (solid) button; a
// disallowed one is DISABLED with the reason in words beside it (`reasonWords`, one map for every code of the fixture). What exists, and for whom, is the
// server's: this file adds no rule. Each click posts `POST posts/:postId/actions` with `expectedStatus` (the step the page showed) and a fresh `actionId`.
//
// Params come from small dialogs, validated here with the fixture's own rules (`buildActionParams`) so a person is told before the round trip; the server
// checks again and decides, and every refusal comes back in words, with a 409's `blockers`. An action with no params posts straight away. `send_to_proofread`
// shows the read's `checks[]` first when any fail: the hard ones can never be skipped, the soft ones can be "sent anyway" with a reason of 10 to 500 characters.
import { useId, useState, useTransition } from "react";
import { Modal } from "@/components/overlay/Modal";
import { PinOverlay } from "@/components/social/PinOverlay";
import { RefusalNote } from "@/components/social/PostRefusal";
import { formatDateTime } from "@/lib/format";
import { runPostAction, type WriteResult } from "@/lib/socialPipelineActions";
import {
  ACTION_DIALOG, ACTION_LABEL, CHANGE_KIND_LABEL, CHANGE_KINDS, CHANNEL_LABEL, CHANNELS, FOLLOW_UP_NOTE_MAX, NETWORKS, NOTE_MAX, REASON_MAX, SEND_ANYWAY_MAX, SEND_ANYWAY_MIN,
  WAITING_ON, WAITING_ON_LABEL, buildActionParams, isoToZoneInput, networkLabel, newActionId, reasonWords, zoneInputToIso,
  type DialogInput, type PipelinePost, type PostImage,
} from "@/lib/socialPipeline";
import type { CommentAnchor } from "@/lib/pm";

type Failed = Extract<WriteResult, { ok: false }>;

export function PostActionBar({ post, image, onResult }: { post: PipelinePost; image: PostImage | null; onResult: (r: WriteResult, label: string) => void }) {
  const uid = useId();
  const [dialog, setDialog] = useState<string | null>(null);
  const [error, setError] = useState<Failed | null>(null);
  const [pending, start] = useTransition();

  // `accept_suggestion` is a per-field button on the suggestion itself (the Post tab), not a bar button.
  const rows = post.actions.filter((a) => a.action !== "accept_suggestion");
  const allowed = rows.filter((a) => a.allowed).sort((a, b) => Number(b.action === post.nextAction) - Number(a.action === post.nextAction));
  const off = rows.filter((a) => !a.allowed);

  function send(action: string, params: Record<string, unknown>) {
    setError(null);
    start(async () => {
      const r = await runPostAction(post.id, { action, expectedStatus: post.pipelineStatus, actionId: newActionId(), ...params });
      onResult(r, ACTION_LABEL[action] ?? action);
      if (r.ok) setDialog(null);
      else setError(r);
    });
  }

  function click(action: string) {
    setError(null);
    const needsDialog = ACTION_DIALOG[action] !== null && !(action === "send_to_proofread" && post.checks.every((c) => c.ok));
    if (needsDialog) setDialog(action);
    else send(action, {});
  }

  return (
    <section className="scp-actions" aria-label="Actions">
      {allowed.length > 0 ? (
        <div className="scp-actions__row">
          {allowed.map((a) => (
            <button
              key={a.action} type="button" disabled={pending} onClick={() => click(a.action)}
              className={`lux-btn lux-btn--${a.action === post.nextAction ? "solid" : "ghost"} lux-btn--sm`}
            >
              {ACTION_LABEL[a.action] ?? a.action}
            </button>
          ))}
        </div>
      ) : (
        <p className="scp-note" style={{ margin: 0 }}>Nothing on this post is yours to do right now.</p>
      )}
      {off.length > 0 && (
        <>
          <p className="scp-actions__title">Not available to you</p>
          <ul className="scp-actions__off">
            {off.map((a) => (
              <li key={a.action}>
                <button type="button" disabled aria-describedby={`${uid}-${a.action}`} className="lux-btn lux-btn--ghost lux-btn--sm">{ACTION_LABEL[a.action] ?? a.action}</button>
                <span id={`${uid}-${a.action}`} className="scp-actions__why">{reasonWords(a.reason)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!dialog && error && <RefusalNote refusal={error.refusal} message={error.message} />}
      {dialog && <ActionDialog action={dialog} post={post} image={image} pending={pending} error={error} onClose={() => { setDialog(null); setError(null); }} onSubmit={(p) => send(dialog, p)} />}
    </section>
  );
}

// ── The dialogs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TEXT_HELP: Record<string, { label: string; help: string }> = {
  return_copy: { label: "What should change?", help: "The officer sees this note and your suggestions, and fixes the copy before it comes back to you." },
  hod_changes: { label: "What should the officer change?", help: "The post goes back to the officer, and returns straight to you once they have fixed it." },
};

function ActionDialog({ action, post, image, pending, error, onClose, onSubmit }: {
  action: string; post: PipelinePost; image: PostImage | null; pending: boolean; error: Failed | null; onClose: () => void; onSubmit: (params: Record<string, unknown>) => void;
}) {
  const kind = ACTION_DIALOG[action];
  const label = ACTION_LABEL[action] ?? action;
  const approved = post.approvedSchedule;
  const [i, setI] = useState<DialogInput>({
    channel: "", changeKind: "", waitingOn: "", note: "", reason: "", url: "", sendAnyway: false, sendAnywayReason: "", anchor: null,
    placement: action === "reschedule" ? [...(approved?.placement ?? post.placement)] : [],
  });
  const [atLocal, setAtLocal] = useState(action === "reschedule" ? isoToZoneInput(approved?.scheduledAt ?? post.scheduledAt) : "");
  const [placing, setPlacing] = useState(false);
  const [local, setLocal] = useState<{ field: string; message: string } | null>(null);
  const set = (patch: Partial<DialogInput>) => { setLocal(null); setI((x) => ({ ...x, ...patch })); };

  const hardFail = post.checks.some((c) => !c.skippable && !c.ok);
  const softFail = post.checks.some((c) => c.skippable && !c.ok);
  const sendBlocked = kind === "send" && (hardFail || (softFail && !i.sendAnyway));

  function submit() {
    const at = atLocal ? zoneInputToIso(atLocal) : "";
    if (atLocal && !at) { setLocal({ field: "at", message: "Give a real date and time." }); return; }
    const r = buildActionParams(action, { ...i, at }, post);
    if (!r.ok) { setLocal({ field: r.field, message: r.message }); return; }
    onSubmit(r.params);
  }

  const pin: CommentAnchor | null = i.anchor ?? null;
  const field = (name: string) => (local?.field === name ? local.message : null);

  return (
    <Modal
      open onClose={onClose} title={label} size="md"
      footer={
        <>
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={submit} disabled={pending || sendBlocked}>{pending ? "Working…" : label}</button>
        </>
      }
    >
      <div className="scp-dialog">
        {(kind === "note") && (
          <label className="scp-field">
            {TEXT_HELP[action]?.label ?? "Note"}
            <textarea className="scp-input" value={i.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} aria-invalid={field("note") !== null} />
            <span className="scp-field__hint">{TEXT_HELP[action]?.help} Up to {NOTE_MAX} characters.</span>
          </label>
        )}

        {(kind === "change" || kind === "record_change") && (
          <fieldset className="scp-checks" aria-label="What needs to change">
            {CHANGE_KINDS.map((k) => (
              <label key={k}>
                <input type="radio" name="changeKind" value={k} checked={i.changeKind === k} onChange={() => set({ changeKind: k })} />
                {CHANGE_KIND_LABEL[k]}
              </label>
            ))}
          </fieldset>
        )}
        {(kind === "change" || kind === "record_change" || kind === "record_approve") && (
          <>
            {kind !== "change" && (
              <label className="scp-field">
                How did the client tell you?
                <select className="scp-input" value={i.channel} onChange={(e) => set({ channel: e.target.value })} aria-invalid={field("channel") !== null}>
                  <option value="">Choose…</option>
                  {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                </select>
              </label>
            )}
            <label className="scp-field">
              {kind === "record_approve" ? "Note" : "What was asked?"}
              <textarea className="scp-input" value={i.note} maxLength={NOTE_MAX} onChange={(e) => set({ note: e.target.value })} aria-invalid={field("note") !== null} />
              <span className="scp-field__hint">
                {kind === "record_approve" ? "A line on where and when they approved, for the record." : kind === "change" ? "The officer or the designer sees this note." : "The officer, and the designer for a design change, see this note."} Up to {NOTE_MAX} characters.
              </span>
            </label>
          </>
        )}
        {kind === "record_change" && (
          <div className="scp-field">
            <span>A pin on the image (optional)</span>
            {image?.fileId ? (
              <>
                <div className="scp-dialog__pins">
                  <PinOverlay
                    src={image.src} alt={image.alt} fileId={image.fileId} placing={placing}
                    pins={pin ? [{ id: "new", n: 1, anchor: pin, label: "the new pin" }] : []}
                    onPlace={(a) => { setPlacing(false); set({ anchor: { x: a.x, y: a.y, fileId: a.fileId } }); }}
                    onCancelPlace={() => setPlacing(false)}
                  />
                </div>
                <div className="scp-row__buttons">
                  <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => setPlacing(true)} disabled={placing}>{pin ? "Move the pin" : "Place a pin"}</button>
                  {pin && <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => set({ anchor: null })}>Remove the pin</button>}
                </div>
                {pin && <span className="scp-field__hint">{`Pinned at ${Math.round(pin.x * 100)}%, ${Math.round(pin.y * 100)}% on the image.`}</span>}
              </>
            ) : (
              <span className="scp-field__hint">A pin needs a stored design, and this post has none yet.</span>
            )}
          </div>
        )}

        {kind === "block" && (
          <>
            <label className="scp-field">
              Why is it blocked?
              <textarea className="scp-input" value={i.reason} maxLength={REASON_MAX} onChange={(e) => set({ reason: e.target.value })} aria-invalid={field("reason") !== null} />
              <span className="scp-field__hint">For example, waiting for the client&rsquo;s photos. 3 to {REASON_MAX} characters.</span>
            </label>
            <label className="scp-field">
              Who are we waiting on?
              <select className="scp-input" value={i.waitingOn} onChange={(e) => set({ waitingOn: e.target.value })} aria-invalid={field("waitingOn") !== null}>
                <option value="">Choose…</option>
                {WAITING_ON.map((w) => <option key={w} value={w}>{WAITING_ON_LABEL[w]}</option>)}
              </select>
              <span className="scp-field__hint">Resolving it returns the post to the step it left.</span>
            </label>
          </>
        )}

        {kind === "archive" && (
          <label className="scp-field">
            Why archive it?
            <textarea className="scp-input" value={i.reason} maxLength={REASON_MAX} onChange={(e) => set({ reason: e.target.value })} aria-invalid={field("reason") !== null} />
            <span className="scp-field__hint">The post leaves every list and cannot change. 3 to {REASON_MAX} characters.</span>
          </label>
        )}

        {kind === "follow_up" && (
          <label className="scp-field">
            A note (optional)
            <textarea className="scp-input" value={i.note} maxLength={FOLLOW_UP_NOTE_MAX} onChange={(e) => set({ note: e.target.value })} aria-invalid={field("note") !== null} />
            <span className="scp-field__hint">{post.holder.label ? `${post.holder.label} gets a notification. ` : ""}Each holder can be followed up once in 24 hours.</span>
          </label>
        )}

        {kind === "mark_live" && (
          <>
            <label className="scp-field">
              The link to the post
              <input className="scp-input" type="url" value={i.url} onChange={(e) => set({ url: e.target.value })} aria-invalid={field("url") !== null} placeholder="https://" />
            </label>
            <label className="scp-field">
              Went live at (optional, now if empty)
              <input className="scp-input" type="datetime-local" value={atLocal} onChange={(e) => { setLocal(null); setAtLocal(e.target.value); }} />
            </label>
          </>
        )}

        {kind === "schedule" && (
          <>
            <p className="scp-note" style={{ margin: 0 }}>
              {approved?.scheduledAt
                ? <>It is scheduled at the date, time and networks the client approved: <strong>{formatDateTime(approved.scheduledAt)}</strong> on {approved.placement.map(networkLabel).join(", ") || "no network"}.</>
                : "The client has no approved date for this post."}
            </p>
            <p className="scp-note" style={{ margin: 0 }}>
              {action === "schedule_publisher"
                ? "It goes through the publisher. A second approver has to approve the publish in Approvals before anything is sent."
                : "You schedule it yourself in Meta. Marking it scheduled here changes nothing there."}{" "}
              A different date or placement is Reschedule, which asks the client again.
            </p>
          </>
        )}

        {kind === "reschedule" && (
          <>
            <p className="scp-note scp-note--reason" style={{ margin: 0 }}>The client will be asked to approve the new date, time and networks again before it can be scheduled.</p>
            <label className="scp-field">
              New date and time
              <input className="scp-input" type="datetime-local" value={atLocal} onChange={(e) => { setLocal(null); setAtLocal(e.target.value); }} aria-invalid={field("at") !== null} />
            </label>
            <fieldset className="scp-checks" aria-label="Networks">
              {NETWORKS.map((n) => (
                <label key={n}>
                  <input
                    type="checkbox" checked={i.placement?.includes(n) ?? false}
                    onChange={(e) => set({ placement: e.target.checked ? [...(i.placement ?? []), n] : (i.placement ?? []).filter((x) => x !== n) })}
                  />
                  {networkLabel(n)}
                </label>
              ))}
            </fieldset>
          </>
        )}

        {kind === "confirm" && (
          <p className="scp-note" style={{ margin: 0 }}>
            {action === "discard" ? "Discard this post? It leaves every list and cannot be brought back." : "Unschedule this post? It goes back to Client approved, and the client's approval stands."}
          </p>
        )}

        {kind === "send" && (
          <>
            <ul className="scp-dialog__checks" aria-label="Hand-off checks">
              {post.checks.map((c) => (
                <li key={c.code} className={c.ok ? "scp-dialog__check--ok" : "scp-dialog__check--bad"}>
                  <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> <span className="scp-sr">{c.ok ? "Passed:" : c.skippable ? "Failed, can be skipped:" : "Failed, cannot be skipped:"}</span> {c.message}
                </li>
              ))}
            </ul>
            {hardFail && <p className="scp-note scp-note--reason" style={{ margin: 0 }}>The checks that cannot be skipped must pass first. Fix them on the Post tab.</p>}
            {!hardFail && softFail && (
              <>
                <label className="scp-checks">
                  <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={i.sendAnyway ?? false} onChange={(e) => set({ sendAnyway: e.target.checked })} /> Send anyway
                  </span>
                </label>
                {i.sendAnyway ? (
                  <label className="scp-field">
                    Why send it with failed checks?
                    <textarea className="scp-input" value={i.sendAnywayReason} maxLength={SEND_ANYWAY_MAX} onChange={(e) => set({ sendAnywayReason: e.target.value })} aria-invalid={field("sendAnywayReason") !== null} />
                    <span className="scp-field__hint">{SEND_ANYWAY_MIN} to {SEND_ANYWAY_MAX} characters. It is kept on the post and shown in its activity.</span>
                  </label>
                ) : (
                  <p className="scp-note" style={{ margin: 0 }}>Fix the failed checks, or send anyway with a reason.</p>
                )}
              </>
            )}
          </>
        )}

        {local && <p className="scp-msg scp-msg--error" role="alert">{local.message}</p>}
        {error && <RefusalNote refusal={error.refusal} message={error.message} />}
      </div>
    </Modal>
  );
}
