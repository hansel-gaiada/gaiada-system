// SCP-1o (plan §11.1, BFF §63.16) — the DEMO_MODE store of the Social Media content pipeline: three INVENTED clients (Northwind Traders, a spa and a
// hotel brand) with allocations, brand books, cycles (last month, this month, next) and a month of posts across all twelve statuses and all six
// change cases. Nothing here is a real client, person or asset; the images are generated placeholders.
//
// It answers what `demoSocial.ts` routes to it: settings, cycles, health, allocation, brand book and `GET posts/:postId/pipeline` (the
// `PipelinePost` of §63.6.2). Every phase, holder, engine status, primary action and action-from-status comes from the fixture twin through
// `scpStageMachine.ts`; no status list or rule is retyped here. Health is FIXED mock values (no working-day maths: that is platform-nest's).
//
// The writes (`POST posts/:postId/actions`, the edit, suggestion, design and bulk routes) are answered by `demoSocialPipelineRun.ts` (SCP-1e), which mutates this store.
//
// Pinned to globalThis like the other demo stores (see "WHY THESE STORES ARE PINNED" in demoSocial.ts). Seeded once, from the day it is first touched;
// tests pin the clock to mid-month before importing it.
import { createHash } from "node:crypto";
import { todayIsoInDisplayZone } from "./format";
import type { BrandBook } from "./socialBrandBook";
import fixture from "./scpStageMachine.json";
import {
  scpActionsFromStatus, scpEngineStatusOf, scpHolderOf, scpPhaseOf, scpPrimaryActionOf, type ScpPostView,
} from "./scpStageMachine";

export interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });
const err = (status: number, error: string): DemoResult => ({ status, json: { error } });

// ── people ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const DEMO_PEOPLE: Record<string, string> = {
  "demo-hansel": "Clement Hansel", "u-pm": "Dewi Santoso", "u-dev": "Made Putra", "u-social": "Komang Lestari", "u-creative": "Putu Rani",
  "u-social-2": "Wayan Sudira", "u-copy": "Citra Maheswari", "u-social-design": "Kadek Surya", "u-gm": "Edward", "demo-owner": "Group Owner",
  "demo-client": "Dana Whitfield",
};
/** Who may be an officer: the company's members (`demoFixtures.ts` MEMBERS). */
export const DEMO_MEMBER_NAMES: Record<string, string> = {
  "demo-hansel": DEMO_PEOPLE["demo-hansel"], "u-pm": DEMO_PEOPLE["u-pm"], "u-dev": DEMO_PEOPLE["u-dev"], "u-social": DEMO_PEOPLE["u-social"],
  "u-creative": DEMO_PEOPLE["u-creative"], "u-social-2": DEMO_PEOPLE["u-social-2"], "u-copy": DEMO_PEOPLE["u-copy"],
  "u-social-design": DEMO_PEOPLE["u-social-design"], "u-gm": DEMO_PEOPLE["u-gm"],
};
export const COPYWRITER = "u-copy";
export const IN_TEAM_DESIGNER = "u-social-design";
export const CREATIVES_DESIGNER = "u-creative";
/** The four approvers (SCP-Q19): the HoD and GM seats, the owner and the superadmin. */
export const DEMO_SOCIAL_APPROVERS: readonly string[] = ["u-pm", "u-gm", "demo-owner", "demo-hansel"];
/** The HoD, the GM and the superadmin (its wildcard): the actors of `seat_approver`; the owner holds none of those steps. */
export const SEAT_APPROVERS: readonly string[] = ["u-pm", "u-gm", "demo-hansel"];
export const isDemoSocialApprover = (userId: string): boolean => DEMO_SOCIAL_APPROVERS.includes(userId);
export const isClientContact = (userId: string) => userId.startsWith("demo-client") || userId === "demo-two-company-client";
export const who = (id: string) => ({ id, name: DEMO_PEOPLE[id] ?? "A colleague" });

// ── dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const demoDow = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();
export const demoShift = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
/** Monday to Friday only (the demo has no holiday data of its own: its calendar is "known" only so the page shows a name). */
export const demoWeekdayOnOrBefore = (iso: string): string => { let d = iso; while (demoDow(d) === 0 || demoDow(d) === 6) d = demoShift(d, -1); return d; };
export const demoWalkBack = (iso: string, n: number): string => {
  let d = iso;
  for (let left = n; left > 0; ) { d = demoShift(d, -1); if (demoDow(d) !== 0 && demoDow(d) !== 6) left -= 1; }
  return d;
};
export const demoMonthShift = (month: string, delta: number): string => {
  const t = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
};
export const demoPrefill = (month: string, batch: "A" | "B"): string => {
  const prev = demoMonthShift(month, -1);
  return demoWeekdayOnOrBefore(batch === "A" ? `${prev}-15` : demoShift(`${month}-01`, -1));
};
/** `[min, max]` of a cycle's deadline for `month` (the `social_cycles` check). */
export const demoDeadlineRange = (month: string): { min: string; max: string } =>
  ({ min: `${demoMonthShift(month, -3)}-01`, max: demoShift(`${demoMonthShift(month, 1)}-01`, -1) });
export const demoRealDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

