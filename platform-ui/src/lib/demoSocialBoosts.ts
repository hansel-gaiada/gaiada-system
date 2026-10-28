import "server-only";
// SCP-4b, SCP-4c (BFF §63.11, §63.16) — what DEMO_MODE answers for boosts and the monthly boost budget, staff side and portal side, in the server's order of checks. The money
// rules are the fixture's (`scp-stage-machine.json`, keys `boosts` and `boostBudgets`) and the contract's; a unit test drives the fixture's own scenario against this twin.
//
//   staff   GET  cycles/:cycleId/boost-budget                     POST cycles/:cycleId/boost-budget/proposals
//           POST boost-budget/proposals/:proposalId/withdraw      POST cycles/:cycleId/boost-budget/record
//           GET  boosts                                           GET  posts/:postId/boosts/estimate        POST posts/:postId/boosts       POST boosts/:boostId/actions
//   portal  GET  portal/social/spend                              POST portal/social/spend/budgets/:proposalId/decide
//                                                                 POST portal/social/spend/boosts/:boostId/decide
//
// THE MONEY, exactly as the contract states it. A boost belongs to the cycle of the month its `startsOn` falls in. `committed` of a cycle is the full budget of each `approved` or
// `running` boost plus the actual spend of each `stopped` or `completed` one (nothing for `requested`, `cancelled` or `declined`); `remaining` is the cycle's agreed budget (0 with none)
// minus committed, never below 0. A request whose total fits `remaining` is `approved` through `budget`, else `requested` and the client is asked. A budget may be lowered down to
// `committed` and not below (409 `budget_below_committed`, with `detail`), checked when proposed, recorded and agreed. One open boost per post. Every write is one synchronous step, so
// there is no race between two writers here (the server's cycle lock is what gives it the same).
//
// THE ORDER OF CHECKS, as every twin here keeps it: 1 the caller (a client contact is not staff); 2 the target (404); 3 the role (403 with the fixture's code); 4 the body (400 `{field}`);
// 5 the fixture's guards in the order it lists them (409). The portal's order: identity, the target in the contact's scope (404), the signer (403 `view_only`), the body, the replay or a
// different decision (409), then the money guard.
//
// THE DATA is invented: three clients, Northwind Traders (agreed IDR 1,000,000 this month: one boost approved within it, one running, one over it and waiting for the client; a proposal for
// next month waiting too), Saltmarsh Day Spa (agreed IDR 600,000 recorded: one boost completed with results) and Harborlight Hotel (nothing agreed: a SIMULATED boost waiting, and a proposal
// pending). "A day in the warehouse" is the live boost candidate with no boost.
import { isDemoPortalClient } from "./demoPortalClients";
import {
  DEMO_PEOPLE, PIPE_ENGAGEMENTS, PIPE_POSTS, SEAT_APPROVERS, allocStore, cyclesStore, demoMonthShift, demoShift, isClientContact, isDemoSocialApprover, setDemoBoostReader, who,
  type DemoResult, type PipePost,
} from "./demoSocialPipeline";
import { DEMO_PORTAL_CLIENT_ID, isPortalVisible } from "./demoSocialPortal";
import { demoSocialMetrics } from "./demoSocialMetrics";
import { todayIsoInDisplayZone } from "./format";
import { isIsoDate } from "./contracts";
import { scpBoostAction, scpBoostStatuses, scpBudgetAction } from "./scpStageMachine";
import { isOpenBoost } from "./socialBoosts";
import type { BoostRow } from "./socialBoostRow";

const err = (status: number, error: string, extra: Record<string, unknown> = {}): DemoResult => ({ status, json: { error, ...extra } });
const ok = (json: unknown, status = 200): DemoResult => ({ status, json });
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const absent = (v: unknown): boolean => v === undefined || v === null;
const NOT_AUTHORIZED = "not authorized: cerbos denied read on social_post";
const ID = /^[\w-]{1,64}$/;
const CURRENCY = "IDR";
const MINOR_UNIT = 0;
const CHANNELS = ["whatsapp", "email", "meeting"];
const GOALS = ["profile_visits", "website", "messages"];
const AUDIENCES = ["automatic", "local", "custom"];
const NOTE_MAX = 2000;
const AUDIENCE_NOTE_MAX = 500;
/** The signers of the demo portal: every demo client contact except Northwind's view-only one (WSK-49f). */
const VIEWER = "demo-client-viewer";

// ── the store ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

type BudgetStatus = "pending" | "agreed" | "declined" | "withdrawn" | "superseded";
export interface BudgetRec {
  id: string; cycleId: string; engagementId: string; status: BudgetStatus; amountMinor: number; currency: string; via: "portal" | "recorded" | null; channel: string | null;
  note: string | null; proposedBy: string | null; requestedAt: string; decidedAt: string | null; decidedBy: string | null;
}
export interface BoostRec {
  id: string; postId: string; engagementId: string; cycleId: string | null; status: string; goal: string; audience: string; audienceNote: string | null;
  dailyBudgetMinor: number; days: number; totalBudgetMinor: number; currency: string; startsOn: string; approvedVia: "budget" | "portal" | "recorded" | null; budgetId: string | null;
  approvedAt: string | null; startedAt: string | null; endedAt: string | null; spendMinor: number | null; paidReach: number | null; clicks: number | null;
  reachEstimate: { low: number; high: number } | null; simulated: boolean; requestedBy: string | null; requestedAt: string; channel: string | null; decisionNote: string | null;
  /** The `actionId` of the last staff action applied: a replay of it answers `alreadyApplied: true` (the server's replay key). */
  lastActionId?: string | null;
}
export interface BoostStore { budgets: BudgetRec[]; boosts: BoostRec[]; seq: number }

