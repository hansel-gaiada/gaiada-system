import "server-only";
// SCP-5e (BFF §63.26) — what DEMO_MODE answers for Saved, each client's content bank, in the server's order of checks and with its gates (SCP-Q29):
//
//   GET    engagements/:engagementId/saved                         the collections, with counts and previews, and `canAdd`
//   GET    engagements/:engagementId/saved?collection=&pillar=&used=&source=&cursor=&limit=      one collection's items, paged
//   POST   engagements/:engagementId/saved                         add a link, a text or an Asset Library photo (201 `{item, created}`; 200 for a replayed id or a kept asset)
//   PATCH  saved/:itemId   |   DELETE saved/:itemId                the author's, else the client's officer or one of the four
//   `savedItemIds` on `PATCH posts/:postId/pipeline` (BFF §63.26.3)  judged and counted for the post edit by `use`, below (the edit itself is demoSocialPipelineRun.ts's)
//
// THE GATES. Reading: any staff member (a client contact is refused). Adding: `create` on the client's would-be post, which is the Social Media team's (the two officers, the copywriter, the in-team
// designer, the company admin) and the four approvers; the Creatives designer is refused. Changing or deleting: the item's author who still holds `create`, else `manage` on the would-be post, which is the
// client's officer and the four (403 `not_officer_or_approver`); an automation is refused every write (403 `automation_cannot_act`).
//
// THE ORDER OF CHECKS is the server's own (`saved.controller.ts`): a read judges `read` first (there is no per-client resource), then 404 `engagement_not_found`, then the query (400); a create answers 404
// (the client), then 403, then a replayed `id` (before the body is judged), then 400 `{field}` in the body's order, then the body's own 404 `asset_not_found`; a change or delete answers 404
// `saved_item_not_found`, then 403, then 400.
//
// THE DATA is invented and read where the server reads it: the photos are the asset groups on the live designs of the client's posts (derived, never stored) plus the bank's own kept assets and links; the
// posts are the client's pipeline posts from `approved` on that have a stored design; the hashtag sets are the brand book's. Northwind Traders' bank holds an item in every collection (one kept asset no post
// uses, a stock photo link, a Drive video link, three captions, two templates, two references); Saltmarsh Day Spa's bank stores nothing, so its empty collections can be seen.
import { DEMO_ASSETS, type SavedUse } from "./demoSocialPipelineRun";
import { PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, isClientContact, isDemoSocialApprover, who, type DemoResult } from "./demoSocialPipeline";
import fixture from "./scpStageMachine.json";
import rules from "./socialRulesDefaults.json";
import { SAVED_LIMITS, type SavedHolds } from "./socialSaved";
import { SOURCES } from "./socialPipeline";