// ── types ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface PipeEngagement { id: string; clientId: string; clientName: string; name: string; status: string }
export interface DemoAllocation {
  officerId: string | null; postsPerCycle: number | null; creativeSource: "creatives" | "in_team"; deliveryBatch: "A" | "B" | null;
  reportFormat: "email" | "meeting" | null; reportDueDay: number | null; platforms: string[]; formats: string[]; defaultPostTime: string | null;
  stepEstimates: Record<string, number>;
}
export interface DemoBrandProfile {
  id: string; clientId: string; tone: Record<string, unknown>; hashtagStrategy: Record<string, unknown>; knowledgeSourceIds: string[];
  book: Omit<BrandBook, "toneSummary" | "hashtagSets">; updatedAt: string;
}
export interface DemoCycle { id: string; engagementId: string; month: string; deadline: string; readyBy: string }
export interface DemoCycleStore { bufferWorkingDays: number; boostCandidateFactor: number; cycles: DemoCycle[] }
type Format = "feed" | "carousel" | "reel" | "story";
export interface PipePost {
  id: string; engagementId: string; cycleId: string; cycleMonth: string; title: string; format: Format; pillar: string; angle: string; objective: string;
  keyMessage: string; caption: string; onAssetText: string; cta: string; hashtags: string[]; visualDirection: string;
  rawAssets: Array<{ url: string; label: string; source: string; aiNote: string | null }>; placement: string[]; scheduledAt: string | null;
  isExtra: boolean; mustHaves: string[];
  pipelineStatus: string; statusSince: string;
  changeBy: string | null; changeKind: string | null; returnTo: string | null; changeNote: string | null; changeCase: string | null;
  changedOnly: boolean; copyBefore: Record<string, unknown> | null;
  blockReason: string | null; blockWaitingOn: string | null; blockedFrom: string | null; blockedAt: string | null;
  creativeSource: "creatives" | "in_team" | null; creativeState: string | null; creativeRequestId: string | null;
  designs: Array<Record<string, unknown>>;
  suggestions: Record<string, { value: unknown; base: unknown; by: string; at: string }>;
  skippedChecks: Array<{ codes: string[]; reason: string; by: string; at: string }>;
  authorId: string | null; scheduleVia: "manual" | "publisher" | null; liveUrl: string | null; wentLiveAt: string | null; simulated: boolean;
  rescheduled: boolean; healthHint: "tight" | "at_risk" | null;
  /** SCP-1e: set by `archive` (the post leaves every list, the engine status reads archived); the id of the last applied action (the replay key, BFF §63.0). */
  archivedAt: string | null; lastActionId: string | null;
  metrics: { impressions: number; reach: number; likes: number; comments: number; shares: number; saves: number } | null;
  copyLog: Array<Record<string, unknown>>; history: Array<Record<string, unknown>>;
}
interface PipeStore {
  engagements: PipeEngagement[]; allocations: Record<string, DemoAllocation>; brands: Record<string, DemoBrandProfile>;
  cycleStore: DemoCycleStore; posts: PipePost[];
}

