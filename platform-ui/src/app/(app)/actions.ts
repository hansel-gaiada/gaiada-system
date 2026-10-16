"use server";
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "@/lib/session-server";
import { platformFetch } from "@/lib/platform";
import { retryAutomationApproval as retryAutomationApprovalCall } from "@/lib/automationApprovals";
import { parseKeyMintDecision } from "@/lib/webdeskContent";
import type { KeyMintDecideResult } from "@/lib/webdeskContentModel";

export async function decideApproval(tenantId: string, approvalId: string, decision: "approved" | "rejected"): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await platformFetch(`/api/${tenantId}/modules/agency/approvals/${approvalId}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ decision }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/");
  revalidatePath("/approvals");
  return { ok: true };
}

export type QueueDecideOrigin = "agency" | "automation" | "pipeline";

// DW-3c: the pages that render the Overview's "Needs you" block. `/` and
// `/departments` do not cover them: `revalidatePath` matches one path, and `/departments/[deptId]` is a
// dynamic segment. The functional workspaces' Overviews are their own pages.
function revalidateOverviews() {
  revalidatePath("/departments/[deptId]", "page");
  revalidatePath("/hr");
  revalidatePath("/finance");
  revalidatePath("/it");
}

// The Home `NeedsMeQueue`'s decide dispatcher — one action shape over the
// queue's three approval-like origins, matching contract §9(a)'s generic
// decide façade in spirit (`POST /api/:t/approvals/:id/decide {origin,
// decision}`) WITHOUT waiting on that endpoint: it dispatches straight to
// each origin's own already-live decide handler (no new authorization model,
// `approvals.decide` is checked server-side per-origin exactly as today).
// Swap the body of this function for a single call to the façade once
// WSUX-2 ships — callers (NeedsMeQueue) never need to change.
export async function decideQueueItem(
  tenantId: string,
  origin: QueueDecideOrigin,
  originId: string,
  decision: "approved" | "rejected",
): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const path =
    origin === "agency" ? `/api/${tenantId}/modules/agency/approvals/${originId}/decide`
    : origin === "automation" ? `/api/${tenantId}/automation-approvals/${originId}/decide`
    : `/api/${tenantId}/pipeline/gates/${originId}/decide`;
  try {
    await platformFetch(path, userId, { method: "POST", body: JSON.stringify({ decision }) });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/");
  revalidatePath("/departments");
  revalidateOverviews();
  return { ok: true };
}

// WSUX-6 — the unified /approvals inbox's decide action. Unlike
// `decideQueueItem` above (which dispatches per-origin to each native decide
// route directly, predating WSUX-2), this calls the WSUX-2 façade
// (`POST /api/:t/approvals/:id/decide`) straight up: one path, all five
// origins (agency|pipeline|hr|automation|agent|search), the façade's own dispatcher
// does the per-origin authorize()/Cerbos call. No new authorization model —
// same rule as `decideQueueItem`'s own comment, just via the endpoint instead
// of a client-side origin switch.
// `search` (probe consent) added 2026-09-03. The façade routes it to the same
// automation_approvals controller as automation/agent/hr, which re-derives the row's real origin
// from the DB before authorizing — so a caller cannot claim a softer origin to dodge the
// probe-consent property gate.
export type ApprovalDecideOrigin = "agency" | "pipeline" | "hr" | "automation" | "agent" | "search" | "webdesk" | "github";

export async function decideApprovalItem(
  tenantId: string,
  origin: ApprovalDecideOrigin,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await platformFetch(`/api/${tenantId}/approvals/${id}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ origin, decision, note }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/approvals");
  // APPR-01: the per-approval detail page (`/approvals/[id]`) needs its own revalidation — a
  // no-op for every OLDER caller (the unified inbox list) that never visits that path.
  revalidatePath(`/approvals/${id}`);
  revalidatePath("/");
  revalidatePath("/departments");
  return { ok: true };
}

// WebDesk key.mint — the SIBLING of `decideApprovalItem` for the one approval whose decide response carries a secret.
// WSK-66 mints IN-BAND on approve and the façade answers `{ ok: true, webdesk: { command: "key.mint", executionStatus,
// apiKeyId, envId, scope, plaintextOnce } }`; `plaintextOnce` is the API key in plaintext and this is the ONLY time it exists
// anywhere (WebDesk keeps a hash; the approval row, activities, outbox and logs never hold it). `decideApprovalItem` ignores the
// body, which is right for every other origin and meant a key approved through the UI was minted and thrown away.
//
// CUSTODY (hard rules; `KeyMintDecide.test.tsx` pins them):
//   • the key is RETURNED to the one client component that asked, and goes nowhere else: not logged, not stored, not a cache
//     tag, and nothing derived from the response reaches `revalidatePath` (the four paths below are constants plus the approval id
//     the caller already sent). The page that revalidation re-renders reads the decided ROW, which never holds the key.
//   • the parser (`parseKeyMintDecision`) names a bad field by path and TYPE only, so a malformed `plaintextOnce` cannot leak
//     through an error message.
//   • every OTHER caller of the façade keeps `decideApprovalItem`, untouched.
export async function decideKeyMintApproval(
  tenantId: string,
  id: string,
  decision: "approved" | "rejected",
  note?: string,
): Promise<KeyMintDecideResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  let body: unknown;
  try {
    body = await platformFetch<unknown>(`/api/${tenantId}/approvals/${id}/decide`, userId, {
      method: "POST",
      body: JSON.stringify({ origin: "webdesk", decision, note }),
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${id}`);
  revalidatePath("/");
  revalidatePath("/departments");
  if (decision === "rejected") return { ok: true, decision: "rejected" };
  try {
    return { ok: true, decision: "approved", mint: parseKeyMintDecision(body) ?? { status: "unreadable" } };
  } catch {
    // Approved, but the answer was not the shape the ERP expects. The drift detail is deliberately dropped: the key is not
    // recoverable from here either way, and the approver is told so rather than shown a half-parsed value.
    return { ok: true, decision: "approved", mint: { status: "unreadable" } };
  }
}

// D14-08 — retry a FAILED (or stuck-`executing`, per D14-07's staleness window) automation
// write's execution from the unified inbox's "Recently decided" section. No client-side RBAC gate
// here on purpose: the backend Cerbos-authorizes the `retry` action (superadmin/company_admin/
// group_executive, NOT manager) and returns a real 403 for anyone else — this action only relays
// that outcome. What IS gated client-side is whether the button renders at all
// (`ApprovalsList`'s `retryableTenantIds`, computed from `can(me, "approvals.retry", tenantId)` in
// `/approvals/page.tsx`) — the UI must not OFFER the control to someone it would refuse, not merely
// hide a button someone could still POST to.
export async function retryAutomationApproval(tenantId: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  try {
    await retryAutomationApprovalCall(userId, tenantId, id);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  revalidatePath("/approvals");
  revalidatePath(`/approvals/${id}`);
  return { ok: true };
}
