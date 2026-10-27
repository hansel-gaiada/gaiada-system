// SCP-2 (BFF §63.9, §63.16) — the DEMO_MODE answers of the client's post approval page: `GET portal/social/posts`, `GET portal/social/stories`,
// `GET portal/social/posts/:postId`, `POST portal/social/posts/:postId/decide`, `POST portal/social/posts/approve-all` and
// `POST portal/social/decisions/:decisionId/undo`, plus the images the portal's file route serves (`GET portal/files/:fileId`).
//
// ONE STORE, TWO SIDES. Every answer is read from, and every decision is written to, the SAME pipeline store the staff demo uses
// (`demoSocialPipeline.ts`), through the machine's own commit (`demoCommitPortalDecision`, the fixture's `client_approve` and `client_change`). So a
// decision made here moves the post the staff pages show (status, change case, `changedOnly` and `copyBefore` for loop e, the creative state for loop d,
// the history row), and a recorded decision or a staff edit made there shows here (the "recorded on your behalf" line, a new `reviewHash`).
//
// THE SERVER'S ORDER OF CHECKS (§63.9), kept: 1 the caller is a portal client (a staff caller is 403 "not a portal client"); 2 the post is one of the
// contact's client's and has reached the client (else 404 `post_not_found`, never 403); 3 the status (409 `post_not_with_client`; a post that holds this
// contact's decision is let through to the replay rule); 4 the body (400 `{field}`); 5 the hash (409 `content_changed`); 6 a replay is 200
// `{alreadyDecided: true}`, a different decision 409 `client_review_already_decided`; 7 the decision. Undo: 404 `decision_not_found` (outside the scope), 403
// `not_your_decision`, 409 `undo_window_passed` (also when anything happened to the post since); a recorded decision has no undo.
//
// WHAT THE CLIENT SEES is built here from the store and nothing else: no staff status, holder, check, suggestion or name. The only staff name in an answer
// is the author of a comment written for the client.
import { isDemoPortalClient } from "./demoPortalClients";
import {
  PIPE_ENGAGEMENTS, PIPE_POSTS, allocStore, demoReviewHash, placeholderSvg, who, type DemoResult, type PipePost,
} from "./demoSocialPipeline";
import { demoCommitPortalDecision } from "./demoSocialPipelineRun";
import {
  UNDO_WINDOW_MS, CHANGE_NOTE_MAX,
  type PortalSocialBulkResult, type PortalSocialComment, type PortalSocialDecision, type PortalSocialImage, type PortalSocialPost,
  type PortalSocialState, type PortalSocialVariant,
} from "./portalSocial";

/** The client `demo-client` represents: Northwind Traders (the same id `socialClientReviewPortalDemo` serves). */
export const DEMO_PORTAL_CLIENT_ID = "cl-1";

const err = (status: number, error: string, field?: string): DemoResult => ({ status, json: field ? { error, field } : { error } });
const ok = (json: unknown): DemoResult => ({ status: 200, json });

const engagementOf = (p: PipePost) => PIPE_ENGAGEMENTS.find((e) => e.id === p.engagementId);

// ── the portal's own rows: decisions (for undo) and the comments written for the client ──────────────────────────────────────
interface DecisionRec {
  id: string; postId: string; userId: string; kind: "approved" | "changes"; at: number; until: number;
  /** The post's history length right after the decision: anything longer means something happened to the post since (undo is then refused). */
  historyLen: number;
  /** The post as it was before the decision: undo puts these fields back (`restore_pre_decision_fields`). */
  snapshot: PipePost;
}
interface CommentRow { id: string; postId: string; body: string; authorId: string; anchor: { x: number; y: number; fileId: string } | null; createdAt: string; visibility: "client" | "team" }
interface PortalStore { decisions: Map<string, DecisionRec>; undone: Set<string>; comments: CommentRow[]; seq: number }

const STORE = Symbol.for("gaiada.demoSocial.portal");
const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

