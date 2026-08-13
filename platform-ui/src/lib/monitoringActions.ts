"use server";
// MON — the monitoring write path. Mirrors lib/checkinActions.ts's convention (session -> tenant ->
// platformFetch, PlatformError message surfaced verbatim to the form).
//
// RBAC gating here is defence-in-depth ONLY; Cerbos + RLS on platform-nest are the authority
// (`monitoring.write` for monitors/channels/routes/maintenance, `monitoring.ack` for incidents).
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
import { platformFetch, PlatformError } from "./platform";

export type MonitoringActionResult = { ok: boolean; error?: string; field?: string; id?: string };

async function ctx(formData: FormData): Promise<{ userId: string; tenantId: string } | MonitoringActionResult> {
  const userId = await getSessionUserId();
  if (!userId) return { ok: false, error: "Session expired — sign in again." };
  const tenantId = String(formData.get("tenantId") ?? "").trim();
  if (!tenantId) return { ok: false, error: "No active company selected." };
  return { userId, tenantId };
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
    revalidatePath("/monitoring");
    return { ok: true, id: res.id };
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
