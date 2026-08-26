// WSK-10 — the wire shape for POST /v1/t/:tenantSlug/forms/:formId/submit.
//
// Protocol-level fields (consent/turnstileToken/attachments/the honeypot field) are kept at the
// TOP LEVEL, separate from `fields` (the tenant-authored form's own field values) — a form that
// happens to define a field literally named "consent" or "turnstileToken" must never collide with
// this envelope's own control fields. The honeypot field name is dynamic per form
// (form_defs.schema.honeypotField, default `_hp` — forms.config.ts) so it cannot be typed
// statically here; honeypot.ts reads it off the raw body by that resolved name.
export type FormAttachmentInput = {
  filename?: string;
  contentType?: string;
  /** Base64-encoded file bytes — same convention media/dto.ts's UploadMediaBody uses, and for the
   *  same reason: registering a streaming multipart parser is a main.ts/app.ts bootstrap change,
   *  out of this ticket's owned scope (src/forms/** only). */
  contentBase64?: string;
};

export type FormSubmitBody = {
  /** The tenant-authored field values, validated against form_defs.schema by
   *  form-schema.service.ts. Absent/non-object is treated as `{}`. */
  fields?: Record<string, unknown>;
  /** Must be exactly `true` (WSK-D22c: consent is recorded per submission, universally — not
   *  only when a form author remembers to add a consent-typed field). */
  consent?: boolean;
  turnstileToken?: string;
  attachments?: FormAttachmentInput[];
  /** Every other top-level key is scanned for the resolved honeypot field name at submit time —
   *  see honeypot.ts. Not enumerable here because the field NAME is per-form data, not a static
   *  part of this type. */
  [key: string]: unknown;
};

export type FormSubmitAccepted = { ok: true; id: string };
/** The honeypot-tripped response — deliberately THE SAME SHAPE as a real success (§11: "silently
 *  dropped, never a visible error"), only distinguishable by `id` being absent, which nothing a
 *  bot inspects for a fire-and-forget POST would ever notice or branch on. */
export type FormSubmitHoneypotDropped = { ok: true };

export type SubmissionAttachmentRef = {
  mediaAssetId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
};
