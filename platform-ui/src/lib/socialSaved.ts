// SCP-5e (BFF §63.26) — Saved, each client's content bank: the types of every answer, their defensive parsing, the words for every refusal, the forms' own checks and the pure rules of the page.
// No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialSaved-data.ts` (server-only, `ReadResult`), the writes in `lib/socialSavedActions.ts` ("use server"); DEMO_MODE answers every route from `lib/demoSocialSaved.ts`, in the
// server's order of checks.
//
// WHAT THE BANK IS. The bank STORES only what has no other home: an Asset Library photo kept for a client (`asset`), a link, which is also every video (`link`, SCP-Q30), and a text (`text`: a caption
// or a template). A design's photo, an approved post and a hashtag set are READ from where they live, so they come back in the same collection answers but are never edited here. Its collections are
// the company's categories (BFF §63.30 `saved.categories`), in the company's order; the page never names a seeded one except to know the three that are read from elsewhere (`photos` also shows the
// designs' photos, `posts` and `hashtags` hold nothing of their own). WHO (SCP-Q29): reading is the team's, adding is whoever holds `create` on the client's would-be post (the Social Media team),
// changing or deleting an item is its author's, else the client's officer, the HoD, the GM, the owner or the superadmin. The server decides each one; the page says who may.
// A parsed answer that is the wrong shape throws, and the reader turns that into "cannot tell", never into a plausible empty page.
import { SOURCES, SOURCE_LABEL, isHttpUrl, refusalText, type Refusal } from "./socialPipeline";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : 0);

export const HOLDS = ["asset", "link", "text"] as const;
export type SavedHolds = (typeof HOLDS)[number];
const isHolds = (v: unknown): v is SavedHolds => typeof v === "string" && (HOLDS as readonly string[]).includes(v);
export const MEDIA = ["photo", "video"] as const;
export type SavedMedia = (typeof MEDIA)[number];
const media = (v: unknown): SavedMedia | null => (v === "photo" || v === "video" ? v : null);

/** The key of the items whose category the company no longer has, and the category that shows the design photos too. */
export const OTHER_KEY = "other";
export const PHOTOS_KEY = "photos";
export const POSTS_KEY = "posts";
export const HASHTAGS_KEY = "hashtags";

/** The server's lengths (BFF §63.26.1), mirrored for the forms' own checks. */
export const SAVED_LIMITS = { title: 120, body: 5000, url: 500, pillar: 60, aiNote: 1000, useIds: 10, pageDefault: 30 } as const;

export const HOLDS_LABEL: Readonly<Record<SavedHolds, string>> = { asset: "Asset Library photo", link: "Link", text: "Text" };
export const MEDIA_LABEL: Readonly<Record<SavedMedia, string>> = { photo: "Photo", video: "Video" };

// ── The collections (GET engagements/:id/saved) ──────────────────────────────────────────────────

export interface SavedCollection {
  key: string;
  label: string;
  holds: SavedHolds[];
  /** Read from elsewhere (design photos, approved posts, hashtag sets), never stored here. */
  derived: boolean;
  count: number;
  /** Up to four. Asset version ids when the collection shows images; `posts`: thumbnail file ids; otherwise the newest titles. */
  previews: string[];
}

export interface SavedCollections { collections: SavedCollection[]; canAdd: boolean }

export function asCollection(raw: unknown): SavedCollection {
  if (!isObj(raw) || typeof raw.key !== "string" || typeof raw.label !== "string") throw new Error("saved: not a collection");
  return {
    key: raw.key, label: raw.label, holds: arr(raw.holds).filter(isHolds), derived: raw.derived === true, count: count(raw.count),
    previews: arr(raw.previews).filter((p): p is string => typeof p === "string"),
  };
}

export function asCollections(raw: unknown): SavedCollections {
  if (!isObj(raw) || !Array.isArray(raw.collections)) throw new Error("saved: not a list of collections");
  return { collections: raw.collections.map(asCollection), canAdd: raw.canAdd === true };
}

/** What a collection's previews are: image ids of the Asset Library, file ids of a post's design, or the newest titles. */
export type PreviewKind = "asset" | "file" | "text";
export const previewKind = (c: Pick<SavedCollection, "key" | "holds">): PreviewKind => (c.key === POSTS_KEY ? "file" : c.holds.includes("asset") ? "asset" : "text");

/** The collections an item can be added to: those that store something. `photos` stores assets and links; `posts` and `hashtags` store nothing. */
export const storableCollections = (cs: readonly SavedCollection[]): SavedCollection[] => cs.filter((c) => c.holds.length > 0 && c.key !== OTHER_KEY);

