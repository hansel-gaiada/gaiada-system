// SCP-1d (BFF §63.7 `GET feed`, §63.4 `GET allocation?mine=1`, §63.5 `GET cycles?month=`; plan §6.2, §6.4) — the Social Media Home's types and pure rules.
// No server-only import, so a client component may import the values. Readers live in `lib/socialHome-data.ts` (server-only), the writes the Home's main
// button runs are `runPostAction` in `lib/socialPipelineActions.ts` (the same path as `PostActionBar`).
//
// The server decides who may do what: `nextAction.allowed` and its `reason` come from the feed's one `checkMany`. This file only turns them into words and
// into the rule for which button a card draws; it adds no rule of its own about who may act.
import type { Me } from "./platform";
import { isElevated } from "./rbac";
import { ACTION_DIALOG, ACTION_LABEL, reasonWords } from "./socialPipeline";
import { asHealth, healthText, type CycleRow, type CycleTable, type Health, type HealthState } from "./socialCycles";
import type { AllocationRow } from "./socialAllocation";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

// ── The feed (`GET feed`, §63.7) ─────────────────────────────────────────────────────────────────────────────────────────

export interface NextAction { action: string; allowed: boolean; reason?: string }

export interface PipelineCard {
  id: string;
  engagementId: string;
  clientName: string;
  title: string;
  format: string | null;
  isExtra: boolean;
  isStory: boolean;
  thumbFileId: string | null;
  pipelineStatus: string;
  phase: string | null;
  holder: { role: string | null; label: string };
  yourTurn: boolean;
  health: Health | null;
  scheduledAt: string | null;
  statusSince: string;
  nextAction: NextAction | null;
  simulated: boolean;
}

export interface FeedPage { items: PipelineCard[]; hasMore: boolean }

/** `GET feed`. Throws on a body that is not one (the reader turns that into "cannot tell", never an empty list); a card of the wrong shape is dropped. */
export function asFeedPage(raw: unknown): FeedPage {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("feed: not a page of cards");
  const items: PipelineCard[] = [];
  for (const c of raw.items) {
    if (!isObj(c)) continue;
    const id = str(c.id);
    const status = str(c.pipelineStatus);
    if (!id || !status) continue;
    const holder = isObj(c.holder) ? c.holder : {};
    const na = isObj(c.nextAction) && typeof c.nextAction.action === "string"
      ? { action: c.nextAction.action, allowed: c.nextAction.allowed === true, ...(str(c.nextAction.reason) ? { reason: str(c.nextAction.reason) as string } : {}) }
      : null;
    items.push({
      id, engagementId: str(c.engagementId) ?? "", clientName: str(c.clientName) ?? "A client", title: str(c.title) ?? "Untitled post", format: str(c.format),
      isExtra: c.isExtra === true, isStory: c.isStory === true, thumbFileId: str(c.thumbFileId), pipelineStatus: status, phase: str(c.phase),
      holder: { role: str(holder.role), label: str(holder.label) ?? "Nobody" }, yourTurn: c.yourTurn === true, health: asHealth(c.health),
      scheduledAt: str(c.scheduledAt), statusSince: str(c.statusSince) ?? "", nextAction: na, simulated: c.simulated === true,
    });
  }
  return { items, hasMore: typeof raw.nextCursor === "string" && raw.nextCursor !== "" };
}

/** What a card's main button is. The server decides `allowed`; this says how the button behaves.
 *  - `run`: an allowed action that needs no answer from the person: the button posts it (with `expectedStatus` and a fresh action id), as `PostActionBar` does.
 *  - `open`: an allowed action that asks for a note, a date or a check first (`ACTION_DIALOG`): its dialog lives on the post page, so the button opens the post.
 *  - `refused`: not allowed; a disabled button with the server's reason in words (`reasonWords`).
 *  - `none`: the card has no next action at all; it is only a link to the post. */
export type MainButton =
  | { kind: "run"; action: string; label: string }
  | { kind: "open"; action: string; label: string }
  | { kind: "refused"; action: string; label: string; reason: string }
  | { kind: "none" };

export function mainButtonOf(card: Pick<PipelineCard, "nextAction">): MainButton {
  const na = card.nextAction;
  if (!na) return { kind: "none" };
  const label = ACTION_LABEL[na.action] ?? na.action;
  if (!na.allowed) return { kind: "refused", action: na.action, label, reason: reasonWords(na.reason) };
  // An action the page does not know has no dialog entry (`undefined`): send the person to the post, where the server's full list of actions is drawn.
  return ACTION_DIALOG[na.action] === null ? { kind: "run", action: na.action, label } : { kind: "open", action: na.action, label };
}

