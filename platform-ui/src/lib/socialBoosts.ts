// SCP-4b, SCP-4c (BFF §63.11) — boosts and the monthly boost budget: the types of every answer, their defensive parsing, the words for each refusal, the forms' checks and the
// pure rules of the pages. No server-only import, so a client component may import the values.
//
// Readers live in `lib/socialBoosts-data.ts` (server-only, `ReadResult`), the writes in `lib/socialBoostsActions.ts` and `lib/portalSpendActions.ts` ("use server"); DEMO_MODE
// answers every route from `lib/demoSocialBoosts.ts`, in the server's order of checks.
//
// NO ADS ARE BOUGHT HERE. A boost records what the team runs in the network's own tools (or what the simulator runs): the agreement, the budget, the start and stop, the results.
//
// THE MACHINE IS THE FIXTURE. Which action exists from which status, and which Cerbos action each needs, are read from `scpStageMachine.json` (`scpBoostActionsFrom`); the
// money rules (committed, remaining, lowering) are the server's and are drawn here only as the server answered them. The one money rule this file states is the "within or over"
// line of the request dialog, which compares the request's total with the `remainingMinor` of the budget read, exactly as the server decides `approved` against `requested`.
// A parsed answer that is the wrong shape throws, and the reader turns that into "cannot tell", never into a plausible empty page. The server decides every write.
import { fromMinor, isIsoDate, minorUnitOf, toMinor } from "./contracts";
import { scpBoostAction, scpBoostActionsFrom } from "./scpStageMachine";
import { asBoostRow, formatBoostMoney, type BoostAudience, type BoostGoal, type BoostRow } from "./socialBoostRow";
import { CHANNELS, NOTE_MAX, refusalText, type Refusal } from "./socialPipeline";

export * from "./socialBoostRow";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const nameOf = (v: unknown): string | null => (isObj(v) ? str(v.name) : null);

// ── The budget (GET cycles/:cycleId/boost-budget) ───────────────────────────────────────────────────────────────────────────

export interface BoostAgreed {
  id: string | null; amountMinor: number; currency: string; minorUnit: number; via: "portal" | "recorded" | null; agreedAt: string | null; agreedBy: string | null; channel: string | null;
}
/** One proposal or recording of a month's budget. The contract names the list `Proposal[]` without a shape: the fields below are the ones the pages draw, all read leniently. */
export interface BudgetProposal {
  id: string; status: string; amountMinor: number; currency: string; minorUnit: number; note: string | null;
  at: string | null; by: string | null; decidedAt: string | null; decidedBy: string | null; via: string | null; channel: string | null;
}
export interface BoostBudget {
  cycleId: string | null; agreed: BoostAgreed | null; pending: BudgetProposal | null; committedMinor: number; remainingMinor: number; history: BudgetProposal[]; canRecord: boolean;
  /** The currency the figures are in: the agreement's, else a proposal's, else the department's (IDR). */
  currency: string; minorUnit: number;
}

function asProposal(raw: unknown, fallback: { currency: string; minorUnit: number }): BudgetProposal | null {
  if (!isObj(raw) || typeof raw.id !== "string") return null;
  const currency = str(raw.currency) ?? fallback.currency;
  return {
    id: raw.id, status: str(raw.status) ?? "pending", amountMinor: num(raw.amountMinor) ?? 0, currency, minorUnit: num(raw.minorUnit) ?? (str(raw.currency) ? minorUnitOf(currency) : fallback.minorUnit),
    note: str(raw.note) ?? str(raw.requestNote), at: str(raw.proposedAt) ?? str(raw.requestedAt) ?? str(raw.createdAt) ?? str(raw.at), by: nameOf(raw.proposedBy) ?? nameOf(raw.by) ?? nameOf(raw.requestedBy),
    decidedAt: str(raw.decidedAt), decidedBy: nameOf(raw.decidedBy), via: str(raw.via) ?? str(raw.agreedVia) ?? str(raw.decidedVia), channel: str(raw.channel),
  };
}

