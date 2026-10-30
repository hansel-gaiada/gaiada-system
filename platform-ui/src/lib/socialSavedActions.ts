"use server";
// SCP-5e (BFF §63.26): the content bank's writes.
//
//   addSavedItem      `POST engagements/:engagementId/saved`   a link, a text or an Asset Library photo kept for the client; 201 `{item, created}`; 200 for a replayed id or an asset already kept
//   updateSavedItem   `PATCH saved/:itemId`                    the title, text, pillar, source, AI note (and the collection, for an item left under "Other")
//   deleteSavedItem   `DELETE saved/:itemId`                   a soft delete
//
// The gates here are hints; the server's 403 is the boundary (SCP-Q29): adding is the Social Media team's, changing or deleting is the item's author's, else the client's officer, the HoD, the GM, the owner
// or the superadmin. Every refusal comes back as the contract's own code with the words for it (`savedRefusalText`), and a 403 says who may.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asSavedCreated, savedRefusalText, type SavedItem, type SavedWriteKind } from "./socialSaved";

export type SavedWrite<T = object> = ({ ok: true } & T) | { ok: false; refusal: Refusal; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;
const fail = (refusal: Refusal, kind: SavedWriteKind): { ok: false; refusal: Refusal; message: string } => ({ ok: false, refusal, message: savedRefusalText(refusal, kind) });

async function run<T extends object>(kind: SavedWriteKind, fn: (c: { userId: string; tenant: string }) => Promise<T>): Promise<SavedWrite<T>> {
  const userId = await getSessionUserId();
  if (!userId) return fail({ status: 401, error: "session_expired" }, kind);
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return fail({ status: 400, error: "no_company" }, kind);
  try {
    const out = await fn({ userId, tenant });
    revalidatePath("/departments", "layout");
    return { ok: true, ...out };
  } catch (e) {
    if (e instanceof PlatformError) return fail(refusalFromBody(e.status, e.message, e.body, e.field, e.reason), kind);
    throw e;
  }
}

/** `POST engagements/:engagementId/saved` with the form's body (built by `buildSavedCreate`, with a fresh `id` for the click, so a replay is the same item). */
export async function addSavedItem(engagementId: string, body: Record<string, unknown>): Promise<SavedWrite<{ item: SavedItem; created: boolean }>> {
  return run("add", async (c) =>
    asSavedCreated(await platformFetch<unknown>(`${base(c.tenant)}/engagements/${encodeURIComponent(engagementId)}/saved`, c.userId, { method: "POST", body: JSON.stringify(body) })));
}

/** `PATCH saved/:itemId` with only the fields that changed. */
export async function updateSavedItem(itemId: string, body: Record<string, unknown>): Promise<SavedWrite> {
  return run("change", async (c) => {
    await platformFetch<unknown>(`${base(c.tenant)}/saved/${encodeURIComponent(itemId)}`, c.userId, { method: "PATCH", body: JSON.stringify(body) });
    return {};
  });
}

/** `DELETE saved/:itemId`. */
export async function deleteSavedItem(itemId: string): Promise<SavedWrite> {
  return run("delete", async (c) => {
    await platformFetch<unknown>(`${base(c.tenant)}/saved/${encodeURIComponent(itemId)}`, c.userId, { method: "DELETE" });
    return {};
  });
}
