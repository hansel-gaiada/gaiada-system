// M5-L1d — the validator behind `forms.define`, and the one place that says what a stored form definition may be.
//
// A form definition is what a PUBLIC endpoint (`POST /v1/t/:tenantSlug/forms/:formId/submit`) accepts, so a bad one
// is a bad public surface: it is refused here, with every problem listed, before anything is written. The same
// function is run by test/form-definitions-gaiada.spec.ts over the checked-in definition files
// (webdesk/sites/gaiada-com/forms/*.json), so a bad file fails CI instead of failing on the live tenant.
//
// THE SHAPE (the convention form-schema.service.ts reads; nothing here invents a new one):
//
//   {
//     "schema": {
//       "fields":        [ { "key", "type", "required"?, "maxLength"?, "min"?, "max"?, "options"? }, ... ],
//       "honeypotField": "_hp",                       // optional; default is forms.config's `_hp`
//       "consentNotice": { "text": "..." },           // REQUIRED, non-empty (see CONSENT below)
//       "attachments":   { "allowed"?, "maxCount"? }  // optional
//     },
//     "notify":               { "to"?: {email, name?}, "templateKey"?, "autoresponder"?, "autoresponderTemplateKey"? },
//     "retentionDays":        90,                      // REQUIRED: a retention decision is never defaulted silently
//     "consentNoticeVersion": "site-2026-10-11"        // REQUIRED
//   }
//
// The form's `key` is the route parameter (`PUT .../forms/:formKey`), not a body member.
//
// RULES, and why:
//   * Field keys are `[a-z0-9_]{1,64}`, unique. The keys are the integration contract with the site and the ERP.
//   * Known types only (FORM_FIELD_TYPES). A field that LOOKS like an email or a phone number (by its key) but is
//     typed `text` is refused: subject-refs.ts derives the data-subject correlators (privacy.find / erase) from
//     the first `email` / `tel` TYPED field, so a mistyped one silently makes its submitters unfindable.
//   * The honeypot key is `[a-z0-9_]{1,64}`, is not a field key (a declared field is a real input, not a trap),
//     and is not one of the submit body's own top-level members (`consent: true` would then trip the honeypot).
//   * CONSENT. consent.ts makes consent a universal requirement of the submit endpoint, and every submission
//     snapshots the notice text, so `consentNotice.text` is required for EVERY form, not only a form that has a
//     consent-typed field (there is no such field type).
//   * retentionDays is an integer in [1, MAX_RETENTION_DAYS]. 1 is the table's own CHECK (retention_days > 0);
//     the purge (forms/submissions-purge.service.ts) compares `expires_at < now()` and has no upper bound, so the
//     ceiling is a sanity cap, not a purge limit: ten years.
//   * The change rule (notice text vs version) needs the stored row, so it is enforced in the service, not here.
import { FORM_FIELD_TYPES, type FormFieldDef, type FormFieldType, type FormSchemaDef } from "../../forms/form-schema.service";
import { formsConfig } from "../../forms/forms.config";

export const FIELD_KEY_RE = /^[a-z0-9_]{1,64}$/;
export const FORM_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const NOTICE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
export const MAX_FIELDS = 60;
export const MAX_OPTIONS = 100;
export const MAX_OPTION_LENGTH = 200;
export const MAX_NOTICE_TEXT = 4000;
export const MAX_ATTACHMENT_COUNT = 20;

/** The submit body's own top-level members: a honeypot key equal to one of them would be a live input. */
export const RESERVED_BODY_MEMBERS: readonly string[] = ["fields", "consent", "turnstileToken", "attachments", "attribution", "visitor_consent"];

const TEXT_LIKE: ReadonlySet<FormFieldType> = new Set<FormFieldType>(["text", "textarea", "email", "tel", "select", "date"]);
const EMAIL_LOOKING = /(^|_)e?mail(_|$)/;
const PHONE_LOOKING = /(^|_)(phone|tel|telephone|mobile|whatsapp|msisdn)(_|$)/;

