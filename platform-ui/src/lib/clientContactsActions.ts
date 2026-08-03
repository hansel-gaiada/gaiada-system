"use server";
import { revalidatePath } from "next/cache";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getSessionUserId } from "./session-server";
import { getActiveTenant } from "./tenant";
import type { ClientContact } from "./clientContactsView";

// W0-5 — invite / revoke a client portal contact. Manager-tier on the API (owner decision D-2: a PM
// delegates internally AND starts the external setup), so a PM reaches these without an admin.

export type InviteResult =
  | {
      ok: true;
      /** The RAW invite link. Returned by the API exactly once and never stored in a readable form —
       *  see the note in clientContacts.ts. Shown to the PM to forward. */
      acceptUrl: string;
      expiresAt: string;
      email: string;
    }
  | { ok: false; error: string };

export type RevokeResult = { ok: boolean; error?: string; idpDisabled?: boolean; keptAccount?: boolean };

/** Same shape every other action module uses — `Me` carries no tenant, the ACTIVE one comes from the
 *  company switcher, so this must not be re-derived locally. */
async function ctx(): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant };
}

function fail(e: unknown): { ok: false; error: string } {
  if (e instanceof PlatformError) {
    // Surface the API's own message: it is the thing that says WHICH field was wrong (bad email, bad
    // capability, a project from another tenant), and re-inventing it here would drift.
    return { ok: false, error: e.message };
  }
  return { ok: false, error: "Could not complete that. Please try again." };
}

export async function inviteClientContactAction(
  _prev: InviteResult | null,
  formData: FormData,
): Promise<InviteResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };

  const clientId = String(formData.get("clientId") ?? "");
  const email = String(formData.get("email") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const capability = String(formData.get("capability") ?? "viewer");
  // Empty string = client-wide (D-1's `project_id NULL`), which is what a PM wants before any project
  // exists — the D-3 case of setting a client up BEFORE the first meeting.
  const projectId = String(formData.get("projectId") ?? "").trim();

  if (!clientId) return { ok: false, error: "Missing client." };
  if (!email) return { ok: false, error: "An email address is required." };

  try {
    const r = await platformFetch<{
      contact: ClientContact;
      invite: { token: string; expiresAt: string; acceptPath: string };
    }>(`/api/${c.tenant}/clients/${clientId}/contacts`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        email,
        name: name || undefined,
        capability,
        projectId: projectId || null,
      }),
    });

    revalidatePath(`/clients/${clientId}`);

    // Absolute URL so the PM can paste it straight into whatever channel they already use with this
    // client. There is no mail transport in this estate (verified — no mail dependency anywhere), so
    // W0 hands the link over rather than sending it; automated send is a later change that does not
    // alter this contract.
    const origin = process.env.PUBLIC_APP_ORIGIN ?? process.env.OIDC_REDIRECT_URI?.replace(/\/auth\/callback.*$/, "") ?? "";
    const qs = new URLSearchParams();
    const clientLabel = String(formData.get("clientName") ?? "").trim();
    if (clientLabel) qs.set("client", clientLabel);
    const path = `${r.invite.acceptPath}${qs.toString() ? `?${qs}` : ""}`;
    return {
      ok: true,
      acceptUrl: origin ? `${origin}${path}` : path,
      expiresAt: r.invite.expiresAt,
      email: r.contact.email,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function revokeClientContactAction(
  _prev: RevokeResult | null,
  formData: FormData,
): Promise<RevokeResult> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  const id = String(formData.get("id") ?? "");
  const clientId = String(formData.get("clientId") ?? "");
  if (!id) return { ok: false, error: "Missing contact." };
  try {
    const r = await platformFetch<{ idpDisabled?: boolean; keptAccountForOtherEngagements?: boolean }>(
      `/api/${c.tenant}/client-contacts/${id}/revoke`,
      c.userId,
      { method: "POST", body: JSON.stringify({}) },
    );
    if (clientId) revalidatePath(`/clients/${clientId}`);
    // Surfaced so the PM is not misled: when the person is a contact on ANOTHER client or project their
    // login is deliberately left enabled, and a revoke that quietly kept an account would be worse than
    // one that says so.
    return { ok: true, idpDisabled: r.idpDisabled === true, keptAccount: r.keptAccountForOtherEngagements === true };
  } catch (e) {
    const f = fail(e);
    return { ok: false, error: f.error };
  }
}