// ── placeholder images (generated, never an asset from anyone's prototype) ───────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
export function placeholderImage(label: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="hsl(${hue} 35% 82%)"/>` +
    `<text x="540" y="540" font-family="sans-serif" font-size="52" text-anchor="middle" fill="hsl(${hue} 30% 28%)">${esc(label)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ── the three clients ─────────────────────────────────────────────────────────────────────────────────────────────────────
const STORE = Symbol.for("gaiada.demoSocial.pipeline");
const EKEY = { n: "soc-eng-1", s: "soc-eng-3", h: "soc-eng-4" } as const;
type EK = keyof typeof EKEY;
const HUE: Record<EK, number> = { n: 210, s: 150, h: 30 };
const HANDLE: Record<EK, string> = { n: "northwindtraders", s: "saltmarshdayspa", h: "harborlighthotel" };

function buildStore(): PipeStore {
  const today = todayIsoInDisplayZone();
  const M = today.slice(0, 7);
  const mo = (k: number) => demoMonthShift(M, k);
  const engagements: PipeEngagement[] = [
    { id: EKEY.n, clientId: "cl-1", clientName: "Northwind Traders", name: "Northwind Traders — Organic Social", status: "active" },
    { id: EKEY.s, clientId: "cl-soc-spa", clientName: "Saltmarsh Day Spa", name: "Saltmarsh Day Spa — Organic Social", status: "active" },
    { id: EKEY.h, clientId: "cl-soc-hotel", clientName: "Harborlight Hotel", name: "Harborlight Hotel — Organic Social", status: "active" },
  ];
  const allocations: Record<string, DemoAllocation> = {
    [EKEY.n]: {
      officerId: "u-social", postsPerCycle: 12, creativeSource: "creatives", deliveryBatch: "B", reportFormat: "email", reportDueDay: 5,
      platforms: ["instagram", "facebook", "tiktok"], formats: ["feed", "reel", "story"], defaultPostTime: "09:30",
      stepEstimates: { proofread: 1, hod: 1, design: 3, final: 1, client: 2, schedule: 1 },
    },
    [EKEY.s]: {
      officerId: "u-social-2", postsPerCycle: 8, creativeSource: "in_team", deliveryBatch: "A", reportFormat: "meeting", reportDueDay: 10,
      platforms: ["instagram", "facebook"], formats: ["feed", "reel", "story"], defaultPostTime: "18:00",
      stepEstimates: { proofread: 1, hod: 1, design: 2, final: 1, client: 2, schedule: 1 },
    },
    [EKEY.h]: {
      officerId: "u-social", postsPerCycle: 10, creativeSource: "creatives", deliveryBatch: "B", reportFormat: "email", reportDueDay: 7,
      platforms: ["instagram", "facebook", "linkedin"], formats: ["feed", "carousel", "reel"], defaultPostTime: "12:00",
      stepEstimates: { proofread: 1, hod: 1, design: 4, final: 1, client: 3, schedule: 1 },
    },
  };
  const brands: Record<string, DemoBrandProfile> = {
    "cl-1": {
      id: "soc-brand-cl-1", clientId: "cl-1", tone: { summary: "Warm, direct and a little playful.", traits: ["warm", "direct"] },
      hashtagStrategy: { maxCount: 5, sets: [{ name: "Always", tags: ["northwind", "madewithcare"] }] }, knowledgeSourceIds: [],
      book: {
        contentPillars: ["Behind the scenes", "Product stories"], mustHaveNotes: ["Always tag the store"], brandRules: ["No discount wording"],
        channels: [{ network: "instagram", handle: HANDLE.n, url: "https://example.com/northwind" }],
        keyDates: [{ date: "12-24", label: "Holiday campaign ends" }], links: [{ label: "Brand guide", url: "https://example.com/northwind/brand" }],
      },
      updatedAt: "2026-09-01T09:00:00Z",
    },
    "cl-soc-spa": {
      id: "soc-brand-cl-soc-spa", clientId: "cl-soc-spa", tone: { summary: "Calm, unhurried and reassuring.", traits: ["calm", "kind"] },
      hashtagStrategy: { maxCount: 8, sets: [{ name: "Always", tags: ["saltmarsh", "slowdown"] }, { name: "Seasonal", tags: ["wintersoft", "warmthrituals"] }] },
      knowledgeSourceIds: [],
      book: {
        contentPillars: ["Rituals", "Therapist stories", "Seasonal menu"], mustHaveNotes: ["Show the booking line in every story", "Never promise health outcomes"],
        brandRules: ["No before and after photos", "Soft natural light only"],
        channels: [{ network: "instagram", handle: HANDLE.s, url: "https://example.com/saltmarsh" }, { network: "facebook", handle: "saltmarshdayspa" }],
        keyDates: [{ date: "03-08", label: "Women's day ritual" }, { date: "11-15", label: "Winter menu launch" }], links: [{ label: "Brand guide", url: "https://example.com/saltmarsh/brand" }],
      },
      updatedAt: "2026-09-12T09:00:00Z",
    },
    "cl-soc-hotel": {
      id: "soc-brand-cl-soc-hotel", clientId: "cl-soc-hotel", tone: { summary: "Polished, welcoming and a touch nautical.", traits: ["polished", "welcoming"] },
      hashtagStrategy: { maxCount: 10, sets: [{ name: "Always", tags: ["harborlight", "stayhere"] }, { name: "Dining", tags: ["harbourbrunch", "tableforfour"] }] },
      knowledgeSourceIds: [],
      book: {
        contentPillars: ["Rooms and views", "Dining", "Local guide"], mustHaveNotes: ["Credit the photographer when it is not us", "Mention the direct booking link"],
        brandRules: ["Never show competitor hotels", "Prices only with the terms line"],
        channels: [{ network: "instagram", handle: HANDLE.h, url: "https://example.com/harborlight" }, { network: "linkedin", handle: "harborlight-hotel" }],
        keyDates: [{ date: "12-31", label: "New year gala" }, { date: "06-21", label: "Midsummer dinner" }], links: [{ label: "Brand guide", url: "https://example.com/harborlight/brand" }],
      },
      updatedAt: "2026-09-20T09:00:00Z",
    },
  };
  const buffer = 1;
  const cycles: DemoCycle[] = [];
  for (const e of engagements) {
    for (const k of [-1, 0, 1]) {
      const month = mo(k);
      const deadline = demoPrefill(month, allocations[e.id].deliveryBatch ?? "B");
      cycles.push({ id: `soc-cyc-${e.id}-${month}`, engagementId: e.id, month, deadline, readyBy: demoWalkBack(deadline, buffer) });
    }
  }
  const cycleStore: DemoCycleStore = { bufferWorkingDays: buffer, boostCandidateFactor: 1.25, cycles };
  return { engagements, allocations, brands, cycleStore, posts: seedPosts(M, today, allocations) };
}

// ── the posts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
interface Seed {
  e: EK; m: -1 | 0 | 1; d: number; t: string; f: Format; st: string;
  pil?: number; ph?: string[]; extra?: boolean; cc?: string; note?: string; sch?: "manual" | "publisher"; cs?: string; sim?: boolean; co?: boolean;
  blk?: { from: string; on: string; reason: string }; sug?: "fresh" | "both"; resched?: boolean; ago?: number; hint?: "tight" | "at_risk"; ai?: boolean; metrics?: boolean;
}
const AGO: Record<string, number> = { planned: 1, drafting: 2, proofread: 2, hod: 3, design: 4, final: 2, client: 3, approved: 5, scheduled: 6, live: 8, changes: 2, blocked: 4 };
const CASES = (fixture as unknown as { changeCases: Array<{ key: string; changeBy: string; changeKind: string; returnTo: string }> }).changeCases;

// Per engagement, newest first inside each month: `n` Northwind, `s` the spa, `h` the hotel. Every row is one post of the demo.
const SEEDS: Seed[] = [
  // Northwind (creatives): last month all live, this month scheduled to with the client, next month at every early stage.
  { e: "n", m: -1, d: 3, t: "Harvest collection arrives", f: "feed", st: "live", pil: 1, sch: "manual", metrics: true },
  { e: "n", m: -1, d: 10, t: "A day in the warehouse", f: "reel", st: "live", pil: 0, sch: "publisher", metrics: true },
  { e: "n", m: -1, d: 12, t: "Open until late tonight", f: "story", st: "live", pil: 1, sch: "manual", metrics: true },
  { e: "n", m: -1, d: 17, t: "Reader favourite reshare", f: "feed", st: "live", pil: 1, extra: true, sch: "manual", metrics: true },
  { e: "n", m: 0, d: 20, t: "Autumn collection teaser", f: "feed", st: "scheduled", pil: 1, sch: "manual" },
  { e: "n", m: 0, d: 23, t: "Behind the scenes at the studio", f: "feed", st: "approved", pil: 0 },
  { e: "n", m: 0, d: 25, t: "Five ways to style a scarf", f: "carousel", st: "client", pil: 1 },
  { e: "n", m: 0, d: 27, t: "Launch day announcement", f: "feed", st: "changes", cc: "client_design", note: "Please make the product larger and move the logo to the top corner.", pil: 1 },
  { e: "n", m: 0, d: 28, t: "Meet the packing team", f: "reel", st: "scheduled", pil: 0, sch: "publisher" },
  { e: "n", m: 0, d: 24, t: "Weekend market date moved", f: "feed", st: "client", pil: 0, resched: true },
  { e: "n", m: 1, d: 4, t: "November kickoff", f: "feed", st: "planned", pil: 0 },
  { e: "n", m: 1, d: 6, t: "Gift guide for the host", f: "carousel", st: "drafting", pil: 1 },
  { e: "n", m: 1, d: 9, t: "Wool care in three steps", f: "feed", st: "proofread", pil: 1, sug: "both" },
  { e: "n", m: 1, d: 12, t: "Our first cold-weather drop", f: "feed", st: "hod", pil: 1, hint: "tight" },
  { e: "n", m: 1, d: 15, t: "Seasonal window display", f: "feed", st: "blocked", pil: 0, hint: "at_risk", blk: { from: "design", on: "client", reason: "Waiting for the product photos from the client." } },
  // Saltmarsh Day Spa (in-team designer): the next month's cycle is past its deadline, so its open posts are late with the designer.
  { e: "s", m: -1, d: 20, t: "Closing hours reminder", f: "story", st: "live", pil: 0, sch: "manual", metrics: true },
  { e: "s", m: 0, d: 2, t: "Sunday reset ritual", f: "feed", st: "live", pil: 0, sch: "manual", metrics: true },
  { e: "s", m: 0, d: 22, t: "Autumn body scrub", f: "reel", st: "scheduled", pil: 2, sch: "publisher" },
  { e: "s", m: 1, d: 5, t: "Winter warmth menu", f: "feed", st: "design", cs: "not_started", pil: 2 },
  { e: "s", m: 1, d: 8, t: "Hot stone, step by step", f: "carousel", st: "design", cs: "in_progress", pil: 0 },
  { e: "s", m: 1, d: 11, t: "Meet our senior therapist", f: "feed", st: "final", pil: 1 },
  { e: "s", m: 1, d: 13, t: "Ginger and clove tea", f: "feed", st: "changes", cc: "copywriter_copy", note: "The second sentence promises a result; please soften it.", sug: "fresh", pil: 2 },
  { e: "s", m: 1, d: 16, t: "Candlelit couples room", f: "feed", st: "changes", cc: "final_design", note: "The text sits on a bright patch; move it lower.", pil: 0 },
  // Harborlight Hotel (creatives): a simulated live post, client changes, hod and final copy changes.
  { e: "h", m: 0, d: 3, t: "Weekend brunch is back", f: "carousel", st: "live", pil: 1, sch: "publisher", sim: true, metrics: true },
  { e: "h", m: 0, d: 24, t: "Harbour view suite", f: "reel", st: "approved", pil: 0, ai: true },
  { e: "h", m: 0, d: 21, t: "Sunset terrace menu", f: "feed", st: "changes", cc: "client_copy", note: "Please say 'from five in the evening', not 'from dusk'.", co: true, pil: 1 },
  { e: "h", m: 1, d: 7, t: "Winter packages", f: "feed", st: "changes", cc: "hod_copy", note: "Add the terms line under the price.", pil: 0 },
  { e: "h", m: 1, d: 10, t: "The new lobby bar", f: "carousel", st: "changes", cc: "final_copy", note: "Hashtags are over the brand's limit; trim to eight.", pil: 1 },
  { e: "h", m: 1, d: 14, t: "Old harbour walk", f: "feed", st: "proofread", co: true, pil: 2 },
  { e: "h", m: 1, d: 18, t: "Staff pick of the week", f: "feed", st: "drafting", extra: true, pil: 0 },
  { e: "h", m: 1, d: 20, t: "Banquet room open day", f: "carousel", st: "design", cs: "in_progress", pil: 0 },
  { e: "h", m: 1, d: 22, t: "December at the harbour", f: "feed", st: "planned", pil: 2 },
];

const PATH: Array<[string, string, string]> = [
  ["planned", "start_draft", "drafting"], ["drafting", "send_to_proofread", "proofread"], ["proofread", "approve_copy", "hod"],
  ["hod", "approve_for_design", "design"], ["design", "submit_design", "final"], ["final", "final_approve", "client"],
  ["client", "record_client_approve", "approved"], ["approved", "schedule", "scheduled"], ["scheduled", "mark_live", "live"],
];
const STATUS_ORDER = ["planned", "drafting", "proofread", "hod", "design", "final", "client", "approved", "scheduled", "live"];
const ACTOR: Record<string, (o: string, designer: string) => string> = {
  approve_copy: () => COPYWRITER, return_copy: () => COPYWRITER, approve_for_design: () => "u-pm", final_approve: () => "u-pm", hod_changes: () => "u-pm",
  final_changes: () => "u-pm", schedule_publisher: () => "u-pm", submit_design: (_o, d) => d, start_design: (_o, d) => d,
};

function seedPosts(M: string, today: string, allocations: Record<string, DemoAllocation>): PipePost[] {
  const mo = (k: number) => demoMonthShift(M, k);
  const stamp = (daysAgo: number, hour: number) => `${demoShift(today, -daysAgo)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const counters: Record<string, number> = {};
  return SEEDS.map((s) => {
    const engId = EKEY[s.e];
    const a = allocations[engId];
    const officer = a.officerId ?? "u-social";
    const n = (counters[s.e] = (counters[s.e] ?? 0) + 1);
    const id = `soc-post-${s.e}-${n}`;
    const month = mo(s.m);
    const time = a.defaultPostTime ?? "09:00";
    const scheduledAt = `${month}-${String(s.d).padStart(2, "0")}T${time}:00.000Z`;
    const status = s.st;
    const rank = STATUS_ORDER.indexOf(status);
    const kase = s.cc ? CASES.find((c) => c.key === s.cc)! : null;
    const designer = a.creativeSource === "in_team" ? IN_TEAM_DESIGNER : CREATIVES_DESIGNER;
    // where the post got to before a side branch
    const base = s.resched ? "scheduled" : s.co && status === "proofread" ? "client"
      : kase ? (kase.returnTo === "proofread" && kase.changeBy === "client" ? "client" : kase.returnTo) : s.blk ? s.blk.from : null;
    const reached = base ?? status;
    const reachedRank = STATUS_ORDER.indexOf(reached);
    const hasDesign = reachedRank >= STATUS_ORDER.indexOf("design");
    const pastFinal = reachedRank >= STATUS_ORDER.indexOf("final");
    const stored = reachedRank > STATUS_ORDER.indexOf("final"); // `final_approve` materializes each design as a file (BFF §63.3.5)
    const creativeSource = hasDesign ? a.creativeSource : null;
    const creativeState = status === "design" ? (s.cs ?? "in_progress") : s.blk?.from === "design" ? "in_progress" : pastFinal || hasDesign ? (kase?.changeKind === "design" ? "revision" : "submitted") : null;
    const caption = `${s.t}: a short, true note from the team.`;
    const hashtags = s.e === "n" ? ["northwind", "madewithcare"] : s.e === "s" ? ["saltmarsh", "slowdown"] : ["harborlight", "stayhere"];
    const placement = status === "planned" ? [] : s.ph ?? (s.f === "story" || s.f === "reel" ? ["instagram"] : a.platforms.slice(0, 2));
    const withAssets = status !== "planned";
    const rawAssets = withAssets
      ? [{ url: placeholderImage(`Placeholder: ${s.t}`, HUE[s.e]), label: "Hero image", source: s.ai ? "ai" : "own", aiNote: s.ai ? "Sky generated by an image model; the text is set by hand." : null }]
      : [];
    const designs = hasDesign && (pastFinal || status === "design" || kase?.changeKind === "design")
      ? status === "design" && creativeState === "not_started" ? []
        : status === "design"
          ? [{ id: `${id}-d1`, position: 1, asset: null, link: { url: `https://example.com/drafts/${id}`, source: "own", aiNote: null }, fileId: null }]
          : [{ id: `${id}-d1`, position: 1, asset: { groupId: `${id}-g1`, versionId: `${id}-v1`, versionNo: 1, name: `${s.t} - final.png`, source: s.ai ? "ai" : "own", aiNote: s.ai ? "Sky generated by an image model; the text is set by hand." : null }, link: null, fileId: stored ? `${id}-f1` : null }]
      : [];
    // suggestions: fresh ones carry the field as it is now; a stale one carries the base it was made against
    const suggestions: PipePost["suggestions"] = {};
    if (s.sug) {
      suggestions.caption = { value: `${caption} Tell us what you think.`, base: caption, by: COPYWRITER, at: stamp(1, 9) };
      if (s.sug === "both") suggestions.cta = { value: "Book now", base: "an older call to action", by: COPYWRITER, at: stamp(1, 10) };
    }
    const cta = s.sug === "both" ? "Book your visit" : "Learn more";
    const blockedAt = s.blk ? stamp(s.ago ?? AGO.blocked, 11) : null;
    const copyBefore = s.co ? { caption: `${s.t}: the version the client saw.`, onAssetText: s.t, cta: "Learn more", hashtags } : null;
    const post: PipePost = {
      id, engagementId: engId, cycleId: `soc-cyc-${engId}-${month}`, cycleMonth: month, title: s.t, format: s.f,
      pillar: ["Behind the scenes", "Product stories", "Seasonal"][s.pil ?? 0], angle: status === "planned" ? "" : `An honest look at ${s.t.toLowerCase()}.`,
      objective: status === "planned" ? "" : "Warm reach with existing followers", keyMessage: status === "planned" ? "" : s.t,
      caption: status === "planned" ? "" : caption, onAssetText: status === "planned" || s.f === "reel" ? "" : s.t, cta: status === "planned" ? "" : cta,
      hashtags: status === "planned" ? [] : hashtags, visualDirection: status === "planned" ? "" : "Natural light, one clear subject, room for the text.",
      rawAssets, placement, scheduledAt, isExtra: !!s.extra,
      mustHaves: rank >= STATUS_ORDER.indexOf("hod") || kase || s.blk ? ["logo", "brand_colours", "brand_fonts", "contact_info", "handle_and_tags", "mandatory_words", "no_forbidden_claims", "price_terms_checked", "location_tag", "hashtag_set"] : [],
      pipelineStatus: status, statusSince: stamp(s.ago ?? AGO[status], 9),
      changeBy: kase?.changeBy ?? null, changeKind: kase?.changeKind ?? null, returnTo: kase?.returnTo ?? null, changeNote: s.note ?? null, changeCase: kase?.key ?? null,
      changedOnly: !!s.co, copyBefore,
      blockReason: s.blk?.reason ?? null, blockWaitingOn: s.blk?.on ?? null, blockedFrom: s.blk?.from ?? null, blockedAt,
      creativeSource, creativeState,
      creativeRequestId: creativeSource === "creatives" ? `soc-req-${engId}-${month}` : null,
      designs, suggestions,
      skippedChecks: s.e === "h" && s.m === 1 && status === "changes" && s.cc === "final_copy"
        ? [{ codes: ["too_many_hashtags"], reason: "The client asked for this tag set in writing.", by: officer, at: stamp(5, 10) }] : [],
      authorId: status === "planned" ? null : officer,
      scheduleVia: status === "scheduled" || status === "live" ? s.sch ?? "manual" : null,
      liveUrl: status === "live" ? `https://example.com/${HANDLE[s.e]}/p/${id}` : null,
      wentLiveAt: status === "live" ? scheduledAt : null, simulated: !!s.sim, rescheduled: !!s.resched, healthHint: s.hint ?? null, archivedAt: null, lastActionId: null,
      metrics: s.metrics ? { impressions: 4200 + n * 310, reach: 3100 + n * 220, likes: 380 + n * 21, comments: 24 + n, shares: 17 + n, saves: 52 + n * 3 } : null,
      copyLog: [], history: [],
    };
    // history: the route the post took, newest last
    const steps: Array<{ action: string; from: string | null; to: string }> = [{ action: "create", from: null, to: "planned" }];
    const target = base ?? status;
    for (const [from, action, to] of PATH) {
      if (STATUS_ORDER.indexOf(from) >= STATUS_ORDER.indexOf(target)) break;
      steps.push({ action: action === "schedule" && post.scheduleVia === "publisher" ? "schedule_publisher" : action, from, to });
      if (action === "approve_for_design" && hasDesign) steps.push({ action: "start_design", from: "design", to: "design" });
    }
    if (s.co && status === "proofread") {
      steps.push({ action: "record_client_change", from: "client", to: "changes" }, { action: "send_to_proofread", from: "changes", to: "proofread" });
    } else if (kase) {
      const set: Record<string, string> = { copywriter_copy: "return_copy", hod_copy: "hod_changes", final_copy: "final_changes", final_design: "final_changes", client_copy: "record_client_change", client_design: "record_client_change" };
      steps.push({ action: set[kase.key], from: reached, to: "changes" });
    } else if (s.blk) steps.push({ action: "block", from: s.blk.from, to: "blocked" });
    if (s.resched) steps.push({ action: "reschedule", from: "scheduled", to: "client" });
    post.history = steps.map((st, i) => {
      const portal = s.e === "n" && (st.action === "record_client_approve" || st.action === "record_client_change");
      const action = portal ? (st.action === "record_client_approve" ? "client_approve" : "client_change") : st.action;
      const by = portal ? "demo-client" : (ACTOR[st.action]?.(officer, designer) ?? officer);
      const recorded = !portal && (st.action === "record_client_approve" || st.action === "record_client_change") ? { channel: "email" } : null;
      return { action, from: st.from, to: st.to, by: who(by), agent: null, at: stamp(Math.max(0, (s.ago ?? AGO[status]) + (steps.length - 1 - i)), 9 + (i % 8)), recorded, viaPortal: portal };
    });
    // copy log: what the copywriter's suggestion and the officer's fixes changed
    if (rank >= STATUS_ORDER.indexOf("hod") || s.cc === "client_copy" || s.cc === "copywriter_copy") {
      post.copyLog.push({ field: "caption", before: `${s.t}: a first draft.`, after: caption, via: "suggestion", by: who(officer), suggestedBy: who(COPYWRITER), stage: "proofread", at: stamp((s.ago ?? AGO[status]) + 2, 15) });
    }
    if (s.cc && s.cc.endsWith("_copy")) {
      post.copyLog.push({ field: "cta", before: "Learn more", after: cta, via: "fix", by: who(officer), suggestedBy: null, stage: "changes", at: stamp(s.ago ?? AGO.changes, 16) });
    }
    return post;
  });
}