// ── The ring (the client circles) ────────────────────────────────────────────────────────────────────────────────────────

/** A ring's state: the client's cycle health, or "none" for a client with no cycle this month (a different fact from "on track"). */
export type RingState = HealthState | "none";

/** The status tokens a ring is drawn with. They are the same tokens every status uses, so a skin never changes what a colour means; the label beside the ring
 *  always says the state in words, so the colour is never the only signal. */
export const RING_TOKEN: Readonly<Record<RingState, string>> = {
  on_track: "var(--status-ok)", tight: "var(--status-warning)", at_risk: "var(--status-critical)", late: "var(--status-danger)",
  done: "var(--status-idle)", none: "var(--erp-hairline)",
};
const RING_ORDER: Readonly<Record<RingState, number>> = { late: 0, at_risk: 1, tight: 2, on_track: 3, done: 4, none: 5 };

export const ringStateOf = (h: Health | null): RingState => h?.state ?? "none";

/** The words for a ring ("Brand Alpha: Late · 2 days · with the designer"), for the screen reader and the visible caption. */
export const ringWords = (h: Health | null): string => (h ? healthText(h) : "No cycle this month");

export interface StoryCircle { engagementId: string; clientName: string; state: RingState; words: string; mine: boolean }

/** One circle per client the caller works on: the clients whose officer is the caller; for one of the four approvers (the table's `canPlan`), every client.
 *  Worst state first, then the caller's own, then by name. Pure over the one `GET cycles` answer: no read per client. */
export function storyCircles(table: Pick<CycleTable, "rows" | "canPlan">, userId: string): StoryCircle[] {
  const all: StoryCircle[] = table.rows.map((r: CycleRow) => ({
    engagementId: r.engagementId, clientName: r.clientName, state: ringStateOf(r.health), words: ringWords(r.health), mine: r.officer?.id === userId,
  }));
  return all
    .filter((c) => table.canPlan || c.mine)
    .sort((a, b) => RING_ORDER[a.state] - RING_ORDER[b.state] || Number(b.mine) - Number(a.mine) || a.clientName.localeCompare(b.clientName));
}

// ── Reports due (the allocation's `reportDueDay`) ────────────────────────────────────────────────────────────────────────

export interface ReportDue { engagementId: string; clientName: string; dueDay: number; dueIso: string; daysLeft: number; format: "email" | "meeting" | null }

const pad = (n: number) => String(n).padStart(2, "0");

/** Each of the caller's clients with a report due day, with the date of this month's due day (clamped to the month's length) and the days left from `todayIso`
 *  (negative once it has passed). Soonest first. A client with no due day is not listed: nothing says when its report is due. */
export function reportsDue(rows: readonly AllocationRow[], todayIso: string): ReportDue[] {
  const y = Number(todayIso.slice(0, 4));
  const m = Number(todayIso.slice(5, 7));
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  const out: ReportDue[] = [];
  for (const r of rows) {
    if (r.reportDueDay === null || r.reportDueDay < 1) continue;
    const day = Math.min(r.reportDueDay, last);
    const dueIso = `${y}-${pad(m)}-${pad(day)}`;
    out.push({
      engagementId: r.engagementId, clientName: r.clientName, dueDay: r.reportDueDay, dueIso,
      daysLeft: Math.round((Date.parse(`${dueIso}T00:00:00Z`) - todayMs) / 86400000), format: r.reportFormat,
    });
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.clientName.localeCompare(b.clientName));
}

/** "Due today", "Due in 3 days", "Was due 2 days ago": when a report is due, in words. */
export function dueWords(daysLeft: number): string {
  if (daysLeft === 0) return "Due today";
  if (daysLeft === 1) return "Due tomorrow";
  if (daysLeft > 1) return `Due in ${daysLeft} days`;
  return daysLeft === -1 ? "Was due yesterday" : `Was due ${-daysLeft} days ago`;
}

/** The ordinal of a day of the month ("5th"), for "due on the 5th". */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

/** The owner and the superadmin act through the wildcard but hold no seat, so `feed?view=your_turn` is empty for them BY DESIGN (BFF §63.2, the same rule as Needs
 *  you's "no queue"): only the Social Media head and GM seats are approver holders. The Home says so instead of reading as "nothing to do". A mirror of the server. */
export function holdsNoSocialQueue(me: Pick<Me, "roles">, tenantId: string): boolean {
  return isElevated(me as Me) || me.roles.some((r) => r.role === "owner" && (r.scopeType === "global" || (r.scopeType === "company" && r.scopeId === tenantId)));
}
