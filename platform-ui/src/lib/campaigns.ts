// DW-5b: shared campaigns and their parts (docs/FRONTEND-BFF-CONTRACT.md §31). Pure types and helpers,
// client-safe: the readers live in `campaigns-data.ts` (server-only), the writes in `campaignActions.ts`.
//
// Money rule (§31.3, plan trap 6): the server does every sum. This file formats the minor-unit integers it is
// handed and never adds or subtracts them. The one conversion it owns is the TYPED amount a person enters, from
// major units ("1,250.50") to minor units (125050), done on the decimal string so no float is ever involved.
import { formatBudget, isZeroDecimal } from "./format";

// ── vocabulary ───────────────────────────────────────────────────────────────────────────────────

export const PART_STATUSES = ["planned", "active", "blocked", "done", "cancelled"] as const;
export type PartStatus = (typeof PART_STATUSES)[number];

export const CAMPAIGN_STATUSES = ["active", "paused", "completed"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export type LinkKind = "search_campaign" | "social_campaign";
export type LinkAccess = "ok" | "module_off" | "forbidden";

// ── shapes (§31.4) ───────────────────────────────────────────────────────────────────────────────

/** A row of `GET campaigns?unitId=<dept>`: the campaign, and this department's part in it (null = it only leads). */
export interface DeptCampaignRow {
  id: string;
  name: string;
  status: string;
  projectId: string | null;
  clientId: string | null;
  leadUnitId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  partCount: number;
  part: { id: string; status: string; ownerId: string | null; ownerName: string | null; dueOn: string | null } | null;
}

export interface CampaignMoney {
  budgetMinor: number | null;
  currency: string | null;
  allocatedMinor: number;
  /** Null when the campaign has no budget. Computed by the server; never derived here. */
  unallocatedMinor: number | null;
}

export interface LinkedSearchCampaign { id: string; name: string; status: string; budgetMinor: number | null; currency: string | null }
export interface LinkedSocialCampaign { id: string; name: string; status: string }
export interface PartRequests { open: number; delivered: number; declined: number }

export interface CampaignPart {
  id: string;
  unitId: string;
  /** Null when the unit has left the org chart: `unitMissing` is then true. */
  unitName: string | null;
  unitMissing: boolean;
  ownerId: string | null;
  ownerName: string | null;
  status: string;
  brief: string;
  dueOn: string | null;
  budgetMinor: number | null;
  links: { searchCampaigns: LinkedSearchCampaign[]; socialCampaigns: LinkedSocialCampaign[] };
  requests: PartRequests;
}

export interface CampaignDetail {
  id: string;
  name: string;
  status: string;
  projectId: string | null;
  clientId: string | null;
  leadUnitId: string | null;
  leadUnitName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  money: CampaignMoney;
  parts: CampaignPart[];
  linkAccess: { searchCampaigns: LinkAccess; socialCampaigns: LinkAccess };
}

// ── normalising what the wire sends (defensive: a wrong shape must not crash the page) ────────────

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const access = (v: unknown): LinkAccess => (v === "module_off" || v === "forbidden" ? v : "ok");

export function normalizeDeptCampaignRow(raw: unknown): DeptCampaignRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const p = r.part && typeof r.part === "object" ? (r.part as Record<string, unknown>) : null;
  const partId = p ? str(p.id) : null;
  return {
    id,
    name: str(r.name) ?? "(unnamed)",
    status: str(r.status) ?? "",
    projectId: str(r.project_id) ?? str(r.projectId),
    clientId: str(r.clientId),
    leadUnitId: str(r.leadUnitId),
    startsOn: str(r.startsOn),
    endsOn: str(r.endsOn),
    partCount: typeof r.partCount === "number" ? r.partCount : 0,
    part: p && partId
      ? { id: partId, status: str(p.status) ?? "planned", ownerId: str(p.ownerId), ownerName: str(p.ownerName), dueOn: str(p.dueOn) }
      : null,
  };
}