export type FormDefinitionIssue = { path: string; message: string };

export type FormNotify = {
  to?: { email: string; name?: string };
  templateKey?: string;
  autoresponder?: boolean;
  autoresponderTemplateKey?: string;
};

/** A definition that passed every rule, normalised (unknown members were refused, not dropped). */
export interface FormDefinition {
  key: string;
  schema: FormSchemaDef & { fields: FormFieldDef[]; consentNotice: { text: string } };
  notify: FormNotify;
  retentionDays: number;
  consentNoticeVersion: string;
}

export type FormDefinitionResult = { ok: true; value: FormDefinition } | { ok: false; issues: FormDefinitionIssue[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: FormDefinitionIssue[]): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) issues.push({ path: path ? `${path}.${k}` : k, message: `unknown member (allowed: ${allowed.join(", ")})` });
  }
}

function validateField(raw: unknown, index: number, issues: FormDefinitionIssue[]): FormFieldDef | null {
  const path = `schema.fields[${index}]`;
  if (!isObj(raw)) {
    issues.push({ path, message: "must be an object" });
    return null;
  }
  const before = issues.length;
  unknownKeys(raw, ["key", "type", "required", "maxLength", "min", "max", "options"], path, issues);

  const key = raw.key;
  if (typeof key !== "string" || !FIELD_KEY_RE.test(key)) issues.push({ path: `${path}.key`, message: "must match [a-z0-9_]{1,64}" });
  const type = raw.type;
  if (typeof type !== "string" || !(FORM_FIELD_TYPES as readonly string[]).includes(type)) {
    issues.push({ path: `${path}.type`, message: `must be one of ${FORM_FIELD_TYPES.join(", ")}` });
  }
  if (raw.required !== undefined && typeof raw.required !== "boolean") issues.push({ path: `${path}.required`, message: "must be a boolean" });

  const t = typeof type === "string" ? (type as FormFieldType) : null;
  if (raw.maxLength !== undefined) {
    const ceiling = formsConfig.maxSchemaFieldTextLength;
    if (t !== null && !TEXT_LIKE.has(t)) issues.push({ path: `${path}.maxLength`, message: `is only for text-like fields, not ${t}` });
    else if (typeof raw.maxLength !== "number" || !Number.isInteger(raw.maxLength) || raw.maxLength < 1 || raw.maxLength > ceiling) {
      issues.push({ path: `${path}.maxLength`, message: `must be an integer from 1 to ${ceiling}` });
    }
  }
  for (const bound of ["min", "max"] as const) {
    if (raw[bound] === undefined) continue;
    if (t !== null && t !== "number") issues.push({ path: `${path}.${bound}`, message: `is only for number fields, not ${t}` });
    else if (typeof raw[bound] !== "number" || !Number.isFinite(raw[bound])) issues.push({ path: `${path}.${bound}`, message: "must be a finite number" });
  }
  if (typeof raw.min === "number" && typeof raw.max === "number" && raw.min > raw.max) issues.push({ path: `${path}.min`, message: "must not exceed max" });

  if (t === "select") {
    const o = raw.options;
    if (!Array.isArray(o) || o.length < 1 || o.length > MAX_OPTIONS) {
      issues.push({ path: `${path}.options`, message: `a select needs 1 to ${MAX_OPTIONS} options` });
    } else if (o.some((v) => typeof v !== "string" || v.length < 1 || v.length > MAX_OPTION_LENGTH)) {
      issues.push({ path: `${path}.options`, message: `every option must be a string of 1 to ${MAX_OPTION_LENGTH} characters` });
    } else if (new Set(o).size !== o.length) {
      issues.push({ path: `${path}.options`, message: "options must be distinct" });
    }
  } else if (raw.options !== undefined) {
    issues.push({ path: `${path}.options`, message: "is only for select fields" });
  }

  // Mistyped contact field: the data-subject correlators would be silently lost (see the header).
  if (typeof key === "string" && (t === "text" || t === "textarea")) {
    const k = key;
    if (EMAIL_LOOKING.test(k)) issues.push({ path: `${path}.type`, message: `"${k}" looks like an email address field; type it "email" so submitters can be found by privacy.find` });
    if (PHONE_LOOKING.test(k)) issues.push({ path: `${path}.type`, message: `"${k}" looks like a phone field; type it "tel" so submitters can be found by privacy.find` });
  }
  if (issues.length > before) return null;
  const out: FormFieldDef = { key: key as string, type: t as FormFieldType };
  if (raw.required !== undefined) out.required = raw.required as boolean;
  if (raw.maxLength !== undefined) out.maxLength = raw.maxLength as number;
  if (raw.min !== undefined) out.min = raw.min as number;
  if (raw.max !== undefined) out.max = raw.max as number;
  if (raw.options !== undefined) out.options = raw.options as string[];
  return out;
}