const store: PipeStore = ((globalThis as Record<symbol, unknown>)[STORE] ??= buildStore()) as PipeStore;
export const PIPE_ENGAGEMENTS = store.engagements;
export const allocStore = { byEngagement: store.allocations, brands: store.brands };
export const cyclesStore = store.cycleStore;
export const PIPE_POSTS = store.posts;
export const isPipelinePostId = (id: string): boolean => store.posts.some((p) => p.id === id);
export const pipelineEngagement = (id: string): PipeEngagement | undefined => store.engagements.find((e) => e.id === id && e.status !== "closed");

// ── health (FIXED mock values; the server's maths is platform-nest's `schedule-health.ts`) ──────────────────────────────────
const STATE_RANK: Record<string, number> = { done: 0, on_track: 1, tight: 2, at_risk: 3, late: 4 };
const view = (p: PipePost): ScpPostView => ({
  pipelineStatus: p.pipelineStatus, changeCase: p.changeCase, scheduleVia: p.scheduleVia, blockWaitingOn: p.blockWaitingOn, creativeState: p.creativeState,
});
const DONE = ["approved", "scheduled", "live"];
function holderRole(p: PipePost): string | null { return scpHolderOf(view(p)); }

export function demoPostHealth(p: PipePost): Record<string, unknown> {
  const cycle = cyclesStore.cycles.find((c) => c.id === p.cycleId);
  const readyBy = cycle?.readyBy ?? demoShift(todayIsoInDisplayZone(), 7);
  if (DONE.includes(p.pipelineStatus)) return { state: "done", spareDays: null, lateDays: null, lateWith: null, latestSafeHandoff: null, readyBy };
  if (readyBy < todayIsoInDisplayZone()) return { state: "late", spareDays: -3, lateDays: 2, lateWith: holderRole(p), latestSafeHandoff: demoWalkBack(readyBy, 1), readyBy };
  if (p.healthHint === "at_risk") return { state: "at_risk", spareDays: -1, lateDays: null, lateWith: null, latestSafeHandoff: demoWalkBack(readyBy, 1), readyBy };
  if (p.healthHint === "tight") return { state: "tight", spareDays: 0, lateDays: null, lateWith: null, latestSafeHandoff: readyBy, readyBy };
  return { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: readyBy, readyBy };
}
/** The client's state is the worst post state (§63.5); a cycle with no posts is on track. */
export function demoClientHealth(cycle: DemoCycle): Record<string, unknown> {
  const hs = store.posts.filter((p) => p.cycleId === cycle.id && !p.archivedAt).map(demoPostHealth);
  if (hs.length === 0) return { state: "on_track", spareDays: 3, lateDays: null, lateWith: null, latestSafeHandoff: cycle.readyBy, readyBy: cycle.readyBy };
  return hs.reduce((w, h) => (STATE_RANK[String(h.state)] > STATE_RANK[String(w.state)] ? h : w));
}