export function normalizeCampaignDetail(raw: unknown): CampaignDetail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const m = (r.money && typeof r.money === "object" ? r.money : {}) as Record<string, unknown>;
  const la = (r.linkAccess && typeof r.linkAccess === "object" ? r.linkAccess : {}) as Record<string, unknown>;
  return {
    id,
    name: str(r.name) ?? "(unnamed)",
    status: str(r.status) ?? "",
    projectId: str(r.projectId),
    clientId: str(r.clientId),
    leadUnitId: str(r.leadUnitId),
    leadUnitName: str(r.leadUnitName),
    startsOn: str(r.startsOn),
    endsOn: str(r.endsOn),
    money: {
      budgetMinor: numOrNull(m.budgetMinor),
      currency: str(m.currency),
      allocatedMinor: numOrNull(m.allocatedMinor) ?? 0,
      unallocatedMinor: numOrNull(m.unallocatedMinor),
    },
    parts: arr<Record<string, unknown>>(r.parts).flatMap((p): CampaignPart[] => {
      const pid = str(p.id);
      if (!pid) return [];
      const links = (p.links && typeof p.links === "object" ? p.links : {}) as Record<string, unknown>;
      const rq = (p.requests && typeof p.requests === "object" ? p.requests : {}) as Record<string, unknown>;
      return [{
        id: pid,
        unitId: str(p.unitId) ?? "",
        unitName: str(p.unitName),
        unitMissing: p.unitMissing === true,
        ownerId: str(p.ownerId),
        ownerName: str(p.ownerName),
        status: str(p.status) ?? "planned",
        brief: str(p.brief) ?? "",
        dueOn: str(p.dueOn),
        budgetMinor: numOrNull(p.budgetMinor),
        links: {
          searchCampaigns: arr<LinkedSearchCampaign>(links.searchCampaigns),
          socialCampaigns: arr<LinkedSocialCampaign>(links.socialCampaigns),
        },
        requests: {
          open: numOrNull(rq.open) ?? 0,
          delivered: numOrNull(rq.delivered) ?? 0,
          declined: numOrNull(rq.declined) ?? 0,
        },
      }];
    }),
    linkAccess: { searchCampaigns: access(la.searchCampaigns), socialCampaigns: access(la.socialCampaigns) },
  };
}

// ── money display and entry ──────────────────────────────────────────────────────────────────────

/** One server-supplied minor-unit figure as text. Without a currency there is no honest symbol, so say so. */
export function moneyText(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null) return "—";
  if (!currency) return `${minor} minor units`;
  return formatBudget(minor, currency);
}

export interface MoneyView { budget: string; allocated: string; unallocated: string; hasBudget: boolean }

/** The campaign's money block, every figure as the server returned it. Nothing is added or subtracted. */
export function moneyView(m: CampaignMoney): MoneyView {
  const hasBudget = m.budgetMinor !== null && m.currency !== null;
  return {
    hasBudget,
    budget: hasBudget ? moneyText(m.budgetMinor, m.currency) : "No budget set",
    allocated: m.allocatedMinor === 0 && !m.currency ? "None allocated" : moneyText(m.allocatedMinor, m.currency),
    unallocated: m.unallocatedMinor === null ? "Not applicable until a budget is set" : moneyText(m.unallocatedMinor, m.currency),
  };
}

/** A part's allocation. A cancelled part keeps its figure but no longer counts (§31.3 rule 6); say so. */
export function allocationText(part: Pick<CampaignPart, "budgetMinor" | "status">, currency: string | null): string {
  if (part.budgetMinor === null) return "No allocation";
  const text = moneyText(part.budgetMinor, currency);
  return part.status === "cancelled" ? `${text} (released: the part is cancelled)` : text;
}

export type MoneyInput = { ok: true; minor: number | null } | { ok: false; error: string };

/**
 * An amount a person typed, in MAJOR units, to the integer minor units the API takes. Blank means "none"
 * (`minor: null`). Pure string work: "1,250.5" in USD is 125050, "1500000" in IDR is 1500000; more decimals than the
 * currency has, a sign, letters and anything beyond a safe integer are refused rather than rounded.
 */
