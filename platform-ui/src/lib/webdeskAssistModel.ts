// M5-W6 — the writers' room AI assist, client-safe half (types, plain-words copy, and the pure rules for putting a suggestion into the
// editor's draft). NO `server-only` import: the drawer (a client component) imports this. The reader/validator is `webdeskAssist.ts`,
// the call is `webdeskAssistActions.ts`.
//
//   POST …/sites/:tenantSlug/:siteId/items/:itemId/assist   {kind, version?}
//     -> 200 {kind, itemId, version, headVersion, locale, advisory: true, suggestions[], notice?, provider, usage}
//     -> 422 assist-not-applicable {reason} · 429 assist-budget-exceeded {retryAfterSeconds…} · 503 assist-unavailable {reason}
//        502 assist-output-invalid · 409 item-deleted · 404 · 403 · 400                    (docs/FRONTEND-BFF-CONTRACT.md, M5-W6)
//
// SUGGESTIONS ONLY. Assist writes nothing. `applySuggestion` below returns a NEW draft for the editor to hold as an UNSAVED edit; the human
// then saves through the normal save (`baseVersion`, lint, history behave as for any edit). Nothing in the drawer saves or publishes.
//
// NO SUGGESTION TEXT LEAVES THE PAGE except to the clipboard, at the user's click. Nothing here logs, and no failure's words quote a
// suggestion or an error body.
import { defaultValueFor, fieldLabel, type FieldDef } from "./webdeskContentModel";

export const ASSIST_KINDS = ["outline", "meta_description", "faq", "translate_draft", "alt_text"] as const;
export type AssistKind = (typeof ASSIST_KINDS)[number];

export function isAssistKind(s: unknown): s is AssistKind {
  return typeof s === "string" && (ASSIST_KINDS as readonly string[]).includes(s);
}

export interface AssistKindInfo {
  /** The action's name on the button. */
  label: string;
  /** One line under it: what it reads and what it gives. */
  hint: string;
}

export const ASSIST_KIND_INFO: Record<AssistKind, AssistKindInfo> = {
  outline: { label: "Outline", hint: "A heading outline from the title, keyword and opening text." },
  meta_description: { label: "Meta description", hint: "A search-result description of 120 to 155 characters." },
  faq: { label: "FAQ", hint: "Three to eight questions and answers from the text." },
  translate_draft: { label: "English to Indonesian first draft", hint: "A machine first draft of the prose fields. It needs a human." },
  alt_text: { label: "Alt text", hint: "Alt text for images in the text that have none." },
};

/** The sentence a translated draft must be shown with (the BFF also sends it as `notice`; this is the floor if it did not). */
export const FIRST_DRAFT_NOTICE = "First draft — needs a human";

// ── What the BFF answers ─────────────────────────────────────────────────────────────────────────

export type AssistSuggestion =
  | { id: string; kind: "meta_description"; target: string; text: string; length: number }
  | { id: string; kind: "outline"; headings: { level: number; text: string }[]; markdown: string }
  | { id: string; kind: "faq"; question: string; answer: string }
  | { id: string; kind: "translate_draft"; sourcePath: string; field: string; locale: string; text: string; notice: string }
  | { id: string; kind: "alt_text"; target: string; index: number; imageRef: string; alt: string };

export interface AssistUsage {
  callsUsed: number | null;
  callsLimit: number | null;
  /** Always an estimate (the gateway reports none); never shown as exact. */
  tokensEstimatedUsed: number | null;
  tokensLimit: number | null;
}

export interface AssistBody {
  kind: AssistKind;
  itemId: string;
  /** The version the suggestions were made from. */
  version: number | null;
  headVersion: number | null;
  locale: string;
  suggestions: AssistSuggestion[];
  /** Shown with a translated draft. */
  notice: string | null;
  provider: string | null;
  usage: AssistUsage | null;
}

/** Every way a call can fail, as data (never thrown), so the drawer can say each one in words and keep what the user has. */
export type AssistFailure =
  | { kind: "not_applicable"; reason: string | null }
  | { kind: "budget"; retryAfterSeconds: number | null }
  | { kind: "unavailable"; reason: string | null }
  | { kind: "invalid_output" }
  | { kind: "deleted" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "bad_request"; message: string }
  | { kind: "session" }
  | { kind: "unreachable" }
  | { kind: "drift"; reason: string };

