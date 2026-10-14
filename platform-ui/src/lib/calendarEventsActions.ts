"use server";
// DW-8g (BFF §47.3): the calendar-event writes. Every action returns a value, never a thrown refusal. The platform is
// the authority (Cerbos `calendar_event`); a refusal is worded by `eventErrorText`. The company is the event's own
// (the event page reads it from `?company=`), checked here against the caller's companies, so a tampered id
// cannot reach a company the caller is not in; the backend would refuse it anyway.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { accessibleCompanies } from "./rbac";
import {
  eventErrorText, eventHref, validateEventForm,
  type EventActionResult, type EventAnswer, type EventFormInput,
} from "./calendarEvents";

async function ctx(tenantId: string): Promise<{ userId: string; tenant: string } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Your session expired. Sign in again." };
  const me = await getMe(userId);
  if (!tenantId || !accessibleCompanies(me).some((c) => c.id === tenantId)) return { error: "Select a company first." };
  return { userId, tenant: tenantId };
}

const base = (t: string) => `/api/${encodeURIComponent(t)}/calendar/events`;

function detailOf(body: unknown): Record<string, unknown> | undefined {
  const d = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : undefined;
}

function refused(e: unknown, names: Record<string, string>, kind: "create" | "change" | "respond" = "change"): EventActionResult {
  if (e instanceof PlatformError) {
    return {
      ok: false,
      error: eventErrorText({ status: e.status, reason: e.reason ?? e.message, detail: detailOf(e.body) }, (id) => names[id], kind),
      ...(e.field ? { field: e.field } : {}),
    };
  }
  throw e;
}

function refresh() {
  revalidatePath("/calendar");
  revalidatePath("/");
}

/** `names` is the members list the page already holds (user id to name), so a 422 can say WHO. */
export async function createEventAction(tenantId: string, input: EventFormInput, names: Record<string, string> = {}): Promise<EventActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const v = validateEventForm(input, "create");
  if (!v.ok) return { ok: false, error: v.error, field: v.field };
  try {
    const ev = await platformFetch<{ id: string }>(base(c.tenant), c.userId, { method: "POST", body: JSON.stringify(v.payload) });
    refresh();
    return { ok: true, id: ev.id, href: eventHref(c.tenant, ev.id) };
  } catch (e) {
    return refused(e, names, "create");
  }
}

export async function updateEventAction(tenantId: string, id: string, input: EventFormInput, names: Record<string, string> = {}): Promise<EventActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  const v = validateEventForm(input, "edit");
  if (!v.ok) return { ok: false, error: v.error, field: v.field };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}`, c.userId, { method: "PATCH", body: JSON.stringify(v.payload) });
    refresh();
    return { ok: true, id, href: eventHref(c.tenant, id) };
  } catch (e) {
    return refused(e, names);
  }
}

export async function cancelEventAction(tenantId: string, id: string): Promise<EventActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/cancel`, c.userId, { method: "POST" });
    refresh();
    return { ok: true, id, href: eventHref(c.tenant, id) };
  } catch (e) {
    return refused(e, {});
  }
}

export async function respondEventAction(tenantId: string, id: string, response: EventAnswer): Promise<EventActionResult> {
  const c = await ctx(tenantId);
  if ("error" in c) return { ok: false, error: c.error };
  if (response !== "accepted" && response !== "tentative" && response !== "declined") return { ok: false, error: "Choose Accept, Maybe or Decline." };
  try {
    await platformFetch(`${base(c.tenant)}/${encodeURIComponent(id)}/respond`, c.userId, { method: "POST", body: JSON.stringify({ response }) });
    refresh();
    return { ok: true, id, href: eventHref(c.tenant, id) };
  } catch (e) {
    return refused(e, {}, "respond");
  }
}
