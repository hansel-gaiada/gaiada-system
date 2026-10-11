// M5-L1 — data-subject correlators derived from the FORM DEFINITION, not from a hard-coded field name.
//
// Before M5 the email correlator (`submissions.data_subject_ref`) was taken only from a field literally
// named `email`. gaiada.com's forms use `email_address` and `contact_email`, so none of its submitters
// was findable by the privacy.* commands. The convention now:
//
//   EMAIL ref  = the value of the FIRST field of the form definition that is an email field, i.e. declares
//                `"format": "email"` (JSON-schema style) or `"type": "email"` (the form builder's own type);
//                else, for forms that declare no such field, the legacy `email` key. Trimmed, lower-cased.
//   PHONE ref  = the value of the FIRST field that declares `"format": "tel"` (or `"type": "tel"`),
//                normalised by normalizePhone() below. There is no legacy fallback: a field named `phone`
//                that is not marked `tel` yields no ref (guessing from names is what broke the email case).
//
// "First" is the order of `fields` in the definition (or, for a JSON-schema `properties` object, its key
// order). Only the first such field counts: a second email field (say, a billing contact) is not the
// submitter.
//
// The form definition is read from `form_defs.schema` (a tenant-authored jsonb, never user input); the
// recognised shapes are `fields: [{ key, type?, format? }]` (what form-schema.service.ts reads) and
// `properties: { <key>: { type?, format? } }` (a JSON-schema object).
//
// PHONE NORMALISATION (normalizePhone):
//   1. Only digits, spaces, `-`, `.`, `(`, `)` and a single leading `+` are accepted; anything else
//      (letters, an extension "x12", a second `+`) gives no ref rather than a guessed one.
//   2. Everything but the digits is removed. A leading `+` or `00` (the international call prefix) is
//      dropped: the digits that follow ARE the country code and number.
//   3. 7 to 15 digits remain (E.164 allows at most 15); otherwise no ref.
//   4. A NATIONAL leading zero is NOT rewritten. "0812-3456-7890" stays "081234567890" and does NOT equal
//      "+62 812-3456-7890" ("6281234567890"). Rewriting 0 -> 62 would hard-wire one country into a
//      multi-tenant platform (internal-now-SaaS-later ruling 2026-10-10) and would be wrong for every
//      other country that also uses a trunk 0 (the UK's 0 -> 44, etc.). The cost is that an operator who
//      looks a person up must try the number the way the person is likely to have typed it (with and
//      without the country code); privacy.find is cheap and audited, so that is acceptable. A per-tenant
//      default country code is the proper fix and needs a schema decision.
import type { FormSchemaDef } from "./form-schema.service";

type FieldLike = { key?: unknown; type?: unknown; format?: unknown };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The definition's fields in order, whichever of the two recognised shapes it uses. */
function orderedFields(schema: unknown): Array<{ key: string; type?: string; format?: string }> {
  if (!isObject(schema)) return [];
  const out: Array<{ key: string; type?: string; format?: string }> = [];
  const push = (key: unknown, def: FieldLike) => {
    if (typeof key !== "string" || key.length === 0) return;
    out.push({
      key,
      type: typeof def.type === "string" ? def.type : undefined,
      format: typeof def.format === "string" ? def.format : undefined,
    });
  };
  if (Array.isArray(schema.fields)) {
    for (const f of schema.fields) if (isObject(f)) push(f.key, f);
  }
  if (isObject(schema.properties)) {
    for (const [key, def] of Object.entries(schema.properties)) if (isObject(def)) push(key, def);
  }
  return out;
}

/** The key of the first field marked as an email (`format: "email"` or `type: "email"`), else null. */
export function emailFieldKey(schema: unknown): string | null {
  return orderedFields(schema).find((f) => f.format === "email" || f.type === "email")?.key ?? null;
}

/** The key of the first field marked as a phone (`format: "tel"` or `type: "tel"`), else null. */
export function phoneFieldKey(schema: unknown): string | null {
  return orderedFields(schema).find((f) => f.format === "tel" || f.type === "tel")?.key ?? null;
}

/** True for a field whose value is a contact detail (email / tel), which the PAN / national-ID scrub must leave alone. */
export function isContactField(schema: FormSchemaDef | Record<string, unknown> | undefined, key: string): boolean {
  const f = orderedFields(schema).find((x) => x.key === key);
  return !!f && (f.format === "email" || f.type === "email" || f.format === "tel" || f.type === "tel");
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v.length > 0 ? v : null;
}

const PHONE_CHARS = /^\+?[\d\s().-]+$/;

/** See the header: digits with the country code if one was given; null when it is not a usable phone number. */
export function normalizePhone(raw: string): string | null {
  const v = raw.trim();
  if (!PHONE_CHARS.test(v)) return null;
  let digits = v.replace(/\D/g, "");
  if (v.startsWith("+")) {
    // digits already are country code + number
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

export type SubjectRefs = { email: string | null; phone: string | null };

/** The two correlators of one submission, from its (already validated + sanitised) fields and the form's definition. */
export function deriveSubjectRefs(schema: unknown, fields: Record<string, unknown>): SubjectRefs {
  const emailKey = emailFieldKey(schema);
  const emailRaw = emailKey !== null ? fields[emailKey] : fields.email;
  const email = typeof emailRaw === "string" ? normalizeEmail(emailRaw) : null;

  const phoneKey = phoneFieldKey(schema);
  const phoneRaw = phoneKey !== null ? fields[phoneKey] : undefined;
  const phone = typeof phoneRaw === "string" ? normalizePhone(phoneRaw) : null;

  return { email, phone };
}
