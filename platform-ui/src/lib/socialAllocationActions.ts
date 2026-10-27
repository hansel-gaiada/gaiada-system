"use server";
// SCP-1a (BFF §63.4): the Allocation page's and the brand book's server actions.
//
//   saveAllocation   `PATCH engagements/:engagementId/allocation`  (social_engagement · plan: the four Social approvers)
//   loadBrandBook    `GET brand-profiles/:clientId`                 (social_engagement · read; a client with no profile yet answers an empty book)
//   saveBrandBook    `PATCH brand-profiles/:clientId`               (social_engagement · update)
//
// The gates here are hints; the server's 403 is the boundary. Every refusal comes back as the contract's own code in `error` (and its `field`),
// plus the words for it in `message`; the screens show the words.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { allocationRefusalText, asAllocationRow, type AllocationPatch, type AllocationRow } from "./socialAllocation";
import { EMPTY_BRAND_BOOK, asBrandBook, brandBookRefusalText, validateBrandBook, type BrandBook } from "./socialBrandBook";

export type AllocationActionResult<T> = ({ ok: true } & T) | { ok: false; error: string; field?: string; message: string };

const base = (t: string) => `/api/${encodeURIComponent(t)}/modules/social`;

async function run<T>(
  words: (code: string, field?: string) => string, fn: (c: { userId: string; tenant: string }) => Promise<T>,
): Promise<AllocationActionResult<T>> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "session_expired", message: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { ok: false, error: "no_company", message: "No active company selected." };
  try {
    return { ok: true, ...(await fn({ userId, tenant })) };
  } catch (e) {
    if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field, message: words(e.message, e.field) };
    throw e;
  }
}

/** Saves a subset of one client's allocation. Answers the row as the server now holds it. */
export async function saveAllocation(engagementId: string, patch: AllocationPatch): Promise<AllocationActionResult<{ row: AllocationRow }>> {
  return run(allocationRefusalText, async (c) => {
    const raw = await platformFetch<unknown>(`${base(c.tenant)}/engagements/${encodeURIComponent(engagementId)}/allocation`, c.userId, {
      method: "PATCH", body: JSON.stringify(patch),
    });
    revalidatePath("/departments", "layout");
    return { row: asAllocationRow(raw) };
  });
}

/** One client's brand book. A client with no profile row yet (404) answers the empty book, which the form fills in and the first save creates. */
export async function loadBrandBook(clientId: string): Promise<AllocationActionResult<{ book: BrandBook; exists: boolean }>> {
  return run(brandBookRefusalText, async (c) => {
    try {
      const raw = await platformFetch<unknown>(`${base(c.tenant)}/brand-profiles/${encodeURIComponent(clientId)}`, c.userId);
      return { book: asBrandBook(raw), exists: true };
    } catch (e) {
      if (e instanceof PlatformError && e.status === 404) return { book: { ...EMPTY_BRAND_BOOK }, exists: false };
      throw e;
    }
  });
}

/** Saves the whole brand book of one client (every field is sent; the server keeps the rest of the profile: voice, hashtag rules, sources). */
export async function saveBrandBook(clientId: string, book: BrandBook): Promise<AllocationActionResult<{ book: BrandBook }>> {
  const checked = validateBrandBook(book);
  if (!checked.ok) return { ok: false, error: "invalid_field", field: checked.field, message: checked.message };
  return run(brandBookRefusalText, async (c) => {
    await platformFetch(`${base(c.tenant)}/brand-profiles/${encodeURIComponent(clientId)}`, c.userId, { method: "PATCH", body: JSON.stringify(checked.book) });
    revalidatePath("/departments", "layout");
    return { book: checked.book };
  });
}
