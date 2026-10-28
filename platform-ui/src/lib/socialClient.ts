// SCP-1k / SCP-1m — the Social Media client page's types and pure helpers (BFF §63.5 `GET cycles/:cycleId/health`, §63.10 `GET calendar`, §63.6.1 create,
// §63.6.7 bulk). No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialClient-data.ts` (server-only, `ReadResult`), the writes in `lib/socialClientActions.ts` ("use server").
// The answers are parsed defensively: a 200 with the wrong shape must read as "cannot tell", never as a plausible-looking empty grid.
//
// COUNTING (plan §4.4): a post COUNTS toward the monthly target unless it is an extra post or a story. Stories and extra posts are shown beside the
// target and never fill a slot of the Plan grid. The server counts the same way (`tallyCounts`); `planSlots` here only lays the grid out.
import { SCP_PHASES, scpPhaseLabel } from "./scpStageMachine";
import type { Health, HealthState, HolderRole } from "./socialCycles";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

// ── The tabs ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The client page's tabs, by `?tab=` (BFF §63.17). The Feed preview (`preview`, SCP-3d) is the client's grid, with drag-to-swap of publish dates. */
export const CLIENT_TABS = [
  { key: "plan", label: "Plan" },
  { key: "stories", label: "Stories" },
  { key: "calendar", label: "Calendar" },
  { key: "preview", label: "Feed preview" },
  { key: "list", label: "List" },
  { key: "brand", label: "Client profile" },
] as const;
export type ClientTab = (typeof CLIENT_TABS)[number]["key"];

/** A `?tab=` value (or the first of several) as a tab; Plan for anything the page does not have. */
export function parseClientTab(v: string | string[] | undefined): ClientTab {
  const s = typeof v === "string" ? v : v?.[0];
  return CLIENT_TABS.find((t) => t.key === s)?.key ?? "plan";
}

