// SCP-1a — the brand book's rules (BFF §63.1 `social_brand_profiles`, §63.4). PURE: no database, no request.
//
// The brand book is the client's, and it lives on `social_brand_profiles` beside the voice settings `ai-drafts.ts` reads. Two of its fields are
// KEYS INSIDE existing jsonb columns (`tone.summary`, `hashtag_strategy.sets`); the other six are new columns. `GET`/`PATCH brand-profiles/:clientId`
// (`social.controller.ts`) call these functions; each throws a 400 `{error: "invalid_field", field}` naming the request field.
//
// AN ABSENT FIELD IS UNTOUCHED (the PATCH's standing rule): `parseBrandBook` returns only the fields the body carried.
//
// MERGING INTO A jsonb COLUMN MUST NOT ERASE ITS SIBLINGS. `mergeToneSummary` and `mergeHashtagSets` set one key on the column's current
// object. A caller that replaces the whole `tone` or `hashtagStrategy` object without the brand-book key keeps the stored one
// (`carryKey`), so a legacy writer cannot wipe a brand book it has never heard of.
import { BadRequestException } from "@nestjs/common";

/** The ten networks of `social_accounts` / `social_engagements.platforms` (BFF §63.1). */
export const NETWORKS = ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"] as const;

export const BRAND_LIMITS = {
  toneSummary: 200,
  contentPillars: { max: 20, each: 60 },
  mustHaveNotes: { max: 20, each: 300 },
  brandRules: { max: 30, each: 300 },
  hashtagSets: { max: 10, name: 60, tags: 30, tag: 100 },
  channels: { max: 30, handle: 100, url: 500 },
  keyDates: { max: 100, label: 120 },
  links: { max: 30, label: 100, url: 500 },
} as const;

/** The request fields of the brand book, in the order the answer lists them. */
export const BRAND_BOOK_FIELDS = [
  "toneSummary", "contentPillars", "mustHaveNotes", "brandRules", "hashtagSets", "channels", "keyDates", "links",
] as const;

export interface HashtagSet { name: string; tags: string[] }
export interface BrandChannel { network: string; handle: string; url?: string }
export interface KeyDate { date: string; label: string }
export interface BrandLink { label: string; url: string }

/** The validated brand-book fields of one PATCH body: only the ones the body carried. */
export interface BrandBookPatch {
  toneSummary?: string;
  contentPillars?: string[];
  mustHaveNotes?: string[];
  brandRules?: string[];
  hashtagSets?: HashtagSet[];
  channels?: BrandChannel[];
  keyDates?: KeyDate[];
  links?: BrandLink[];
}

