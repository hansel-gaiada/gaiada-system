"use client";
import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Field } from "@/components/forms/Field";
import { Button } from "@/components/ui";
import { validateCompose, type ComposeErrors } from "@/lib/gmail";
import { sendGmailAction } from "@/lib/gmailActions";
import "./mail.css";

/** Plain-text compose, also used for Reply (`inReplyTo`) and "Email this client" (`clientId`). On success it goes to Sent with a "Sent" line. */
export function ComposeForm({ initial, inReplyTo, clientId, submitLabel = "Send" }: {
  initial: { to: string; cc?: string; subject: string; body?: string };
  inReplyTo?: { threadId: string; messageId: string };
  clientId?: string;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<ComposeErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = { to: String(fd.get("to") ?? ""), cc: String(fd.get("cc") ?? ""), subject: String(fd.get("subject") ?? ""), body: String(fd.get("body") ?? "") };
    const errs = validateCompose(input);
    setErrors(errs);
    setFailure(null);
    if (Object.keys(errs).length > 0) return;
    start(async () => {
      const r = await sendGmailAction({ ...input, inReplyTo, clientId });
      if (r.ok) return router.push("/me/mail?label=SENT&sent=1");
      const f = r.field as keyof ComposeErrors | undefined;
      if (f && ["to", "cc", "subject", "body"].includes(f)) setErrors({ [f]: r.error });
      else setFailure(r.error);
    });
  };

  return (
    <form className="gm-form" onSubmit={onSubmit} noValidate>
      <Field name="to" label="To" defaultValue={initial.to} required error={errors.to} hint="Separate several addresses with commas." />
      <Field name="cc" label="Cc" defaultValue={initial.cc ?? ""} error={errors.cc} />
      <Field name="subject" label="Subject" defaultValue={initial.subject} required error={errors.subject} />
      <Field name="body" label="Message" type="textarea" defaultValue={initial.body ?? ""} required error={errors.body} hint="Plain text." />
      {failure && <p className="gm-error" role="alert">{failure}</p>}
      <div className="gm-actions">
        <Button type="submit" disabled={pending}>{pending ? "Sending…" : submitLabel}</Button>
      </div>
    </form>
  );
}