/** The collection a page opens: the one asked for when the client has it, else none (the page then shows the mosaic). */
export const openCollection = (cs: readonly SavedCollection[], key: string | null): SavedCollection | null => cs.find((c) => c.key === key) ?? null;

// ── The items of one collection (GET …?collection=) ──────────────────────────────────────────────

export interface SavedPerson { id: string; name: string }
const person = (v: unknown): SavedPerson | null => (isObj(v) && typeof v.id === "string" ? { id: v.id, name: str(v.name) ?? "Someone" } : null);

export interface SavedAssetRef { groupId: string; versionId: string; versionNo: number; contentType: string }
const assetRef = (v: unknown): SavedAssetRef | null =>
  isObj(v) && typeof v.groupId === "string" && typeof v.versionId === "string"
    ? { groupId: v.groupId, versionId: v.versionId, versionNo: count(v.versionNo) || 1, contentType: str(v.contentType) ?? "" }
    : null;

/** A stored item of `captions`, `templates`, `references` or any category the company added. */
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

export function asSavedItem(raw: unknown): SavedItem {
  if (!isObj(raw) || typeof raw.id !== "string" || !isHolds(raw.holds) || typeof raw.title !== "string") throw new Error("saved: not an item");
  return {
    id: raw.id, category: str(raw.category) ?? "", holds: raw.holds, title: raw.title, body: str(raw.body), url: str(raw.url), media: media(raw.media), asset: assetRef(raw.asset),
    source: str(raw.source), aiNote: str(raw.aiNote), pillar: str(raw.pillar), useCount: count(raw.useCount), lastUsedAt: str(raw.lastUsedAt), used: raw.used === true,
    addedBy: person(raw.addedBy), addedAt: str(raw.addedAt) ?? "",
  };
}

/** One entry of the photos collection: a design's photo (derived), a kept asset or a kept link. `savedItemId` is null for a photo that only a design holds. */
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

export function asSavedPhoto(raw: unknown): SavedPhoto {
  if (!isObj(raw) || typeof raw.key !== "string" || (raw.holds !== "asset" && raw.holds !== "link") || typeof raw.title !== "string") throw new Error("saved: not a photo");
  return {
    key: raw.key, savedItemId: str(raw.savedItemId), holds: raw.holds, title: raw.title, media: media(raw.media), asset: assetRef(raw.asset), url: str(raw.url), source: str(raw.source),
    aiNote: str(raw.aiNote), pillar: str(raw.pillar), used: raw.used === true, usedIn: count(raw.usedIn), addedBy: person(raw.addedBy), addedAt: str(raw.addedAt) ?? "",
  };
}

/** An approved post of this client that has a stored design (read-only here; it links to its post). */
export interface SavedPostEntry {
  postId: string;
  title: string;
  format: string | null;
  cycleMonth: string | null;
  thumbFileId: string | null;
  pipelineStatus: string;
  simulated: boolean;
}

export function asSavedPost(raw: unknown): SavedPostEntry {
  if (!isObj(raw) || typeof raw.postId !== "string" || typeof raw.title !== "string") throw new Error("saved: not a post entry");
  return {
    postId: raw.postId, title: raw.title, format: str(raw.format), cycleMonth: str(raw.cycleMonth), thumbFileId: str(raw.thumbFileId),
    pipelineStatus: str(raw.pipelineStatus) ?? "approved", simulated: raw.simulated === true,
  };
}

/** A hashtag set of the client's brand book (read-only here: it is edited in the brand book). */
export interface SavedHashtagSet { key: string; name: string; tags: string[] }

export function asSavedHashtagSet(raw: unknown): SavedHashtagSet {
  if (!isObj(raw) || typeof raw.key !== "string" || !Array.isArray(raw.tags)) throw new Error("saved: not a hashtag set");
  return { key: raw.key, name: str(raw.name) ?? "Hashtags", tags: raw.tags.filter((t): t is string => typeof t === "string" && t !== "") };
}

export type SavedEntries =
  | { kind: "photos"; items: SavedPhoto[] }
  | { kind: "posts"; items: SavedPostEntry[] }
  | { kind: "hashtags"; items: SavedHashtagSet[] }
  | { kind: "items"; items: SavedItem[] };

export interface SavedPage { collection: string; entries: SavedEntries; nextCursor: string | null }