function buildStore(): PortalStore {
  const byTitle = (t: string) => PIPE_POSTS.find((p) => p.title === t && engagementOf(p)?.clientId === DEMO_PORTAL_CLIENT_ID);
  const comments: CommentRow[] = [];
  const scarf = byTitle("Five ways to style a scarf");
  if (scarf) {
    comments.push(
      { id: "soc-cm-1", postId: scarf.id, body: "Slide 2 shows the new moss colour. Please check it looks right on your screen.", authorId: "u-social", anchor: { x: 0.42, y: 0.58, fileId: `${scarf.id}-f2` }, createdAt: hoursAgo(20), visibility: "client" },
      { id: "soc-cm-2", postId: scarf.id, body: "We added the care label on the last slide.", authorId: "u-social", anchor: null, createdAt: hoursAgo(19), visibility: "client" },
      // a team comment: it exists in the thread and must never reach the portal
      { id: "soc-cm-3", postId: scarf.id, body: "Internal: the moss colour is not in the brand book yet.", authorId: "u-pm", anchor: null, createdAt: hoursAgo(21), visibility: "team" },
    );
  }
  const launch = byTitle("Launch day announcement");
  if (launch) comments.push({ id: "soc-cm-4", postId: launch.id, body: "Thank you. We are making the product larger and moving the logo to the corner you pinned.", authorId: "u-social", anchor: null, createdAt: hoursAgo(30), visibility: "client" });
  return { decisions: new Map(), undone: new Set(), comments, seq: 0 };
}
const store: PortalStore = ((globalThis as Record<symbol, unknown>)[STORE] ??= buildStore()) as PortalStore;

// ── what is visible, and in which state ───────────────────────────────────────────────────────────────────────────────────────
const DECISION_ACTIONS: ReadonlySet<string> = new Set(["client_approve", "client_change", "record_client_approve", "record_client_change"]);
const APPROVE_ACTIONS: ReadonlySet<string> = new Set(["client_approve", "record_client_approve"]);
type Row = Record<string, unknown> & { action: string; to: string; at: string };
const rowsOf = (p: PipePost): Row[] => p.history as Row[];

/** The post has reached the client (the server's `client_first_sent_at`): it is, or was, with the client. */
function reachedClient(p: PipePost): boolean {
  return ["client", "approved", "scheduled", "live"].includes(p.pipelineStatus) || rowsOf(p).some((h) => h.to === "client" || DECISION_ACTIONS.has(h.action));
}
export const isPortalVisible = (p: PipePost): boolean => !p.archivedAt && engagementOf(p)?.clientId === DEMO_PORTAL_CLIENT_ID && reachedClient(p);

/** The client's own word on the post, if one stands: the last decision row, unless it was undone or the post was sent to the client again since. */
function standingRow(p: PipePost): Row | null {
  let standing: Row | null = null;
  for (const h of rowsOf(p)) {
    if (DECISION_ACTIONS.has(h.action)) standing = h;
    else if (h.action === "client_undo" || h.to === "client") standing = null;
  }
  return standing;
}

export function portalState(p: PipePost): PortalSocialState | null {
  if (!isPortalVisible(p)) return null;
  switch (p.pipelineStatus) {
    case "client": return "to_review";
    case "approved": return "approved";
    case "scheduled": return "scheduled";
    case "live": return "live";
    default: return "changes_asked"; // the team is working on what the client asked (changes, proofread, design, final check, blocked)
  }
}

// ── the answer's shape ────────────────────────────────────────────────────────────────────────────────────────────────────────
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const handleFor = (p: PipePost, network: string): string => {
  const channels = allocStore.brands[engagementOf(p)?.clientId ?? ""]?.book.channels ?? [];
  const hit = channels.find((c) => c.network === network);
  return `@${hit?.handle ?? slug(engagementOf(p)?.clientName ?? "account")}`;
};
const imageCount = (p: PipePost): number => (p.format === "carousel" ? 3 : 1);
const imagesOf = (p: PipePost): PortalSocialImage[] =>
  Array.from({ length: imageCount(p) }, (_, i) => ({
    fileId: `${p.id}-f${i + 1}`, thumbFileId: `${p.id}-f${i + 1}`, position: i + 1,
    alt: imageCount(p) > 1 ? `${p.title}, image ${i + 1} of ${imageCount(p)}` : p.title,
  }));
