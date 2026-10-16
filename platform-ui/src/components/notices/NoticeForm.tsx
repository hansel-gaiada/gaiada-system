"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { postNoticeAction, editNoticeAction } from "@/lib/noticeActions";
import { BODY_MAX, TITLE_MAX, type NoticeActionResult, type NoticeRow, type NoticeScope } from "@/lib/notices";
import "@/components/forms/forms.css";
import "./notices.css";

// DW-10a-2 (BFF §57.8): the notice form, for posting (a unit's page, or the company-wide page) and for editing one notice. The scope is
// decided by the PAGE: a unit's page posts to its own unit and the company-wide page posts company-wide; the form has no scope control, and
// the server never widens it. It is only OFFERED to a person who may post (`mayPostNotice`, a mirror); the server's 400 `{field}`, 403, 404
// and 409 `pin_limit` come back as `NoticeActionResult.error` and are shown as said.

export type NoticeTarget = { scope: "company" } | { scope: "unit"; unitNodeId: string };

const INLINE = ["title", "body", "endsOn"];

export function NoticeForm({ tenantId, target, notice, onDone, onCancel }: {
  tenantId: string;
  /** Where a NEW notice goes. */
  target: NoticeTarget;
  /** Given: edit this notice (the form starts from it). Absent: post a new one. */
  notice?: NoticeRow;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [field, setField] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const editing = !!notice;
  const scope: NoticeScope = notice?.scope ?? target.scope;

  // A plain submit handler, not the form's `action` prop: React 19 resets an uncontrolled form once its action finishes, so a refusal (a 409
  // on the pin, a 403) would wipe a notice the person just wrote. This keeps what they typed until the post succeeds.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const input = {
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
      pinned: formData.get("pinned") === "on",
      endsOn: String(formData.get("endsOn") ?? ""),
    };
    startTransition(async () => {
      const res: NoticeActionResult = notice
        ? await editNoticeAction(tenantId, notice.id, input, notice.scope)
        : await postNoticeAction(tenantId, target, input);
      if (res.ok) {
        setMsg(null);
        setField(undefined);
        onDone?.();
        router.refresh();
      } else {
        setMsg(res.error ?? "The notice could not be saved.");
        setField(res.field);
      }
    });
  };

  const err = (f: string) => (field === f ? msg ?? undefined : undefined);
  const label = editing ? "Edit this notice" : scope === "company" ? "Post a company-wide notice" : "Post a notice";
  return (
    <form onSubmit={onSubmit} className="nt-form" aria-label={label}>
      <Field name="title" label="Title" type="text" required defaultValue={notice?.title ?? ""} hint={`Up to ${TITLE_MAX} characters.`} error={err("title")} />
      <Field name="body" label="Notice" type="textarea" required defaultValue={notice?.body ?? ""} hint={`Plain text, up to ${BODY_MAX} characters. Line breaks are kept; links and formatting are not.`} error={err("body")} />
      <Field name="endsOn" label="Show until (optional)" type="date" defaultValue={notice?.endsOn ?? ""} hint="The last day the notice is current. Leave empty to keep it until it is withdrawn." error={err("endsOn")} />
      <Field name="pinned" label="Pin to the top (at most 3 at a time)" type="boolean" defaultValue={notice?.pinned ?? false} />
      <div className="nt-form__row">
        <button type="submit" className="lux-btn lux-btn--solid lux-btn--sm" disabled={pending}>
          {pending ? "Saving…" : editing ? "Save changes" : "Post notice"}
        </button>
        {onCancel && (
          <button type="button" className="lux-btn lux-btn--ghost lux-btn--sm" onClick={() => { setMsg(null); setField(undefined); onCancel(); }}>
            Cancel
          </button>
        )}
        {msg && !INLINE.includes(field ?? "") && <span role="alert" className="nt-msg nt-msg--bad">{msg}</span>}
      </div>
    </form>
  );
}

/** "Post a notice": a button that opens the form in place (so a page of notices is not a page of form). */
export function PostNotice({ tenantId, target }: { tenantId: string; target: NoticeTarget }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <div className="nt-compose">
        <button type="button" className="lux-btn lux-btn--solid lux-btn--sm" onClick={() => setOpen(true)}>
          Post a notice
        </button>
      </div>
    );
  }
  return (
    <div className="nt-compose">
      <NoticeForm tenantId={tenantId} target={target} onDone={() => setOpen(false)} onCancel={() => setOpen(false)} />
    </div>
  );
}