export type AssistResult = { ok: true; data: AssistBody } | { ok: false; failure: AssistFailure };

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

const NOT_APPLICABLE_WORDS: Record<string, string> = {
  no_text: "This item has no text yet, so there is nothing to base a suggestion on. Write some, save it, and try again.",
  not_enough_text: "There is not enough text on this item yet for this kind of suggestion (it needs a couple of paragraphs). Write more, save it, and try again.",
  source_not_english: "The Indonesian first draft is made from English text, and this item is not in English.",
  no_image_without_alt: "Every image in this item's text already has alt text, so there is nothing to suggest.",
};

/** "in about 3 hours" / "in about 40 minutes" / "soon". Never a raw number of seconds. */
export function resetsIn(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return "in about a minute";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `in about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return `in about ${hours} hour${hours === 1 ? "" : "s"}`;
}

/** Plain words for a failed call: never a status code, a slug or the body; always what happened to the user's text (nothing) and what to do. */
export function assistFailureCopy(f: AssistFailure): string {
  switch (f.kind) {
    case "not_applicable":
      return (f.reason && NOT_APPLICABLE_WORDS[f.reason]) || "This item does not have what that kind of suggestion needs. Nothing was suggested.";
    case "budget": {
      const when = resetsIn(f.retryAfterSeconds);
      return `You have used today's AI suggestions. The allowance resets at 00:00 UTC${when ? ` (${when})` : ""}. Nothing was changed.`;
    }
    case "unavailable":
      return "The writing assistant is not available right now. Nothing was suggested and nothing was changed. Try again later.";
    case "invalid_output":
      return "The assistant answered, but not in a form that fits this page's rules, so nothing was suggested. Try again.";
    case "deleted":
      return "This item has been deleted, so there is nothing to suggest for.";
    case "forbidden":
      return "You don't have permission to use the writing assistant on this item. Nothing was changed.";
    case "not_found":
      return "This item no longer exists in WebDesk. Nothing was changed.";
    case "bad_request":
      return f.message ? `That request wasn't accepted: ${f.message} Nothing was changed.` : "That request wasn't accepted. Nothing was changed.";
    case "session":
      return "Your session has expired. Sign in again; nothing was changed.";
    case "unreachable":
      return "The writing assistant could not be reached. Nothing was suggested and nothing was changed.";
    case "drift":
      return `The assistant answered with something unexpected (${f.reason}), so none of it was used. Nothing was changed.`;
  }
}

// ── Applying a suggestion to the editor's draft ──────────────────────────────────────────────────

/** What the drawer may change: exactly what the editor holds as its unsaved draft. */
export interface DraftState {
  fields: Record<string, unknown>;
  seo: Record<string, unknown>;
}

export interface ApplyCtx {
  /** The collection's declared fields (what the form shows). */
  defs: FieldDef[];
  /** The draft right now. */
  draft: DraftState;
  /** The locale the editor is on. */
  locale: string;
  /** The tenant's default locale (a locale-neutral member is read-only on any other). */
  defaultLocale: string;
  /** The collection keeps no separate SEO description control (a system collection such as redirect). */
  seoCarrier: boolean;
  /** The collection is locale-neutral as a whole (one item, in the default locale). */
  localeNeutralCollection: boolean;
}

export interface ApplyTarget {
  /** A stable key, passed back to `applySuggestion`. */
  key: string;
  /** "Add to the end of Body". */
  label: string;
}

export interface ApplyOptions {
  targets: ApplyTarget[];
  /** Why there is no target (shown beside Copy); null when there is at least one. */
  why: string | null;
}

/** A top-level field the drawer may write: it exists, is not a derived column, and is not locked by locale neutrality. */
function writable(def: FieldDef, ctx: ApplyCtx): boolean {
  if (def.ui?.readOnly) return false;
  const nonDefault = ctx.locale !== ctx.defaultLocale && !ctx.localeNeutralCollection;
  if (nonDefault && def.localized === false) return false;
  return true;
}