const variantsOf = (p: PipePost): PortalSocialVariant[] =>
  p.placement.map((network) => ({
    id: `${p.id}-v-${network}`, network, handle: handleFor(p, network), surface: p.format,
    body: [p.caption, p.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n"), firstComment: null, scheduledAt: p.scheduledAt,
  }));

function decisionOf(p: PipePost, userId: string, now: number): PortalSocialDecision | null {
  const row = standingRow(p);
  if (!row) return null;
  const id = String(row.decisionId ?? `soc-dec-${p.id}`);
  const kind = APPROVE_ACTIONS.has(row.action) ? "approved" : "changes";
  const recorded = row.recorded !== null && row.recorded !== undefined;
  const channel = recorded ? String((row.recorded as { channel?: string }).channel ?? "") || undefined : undefined;
  const rec = store.decisions.get(id);
  const open = !recorded && rec !== undefined && rec.userId === userId && now < rec.until && p.history.length === rec.historyLen;
  return {
    decisionId: id, kind,
    ...(kind === "changes" && typeof row.changeKind === "string" ? { changeKind: row.changeKind as "copy" | "design" } : {}),
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    ...(row.anchor ? { anchor: row.anchor as { x: number; y: number; fileId: string } } : {}),
    decidedAt: row.at,
    // never a staff name: a recorded decision has no author on the client's side
    decidedBy: recorded ? null : { name: (row.by as { name?: string } | undefined)?.name ?? "A contact of yours" },
    recorded, ...(channel ? { channel } : {}),
    ...(open && rec ? { undoUntil: new Date(rec.until).toISOString() } : {}),
  };
}

const commentsOf = (p: PipePost): PortalSocialComment[] =>
  store.comments
    .filter((c) => c.postId === p.id && c.visibility === "client")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((c) => ({ id: c.id, body: c.body, author: { name: who(c.authorId).name }, anchor: c.anchor, createdAt: c.createdAt }));

export function portalPost(p: PipePost, userId: string, now: number = Date.now()): PortalSocialPost {
  const eng = engagementOf(p)!;
  return {
    id: p.id, clientId: eng.clientId, clientName: eng.clientName, month: p.cycleMonth, title: p.title, format: p.format,
    plannedAt: p.scheduledAt, placement: [...p.placement], state: portalState(p)!,
    caption: p.caption, onAssetText: p.onAssetText, cta: p.cta, hashtags: [...p.hashtags],
    images: imagesOf(p), variants: variantsOf(p), reviewHash: demoReviewHash(p),
    decision: decisionOf(p, userId, now), comments: commentsOf(p),
    liveUrl: p.pipelineStatus === "live" ? p.liveUrl : null, simulated: p.simulated,
  };
}

// ── the images (BFF §63.8): `GET portal/files/:fileId` of a social post ─────────────────────────────────────────────────────
const hueOf = (clientId: string): number => [...clientId].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 7);
/** The portal file route's answer in DEMO_MODE: a generated placeholder at the post's network ratio, only for a visible post of the contact's client and
 *  only for an image the post has (anything else is the server's one 404). Null: not a social post file (the caller falls through). */
export function demoPortalSocialFile(userId: string, fileId: string): { status: number; svg?: string } | null {
  const m = /^(.+)-f(\d+)$/.exec(fileId);
  const p = m ? PIPE_POSTS.find((x) => x.id === m[1]) : undefined;
  if (!m || !p) return null;
  if (!isDemoPortalClient(userId)) return { status: 403 };
  const n = Number(m[2]);
  if (!isPortalVisible(p) || n < 1 || n > imageCount(p)) return { status: 404 };
  const tall = p.format === "story" || p.format === "reel";
  const label = imageCount(p) > 1 ? `${p.title} (${n}/${imageCount(p)})` : p.title;
  return { status: 200, svg: placeholderSvg(label, hueOf(engagementOf(p)!.clientId), 1080, tall ? 1920 : 1350) };
}

// ── the reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TABS = ["to_review", "approved", "grid"] as const;
const inTab = (tab: (typeof TABS)[number], s: PortalSocialState): boolean =>
  tab === "grid" || (tab === "to_review" ? s === "to_review" : s === "approved" || s === "scheduled" || s === "live");