function validateNotify(raw: unknown, issues: FormDefinitionIssue[]): FormNotify {
  if (raw === undefined) return {};
  if (!isObj(raw)) {
    issues.push({ path: "notify", message: "must be an object" });
    return {};
  }
  unknownKeys(raw, ["to", "templateKey", "autoresponder", "autoresponderTemplateKey"], "notify", issues);
  const out: FormNotify = {};
  if (raw.to !== undefined) {
    const to = raw.to;
    if (!isObj(to)) issues.push({ path: "notify.to", message: "must be an object { email, name? }" });
    else {
      unknownKeys(to, ["email", "name"], "notify.to", issues);
      if (typeof to.email !== "string" || to.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.email)) {
        issues.push({ path: "notify.to.email", message: "must be an email address" });
      } else {
        out.to = { email: to.email };
        if (to.name !== undefined) {
          if (typeof to.name !== "string" || to.name.length < 1 || to.name.length > 200) issues.push({ path: "notify.to.name", message: "must be a string of 1 to 200 characters" });
          else out.to.name = to.name;
        }
      }
    }
  }
  for (const k of ["templateKey", "autoresponderTemplateKey"] as const) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw[k] as string)) issues.push({ path: `notify.${k}`, message: "must match [a-z0-9][a-z0-9_-]{0,63}" });
    else out[k] = raw[k] as string;
  }
  if (raw.autoresponder !== undefined) {
    if (typeof raw.autoresponder !== "boolean") issues.push({ path: "notify.autoresponder", message: "must be a boolean" });
    else out.autoresponder = raw.autoresponder;
  }
  return out;
}