function textDefs(ctx: ApplyCtx, primitives: FieldDef["primitive"][]): FieldDef[] {
  return ctx.defs.filter((d) => !d.multiple && primitives.includes(d.primitive) && writable(d, ctx));
}

const SUB_TEXT: ReadonlyArray<FieldDef["primitive"]> = ["text", "markdown", "richtext"];

/** A top-level list of groups with a question and an answer (and nothing else required), where an FAQ row can be added as a row. */
function faqList(ctx: ApplyCtx): FieldDef | null {
  for (const d of ctx.defs) {
    if (!d.multiple || d.primitive !== "group" || !writable(d, ctx)) continue;
    const subs = d.fields ?? [];
    const q = subs.find((s) => s.name === "question" && SUB_TEXT.includes(s.primitive) && !s.multiple);
    const a = subs.find((s) => s.name === "answer" && SUB_TEXT.includes(s.primitive) && !s.multiple);
    if (!q || !a) continue;
    if (subs.some((s) => s !== q && s !== a && s.required)) continue; // a required third member would make the new row invalid
    return d;
  }
  return null;
}

/** `/blocks/0/props/<key>` -> `<key>` (RFC 6901 unescaped); null for anything else (another block, a nested path). */
export function fieldKeyOfPointer(pointer: string): string | null {
  const m = /^\/blocks\/0\/props\/([^/]+)$/.exec(pointer);
  return m ? m[1].replace(/~1/g, "/").replace(/~0/g, "~") : null;
}

/** The suggestion's own words for what can be copied. */
export function copyTextOf(s: AssistSuggestion): string {
  switch (s.kind) {
    case "meta_description": return s.text;
    case "outline": return s.markdown;
    case "faq": return `${s.question}\n\n${s.answer}`;
    case "translate_draft": return s.text;
    case "alt_text": return s.alt;
  }
}

/** Where the suggestion can go in THIS editor. Empty `targets` means Copy only, with the reason in `why`. */
export function applyOptions(s: AssistSuggestion, ctx: ApplyCtx): ApplyOptions {
  switch (s.kind) {
    case "meta_description": {
      if (ctx.seoCarrier) return { targets: [], why: "This collection has no search description field in the editor." };
      return { targets: [{ key: "seo.description", label: "Set the SEO description" }], why: null };
    }
    case "outline": {
      const t = textDefs(ctx, ["markdown"]).map((d) => ({ key: `append:${d.name}`, label: `Add to the end of ${fieldLabel(d)}` }));
      return t.length ? { targets: t, why: null } : { targets: [], why: "This editor has no text field an outline can be added to." };
    }
    case "faq": {
      const targets: ApplyTarget[] = [];
      const list = faqList(ctx);
      if (list) targets.push({ key: `row:${list.name}`, label: `Add as a row in ${fieldLabel(list)}` });
      for (const d of textDefs(ctx, ["markdown"])) targets.push({ key: `append:${d.name}`, label: `Add to the end of ${fieldLabel(d)}` });
      return targets.length ? { targets, why: null } : { targets: [], why: "This editor has no FAQ list or text field to add it to." };
    }
    case "translate_draft": {
      // The draft is Indonesian text made from this (English) item. It belongs to the item's Indonesian twin, which is a SEPARATE item the
      // editor does not have open. It applies only when the editor IS on that locale and has the field; otherwise: Copy only, and say why.
      const def = ctx.locale === s.locale ? ctx.defs.find((d) => d.name === s.field && !d.multiple && SUB_TEXT.includes(d.primitive)) : undefined;
      if (def && writable(def, ctx)) return { targets: [{ key: `set:${def.name}`, label: `Replace ${fieldLabel(def)}` }], why: null };
      return {
        targets: [],
        why: `The ${s.locale.toUpperCase()} version is a separate item (the “${s.locale}” twin), and this editor is not on it. Copy the draft, then open or create that twin and paste it there.`,
      };
    }
    case "alt_text": {
      const key = fieldKeyOfPointer(s.target);
      if (key === null) return { targets: [], why: "This image sits in a part of the page this form does not edit. Copy the alt text and add it where the image is." };
      const def = ctx.defs.find((d) => d.name === key);
      if (!def || def.multiple || !writable(def, ctx)) return { targets: [], why: "The field this image sits in cannot be edited here. Copy the alt text and add it where the image is." };
      return { targets: [{ key: `alt:${key}`, label: "Put it on the image" }], why: null };
    }
  }
}

