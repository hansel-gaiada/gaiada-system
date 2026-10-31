// SCP-5e (BFF §63.26.3, "Use in a post") — the pure rules of the post page's "Use from Saved": which of a client's Saved items the picker offers and where each one goes, the body of the
// post edit that carries them (`PATCH posts/:postId/pipeline` with `savedItemIds`), and the words for what the server refuses. No server-only import, so a client component may import it.
//
// WHERE AN ITEM GOES (contract 63.26.3). A caption, a template (a stored `text`) and a hashtag set go into the COPY: a text is added to the caption after a blank line, a hashtag set's tags are merged
// into the hashtags; both are fields of the fixture's `copy` group, editable while the post is in `drafting` and in the team's copy change cases. A link (a reference, a photo link or a video link) goes into
// `rawAssets`, the brief's reference images, which `planned` and `drafting` allow. An Asset Library photo becomes a design only through `POST posts/:postId/designs`, by the designer, so the picker
// shows it and says so, and never sends it. Which fields the post may take is the fixture's `editRules` (`editableFieldsOf`), the same twin the server reads; the server decides all the same.
//
// THE COUNT IS THE SERVER'S. The edit carries `savedItemIds` (1 to 10 stored items of the post's client) and the server adds one use to each in the edit's own transaction. A hashtag set is read from the
// brand book and has no item id, so it is merged into the copy but never counted. A refused edit counts nothing, and the picker says so.
import { refusalText, editableFieldsOf, type PipelinePost, type RawAsset, type Refusal } from "./socialPipeline";
import {
  OTHER_KEY, POSTS_KEY, SAVED_LIMITS, photoUseWords, sourceWords, useWords,
  type SavedCollection, type SavedPage,
} from "./socialSaved";

/** One edit takes 1 to 10 items (the server's own bound). */
export const SAVED_USE_MAX = SAVED_LIMITS.useIds;
const CAPTION_MAX = 5000;
const HASHTAGS_MAX = 60;
const RAW_ASSETS_MAX = 10;

export type UseTarget = "caption" | "hashtags" | "rawAssets" | "design";

/** One row of the picker. `id` is the stored item's id (what `savedItemIds` carries), or null for a hashtag set (the brand book's) and a design's photo. */
export interface PickEntry {
  /** Unique in the picker, and what the checkbox keeps. */
  key: string;
  id: string | null;
  title: string;
  holds: "text" | "link" | "asset" | "hashtags";
  /** The text of a caption or template. */
  body: string | null;
  url: string | null;
  media: "photo" | "video" | null;
  source: string | null;
  aiNote: string | null;
  tags: string[];
  /** The Asset Library version to show as a picture (a kept photo only). */
  versionId: string | null;
  /** "Used 2 times": the stored item's use count in words (a photo link has only a used flag). */
  useWords: string;
  /** The count itself, when the server states one. */
  useCount: number | null;
}

export interface PickGroup { key: string; label: string; entries: PickEntry[] }

export const targetOf = (e: Pick<PickEntry, "holds">): UseTarget => (e.holds === "text" ? "caption" : e.holds === "hashtags" ? "hashtags" : e.holds === "link" ? "rawAssets" : "design");

/** What a person sees as the kind of an entry, so nothing is said by position or colour alone. */
export function entryKindWords(e: Pick<PickEntry, "holds" | "media">): string {
  if (e.holds === "text") return "Text for the caption";
  if (e.holds === "hashtags") return "Hashtag set";
  if (e.holds === "asset") return "Asset Library photo";
  return e.media === "video" ? "Video link" : e.media === "photo" ? "Photo link" : "Link";
}