export function asBoostBudget(raw: unknown): BoostBudget {
  if (!isObj(raw) || num(raw.committedMinor) === null || num(raw.remainingMinor) === null) throw new Error("boost budget: not a budget read");
  const a = isObj(raw.agreed) && num(raw.agreed.amountMinor) !== null ? raw.agreed : null;
  const aCur = a ? str(a.currency) ?? "IDR" : null;
  const topCur = str(raw.currency);
  const currency = aCur ?? topCur ?? "IDR";
  const minorUnit = a ? num(a.minorUnit) ?? minorUnitOf(currency) : num(raw.minorUnit) ?? minorUnitOf(currency);
  const fb = { currency, minorUnit };
  const via = a && (a.via === "portal" || a.via === "recorded") ? a.via : null;
  return {
    cycleId: str(raw.cycleId),
    agreed: a ? { id: str(a.id), amountMinor: a.amountMinor as number, currency: aCur as string, minorUnit, via, agreedAt: str(a.agreedAt), agreedBy: nameOf(a.agreedBy), channel: str(a.channel) } : null,
    pending: asProposal(raw.pending, fb),
    committedMinor: raw.committedMinor as number, remainingMinor: raw.remainingMinor as number,
    history: arr(raw.history).map((h) => asProposal(h, fb)).filter((p): p is BudgetProposal => p !== null),
    canRecord: raw.canRecord === true, currency, minorUnit,
  };
}

/** The budget as the dialog needs it: the figures for one cycle, or "no cycle" (a month with no cycle has nothing agreed, so nothing remains). */
export interface BudgetForMonth { cycleId: string | null; agreedMinor: number | null; remainingMinor: number; committedMinor: number; currency: string; minorUnit: number; canRecord: boolean }

// ── The Boosting list (GET boosts) ──────────────────────────────────────────────────────────────────────────────────────────

export interface BoostCandidate { postId: string; clientName: string; title: string; engagementRate: number | null; accountAverageRate: number | null }
export interface BoostList {
  items: BoostRow[]; candidates: BoostCandidate[]; totals: { committedMinor: number; spendMinor: number; currency: string }; nextCursor: string | null;
}

export function asBoostList(raw: unknown): BoostList {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("boosts: not a boost list");
  const t = isObj(raw.totals) ? raw.totals : {};
  return {
    items: raw.items.map(asBoostRow),
    candidates: arr(raw.candidates).filter(isObj).filter((c) => typeof c.postId === "string").map((c) => ({
      postId: c.postId as string, clientName: str(c.clientName) ?? "", title: str(c.title) ?? "", engagementRate: num(c.engagementRate), accountAverageRate: num(c.accountAverageRate),
    })),
    totals: { committedMinor: num(t.committedMinor) ?? 0, spendMinor: num(t.spendMinor) ?? 0, currency: str(t.currency) ?? "IDR" },
    nextCursor: str(raw.nextCursor),
  };
}

/** `low` and `high` are null when the server has no basis (`none`): it never makes a number up. */
export interface BoostEstimate { low: number | null; high: number | null; basis: "history" | "simulated" | "none" }
export function asBoostEstimate(raw: unknown): BoostEstimate {
  const basis = isObj(raw) && (raw.basis === "history" || raw.basis === "simulated" || raw.basis === "none") ? raw.basis : null;
  if (!isObj(raw) || basis === null || (basis !== "none" && (num(raw.reachLow) === null || num(raw.reachHigh) === null))) throw new Error("estimate: not an estimate");
  return { low: num(raw.reachLow), high: num(raw.reachHigh), basis };
}
export const ESTIMATE_BASIS_WORDS: Readonly<Record<BoostEstimate["basis"], string>> = {
  history: "From this client's own past posts.", simulated: "SIMULATED: from the simulator's numbers, not a real account.", none: "There is not enough history to estimate a reach.",
};

// ── The portal's spend read (GET portal/social/spend) ──────────────────────────────────────────────────────────────────────

export interface PortalBudgetItem { proposalId: string; clientName: string; month: string; amountMinor: number; agreedMinor: number | null; committedMinor: number; currency: string; minorUnit: number; note: string | null; requestedAt: string | null }
export interface PortalBoostItem { boostId: string; clientName: string; postTitle: string; thumbFileId: string | null; totalBudgetMinor: number; days: number; startsOn: string; currency: string; minorUnit: number; remainingMinor: number }
/** A settled item of the client's own, as the page lists it. The contract names `history` without a shape: every field is read leniently. */
export interface PortalSpendHistory { id: string; kind: "budget" | "boost"; title: string; status: string; amountMinor: number | null; currency: string; minorUnit: number; decidedAt: string | null }
export interface PortalSpend { budgets: PortalBudgetItem[]; boosts: PortalBoostItem[]; history: PortalSpendHistory[]; canDecide: boolean }