// ── counts ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function demoCycleCounts(cycleId: string): Record<string, number> {
  const c = { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 };
  for (const p of store.posts.filter((x) => x.cycleId === cycleId && !x.archivedAt)) {
    if (p.isExtra) { c.extra += 1; continue; }
    if (p.format === "story") { c.stories += 1; continue; }
    c.counted += 1;
    const phase = scpPhaseOf(view(p));
    if (phase === "brief") c.planned += 1;
    else if (phase === "in_production") c.inProduction += 1;
    else if (phase === "with_client") c.withClient += 1;
    else if (phase === "client_changes") c.clientChanges += 1;
    else if (phase === "posted") c.live += 1;
    else if (p.pipelineStatus === "approved") c.approved += 1;
    else c.scheduled += 1;
  }
  return c;
}

// ── settings, cycles, allocation, brand book ────────────────────────────────────────────────────────────────────────────
export const demoSettingsAnswer = (userId: string) => ({
  bufferWorkingDays: cyclesStore.bufferWorkingDays, boostCandidateFactor: cyclesStore.boostCandidateFactor,
  holidayCalendar: { known: true, name: "Demo public holidays" }, canPlan: isDemoSocialApprover(userId),
});
const officerOf = (engId: string) => { const o = store.allocations[engId]?.officerId ?? null; return o ? { id: o, name: DEMO_MEMBER_NAMES[o] ?? "" } : null; };
const ZERO = { counted: 0, planned: 0, inProduction: 0, withClient: 0, clientChanges: 0, approved: 0, scheduled: 0, live: 0, extra: 0, stories: 0 };