/** Validates the body of `forms.define` for form `key`. Lists EVERY problem found, not the first. */
export function parseFormDefinition(key: unknown, body: unknown): FormDefinitionResult {
  const issues: FormDefinitionIssue[] = [];
  if (typeof key !== "string" || !FORM_KEY_RE.test(key)) issues.push({ path: "key", message: "must match [a-z0-9][a-z0-9_-]{0,63}" });
  if (!isObj(body)) return { ok: false, issues: [...issues, { path: "(body)", message: "must be a JSON object" }] };
  unknownKeys(body, ["schema", "notify", "retentionDays", "consentNoticeVersion"], "", issues);

  // ── schema ──
  const fields: FormFieldDef[] = [];
  let honeypotField: string | undefined;
  let consentText: string | undefined;
  let attachments: FormSchemaDef["attachments"];
  const schema = body.schema;
  if (!isObj(schema)) {
    issues.push({ path: "schema", message: "is required and must be an object" });
  } else {
    unknownKeys(schema, ["fields", "honeypotField", "consentNotice", "attachments"], "schema", issues);
    if (!Array.isArray(schema.fields) || schema.fields.length < 1 || schema.fields.length > MAX_FIELDS) {
      issues.push({ path: "schema.fields", message: `must be an array of 1 to ${MAX_FIELDS} fields` });
    } else {
      schema.fields.forEach((f, i) => {
        const v = validateField(f, i, issues);
        if (v) fields.push(v);
      });
      const seen = new Set<string>();
      for (const f of fields) {
        if (seen.has(f.key)) issues.push({ path: "schema.fields", message: `field key "${f.key}" is declared twice` });
        seen.add(f.key);
      }
    }

    if (schema.honeypotField !== undefined) {
      const h = schema.honeypotField;
      if (typeof h !== "string" || !FIELD_KEY_RE.test(h)) issues.push({ path: "schema.honeypotField", message: "must match [a-z0-9_]{1,64}" });
      else if (fields.some((f) => f.key === h) || (Array.isArray(schema.fields) && schema.fields.some((f) => isObj(f) && f.key === h))) {
        issues.push({ path: "schema.honeypotField", message: `"${h}" is also a field key; a honeypot is a trap, not an input` });
      } else if (RESERVED_BODY_MEMBERS.includes(h)) {
        issues.push({ path: "schema.honeypotField", message: `"${h}" is a member of the submit body and cannot be the honeypot` });
      } else honeypotField = h;
    }

    const cn = schema.consentNotice;
    if (!isObj(cn)) {
      issues.push({ path: "schema.consentNotice", message: "is required: every submission snapshots a notice text" });
    } else {
      unknownKeys(cn, ["text"], "schema.consentNotice", issues);
      if (typeof cn.text !== "string" || cn.text.trim().length === 0 || cn.text.length > MAX_NOTICE_TEXT) {
        issues.push({ path: "schema.consentNotice.text", message: `must be non-empty text of at most ${MAX_NOTICE_TEXT} characters` });
      } else consentText = cn.text.trim();
    }

    if (schema.attachments !== undefined) {
      const a = schema.attachments;
      if (!isObj(a)) issues.push({ path: "schema.attachments", message: "must be an object" });
      else {
        unknownKeys(a, ["allowed", "maxCount"], "schema.attachments", issues);
        const out: NonNullable<FormSchemaDef["attachments"]> = {};
        if (a.allowed !== undefined) {
          if (typeof a.allowed !== "boolean") issues.push({ path: "schema.attachments.allowed", message: "must be a boolean" });
          else out.allowed = a.allowed;
        }
        if (a.maxCount !== undefined) {
          if (typeof a.maxCount !== "number" || !Number.isInteger(a.maxCount) || a.maxCount < 0 || a.maxCount > MAX_ATTACHMENT_COUNT) {
            issues.push({ path: "schema.attachments.maxCount", message: `must be an integer from 0 to ${MAX_ATTACHMENT_COUNT}` });
          } else out.maxCount = a.maxCount;
        }
        attachments = out;
      }
    }
  }

  // ── the rest of the body ──
  const notify = validateNotify(body.notify, issues);

  const rd = body.retentionDays;
  if (typeof rd !== "number" || !Number.isInteger(rd) || rd < MIN_RETENTION_DAYS || rd > MAX_RETENTION_DAYS) {
    issues.push({ path: "retentionDays", message: `is required: an integer from ${MIN_RETENTION_DAYS} to ${MAX_RETENTION_DAYS}` });
  }
  const cv = body.consentNoticeVersion;
  if (typeof cv !== "string" || !NOTICE_VERSION_RE.test(cv)) {
    issues.push({ path: "consentNoticeVersion", message: "is required: 1 to 64 characters of [A-Za-z0-9._:-], starting with a letter or digit" });
  }

  if (issues.length > 0 || consentText === undefined) return { ok: false, issues };
  const outSchema: FormDefinition["schema"] = { fields, consentNotice: { text: consentText } };
  if (honeypotField !== undefined) outSchema.honeypotField = honeypotField;
  if (attachments !== undefined) outSchema.attachments = attachments;
  return {
    ok: true,
    value: { key: key as string, schema: outSchema, notify, retentionDays: rd as number, consentNoticeVersion: cv as string },
  };
}
