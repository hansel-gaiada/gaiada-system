"use server";
// SCP-5e (BFF §63.26): the content bank's writes.
//
//   addSavedItem      `POST engagements/:engagementId/saved`   a link, a text or an Asset Library photo kept for the client; 201 `{item, created}`; 200 for a replayed id or an asset already kept
//   updateSavedItem   `PATCH saved/:itemId`                    the title, text, pillar, source, AI note (and the collection, for an item left under "Other")
//   deleteSavedItem   `DELETE saved/:itemId`                   a soft delete
//   loadSavedPicker   the two GETs, for the post page's "Use from Saved" picker (a read, so null when it cannot be told)
//
// The gates here are hints; the server's 403 is the boundary (SCP-Q29): adding is the Social Media team's, changing or deleting is the item's author's, else the client's officer, the HoD, the GM, the owner
// or the superadmin. Every refusal comes back as the contract's own code with the words for it (`savedRefusalText`), and a 403 says who may.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { refusalFromBody, type Refusal } from "./socialPipeline";
import { asCollections, asSavedCreated, asSavedPage, savedRefusalText, type SavedCollection, type SavedItem, type SavedPage, type SavedWriteKind } from "./socialSaved";

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

/** What the post page's picker reads for one client: the company's collections and every item of each (the read-only approved posts are not read). */
export interface SavedPickerData { collections: SavedCollection[]; pages: SavedPage[] }

const PICKER_PAGE = 100;
const PICKER_PAGES_MAX = 5;

/**
 * `GET engagements/:engagementId/saved`, then each collection's items (`limit=100`, followed up to five pages). Null when anything cannot be read (a 403 for a person without the social read tier
 * included): the picker then says it cannot tell, never that the bank is empty.
 */
export async function loadSavedPicker(engagementId: string): Promise<SavedPickerData | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return null;
  const root = `${base(tenant)}/engagements/${encodeURIComponent(engagementId)}/saved`;
  try {
    const { collections } = asCollections(await platformFetch<unknown>(root, userId));
    const pages: SavedPage[] = [];
    for (const c of collections.filter((x) => x.key !== "posts")) {
      let cursor: string | null = null;
      const items: unknown[] = [];
      for (let n = 0; n < PICKER_PAGES_MAX; n++) {
        const qs: URLSearchParams = new URLSearchParams({ collection: c.key, limit: String(PICKER_PAGE), ...(cursor ? { cursor } : {}) });
        const raw: unknown = await platformFetch<unknown>(`${root}?${qs.toString()}`, userId);
        const o: { items?: unknown; nextCursor?: unknown } = typeof raw === "object" && raw !== null ? (raw as { items?: unknown; nextCursor?: unknown }) : {};
        if (Array.isArray(o.items)) items.push(...o.items);
        cursor = typeof o.nextCursor === "string" && o.nextCursor !== "" ? o.nextCursor : null;
        if (!cursor) break;
      }
      pages.push(asSavedPage({ items, nextCursor: cursor }, c.key));
    }
    return { collections, pages };
  } catch (e) {
    if (e instanceof PlatformError) return null;
    if (e instanceof Error && e.message.startsWith("saved:")) return null;
    throw e;
  }
}
