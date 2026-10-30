// SCP-5e (W5-B3) — Saved, each client's content bank: the PURE half (FRONTEND-BFF-CONTRACT §63.26). The rows are saved-data.ts's,
// the routes are saved.controller.ts's, and the use count that rides the post edit is saved-data.ts's `countSavedUse`.
//
// WHAT IS STORED, AND WHAT IS ONLY READ. The bank stores what has no other home: `asset` (an Asset Library group kept for a client), `link`
// (a Drive or web link: every video is one, SCP-Q30) and `text` (a caption, a template). A design's photo, an approved post and a hashtag
// set are READ from where they live. A category is the company's (`saved.categories`, §63.30, read through `socialRules`); this file never
// names a seeded one except the three the rules keep read-only for storing (`posts`, `hashtags`) and the category `photos` that also shows
// design photos: `DERIVED_SAVED_CATEGORIES` in rules.ts is where that is said.
//
// REFUSALS (400, after the decision): `invalid_field` / `missing_field` with `{field}`. A category the company does not have, has hidden,
// or that does not take the item's shape is `{field: 'category'}`. The order inside a body is the order of `parseSavedCreate`.
import type { SavedCategoryView, SavedHolds } from "./rules";
import { SAVED_HOLDS, SAVED_OTHER_KEY } from "./rules";
import { ScpRouteError } from "./pipeline-effects";

export const SAVED_SOURCES = ["own", "client", "stock", "ai", "unknown"] as const;
export type SavedSource = (typeof SAVED_SOURCES)[number];
export const SAVED_MEDIA = ["photo", "video"] as const;
export type SavedMedia = (typeof SAVED_MEDIA)[number];
export const SAVED_LIMITS = { title: 120, body: 5000, url: 500, pillar: 60, aiNote: 1000, useIds: 10, pageDefault: 30, pageMax: 100, previews: 4 } as const;

/** The collection key of the items whose category the company no longer has (63.26.1). */
export const OTHER_COLLECTION = SAVED_OTHER_KEY;
export const OTHER_LABEL = "Other";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;
const bad = (field: string) => new ScpRouteError(400, "invalid_field", { field });
const missing = (field: string) => new ScpRouteError(400, "missing_field", { field });
/** Characters as the database counts them (`char_length`): code points, not UTF-16 units. */
const len = (s: string) => [...s].length;

// ── Categories ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `key` is an enabled category of the company that STORES items of shape `holds` (63.26.3: "an enabled, stored category … that takes holds"). */
export function categoryTakes(categories: readonly SavedCategoryView[], key: string, holds: SavedHolds): boolean {
  const c = categories.find((x) => x.key === key);
  return !!c && c.enabled && c.holds.includes(holds);
}

// ── POST body ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SavedCreate {
  id: string | null;
  category: string;
  holds: SavedHolds;
  title: string;
  body: string | null;
  url: string | null;
  media: SavedMedia | null;
  assetGroupId: string | null;
  pillar: string | null;
  source: SavedSource | null;
  aiNote: string | null;
}

const CREATE_KEYS = ["id", "category", "holds", "title", "body", "url", "media", "assetGroupId", "pillar", "source", "aiNote"] as const;

/** A trimmed string of 1 to `max` characters, or 400 on `field`. */
function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") throw bad(field);
  const t = v.trim();
  if (len(t) < 1 || len(t) > max) throw bad(field);
  return t;
}

/** An http(s) link of at most 500 characters with no white space. */
function link(v: unknown, field: string): string {
  const t = text(v, field, SAVED_LIMITS.url);
  if (!/^https?:\/\/\S+$/i.test(t)) throw bad(field);
  try {
    new URL(t);
  } catch {
    throw bad(field);
  }
  return t;
}

function oneOf<T extends string>(v: unknown, field: string, list: readonly T[]): T {
  if (typeof v !== "string" || !(list as readonly string[]).includes(v)) throw bad(field);
  return v as T;
}

/**
 * PURE. The body of `POST engagements/:engagementId/saved`, judged AFTER authorization (§63.0). The shape of each `holds` is the table's CHECK
 * (63.26.1), said as a typed refusal before the database has to: an `asset` carries its group and nothing else (its source and AI note are the
 * asset's own, §63.6.6), a `link` its url and source (and, for `ai`, a note), a `text` its body.
 */