export function invalidField(field: string): never {
  throw new BadRequestException({ message: "invalid_field", field });
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A trimmed, non-empty string of at most `max` characters, or 400 on `field`. */
function shortText(v: unknown, max: number, field: string): string {
  if (typeof v !== "string") return invalidField(field);
  const t = v.trim();
  if (t.length === 0 || t.length > max) return invalidField(field);
  return t;
}

function textList(v: unknown, lim: { max: number; each: number }, field: string): string[] {
  if (!Array.isArray(v) || v.length > lim.max) return invalidField(field);
  return v.map((x) => shortText(x, lim.each, field));
}

/** An `http` or `https` URL no longer than `max`. */
export function httpUrl(v: unknown, max: number, field: string): string {
  const s = shortText(v, max, field);
  let u: URL;
  try { u = new URL(s); } catch { return invalidField(field); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return invalidField(field);
  return s;
}

/** Only these keys; anything else is a 400 on `field`. */
function onlyKeys(o: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) invalidField(field);
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // February 29 is allowed: a yearly date may name it

/** `MM-DD` (a real day of a leap year) or a real `YYYY-MM-DD`. */
export function isKeyDate(s: string): boolean {
  let m = /^(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    return mo >= 1 && mo <= 12 && d >= 1 && d <= DAYS_IN_MONTH[mo - 1];
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const dt = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === s;
}

/** A tag is a single token without `#` or whitespace (the `#` is added when a post is written). */
function tagText(v: unknown, field: string): string {
  if (typeof v !== "string") return invalidField(field);
  const t = v.trim();
  if (t.length === 0 || t.length > BRAND_LIMITS.hashtagSets.tag || t.includes("#") || /\s/.test(t)) return invalidField(field);
  return t;
}

/** `[{name ≤ 60, tags: string[] ≤ 30 each without '#'}]`, at most 10 sets. */
export function parseHashtagSets(v: unknown, field: string): HashtagSet[] {
  const lim = BRAND_LIMITS.hashtagSets;
  if (!Array.isArray(v) || v.length > lim.max) return invalidField(field);
  return v.map((raw) => {
    if (!isPlainObject(raw)) return invalidField(field);
    onlyKeys(raw, ["name", "tags"], field);
    const name = shortText(raw.name, lim.name, field);
    if (!Array.isArray(raw.tags) || raw.tags.length > lim.tags) return invalidField(field);
    return { name, tags: raw.tags.map((t) => tagText(t, field)) };
  });
}

function parseChannels(v: unknown, field: string): BrandChannel[] {
  const lim = BRAND_LIMITS.channels;
  if (!Array.isArray(v) || v.length > lim.max) return invalidField(field);
  return v.map((raw) => {
    if (!isPlainObject(raw)) return invalidField(field);
    onlyKeys(raw, ["network", "handle", "url"], field);
    if (typeof raw.network !== "string" || !(NETWORKS as readonly string[]).includes(raw.network)) return invalidField(field);
    const out: BrandChannel = { network: raw.network, handle: shortText(raw.handle, lim.handle, field) };
    if (raw.url !== undefined && raw.url !== null && raw.url !== "") out.url = httpUrl(raw.url, lim.url, field);
    return out;
  });
}

function parseKeyDates(v: unknown, field: string): KeyDate[] {
  const lim = BRAND_LIMITS.keyDates;
  if (!Array.isArray(v) || v.length > lim.max) return invalidField(field);
  return v.map((raw) => {
    if (!isPlainObject(raw)) return invalidField(field);
    onlyKeys(raw, ["date", "label"], field);
    if (typeof raw.date !== "string" || !isKeyDate(raw.date)) return invalidField(field);
    return { date: raw.date, label: shortText(raw.label, lim.label, field) };
  });
}

function parseLinks(v: unknown, field: string): BrandLink[] {
  const lim = BRAND_LIMITS.links;
  if (!Array.isArray(v) || v.length > lim.max) return invalidField(field);
  return v.map((raw) => {
    if (!isPlainObject(raw)) return invalidField(field);
    onlyKeys(raw, ["label", "url"], field);
    return { label: shortText(raw.label, lim.label, field), url: httpUrl(raw.url, lim.url, field) };
  });
}

/** The tone summary: a string of at most 200 characters; "" clears it. */
export function parseToneSummary(v: unknown, field: string): string {
  if (typeof v !== "string") return invalidField(field);
  const t = v.trim();
  if (t.length > BRAND_LIMITS.toneSummary) return invalidField(field);
  return t;
}

/** Validates the brand-book fields of a PATCH body and returns the ones it carried. Throws a 400 on the first bad field. */
export function parseBrandBook(body: Record<string, unknown>): BrandBookPatch {
  const out: BrandBookPatch = {};
  if (body.toneSummary !== undefined) out.toneSummary = parseToneSummary(body.toneSummary, "toneSummary");
  if (body.contentPillars !== undefined) out.contentPillars = textList(body.contentPillars, BRAND_LIMITS.contentPillars, "contentPillars");
  if (body.mustHaveNotes !== undefined) out.mustHaveNotes = textList(body.mustHaveNotes, BRAND_LIMITS.mustHaveNotes, "mustHaveNotes");
  if (body.brandRules !== undefined) out.brandRules = textList(body.brandRules, BRAND_LIMITS.brandRules, "brandRules");
  if (body.hashtagSets !== undefined) out.hashtagSets = parseHashtagSets(body.hashtagSets, "hashtagSets");
  if (body.channels !== undefined) out.channels = parseChannels(body.channels, "channels");
  if (body.keyDates !== undefined) out.keyDates = parseKeyDates(body.keyDates, "keyDates");
  if (body.links !== undefined) out.links = parseLinks(body.links, "links");
  return out;
}

/** A whole-object `tone` or `hashtagStrategy` write must be a plain object. */
export function requireObject(v: unknown, field: string): Record<string, unknown> {
  return isPlainObject(v) ? v : invalidField(field);
}

/**
 * The `tone` object to store. `current` is the stored one. A whole-object `tone` write replaces it but KEEPS the stored `summary` unless the
 * new object names one; `toneSummary` sets (or, with "", clears) only that key and leaves every sibling.
 */
export function mergeToneSummary(
  current: Record<string, unknown>, wholeTone: Record<string, unknown> | undefined, summary: string | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = wholeTone === undefined ? { ...current } : { ...wholeTone };
  if (wholeTone !== undefined && !("summary" in wholeTone) && "summary" in current) base.summary = current.summary;
  if (summary !== undefined) {
    if (summary === "") delete base.summary;
    else base.summary = summary;
  }
  return base;
}

/** The `hashtag_strategy` object to store: the same rule as `mergeToneSummary`, for the key `sets`. */
export function mergeHashtagSets(
  current: Record<string, unknown>, wholeStrategy: Record<string, unknown> | undefined, sets: HashtagSet[] | undefined,
): Record<string, unknown> {
  const base: Record<string, unknown> = wholeStrategy === undefined ? { ...current } : { ...wholeStrategy };
  if (wholeStrategy !== undefined && !("sets" in wholeStrategy) && "sets" in current) base.sets = current.sets;
  if (sets !== undefined) base.sets = sets;
  return base;
}

/** Reads the brand-book view of the stored `tone` and `hashtag_strategy`. */
export function toneSummaryOf(tone: unknown): string {
  return isPlainObject(tone) && typeof tone.summary === "string" ? tone.summary : "";
}
export function hashtagSetsOf(strategy: unknown): HashtagSet[] {
  if (!isPlainObject(strategy) || !Array.isArray(strategy.sets)) return [];
  return strategy.sets.filter((s): s is HashtagSet => isPlainObject(s) && typeof s.name === "string" && Array.isArray(s.tags));
}