export function asPortalSpend(raw: unknown): PortalSpend {
  if (!isObj(raw) || !Array.isArray(raw.budgets) || !Array.isArray(raw.boosts)) throw new Error("portal spend: not a spend read");
  const cur = (o: Record<string, unknown>) => str(o.currency) ?? "IDR";
  return {
    budgets: raw.budgets.filter(isObj).filter((b) => typeof b.proposalId === "string").map((b) => ({
      proposalId: b.proposalId as string, clientName: str(b.clientName) ?? "", month: str(b.month) ?? "", amountMinor: num(b.amountMinor) ?? 0, agreedMinor: num(b.agreedMinor),
      committedMinor: num(b.committedMinor) ?? 0, currency: cur(b), minorUnit: num(b.minorUnit) ?? minorUnitOf(cur(b)), note: str(b.note), requestedAt: str(b.requestedAt),
    })),
    boosts: raw.boosts.filter(isObj).filter((b) => typeof b.boostId === "string").map((b) => ({
      boostId: b.boostId as string, clientName: str(b.clientName) ?? "", postTitle: str(b.postTitle) ?? "", thumbFileId: str(b.thumbFileId), totalBudgetMinor: num(b.totalBudgetMinor) ?? 0,
      days: num(b.days) ?? 0, startsOn: str(b.startsOn) ?? "", currency: cur(b), minorUnit: num(b.minorUnit) ?? minorUnitOf(cur(b)), remainingMinor: num(b.remainingMinor) ?? 0,
    })),
    history: arr(raw.history).filter(isObj).map((h, i): PortalSpendHistory => ({
      id: str(h.id) ?? str(h.boostId) ?? str(h.proposalId) ?? `h${i}`, kind: h.kind === "boost" || typeof h.boostId === "string" ? "boost" : "budget",
      title: str(h.title) ?? str(h.postTitle) ?? (str(h.month) ? `${monthName(str(h.month) as string)} budget` : "A decision"), status: str(h.status) ?? str(h.decision) ?? "", amountMinor: num(h.amountMinor) ?? num(h.totalBudgetMinor),
      currency: cur(h), minorUnit: num(h.minorUnit) ?? minorUnitOf(cur(h)), decidedAt: str(h.decidedAt) ?? str(h.at),
    })),
    canDecide: raw.canDecide === true,
  };
}

/** "October 2026" from `YYYY-MM` (pure: no Date, so no zone), else the text as it came. */
function monthName(m: string): string {
  const x = /^(\d{4})-(\d{2})$/.exec(m);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return x && Number(x[2]) >= 1 && Number(x[2]) <= 12 ? `${names[Number(x[2]) - 1]} ${x[1]}` : m;
}

/** True when the section has something to draw: an item waiting, or a history. It stays absent otherwise. */
export const portalSpendHasContent = (s: PortalSpend | null): s is PortalSpend => s !== null && (s.budgets.length > 0 || s.boosts.length > 0 || s.history.length > 0);

export const PORTAL_VIEWER_LINE = "Only a signer on your account can agree to this, because it commits your money. You can see it here, and a signer will be asked.";

// ── The refusal words ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The wording of the codes that mean something a little different on a boost than the post page's map says. The rest are `REFUSAL_WORDS`'s (every fixture code is worded there). */
export const BOOST_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  not_officer_or_approver: "Only the client's officer, the Social Media head or the GM can run a boost. The owner agrees the money but does not run boosts.",
  not_a_social_approver: "Only the Social Media head, the GM, the owner and the superadmin can record or change a client's boost money.",
  view_only: "Only a signer on this account can decide this. Your access is view-only.",
  post_not_live: "Only a live post can be boosted.",
  open_boost_exists: "This post already has a boost that is not finished. Cancel it, or complete it, first.",
  currency_mismatch: "The boost's currency is not the currency of this client's agreed budget.",
  boost_not_waiting: "That boost is no longer waiting for the client. Reload to see where it is.",
  proposal_pending: "A proposal is already waiting for the client. Withdraw it first to propose another amount.",
  budget_already_decided: "That proposal has already been decided or withdrawn.",
  boost_already_decided: "That boost has already been decided.",
  cycle_not_found: "This client has no cycle for that month, so there is no budget to read.",
  proposal_not_found: "That proposal no longer exists.",
};