export function parseSavedCreate(body: unknown, categories: readonly SavedCategoryView[]): SavedCreate {
  if (!isObj(body)) throw missing("category");
  for (const k of Object.keys(body)) if (!(CREATE_KEYS as readonly string[]).includes(k)) throw bad(k);
  if (!absent(body.id) && !isUuid(body.id)) throw bad("id");
  if (absent(body.category)) throw missing("category");
  if (absent(body.holds)) throw missing("holds");
  const holds = oneOf(body.holds, "holds", SAVED_HOLDS);
  if (typeof body.category !== "string" || !categoryTakes(categories, body.category, holds)) throw bad("category");
  if (absent(body.title)) throw missing("title");
  const out: SavedCreate = {
    id: absent(body.id) ? null : (body.id as string).toLowerCase(),
    category: body.category, holds, title: text(body.title, "title", SAVED_LIMITS.title),
    body: null, url: null, media: null, assetGroupId: null, pillar: null, source: null, aiNote: null,
  };
  if (!absent(body.pillar)) out.pillar = text(body.pillar, "pillar", SAVED_LIMITS.pillar);

  const only = (allowed: readonly string[]) => {
    for (const f of ["body", "url", "media", "assetGroupId", "source", "aiNote"]) if (!allowed.includes(f) && !absent(body[f])) throw bad(f);
  };
  if (holds === "asset") {
    only(["assetGroupId"]);
    if (absent(body.assetGroupId)) throw missing("assetGroupId");
    if (!isUuid(body.assetGroupId)) throw bad("assetGroupId");
    out.assetGroupId = body.assetGroupId.toLowerCase();
  } else if (holds === "link") {
    only(["url", "media", "source", "aiNote"]);
    if (absent(body.url)) throw missing("url");
    out.url = link(body.url, "url");
    if (!absent(body.media)) out.media = oneOf(body.media, "media", SAVED_MEDIA);
    if (absent(body.source)) throw missing("source");
    out.source = oneOf(body.source, "source", SAVED_SOURCES);
    if (!absent(body.aiNote)) out.aiNote = text(body.aiNote, "aiNote", SAVED_LIMITS.aiNote);
    if (out.source === "ai" && out.aiNote === null) throw missing("aiNote");
  } else {
    only(["body"]);
    if (absent(body.body)) throw missing("body");
    out.body = text(body.body, "body", SAVED_LIMITS.body);
  }
  return out;
}

// ── PATCH body ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a stored item is, as far as a change needs: its shape and the link fields a change may leave as they are. */
export interface SavedShape { holds: SavedHolds; source: string | null; aiNote: string | null }

export interface SavedPatch {
  title?: string;
  body?: string;
  /** null clears. */
  pillar?: string | null;
  source?: SavedSource;
  /** null clears. */
  aiNote?: string | null;
  category?: string;
}

const PATCH_KEYS = ["title", "body", "pillar", "source", "aiNote", "category"] as const;

/**
 * PURE. The body of `PATCH saved/:itemId`: `{title?, body?, pillar?, source?, aiNote?}` for the item's own shape (63.26.3), and `category?`, so
 * an item left under "Other" by a removed category can be moved (63.26.1 says someone moves it; the route table lists no field for it).
 * A field the shape does not carry is 400 on that field: `body` only for a text, `source` and `aiNote` only for a link (an asset's are the
 * asset's own). A link whose source ends as `ai` keeps a note.
 */
export function parseSavedPatch(body: unknown, item: SavedShape, categories: readonly SavedCategoryView[]): SavedPatch {
  if (!isObj(body)) throw missing("title");
  for (const k of Object.keys(body)) if (!(PATCH_KEYS as readonly string[]).includes(k)) throw bad(k);
  if (Object.keys(body).length === 0) throw missing("title");
  const out: SavedPatch = {};
  if (body.title !== undefined) out.title = text(body.title, "title", SAVED_LIMITS.title);
  if (body.body !== undefined) {
    if (item.holds !== "text") throw bad("body");
    out.body = text(body.body, "body", SAVED_LIMITS.body);
  }
  if (body.pillar !== undefined) out.pillar = body.pillar === null ? null : text(body.pillar, "pillar", SAVED_LIMITS.pillar);
  if (body.source !== undefined) {
    if (item.holds !== "link") throw bad("source");
    out.source = oneOf(body.source, "source", SAVED_SOURCES);
  }
  if (body.aiNote !== undefined) {
    if (item.holds !== "link") throw bad("aiNote");
    out.aiNote = body.aiNote === null ? null : text(body.aiNote, "aiNote", SAVED_LIMITS.aiNote);
  }
  if (body.category !== undefined) {
    if (typeof body.category !== "string" || !categoryTakes(categories, body.category, item.holds)) throw bad("category");
    out.category = body.category;
  }
  if (item.holds === "link") {
    const source = out.source ?? item.source;
    const note = out.aiNote !== undefined ? out.aiNote : item.aiNote;
    if (source === "ai" && note === null) throw missing("aiNote");
  }
  return out;
}

