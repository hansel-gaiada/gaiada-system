"use server";
import { revalidatePath } from "next/cache";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import { getStaffWebsiteAccess } from "./clientWebsiteAccess";
import {
  describeRefusal,
  type WebsiteAccessCapability,
  type WebsiteAccessReadResult,
  type WebsiteAccessWriteResult,
} from "./clientWebsiteAccessView";

// WSK-49f — STAFF writes on a client's Contacts page (docs/FRONTEND-BFF-CONTRACT.md §16i):
//
//   PUT | DELETE /api/:t/clients/:clientId/contacts/:contactId/website-editor
//   PUT | DELETE /api/:t/clients/:clientId/contacts/:contactId/admin      (DELETE body {to:"signer"|"viewer"})
//
// There is NO role / scope / permission parameter anywhere: the role is a literal in the path, the
// scope is the client in the path, and these actions send no body except the explicit `to` on an admin
// removal. The BFF re-authorizes every call; a 403 comes back as `kind: "forbidden"` and the panel
// turns read-only. Ids are checked to be a plain token (no slash, dot, query or escape) before they are placed in a
// path, so a crafted id can never reach a different route; the BFF validates the UUID itself.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);

async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session has expired. Sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company is selected." };
  return { userId, tenant };
}

function failure(e: unknown): WebsiteAccessWriteResult {
  if (e instanceof PlatformError) {
    if (e.status === 403) return { ok: false, kind: "forbidden", message: "You can't change this." };
    if (e.status === 404) return { ok: false, kind: "not_found", message: "That contact no longer exists." };
    if (e.status === 400 || e.status === 409 || e.status === 422) {
      return { ok: false, kind: "refused", message: describeRefusal(e.message) };
    }
    return { ok: false, kind: "error", message: e.message };
  }
  return { ok: false, kind: "error", message: "Could not complete that. Please try again." };
}

const isCapability = (v: unknown): v is WebsiteAccessCapability => v === "admin" || v === "signer" || v === "viewer";

/** Give (`grant: true`) or take away (`false`) a contact's website access. */
export async function setStaffWebsiteEditorAction(input: {
  clientId: string;
  contactId: string;
  grant: boolean;
}): Promise<WebsiteAccessWriteResult> {
  if (!isId(input?.clientId) || !isId(input?.contactId)) {
    return { ok: false, kind: "error", message: "That contact could not be identified." };
  }
  const c = await ctx();
  if ("error" in c) return { ok: false, kind: "error", message: c.error };
  try {
    const r = await platformFetch<{ websiteEditor?: boolean; changed?: boolean }>(
      `/api/${c.tenant}/clients/${input.clientId}/contacts/${input.contactId}/website-editor`,
      c.userId,
      { method: input.grant ? "PUT" : "DELETE" },
    );
    revalidatePath(`/clients/${input.clientId}/contacts`);
    // `changed` is the server's word. Missing is treated as "not changed": a false "updated" is the
    // worse mistake of the two.
    return { ok: true, changed: r.changed === true, websiteEditor: r.websiteEditor === true };
  } catch (e) {
    return failure(e);
  }
}

/** Make a contact an admin (`to` omitted) or remove admin (`to` = the capability they keep). Staff only
 *  on the server; removing takes an explicit `signer | viewer`, defaulting to viewer. */
export async function setStaffClientAdminAction(input: {
  clientId: string;
  contactId: string;
  grant: boolean;
  to?: "signer" | "viewer";
}): Promise<WebsiteAccessWriteResult> {
  if (!isId(input?.clientId) || !isId(input?.contactId)) {
    return { ok: false, kind: "error", message: "That contact could not be identified." };
  }
  const to = input.to ?? "viewer";
  if (!input.grant && to !== "signer" && to !== "viewer") {
    return { ok: false, kind: "refused", message: "Choose whether they keep Signer or Viewer." };
  }
  const c = await ctx();
  if ("error" in c) return { ok: false, kind: "error", message: c.error };
  try {
    const r = await platformFetch<{ capability?: unknown; changed?: boolean }>(
      `/api/${c.tenant}/clients/${input.clientId}/contacts/${input.contactId}/admin`,
      c.userId,
      input.grant ? { method: "PUT" } : { method: "DELETE", body: JSON.stringify({ to }) },
    );
    revalidatePath(`/clients/${input.clientId}/contacts`);
    return {
      ok: true,
      changed: r.changed === true,
      capability: isCapability(r.capability) ? r.capability : undefined,
    };
  } catch (e) {
    return failure(e);
  }
}

/** Re-read the list after a 404 (the contact is gone) so the panel shows what is true now. */
export async function refreshStaffWebsiteAccessAction(clientId: string): Promise<WebsiteAccessReadResult> {
  if (!isId(clientId)) return { kind: "unavailable", reason: "That client could not be identified." };
  const c = await ctx();
  if ("error" in c) return { kind: "unavailable", reason: c.error };
  return getStaffWebsiteAccess(c.userId, c.tenant, clientId);
}
