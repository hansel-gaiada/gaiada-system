// SCP-1a — the client allocation's types and pure helpers (BFF §63.4 `GET allocation`, `PATCH engagements/:engagementId/allocation`). No
// server-only import, so a client component may import the values.
//
// Readers live in `lib/socialAllocation-data.ts` (server-only, `ReadResult`), the writes in `lib/socialAllocationActions.ts` ("use server").
// The answers are parsed defensively (`asAllocationRows`, `asAllocationRow`): a 200 with the wrong shape must read as "cannot tell", never as a
// plausible-looking empty list.
//
// WHO EDITS. `plan` on `social_engagement` is the four Social approvers' (the HoD and GM seats, the owner, the superadmin; PERMISSION §53.6). The
// server's `canPlan` on each row decides which controls are live; everyone else reads, with the reason on the disabled controls. The server's
// 403 `not_a_social_approver` is the boundary: this file only draws its answer.
import { PLAN_REFUSAL_REASON } from "./socialCycles";

export const ALLOCATION_NETWORKS = ["instagram", "facebook", "tiktok", "linkedin", "x", "youtube", "threads", "pinterest", "bluesky", "mastodon"] as const;
export const ALLOCATION_FORMATS = ["feed", "carousel", "reel", "story"] as const;
export const STEP_KEYS = ["proofread", "hod", "design", "final", "client", "schedule"] as const;
export type StepKey = (typeof STEP_KEYS)[number];
export type StepEstimates = Partial<Record<StepKey, number>>;

export const STEP_LABEL: Readonly<Record<StepKey, string>> = {
  proofread: "Proofread", hod: "HoD approval", design: "Design", final: "Final check", client: "Client approval", schedule: "Scheduling",
};
export const NETWORK_LABEL: Readonly<Record<string, string>> = {
  instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", linkedin: "LinkedIn", x: "X", youtube: "YouTube", threads: "Threads",
  pinterest: "Pinterest", bluesky: "Bluesky", mastodon: "Mastodon",
};
export const FORMAT_LABEL: Readonly<Record<string, string>> = { feed: "Feed", carousel: "Carousel", reel: "Reel", story: "Story" };
export const CREATIVE_SOURCE_LABEL = { creatives: "Creatives team", in_team: "In the team" } as const;
export const REPORT_FORMAT_LABEL = { email: "Email", meeting: "Meeting" } as const;

export type CreativeSource = keyof typeof CREATIVE_SOURCE_LABEL;
export type ReportFormat = keyof typeof REPORT_FORMAT_LABEL;

/** BFF §63.4's AllocationRow. */
export interface AllocationRow {
  engagementId: string;
  clientId: string;
  clientName: string;
  status: string;
  officer: { id: string; name: string } | null;
  postsPerCycle: number | null;
  creativeSource: CreativeSource;
  deliveryBatch: "A" | "B" | null;
  reportFormat: ReportFormat | null;
  reportDueDay: number | null;
  platforms: string[];
  formats: string[];
  defaultPostTime: string | null;
  stepEstimates: StepEstimates;
  thisCycle: { cycleId: string; month: string; target: number | null; counted: number; extra: number; stories: number } | null;
  canPlan: boolean;
}

/** The body of `PATCH engagements/:engagementId/allocation`: any subset of the editable fields (`officerId` sets the officer). */
export interface AllocationPatch {
  officerId?: string | null;
  postsPerCycle?: number | null;
  creativeSource?: CreativeSource;
  deliveryBatch?: "A" | "B" | null;
  reportFormat?: ReportFormat | null;
  reportDueDay?: number | null;
  platforms?: string[];
  formats?: string[];
  defaultPostTime?: string | null;
  stepEstimates?: StepEstimates;
}

// ── Parsing ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function asEstimates(raw: unknown): StepEstimates {
  const out: StepEstimates = {};
  if (!isObj(raw)) return out;
  for (const k of STEP_KEYS) {
    const v = raw[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 30) out[k] = v;
  }
  return out;
}