export function demoCycleTable(month: string, userId: string): Record<string, unknown> {
  const rows = store.engagements.filter((e) => e.status !== "closed").map((e) => {
    const a = store.allocations[e.id];
    const cycle = cyclesStore.cycles.find((c) => c.engagementId === e.id && c.month === month) ?? null;
    const batch = a.deliveryBatch;
    return {
      engagementId: e.id, clientName: e.clientName, officer: officerOf(e.id), deliveryBatch: batch,
      cycleId: cycle?.id ?? null, deadline: cycle?.deadline ?? null, readyBy: cycle?.readyBy ?? null,
      prefill: { deadline: batch ? demoPrefill(month, batch) : null, batch },
      target: a.postsPerCycle, counts: cycle ? demoCycleCounts(cycle.id) : { ...ZERO }, health: cycle ? demoClientHealth(cycle) : null,
    };
  });
  return { month, bufferWorkingDays: cyclesStore.bufferWorkingDays, holidaysKnown: true, canPlan: isDemoSocialApprover(userId), rows };
}

export function demoCycleHealth(cycleId: string): DemoResult {
  const cycle = cyclesStore.cycles.find((c) => c.id === cycleId);
  const eng = cycle ? store.engagements.find((e) => e.id === cycle.engagementId) : undefined;
  if (!cycle || !eng) return err(404, "cycle_not_found");
  return ok({
    cycleId: cycle.id, engagementId: eng.id, clientName: eng.clientName, month: cycle.month, deadline: cycle.deadline, readyBy: cycle.readyBy,
    today: todayIsoInDisplayZone(), bufferWorkingDays: cyclesStore.bufferWorkingDays, holidaysKnown: true,
    estimates: store.allocations[eng.id].stepEstimates, averageApprovalDays: null, clientSlower: false, client: demoClientHealth(cycle),
    posts: store.posts.filter((p) => p.cycleId === cycle.id && !p.archivedAt).map((p) => ({
      postId: p.id, title: p.title, status: p.pipelineStatus, phase: scpPhaseOf(view(p)), holder: holderRole(p), isExtra: p.isExtra, format: p.format, health: demoPostHealth(p),
    })),
  });
}