const iso = (ms: number): string => new Date(ms).toISOString();
const hoursAgo = (h: number): string => iso(Date.now() - h * 3_600_000);

const postById = (id: string): PipePost | undefined => PIPE_POSTS.find((p) => p.id === id);
const engagementOf = (id: string) => PIPE_ENGAGEMENTS.find((e) => e.id === id);
const clientOfEngagement = (engagementId: string): string => engagementOf(engagementId)?.clientId ?? "";
const officerOf = (engagementId: string): string | null => allocStore.byEngagement[engagementId]?.officerId ?? null;
const cycleById = (id: string) => cyclesStore.cycles.find((c) => c.id === id);
const cycleFor = (engagementId: string, month: string) => cyclesStore.cycles.find((c) => c.engagementId === engagementId && c.month === month) ?? null;
const monthTitle = (m: string): string => {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
};

export const emptyBoostStore = (): BoostStore => ({ budgets: [], boosts: [], seq: 0 });

/** The demo's invented boosts and budgets (see the file header), built from the demo pipeline's own posts. */
export function seedBoostStore(): BoostStore {
  const s = emptyBoostStore();
  const today = todayIsoInDisplayZone();
  const M = today.slice(0, 7);
  const byTitle = (t: string) => PIPE_POSTS.find((p) => p.title === t);
  const cyc = (p: PipePost, month: string) => cycleFor(p.engagementId, month)?.id ?? `soc-cyc-${p.engagementId}-${month}`;
  const budget = (cycleId: string, engagementId: string, o: Partial<BudgetRec> & { status: BudgetStatus; amountMinor: number }): BudgetRec => {
    const rec: BudgetRec = {
      id: `soc-bb-${++s.seq}`, cycleId, engagementId, currency: CURRENCY, via: null, channel: null, note: null, proposedBy: null, requestedAt: hoursAgo(24), decidedAt: null, decidedBy: null, ...o,
    };
    s.budgets.push(rec);
    return rec;
  };
  const boost = (p: PipePost, month: string, o: Partial<BoostRec> & { status: string; dailyBudgetMinor: number; days: number; startsOn: string }): BoostRec => {
    const rec: BoostRec = {
      id: `soc-boost-${++s.seq}`, postId: p.id, engagementId: p.engagementId, cycleId: cyc(p, month), goal: "profile_visits", audience: "automatic", audienceNote: null,
      totalBudgetMinor: o.dailyBudgetMinor * o.days, currency: CURRENCY, approvedVia: null, budgetId: null, approvedAt: null, startedAt: null, endedAt: null, spendMinor: null, paidReach: null,
      clicks: null, reachEstimate: null, simulated: p.simulated, requestedBy: officerOf(p.engagementId), requestedAt: hoursAgo(72), channel: null, decisionNote: null, ...o,
    };
    s.boosts.push(rec);
    return rec;
  };

  const harvest = byTitle("Harvest collection arrives");
  const lateOpen = byTitle("Open until late tonight");
  const reshare = byTitle("Reader favourite reshare");
  const sunday = byTitle("Sunday reset ritual");
  const brunch = byTitle("Weekend brunch is back");
  if (harvest && lateOpen && reshare && sunday && brunch) {
    // Northwind Traders: agreed IDR 1,000,000 this month, through the portal; an earlier agreement and a declined proposal are its history.
    const nCycle = cyc(harvest, M);
    budget(nCycle, harvest.engagementId, { status: "superseded", amountMinor: 800_000, via: "portal", requestedAt: hoursAgo(24 * 50), decidedAt: hoursAgo(24 * 45), decidedBy: DEMO_PEOPLE["demo-client"], proposedBy: "u-pm" });
    budget(nCycle, harvest.engagementId, { status: "declined", amountMinor: 1_500_000, note: "Raising the month for the harvest launch.", requestedAt: hoursAgo(24 * 30), decidedAt: hoursAgo(24 * 28), decidedBy: DEMO_PEOPLE["demo-client"], proposedBy: "u-pm" });
    const agreed = budget(nCycle, harvest.engagementId, { status: "agreed", amountMinor: 1_000_000, via: "portal", requestedAt: hoursAgo(24 * 22), decidedAt: hoursAgo(24 * 20), decidedBy: DEMO_PEOPLE["demo-client"], proposedBy: "u-pm" });
    // Next month's proposal is waiting for the client (the portal shows it).
    budget(cyc(harvest, demoMonthShift(M, 1)), harvest.engagementId, { status: "pending", amountMinor: 1_200_000, note: "Raising next month's budget for the holiday launch.", requestedAt: hoursAgo(30), proposedBy: "u-pm" });
    const yesterday = today.endsWith("-01") ? today : demoShift(today, -1);
    // Approved within the budget, not started: 100,000 a day for 3 days.
    boost(harvest, M, { status: "approved", dailyBudgetMinor: 100_000, days: 3, startsOn: `${M}-28`, approvedVia: "budget", budgetId: agreed.id, approvedAt: hoursAgo(72), reachEstimate: { low: 4_800, high: 10_800 } });
    // Running: 50,000 a day for 4 days, started yesterday.
    boost(lateOpen, M, { status: "running", dailyBudgetMinor: 50_000, days: 4, startsOn: yesterday, goal: "website", approvedVia: "budget", budgetId: agreed.id, approvedAt: hoursAgo(60), startedAt: `${yesterday}T09:00:00.000Z`, reachEstimate: { low: 2_400, high: 5_400 } });
    // Over what remains (500,000 left): 100,000 a day for 6 days waits for the client.
    boost(reshare, M, { status: "requested", dailyBudgetMinor: 100_000, days: 6, startsOn: `${M}-27`, goal: "messages", audience: "local", requestedAt: hoursAgo(20), reachEstimate: { low: 7_200, high: 16_200 } });

    // Saltmarsh Day Spa: agreed IDR 600,000 recorded after a call; its boost is completed with results.
    const sCycle = cyc(sunday, M);
    const sAgreed = budget(sCycle, sunday.engagementId, { status: "agreed", amountMinor: 600_000, via: "recorded", channel: "meeting", note: "Agreed at the monthly check-in.", requestedAt: hoursAgo(24 * 21), decidedAt: hoursAgo(24 * 21), decidedBy: DEMO_PEOPLE["u-pm"], proposedBy: "u-pm" });
    boost(sunday, M, {
      status: "completed", dailyBudgetMinor: 50_000, days: 3, startsOn: `${M}-01`, approvedVia: "budget", budgetId: sAgreed.id, approvedAt: hoursAgo(24 * 12), startedAt: `${M}-01T08:00:00.000Z`,
      endedAt: iso(Math.min(Date.now(), Date.parse(`${M}-04T08:00:00.000Z`))), spendMinor: 142_500, paidReach: 6_100, clicks: 230, reachEstimate: { low: 3_600, high: 8_100 },
    });

    // Harborlight Hotel: nothing agreed yet, so its SIMULATED boost waits; a proposal is pending for the client.
    const hCycle = cyc(brunch, M);
    budget(hCycle, brunch.engagementId, { status: "pending", amountMinor: 800_000, note: "A first monthly budget for the brunch campaign.", requestedAt: hoursAgo(10), proposedBy: "u-pm" });
    boost(brunch, M, { status: "requested", dailyBudgetMinor: 80_000, days: 5, startsOn: `${M}-26`, goal: "website", requestedAt: hoursAgo(8), reachEstimate: { low: 3_200, high: 7_200 } });
  }
  return s;
}

