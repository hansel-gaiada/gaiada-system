// WSK-10 — the submit pipeline's orchestration. Ordering (deliberate, cheapest/local checks
// first, matching media.service.ts's own "size cap first, before any I/O" philosophy):
//
//   1. size caps (fields JSON size, attachment count)      — cheap, no I/O, no external calls
//   2. honeypot                                             — cheap, and must short-circuit BEFORE
//                                                              Turnstile so a tripped honeypot never
//                                                              spends a Turnstile verification call
//   3. Turnstile verify                                     — the one external network call
//   4. zod field validation + sanitize                      — local, but only worth doing once
//                                                              Turnstile has already proven the
//                                                              caller passed a human/abuse check
//   5. consent affirmation                                  — local
//   6. attachments (ClamAV via MediaService, PRIVATE bucket) — the other external-ish call (clamd)
//   7. persist (one transaction) + audit row
//   8. mail (best-effort; a mail failure never fails the HTTP response — see the try/catch below)
//
// FormContextGuard (origin) and FormRateLimitGuard (IP + form) have already run by the time this
// service is reached — both are 403/429 REFUSALS the controller never even calls into this class
// for for; see forms.module.ts's @UseGuards ordering.
import { BadRequestException, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AuditService } from "../audit/audit.service";
import { MailService } from "../mail/mail.service";
import { MediaService } from "../media/media.service";
import type { ResolvedApiKey } from "../api-keys/api-keys.service";
import { FormSchemaService } from "./form-schema.service";
import { SubmissionsRepository } from "./submissions.repository";
import { resolveConsentRecord, hasAffirmedConsent } from "./consent";
import { resolveHoneypotFieldName, isHoneypotTripped } from "./honeypot";
import { sanitizeFields } from "./sanitize";
import { formsConfig } from "./forms.config";
import type { TurnstileVerifier } from "./turnstile/turnstile-verifier";
import { TURNSTILE_VERIFIER } from "./turnstile/turnstile-verifier";
import type { ResolvedForm } from "./forms-request";
import type { FormAttachmentInput, FormSubmitAccepted, FormSubmitHoneypotDropped, SubmissionAttachmentRef } from "./dto";

export type SubmitParams = {
  form: ResolvedForm;
  body: Record<string, unknown>;
  remoteIp: string | undefined;
  actor: string;
};

@Injectable()
export class FormsService {
  private readonly logger = new Logger(FormsService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
    private readonly media: MediaService,
    private readonly schema: FormSchemaService,
    private readonly submissions: SubmissionsRepository,
    @Inject(TURNSTILE_VERIFIER) private readonly turnstile: TurnstileVerifier,
  ) {}