export function demoAllocationRow(e: PipeEngagement, userId: string): Record<string, unknown> {
  const a = store.allocations[e.id];
  const month = todayIsoInDisplayZone().slice(0, 7);
  const cycle = cyclesStore.cycles.find((c) => c.engagementId === e.id && c.month === month);
  const counts = cycle ? demoCycleCounts(cycle.id) : null;
  return {
    engagementId: e.id, clientId: e.clientId, clientName: e.clientName, status: e.status, officer: officerOf(e.id),
    postsPerCycle: a.postsPerCycle, creativeSource: a.creativeSource, deliveryBatch: a.deliveryBatch, reportFormat: a.reportFormat,
    reportDueDay: a.reportDueDay, platforms: a.platforms, formats: a.formats, defaultPostTime: a.defaultPostTime, stepEstimates: a.stepEstimates,
    thisCycle: cycle && counts ? { cycleId: cycle.id, month, target: a.postsPerCycle, counted: counts.counted, extra: counts.extra, stories: counts.stories } : null,
    canPlan: isDemoSocialApprover(userId),
  };
}

export function demoBrandAnswer(p: DemoBrandProfile): Record<string, unknown> {
  return {
    id: p.id, clientId: p.clientId, tone: p.tone, hashtagStrategy: p.hashtagStrategy, knowledgeSourceIds: p.knowledgeSourceIds, updatedAt: p.updatedAt,
    toneSummary: typeof p.tone.summary === "string" ? p.tone.summary : "",
    contentPillars: p.book.contentPillars, mustHaveNotes: p.book.mustHaveNotes, brandRules: p.book.brandRules,
    hashtagSets: Array.isArray(p.hashtagStrategy.sets) ? p.hashtagStrategy.sets : [],
    channels: p.book.channels, keyDates: p.book.keyDates, links: p.book.links,
  };
}

// ── the hand-off checks, as a read (§63.3.4) ──────────────────────────────────────────────────────────────────────────────
export function demoChecks(p: PipePost): Array<{ code: string; ok: boolean; message: string; skippable: boolean }> {
  const cycle = cyclesStore.cycles.find((c) => c.id === p.cycleId);
  const insta = p.placement.includes("instagram");
  const text = `${p.caption} ${p.hashtags.map((h) => `#${h}`).join(" ")}`;
  const c = (code: string, pass: boolean, message: string, skippable: boolean) => ({ code, ok: pass, message, skippable });
  return [
    c("format_missing", !!p.format, "Choose a format.", false),
    c("caption_missing", p.caption.trim() !== "", "Write the caption.", false),
    c("date_missing", p.scheduledAt !== null, "Pick a date and time.", false),
    c("placement_missing", p.placement.length > 0, "Place the post on at least one network.", false),
    c("must_haves_unticked", p.mustHaves.length === 10, "Tick all ten must-haves.", true),
    c("caption_too_long", !insta || text.length <= 2200, "The caption and hashtags are over Instagram's limit.", true),
    c("too_many_hashtags", !insta || p.hashtags.length <= 30, "Instagram takes at most 30 hashtags.", true),
    c("on_image_text_missing", !["feed", "carousel", "story"].includes(p.format) || p.onAssetText.trim() !== "", "Add the text on the image.", true),
    c("asset_link_missing", p.rawAssets.every((a) => a.url !== ""), "Every raw asset needs a link.", true),
    c("asset_source_unknown", p.rawAssets.every((a) => a.source !== "unknown"), "Say where each raw asset came from.", true),
    c("ai_note_missing", p.rawAssets.every((a) => a.source !== "ai" || !!a.aiNote), "An AI asset needs a note.", true),
    c("date_before_ready_by", !cycle || !p.scheduledAt || p.scheduledAt.slice(0, 10) >= cycle.readyBy, "The date is before the cycle's ready-by.", true),
  ];
}

// ── who may do what, for the demo persona (63.3.2 steps 6 and 7) ──────────────────────────────────────────────────────────
interface CerbosEntry { actors: unknown; refusal: string; makerChecker?: boolean }
const F = fixture as unknown as {
  cerbosActions: Record<string, CerbosEntry>;
  actions: Array<{ action: string; kind?: string; cerbosAction?: string | Record<string, string> }>;
};
/** Actions that are not `POST posts/:postId/actions` values: the create route, the edit and suggestion routes, the design routes and the portal's. */
const NOT_IN_ACTIONS = new Set(["create", "edit", "suggest", "add_design", "remove_design", "client_approve", "client_change", "client_undo"]);

export function cerbosAllows(key: string, userId: string, p: PipePost): boolean {
  const officer = store.allocations[p.engagementId]?.officerId ?? null;
  // PERMISSION §53.2: platform_admin keeps the house wildcard on every social_post action. Only the maker/checker DENY (applied before this, in
  // `demoPostActions`) beats it. The owner has no wildcard: it holds the approver-only actions alone (`approve`), via the cases below.
  if (userId === "demo-hansel") return true;
  switch (key) {
    case "author": case "schedule": return userId === officer;
    case "proofread": return userId === COPYWRITER;
    case "approve": return isDemoSocialApprover(userId);
    case "design": return userId === (p.creativeSource === "in_team" ? IN_TEAM_DESIGNER : CREATIVES_DESIGNER);
    case "manage": case "record_client": case "boost": return userId === officer || SEAT_APPROVERS.includes(userId);
    default: return false;
  }
}

export function demoPostActions(p: PipePost, userId: string): Array<{ action: string; allowed: boolean; reason?: string }> {
  const officer = store.allocations[p.engagementId]?.officerId ?? null;
  const listed = new Set(scpActionsFromStatus(view(p)));
  return F.actions.filter((a) => listed.has(a.action) && !NOT_IN_ACTIONS.has(a.action))
    .map((a) => {
      const raw = a.cerbosAction;
      const key = typeof raw === "string" ? raw : raw?.[p.scheduleVia ?? "manual"] ?? "approve";
      const entry = F.cerbosActions[key];
      // step 6: maker/checker runs before Cerbos, so the refusal names itself
      if (typeof raw === "string" && entry?.makerChecker && (userId === p.authorId || userId === officer)) return { action: a.action, allowed: false, reason: "author_cannot_approve" };
      if (!cerbosAllows(key, userId, p)) return { action: a.action, allowed: false, reason: entry?.refusal ?? "not_authorized" };
      return { action: a.action, allowed: true };
    });
}