export function parseMoneyInput(text: string, currency: string | null | undefined): MoneyInput {
  const t = text.trim().replace(/,/g, "");
  if (t === "") return { ok: true, minor: null };
  const m = /^(\d+)(?:\.(\d*))?$/.exec(t);
  if (!m) return { ok: false, error: "Enter the amount as a plain number, for example 1250.50." };
  const digits = isZeroDecimal(currency) ? 0 : 2;
  const frac = m[2] ?? "";
  if (frac.length > digits && /[1-9]/.test(frac.slice(digits))) {
    return { ok: false, error: digits === 0 ? "This currency has no decimals." : "An amount has at most two decimals." };
  }
  const minorText = `${m[1]}${frac.slice(0, digits).padEnd(digits, "0")}`.replace(/^0+(?=\d)/, "");
  const minor = Number(minorText);
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "That amount is too large." };
  return { ok: true, minor };
}

/** Minor units back to the text a person edits, in major units ("125050" in USD is "1250.50"). */
export function majorText(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null) return "";
  if (isZeroDecimal(currency)) return String(minor);
  const whole = Math.floor(minor / 100);
  const cents = String(minor % 100).padStart(2, "0");
  return `${whole}.${cents}`;
}

/** The currency a person typed, upper-cased, or an error. Blank means "none". */
export function parseCurrencyInput(text: string): { ok: true; currency: string | null } | { ok: false; error: string } {
  const t = text.trim().toUpperCase();
  if (t === "") return { ok: true, currency: null };
  if (!/^[A-Z]{3}$/.test(t)) return { ok: false, error: "A currency is a three-letter code, for example USD." };
  return { ok: true, currency: t };
}

// ── words for the page ───────────────────────────────────────────────────────────────────────────

export function requestsText(r: PartRequests): string {
  if (r.open + r.delivered + r.declined === 0) return "No requests";
  return `${r.open} open, ${r.delivered} delivered, ${r.declined} declined`;
}

export const LINK_KIND_LABEL: Record<LinkKind, { plural: string; module: string }> = {
  search_campaign: { plural: "SEO campaigns", module: "SEO" },
  social_campaign: { plural: "Social campaigns", module: "Social Media" },
};

/** What to say instead of a list when the list cannot be shown. Null when the list is genuine (`ok`). */
export function linkAccessNote(kind: LinkKind, a: LinkAccess): string | null {
  if (a === "forbidden") return `You cannot see ${LINK_KIND_LABEL[kind].plural}.`;
  if (a === "module_off") return `The ${LINK_KIND_LABEL[kind].module} module is off for this company.`;
  return null;
}

/** "Lead" labelling: a null lead is the company or the Office of the GM (§31.1). */
export function leadText(leadUnitId: string | null, leadUnitName: string | null): string {
  if (leadUnitId === null) return "Office of the GM (or the company)";
  return leadUnitName ?? "A department that is no longer in the org chart";
}

export function partUnitText(p: Pick<CampaignPart, "unitName" | "unitMissing">): string {
  return p.unitMissing || !p.unitName ? "A department that is no longer in the org chart" : p.unitName;
}

// ── who is offered the edit controls (cosmetic: the server decides) ──────────────────────────────

/** Status, owner, brief and due date (§31.2 `update`): managers, the part's owner, the department head. */
export function canEditPart(a: { canManage: boolean; meId: string; ownerId: string | null; isHead: boolean }): boolean {
  return a.canManage || a.isHead || (a.ownerId !== null && a.ownerId === a.meId);
}

// ── the Social campaigns screen ──────────────────────────────────────────────────────────────────

export interface OurPartChoice { campaignId: string; campaignName: string; partId: string; partStatus: string }

/** The shared campaigns where THIS department has a part: the only ones a social campaign can be linked into. */
export function ourPartChoices(rows: readonly DeptCampaignRow[]): OurPartChoice[] {
  return rows.flatMap((r) => (r.part ? [{ campaignId: r.id, campaignName: r.name, partId: r.part.id, partStatus: r.part.status }] : []));
}

export interface SocialLinkRef { sharedCampaignId: string; sharedCampaignName: string; partId: string }

/** social campaign id -> the shared campaign (and our part) it is linked into, read from the details of the shared
 *  campaigns this department has a part in. Only this department's own part counts. */
export function socialLinkIndex(details: readonly CampaignDetail[], unitId: string): Map<string, SocialLinkRef> {
  const out = new Map<string, SocialLinkRef>();
  for (const d of details) {
    for (const p of d.parts) {
      if (p.unitId !== unitId) continue;
      for (const s of p.links.socialCampaigns) out.set(s.id, { sharedCampaignId: d.id, sharedCampaignName: d.name, partId: p.id });
    }
  }
  return out;
}

