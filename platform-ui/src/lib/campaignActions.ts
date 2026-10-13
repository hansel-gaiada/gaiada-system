"use server";
// DW-5b: server actions behind the campaign page's parts and the Social campaigns screen (BFF §31.4 writes).
//
// The platform is the authority on every one of these: Cerbos `agency_campaign` update and `agency_campaign_part`
// create / update / delete / allocate, then the money rules of §31.3 (409 with a machine `reason` and the figures in
// `detail`). Nothing here widens or pre-empts that. Every action returns a value, never a thrown refusal, so the UI
// can say what happened in words. The tenant is the caller's ACTIVE company, never a value from the browser.
//
// Money crosses this file as integer MINOR units only; the UI converts what a person types (see `parseMoneyInput`).
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import {
  campaignErrorText, detailOf,
  type CampaignResult, type LinkKind, type PartStatus, type CampaignStatus,
} from "./campaigns";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "Select a company first." };
  return { userId, tenant };
}

function fail(e: unknown, currency?: string | null): { ok: false; error: string; reason?: string } {
  if (e instanceof PlatformError) {
    return {
      ok: false,
      error: campaignErrorText({ status: e.status, reason: e.reason, message: e.message, detail: detailOf(e.body) }, currency),
      ...(e.reason ? { reason: e.reason } : {}),
    };
  }
  throw e;
}

const base = (t: string, campaignId: string) => `/api/${t}/modules/agency/campaigns/${encodeURIComponent(campaignId)}`;

/** The campaign page, and every department page that lists or links campaigns, must re-read after a write. */
function refresh(campaignId: string) {
  revalidatePath(`/agency/${campaignId}`);
  revalidatePath("/departments", "layout");
}

// ── the campaign itself ──────────────────────────────────────────────────────────────────────────

export interface CampaignPatch {
  name?: string;
  status?: CampaignStatus;
  /** Integer minor units, or null to clear. */
  budgetMinor?: number | null;
  currency?: string | null;
  leadUnitId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

/** `PATCH campaigns/:id` (gate: `agency_campaign` update). `currency` is the campaign's current currency, used only
 *  to word a money refusal. */
export async function updateCampaignAction(campaignId: string, patch: CampaignPatch, currency?: string | null): Promise<CampaignResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(base(c.tenant, campaignId), c.userId, { method: "PATCH", body: JSON.stringify(patch) });
    refresh(campaignId);
    return { ok: true };
  } catch (e) {
    return fail(e, currency);
  }
}

// ── parts ────────────────────────────────────────────────────────────────────────────────────────

export interface PartCreate {
  unitId: string;
  ownerId?: string | null;
  brief?: string;
  dueOn?: string | null;
  budgetMinor?: number | null;
}

/** `POST campaigns/:id/parts`: add a department (gate: part create, plus allocate when `budgetMinor` is sent). */
export async function addPartAction(campaignId: string, input: PartCreate, currency?: string | null): Promise<CampaignResult<{ partId: string }>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    const r = await platformFetch<{ id: string }>(`${base(c.tenant, campaignId)}/parts`, c.userId, {
      method: "POST",
      body: JSON.stringify(input),
    });
    refresh(campaignId);
    return { ok: true, partId: r.id };
  } catch (e) {
    return fail(e, currency);
  }
}

export interface PartPatch {
  status?: PartStatus;
  ownerId?: string | null;
  brief?: string;
  dueOn?: string | null;
  /** Integer minor units, or null for no allocation. Sending it needs the `allocate` gate. */
  budgetMinor?: number | null;
}

/** `PATCH campaigns/:id/parts/:partId` (gate: part update for the work fields, allocate for `budgetMinor`). */
export async function updatePartAction(
  campaignId: string, partId: string, patch: PartPatch, currency?: string | null,
): Promise<CampaignResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant, campaignId)}/parts/${encodeURIComponent(partId)}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    refresh(campaignId);
    return { ok: true };
  } catch (e) {
    return fail(e, currency);
  }
}

/** `DELETE campaigns/:id/parts/:partId`: a soft delete (gate: part delete). Refused with `part_has_links` while work points at it. */
export async function removePartAction(campaignId: string, partId: string): Promise<CampaignResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant, campaignId)}/parts/${encodeURIComponent(partId)}`, c.userId, { method: "DELETE" });
    refresh(campaignId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

// ── links between a part and a department's own campaign ─────────────────────────────────────────

/** `POST .../parts/:partId/links` (gate: part update, plus read on the child). */
export async function linkToPartAction(campaignId: string, partId: string, kind: LinkKind, refId: string): Promise<CampaignResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant, campaignId)}/parts/${encodeURIComponent(partId)}/links`, c.userId, {
      method: "POST",
      body: JSON.stringify({ kind, refId }),
    });
    refresh(campaignId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** `DELETE .../parts/:partId/links/:kind/:refId`. */
export async function unlinkFromPartAction(campaignId: string, partId: string, kind: LinkKind, refId: string): Promise<CampaignResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(
      `${base(c.tenant, campaignId)}/parts/${encodeURIComponent(partId)}/links/${encodeURIComponent(kind)}/${encodeURIComponent(refId)}`,
      c.userId,
      { method: "DELETE" },
    );
    refresh(campaignId);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