const byDate = (a: PipePost, b: PipePost): number => (a.scheduledAt ?? "9").localeCompare(b.scheduledAt ?? "9") || a.id.localeCompare(b.id);
const DEFAULT_LIMIT = 30;

function list(params: URLSearchParams, userId: string, now: number): DemoResult {
  const tab = params.get("tab") ?? "to_review";
  if (!(TABS as readonly string[]).includes(tab)) return err(400, "invalid_field", "tab");
  const month = params.get("month");
  if (month !== null && month !== "" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return err(400, "invalid_field", "month");
  const limitRaw = params.get("limit");
  const limit = limitRaw === null ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return err(400, "invalid_field", "limit");
  const cursor = params.get("cursor");
  const offset = cursor === null || cursor === "" ? 0 : /^o\d{1,6}$/.test(cursor) ? Number(cursor.slice(1)) : -1;
  if (offset < 0) return err(400, "invalid_field", "cursor");
  const clientId = params.get("clientId");
  if (clientId !== null && clientId !== "" && !/^[\w-]{1,64}$/.test(clientId)) return err(400, "invalid_field", "clientId"); // a malformed one; an out-of-scope one lists nothing

  // the filter that frames the counts too: the page's header says how many wait in THIS client and month
  const scoped = PIPE_POSTS
    .filter(isPortalVisible)
    .filter((p) => !clientId || engagementOf(p)?.clientId === clientId)
    .filter((p) => !month || p.cycleMonth === month);
  const state = (p: PipePost) => portalState(p) as PortalSocialState;
  const counts = {
    toReview: scoped.filter((p) => state(p) === "to_review").length,
    approved: scoped.filter((p) => ["approved", "scheduled", "live"].includes(state(p))).length,
    changesAsked: scoped.filter((p) => state(p) === "changes_asked").length,
  };
  // to review: what is due soonest first; approved and the grid: newest first, the order of an account's feed
  const rows = scoped.filter((p) => inTab(tab as (typeof TABS)[number], state(p))).sort(tab === "to_review" ? byDate : (a, b) => byDate(b, a));
  const page = rows.slice(offset, offset + limit);
  return ok({
    items: page.map((p) => portalPost(p, userId, now)),
    nextCursor: offset + limit < rows.length ? `o${offset + limit}` : null,
    counts,
  });
}

function stories(params: URLSearchParams, userId: string, now: number): DemoResult {
  const clientId = params.get("clientId");
  if (clientId !== null && clientId !== "" && !/^[\w-]{1,64}$/.test(clientId)) return err(400, "invalid_field", "clientId");
  const rows = PIPE_POSTS
    .filter(isPortalVisible)
    .filter((p) => p.format === "story" && (!clientId || engagementOf(p)?.clientId === clientId))
    .filter((p) => portalState(p) === "to_review" || portalState(p) === "live")
    .sort((a, b) => Number(portalState(b) === "to_review") - Number(portalState(a) === "to_review") || byDate(b, a));
  return ok({ items: rows.slice(0, 20).map((p) => portalPost(p, userId, now)) });
}

// ── the writes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const frac = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;

function record(p: PipePost, userId: string, kind: "approved" | "changes", before: PipePost, at: Date): string {
  const id = `soc-dec-${p.id}-${++store.seq}-${at.getTime().toString(36)}`;
  const last = rowsOf(p)[rowsOf(p).length - 1] as Record<string, unknown>;
  last.decisionId = id;
  store.decisions.set(id, { id, postId: p.id, userId, kind, at: at.getTime(), until: at.getTime() + UNDO_WINDOW_MS, historyLen: p.history.length, snapshot: before });
  return id;
}

function decide(postId: string, body: string | undefined, userId: string): DemoResult {
  const now = new Date();
  const p = PIPE_POSTS.find((x) => x.id === postId);
  // 2 visibility: a post that is not the contact's client's, or has not reached the client, is a 404 and never a 403
  if (!p || !isPortalVisible(p)) return err(404, "post_not_found");
  // 3 status: waiting, or holding a decision (a replay is judged below)
  const standing = p.pipelineStatus === "client" ? null : standingRow(p);
  if (p.pipelineStatus !== "client" && !standing) return err(409, "post_not_with_client");
  // 4 body
  let raw: unknown = {};
  try { raw = body ? JSON.parse(body) : {}; } catch { return err(400, "invalid_field", "decision"); }
  const b = isObj(raw) ? raw : {};
  if (b.decision !== "approve" && b.decision !== "change") return err(400, "invalid_field", "decision");
  const noteLen = (v: unknown): number => (typeof v === "string" ? [...v.trim()].length : 0);
  // an approval may carry a note too (optional: 1 to 2,000 characters when it is there)
  if (b.decision === "approve" && b.note !== undefined && b.note !== null && (noteLen(b.note) < 1 || noteLen(b.note) > CHANGE_NOTE_MAX)) return err(400, "invalid_field", "note");
  if (b.decision === "change") {
    if (b.changeKind !== "copy" && b.changeKind !== "design") return err(400, "invalid_field", "changeKind");
    const len = typeof b.note === "string" ? [...b.note.trim()].length : 0;
    if (len < 1 || len > CHANGE_NOTE_MAX) return err(400, "invalid_field", "note");
    if (b.anchor !== undefined && b.anchor !== null) {
      const a = b.anchor;
      // the pin sits on one of the post's own pictures
      if (!isObj(a) || !frac(a.x) || !frac(a.y) || typeof a.fileId !== "string" || !imagesOf(p).some((i) => i.fileId === a.fileId)) return err(400, "invalid_field", "anchor");
    }
  }
  if (typeof b.seenHash !== "string" || b.seenHash === "") return err(400, "invalid_field", "seenHash");
  // 5 hash
  if (b.seenHash !== demoReviewHash(p)) return err(409, "content_changed");
  // 6 replay or a different decision
  if (standing) {
    const same = APPROVE_ACTIONS.has(standing.action) === (b.decision === "approve");
    if (!same) return err(409, "client_review_already_decided");
    return ok({ alreadyDecided: true, decisionId: String(standing.decisionId ?? ""), postId: p.id, state: portalState(p) });
  }
  // 7 the decision
  const before = structuredClone(p);
  const approve = b.decision === "approve";
  demoCommitPortalDecision(
    p, approve ? "client_approve" : "client_change",
    approve ? { seenHash: b.seenHash } : { changeKind: b.changeKind, note: String(b.note).trim(), ...(b.anchor ? { anchor: b.anchor } : {}), seenHash: b.seenHash },
    userId, now,
  );
  const last = rowsOf(p)[rowsOf(p).length - 1] as Record<string, unknown>;
  if (approve && typeof b.note === "string") last.note = b.note.trim();
  if (!approve) {
    last.note = String(b.note).trim();
    last.changeKind = b.changeKind;
    if (b.anchor) last.anchor = b.anchor;
  }
  const decisionId = record(p, userId, approve ? "approved" : "changes", before, now);
  return ok({ decisionId, postId: p.id, state: portalState(p), undoUntil: new Date(now.getTime() + UNDO_WINDOW_MS).toISOString() });
}

function approveAll(body: string | undefined, userId: string): DemoResult {
  let raw: unknown = {};
  try { raw = body ? JSON.parse(body) : {}; } catch { return err(400, "invalid_field", "items"); }
  const items = isObj(raw) ? raw.items : undefined;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) return err(400, "invalid_field", "items");
  if (!items.every((it) => isObj(it) && typeof it.postId === "string" && it.postId !== "" && typeof it.seenHash === "string" && it.seenHash !== "")) return err(400, "invalid_field", "items");
  const now = new Date();
  const results: PortalSocialBulkResult[] = (items as Array<{ postId: string; seenHash: string }>).map(({ postId, seenHash }) => {
    const p = PIPE_POSTS.find((x) => x.id === postId);
    if (!p || !isPortalVisible(p)) return { postId, outcome: "skipped", reason: "post_not_found" };
    // "approves exactly the listed posts that still wait with an unchanged hash"
    if (p.pipelineStatus !== "client") return { postId, outcome: "skipped", reason: standingRow(p) ? "client_review_already_decided" : "post_not_with_client" };
    if (seenHash !== demoReviewHash(p)) return { postId, outcome: "skipped", reason: "content_changed" };
    const before = structuredClone(p);
    demoCommitPortalDecision(p, "client_approve", { seenHash }, userId, now);
    return { postId, outcome: "approved", decisionId: record(p, userId, "approved", before, now) };
  });
  // the latest of the approved decisions' windows, or null when nothing was approved
  return ok({ results, undoUntil: results.some((r) => r.outcome === "approved") ? new Date(now.getTime() + UNDO_WINDOW_MS).toISOString() : null });
}