  async submit(params: SubmitParams): Promise<FormSubmitAccepted | FormSubmitHoneypotDropped> {
    const { form, body, remoteIp, actor } = params;
    const schemaDef = this.schema.parseSchemaDef(form.schema);

    // 1. Size caps.
    const rawFields = body.fields && typeof body.fields === "object" ? (body.fields as Record<string, unknown>) : {};
    const fieldsByteLength = Buffer.byteLength(JSON.stringify(rawFields), "utf8");
    if (fieldsByteLength > formsConfig.maxFieldsBytes) {
      throw new BadRequestException(`submission exceeds the ${formsConfig.maxFieldsBytes}-byte fields limit`);
    }
    const attachmentInputs = Array.isArray(body.attachments) ? (body.attachments as FormAttachmentInput[]) : [];
    const maxAttachments = schemaDef.attachments?.maxCount ?? formsConfig.maxAttachmentsPerSubmission;
    if (attachmentInputs.length > maxAttachments) {
      throw new BadRequestException(`too many attachments (max ${maxAttachments})`);
    }
    if (attachmentInputs.length > 0 && schemaDef.attachments?.allowed === false) {
      throw new BadRequestException("this form does not accept attachments");
    }

    // 2. Honeypot — silently dropped, never a visible error (§11 AC).
    const honeypotField = resolveHoneypotFieldName(schemaDef);
    if (isHoneypotTripped(body, honeypotField)) {
      this.logger.debug(`honeypot tripped for form ${form.formId} — silently dropped, no persistence`);
      return { ok: true };
    }

    // 3. Turnstile.
    const turnstileToken = typeof body.turnstileToken === "string" ? body.turnstileToken : undefined;
    const humanVerified = await this.turnstile.verify(turnstileToken, remoteIp);
    if (!humanVerified) {
      throw new ForbiddenException("turnstile verification failed");
    }

    // 4. zod validate + sanitize.
    const validation = this.schema.validate(schemaDef, rawFields);
    if (!validation.ok) {
      throw new BadRequestException({ message: "invalid submission", issues: validation.issues });
    }
    const sanitizedFields = sanitizeFields(validation.fields, formsConfig.maxSchemaFieldTextLength);

    // 5. Consent.
    if (!hasAffirmedConsent(body)) {
      throw new BadRequestException("consent is required");
    }
    const consent = resolveConsentRecord(schemaDef, form.consentNoticeVersion);

    // 6. Attachments — PRIVATE `uploads` bucket, ClamAV-scanned, via WSK-07's MediaService (never
    //    a bespoke upload path — reuses the exact size/mime/scan/quota pipeline media.service.ts
    //    already enforces, plus this ticket's own tighter byte cap below).
    const attachmentRefs: SubmissionAttachmentRef[] = [];
    if (attachmentInputs.length > 0) {
      const syntheticAuth: ResolvedApiKey = {
        apiKeyId: `form-submission:${form.formId}`,
        tenantId: form.tenantId,
        envId: "",
        siteId: form.siteId,
        envName: "public-form",
        scope: "write",
      };
      for (const attachment of attachmentInputs) {
        if (!attachment.filename || !attachment.contentType || !attachment.contentBase64) {
          throw new BadRequestException("each attachment needs filename, contentType and contentBase64");
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(attachment.contentBase64, "base64");
        } catch {
          throw new BadRequestException("attachment contentBase64 is not valid base64");
        }
        if (buffer.length > formsConfig.maxAttachmentBytes) {
          throw new BadRequestException(
            `attachment '${attachment.filename}' exceeds the ${formsConfig.maxAttachmentBytes}-byte limit`,
          );
        }
        // Bubbles up MediaService's own exceptions verbatim (403 infected, 400 size/mime
        // mismatch, 503 scanner unreachable) — this ticket does not re-wrap them.
        const uploaded = await this.media.upload(
          syntheticAuth,
          "uploads",
          { filename: attachment.filename, contentType: attachment.contentType, buffer },
          actor,
        );
        attachmentRefs.push({
          mediaAssetId: uploaded.id,
          filename: attachment.filename,
          mime: uploaded.mime,
          sizeBytes: uploaded.sizeBytes,
        });
      }
    }

    // 7. Persist, one transaction.
    const dataSubjectRef = normalizeDataSubjectRef(sanitizedFields);
    const submission = await this.db.withTenant(form.tenantId, (db) =>
      db.transaction(async (client) => {
        const row = await this.submissions.insert(client, {
          tenantId: form.tenantId,
          siteId: form.siteId,
          formDefId: form.formId,
          fields: sanitizedFields,
          attachments: attachmentRefs,
          consent,
          retentionDays: form.retentionDays,
          dataSubjectRef,
        });
        await this.audit.record(client, {
          tenantId: form.tenantId,
          actor,
          action: "webdesk.forms.submit",
          args: { formDefId: form.formId, submissionId: row.id, attachmentCount: attachmentRefs.length },
        });
        return row;
      }),
    );

    // 8. Mail — best effort. A missing/misconfigured template must not turn a successfully
    //    persisted submission into a failed HTTP response; the submission is the thing of record.
    await this.dispatchMail(form, sanitizedFields, submission.id).catch((err) => {
      this.logger.warn(`mail dispatch failed for submission ${submission.id}: ${String(err)}`);
    });

    return { ok: true, id: submission.id };
  }

  private async dispatchMail(form: ResolvedForm, fields: Record<string, unknown>, submissionId: string): Promise<void> {
    const notify = form.notify as {
      to?: { email?: string; name?: string };
      templateKey?: string;
      autoresponder?: boolean;
      autoresponderTemplateKey?: string;
    };
    if (!notify?.to?.email) {
      this.logger.debug(`form ${form.formId} has no notify.to configured — skipping notification mail`);
      return;
    }
    const variables = flattenToStrings({ ...fields, submissionId });
    const submitterEmail = typeof fields.email === "string" ? fields.email : undefined;

    await this.mail.sendNotification({
      tenantId: form.tenantId,
      siteId: form.siteId,
      templateKey: notify.templateKey || "form-notification",
      to: { email: notify.to.email, name: notify.to.name },
      variables,
      // D14: From: is ours, Reply-To: the human submitter — only when the submission actually
      // carries an email field; a form with no email field sends no Reply-To at all rather than
      // guessing.
      submitter: submitterEmail ? { email: submitterEmail, name: typeof fields.name === "string" ? fields.name : undefined } : { email: notify.to.email },
    });

    if (notify.autoresponder && submitterEmail) {
      await this.mail.sendAutoresponder({
        tenantId: form.tenantId,
        siteId: form.siteId,
        templateKey: notify.autoresponderTemplateKey || "form-autoresponder",
        to: { email: submitterEmail, name: typeof fields.name === "string" ? fields.name : undefined },
        variables,
      });
    }
  }
}

/** `email` (if the form collects one) is the natural correlator for WSK-38's future DSR command —
 *  0003_forms.sql's own comment on `data_subject_ref` calls out "e.g. a normalized email/phone".
 *  Nullable by design: a form with no email field has no correlator, and that is fine. */
function normalizeDataSubjectRef(fields: Record<string, unknown>): string | null {
  const email = fields.email;
  if (typeof email === "string" && email.trim().length > 0) return email.trim().toLowerCase();
  return null;
}

/** mail/template-renderer.ts's `variables: Record<string, string>` is flat, string-only — this
 *  flattens a validated fields object (which may carry numbers/booleans) into that shape. */
function flattenToStrings(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}