/** `{items, nextCursor}` of one collection; the page knows which collection it asked for, which says the shape of each item. */
export function asSavedPage(raw: unknown, collection: string): SavedPage {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("saved: not a page of items");
  const nextCursor = str(raw.nextCursor);
  if (collection === PHOTOS_KEY) return { collection, entries: { kind: "photos", items: raw.items.map(asSavedPhoto) }, nextCursor };
  if (collection === POSTS_KEY) return { collection, entries: { kind: "posts", items: raw.items.map(asSavedPost) }, nextCursor };
  if (collection === HASHTAGS_KEY) return { collection, entries: { kind: "hashtags", items: raw.items.map(asSavedHashtagSet) }, nextCursor: null };
  return { collection, entries: { kind: "items", items: raw.items.map(asSavedItem) }, nextCursor };
}

/** `POST engagements/:id/saved`: 201 `{item, created: true}`; 200 `{item, created: false}` for a replayed id or an asset already kept. */
export function asSavedCreated(raw: unknown): { item: SavedItem; created: boolean } {
  if (!isObj(raw)) throw new Error("saved: not a created item");
  return { item: asSavedItem(raw.item), created: raw.created !== false };
}

// ── What an item says about itself, in words ─────────────────────────────────────────────────────

/** "Source: Our own". A source the page does not know is shown as it came. */
export const sourceWords = (s: string | null): string => (s ? SOURCE_LABEL[s] ?? s : "Source not known");

/** How often a stored item has been used, in a sentence. */
export function useWords(i: Pick<SavedItem, "useCount" | "used">): string {
  if (i.useCount > 0) return i.useCount === 1 ? "Used once" : `Used ${i.useCount} times`;
  return i.used ? "Used" : "Not used yet";
}

/** How often a photo is used: a design's group by the posts that name it, a link by its use count; the words say which. */
export function photoUseWords(p: Pick<SavedPhoto, "used" | "usedIn">): string {
  if (!p.used) return "Not used yet";
  return p.usedIn === 1 ? "Used in 1 post" : p.usedIn > 1 ? `Used in ${p.usedIn} posts` : "Used";
}

/** The title and kind of a photo for its name: "Autumn hero (photo from the Asset Library)". */
export function photoKindWords(p: Pick<SavedPhoto, "holds" | "media" | "savedItemId">): string {
  if (p.holds === "asset") return p.savedItemId ? "Asset Library photo, kept" : "Photo from a design";
  return p.media === "video" ? "Video link" : p.media === "photo" ? "Photo link" : "Link";
}

export const imageHref = (versionId: string): string => `/api/creative-assets/${encodeURIComponent(versionId)}`;
export const fileHref = (fileId: string): string => `/api/files/${encodeURIComponent(fileId)}`;

// ── The words for who may ────────────────────────────────────────────────────────────────────────

/** SCP-Q29. Shown under a button the server refused, and as the page's note on who adds. */
export const SAVED_ADD_REASON = "Only the Social Media team adds to the content bank.";
export const SAVED_CHANGE_REASON = "Only the person who saved an item, this client's officer, the Social Media head, the GM, the owner or the superadmin can change or delete it.";
export const SAVED_NEVER_PORTAL = "The content bank is for the team. Clients never see it.";

export type SavedWriteKind = "add" | "change" | "delete";

const FIELD_WORDS: Readonly<Record<string, string>> = {
  category: "That collection does not take this kind of item. Pick a collection that stores it.",
  holds: "Pick what you are saving: a link, a text or an Asset Library photo.",
  title: `The title is 1 to ${SAVED_LIMITS.title} characters.`,
  body: `The text is 1 to ${SAVED_LIMITS.body} characters, and only a text item has one.`,
  url: "The link must be a web address that starts with http:// or https://, up to 500 characters.",
  media: "The kind must be a photo or a video.",
  assetGroupId: "Pick an asset from the Asset Library.",
  pillar: `The pillar is up to ${SAVED_LIMITS.pillar} characters.`,
  source: "Pick where the link comes from: our own, the client's, stock, made with AI or not known. Only a link has a source.",
  aiNote: `Say how the AI was used, in up to ${SAVED_LIMITS.aiNote} characters. A link made with AI needs this note.`,
  id: "That item belongs to someone else.",
  cursor: "That page link is out of date. Go back to the first page.",
  collection: "That collection is not one of this company's.",
};

/** A refusal of a write in a sentence. A 403 says who may; a 400 field is worded; a 404 says what is gone. The code stays the contract; this is the words. */
export function savedRefusalText(r: Refusal, kind: SavedWriteKind = "change"): string {
  if (r.status === 403) {
    if (r.reason === "assurance_required" || r.error === "automation_cannot_act" || r.error === "not_officer_or_approver") return refusalText(r);
    return `You cannot do this. ${kind === "add" ? SAVED_ADD_REASON : SAVED_CHANGE_REASON}`;
  }
  if ((r.error === "invalid_field" || r.error === "missing_field") && r.field && FIELD_WORDS[r.field]) return FIELD_WORDS[r.field];
  return refusalText(r);
}

