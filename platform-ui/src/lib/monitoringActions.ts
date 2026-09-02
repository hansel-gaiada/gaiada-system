"use server";
// MON — the monitoring write path. Mirrors lib/checkinActions.ts's convention (session -> tenant ->
// platformFetch, PlatformError message surfaced verbatim to the form).
//
// RBAC gating here is defence-in-depth ONLY; Cerbos + RLS on platform-nest are the authority
// (`monitoring.monitor.*` for monitors, `monitoring.incident.acknowledge` for incidents,
// `monitoring.channel.manage` for channels/routes/test-send, `monitoring.maintenance.create`/
// `.delete` for maintenance windows — see rbac.ts's MON-20 capability comments for the exact keys).
// Same shape as webdevProvisionedSitesActions.ts: `ctx()` resolves session -> `me` -> tenant, and
// each write checks `can(c.me, …, c.tenantId)` before ever reaching the network — a hidden button
// that a user could still POST past would be worse than no gate at all.
//
// ── TWO RULES THAT ARE NOT STYLE ───────────────────────────────────────────────────────────────
// 1. A monitor definition written here by a verified human IS the standing authorization for the
//    platform to probe that target on a schedule (monitoring-program.md §4.3). It is NOT
//    authorization to do anything TO the target. No action in this file may ever grow into
//    "restart the client's server" — that belongs behind a D14 approval, not behind a form post.
// 2. `testChannel` sends a REAL notification to a REAL destination. It is the only action here with
//    an outward side effect, so it is rate-limited server-side and never fires implicitly on save.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError, type Me } from "./platform";
import { can } from "./rbac";

export type MonitoringActionResult = { ok: boolean; error?: string; field?: string; id?: string };

async function ctx(formData: FormData): Promise<{ userId: string; tenantId: string; me: Me } | MonitoringActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const tenantId = String(formData.get("tenantId") ?? "").trim();
  if (!tenantId) return { ok: false, error: "No active company selected." };
  const me = await getMe(userId);
  return { userId, tenantId, me };
}

function fail(e: unknown): MonitoringActionResult {
  if (e instanceof PlatformError) return { ok: false, error: e.message, field: e.field };
  throw e;
}

export async function createMonitor(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the monitor a name.", field: "name" };
  const kind = String(formData.get("kind") ?? "").trim();
  if (!kind) return { ok: false, error: "Choose what to check.", field: "kind" };
  const clientId = String(formData.get("clientId") ?? "").trim();
  if (!clientId) return { ok: false, error: "A monitor must belong to a client.", field: "clientId" };

  // `target` is optional only for `heartbeat`, which has no outbound target by definition — the job
  // pushes to us. Every other kind without a target would silently probe nothing and report "up".
  const target = String(formData.get("target") ?? "").trim();
  if (!target && kind !== "heartbeat") {
    return { ok: false, error: "Enter what to check (URL, host, or host:port).", field: "target" };
  }

  const intervalSec = Number(formData.get("intervalSec") ?? "60");
  if (!Number.isFinite(intervalSec) || intervalSec < 20) {
    return { ok: false, error: "Interval must be at least 20 seconds.", field: "intervalSec" };
  }

  const expect = String(formData.get("expectText") ?? "").trim();
  if (kind === "keyword" && !expect) {
    return { ok: false, error: "A content check needs the text it should find.", field: "expectText" };
  }

  try {
    const res = await platformFetch<{ id: string }>(`/api/${c.tenantId}/monitoring/monitors`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        name,
        kind,
        clientId,
        target: target || null,
        intervalSec,
        severity: String(formData.get("severity") ?? "ticket"),
        // The backend validates this against the driver's declared capabilities and refuses an
        // assertion the chosen kind cannot evaluate — a silently-ignored assertion would make a
        // monitor report "up" for a condition it never actually checked.
        assertions: expect ? [{ type: "body_contains", expr: expect }] : [],
      }),
    });
    revalidatePath("/monitoring");
    return { ok: true, id: res.id };
  } catch (e) {
    return fail(e);
  }
}

