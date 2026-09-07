"use server";
// AD-11 — server actions for the agency-leads staff console (create/invite/revoke/triage/convert).
// Same `ctx()` + `{ok,error?,field?}` shape every actions file in this codebase follows
// (`platform-ui/CLAUDE.md`'s "module trio" section) — see `clientContactsActions.ts` for the closest
// precedent (an invite token shown once, revoke idempotent).
//
// RBAC is mirrored, not owned: `lib/rbac.ts`'s `agency.lead.*` capabilities decide what RENDERS; the
// backend's Cerbos check on each of these routes is the actual boundary regardless of what a client
// posts here, so every action below still calls the real endpoint and surfaces whatever it decides
// (contract rule 3: a refusal must never be swallowed into a false success).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe, platformFetch, PlatformError } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { buildInviteLink, type DelegationInput, type DelegationReportEntry, type ExistingConvertArtifact } from "@/lib/agencyLeads";

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof PlatformError) return { ok: false, error: e.message };
  return { ok: false, error: "Could not complete that. Please try again." };
}

// ─────────────────────────────────────────────────────────────────── create (staff-sourced)
export interface CreateLeadResult { ok: boolean; error?: string }

/** `source='staff'` — someone who phoned in. Redirects to the new lead's detail page on success
 *  (mirrors `agency/actions.ts::createCampaign`), so there is no `id` to thread through a result type. */
export async function createLeadAction(_prev: CreateLeadResult | null, formData: FormData): Promise<CreateLeadResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const orgName = String(formData.get("orgName") ?? "").trim();
  if (!orgName) return { ok: false, error: "Organisation name is required." };
  const contactName = String(formData.get("contactName") ?? "").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  let id: string;
  try {
    const created = await platformFetch<{ id: string; status: string }>(`/api/${c.tenant}/agency/leads`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        orgName,
        contactName: contactName || undefined,
        contactEmail: contactEmail || undefined,
        contactPhone: contactPhone || undefined,
      }),
    });
    id = created.id;
  } catch (e) {
    return fail(e);
  }
  revalidatePath("/agency/leads");
  redirect(`/agency/leads/${id}`);
}

// ─────────────────────────────────────────────────────────────────── invite / revoke
export interface InviteResult {
  ok: boolean;
  error?: string;
  tokenId?: string;
  /** The RAW token. Exists in this response ONCE — the API stores only its hash — and nowhere else
   *  this app will ever show it again. */
  token?: string;
  expiresAt?: string;
  /** Built only when `AGENCY_DISCOVERY_FORM_URL` is configured (design §9.1: the prospect form's
   *  hosting is a separate deployment this ticket does not own). `null` when unset — the caller must
   *  degrade to showing the bare token + instructions rather than a broken link. */
  link?: string | null;
}

export async function inviteLeadAction(_prev: InviteResult | null, formData: FormData): Promise<InviteResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) return { ok: false, error: "Missing lead." };

  try {
    // A minimal JSON body (`{}`, ttlDays defaults server-side) — deliberately NOT a bodyless POST,
    // since the controller reads `body.ttlDays` even though this action doesn't set it yet.
    const r = await platformFetch<{ tokenId: string; token: string; expiresAt: string }>(
      `/api/${c.tenant}/agency/leads/${leadId}/invite`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    revalidatePath(`/agency/leads/${leadId}`);
    revalidatePath("/agency/leads");
    const formUrl = process.env.AGENCY_DISCOVERY_FORM_URL;
    return {
      ok: true,
      tokenId: r.tokenId,
      token: r.token,
      expiresAt: r.expiresAt,
      link: formUrl ? buildInviteLink(formUrl, r.token) : null,
    };
  } catch (e) {
    return fail(e);
  }
}

export interface RevokeResult { ok: boolean; error?: string; revoked?: boolean }

/** Idempotent on the backend — `revoked: false` means it was already revoked or already used, which
 *  is information, not a failure (contract). */
export async function revokeInviteAction(_prev: RevokeResult | null, formData: FormData): Promise<RevokeResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  const tokenId = String(formData.get("tokenId") ?? "");
  if (!leadId || !tokenId) return { ok: false, error: "Missing lead or token." };

  try {
    // Bodyless POST — the endpoint reads no body, and `platformFetch` must not declare a JSON
    // content-type on an empty body (platform-ui/CLAUDE.md's Fastify-400 trap).
    const r = await platformFetch<{ revoked: boolean }>(
      `/api/${c.tenant}/agency/leads/${leadId}/invite/${tokenId}/revoke`,
      c.userId,
      { method: "POST" },
    );
    revalidatePath(`/agency/leads/${leadId}`);
    return { ok: true, revoked: r.revoked };
  } catch (e) {
    return fail(e);
  }
}