/** A boost refusal in a sentence, with the figures the server added (`budget_below_committed` names what is committed; a changed status names where the boost is now). */
export function boostRefusalText(r: Refusal): string {
  const d = r.detail ?? {};
  switch (r.error) {
    case "budget_below_committed": {
      const m = num(d.committedMinor);
      const cur = str(d.currency) ?? "IDR";
      return m === null ? "The budget cannot go below what is already committed." : `The budget cannot go below what is already committed: ${formatBoostMoney(m, cur)}.`;
    }
    case "boost_status_changed": case "invalid_boost_transition": {
      const s = str(d.status);
      const base = r.error === "boost_status_changed" ? "That boost changed while you were looking at it." : "That boost cannot move there from where it is.";
      return s ? `${base} It is now ${(BOOST_STATUS_NOW[s] ?? s)}. The page has been refreshed.` : base;
    }
    default:
      return BOOST_REFUSAL_WORDS[r.error] ?? refusalText(r);
  }
}
const BOOST_STATUS_NOW: Readonly<Record<string, string>> = {
  requested: "waiting for the client", approved: "approved", running: "running", stopped: "stopped", completed: "completed", cancelled: "cancelled", declined: "declined",
};

/** The warnings a boost write may carry, in words (`spend_above_budget` is a notice, never an error). */
export const BOOST_WARNING_WORDS: Readonly<Record<string, string>> = {
  spend_above_budget: "The spend is above the boost's budget. It is saved, and it is the spend that counts against the month.",
};
export const boostWarningText = (code: string): string => BOOST_WARNING_WORDS[code] ?? code.replace(/_/g, " ");

// ── What the card offers ────────────────────────────────────────────────────────────────────────────────────────────────────

export type BoostActionName = "cancel_boost" | "start_boost" | "stop_boost" | "complete_boost" | "record_boost_approval" | "record_boost_decline";
export const BOOST_ACTION_LABEL: Readonly<Record<BoostActionName, string>> = {
  cancel_boost: "Cancel", start_boost: "Start", stop_boost: "Stop", complete_boost: "Complete",
  record_boost_approval: "Record client's approval", record_boost_decline: "Record client's decline",
};
/** An open boost: one that still counts and still moves. A post has at most one of these (409 `open_boost_exists`). */
export const isOpenBoost = (status: string | null | undefined): boolean => status === "requested" || status === "approved" || status === "running" || status === "stopped";

/** The fixture's actions from a status that staff take: not the client's own `approve_boost` and `decline_boost` (those are the portal's, `portal:approve_spend`). */
const staffActionsFrom = (status: string) => scpBoostActionsFrom(status).filter((a) => !a.actors.includes("client"));

export interface BoostOffer { action: BoostActionName; label: string }
/**
 * The actions the card offers for a status and a person. The actions that exist from a status are the fixture's; a person's share of them is the fixture's actors:
 * the run actions (`cancel`, `start`, `stop`, `complete`) are the officer's and the two seats', the two `record` actions are one of the four approvers'. The server decides.
 */
export function boostOffers(status: string, who: { canRun: boolean; canRecord: boolean }): BoostOffer[] {
  const mine = staffActionsFrom(status).filter((a) => (a.cerbosAction === "boost" ? who.canRun : who.canRecord));
  // The run actions first, then the two that record the client's answer (the fixture lists them the other way round for a waiting boost).
  return [...mine.filter((a) => a.cerbosAction === "boost"), ...mine.filter((a) => a.cerbosAction !== "boost")]
    .map((a) => ({ action: a.action as BoostActionName, label: BOOST_ACTION_LABEL[a.action as BoostActionName] ?? a.action }));
}
/** True when the status has actions the person cannot take (so the card says who can). */
export const hasHiddenOffers = (status: string, who: { canRun: boolean; canRecord: boolean }): boolean =>
  staffActionsFrom(status).some((a) => (a.cerbosAction === "boost" ? !who.canRun : !who.canRecord));