// ── refusals, in words ───────────────────────────────────────────────────────────────────────────

export interface WriteRefusal {
  status: number | null;
  /** The machine code (`allocation_exceeds_budget`, ...). Prose in `message` is free to change; branch on this. */
  reason?: string;
  message: string;
  /** The figures that explain a money refusal (`PlatformError.body.detail`). */
  detail?: Record<string, unknown>;
}

const fig = (v: unknown, currency: string | null | undefined): string => (typeof v === "number" ? moneyText(v, currency) : "an unknown amount");

/** Typed refusals from the §31.4 writes as plain sentences. Money figures are the server's, formatted, never summed. */
export function campaignErrorText(r: WriteRefusal, currency?: string | null): string {
  const d = r.detail ?? {};
  switch (r.reason) {
    case "allocation_exceeds_budget":
      return `That allocation would take the parts' allocations above the campaign budget. Budget: ${fig(d.budgetMinor, currency)}. Already allocated to the other parts: ${fig(d.allocatedMinor, currency)}. You asked for: ${fig(d.requestedMinor, currency)}.`;
    case "budget_below_allocations":
      return d.budgetMinor === null || d.budgetMinor === undefined
        ? `The budget cannot be cleared while parts hold allocations. Allocated to the parts: ${fig(d.allocatedMinor, currency)}.`
        : `The budget cannot be lowered below what the parts hold. The new budget would be ${fig(d.budgetMinor, currency)}; allocated to the parts: ${fig(d.allocatedMinor, currency)}.`;
    case "currency_locked_by_allocations":
      return `The currency cannot change while parts hold allocations (${fig(d.allocatedMinor, typeof d.currency === "string" ? d.currency : currency)} allocated). Remove those allocations first, or cancel the parts that hold them.`;
    case "campaign_has_no_budget":
      return "This campaign has no budget and currency yet. Set them on the campaign before allocating money to a part.";
    case "part_exists":
      return "That department already has a part in this campaign.";
    case "part_has_links":
      return "This part still has work linked to it (a department campaign or a request). Cancel the part instead, or unlink the work first.";
    case "already_linked":
      return "That campaign is already linked to a part. Unlink it there first.";
    case "owner_invalid":
      return "The owner must be an active member of this company.";
    case "unit_invalid":
      return "That is not a department of this company's org chart.";
    case "part_changed":
      return "The part changed while you were saving. Reload the page and try again.";
    case "part_not_found":
      return "That part no longer exists. Reload the page.";
    case "campaign_not_found":
      return "That campaign no longer exists.";
    case "link_not_found":
      return "That link no longer exists. Reload the page.";
    case "link_target_invalid":
      return "That campaign cannot be linked: it is missing or belongs to another company.";
    case "link_kind_unavailable":
      return "That kind of campaign cannot be linked because its module is off for this company.";
    case "budget_invalid":
      return "The amount must be a whole number of minor units, zero or more.";
    case "currency_invalid":
      return "A currency is a three-letter code, for example USD.";
    case "date_invalid":
      return "Enter a real calendar date.";
    case "dates_invalid":
      return "The end date cannot be before the start date.";
    case "brief_too_long":
      return "The brief is too long (4,000 characters at most).";
    case "name_invalid":
      return "A name is 1 to 200 characters.";
    case "status_invalid":
      return "That status is not one this campaign can take.";
    case "nothing_to_update":
      return "Nothing was changed.";
    default:
      break;
  }
  if (r.status === 403) return "You do not have permission to do that.";
  if (r.status === 404) return "That campaign or part no longer exists. Reload the page.";
  return r.message || "That did not work. Try again.";
}

/** Same sentences for a 400/409 whose figures matter but arrive only on `PlatformError.body`. */
export function detailOf(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const d = (body as { detail?: unknown }).detail;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
}

/** The result every campaign write returns: a value, never a thrown refusal, so the UI can say what happened. */
export type CampaignResult<T = object> = ({ ok: true } & T) | { ok: false; error: string; reason?: string };