/** The company's categories, in their order, each with the client's usable entries. The read-only `posts` is never offered, and a design's photo (no stored item) is not an item of the bank. */
export function pickerGroups(collections: readonly SavedCollection[], pages: readonly SavedPage[]): PickGroup[] {
  const byKey = new Map(pages.map((p) => [p.collection, p]));
  const out: PickGroup[] = [];
  for (const c of collections) {
    if (c.key === POSTS_KEY) continue;
    const page = byKey.get(c.key);
    if (!page) continue;
    const entries: PickEntry[] = [];
    const e = page.entries;
    if (e.kind === "items") {
      for (const i of e.items) {
        entries.push({
          key: `i:${i.id}`, id: i.id, title: i.title, holds: i.holds, body: i.body, url: i.url, media: i.media, source: i.source, aiNote: i.aiNote, tags: [],
          versionId: i.asset?.versionId ?? null, useWords: useWords(i), useCount: i.useCount,
        });
      }
    } else if (e.kind === "photos") {
      for (const p of e.items) {
        if (!p.savedItemId) continue;
        entries.push({
          key: `i:${p.savedItemId}`, id: p.savedItemId, title: p.title, holds: p.holds, body: null, url: p.url, media: p.media, source: p.source, aiNote: p.aiNote, tags: [],
          versionId: p.asset?.versionId ?? null, useWords: photoUseWords(p), useCount: null,
        });
      }
    } else if (e.kind === "hashtags") {
      for (const s of e.items) {
        entries.push({ key: `h:${s.key}`, id: null, title: s.name, holds: "hashtags", body: null, url: null, media: null, source: null, aiNote: null, tags: s.tags, versionId: null, useWords: "From the brand book", useCount: null });
      }
    }
    out.push({ key: c.key, label: c.key === OTHER_KEY ? "Other" : c.label, entries });
  }
  return out;
}

/** The search: every word must appear in the title, the text, the link or the tags (case does not matter). An empty search keeps everything; a group left empty is dropped. */
export function searchGroups(groups: readonly PickGroup[], q: string): PickGroup[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  const hay = (e: PickEntry): string => [e.title, e.body ?? "", e.url ?? "", e.tags.join(" ")].join(" ").toLowerCase();
  return groups.map((g) => ({ ...g, entries: g.entries.filter((e) => words.every((w) => hay(e).includes(w))) })).filter((g) => g.entries.length > 0);
}

/** The field names a post may take at its status (the fixture's rules). */
const allowedFields = (post: Pick<PipelinePost, "pipelineStatus" | "change">): Set<string> => new Set(editableFieldsOf(post).fields);

/** Whether the post page offers "Use from Saved": the viewer may author the post and its status takes the copy or the reference images. The server still decides. */
export function canUseFromSaved(post: Pick<PipelinePost, "pipelineStatus" | "change" | "archivedAt">, author: boolean): boolean {
  if (!author || post.archivedAt) return false;
  const a = allowedFields(post);
  return a.has("caption") || a.has("hashtags") || a.has("rawAssets");
}

/** Why an entry cannot be chosen on this post, or null when it can. Words, not colour. */
export function unusableWords(post: Pick<PipelinePost, "pipelineStatus" | "change">, e: Pick<PickEntry, "holds">): string | null {
  const t = targetOf(e);
  if (t === "design") return "An Asset Library photo becomes a design through the designer, so it cannot be added here.";
  const a = allowedFields(post);
  if (t === "caption" && !a.has("caption")) return "The caption cannot change at this step.";
  if (t === "hashtags" && !a.has("hashtags")) return "The hashtags cannot change at this step.";
  if (t === "rawAssets" && !a.has("rawAssets")) return "The reference images cannot change at this step.";
  return null;
}

/** What the picker tells a person about where a chosen entry will land. */
export const goesWords = (e: Pick<PickEntry, "holds">): string =>
  e.holds === "text" ? "Goes into the caption." : e.holds === "hashtags" ? "Its tags go into the hashtags." : e.holds === "link" ? "Goes into the reference images." : "";

export interface UseBody { fields: Record<string, unknown>; savedItemIds?: string[] }
export type UseCheck = { ok: true; body: UseBody; counted: number } | { ok: false; message: string };
const no = (message: string): UseCheck => ({ ok: false, message });