function undo(decisionId: string, userId: string): DemoResult {
  const now = new Date();
  if (store.undone.has(decisionId)) return err(404, "decision_not_found"); // a second undo has nothing to undo
  const rec = store.decisions.get(decisionId);
  // the post a decision belongs to: a live record, or a decision row of the seed (which carries its id)
  const p = rec
    ? PIPE_POSTS.find((x) => x.id === rec.postId)
    : PIPE_POSTS.find((x) => rowsOf(x).some((h) => DECISION_ACTIONS.has(h.action) && h.decisionId === decisionId));
  if (!p || !isPortalVisible(p)) return err(404, "decision_not_found");
  if (!rec) {
    // a seeded decision: recorded ones have no undo (it was not the contact's), and an old one of theirs is past its window
    const row = rowsOf(p).find((h) => h.decisionId === decisionId)!;
    return row.viaPortal === true && (row.by as { id?: string } | undefined)?.id === userId ? err(409, "undo_window_passed") : err(403, "not_your_decision");
  }
  if (rec.userId !== userId) return err(403, "not_your_decision");
  if (now.getTime() > rec.until || p.history.length !== rec.historyLen) return err(409, "undo_window_passed");
  const undoRow = { action: "client_undo", from: p.pipelineStatus, to: "client", by: who(userId), agent: null, at: now.toISOString(), recorded: null, viaPortal: true, decisionId };
  const history = [...p.history, undoRow];
  Object.assign(p, structuredClone(rec.snapshot), { history, statusSince: now.toISOString() });
  store.decisions.delete(decisionId);
  store.undone.add(decisionId);
  return ok({ decisionId, postId: p.id, state: portalState(p) });
}

