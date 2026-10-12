// WSK-10 — "zod schema derived from form_defs.schema" (ticket AC). `form_defs.schema` (0003's
// jsonb column, shared with the vocabulary's `collections.schema` shape at the TYPE level only —
// forms are not §05 vocabulary blocks, they are a much narrower field-list contract of this
// ticket's own invention, since nothing upstream defines one; flagged in the ticket report) is
// read as:
//
//   { fields: [ { key, type, required?, maxLength?, min?, max?, options? }, ... ],
//     honeypotField?: string,
//     consentNotice?: { text: string },
//     attachments?: { allowed?: boolean, maxCount?: number } }
//
// Building a fresh zod object schema PER REQUEST (not cached) is deliberate: form_defs rows are
// tenant-editable data, not code — caching a compiled schema keyed by form id would need an
// explicit invalidation path this ticket has no event to hang on (no "form updated" signal exists
// yet). zod's own object construction is cheap enough that this is not a real cost at forms-scale
// traffic.
import { Injectable } from "@nestjs/common";
import { z, ZodTypeAny } from "zod";
import { formsConfig } from "./forms.config";

// M5-L1d: the known field types, as DATA so the `forms.define` validator (control/forms/form-definition.ts) and
// this type cannot drift. `tel` is new (additive): a phone field. It validates like short text; what makes it
// matter is subject-refs.ts, which derives the phone correlator from the first `tel`-typed field.
export const FORM_FIELD_TYPES = ["text", "textarea", "email", "tel", "number", "boolean", "date", "select"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormFieldDef = {
  key: string;
  type: FormFieldType;
  required?: boolean;
  maxLength?: number;
  min?: number;
  max?: number;
  options?: string[];
};

export type FormSchemaDef = {
  fields?: FormFieldDef[];
  honeypotField?: string;
  consentNotice?: { text?: string };
  attachments?: { allowed?: boolean; maxCount?: number };
};

export type FieldValidationResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; issues: string[] };

function zodForField(field: FormFieldDef): ZodTypeAny {
  const maxLength = field.maxLength ?? formsConfig.maxSchemaFieldTextLength;
  let base: ZodTypeAny;
  switch (field.type) {
    case "email":
      base = z.string().trim().max(maxLength).email();
      break;
    case "text":
    case "textarea":
    case "tel":
      base = z.string().trim().max(maxLength);
      break;
    case "number":
      base = z.number().finite();
      if (field.min !== undefined) base = (base as z.ZodNumber).min(field.min);
      if (field.max !== undefined) base = (base as z.ZodNumber).max(field.max);
      break;
    case "boolean":
      base = z.boolean();
      break;
    case "date":
      // Accept an ISO-ish date string; this is user-facing form data, not a DB timestamp — kept
      // as a validated string rather than coerced to a Date so the stored jsonb payload stays
      // plain-JSON-serializable with no round-trip surprises.
      base = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/, {
        message: "must be an ISO 8601 date/date-time string",
      });
      break;
    case "select":
      base = field.options && field.options.length > 0 ? z.enum(field.options as [string, ...string[]]) : z.string().trim().max(maxLength);
      break;
    default:
      base = z.string().trim().max(maxLength);
  }
  if (field.required) {
    // M5-L1d: required means non-blank. (An email, a date and an enum already refuse "".) A required text-like field used to
    // accept "": with blank optionals now treated as absent, a required one must not be the one place "" gets through.
    if (field.type === "text" || field.type === "textarea" || field.type === "tel" || (field.type === "select" && !(field.options && field.options.length > 0))) {
      base = (base as z.ZodString).min(1);
    }
    return base;
  }
  return base.optional();
}

/**
 * M5-L1d: a browser form submits an untouched optional input as `""`. For an OPTIONAL declared field a blank string (empty
 * or whitespace only) means "not given": it is treated as absent, so an optional `email` / `select` / `tel` left blank is
 * accepted and nothing is stored under its key. A REQUIRED field is untouched: `""` still reaches its validator and is
 * refused (an `email` / `select` rejects it; a text field that accepts `""` keeps doing so, as before). Keys the schema does
 * not declare are not looked at (they are dropped by the object schema anyway). Never mutates the input.
 */
function withoutBlankOptionals(schemaDef: FormSchemaDef, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const field of schemaDef.fields ?? []) {
    if (field.required) continue;
    const v = out[field.key];
    if (typeof v === "string" && v.trim() === "") delete out[field.key];
  }
  return out;
}

@Injectable()
export class FormSchemaService {
  /** Parses `form_defs.schema` (already-trusted, tenant-authored jsonb, never user input) into a
   *  normalized field-def list. Malformed/missing `fields` degrades to an empty list (a form with
   *  no declared fields accepts none — every submitted field is then stripped by the object
   *  schema below, which is a safe, if unhelpful, default rather than a 500). */
  parseSchemaDef(raw: unknown): FormSchemaDef {
    if (!raw || typeof raw !== "object") return { fields: [] };
    const obj = raw as Record<string, unknown>;
    const fields = Array.isArray(obj.fields)
      ? (obj.fields as unknown[]).filter(
          (f): f is FormFieldDef =>
            !!f && typeof f === "object" && typeof (f as FormFieldDef).key === "string" && typeof (f as FormFieldDef).type === "string",
        )
      : [];
    return {
      fields,
      honeypotField: typeof obj.honeypotField === "string" ? obj.honeypotField : undefined,
      consentNotice:
        obj.consentNotice && typeof obj.consentNotice === "object"
          ? { text: (obj.consentNotice as { text?: unknown }).text as string | undefined }
          : undefined,
      attachments:
        obj.attachments && typeof obj.attachments === "object" ? (obj.attachments as FormSchemaDef["attachments"]) : undefined,
    };
  }

  /** Validates `rawFields` against the form's declared field list. Unknown keys are DROPPED (zod's
   *  default `z.object()` behavior, not `.passthrough()`/`.strict()`) — see sanitize.ts's header
   *  for why that matters against a hostile payload. Returns issues as plain strings (never the
   *  raw zod error internals) so a 400 response cannot leak implementation detail. */
  validate(schemaDef: FormSchemaDef, rawFields: unknown): FieldValidationResult {
    const shape: Record<string, ZodTypeAny> = {};
    for (const field of schemaDef.fields ?? []) {
      shape[field.key] = zodForField(field);
    }
    const objectSchema = z.object(shape);
    const input = withoutBlankOptionals(schemaDef, rawFields && typeof rawFields === "object" ? (rawFields as Record<string, unknown>) : {});
    const result = objectSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, issues };
    }
    return { ok: true, fields: result.data as Record<string, unknown> };
  }
}