// ── The list's query ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SavedListQuery {
  /** null: the collections. */
  collection: string | null;
  pillar: string | null;
  used: boolean | null;
  source: SavedSource | null;
  cursor: string | null;
  limit: number;
}

const one = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** PURE. The query of `GET engagements/:engagementId/saved`; `collection` must be an enabled category or `other`. */
export function parseSavedListQuery(q: Record<string, unknown>, categories: readonly SavedCategoryView[]): SavedListQuery {
  const collection = one(q.collection) ?? null;
  if (collection !== null && collection !== OTHER_COLLECTION && !categories.some((c) => c.key === collection && c.enabled)) throw bad("collection");
  const pillar = one(q.pillar);
  if (pillar !== undefined && len(pillar) > SAVED_LIMITS.pillar) throw bad("pillar");
  const usedRaw = one(q.used);
  if (usedRaw !== undefined && usedRaw !== "true" && usedRaw !== "false") throw bad("used");
  const sourceRaw = one(q.source);
  const source = sourceRaw === undefined ? null : oneOf(sourceRaw, "source", SAVED_SOURCES);
  const limitRaw = one(q.limit);
  let limit: number = SAVED_LIMITS.pageDefault;
  if (limitRaw !== undefined) {
    if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > SAVED_LIMITS.pageMax) throw bad("limit");
    limit = Number(limitRaw);
  }
  return { collection, pillar: pillar ?? null, used: usedRaw === undefined ? null : usedRaw === "true", source, cursor: one(q.cursor) ?? null, limit };
}

/** The opaque cursor: base64url of `<instant with microseconds>|<key>` (the list is newest first, then by key). */
export const encodeSavedCursor = (k: { at: string; key: string }): string => Buffer.from(`${k.at}|${k.key}`, "utf8").toString("base64url");
export function decodeSavedCursor(raw: string): { at: string; key: string } {
  const t = Buffer.from(raw, "base64url").toString("utf8");
  const i = t.indexOf("|");
  const at = t.slice(0, i);
  const key = t.slice(i + 1);
  if (i < 0 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(at) || key.length < 1 || key.length > 80 || encodeSavedCursor({ at, key }) !== raw) throw bad("cursor");
  return { at, key };
}

// ── `savedItemIds` on the post edit ─────────────────────────────────────────────────────────────────────────────────────

/** PURE. `savedItemIds` of `PATCH posts/:postId/pipeline` (63.26.3): 1 to 10 distinct uuids, lower-cased; else 400 `{field: 'savedItemIds'}`. */
export function parseSavedItemIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > SAVED_LIMITS.useIds) throw bad("savedItemIds");
  const ids = raw.map((x) => {
    if (!isUuid(x)) throw bad("savedItemIds");
    return x.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw bad("savedItemIds");
  return ids;
}

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SavedAssetRef { groupId: string; versionId: string; versionNo: number; contentType: string }
export interface SavedPerson { id: string; name: string }

/** A stored item, as `GET …?collection=` answers it for `captions`, `templates`, `references` and any category the company added. */
export interface SavedItem {
  id: string;
  category: string;
  holds: SavedHolds;
  title: string;
  body: string | null;
  url: string | null;
  media: SavedMedia | null;
  asset: SavedAssetRef | null;
  source: string | null;
  aiNote: string | null;
  pillar: string | null;
  useCount: number;
  lastUsedAt: string | null;
  used: boolean;
  addedBy: SavedPerson | null;
  addedAt: string;
}

/** One entry of the photos collection (63.26.3): a design's photo, a kept asset or a kept link. */
export interface SavedPhoto {
  key: string;
  savedItemId: string | null;
  holds: "asset" | "link";
  title: string;
  media: SavedMedia | null;
  asset: SavedAssetRef | null;
  url: string | null;
  source: string | null;
  aiNote: string | null;
  pillar: string | null;
  used: boolean;
  usedIn: number;
  addedBy: SavedPerson | null;
  addedAt: string;
}

export interface SavedPostEntry {
  postId: string;
  title: string;
  format: string | null;
  cycleMonth: string | null;
  thumbFileId: string | null;
  pipelineStatus: string;
  simulated: boolean;
}

export interface SavedHashtagSet { key: string; name: string; tags: string[] }

export interface SavedCollection {
  key: string;
  label: string;
  holds: SavedHolds[];
  derived: boolean;
  count: number;
  /** Up to four. Image ids when the collection shows images (asset version ids; `posts`: thumbnail file ids), else the newest titles. */
  previews: string[];
}