export async function acknowledgeIncident(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  const id = String(formData.get("incidentId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing incident." };
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/incidents/${id}/ack`, c.userId, { method: "POST" });
    revalidatePath("/monitoring");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function scheduleMaintenance(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.maintenance.create", c.tenantId)) {
    return { ok: false, error: "You don't have permission to schedule a maintenance window." };
  }

  const startsAt = String(formData.get("startsAt") ?? "").trim();
  const endsAt = String(formData.get("endsAt") ?? "").trim();
  if (!startsAt || !endsAt) return { ok: false, error: "Set both a start and an end.", field: "startsAt" };
  // A window with no end is how alerting gets muted permanently — the exact failure K7 exists to
  // prevent. An inverted range would do the same thing by accident.
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return { ok: false, error: "The window must end after it starts.", field: "endsAt" };
  }

  try {
    const res = await platformFetch<{ id: string }>(`/api/${c.tenantId}/monitoring/maintenance`, c.userId, {
      method: "POST",
      body: JSON.stringify({
        scope: String(formData.get("scope") ?? "").trim() || "all",
        startsAt,
        endsAt,
        reason: String(formData.get("reason") ?? "").trim() || null,
      }),
    });
    revalidatePath("/monitoring/maintenance");
    revalidatePath("/monitoring");
    return { ok: true, id: res.id };
  } catch (e) {
    return fail(e);
  }
}

/** Cancels a window early — ends suppression, which is why `.delete` is NOT sensitive server-side
 *  (the concealing direction, `.create`, is the one that is). See rbac.ts's capability comment. */
export async function deleteMaintenance(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.maintenance.delete", c.tenantId)) {
    return { ok: false, error: "You don't have permission to cancel a maintenance window." };
  }
  const id = String(formData.get("windowId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing window." };
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/maintenance/${id}`, c.userId, { method: "DELETE" });
    revalidatePath("/monitoring/maintenance");
    revalidatePath("/monitoring");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Fires a real notification down a real channel. Deliberately a separate, explicit action rather
 * than something `saveChannel` does automatically: a config form that silently pages the on-call
 * every time someone opens it trains people to ignore the pager.
 */
export async function testChannel(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to send a test notification." };
  }
  const id = String(formData.get("channelId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing channel." };
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/channels/${id}/test`, c.userId, { method: "POST" });
    revalidatePath("/monitoring/channels");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

// ── MON-20 — channel + route CRUD. Closes the ticket's actual defect: alert delivery has always
// worked once a channel and a route exist, but nothing let a human create either. ─────────────────

/** Creates a channel when `channelId` is absent, edits it in place otherwise — one form, one action,
 *  same convention `createMonitor`/PATCH-style editors elsewhere in the app use. */
export async function saveChannel(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to manage alert channels." };
  }

  const id = String(formData.get("channelId") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Give the channel a name.", field: "name" };
  const kind = String(formData.get("kind") ?? "").trim();
  if (!kind) return { ok: false, error: "Choose a channel kind.", field: "kind" };
  const destination = String(formData.get("destination") ?? "").trim();
  if (!destination) {
    return { ok: false, error: "Enter where this channel delivers to.", field: "destination" };
  }
  const enabled = formData.get("enabled") === "on";

  try {
    const body = JSON.stringify({ kind, name, destination, enabled });
    let savedId = id;
    if (id) {
      await platformFetch(`/api/${c.tenantId}/monitoring/channels/${id}`, c.userId, { method: "PATCH", body });
    } else {
      const res = await platformFetch<{ id: string }>(`/api/${c.tenantId}/monitoring/channels`, c.userId, {
        method: "POST",
        body,
      });
      savedId = res.id;
    }
    revalidatePath("/monitoring/channels");
    return { ok: true, id: savedId };
  } catch (e) {
    return fail(e);
  }
}

/** Quick enable/disable toggle from the channel list — does not require opening the edit form.
 *  A disabled channel is not deleted: its config, health history and routes all survive, which is
 *  what makes "pause this over the client's maintenance window" different from removing it. */
export async function setChannelEnabled(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to manage alert channels." };
  }
  const id = String(formData.get("channelId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing channel." };
  const enabled = formData.get("enabled") === "true";
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/channels/${id}`, c.userId, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    revalidatePath("/monitoring/channels");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteChannel(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to manage alert channels." };
  }
  const id = String(formData.get("channelId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing channel." };
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/channels/${id}`, c.userId, { method: "DELETE" });
    revalidatePath("/monitoring/channels");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Creates or edits a route — the filter that decides which incidents reach which channel. No route
 * pointing at a channel means that channel delivers nothing, which is the exact "configured, never
 * used" quiet failure `/monitoring/channels` already computes an `unrouted` warning for; this is
 * what lets someone actually fix that warning instead of just reading it.
 */
export async function saveRoute(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  // No separate "route" permission exists in the backend's catalog — routes authorize under the
  // `monitor_channel` Cerbos kind (confirmed by the backend implementation), so this rides
  // `monitoring.channel.manage`. See rbac.ts.
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to manage alert routing." };
  }

  const id = String(formData.get("routeId") ?? "").trim();
  const channelId = String(formData.get("channelId") ?? "").trim();
  if (!channelId) return { ok: false, error: "Choose which channel this route delivers to.", field: "channelId" };
  const matchClientId = String(formData.get("matchClientId") ?? "").trim() || null;
  const matchSeverity = String(formData.get("matchSeverity") ?? "").trim() || null;
  const matchKind = String(formData.get("matchKind") ?? "").trim() || null;
  const enabled = formData.get("enabled") === "on";

  try {
    const body = JSON.stringify({ channelId, matchClientId, matchSeverity, matchKind, enabled });
    let savedId = id;
    if (id) {
      await platformFetch(`/api/${c.tenantId}/monitoring/routes/${id}`, c.userId, { method: "PATCH", body });
    } else {
      const res = await platformFetch<{ id: string }>(`/api/${c.tenantId}/monitoring/routes`, c.userId, {
        method: "POST",
        body,
      });
      savedId = res.id;
    }
    revalidatePath("/monitoring/channels");
    return { ok: true, id: savedId };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteRoute(formData: FormData): Promise<MonitoringActionResult> {
  const c = await ctx(formData);
  if ("ok" in c) return c;
  if (!can(c.me, "monitoring.channel.manage", c.tenantId)) {
    return { ok: false, error: "You don't have permission to manage alert routing." };
  }
  const id = String(formData.get("routeId") ?? "").trim();
  if (!id) return { ok: false, error: "Missing route." };
  try {
    await platformFetch(`/api/${c.tenantId}/monitoring/routes/${id}`, c.userId, { method: "DELETE" });
    revalidatePath("/monitoring/channels");
    return { ok: true, id };
  } catch (e) {
    return fail(e);
  }
}
