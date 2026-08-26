// WSK-10 — the honeypot trap (§11: "honeypot ... mandatory", ticket AC: "silently dropped, never
// a visible error"). A hidden form field (CSS-hidden on the real site, invisible to a human,
// visible to any bot that blindly fills every <input> it finds) that a legitimate submitter can
// never populate. If it arrives non-empty, the request is treated as a real-looking success and
// silently discarded — no DB row, no mail, no error, no timing tell beyond what the rest of the
// pipeline already costs (this check runs BEFORE the Turnstile call and BEFORE schema validation,
// deliberately, so a tripped honeypot never even reaches those — see forms.service.ts's ordering
// comment).
import type { FormSchemaDef } from "./form-schema.service";
import { formsConfig } from "./forms.config";

export function resolveHoneypotFieldName(schema: FormSchemaDef | null | undefined): string {
  const override = schema?.honeypotField;
  return typeof override === "string" && override.length > 0 ? override : formsConfig.defaultHoneypotField;
}

/** `true` iff the honeypot field is present on the raw request body AND non-empty. Reads the RAW
 *  body (not the validated `fields` object) — the honeypot field is never part of a form's own
 *  declared schema, so it would never survive zod validation and must be checked ahead of it. */
export function isHoneypotTripped(rawBody: Record<string, unknown>, fieldName: string): boolean {
  const value = rawBody[fieldName];
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true; // any non-string, non-empty value (a bot sending a number/object) also trips it
}