// ── The page's query ─────────────────────────────────────────────────────────────────────────────

export interface SavedView {
  client: string | null;
  collection: string | null;
  pillar: string | null;
  used: boolean | null;
  source: string | null;
  cursor: string | null;
}

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

/** The page's query: a value that is not one is ignored, so a mistyped link shows the whole bank. */
export function parseSavedView(q: { client?: string | string[]; collection?: string | string[]; pillar?: string | string[]; used?: string | string[]; source?: string | string[]; cursor?: string | string[] }): SavedView {
  const used = one(q.used);
  const source = one(q.source);
  const pillar = one(q.pillar);
  return {
    client: one(q.client) || null,
    collection: one(q.collection) || null,
    pillar: pillar && [...pillar].length <= SAVED_LIMITS.pillar ? pillar : null,
    used: used === "true" ? true : used === "false" ? false : null,
    source: source && (SOURCES as readonly string[]).includes(source) ? source : null,
    cursor: one(q.cursor) || null,
  };
}

export const SAVED_PATH = (deptId: string): string => `/departments/${encodeURIComponent(deptId)}/saved`;

/** A link to the page in `view`. A filter or a client switch never keeps the page cursor (the old cursor belongs to the old list). */
export function savedHref(deptId: string, view: Partial<SavedView>): string {
  const qs = new URLSearchParams();
  if (view.client) qs.set("client", view.client);
  if (view.collection) qs.set("collection", view.collection);
  if (view.pillar) qs.set("pillar", view.pillar);
  if (view.used !== null && view.used !== undefined) qs.set("used", String(view.used));
  if (view.source) qs.set("source", view.source);
  if (view.cursor) qs.set("cursor", view.cursor);
  const tail = qs.toString();
  return `${SAVED_PATH(deptId)}${tail ? `?${tail}` : ""}`;
}

/** The query of `GET engagements/:id/saved?collection=…` for a view. */
export function savedQuery(view: Pick<SavedView, "collection" | "pillar" | "used" | "source" | "cursor">): string {
  const qs = new URLSearchParams();
  if (view.collection) qs.set("collection", view.collection);
  if (view.pillar) qs.set("pillar", view.pillar);
  if (view.used !== null) qs.set("used", String(view.used));
  if (view.source) qs.set("source", view.source);
  if (view.cursor) qs.set("cursor", view.cursor);
  return qs.toString();
}

/** Which filters make sense for a collection: hashtag sets have none (they are the brand book's), approved posts only the pillar. */
export function filtersFor(c: Pick<SavedCollection, "key">): { pillar: boolean; used: boolean; source: boolean } {
  if (c.key === HASHTAGS_KEY) return { pillar: false, used: false, source: false };
  if (c.key === POSTS_KEY) return { pillar: true, used: false, source: false };
  return { pillar: true, used: true, source: true };
}

export const hasFilter = (v: Pick<SavedView, "pillar" | "used" | "source">): boolean => v.pillar !== null || v.used !== null || v.source !== null;

/** The caller's clients first, then the rest, each in the order given (the order of `GET allocation`). */
export function clientsMineFirst<T extends { engagementId: string }>(all: readonly T[], mine: readonly { engagementId: string }[]): Array<T & { mine: boolean }> {
  const mineIds = new Set(mine.map((m) => m.engagementId));
  const tag = (r: T): T & { mine: boolean } => ({ ...r, mine: mineIds.has(r.engagementId) });
  return [...all.filter((r) => mineIds.has(r.engagementId)).map(tag), ...all.filter((r) => !mineIds.has(r.engagementId)).map(tag)];
}

// ── The forms and their own checks (before the request) ──────────────────────────────────────────

export interface SavedAddForm {
  category: string;
  holds: SavedHolds;
  title: string;
  body: string;
  url: string;
  media: "" | SavedMedia;
  assetGroupId: string;
  pillar: string;
  source: "" | (typeof SOURCES)[number];
  aiNote: string;
}

export const emptyAddForm = (category: string, holds: SavedHolds): SavedAddForm => ({
  category, holds, title: "", body: "", url: "", media: "", assetGroupId: "", pillar: "", source: "", aiNote: "",
});

const len = (s: string): number => [...s].length;
export type Check<B> = { ok: true; body: B } | { ok: false; field: string; message: string };
const no = (field: string, message: string): { ok: false; field: string; message: string } => ({ ok: false, field, message });