// ── the engine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const contribution = (b: BoostRec): number =>
  b.status === "approved" || b.status === "running" ? b.totalBudgetMinor : b.status === "stopped" || b.status === "completed" ? b.spendMinor ?? 0 : 0;

export function boostApi(store: BoostStore) {
  const agreedOf = (cycleId: string): BudgetRec | null => store.budgets.find((b) => b.cycleId === cycleId && b.status === "agreed") ?? null;
  const pendingOf = (cycleId: string): BudgetRec | null => store.budgets.find((b) => b.cycleId === cycleId && b.status === "pending") ?? null;
  const committed = (cycleId: string | null): number => (cycleId ? store.boosts.filter((b) => b.cycleId === cycleId).reduce((n, b) => n + contribution(b), 0) : 0);
  const remaining = (cycleId: string | null): number => {
    const a = cycleId ? agreedOf(cycleId) : null;
    return a ? Math.max(0, a.amountMinor - committed(cycleId)) : 0;
  };

  const rowOf = (b: BoostRec): BoostRow => {
    const p = postById(b.postId);
    return {
      id: b.id, postId: b.postId, postTitle: p?.title ?? "", clientName: engagementOf(b.engagementId)?.clientName ?? "", cycleId: b.cycleId, status: b.status, goal: b.goal, audience: b.audience,
      audienceNote: b.audienceNote, dailyBudgetMinor: b.dailyBudgetMinor, days: b.days, totalBudgetMinor: b.totalBudgetMinor, currency: b.currency, minorUnit: MINOR_UNIT, startsOn: b.startsOn,
      approvedVia: b.approvedVia, approvedAt: b.approvedAt, startedAt: b.startedAt, endedAt: b.endedAt, spendMinor: b.spendMinor, paidReach: b.paidReach, clicks: b.clicks,
      reachEstimate: b.reachEstimate, simulated: b.simulated,
    };
  };
  const proposalOf = (r: BudgetRec) => ({
    id: r.id, status: r.status, amountMinor: r.amountMinor, currency: r.currency, minorUnit: MINOR_UNIT, note: r.note, proposedAt: r.requestedAt,
    proposedBy: r.proposedBy ? who(r.proposedBy) : null, decidedAt: r.decidedAt, decidedBy: r.decidedBy ? { name: r.decidedBy } : null, via: r.via, channel: r.channel,
  });
  const budgetRead = (cycleId: string, userId: string) => {
    const a = agreedOf(cycleId);
    const p = pendingOf(cycleId);
    return {
      cycleId, currency: CURRENCY, minorUnit: MINOR_UNIT,
      agreed: a ? { id: a.id, amountMinor: a.amountMinor, currency: a.currency, minorUnit: MINOR_UNIT, via: a.via, agreedAt: a.decidedAt, agreedBy: a.decidedBy ? { name: a.decidedBy } : null, ...(a.channel ? { channel: a.channel } : {}) } : null,
      pending: p ? proposalOf(p) : null, committedMinor: committed(cycleId), remainingMinor: remaining(cycleId),
      history: store.budgets.filter((b) => b.cycleId === cycleId && b.status !== "pending" && b.status !== "agreed").sort((x, y) => (y.decidedAt ?? y.requestedAt).localeCompare(x.decidedAt ?? x.requestedAt)).map(proposalOf),
      canRecord: isDemoSocialApprover(userId),
    };
  };
  const openBoostOf = (postId: string): BoostRec | undefined => store.boosts.find((b) => b.postId === postId && isOpenBoost(b.status));
  /** The post read's `boost`: the open one, else the latest. */
  const boostOfPost = (postId: string): BoostRow | null => {
    const open = openBoostOf(postId);
    if (open) return rowOf(open);
    const all = store.boosts.filter((b) => b.postId === postId).sort((a, b) => b.startsOn.localeCompare(a.startsOn) || b.requestedAt.localeCompare(a.requestedAt));
    return all[0] ? rowOf(all[0]) : null;
  };

  // ── shared body checks ──
  const whole = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
  const bad = (code: "missing_field" | "invalid_field", field: string) => err(400, code, { field });
  const noteOf = (v: unknown, max: number): string | null | DemoResult => {
    if (absent(v)) return null;
    if (typeof v !== "string" || [...v.trim()].length > max) return bad("invalid_field", "note");
    return v.trim() === "" ? null : v.trim();
  };
  const isErr = (v: unknown): v is DemoResult => typeof v === "object" && v !== null && "status" in v && "json" in v;
  const parseBody = (raw: string | undefined): Record<string, unknown> | DemoResult => {
    try { const j = raw ? JSON.parse(raw) : {}; return isObj(j) ? j : {}; } catch { return err(400, "invalid_field", { field: "body" }); }
  };

  // ── the budget routes ──
  function readBudget(cycleId: string, userId: string): DemoResult {
    if (isClientContact(userId)) return err(403, NOT_AUTHORIZED);
    if (!cycleById(cycleId)) return err(404, "cycle_not_found");
    return ok(budgetRead(cycleId, userId));
  }

  function propose(cycleId: string, raw: string | undefined, userId: string): DemoResult {
    const cycle = cycleById(cycleId);
    if (isClientContact(userId)) return err(403, "not_a_social_approver");
    if (!cycle) return err(404, "cycle_not_found");
    if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
    const b = parseBody(raw);
    if (isErr(b)) return b;
    if (absent(b.amountMinor)) return bad("missing_field", "amountMinor");
    if (!whole(b.amountMinor, 1, Number.MAX_SAFE_INTEGER)) return bad("invalid_field", "amountMinor");
    const note = noteOf(b.note, NOTE_MAX);
    if (isErr(note)) return note;
    // The fixture's guards, in its order: no_pending_proposal, then covers_committed.
    if (pendingOf(cycleId)) return err(409, scpBudgetAction("propose_boost_budget")!.guards[0].refusal);
    if (b.amountMinor < committed(cycleId)) return err(409, scpBudgetAction("propose_boost_budget")!.guards[1].refusal, { detail: { committedMinor: committed(cycleId), currency: CURRENCY } });
    const rec: BudgetRec = {
      id: `soc-bb-${++store.seq}`, cycleId, engagementId: cycle.engagementId, status: "pending", amountMinor: b.amountMinor, currency: CURRENCY, via: null, channel: null, note,
      proposedBy: userId, requestedAt: iso(Date.now()), decidedAt: null, decidedBy: null,
    };
    store.budgets.push(rec);
    return ok({ ...budgetRead(cycleId, userId), proposalId: rec.id }, 201);
  }

  function withdraw(proposalId: string, userId: string): DemoResult {
    const rec = store.budgets.find((x) => x.id === proposalId);
    if (isClientContact(userId)) return err(403, "not_a_social_approver");
    if (!rec) return err(404, "proposal_not_found");
    if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
    if (rec.status !== "pending") return err(409, scpBudgetAction("withdraw_boost_budget")!.guards[0].refusal);
    rec.status = "withdrawn";
    rec.decidedAt = iso(Date.now());
    rec.decidedBy = who(userId).name;
    return ok({ ...budgetRead(rec.cycleId, userId), proposalId: rec.id });
  }

  function record(cycleId: string, raw: string | undefined, userId: string): DemoResult {
    const cycle = cycleById(cycleId);
    if (isClientContact(userId)) return err(403, "not_a_social_approver");
    if (!cycle) return err(404, "cycle_not_found");
    if (!isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
    const b = parseBody(raw);
    if (isErr(b)) return b;
    if (absent(b.amountMinor)) return bad("missing_field", "amountMinor");
    if (!whole(b.amountMinor, 1, Number.MAX_SAFE_INTEGER)) return bad("invalid_field", "amountMinor");
    if (absent(b.channel)) return bad("missing_field", "channel");
    if (typeof b.channel !== "string" || !CHANNELS.includes(b.channel)) return bad("invalid_field", "channel");
    if (absent(b.note) || (typeof b.note === "string" && b.note.trim() === "")) return bad("missing_field", "note");
    const note = noteOf(b.note, NOTE_MAX);
    if (isErr(note)) return note;
    if (b.amountMinor < committed(cycleId)) return err(409, scpBudgetAction("record_boost_budget")!.guards[0].refusal, { detail: { committedMinor: committed(cycleId), currency: CURRENCY } });
    const now = iso(Date.now());
    for (const x of store.budgets) if (x.cycleId === cycleId && (x.status === "agreed" || x.status === "pending")) { x.status = "superseded"; x.decidedAt ??= now; }
    const rec: BudgetRec = {
      id: `soc-bb-${++store.seq}`, cycleId, engagementId: cycle.engagementId, status: "agreed", amountMinor: b.amountMinor, currency: CURRENCY, via: "recorded", channel: b.channel, note,
      proposedBy: userId, requestedAt: now, decidedAt: now, decidedBy: who(userId).name,
    };
    store.budgets.push(rec);
    return ok({ ...budgetRead(cycleId, userId), proposalId: rec.id });
  }

  // ── the list and the estimate ──
  function candidates(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const p of PIPE_POSTS) {
      if (p.pipelineStatus !== "live" || p.archivedAt || openBoostOf(p.id)) continue;
      const m = demoSocialMetrics("GET", `posts/${p.id}/metrics`, undefined, "demo-hansel", () => false);
      const j = m && m.status === 200 ? (m.json as { boostCandidate?: boolean; engagementRate?: number | null; accountAverageRate?: number | null }) : null;
      if (j?.boostCandidate) out.push({ postId: p.id, clientName: engagementOf(p.engagementId)?.clientName ?? "", title: p.title, engagementRate: j.engagementRate ?? null, accountAverageRate: j.accountAverageRate ?? null });
    }
    return out;
  }

  function list(params: URLSearchParams, userId: string): DemoResult {
    if (isClientContact(userId)) return err(403, NOT_AUTHORIZED);
    const status = params.get("status");
    if (status !== null && status !== "" && !scpBoostStatuses().includes(status)) return bad("invalid_field", "status");
    const engagementId = params.get("engagementId");
    if (engagementId !== null && engagementId !== "" && !ID.test(engagementId)) return bad("invalid_field", "engagementId");
    const cycleId = params.get("cycleId");
    if (cycleId !== null && cycleId !== "" && !ID.test(cycleId)) return bad("invalid_field", "cycleId");
    const limitRaw = params.get("limit");
    const limit = limitRaw === null || limitRaw === "" ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad("invalid_field", "limit");
    const cursor = params.get("cursor");
    const offset = cursor === null || cursor === "" ? 0 : /^o\d{1,6}$/.test(cursor) ? Number(cursor.slice(1)) : -1;
    if (offset < 0) return bad("invalid_field", "cursor");
    const rank = (s: string): number => ({ running: 0, requested: 1, approved: 2, stopped: 3 } as Record<string, number>)[s] ?? 4;
    const all = store.boosts
      .filter((b) => (!status || b.status === status) && (!engagementId || b.engagementId === engagementId) && (!cycleId || b.cycleId === cycleId))
      .sort((a, b) => rank(a.status) - rank(b.status) || b.startsOn.localeCompare(a.startsOn) || a.id.localeCompare(b.id));
    const page = all.slice(offset, offset + limit);
    return ok({
      items: page.map(rowOf),
      candidates: candidates().filter((c) => !engagementId || postById(c.postId as string)?.engagementId === engagementId),
      totals: { committedMinor: all.reduce((n, b) => n + contribution(b), 0), spendMinor: all.reduce((n, b) => n + (b.spendMinor ?? 0), 0), currency: CURRENCY },
      nextCursor: offset + limit < all.length ? `o${offset + limit}` : null,
    });
  }

  function estimate(postId: string, params: URLSearchParams, userId: string): DemoResult {
    const p = postById(postId);
    if (!p) return err(404, "post_not_found");
    if (isClientContact(userId)) return err(403, NOT_AUTHORIZED);
    const daily = params.get("dailyBudgetMinor");
    const days = params.get("days");
    const audience = params.get("audience");
    if (daily === null || daily === "") return bad("missing_field", "dailyBudgetMinor");
    if (!/^\d{1,12}$/.test(daily) || Number(daily) < 1) return bad("invalid_field", "dailyBudgetMinor");
    if (days === null || days === "") return bad("missing_field", "days");
    if (!/^\d{1,4}$/.test(days) || Number(days) < 1) return bad("invalid_field", "days");
    if (audience !== null && audience !== "" && !AUDIENCES.includes(audience)) return bad("invalid_field", "audience");
    const basis = p.simulated ? "simulated" : p.metrics ? "history" : "none";
    if (basis === "none") return ok({ reachLow: 0, reachHigh: 0, basis });
    const factor = audience === "local" ? 0.7 : audience === "custom" ? 0.5 : 1;
    const total = Number(daily) * Number(days);
    return ok({ reachLow: Math.round((total / 10_000) * 400 * factor), reachHigh: Math.round((total / 10_000) * 900 * factor), basis });
  }

  // ── a request ──
  function request(postId: string, raw: string | undefined, userId: string): DemoResult {
    const p = postById(postId);
    if (isClientContact(userId)) return err(403, "not_officer_or_approver");
    if (!p) return err(404, "post_not_found");
    if (!SEAT_APPROVERS.includes(userId) && userId !== officerOf(p.engagementId)) return err(403, "not_officer_or_approver");
    const b = parseBody(raw);
    if (isErr(b)) return b;
    if (!absent(b.id) && (typeof b.id !== "string" || !ID.test(b.id))) return bad("invalid_field", "id");
    if (absent(b.goal)) return bad("missing_field", "goal");
    if (typeof b.goal !== "string" || !GOALS.includes(b.goal)) return bad("invalid_field", "goal");
    if (absent(b.audience)) return bad("missing_field", "audience");
    if (typeof b.audience !== "string" || !AUDIENCES.includes(b.audience)) return bad("invalid_field", "audience");
    let audienceNote: string | null = null;
    if (!absent(b.audienceNote)) {
      if (typeof b.audienceNote !== "string" || [...b.audienceNote.trim()].length > AUDIENCE_NOTE_MAX) return bad("invalid_field", "audienceNote");
      audienceNote = b.audienceNote.trim() || null;
    }
    if (b.audience === "custom" && audienceNote === null) return bad("missing_field", "audienceNote");
    if (absent(b.dailyBudgetMinor)) return bad("missing_field", "dailyBudgetMinor");
    if (!whole(b.dailyBudgetMinor, 1, 1_000_000_000_000)) return bad("invalid_field", "dailyBudgetMinor");
    if (absent(b.days)) return bad("missing_field", "days");
    if (!whole(b.days, 1, 365)) return bad("invalid_field", "days");
    if (absent(b.startsOn)) return bad("missing_field", "startsOn");
    if (typeof b.startsOn !== "string" || !isIsoDate(b.startsOn)) return bad("invalid_field", "startsOn");
    if (!absent(b.currency) && (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency))) return bad("invalid_field", "currency");
    const currency = typeof b.currency === "string" ? b.currency : CURRENCY;
    const cycle = cycleFor(p.engagementId, b.startsOn.slice(0, 7));
    const cycleId = cycle?.id ?? null;

    // A replay of the same id is the same boost (no second row).
    if (typeof b.id === "string") {
      const same = store.boosts.find((x) => x.id === b.id && x.postId === postId);
      if (same) return ok({ boost: rowOf(same), remainingMinor: remaining(same.cycleId), needsClient: same.status === "requested", created: false });
    }
    // The fixture's guards, in its order: post_live, no_open_boost, currency_matches_budget.
    const guards = scpBoostAction("request_boost")!.guards.map((g) => g.refusal);
    if (p.pipelineStatus !== "live") return err(409, guards[0]);
    if (openBoostOf(postId)) return err(409, guards[1]);
    const agreed = cycleId ? agreedOf(cycleId) : null;
    if (agreed && agreed.currency !== currency) return err(409, guards[2]);

    const total = b.dailyBudgetMinor * b.days;
    const fits = total <= remaining(cycleId);
    const now = iso(Date.now());
    const rec: BoostRec = {
      id: typeof b.id === "string" ? b.id : `soc-boost-${++store.seq}`, postId, engagementId: p.engagementId, cycleId, status: fits ? "approved" : "requested", goal: b.goal, audience: b.audience, audienceNote,
      dailyBudgetMinor: b.dailyBudgetMinor, days: b.days, totalBudgetMinor: total, currency, startsOn: b.startsOn, approvedVia: fits ? "budget" : null, budgetId: fits ? agreed?.id ?? null : null,
      approvedAt: fits ? now : null, startedAt: null, endedAt: null, spendMinor: null, paidReach: null, clicks: null, reachEstimate: null, simulated: p.simulated, requestedBy: userId, requestedAt: now,
      channel: null, decisionNote: null,
    };
    const est = estimate(postId, new URLSearchParams({ dailyBudgetMinor: String(b.dailyBudgetMinor), days: String(b.days), audience: b.audience }), userId);
    const ej = est.status === 200 ? (est.json as { reachLow: number; reachHigh: number; basis: string }) : null;
    rec.reachEstimate = ej && ej.basis !== "none" ? { low: ej.reachLow, high: ej.reachHigh } : null;
    store.boosts.push(rec);
    return ok({ boost: rowOf(rec), remainingMinor: remaining(cycleId), needsClient: !fits, created: true }, 201);
  }

  // ── an action ──
  const RUN_ACTIONS = ["cancel_boost", "start_boost", "stop_boost", "complete_boost"];
  const RECORD_ACTIONS = ["record_boost_approval", "record_boost_decline"];

  function action(boostId: string, raw: string | undefined, userId: string): DemoResult {
    const rec = store.boosts.find((x) => x.id === boostId);
    if (isClientContact(userId)) return err(403, "not_officer_or_approver");
    if (!rec) return err(404, "boost_not_found");
    const b = parseBody(raw);
    if (isErr(b)) return b;
    const name = typeof b.action === "string" ? b.action : "";
    const isRun = RUN_ACTIONS.includes(name);
    const isRecord = RECORD_ACTIONS.includes(name);
    if (!isRun && !isRecord) return err(400, "unknown_action");
    // The role, before the body: the officer and the two seats run a boost; the four approvers record the client's answer.
    if (isRun && !SEAT_APPROVERS.includes(userId) && userId !== officerOf(rec.engagementId)) return err(403, "not_officer_or_approver");
    if (isRecord && !isDemoSocialApprover(userId)) return err(403, "not_a_social_approver");
    // The body: expectedStatus, then the action's own params.
    if (absent(b.expectedStatus)) return bad("missing_field", "expectedStatus");
    if (typeof b.expectedStatus !== "string" || !scpBoostStatuses().includes(b.expectedStatus)) return bad("invalid_field", "expectedStatus");
    if (!absent(b.actionId) && (typeof b.actionId !== "string" || !ID.test(b.actionId))) return bad("invalid_field", "actionId");
    // A replay of the last applied action is answered as it was, before the status is judged.
    if (typeof b.actionId === "string" && rec.lastActionId === b.actionId) return ok({ boost: rowOf(rec), remainingMinor: remaining(rec.cycleId), warnings: [], alreadyApplied: true });
    const count = (field: string, required: boolean): number | null | DemoResult => {
      const v = b[field];
      if (absent(v)) return required ? bad("missing_field", field) : null;
      return whole(v, 0, 2_147_483_647) ? v : bad("invalid_field", field);
    };
    let spend: number | null = null;
    let paidReach: number | null = null;
    let clicks: number | null = null;
    if (name === "stop_boost" || name === "complete_boost") {
      const s = count("spendMinor", true); if (isErr(s)) return s; spend = s;
      const pr = count("paidReach", name === "complete_boost"); if (isErr(pr)) return pr; paidReach = pr;
      const c = count("clicks", false); if (isErr(c)) return c; clicks = c;
    }
    let channel: string | null = null;
    let note: string | null = null;
    if (isRecord) {
      if (absent(b.channel)) return bad("missing_field", "channel");
      if (typeof b.channel !== "string" || !CHANNELS.includes(b.channel)) return bad("invalid_field", "channel");
      channel = b.channel;
      if (absent(b.note) || (typeof b.note === "string" && b.note.trim() === "")) return bad("missing_field", "note");
      const n = noteOf(b.note, NOTE_MAX); if (isErr(n)) return n; note = n;
    }
    // The guards: the page's picture of the status, then the fixture's `from` list (a record on a boost that is not waiting is `boost_not_waiting`).
    if (b.expectedStatus !== rec.status) return err(409, "boost_status_changed", { detail: { status: rec.status } });
    const spec = scpBoostAction(name)!;
    if (!spec.from.includes(rec.status)) return isRecord ? err(409, spec.guards[0].refusal, { detail: { status: rec.status } }) : err(409, "invalid_boost_transition", { detail: { status: rec.status } });

    const now = iso(Date.now());
    const warnings: string[] = [];
    switch (name) {
      case "cancel_boost": rec.status = "cancelled"; break;
      case "start_boost": rec.status = "running"; rec.startedAt = now; break;
      case "stop_boost": rec.status = "stopped"; rec.endedAt = now; rec.spendMinor = spend; rec.paidReach = paidReach; rec.clicks = clicks; break;
      case "complete_boost": rec.status = "completed"; rec.endedAt ??= now; rec.spendMinor = spend; rec.paidReach = paidReach; rec.clicks = clicks; break;
      case "record_boost_approval": rec.status = "approved"; rec.approvedVia = "recorded"; rec.approvedAt = now; rec.channel = channel; rec.decisionNote = note; break;
      case "record_boost_decline": rec.status = "declined"; rec.channel = channel; rec.decisionNote = note; break;
    }
    if ((name === "stop_boost" || name === "complete_boost") && spend !== null && spend > rec.totalBudgetMinor) warnings.push("spend_above_budget");
    if (typeof b.actionId === "string") rec.lastActionId = b.actionId;
    return ok({ boost: rowOf(rec), remainingMinor: remaining(rec.cycleId), warnings });
  }

  // ── the portal ──
  const clientMonthRows = () => store.budgets.filter((b) => clientOfEngagement(b.engagementId) === DEMO_PORTAL_CLIENT_ID);
  const portalBoosts = () => store.boosts.filter((b) => clientOfEngagement(b.engagementId) === DEMO_PORTAL_CLIENT_ID);

  function portalRead(userId: string): DemoResult {
    if (!isDemoPortalClient(userId)) return err(403, "not a portal client");
    const budgets = clientMonthRows().filter((b) => b.status === "pending").map((b) => {
      const month = cycleById(b.cycleId)?.month ?? "";
      return {
        proposalId: b.id, clientName: engagementOf(b.engagementId)?.clientName ?? "", month, amountMinor: b.amountMinor, agreedMinor: agreedOf(b.cycleId)?.amountMinor ?? null,
        committedMinor: committed(b.cycleId), currency: b.currency, minorUnit: MINOR_UNIT, note: b.note, requestedAt: b.requestedAt,
      };
    });
    const boosts = portalBoosts().filter((b) => b.status === "requested").map((b) => {
      const p = postById(b.postId);
      return {
        boostId: b.id, clientName: engagementOf(b.engagementId)?.clientName ?? "", postTitle: p?.title ?? "", thumbFileId: p && isPortalVisible(p) ? `${p.id}-f1` : null,
        totalBudgetMinor: b.totalBudgetMinor, days: b.days, startsOn: b.startsOn, currency: b.currency, minorUnit: MINOR_UNIT, remainingMinor: remaining(b.cycleId),
      };
    });
    const history = [
      ...clientMonthRows().filter((b) => b.status === "agreed" || b.status === "declined" || b.status === "superseded").map((b) => ({
        id: b.id, kind: "budget", title: `${monthTitle(cycleById(b.cycleId)?.month ?? "")} budget`, status: b.status, amountMinor: b.amountMinor, currency: b.currency, minorUnit: MINOR_UNIT, decidedAt: b.decidedAt,
      })),
      ...portalBoosts().filter((b) => b.status === "declined" || b.approvedVia === "portal" || b.approvedVia === "recorded").map((b) => ({
        id: b.id, kind: "boost", title: postById(b.postId)?.title ?? "A boost", status: b.status === "declined" ? "declined" : "approved", amountMinor: b.totalBudgetMinor, currency: b.currency, minorUnit: MINOR_UNIT, decidedAt: b.approvedAt,
      })),
    ].sort((x, y) => (y.decidedAt ?? "").localeCompare(x.decidedAt ?? "")).slice(0, 20);
    return ok({ budgets, boosts, history, canDecide: userId !== VIEWER });
  }

  function decisionBody(raw: string | undefined, allowed: [string, string]): { decision: string; note: string | null } | DemoResult {
    const b = parseBody(raw);
    if (isErr(b)) return b;
    if (typeof b.decision !== "string" || !allowed.includes(b.decision)) return bad(absent(b.decision) ? "missing_field" : "invalid_field", "decision");
    const note = noteOf(b.note, NOTE_MAX);
    if (isErr(note)) return note;
    return { decision: b.decision, note };
  }

  function decideBudget(proposalId: string, raw: string | undefined, userId: string): DemoResult {
    if (!isDemoPortalClient(userId)) return err(403, "not a portal client");
    const rec = clientMonthRows().find((x) => x.id === proposalId);
    if (!rec) return err(404, "proposal_not_found");
    if (userId === VIEWER) return err(403, "view_only");
    const d = decisionBody(raw, ["agree", "decline"]);
    if (isErr(d)) return d;
    const wanted: BudgetStatus = d.decision === "agree" ? "agreed" : "declined";
    if (rec.status !== "pending") return rec.status === wanted ? ok({ alreadyDecided: true }) : err(409, scpBudgetAction("agree_boost_budget")!.guards[0].refusal);
    if (d.decision === "agree" && rec.amountMinor < committed(rec.cycleId)) return err(409, scpBudgetAction("agree_boost_budget")!.guards[1].refusal, { detail: { committedMinor: committed(rec.cycleId), currency: rec.currency } });
    const now = iso(Date.now());
    if (d.decision === "agree") for (const x of store.budgets) if (x.cycleId === rec.cycleId && x.status === "agreed") { x.status = "superseded"; x.decidedAt ??= now; }
    rec.status = wanted;
    rec.decidedAt = now;
    rec.decidedBy = who(userId).name;
    if (d.decision === "agree") rec.via = "portal";
    if (d.note) rec.note = rec.note ? `${rec.note} Client: ${d.note}` : `Client: ${d.note}`;
    return ok({ proposalId: rec.id, status: rec.status });
  }

  function decideBoost(boostId: string, raw: string | undefined, userId: string): DemoResult {
    if (!isDemoPortalClient(userId)) return err(403, "not a portal client");
    const rec = portalBoosts().find((x) => x.id === boostId);
    if (!rec) return err(404, "boost_not_found");
    if (userId === VIEWER) return err(403, "view_only");
    const d = decisionBody(raw, ["approve", "decline"]);
    if (isErr(d)) return d;
    const wanted = d.decision === "approve" ? "approved" : "declined";
    if (rec.status !== "requested") {
      // A client's answer already stands: the same one is a replay, the other is a different decision. Anything else (cancelled, or approved within the budget) is not waiting.
      const approvedByClient = rec.approvedVia === "portal" || rec.approvedVia === "recorded";
      if (rec.status === "declined") return wanted === "declined" ? ok({ alreadyDecided: true }) : err(409, "boost_already_decided");
      if (approvedByClient) return wanted === "approved" ? ok({ alreadyDecided: true }) : err(409, "boost_already_decided");
      return err(409, scpBoostAction("approve_boost")!.guards[0].refusal);
    }
    const now = iso(Date.now());
    rec.status = wanted;
    if (wanted === "approved") { rec.approvedVia = "portal"; rec.approvedAt = now; }
    rec.decisionNote = d.note;
    return ok({ boost: { id: rec.id, status: rec.status } });
  }

  // ── the routers ──
  /** The staff routes of 63.11 by `tail` (the path after `modules/social/`); null for any other path or method (the caller falls through). */
  function staff(method: string, tail: string, params: URLSearchParams, body: string | undefined, userId: string): DemoResult | null {
    const m = method.toUpperCase();
    let x: RegExpExecArray | null;
    if ((x = /^cycles\/([^/]+)\/boost-budget$/.exec(tail))) return m === "GET" ? readBudget(decodeURIComponent(x[1]), userId) : null;
    if ((x = /^cycles\/([^/]+)\/boost-budget\/proposals$/.exec(tail))) return m === "POST" ? propose(decodeURIComponent(x[1]), body, userId) : null;
    if ((x = /^cycles\/([^/]+)\/boost-budget\/record$/.exec(tail))) return m === "POST" ? record(decodeURIComponent(x[1]), body, userId) : null;
    if ((x = /^boost-budget\/proposals\/([^/]+)\/withdraw$/.exec(tail))) return m === "POST" ? withdraw(decodeURIComponent(x[1]), userId) : null;
    if (tail === "boosts") return m === "GET" ? list(params, userId) : null;
    if ((x = /^posts\/([^/]+)\/boosts\/estimate$/.exec(tail))) return m === "GET" ? estimate(decodeURIComponent(x[1]), params, userId) : null;
    if ((x = /^posts\/([^/]+)\/boosts$/.exec(tail))) return m === "POST" ? request(decodeURIComponent(x[1]), body, userId) : null;
    if ((x = /^boosts\/([^/]+)\/actions$/.exec(tail))) return m === "POST" ? action(decodeURIComponent(x[1]), body, userId) : null;
    return null;
  }

  /** The portal routes of 63.11 by pathname; null for any other path or method. */
  function portal(method: string, pathname: string, body: string | undefined, userId: string): DemoResult | null {
    const m = method.toUpperCase();
    let x: RegExpExecArray | null;
    if (/^\/api\/[^/]+\/portal\/social\/spend$/.test(pathname)) return m === "GET" ? portalRead(userId) : null;
    if ((x = /^\/api\/[^/]+\/portal\/social\/spend\/budgets\/([^/]+)\/decide$/.exec(pathname))) return m === "POST" ? decideBudget(decodeURIComponent(x[1]), body, userId) : null;
    if ((x = /^\/api\/[^/]+\/portal\/social\/spend\/boosts\/([^/]+)\/decide$/.exec(pathname))) return m === "POST" ? decideBoost(decodeURIComponent(x[1]), body, userId) : null;
    return null;
  }

  return { staff, portal, rowOf, boostOfPost, budgetRead, committed, remaining, store };
}

// ── the demo's own store, pinned to globalThis like the other demo stores ─────────────────────────────────────────────────────
const KEY = Symbol.for("gaiada.demoSocial.boosts");
const demoStore: BoostStore = ((globalThis as Record<symbol, unknown>)[KEY] ??= seedBoostStore()) as BoostStore;
export const demoBoosts = boostApi(demoStore);
// The post read's `boost` (BFF §63.6.2) comes from this store: the pipeline twin asks for it by post id.
setDemoBoostReader((postId) => demoBoosts.boostOfPost(postId));

/** The staff routes of 63.11 by `tail`; null when `tail` is none of them. */
export const demoBoostsRoute = demoBoosts.staff;
/** The portal routes of 63.11 by pathname; null when it is none of them. */
export const demoPortalSpendRoute = demoBoosts.portal;
