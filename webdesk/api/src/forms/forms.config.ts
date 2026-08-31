// WSK-10 — forms-service env config. Same "every field is a live GETTER" discipline as
// ../config.ts / ../media/media.config.ts / ../mail/mail.config.ts: process.env must be read at
// call time, never snapshotted at module-import time (ESM import hoisting races a test's own
// `process.env.X = ...` assignment against this module's evaluation otherwise).
//
// None of these env vars exist in ../../.env.example yet — .env.example is WSK-01's file, out of
// this ticket's owned scope. Reported as a required addition in the ticket output and in
// README.md's forms section, exactly like WSK-05/07/11 reported their own new vars there.
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const formsConfig = {
  /** Hard cap on the JSON-serialized size of the `fields` object (§11: "size caps ... mandatory").
   *  Deliberately separate from attachment size (below) — form field text and file bytes are very
   *  different abuse shapes and get independent knobs. */
  get maxFieldsBytes(): number {
    return Number(process.env.WEBDESK_FORMS_MAX_FIELDS_BYTES ?? 65_536); // 64 KiB
  },

  get maxAttachmentsPerSubmission(): number {
    return Number(process.env.WEBDESK_FORMS_MAX_ATTACHMENTS ?? 5);
  },
  /** Per-attachment byte cap this service enforces BEFORE handing the buffer to MediaService
   *  (which has its own, bucket-wide `WEBDESK_MEDIA_MAX_UPLOAD_BYTES` cap — this one lets forms
   *  set a tighter limit for form attachments specifically without touching storage/**). */
  get maxAttachmentBytes(): number {
    return Number(process.env.WEBDESK_FORMS_MAX_ATTACHMENT_BYTES ?? 10 * 1024 * 1024); // 10 MiB
  },

  /** Reserved field NAME for the honeypot trap. A per-form override lives at
   *  `form_defs.schema.honeypotField` (honeypot.ts) — this is only the fallback default. */
  get defaultHoneypotField(): string {
    return process.env.WEBDESK_FORMS_HONEYPOT_FIELD || "_hp";
  },

  // Fixed-window rate limits (§11: "per-IP and per-form rate limits ... mandatory"). Two
  // independent counters, both enforced — see form-rate-limit.service.ts.
  get ipLimitPerWindow(): number {
    return Number(process.env.WEBDESK_FORMS_RATE_LIMIT_IP_PER_WINDOW ?? 20);
  },
  get ipWindowMs(): number {
    return Number(process.env.WEBDESK_FORMS_RATE_LIMIT_IP_WINDOW_MS ?? 10 * 60_000); // 10 min
  },
  get formLimitPerWindow(): number {
    return Number(process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_PER_WINDOW ?? 120);
  },
  get formWindowMs(): number {
    return Number(process.env.WEBDESK_FORMS_RATE_LIMIT_FORM_WINDOW_MS ?? 10 * 60_000);
  },

  /** Fallback consent-notice text (WSK-D22c) used only when a form defines no
   *  `schema.consentNotice.text` of its own — every submission still needs SOME evidenced text,
   *  never a silently-empty string. See consent.ts. */
  get defaultConsentNoticeText(): string {
    return (
      process.env.WEBDESK_FORMS_DEFAULT_CONSENT_TEXT ||
      "By submitting this form you consent to us processing the information you provide in " +
        "order to respond to your enquiry."
    );
  },
  get defaultConsentNoticeVersion(): string {
    return process.env.WEBDESK_FORMS_DEFAULT_CONSENT_VERSION || "unspecified-v0";
  },

  get maxSchemaFieldTextLength(): number {
    return Number(process.env.WEBDESK_FORMS_MAX_FIELD_TEXT_LENGTH ?? 5_000);
  },
};

export const turnstileConfig = {
  /** "stub" (default everywhere until real Cloudflare keys land — see webdesk-design.md §12's
   *  WSK-10 row: "env-swappable dev stub — real keys at procurement, do NOT activate one") or
   *  "live" (the CloudflareTurnstileVerifier — WSK-10 builds the seam only, never flips this). */
  get mode(): "stub" | "live" {
    return (process.env.TURNSTILE_MODE || "stub").toLowerCase() === "live" ? "live" : "stub";
  },
  get secretKey(): string {
    return process.env.TURNSTILE_SECRET_KEY || "";
  },
  get verifyUrl(): string {
    return process.env.TURNSTILE_VERIFY_URL || "https://challenges.cloudflare.com/turnstile/v0/siteverify";
  },
  /** The ONE token the stub verifier accepts. Never a real Turnstile response shape — deliberately
   *  distinct so a stray real integration can never accidentally validate against the stub. */
  get stubPassToken(): string {
    return process.env.TURNSTILE_STUB_PASS_TOKEN || "stub-pass";
  },
  get requestTimeoutMs(): number {
    return Number(process.env.TURNSTILE_REQUEST_TIMEOUT_MS ?? 5_000);
  },
  get enabled(): boolean {
    return bool("TURNSTILE_ENABLED", true);
  },
};