// ── The request form ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RequestForm { goal: string; audience: string; audienceNote: string; dailyBudget: string; days: string; startsOn: string }
export const emptyRequestForm = (startsOn = ""): RequestForm => ({ goal: "", audience: "automatic", audienceNote: "", dailyBudget: "", days: "", startsOn });
export const AUDIENCE_NOTE_MAX = 500;
/** The server's bounds (BFF §63.1 file 7, §63.0): 1 to 90 days, and no total (daily × days) above 10^12 minor units. */
export const BOOST_DAYS_MAX = 90;
export const BOOST_TOTAL_MAX_MINOR = 1_000_000_000_000;
export type FormCheck<T> = { ok: true; body: T } | { ok: false; field: string; message: string };

/** A money input's text (whole units, with the currency's own decimals at most) as minor units, or null. `1,000,000` and `1 000 000` read as 1000000. */
export function parseMoneyInput(text: string, minorUnit: number): number | null {
  const t = text.replace(/[\s,]/g, "");
  if (t === "") return null;
  const b = toMinor(t, minorUnit);
  if (b === null || b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}
const wholeNumber = (text: string): number | null => (/^\d{1,6}$/.test(text.trim()) ? Number(text.trim()) : null);

/** The request's total in minor units, or null while the budget or the days are not filled in. */
export function requestTotal(form: Pick<RequestForm, "dailyBudget" | "days">, minorUnit: number): { dailyMinor: number; days: number; totalMinor: number } | null {
  const daily = parseMoneyInput(form.dailyBudget, minorUnit);
  const days = wholeNumber(form.days);
  if (daily === null || daily < 1 || days === null || days < 1) return null;
  const total = daily * days;
  return Number.isSafeInteger(total) ? { dailyMinor: daily, days, totalMinor: total } : null;
}

/** The dialog's line: starts without asking, or the client is asked. Same comparison as the server's `fitsRemaining`: the total against what remains. */
export function budgetLine(totalMinor: number, remainingMinor: number, currency: string, minorUnit: number): { within: boolean; text: string } {
  if (totalMinor <= remainingMinor) return { within: true, text: "Within this month's agreed budget: starts without asking." };
  return { within: false, text: `Over what remains (${formatBoostMoney(remainingMinor, currency, minorUnit)} left): the client will be asked to approve it.` };
}

/** The body of `POST posts/:postId/boosts`, checked with the contract's own rules so a person is told before the round trip. The server checks again. */
export function buildBoostRequest(form: RequestForm, ctx: { minorUnit: number; currency: string | null; id: string }): FormCheck<Record<string, unknown>> {
  const bad = (field: string, message: string): FormCheck<never> => ({ ok: false, field, message });
  if (!(["profile_visits", "website", "messages"] as string[]).includes(form.goal)) return bad("goal", "Choose what the boost is for.");
  if (!(["automatic", "local", "custom"] as string[]).includes(form.audience)) return bad("audience", "Choose an audience.");
  const note = form.audienceNote.trim();
  if (form.audience === "custom" && note === "") return bad("audienceNote", "Describe the custom audience.");
  if (note.length > AUDIENCE_NOTE_MAX) return bad("audienceNote", `Keep the audience note to ${AUDIENCE_NOTE_MAX} characters.`);
  const daily = parseMoneyInput(form.dailyBudget, ctx.minorUnit);
  if (daily === null || daily < 1) return bad("dailyBudgetMinor", "Give the daily budget as a whole amount above zero.");
  const days = wholeNumber(form.days);
  if (days === null || days < 1 || days > BOOST_DAYS_MAX) return bad("days", `Give the number of days, 1 to ${BOOST_DAYS_MAX}.`);
  if (daily * days > BOOST_TOTAL_MAX_MINOR) return bad("dailyBudgetMinor", "The total (daily budget × days) is too large.");
  if (!isIsoDate(form.startsOn)) return bad("startsOn", "Give a real start date.");
  return {
    ok: true,
    body: {
      id: ctx.id, goal: form.goal as BoostGoal, audience: form.audience as BoostAudience, ...(note ? { audienceNote: note } : {}),
      dailyBudgetMinor: daily, days, startsOn: form.startsOn, ...(ctx.currency ? { currency: ctx.currency } : {}),
    },
  };
}

// ── The action forms ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActionForm { spend: string; paidReach: string; clicks: string; channel: string; note: string }
export const emptyActionForm = (): ActionForm => ({ spend: "", paidReach: "", clicks: "", channel: "", note: "" });
const countOf = (text: string): number | null => (/^\d{1,10}$/.test(text.replace(/[\s,]/g, "")) ? Number(text.replace(/[\s,]/g, "")) : null);

/**
 * The body of `POST boosts/:boostId/actions` for one action: `expectedStatus` (the status the page showed) always, then the action's own params with the fixture's rules
 * (`stop_boost`: `spendMinor` required, `paidReach` and `clicks` optional; `complete_boost`: `spendMinor` and `paidReach` required, `clicks` optional; the two `record_*`: `channel`
 * and `note` required). A run action with no params (`cancel_boost`, `start_boost`) sends only the status.
 */
export function buildBoostAction(action: BoostActionName, expectedStatus: string, f: ActionForm, minorUnit: number): FormCheck<Record<string, unknown>> {
  const bad = (field: string, message: string): FormCheck<never> => ({ ok: false, field, message });
  const body: Record<string, unknown> = { action, expectedStatus };
  const spec = scpBoostAction(action)?.params ?? {};
  if (action === "stop_boost" || action === "complete_boost") {
    const spend = parseMoneyInput(f.spend, minorUnit);
    if (spend === null) return bad("spendMinor", "Give what the boost spent in total, 0 or more.");
    body.spendMinor = spend;
    const reachRequired = spec.paidReach?.startsWith("required") ?? false;
    if (f.paidReach.trim() === "") { if (reachRequired) return bad("paidReach", "Give the paid reach the network showed."); }
    else { const n = countOf(f.paidReach); if (n === null) return bad("paidReach", "Paid reach is a whole number."); body.paidReach = n; }
    if (f.clicks.trim() !== "") { const n = countOf(f.clicks); if (n === null) return bad("clicks", "Clicks is a whole number."); body.clicks = n; }
  }
  if (action === "record_boost_approval" || action === "record_boost_decline") {
    if (!(CHANNELS as readonly string[]).includes(f.channel)) return bad("channel", "Say how the client told you.");
    const note = f.note.trim();
    if (note === "") return bad("note", "Add a note on what the client said.");
    if (note.length > NOTE_MAX) return bad("note", `Keep the note to ${NOTE_MAX} characters.`);
    body.channel = f.channel;
    body.note = note;
  }
  return { ok: true, body };
}

// ── The budget forms ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BudgetForm { amount: string; channel: string; note: string }
export const emptyBudgetForm = (): BudgetForm => ({ amount: "", channel: "", note: "" });

/** The body of a proposal (`{amountMinor, note?}`) or of a recording (`{amountMinor, channel, note}`, both required). */
export function buildBudgetBody(kind: "propose" | "record", f: BudgetForm, minorUnit: number): FormCheck<Record<string, unknown>> {
  const bad = (field: string, message: string): FormCheck<never> => ({ ok: false, field, message });
  const amount = parseMoneyInput(f.amount, minorUnit);
  if (amount === null || amount < 1) return bad("amountMinor", "Give the monthly budget as a whole amount above zero.");
  const note = f.note.trim();
  if (note.length > NOTE_MAX) return bad("note", `Keep the note to ${NOTE_MAX} characters.`);
  if (kind === "propose") return { ok: true, body: { amountMinor: amount, ...(note ? { note } : {}) } };
  if (!(CHANNELS as readonly string[]).includes(f.channel)) return bad("channel", "Say how the client told you.");
  if (note === "") return bad("note", "Add a note on what the client said.");
  return { ok: true, body: { amountMinor: amount, channel: f.channel, note } };
}

/** The agreed amount in the text the money inputs take ("1000000"), for a prefilled field. */
export const amountInputText = (minor: number, minorUnit: number): string => fromMinor(BigInt(Math.trunc(minor)), minorUnit);

// ── Small words ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PROPOSAL_STATUS_LABEL: Readonly<Record<string, string>> = { pending: "Waiting for the client", agreed: "Agreed", declined: "Declined", withdrawn: "Withdrawn", superseded: "Replaced" };
export const proposalStatusLabel = (s: string): string => PROPOSAL_STATUS_LABEL[s] ?? s;
export const AGREED_VIA_LABEL: Readonly<Record<string, string>> = { portal: "by the client in the portal", recorded: "recorded by our team" };

/** "34.5%" for a ratio (0.0345); null is a dash. */
export const ratePercent = (r: number | null | undefined): string => (r === null || r === undefined ? "—" : `${(Math.round(r * 1000) / 10).toString()}%`);