// ── Words and tokens ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The status of a pipeline post, in words (the twelve statuses of the fixture). */
export const STATUS_LABEL: Readonly<Record<string, string>> = {
  planned: "Planned", drafting: "Drafting", proofread: "Proofread", hod: "HoD approval", design: "Design", final: "Final check",
  client: "With the client", changes: "Changes asked", approved: "Client approved", scheduled: "Scheduled", live: "Live", blocked: "Blocked",
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

const HOLDER_WORDS: Readonly<Record<string, string>> = {
  officer: "Officer", copywriter: "Copywriter", approver: "Approvers", designer: "Designer", client: "Client", publisher: "Publisher", external: "An outside party",
};
export const holderLabel = (h: string | null): string => (h ? HOLDER_WORDS[h] ?? h : "Nobody");

/** The phase of a post, in words: the fixture's own labels. */
export const phaseLabel = (phase: string | null): string => (phase ? scpPhaseLabel(phase) : "No phase");

/** The design token each phase is drawn with (a border and a legend dot; the label is always written beside it, so colour is never the only signal). */
export const PHASE_TOKEN: Readonly<Record<string, string>> = {
  brief: "var(--status-idle)",
  in_production: "var(--status-progress)",
  with_client: "var(--status-info)",
  client_changes: "var(--status-warning)",
  client_approved: "var(--status-ok)",
  posted: "var(--status-neutral)",
};
export const phaseToken = (phase: string | null): string => (phase ? PHASE_TOKEN[phase] ?? "var(--status-idle)" : "var(--status-idle)");

/** The inline style that carries a phase's token to the stylesheet as `--scp-phase` (a custom property is kept by every browser and by jsdom; the CSS
 *  draws the border, the legend dot and the phase dot from it, with the idle token when none is set). */
export const phaseStyle = (phase: string | null): Record<string, string> => ({ "--scp-phase": phaseToken(phase) });

/** The legend of the phase colours, in the fixture's order. */
export const PHASE_LEGEND: ReadonlyArray<{ key: string; label: string; token: string }> = SCP_PHASES.map((p) => ({ key: p.key, label: p.label, token: phaseToken(p.key) }));

export const FORMAT_WORDS: Readonly<Record<string, string>> = { feed: "Feed", carousel: "Carousel", reel: "Reel", story: "Story" };
export const formatWords = (f: string | null): string => (f ? FORMAT_WORDS[f] ?? f : "No format yet");

// ── The cycle's posts (GET cycles/:cycleId/health) ─────────────────────────────────────────────────────────────────────────

export interface ClientPost {
  postId: string;
  title: string;
  status: string;
  phase: string | null;
  holder: HolderRole | null;
  isExtra: boolean;
  format: string | null;
  health: Health | null;
}

export interface CycleView {
  cycleId: string;
  engagementId: string;
  clientName: string;
  month: string;
  deadline: string;
  readyBy: string;
  today: string;
  client: Health | null;
  posts: ClientPost[];
}

const STATES: readonly string[] = ["on_track", "tight", "at_risk", "late", "done"];
const HOLDERS: readonly string[] = ["officer", "copywriter", "approver", "designer", "client", "publisher", "external"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function asHealth(raw: unknown): Health | null {
  if (!isObj(raw) || typeof raw.state !== "string" || !STATES.includes(raw.state)) return null;
  return {
    state: raw.state as HealthState, spareDays: num(raw.spareDays), lateDays: num(raw.lateDays),
    lateWith: typeof raw.lateWith === "string" && HOLDERS.includes(raw.lateWith) ? (raw.lateWith as HolderRole) : null,
    latestSafeHandoff: str(raw.latestSafeHandoff), readyBy: str(raw.readyBy) ?? "",
  };
}

/** `GET cycles/:cycleId/health`. Throws on a body that is not one. */
export function asCycleView(raw: unknown): CycleView {
  if (!isObj(raw) || typeof raw.cycleId !== "string" || !Array.isArray(raw.posts)) throw new Error("cycle health: not an answer");
  const posts = raw.posts.map((p): ClientPost => {
    if (!isObj(p) || typeof p.postId !== "string" || typeof p.status !== "string") throw new Error("cycle health: not a post");
    return {
      postId: p.postId, title: str(p.title) ?? "Untitled post", status: p.status, phase: str(p.phase),
      holder: typeof p.holder === "string" && HOLDERS.includes(p.holder) ? (p.holder as HolderRole) : null,
      isExtra: p.isExtra === true, format: str(p.format), health: asHealth(p.health),
    };
  });
  return {
    cycleId: raw.cycleId, engagementId: str(raw.engagementId) ?? "", clientName: str(raw.clientName) ?? "", month: str(raw.month) ?? "",
    deadline: str(raw.deadline) ?? "", readyBy: str(raw.readyBy) ?? "", today: str(raw.today) ?? "", client: asHealth(raw.client), posts,
  };
}

/** Counted posts: neither an extra post nor a story (plan §4.4). */
export const isCounted = (p: Pick<ClientPost, "isExtra" | "format">): boolean => !p.isExtra && p.format !== "story";
/** A story: the story format, and not an extra post (an extra story is shown with the extra posts). */
export const isStory = (p: Pick<ClientPost, "isExtra" | "format">): boolean => !p.isExtra && p.format === "story";

export interface PlanLayout {
  /** The posts that fill the target's slots, in the order the server sent them. Never more than the target. */
  filled: ClientPost[];
  /** The empty slots, up to the target. Zero with no target. */
  empty: number;
  /** Counted posts beyond the target (they are still shown, after the slots). */
  over: ClientPost[];
  /** Extra posts, shown apart; never in a slot. */
  extras: ClientPost[];
  /** Stories, shown apart; never in a slot. */
  stories: ClientPost[];
}

/**
 * The Plan grid's layout: counted posts fill the slots of the monthly target in order, empty slots follow up to the target, and counted posts past the
 * target are listed as "over" rather than hidden. Extra posts and stories never take a slot. No target means no slots (the page says so).
 */
export function planSlots(posts: readonly ClientPost[], target: number | null): PlanLayout {
  const counted = posts.filter(isCounted);
  const cap = target === null ? counted.length : Math.max(0, target);
  const filled = counted.slice(0, cap);
  return {
    filled,
    empty: target === null ? 0 : Math.max(0, cap - filled.length),
    over: counted.slice(cap),
    extras: posts.filter((p) => p.isExtra),
    stories: posts.filter(isStory),
  };
}

/** The strip under the header: how many posts are late, at risk, with the client, and approved or beyond (counted posts only, like the target). */
export interface Highlights { late: number; atRisk: number; withClient: number; approvedOrLater: number; changesAsked: number }
export function cycleHighlights(posts: readonly ClientPost[]): Highlights {
  const h: Highlights = { late: 0, atRisk: 0, withClient: 0, approvedOrLater: 0, changesAsked: 0 };
  for (const p of posts.filter(isCounted)) {
    if (p.health?.state === "late") h.late += 1;
    else if (p.health?.state === "at_risk") h.atRisk += 1;
    if (p.phase === "with_client") h.withClient += 1;
    if (p.phase === "client_changes") h.changesAsked += 1;
    if (p.phase === "client_approved" || p.phase === "posted") h.approvedOrLater += 1;
  }
  return h;
}

// ── The calendar (GET calendar) ────────────────────────────────────────────────────────────────────────────────────────────

export interface CalendarItem {
  postId: string;
  clientName: string;
  title: string;
  format: string | null;
  scheduledAt: string;
  pipelineStatus: string;
  phase: string | null;
  simulated: boolean;
  /** SCP-3e: what dragging the post to another day does, the server's answer (the fixture's `date_moves` rule): an edit, `reschedule`, or locked. */
  dateMove: "edit" | "reschedule" | "locked";
  /** The refusal a move would get: `post_is_live` or `field_locked` when locked, else null. */
  dateMoveRefusal: "post_is_live" | "field_locked" | null;
}

/** `GET calendar`'s `{items}`. Throws on a body that is not one, an item with no `dateMove` included: the calendar never guesses whether a date may move. */
export function asCalendarItems(raw: unknown): CalendarItem[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("calendar: not a list");
  return raw.items.map((i): CalendarItem => {
    if (!isObj(i) || typeof i.postId !== "string" || typeof i.scheduledAt !== "string") throw new Error("calendar: not an item");
    if (i.dateMove !== "edit" && i.dateMove !== "reschedule" && i.dateMove !== "locked") throw new Error("calendar: an item without dateMove");
    return {
      postId: i.postId, clientName: str(i.clientName) ?? "", title: str(i.title) ?? "Untitled post", format: str(i.format), scheduledAt: i.scheduledAt,
      pipelineStatus: str(i.pipelineStatus) ?? "", phase: str(i.phase), simulated: i.simulated === true,
      dateMove: i.dateMove,
      // A locked post always says why (`field_locked` unless the server says it is live); a movable one has no refusal.
      dateMoveRefusal: i.dateMove !== "locked" ? null : i.dateMoveRefusal === "post_is_live" ? "post_is_live" : "field_locked",
    };
  });
}

const pad = (n: number): string => String(n).padStart(2, "0");
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

export const isMonth = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** The month asked for (`?month=YYYY-MM`), or the current one. */
export const parseMonth = (v: string | string[] | undefined, current: string): string => {
  const s = typeof v === "string" ? v : v?.[0];
  return isMonth(s) ? s : current;
};
export function shiftMonth(month: string, delta: number): string {
  const t = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

export interface GridDay { iso: string; inMonth: boolean }

/** A Monday-first month grid: whole weeks from the Monday on or before the 1st to the Sunday on or after the last day. */
export function monthGrid(month: string): GridDay[][] {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const first = Date.UTC(y, m - 1, 1);
  const last = Date.UTC(y, m, 0);
  const lead = (new Date(first).getUTCDay() + 6) % 7; // Monday = 0
  const trail = 6 - ((new Date(last).getUTCDay() + 6) % 7);
  const weeks: GridDay[][] = [];
  let week: GridDay[] = [];
  for (let ms = first - lead * DAY; ms <= last + trail * DAY; ms += DAY) {
    const iso = isoOf(ms);
    week.push({ iso, inMonth: iso.slice(0, 7) === month });
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  return weeks;
}

/** The first and last day of the month's grid: the range `GET calendar` is asked for (at most 42 days, inside the server's 62). */
export function gridRange(month: string): { from: string; to: string } {
  const weeks = monthGrid(month);
  return { from: weeks[0][0].iso, to: weeks[weeks.length - 1][6].iso };
}

/** The items by day (`YYYY-MM-DD`, in the zone the page shows dates in), each day's items in time order. */
export function itemsByDay(items: readonly CalendarItem[], dayOf: (iso: string) => string): Map<string, CalendarItem[]> {
  const out = new Map<string, CalendarItem[]>();
  for (const it of [...items].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))) {
    const k = dayOf(it.scheduledAt);
    out.set(k, [...(out.get(k) ?? []), it]);
  }
  return out;
}

// ── Creating a post (BFF §63.6.1) ──────────────────────────────────────────────────────────────────────────────────────────

export interface NewPostInput {
  /** A fresh uuid, so a replayed request answers 201 `created: false`. */
  id: string;
  title: string;
  isExtra: boolean;
  format: string | null;
  pillar: string | null;
  /** An ISO date-time, or null. */
  scheduledAt: string | null;
  placement: string[];
}

export interface NewPostDraft { title: string; format: string; pillar: string; scheduledLocal: string; placement: string[]; isExtra: boolean }

/** The body of `POST cycles/:cycleId/posts` for a draft, or the words of the first value outside its rule (the server re-checks every one). */
export function buildNewPost(d: NewPostDraft, id: string): { ok: true; body: NewPostInput } | { ok: false; field: string; message: string } {
  const title = d.title.trim();
  if (title === "" || [...title].length > 200) return { ok: false, field: "title", message: "Give the post a title of 1 to 200 characters." };
  const pillar = d.pillar.trim();
  if ([...pillar].length > 60) return { ok: false, field: "pillar", message: "The pillar is at most 60 characters." };
  let scheduledAt: string | null = null;
  if (d.scheduledLocal !== "") {
    const t = new Date(d.scheduledLocal);
    if (Number.isNaN(t.getTime())) return { ok: false, field: "scheduledAt", message: "Choose a real date and time, or leave it empty." };
    scheduledAt = t.toISOString();
  }
  return {
    ok: true,
    body: { id, title, isExtra: d.isExtra, format: d.format === "" ? null : d.format, pillar: pillar === "" ? null : pillar, scheduledAt, placement: [...d.placement] },
  };
}

/** The sentence for a refusal of the create route. The code stays the contract's; this is only the words. */
export function createRefusalText(code: string, field?: string): string {
  switch (code) {
    case "not_officer_or_approver": return "Only this client's officer, the Social Media head, the GM, the owner or the superadmin can add a post to the cycle.";
    case "cycle_not_found": return "This cycle is no longer there. Reload the page and try again.";
    case "invalid_field":
    case "missing_field":
      switch (field) {
        case "title": return "Give the post a title of 1 to 200 characters.";
        case "format": return "Choose feed, carousel, reel or story.";
        case "pillar": return "The pillar is at most 60 characters.";
        case "scheduledAt": return "Choose a real date and time, or leave it empty.";
        case "placement": return "Choose from the supported networks, each once.";
        case "id": return "That post id is already taken. Try again.";
        default: return field ? `${field} is not valid.` : "A value is not valid.";
      }
    default:
      return code.startsWith("not authorized") ? "You do not have access to add posts here." : code;
  }
}

// ── Bulk (BFF §63.6.7) ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type BulkAction = "send_to_proofread" | "approve_copy";
export const BULK_WORDS: Readonly<Record<BulkAction, { verb: string; done: string }>> = {
  send_to_proofread: { verb: "Send to proofread", done: "sent to proofread" },
  approve_copy: { verb: "Approve all", done: "approved" },
};

export interface BulkItem { postId: string; expectedStatus: string; actionId: string }
export type BulkResult =
  | { postId: string; ok: true; alreadyApplied: boolean }
  | { postId: string; ok: false; error: string; field?: string; blockers: Array<{ code: string; message: string }> };

/** `POST posts/actions`'s `{results}`. Throws on a body that is not one. */
export function asBulkResults(raw: unknown): BulkResult[] {
  if (!isObj(raw) || !Array.isArray(raw.results)) throw new Error("bulk: not an answer");
  return raw.results.map((r): BulkResult => {
    if (!isObj(r) || typeof r.postId !== "string" || typeof r.ok !== "boolean") throw new Error("bulk: not a result");
    if (r.ok) return { postId: r.postId, ok: true, alreadyApplied: r.alreadyApplied === true };
    const blockers = Array.isArray(r.blockers)
      ? r.blockers.filter(isObj).map((b) => ({ code: str(b.code) ?? "", message: str(b.message) ?? "" })).filter((b) => b.message !== "")
      : [];
    return { postId: r.postId, ok: false, error: str(r.error) ?? "refused", field: str(r.field) ?? undefined, blockers };
  });
}

/** The sentence for one refused item of a bulk call. */
export function bulkRefusalText(r: Extract<BulkResult, { ok: false }>): string {
  const base = ((): string => {
    switch (r.error) {
      case "not_the_officer": return "Only this client's officer can send it to proofread.";
      case "not_a_copywriter": return "Only a copywriter can approve the copy.";
      case "author_cannot_approve": return "The author of the copy cannot approve it.";
      case "automation_cannot_act": return "An automation cannot do this.";
      case "view_only": return "You can read this post but not act on it.";
      case "status_changed": return "Someone moved this post on since the page was loaded. Reload and try again.";
      case "invalid_transition": return "This post is not at a step where that can be done.";
      case "incomplete_post": return "The post is not complete enough to send.";
      case "checks_failed": return "The hand-off checks did not pass.";
      case "suggestion_stale": return "A suggestion was made on an older copy. Open the post and sort it out first.";
      case "field_locked": return "A field of this post is locked at its step.";
      case "post_not_found": return "This post is no longer there.";
      case "not_a_pipeline_post": return "This is a Composer post, not a pipeline post.";
      case "post_archived": return "This post is archived.";
      case "missing_field":
      case "invalid_field": return "The request for this post was not valid.";
      default: return r.error.startsWith("not authorized") ? "You do not have access to do this." : r.error;
    }
  })();
  const why = r.blockers.map((b) => b.message).join(" ");
  return why ? `${base} ${why}` : base;
}

/** One line per outcome, for the whole call: "3 sent to proofread. 1 refused." */
export function bulkSummary(action: BulkAction, results: readonly BulkResult[]): string {
  const done = results.filter((r) => r.ok).length;
  const refused = results.length - done;
  const parts = [`${done} ${BULK_WORDS[action].done}.`];
  if (refused > 0) parts.push(`${refused} refused.`);
  return parts.join(" ");
}

// ── Small helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A v4 uuid: the key of a create (so a retried request replays) and of a bulk item's `actionId`. */
export function newUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/** "October 2026" for `2026-10`. */
export function monthTitle(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The page of a post (SCP-1e's post page; it opens as a drawer over the page the person is on). */
export const postHref = (deptId: string, postId: string): string => `/departments/${encodeURIComponent(deptId)}/posts/${encodeURIComponent(postId)}`;
/** One client's page, on a tab. */
export const clientHref = (deptId: string, engagementId: string, tab?: ClientTab, extra: Record<string, string> = {}): string => {
  const qs = new URLSearchParams({ ...(tab ? { tab } : {}), ...extra }).toString();
  return `/departments/${encodeURIComponent(deptId)}/profile/${encodeURIComponent(engagementId)}${qs ? `?${qs}` : ""}`;
};
