"use server";
// AIP-13b (BFF §65.3): the guidance editor's one write. RBAC here is DEFENCE IN DEPTH ONLY: Cerbos decides (`resource_dept_assistant_preamble.yaml`:
// the company tier's `manage`, else a head's per-unit `edit`), so this layer does not pre-refuse a head. The server's 400 (with its message), 403
// and 404 come back as the form's error (`guidanceErrorText`). An EMPTY body is the reset: the server deletes the company's row and the default
// is back. The company is the page's own, checked against the caller's companies so a tampered id cannot reach one the caller is not in.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { accessibleCompanies } from "./rbac";
import { asPreambleView, guidanceErrorText, measuredText, type GuidanceActionResult } from "./assistantGuidance";

const path = (tenantId: string, unitNodeId: string) =>
  `/api/${encodeURIComponent(tenantId)}/departments/${encodeURIComponent(unitNodeId)}/assistant-preamble`;

/** Save the department's guidance (`body`), or reset it to the default (`body` empty). Answers the new state (the server's §65.1 view). */
export async function savePreambleAction(tenantId: string, unitNodeId: string, body: string): Promise<GuidanceActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  if (!tenantId || !accessibleCompanies(me).some((c) => c.id === tenantId)) return { ok: false, error: "Select a company first." };
  if (!unitNodeId) return { ok: false, error: "No department chosen.", field: "unitNodeId" };
  try {
    const raw = await platformFetch<unknown>(path(tenantId, unitNodeId), userId, {
      method: "PUT",
      body: JSON.stringify({ body: measuredText(typeof body === "string" ? body : "") }),
    });
    const view = asPreambleView(raw);
    revalidatePath("/departments/[deptId]/assistant-guidance", "page");
    return { ok: true, view };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: guidanceErrorText({ status: e.status, message: e.message }), ...(e.field ? { field: e.field } : {}) };
    throw e;
  }
}