/** The collection's first storable shape: what a person is adding when they open it. */
export const defaultHolds = (c: Pick<SavedCollection, "holds">): SavedHolds => (c.holds.includes("link") ? "link" : c.holds[0] ?? "text");

/** The server's own shapes, checked before the request: the body of `POST engagements/:id/saved` for one `holds`, with only the fields that shape carries. */
export function buildSavedCreate(f: SavedAddForm, id: string): Check<Record<string, unknown>> {
  const title = f.title.trim();
  if (len(title) < 1) return no("title", "Give it a title.");
  if (len(title) > SAVED_LIMITS.title) return no("title", `The title is over ${SAVED_LIMITS.title} characters.`);
  const pillar = f.pillar.trim();
  if (len(pillar) > SAVED_LIMITS.pillar) return no("pillar", `The pillar is over ${SAVED_LIMITS.pillar} characters.`);
  const body: Record<string, unknown> = { id, category: f.category, holds: f.holds, title, ...(pillar ? { pillar } : {}) };
  if (f.holds === "text") {
    const text = f.body.trim();
    if (len(text) < 1) return no("body", "Write the text.");
    if (len(text) > SAVED_LIMITS.body) return no("body", `The text is over ${SAVED_LIMITS.body} characters.`);
    body.body = text;
  } else if (f.holds === "link") {
    const url = f.url.trim();
    if (!url) return no("url", "Paste the link.");
    if (!isHttpUrl(url)) return no("url", "The link must start with http:// or https:// and be at most 500 characters.");
    if (!f.source) return no("source", "Say where it comes from: our own, the client's, stock, made with AI or not known.");
    const note = f.aiNote.trim();
    if (f.source === "ai" && !note) return no("aiNote", "Say how the AI was used: a link made with AI needs a note.");
    if (len(note) > SAVED_LIMITS.aiNote) return no("aiNote", `The AI note is over ${SAVED_LIMITS.aiNote} characters.`);
    body.url = url;
    body.source = f.source;
    if (f.media) body.media = f.media;
    if (note) body.aiNote = note;
  } else {
    if (!f.assetGroupId) return no("assetGroupId", "Pick an asset from the Asset Library.");
    body.assetGroupId = f.assetGroupId;
  }
  return { ok: true, body };
}

export interface SavedEditForm { title: string; body: string; pillar: string; source: string; aiNote: string; category: string }

export const editFormOf = (i: SavedItem): SavedEditForm => ({
  title: i.title, body: i.body ?? "", pillar: i.pillar ?? "", source: i.source ?? "", aiNote: i.aiNote ?? "", category: i.category,
});

/** The body of `PATCH saved/:id`: only what changed, for the item's own shape (a text has a body, a link a source and note, an asset neither). Nothing changed is no request. */
export function buildSavedPatch(item: SavedItem, f: SavedEditForm): Check<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const title = f.title.trim();
  if (len(title) < 1) return no("title", "Give it a title.");
  if (len(title) > SAVED_LIMITS.title) return no("title", `The title is over ${SAVED_LIMITS.title} characters.`);
  if (title !== item.title) out.title = title;
  const pillar = f.pillar.trim();
  if (len(pillar) > SAVED_LIMITS.pillar) return no("pillar", `The pillar is over ${SAVED_LIMITS.pillar} characters.`);
  if (pillar !== (item.pillar ?? "")) out.pillar = pillar === "" ? null : pillar;
  if (item.holds === "text") {
    const text = f.body.trim();
    if (len(text) < 1) return no("body", "Write the text.");
    if (len(text) > SAVED_LIMITS.body) return no("body", `The text is over ${SAVED_LIMITS.body} characters.`);
    if (text !== (item.body ?? "")) out.body = text;
  }
  if (item.holds === "link") {
    if (!f.source) return no("source", "Say where it comes from.");
    const note = f.aiNote.trim();
    if (f.source === "ai" && !note) return no("aiNote", "Say how the AI was used: a link made with AI needs a note.");
    if (len(note) > SAVED_LIMITS.aiNote) return no("aiNote", `The AI note is over ${SAVED_LIMITS.aiNote} characters.`);
    if (f.source !== (item.source ?? "")) out.source = f.source;
    if (note !== (item.aiNote ?? "")) out.aiNote = note === "" ? null : note;
  }
  if (f.category !== item.category) out.category = f.category;
  if (Object.keys(out).length === 0) return no("", "Nothing has changed.");
  return { ok: true, body: out };
}