const len = (s: string): number => [...s].length;
const tag = (t: string): string => t.replace(/^#+/, "").replace(/\s+/g, "");

/**
 * The body of the post edit for the chosen entries: the changed fields (only those) and the ids of the stored items, in the order chosen. Nothing is sent that the post's step does not take, an
 * entry already in the post is not added twice, and every bound is the server's. The server judges again, and it alone counts.
 */
export function buildUseInPost(
  post: Pick<PipelinePost, "pipelineStatus" | "change" | "caption" | "hashtags" | "rawAssets">, picked: readonly PickEntry[],
): UseCheck {
  if (picked.length < 1) return no("Choose at least one item.");
  if (picked.length > SAVED_USE_MAX) return no(`Choose at most ${SAVED_USE_MAX} items.`);
  const seen = new Set<string>();
  for (const e of picked) {
    if (seen.has(e.key)) return no("An item is chosen twice.");
    seen.add(e.key);
    const why = unusableWords(post, e);
    if (why) return no(`${e.title}: ${why}`);
  }
  const fields: Record<string, unknown> = {};

  const texts = picked.filter((e) => e.holds === "text" && e.body);
  if (texts.length < picked.filter((e) => e.holds === "text").length) return no("A chosen text has no words in it.");
  if (texts.length > 0) {
    const have = post.caption.trimEnd();
    const added = texts.map((e) => (e.body as string).trim());
    const caption = [...(have ? [have] : []), ...added].join("\n\n");
    if (len(caption) > CAPTION_MAX) return no(`The caption would be over ${CAPTION_MAX.toLocaleString("en-US")} characters. Choose fewer texts or shorten the caption first.`);
    fields.caption = caption;
  }

  const sets = picked.filter((e) => e.holds === "hashtags");
  if (sets.length > 0) {
    const merged = [...post.hashtags];
    const known = new Set(merged.map((h) => h.toLowerCase()));
    for (const e of sets) for (const raw of e.tags) {
      const t = tag(raw);
      if (t && !known.has(t.toLowerCase())) { known.add(t.toLowerCase()); merged.push(t); }
    }
    if (merged.length > HASHTAGS_MAX) return no(`The post would have ${merged.length} hashtags and takes at most ${HASHTAGS_MAX}. Choose a smaller set.`);
    if (merged.length > post.hashtags.length) fields.hashtags = merged;
  }

  const links = picked.filter((e) => e.holds === "link");
  if (links.length > 0) {
    const have = new Set(post.rawAssets.map((a) => a.url));
    const added: RawAsset[] = [];
    for (const e of links) {
      if (!e.url) return no(`${e.title}: this link has no address.`);
      if (have.has(e.url)) continue;
      have.add(e.url);
      added.push({ url: e.url, label: e.title.slice(0, SAVED_LIMITS.title), source: e.source ?? "unknown", aiNote: e.source === "ai" ? e.aiNote : null });
    }
    if (post.rawAssets.length + added.length > RAW_ASSETS_MAX) return no(`The post would have ${post.rawAssets.length + added.length} reference images and takes at most ${RAW_ASSETS_MAX}.`);
    if (added.length > 0) {
      fields.rawAssets = [...post.rawAssets.map((a) => ({ url: a.url, label: a.label, source: a.source, aiNote: a.aiNote })), ...added];
    }
  }

  if (Object.keys(fields).length === 0) return no("Everything you chose is already in the post, so there is nothing to add.");
  const ids = picked.map((e) => e.id).filter((x): x is string => x !== null);
  return { ok: true, body: { fields, ...(ids.length > 0 ? { savedItemIds: ids } : {}) }, counted: ids.length };
}

/** A refusal of the edit in words, for the line beside the picker. A refused edit counts nothing, and the line says so. */
export function useRefusalText(r: Refusal): string {
  if ((r.error === "invalid_field" || r.error === "missing_field") && r.field === "savedItemIds") {
    return "One of the chosen items cannot be used here: it may belong to another client, have been deleted, or the choice is not 1 to 10 items. Close the picker, open it again and choose again. Nothing was changed or counted.";
  }
  const base = refusalText(r);
  return r.status >= 400 && r.status < 500 ? `${base} Nothing was changed or counted.` : base;
}

/** "Used 2 times · Source: Our own" style line for a chosen entry's preview, without colour. */
export function entryMeta(e: PickEntry): string {
  const parts = [entryKindWords(e), e.useWords];
  if (e.holds === "link") parts.push(sourceWords(e.source));
  return parts.join(" · ");
}

/** The count line under the list. */
export function chosenWords(n: number): string {
  return n >= SAVED_USE_MAX ? `${n} of ${SAVED_USE_MAX} chosen. That is the most one edit takes.` : `${n} of ${SAVED_USE_MAX} chosen.`;
}