// ── the dispatch ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Every route of BFF §63.9, answered in the server's order (the identity first). Null for a path that is none of them (the caller falls through).
 * `p` is the pathname (no query); `params` is the query.
 */
export function socialPortalPostsDemo(method: string, p: string, params: URLSearchParams, userId: string, body?: string): DemoResult | null {
  const m = /^\/api\/[^/]+\/portal\/social\/(posts|stories|posts\/approve-all|posts\/[^/]+|posts\/[^/]+\/decide|decisions\/[^/]+\/undo)$/.exec(p);
  if (!m) return null;
  const verb = method.toUpperCase();
  const tail = m[1];
  const route =
    verb === "GET" && tail === "posts" ? "list"
      : verb === "GET" && tail === "stories" ? "stories"
        : verb === "POST" && tail === "posts/approve-all" ? "approve-all"
          : verb === "GET" && /^posts\/[^/]+$/.test(tail) && tail !== "posts/approve-all" ? "one"
            : verb === "POST" && /^posts\/[^/]+\/decide$/.test(tail) ? "decide"
              : verb === "POST" && /^decisions\/[^/]+\/undo$/.test(tail) ? "undo"
                : null;
  if (!route) return null;
  // 1 identity: only a portal client contact (a staff caller is the server's 403, never an empty list)
  if (!isDemoPortalClient(userId)) return err(403, "not a portal client");
  const now = Date.now();
  const id = decodeURIComponent(tail.split("/")[1] ?? "");
  switch (route) {
    case "list": return list(params, userId, now);
    case "stories": return stories(params, userId, now);
    case "approve-all": return approveAll(body, userId);
    case "one": {
      const post = PIPE_POSTS.find((x) => x.id === id);
      return post && isPortalVisible(post) ? ok(portalPost(post, userId, now)) : err(404, "post_not_found");
    }
    case "decide": return decide(id, body, userId);
    default: return undo(id, userId);
  }
}