// ── the PipelinePost read (§63.6.2) ───────────────────────────────────────────────────────────────────────────────────────
const ROLE_LABEL: Record<string, string> = { officer: "Officer", copywriter: "Copywriter", approver: "Approvers", designer: "Designer", client: "Client", publisher: "Publisher" };
function holderOf(p: PipePost): { role: string | null; userIds: string[]; label: string } {
  const role = holderRole(p);
  if (role === null) return { role: null, userIds: [], label: "Nobody" };
  const officer = store.allocations[p.engagementId]?.officerId ?? null;
  const userIds = role === "officer" ? (officer ? [officer] : [])
    : role === "copywriter" ? [COPYWRITER]
    : role === "approver" ? [...DEMO_SOCIAL_APPROVERS]
    : role === "designer" ? [p.creativeSource === "in_team" ? IN_TEAM_DESIGNER : CREATIVES_DESIGNER]
    : [];
  const label = userIds.length === 1 ? `${ROLE_LABEL[role] ?? role}: ${DEMO_PEOPLE[userIds[0]] ?? ""}` : ROLE_LABEL[role] ?? role;
  return { role, userIds, label };
}

function variantsOf(p: PipePost): Array<Record<string, unknown>> {
  const clientSeen = p.pipelineStatus === "client" || DONE.includes(p.pipelineStatus) || p.changeBy === "client" || p.changedOnly;
  if (!clientSeen) return [];
  const status = p.pipelineStatus === "live" ? "published" : p.pipelineStatus === "scheduled" ? "queued" : p.pipelineStatus === "approved" ? "approved" : p.pipelineStatus === "client" ? "in_review" : "draft";
  const review = p.pipelineStatus === "client" ? "pending" : DONE.includes(p.pipelineStatus) ? "approved" : p.changeBy === "client" ? "changes_requested" : "not_requested";
  const key = (Object.keys(EKEY) as EK[]).find((k) => EKEY[k] === p.engagementId) ?? "n";
  return p.placement.map((network) => ({
    id: `${p.id}-v-${network}`, network, handle: HANDLE[key], status, reviewStatus: review, validation: { ok: true, errors: [], warnings: [] },
  }));
}

export function demoPipelinePost(p: PipePost, userId: string): Record<string, unknown> {
  const eng = store.engagements.find((e) => e.id === p.engagementId)!;
  const alloc = store.allocations[p.engagementId];
  const v = view(p);
  const variants = variantsOf(p);
  const approved = DONE.includes(p.pipelineStatus) && !p.rescheduled;
  const approvedSchedule = approved ? { scheduledAt: p.scheduledAt, placement: p.placement } : null;
  const sent = p.pipelineStatus === "client" || DONE.includes(p.pipelineStatus) || p.changeBy === "client" || p.changedOnly;
  const reviewHash = sent
    ? createHash("sha256").update(variants.map((x) => `${String(x.id)}:${createHash("sha256").update(`${p.caption}|${p.scheduledAt}|${String(x.network)}`).digest("hex")}`).sort().join("\n")).digest("hex")
    : null;
  const actions = demoPostActions(p, userId);
  const primary = scpPrimaryActionOf(v);
  const nextAction = primary && actions.some((a) => a.action === primary && a.allowed) ? primary : null;
  const stale = (field: string, s: { base: unknown }) => {
    const cur = field === "hashtags" ? p.hashtags : field === "onAssetText" ? p.onAssetText : field === "cta" ? p.cta : p.caption;
    return JSON.stringify(cur) !== JSON.stringify(s.base);
  };
  const suggestions: Record<string, unknown> = {};
  for (const [field, s] of Object.entries(p.suggestions)) suggestions[field] = { value: s.value, base: s.base, stale: stale(field, s), by: who(s.by), at: s.at };
  return {
    id: p.id, engagementId: p.engagementId, clientId: eng.clientId, clientName: eng.clientName, cycleId: p.cycleId, cycleMonth: p.cycleMonth,
    title: p.title, format: p.format, pillar: p.pillar, angle: p.angle, objective: p.objective, keyMessage: p.keyMessage, caption: p.caption,
    onAssetText: p.onAssetText, cta: p.cta, hashtags: p.hashtags, visualDirection: p.visualDirection, rawAssets: p.rawAssets, placement: p.placement,
    scheduledAt: p.scheduledAt, isExtra: p.isExtra, isStory: p.format === "story", mustHaves: p.mustHaves,
    pipelineStatus: p.pipelineStatus, phase: scpPhaseOf(v), statusSince: p.statusSince,
    engineStatus: scpEngineStatusOf(v, variants.map((x) => String(x.status)), !!p.archivedAt),
    change: p.changeBy ? { by: p.changeBy, kind: p.changeKind, returnTo: p.returnTo, note: p.changeNote, case: p.changeCase } : null,
    changedOnly: p.changedOnly, copyBefore: p.copyBefore,
    block: p.blockedFrom ? { reason: p.blockReason, waitingOn: p.blockWaitingOn, from: p.blockedFrom, at: p.blockedAt } : null,
    creativeSource: p.creativeSource, creativeState: p.creativeState,
    creativeRequest: p.creativeRequestId ? { id: p.creativeRequestId, title: `${eng.clientName} · ${p.cycleMonth} content month`, status: "open" } : null,
    designs: p.designs, suggestions,
    checks: demoChecks(p), skippedChecks: p.skippedChecks.map((s) => ({ codes: s.codes, reason: s.reason, by: who(s.by), at: s.at })),
    officer: alloc.officerId ? who(alloc.officerId) : null, author: p.authorId ? who(p.authorId) : null,
    holder: holderOf(p), health: demoPostHealth(p), variants, approvedSchedule, scheduleVia: p.scheduleVia, reviewHash,
    liveUrl: p.liveUrl, wentLiveAt: p.wentLiveAt, simulated: p.simulated, archivedAt: p.archivedAt,
    boost: null, tasks: [], copyLog: p.copyLog, history: p.history, actions, nextAction,
  };
}

/** `GET posts/:postId/pipeline`. 403 for a client contact (the portal has its own routes); 404 `post_not_found`. */
export function demoPipelineRead(postId: string, userId: string): DemoResult {
  if (isClientContact(userId)) return err(403, "not authorized: social_post read");
  const p = store.posts.find((x) => x.id === postId);
  return p ? ok(demoPipelinePost(p, userId)) : err(404, "post_not_found");
}

/** The live post's metrics (the store holds them; the §63.6.2 read has no metrics field, the Boosting and report tickets read them). */
export const demoPipelineMetrics = (postId: string) => store.posts.find((p) => p.id === postId)?.metrics ?? null;