// ─────────────────────────────────────────────────────────────────── triage (open / decline / nurture)
export interface TriageResult { ok: boolean; error?: string; status?: string }

export async function openLeadAction(_prev: TriageResult | null, formData: FormData): Promise<TriageResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) return { ok: false, error: "Missing lead." };
  try {
    const r = await platformFetch<{ id: string; status: string }>(`/api/${c.tenant}/agency/leads/${leadId}/open`, c.userId, { method: "POST" });
    revalidatePath(`/agency/leads/${leadId}`);
    revalidatePath("/agency/leads");
    return { ok: true, status: r.status };
  } catch (e) {
    return fail(e);
  }
}

export async function declineLeadAction(_prev: TriageResult | null, formData: FormData): Promise<TriageResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!leadId) return { ok: false, error: "Missing lead." };
  // Client-side-equivalent check BEFORE the round trip — the backend 400s on this too
  // (`normalizeDeclineReason`), but a decline reason is REQUIRED per the design's own state machine,
  // and there is no reason to make a prospect-facing decision wait on a network error for something
  // this cheap to catch here.
  if (!reason) return { ok: false, error: "A decline needs a reason." };
  try {
    const r = await platformFetch<{ id: string; status: string }>(`/api/${c.tenant}/agency/leads/${leadId}/decline`, c.userId, {
      method: "POST",
      body: JSON.stringify({ reason }),
    });
    revalidatePath(`/agency/leads/${leadId}`);
    revalidatePath("/agency/leads");
    return { ok: true, status: r.status };
  } catch (e) {
    return fail(e);
  }
}

export async function nurtureLeadAction(_prev: TriageResult | null, formData: FormData): Promise<TriageResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) return { ok: false, error: "Missing lead." };
  try {
    const r = await platformFetch<{ id: string; status: string }>(`/api/${c.tenant}/agency/leads/${leadId}/nurture`, c.userId, { method: "POST" });
    revalidatePath(`/agency/leads/${leadId}`);
    revalidatePath("/agency/leads");
    return { ok: true, status: r.status };
  } catch (e) {
    return fail(e);
  }
}

// ─────────────────────────────────────────────────────────────────── convert (AD-6)
export interface ConvertResult {
  ok: boolean;
  error?: string;
  id?: string;
  status?: string;
  clientId?: string;
  projectId?: string;
  runId?: string;
  /** AD-6b's delegation report — kept optional (see `lib/agencyLeads.ts::ConvertSuccess`'s header):
   *  a rolling deploy could still be running the pre-AD-6b controller for a moment, and the UI must
   *  degrade rather than assume this key exists. */
  delegations?: DelegationReportEntry[];
  /** The 409 race artifact — someone else already converted this lead. Not a failure to dwell on:
   *  point at what exists (mirrors the webdev triage 409 convention). */
  existing?: ExistingConvertArtifact;
}

export async function convertLeadAction(_prev: ConvertResult | null, formData: FormData): Promise<ConvertResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const leadId = String(formData.get("leadId") ?? "");
  if (!leadId) return { ok: false, error: "Missing lead." };

  let delegations: DelegationInput[] = [];
  const raw = formData.get("delegations");
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) delegations = parsed;
    } catch {
      return { ok: false, error: "Delegation list was malformed — try again." };
    }
  }

  try {
    const r = await platformFetch<{
      id: string; status: string; clientId: string; projectId: string; runId: string; delegations?: DelegationReportEntry[];
    }>(`/api/${c.tenant}/agency/leads/${leadId}/convert`, c.userId, {
      method: "POST",
      body: JSON.stringify({ delegations }),
    });
    revalidatePath(`/agency/leads/${leadId}`);
    revalidatePath("/agency/leads");
    return { ok: true, id: r.id, status: r.status, clientId: r.clientId, projectId: r.projectId, runId: r.runId, delegations: r.delegations };
  } catch (e) {
    if (e instanceof PlatformError && e.status === 409 && e.existing) {
      return { ok: false, error: e.message, existing: e.existing as unknown as ExistingConvertArtifact };
    }
    return fail(e);
  }
}
