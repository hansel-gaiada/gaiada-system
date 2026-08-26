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

export type FormFieldType = "text" | "textarea" | "email" | "number" | "boolean" | "date" | "select";

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
  return field.required ? base : base.optional();
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
    const input = rawFields && typeof rawFields === "object" ? rawFields : {};
    const result = objectSchema.safeParse(input);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      return { ok: false, issues };
    }
    return { ok: true, fields: result.data as Record<string, unknown> };
  }
}