const FX = fixture as { refusals: Record<string, { http: number }> };
const refuse = (code: string, extra: Record<string, unknown> = {}): DemoResult => {
  const http = FX.refusals[code]?.http;
  if (http === undefined) throw new Error(`demoSocialSaved: refusal '${code}' is not in the fixture`);
  return { status: http, json: { error: code, ...extra } };
};
const bad = (field: string): DemoResult => refuse("invalid_field", { field });
const missing = (field: string): DemoResult => refuse("missing_field", { field });
const denied = (action: string): DemoResult => ({ status: 403, json: { error: `not authorized: cerbos denied ${action} on social_post` } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;
const len = (s: string): number => [...s].length;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isAutomation = (userId: string): boolean => /^(demo-)?(automation|bot)\b/.test(userId);

// ── the company's categories (the seed: the demo company has not edited its rules) ────────────────

interface Category { key: string; label: string; holds: SavedHolds[]; enabled: boolean }
const CATEGORIES: readonly Category[] = (rules.saved.categories as Array<{ key: string; label: string; holds: string[]; enabled: boolean }>)
  .map((c) => ({ key: c.key, label: c.label, holds: c.holds as SavedHolds[], enabled: c.enabled }));
const DERIVED = new Set(["photos", "posts", "hashtags"]);
const takes = (key: string, holds: SavedHolds): boolean => CATEGORIES.some((c) => c.key === key && c.enabled && c.holds.includes(holds));

// ── the store ────────────────────────────────────────────────────────────────────────────────────

export interface SavedRec {
  id: string;
  engagementId: string;
  category: string;
  holds: SavedHolds;
  title: string;
  body: string | null;
  url: string | null;
  media: "photo" | "video" | null;
  assetGroupId: string | null;
  pillar: string | null;
  source: string | null;
  aiNote: string | null;
  useCount: number;
  lastUsedAt: string | null;
  createdBy: string;
  createdAt: string;
  deleted: boolean;
}
export interface SavedStore { items: SavedRec[]; seq: number }
export const emptySavedStore = (): SavedStore => ({ items: [], seq: 0 });

const iso = (ms: number): string => new Date(ms).toISOString();
const hoursAgo = (h: number): string => iso(Date.now() - h * 3_600_000);
const engagementOf = (id: string) => PIPE_ENGAGEMENTS.find((e) => e.id === id && e.status !== "closed");
const officerOf = (engagementId: string): string | null => allocStore.byEngagement[engagementId]?.officerId ?? null;
const assetOf = (groupOrVersion: string) => DEMO_ASSETS.find((a) => a.groupId === groupOrVersion || a.versionId === groupOrVersion);

/** The demo's invented bank (see the file header), built from the demo pipeline's own clients and the day the store is first touched. */
export function seedSavedStore(): SavedStore {
  const s = emptySavedStore();
  const [north] = PIPE_ENGAGEMENTS;
  if (!north) return s;
  const add = (o: Partial<SavedRec> & Pick<SavedRec, "category" | "holds" | "title" | "createdBy">, hours: number): void => {
    s.items.push({
      id: `soc-saved-${++s.seq}`, engagementId: north.id, body: null, url: null, media: null, assetGroupId: null, pillar: null, source: null, aiNote: null, useCount: 0, lastUsedAt: null,
      createdAt: hoursAgo(hours), deleted: false, ...o,
    });
  };
  // Oldest first, so the newest reads first in the lists.
  add({ category: "references", holds: "asset", title: "Studio portrait", assetGroupId: DEMO_ASSETS[1].groupId, createdBy: "u-social-2", pillar: "Behind the scenes" }, 240);
  add({ category: "references", holds: "link", title: "Competitor-free mood board", url: "https://example.com/northwind/moodboard", media: "photo", source: "client", createdBy: "u-social", pillar: "Product stories" }, 220);
  add({ category: "templates", holds: "text", title: "Product launch caption", body: "Meet [product]. Made with care in [place]. Tap the link to see how it is made.", createdBy: "u-copy", pillar: "Product stories", useCount: 2, lastUsedAt: hoursAgo(30) }, 200);
  add({ category: "templates", holds: "text", title: "Behind the scenes", body: "A day in the workshop: [what happened]. Tell us what you want to see next.", createdBy: "u-copy", pillar: "Behind the scenes" }, 190);
  add({ category: "captions", holds: "text", title: "Harvest week opener", body: "The harvest is in. Fresh, local and on the shelf from Friday.", createdBy: "u-social", pillar: "Product stories", useCount: 1, lastUsedAt: hoursAgo(80) }, 160);
  add({ category: "captions", holds: "text", title: "Thank you to the team", body: "Behind every parcel is a person who packed it by hand. Thank you.", createdBy: "u-social", pillar: "Behind the scenes" }, 150);
  add({ category: "captions", holds: "text", title: "Weekend reminder", body: "Open Saturday 9 to 5. Come say hello.", createdBy: "u-social-2" }, 140);
  add({ category: "photos", holds: "link", title: "Stock: wooden table, morning light", url: "https://example.com/stock/wooden-table", media: "photo", source: "stock", createdBy: "u-social", pillar: "Product stories" }, 120);
  add({ category: "photos", holds: "link", title: "Drive: workshop walkthrough (video)", url: "https://drive.example.com/file/workshop-walkthrough", media: "video", source: "own", createdBy: "u-social", pillar: "Behind the scenes", useCount: 1, lastUsedAt: hoursAgo(50) }, 100);
  add({ category: "photos", holds: "asset", title: "Autumn hero - final", assetGroupId: DEMO_ASSETS[0].groupId, createdBy: "u-social", pillar: "Product stories" }, 60);
  return s;
}

// ── what the server reads ────────────────────────────────────────────────────────────────────────

interface PhotoView {
  key: string; savedItemId: string | null; holds: "asset" | "link"; title: string; media: string | null; asset: Record<string, unknown> | null; url: string | null; source: string | null;
  aiNote: string | null; pillar: string | null; used: boolean; usedIn: number; addedBy: { id: string; name: string } | null; addedAt: string; sort: string;
}

const assetRef = (groupId: string): Record<string, unknown> | null => {
  const a = assetOf(groupId);
  return a ? { groupId: a.groupId, versionId: a.versionId, versionNo: a.versionNo, contentType: "image/png" } : null;
};

/** The live designs of the client's live posts: the asset groups they name, with the posts that use each. */
function designGroups(engagementId: string): Map<string, { name: string; versionId: string; versionNo: number; source: string | null; aiNote: string | null; pillar: string | null; posts: Set<string>; at: string }> {
  const out = new Map<string, { name: string; versionId: string; versionNo: number; source: string | null; aiNote: string | null; pillar: string | null; posts: Set<string>; at: string }>();
  for (const p of PIPE_POSTS) {
    if (p.engagementId !== engagementId || p.archivedAt || !p.pipelineStatus) continue;
    for (const d of p.designs) {
      const a = d.asset as { groupId: string; versionId: string; versionNo: number; name: string; source: string | null; aiNote: string | null } | null;
      if (!a) continue;
      const cur = out.get(a.groupId) ?? { name: a.name, versionId: a.versionId, versionNo: a.versionNo, source: a.source, aiNote: a.aiNote, pillar: p.pillar, posts: new Set<string>(), at: p.statusSince };
      cur.posts.add(p.id);
      out.set(a.groupId, cur);
    }
  }
  return out;
}

export function savedApi(store: SavedStore) {
  const live = (engagementId: string) => store.items.filter((i) => i.engagementId === engagementId && !i.deleted);
  const find = (id: string) => store.items.find((i) => i.id === id);

  const usedIn = (r: SavedRec): number => {
    if (r.holds !== "asset" || !r.assetGroupId) return 0;
    const g = designGroups(r.engagementId).get(r.assetGroupId);
    return g ? g.posts.size : 0;
  };
  const isUsed = (r: SavedRec): boolean => (r.holds === "asset" ? usedIn(r) > 0 : r.useCount > 0);

  const itemOf = (r: SavedRec): Record<string, unknown> => {
    const a = r.holds === "asset" && r.assetGroupId ? assetOf(r.assetGroupId) : undefined;
    return {
      id: r.id, category: r.category, holds: r.holds, title: r.title, body: r.body, url: r.url, media: r.media, asset: r.holds === "asset" && r.assetGroupId ? assetRef(r.assetGroupId) : null,
      source: r.holds === "asset" ? a?.source ?? null : r.source, aiNote: r.holds === "asset" ? a?.aiNote ?? null : r.aiNote, pillar: r.pillar, useCount: r.useCount, lastUsedAt: r.lastUsedAt,
      used: isUsed(r), addedBy: who(r.createdBy), addedAt: r.createdAt,
    };
  };

  /** The union, without repeats, of the design groups and the bank's own `photos` items: one entry per group. */
  const photos = (engagementId: string): PhotoView[] => {
    const out: PhotoView[] = [];
    const groups = designGroups(engagementId);
    const kept = live(engagementId).filter((r) => r.category === "photos");
    for (const [gid, g] of groups) {
      const keptRec = kept.find((r) => r.holds === "asset" && r.assetGroupId === gid);
      out.push({
        key: `g:${gid}`, savedItemId: keptRec?.id ?? null, holds: "asset", title: g.name, media: "photo",
        asset: { groupId: gid, versionId: g.versionId, versionNo: g.versionNo, contentType: "image/png" }, url: null, source: g.source, aiNote: g.aiNote, pillar: keptRec?.pillar ?? g.pillar,
        used: true, usedIn: g.posts.size, addedBy: keptRec ? who(keptRec.createdBy) : null, addedAt: keptRec?.createdAt ?? g.at, sort: keptRec?.createdAt ?? g.at,
      });
    }
    for (const r of kept) {
      if (r.holds === "asset" && r.assetGroupId && groups.has(r.assetGroupId)) continue;
      const it = itemOf(r);
      out.push({
        key: `s:${r.id}`, savedItemId: r.id, holds: r.holds as "asset" | "link", title: r.title, media: r.media, asset: it.asset as Record<string, unknown> | null, url: r.url,
        source: it.source as string | null, aiNote: it.aiNote as string | null, pillar: r.pillar, used: isUsed(r), usedIn: usedIn(r), addedBy: who(r.createdBy), addedAt: r.createdAt, sort: r.createdAt,
      });
    }
    return out.sort((a, b) => b.sort.localeCompare(a.sort) || b.key.localeCompare(a.key));
  };

  const posts = (engagementId: string) =>
    PIPE_POSTS.filter((p) => p.engagementId === engagementId && !p.archivedAt && ["approved", "scheduled", "live"].includes(p.pipelineStatus) && p.designs.some((d) => d.asset))
      .map((p) => ({ postId: p.id, title: p.title, format: p.format, cycleMonth: p.cycleMonth, thumbFileId: `${p.id}-f1`, pipelineStatus: p.pipelineStatus, simulated: p.simulated, pillar: p.pillar, at: p.scheduledAt ?? p.statusSince }))
      .sort((a, b) => b.at.localeCompare(a.at) || b.postId.localeCompare(a.postId));

  const hashtagSets = (engagementId: string) => {
    const e = engagementOf(engagementId);
    const brand = e ? allocStore.brands[e.clientId] : undefined;
    return (brand?.hashtagStrategy as { sets?: Array<{ name: string; tags: string[] }> } | undefined)?.sets?.map((x, i) => ({ key: `set-${i + 1}`, name: x.name, tags: x.tags })) ?? [];
  };

  // ── collections ──────────────────────────────────────────────────────────────────────────────

  function collections(engagementId: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const c of CATEGORIES.filter((x) => x.enabled)) {
      const base = { key: c.key, label: c.label, holds: c.holds, derived: DERIVED.has(c.key) };
      if (c.key === "photos") {
        const p = photos(engagementId);
        out.push({ ...base, count: p.length, previews: p.filter((x) => x.asset).slice(0, 4).map((x) => (x.asset as { versionId: string }).versionId) });
      } else if (c.key === "posts") {
        const p = posts(engagementId);
        out.push({ ...base, count: p.length, previews: p.slice(0, 4).map((x) => x.thumbFileId) });
      } else if (c.key === "hashtags") {
        const sets = hashtagSets(engagementId);
        out.push({ ...base, count: sets.length, previews: sets.slice(0, 4).map((x) => x.name) });
      } else {
        const mine = live(engagementId).filter((r) => r.category === c.key).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
        const images = c.holds.includes("asset");
        out.push({
          ...base, count: mine.length,
          previews: images ? mine.filter((r) => r.holds === "asset" && r.assetGroupId).slice(0, 4).map((r) => (assetRef(r.assetGroupId as string) as { versionId: string } | null)?.versionId).filter(Boolean) : mine.slice(0, 4).map((r) => r.title),
        });
      }
    }
    const known = new Set(CATEGORIES.map((c) => c.key));
    const orphans = live(engagementId).filter((r) => !known.has(r.category));
    if (orphans.length > 0) {
      out.push({ key: "other", label: "Other", holds: ["asset", "link", "text"], derived: false, count: orphans.length, previews: orphans.slice(0, 4).map((r) => r.title) });
    }
    return out;
  }

  // ── a collection's items ─────────────────────────────────────────────────────────────────────

  function parseQuery(params: URLSearchParams): DemoResult | { collection: string | null; pillar: string | null; used: boolean | null; source: string | null; cursor: number; limit: number } {
    const one = (k: string): string | undefined => { const v = params.get(k); return v === null || v === "" ? undefined : v; };
    const collection = one("collection") ?? null;
    if (collection !== null && collection !== "other" && !CATEGORIES.some((c) => c.key === collection && c.enabled)) return bad("collection");
    const pillar = one("pillar");
    if (pillar !== undefined && len(pillar) > SAVED_LIMITS.pillar) return bad("pillar");
    const usedRaw = one("used");
    if (usedRaw !== undefined && usedRaw !== "true" && usedRaw !== "false") return bad("used");
    const source = one("source");
    if (source !== undefined && !(SOURCES as readonly string[]).includes(source)) return bad("source");
    const limitRaw = one("limit");
    let limit: number = SAVED_LIMITS.pageDefault;
    if (limitRaw !== undefined) {
      if (!/^\d{1,3}$/.test(limitRaw) || Number(limitRaw) < 1 || Number(limitRaw) > 100) return bad("limit");
      limit = Number(limitRaw);
    }
    let cursor = 0;
    const c = one("cursor");
    if (c !== undefined) {
      const n = Buffer.from(c, "base64url").toString("utf8");
      if (!/^\d{1,6}$/.test(n) || Buffer.from(n, "utf8").toString("base64url") !== c) return bad("cursor");
      cursor = Number(n);
    }
    return { collection, pillar: pillar ?? null, used: usedRaw === undefined ? null : usedRaw === "true", source: source ?? null, cursor, limit };
  }

  const page = <T,>(all: T[], q: { cursor: number; limit: number }): { items: T[]; nextCursor: string | null } => {
    const items = all.slice(q.cursor, q.cursor + q.limit);
    const next = q.cursor + q.limit;
    return { items, nextCursor: next < all.length ? Buffer.from(String(next), "utf8").toString("base64url") : null };
  };

  function list(engagementId: string, params: URLSearchParams, userId: string): DemoResult {
    if (isClientContact(userId)) return denied("read");
    if (!engagementOf(engagementId)) return refuse("engagement_not_found");
    const q = parseQuery(params);
    if ("status" in q) return q;
    if (q.collection === null) return ok({ collections: collections(engagementId), canAdd: !isAutomation(userId) && canCreate(userId) });
    const filter = <T extends { pillar: string | null; used?: boolean; source?: string | null }>(xs: T[]): T[] =>
      xs.filter((x) => (q.pillar === null || x.pillar === q.pillar) && (q.used === null || x.used === q.used) && (q.source === null || x.source === q.source));
    if (q.collection === "photos") {
      const rows = filter(photos(engagementId)).map(({ sort: _sort, ...r }) => r);
      return ok(page(rows, q));
    }
    if (q.collection === "posts") {
      const rows = posts(engagementId).filter((p) => q.pillar === null || p.pillar === q.pillar).map(({ pillar: _p, at: _a, ...r }) => r);
      return ok(page(rows, q));
    }
    if (q.collection === "hashtags") return ok({ items: hashtagSets(engagementId), nextCursor: null });
    const known = new Set(CATEGORIES.map((c) => c.key));
    const mine = live(engagementId)
      .filter((r) => (q.collection === "other" ? !known.has(r.category) : r.category === q.collection))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(itemOf) as Array<Record<string, unknown> & { pillar: string | null; used: boolean; source: string | null }>;
    return ok(page(filter(mine), q));
  }

  // ── gates ────────────────────────────────────────────────────────────────────────────────────

  const TEAM = new Set(["u-social", "u-social-2", "u-copy", "u-social-design", "u-dev"]);
  /** `create` on the client's would-be post: the Social Media team and the four approvers. */
  const canCreate = (userId: string): boolean => !isClientContact(userId) && (TEAM.has(userId) || isDemoSocialApprover(userId));
  /** `manage` on the would-be post: the client's officer and the four. */
  const canManage = (userId: string, engagementId: string): boolean => isDemoSocialApprover(userId) || officerOf(engagementId) === userId;

  // ── create ───────────────────────────────────────────────────────────────────────────────────

  function parseCreate(body: unknown): DemoResult | { id: string | null; category: string; holds: SavedHolds; title: string; text: string | null; url: string | null; media: "photo" | "video" | null; assetGroupId: string | null; pillar: string | null; source: string | null; aiNote: string | null } {
    if (!isObj(body)) return missing("category");
    const KEYS = ["id", "category", "holds", "title", "body", "url", "media", "assetGroupId", "pillar", "source", "aiNote"];
    for (const k of Object.keys(body)) if (!KEYS.includes(k)) return bad(k);
    if (!absent(body.id) && !(typeof body.id === "string" && UUID.test(body.id))) return bad("id");
    if (absent(body.category)) return missing("category");
    if (absent(body.holds)) return missing("holds");
    if (typeof body.holds !== "string" || !(["asset", "link", "text"] as string[]).includes(body.holds)) return bad("holds");
    const holds = body.holds as SavedHolds;
    if (typeof body.category !== "string" || !takes(body.category, holds)) return bad("category");
    if (absent(body.title)) return missing("title");
    const title = typeof body.title === "string" ? body.title.trim() : null;
    if (title === null || len(title) < 1 || len(title) > SAVED_LIMITS.title) return bad("title");
    let pillar: string | null = null;
    if (!absent(body.pillar)) {
      const t = typeof body.pillar === "string" ? body.pillar.trim() : "";
      if (len(t) < 1 || len(t) > SAVED_LIMITS.pillar) return bad("pillar");
      pillar = t;
    }
    const out = { id: absent(body.id) ? null : (body.id as string).toLowerCase(), category: body.category, holds, title, text: null as string | null, url: null as string | null, media: null as "photo" | "video" | null, assetGroupId: null as string | null, pillar, source: null as string | null, aiNote: null as string | null };
    const only = (allowed: string[]): DemoResult | null => {
      for (const f of ["body", "url", "media", "assetGroupId", "source", "aiNote"]) if (!allowed.includes(f) && !absent(body[f])) return bad(f);
      return null;
    };
    const trimmed = (v: unknown, max: number): string | null => { const t = typeof v === "string" ? v.trim() : ""; return len(t) >= 1 && len(t) <= max ? t : null; };
    if (holds === "asset") {
      const r = only(["assetGroupId"]);
      if (r) return r;
      if (absent(body.assetGroupId)) return missing("assetGroupId");
      if (typeof body.assetGroupId !== "string" || !body.assetGroupId.trim()) return bad("assetGroupId");
      out.assetGroupId = body.assetGroupId.trim();
    } else if (holds === "link") {
      const r = only(["url", "media", "source", "aiNote"]);
      if (r) return r;
      if (absent(body.url)) return missing("url");
      const url = trimmed(body.url, SAVED_LIMITS.url);
      if (url === null || !/^https?:\/\/\S+$/i.test(url)) return bad("url");
      out.url = url;
      if (!absent(body.media)) {
        if (body.media !== "photo" && body.media !== "video") return bad("media");
        out.media = body.media;
      }
      if (absent(body.source)) return missing("source");
      if (typeof body.source !== "string" || !(SOURCES as readonly string[]).includes(body.source)) return bad("source");
      out.source = body.source;
      if (!absent(body.aiNote)) {
        const n = trimmed(body.aiNote, SAVED_LIMITS.aiNote);
        if (n === null) return bad("aiNote");
        out.aiNote = n;
      }
      if (out.source === "ai" && out.aiNote === null) return missing("aiNote");
    } else {
      const r = only(["body"]);
      if (r) return r;
      if (absent(body.body)) return missing("body");
      const t = trimmed(body.body, SAVED_LIMITS.body);
      if (t === null) return bad("body");
      out.text = t;
    }
    return out;
  }

  function create(engagementId: string, body: string | undefined, userId: string): DemoResult {
    if (!engagementOf(engagementId)) return refuse("engagement_not_found");
    if (isAutomation(userId)) return refuse("automation_cannot_act");
    if (!canCreate(userId)) return denied("create");
    let json: unknown;
    try { json = body ? JSON.parse(body) : {}; } catch { return missing("category"); }
    // A replayed `id` answers with the item as it stands, before the rest of the body is judged (§63.0).
    const wanted = isObj(json) && typeof json.id === "string" && UUID.test(json.id) ? json.id.toLowerCase() : null;
    if (wanted) {
      const mine = find(wanted);
      if (mine) {
        if (mine.engagementId !== engagementId || mine.deleted) return bad("id");
        return ok({ item: itemOf(mine), created: false });
      }
    }
    const input = parseCreate(json);
    if ("status" in input) return input;
    let group: string | null = null;
    if (input.holds === "asset") {
      const a = assetOf(input.assetGroupId as string);
      if (!a) return refuse("asset_not_found");
      group = a.groupId;
      const kept = live(engagementId).find((r) => r.holds === "asset" && r.assetGroupId === group);
      if (kept) return ok({ item: itemOf(kept), created: false });
    }
    const rec: SavedRec = {
      id: input.id ?? `soc-saved-${++store.seq}`, engagementId, category: input.category, holds: input.holds, title: input.title, body: input.text, url: input.url, media: input.media,
      assetGroupId: group, pillar: input.pillar, source: input.source, aiNote: input.aiNote, useCount: 0, lastUsedAt: null, createdBy: userId, createdAt: new Date().toISOString(), deleted: false,
    };
    store.items.push(rec);
    return ok({ item: itemOf(rec), created: true }, 201);
  }

  // ── change and delete ────────────────────────────────────────────────────────────────────────

  /** 404 `saved_item_not_found`, then 403: the author who still holds `create`, else `manage` (403 `not_officer_or_approver`). */
  function gate(itemId: string, userId: string): DemoResult | SavedRec {
    const r = find(itemId);
    if (!r || r.deleted || !engagementOf(r.engagementId)) return refuse("saved_item_not_found");
    if (isAutomation(userId)) return refuse("automation_cannot_act");
    const mine = r.createdBy === userId && canCreate(userId);
    if (!mine && !canManage(userId, r.engagementId)) return refuse("not_officer_or_approver");
    return r;
  }

  function patch(itemId: string, body: string | undefined, userId: string): DemoResult {
    const g = gate(itemId, userId);
    if ("status" in g) return g;
    let json: unknown;
    try { json = body ? JSON.parse(body) : undefined; } catch { json = undefined; }
    if (!isObj(json) || Object.keys(json).length === 0) return missing("title");
    const KEYS = ["title", "body", "pillar", "source", "aiNote", "category"];
    for (const k of Object.keys(json)) if (!KEYS.includes(k)) return bad(k);
    const next: Partial<SavedRec> = {};
    const trimmed = (v: unknown, max: number): string | null => { const t = typeof v === "string" ? v.trim() : ""; return len(t) >= 1 && len(t) <= max ? t : null; };
    if (json.title !== undefined) { const t = trimmed(json.title, SAVED_LIMITS.title); if (t === null) return bad("title"); next.title = t; }
    if (json.body !== undefined) {
      if (g.holds !== "text") return bad("body");
      const t = trimmed(json.body, SAVED_LIMITS.body);
      if (t === null) return bad("body");
      next.body = t;
    }
    if (json.pillar !== undefined) {
      if (json.pillar === null) next.pillar = null;
      else { const t = trimmed(json.pillar, SAVED_LIMITS.pillar); if (t === null) return bad("pillar"); next.pillar = t; }
    }
    if (json.source !== undefined) {
      if (g.holds !== "link") return bad("source");
      if (typeof json.source !== "string" || !(SOURCES as readonly string[]).includes(json.source)) return bad("source");
      next.source = json.source;
    }
    if (json.aiNote !== undefined) {
      if (g.holds !== "link") return bad("aiNote");
      if (json.aiNote === null) next.aiNote = null;
      else { const t = trimmed(json.aiNote, SAVED_LIMITS.aiNote); if (t === null) return bad("aiNote"); next.aiNote = t; }
    }
    if (json.category !== undefined) {
      if (typeof json.category !== "string" || !takes(json.category, g.holds)) return bad("category");
      next.category = json.category;
    }
    if (g.holds === "link") {
      const source = next.source ?? g.source;
      const note = next.aiNote !== undefined ? next.aiNote : g.aiNote;
      if (source === "ai" && note === null) return missing("aiNote");
    }
    Object.assign(g, next);
    return ok({ item: itemOf(g) });
  }

  function remove(itemId: string, userId: string): DemoResult {
    const g = gate(itemId, userId);
    if ("status" in g) return g;
    g.deleted = true;
    return ok({ id: g.id, deleted: true });
  }

  /** The routes of 63.26 by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
  function staff(method: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
    const m = method.toUpperCase();
    let x: RegExpExecArray | null;
    if ((x = /^engagements\/([^/]+)\/saved$/.exec(tail))) {
      const id = decodeURIComponent(x[1]);
      return m === "GET" ? list(id, params, userId) : m === "POST" ? create(id, body, userId) : null;
    }
    if ((x = /^saved\/([^/]+)$/.exec(tail))) {
      const id = decodeURIComponent(x[1]);
      return m === "PATCH" ? patch(id, body, userId) : m === "DELETE" ? remove(id, userId) : null;
    }
    return null;
  }

  /**
   * SCP-5e: the saved items of a post edit, in the server's order. `judge` runs after the gate and before the machine's guards: the list is 1 to 10 distinct ids (a demo id is any non-empty string, as
   * its other ids are), else 400 `savedItemIds`; each must be a LIVE item of the post's client, else the same 400 (nothing is counted). `count` runs only when the edit applied: one more use for each
   * item, and the time, in the same step.
   */
  const use: SavedUse = {
    judge(engagementId, raw) {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > SAVED_LIMITS.useIds) return bad("savedItemIds");
      if (!raw.every((x) => typeof x === "string" && x !== "") || new Set(raw).size !== raw.length) return bad("savedItemIds");
      const mine = new Set(live(engagementId).map((r) => r.id));
      return raw.every((x) => mine.has(x as string)) ? null : bad("savedItemIds");
    },
    count(engagementId, raw) {
      const at = new Date().toISOString();
      for (const r of live(engagementId)) if ((raw as string[]).includes(r.id)) { r.useCount += 1; r.lastUsedAt = at; }
    },
  };

  return { staff, store, find, itemOf, use };
}

// ── the demo's own store, pinned to globalThis like the other demo stores ───────────────────────────────────────────────
const KEY = Symbol.for("gaiada.demoSocial.saved");
const demoStore: SavedStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= seedSavedStore()) as SavedStore;
export const demoSaved = savedApi(demoStore);

/** The routes of 63.26 by `tail`; null when `tail` is none of them. */
export const demoSavedRoute = demoSaved.staff;

/** The post edit's hook into this store (BFF §63.26.3): `runDemoPipelineWrite` judges and counts `savedItemIds` through it. */
export const demoSavedUse = demoSaved.use;