/** One allocation row. Throws on a body that is not one. */
export function asAllocationRow(raw: unknown): AllocationRow {
  if (!isObj(raw) || typeof raw.engagementId !== "string" || typeof raw.clientName !== "string") throw new Error("allocation: not a row");
  const officer = isObj(raw.officer) && typeof raw.officer.id === "string" ? { id: raw.officer.id, name: str(raw.officer.name) ?? "" } : null;
  const tc = isObj(raw.thisCycle) && typeof raw.thisCycle.cycleId === "string" ? raw.thisCycle : null;
  return {
    engagementId: raw.engagementId,
    clientId: str(raw.clientId) ?? "",
    clientName: raw.clientName,
    status: str(raw.status) ?? "",
    officer,
    postsPerCycle: num(raw.postsPerCycle),
    creativeSource: raw.creativeSource === "in_team" ? "in_team" : "creatives",
    deliveryBatch: raw.deliveryBatch === "A" || raw.deliveryBatch === "B" ? raw.deliveryBatch : null,
    reportFormat: raw.reportFormat === "email" || raw.reportFormat === "meeting" ? raw.reportFormat : null,
    reportDueDay: num(raw.reportDueDay),
    platforms: strings(raw.platforms),
    formats: strings(raw.formats),
    defaultPostTime: str(raw.defaultPostTime),
    stepEstimates: asEstimates(raw.stepEstimates),
    thisCycle: tc
      ? { cycleId: tc.cycleId as string, month: str(tc.month) ?? "", target: num(tc.target), counted: num(tc.counted) ?? 0, extra: num(tc.extra) ?? 0, stories: num(tc.stories) ?? 0 }
      : null,
    canPlan: raw.canPlan === true,
  };
}

/** `GET allocation`'s `{items}`. Throws on a body that is not one. */
export function asAllocationRows(raw: unknown): AllocationRow[] {
  if (!isObj(raw) || !Array.isArray(raw.items)) throw new Error("allocation: not a list");
  return raw.items.map(asAllocationRow);
}

// ── Words ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "8 of 12", or "8" with no target; the stories and extra posts that sit beside the target. */
export function cycleCountsText(r: AllocationRow): { main: string; beside: string | null } | null {
  const c = r.thisCycle;
  if (!c) return null;
  const main = r.postsPerCycle !== null ? `${c.counted} of ${r.postsPerCycle}` : String(c.counted);
  const beside = [
    c.extra > 0 ? `${c.extra} extra` : null,
    c.stories > 0 ? `${c.stories} ${c.stories === 1 ? "story" : "stories"}` : null,
  ].filter(Boolean).join(" · ");
  return { main, beside: beside || null };
}

/** The sentence for a refusal code of the allocation write (the token itself stays the contract; this is only the words). */
export function allocationRefusalText(code: string, field?: string): string {
  switch (code) {
    case "not_a_social_approver": return PLAN_REFUSAL_REASON;
    case "engagement_not_found": return "This client is no longer in the list. Reload the page and try again.";
    case "officer_not_member": return "The officer must be an active employee of this company.";
    case "unknown_field": return `The server did not recognise ${field ?? "a field"}.`;
    case "no_fields": return "Nothing to save.";
    case "invalid_field": {
      switch (field) {
        case "officerId": return "Choose an officer from the company's members.";
        case "postsPerCycle": return "The target is a whole number of posts from 0 to 200.";
        case "reportDueDay": return "The report day is a day of the month from 1 to 31.";
        case "defaultPostTime": return "The default time is a time of day, such as 09:30.";
        case "platforms": return "Choose from the ten supported networks.";
        case "formats": return "Choose from feed, carousel, reel and story.";
        case "stepEstimates": return "Each step estimate is a whole number of working days from 0 to 30.";
        default: return field ? `${field} is not valid.` : "A value is not valid.";
      }
    }
    default: return code;
  }
}

/** Client-side mirror of the server's rules for the fields typed as text; null means the value is fine. The server decides. */
export function estimateProblem(text: string): string | null {
  if (text.trim() === "") return null; // empty clears the step's estimate
  const n = Number(text);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? null : "A whole number of working days from 0 to 30.";
}
