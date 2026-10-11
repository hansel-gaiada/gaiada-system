"use server";
import { revalidatePath } from "next/cache";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActivePortalCompany } from "./portal-company";
import { getPortalWebsiteAccess } from "./clientWebsiteAccess";
import {
  describeRefusal,
  type WebsiteAccessReadResult,
  type WebsiteAccessWriteResult,
} from "./clientWebsiteAccessView";

// WSK-49f — PORTAL writes on the People page, for a client ADMIN (docs/FRONTEND-BFF-CONTRACT.md §16i):
//
//   PUT | DELETE /api/:t/portal/clients/:clientId/contacts/:contactId/website-editor
//
// That is the ONLY write there is. There is deliberately no portal route for `admin`, for a capability,
// or for any other role, so this module has none either: the role is a literal in the path, the scope is
// the client in the path, and nothing in a body is read by the server. Whatever the BFF answers is shown
// (self-grant, 403, 404): no client-side rule is added on top of it.
//
// The company comes from the PORTAL's own resolver (`getActivePortalCompany`), never the staff one
// (`portal-company.guard.test.ts` is the guard for the portal tree; this file follows the same rule).

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return { error: "No client account is linked to your sign-in." };
  return { userId, tenant };
}

function failure(e: unknown): WebsiteAccessWriteResult {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { ok: false, kind: "forbidden", message: "You can't change website access." };
    if (e.status === 404) return { ok: false, kind: "not_found", message: "That person is no longer on your account." };
    if (e.status === 400 || e.status === 409 || e.status === 422) {
      return { ok: false, kind: "refused", message: describeRefusal(e.message) };
    }
    return { ok: false, kind: "error", message: e.message };
  }
  return { ok: false, kind: "error", message: "Could not complete that. Please try again." };
}

/** Give (`grant: true`) or take away (`false`) a colleague's website access. */
export async function setPortalWebsiteEditorAction(input: {
  clientId: string;
  contactId: string;
  grant: boolean;
}): Promise<WebsiteAccessWriteResult> {
  if (!isId(input?.clientId) || !isId(input?.contactId)) {
    return { ok: false, kind: "error", message: "That person could not be identified." };
  }
  const c = await ctx();
  if ("error" in c) return { ok: false, kind: "error", message: c.error };
  try {
    const r = await platformFetch<{ websiteEditor?: boolean; changed?: boolean }>(
      `/api/${c.tenant}/portal/clients/${input.clientId}/contacts/${input.contactId}/website-editor`,
      c.userId,
      { method: input.grant ? "PUT" : "DELETE" },
    );
    revalidatePath("/portal/profile");
    return { ok: true, changed: r.changed === true, websiteEditor: r.websiteEditor === true };
  } catch (e) {
    return failure(e);
  }
}

/** Re-read the list after a 404 so the card shows who is on the account now. */
export async function refreshPortalWebsiteAccessAction(clientId: string): Promise<WebsiteAccessReadResult> {
  if (!isId(clientId)) return { kind: "unavailable", reason: "That account could not be identified." };
  const c = await ctx();
  if ("error" in c) return { kind: "unavailable", reason: c.error };
  return getPortalWebsiteAccess(c.userId, c.tenant, clientId);
}