export type ApplyOutcome = { ok: true; draft: DraftState } | { ok: false; message: string };

const append = (current: unknown, add: string): string => {
  const base = typeof current === "string" ? current : "";
  return base.trim() === "" ? add : `${base.replace(/\s+$/, "")}\n\n${add}`;
};

/** The image's address in the markdown, cut the way the BFF cut `imageRef` (300 chars). */
const REF_CAP = 300;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;

/** Put `alt` on the first image of `text` that has none and whose address is `ref`; null when there is no such image. */
export function putAltOnImage(text: string, ref: string, alt: string): string | null {
  let done = false;
  const out = text.replace(IMAGE_RE, (whole, existing: string, url: string, title: string) => {
    if (done || existing.trim() !== "" || url.slice(0, REF_CAP) !== ref) return whole;
    done = true;
    return `![${alt.replace(/([[\]\\])/g, "\\$1")}](${url}${title})`;
  });
  return done ? out : null;
}

/**
 * The new draft with the suggestion in it, or the reason it could not be applied. PURE: it never saves, never mutates `ctx.draft`, and the
 * caller holds the result as an UNSAVED edit. `targetKey` is one of `applyOptions(...).targets[].key`.
 */
export function applySuggestion(s: AssistSuggestion, targetKey: string, ctx: ApplyCtx): ApplyOutcome {
  const opts = applyOptions(s, ctx);
  if (!opts.targets.some((t) => t.key === targetKey)) return { ok: false, message: opts.why ?? "That can't be applied here." };
  const { fields, seo } = ctx.draft;
  const [mode, name] = [targetKey.slice(0, targetKey.indexOf(":")), targetKey.slice(targetKey.indexOf(":") + 1)];

  if (s.kind === "meta_description") return { ok: true, draft: { fields, seo: { ...seo, description: s.text } } };

  if (s.kind === "outline" && mode === "append") return { ok: true, draft: { fields: { ...fields, [name]: append(fields[name], s.markdown) }, seo } };

  if (s.kind === "faq") {
    if (mode === "append") return { ok: true, draft: { fields: { ...fields, [name]: append(fields[name], `**${s.question}**\n\n${s.answer}`) }, seo } };
    if (mode === "row") {
      const list = faqList(ctx);
      if (!list || list.name !== name) return { ok: false, message: "That list is no longer in this form." };
      const rows = Array.isArray(fields[name]) ? (fields[name] as unknown[]) : [];
      const row: Record<string, unknown> = {};
      for (const sub of list.fields ?? []) if (sub.required && sub.name !== "question" && sub.name !== "answer") row[sub.name] = defaultValueFor(sub);
      row.question = s.question; row.answer = s.answer;
      return { ok: true, draft: { fields: { ...fields, [name]: [...rows, row] }, seo } };
    }
  }

  if (s.kind === "translate_draft" && mode === "set") return { ok: true, draft: { fields: { ...fields, [name]: s.text }, seo } };

  if (s.kind === "alt_text" && mode === "alt") {
    const current = fields[name];
    if (typeof current !== "string") return { ok: false, message: "That field has no text any more, so there is no image to change." };
    const next = putAltOnImage(current, s.imageRef, s.alt);
    if (next === null) return { ok: false, message: "That image already has alt text, or is no longer in the text, so nothing was changed." };
    return { ok: true, draft: { fields: { ...fields, [name]: next }, seo } };
  }

  return { ok: false, message: "That can't be applied here." };
}

/** What a suggestion is "about", for the list: the thing a person scans for. */
export function suggestionTitle(s: AssistSuggestion): string {
  switch (s.kind) {
    case "meta_description": return `${s.text.length} characters`;
    case "outline": return `${s.headings.length} headings`;
    case "faq": return s.question;
    case "translate_draft": return s.field.replace(/[_-]+/g, " ");
    case "alt_text": return s.imageRef.split(/[?#]/)[0].split("/").pop() || "image";
  }
}
