// Shared route helpers (Nest port). authorize() now THROWS (Nest maps the exception to a
// status) instead of writing to a Fastify reply — the only behavioural change from the
// Fastify core, and it produces the identical 403/401 responses. writeActivity/notify are
// unchanged (framework-agnostic).
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { auditDecision, sessionVersionCurrent, type Principal } from "../rbac/principal";
import { check, type Resource } from "../rbac/cerbos";

/** RBAC gate: throws ForbiddenException (403) on deny, UnauthorizedException (401) on a
 *  revoked session for mutations (D11). Returns void on allow. */
export async function authorize(principal: Principal, resource: Resource, action: string): Promise<void> {
  const decision = await check(principal, resource, action);
  if (!decision.allow) {
    await auditDecision(
      resource.tenantId ?? null, principal, action, resource.kind, resource.id ?? null, false, decision.reason,
    );
    throw new ForbiddenException(`not authorized: ${decision.reason}`);
  }
  if (action !== "read" && !(await sessionVersionCurrent(principal))) {
    throw new UnauthorizedException("session revoked — re-authenticate");
  }
}

export async function writeActivity(
  tenantId: string,
  actorId: string | null,
  verb: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), tenantId, actorId, verb, entityType, entityId, JSON.stringify(metadata), config.originSite],
    ),
  );
}

/** Typed notification payload contract (WSUX-4; FRONTEND-BFF-CONTRACT §9(c)): every notification
 *  row's `payload` carries `{title, href, body?, entityType?, entityId?, severity?}` so the UI
 *  never has to guess a title or re-derive a deep-link route. Additive — extra legacy keys
 *  (e.g. `commentId`, `decision`, `approvalId`) may still ride alongside for callers that read
 *  them directly; nothing is removed from the bag, only the typed fields are now guaranteed. */
export interface NotificationPayload extends Record<string, unknown> {
  title?: string;
  href?: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  severity?: "info" | "warning" | "critical";
}

/** Humanizes a notification `type` ("hr.leave.decided" -> "Hr Leave Decided") as the fallback
 *  title for callers that don't supply one (chiefly the generic elevated-actor passthrough
 *  below) — every notification ships with a non-empty title, never an opaque bag. */
function titleFromType(type: string): string {
  return type
    .replace(/[_.]/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || "Notification";
}

/** Best-effort in-app notification (5c.3); skips self and non-members. */
export async function notify(
  tenantId: string,
  recipientId: string | null,
  actorId: string | null,
  type: string,
  payload: NotificationPayload = {},
): Promise<void> {
  if (!recipientId || recipientId === actorId) return;
  await withTenants([tenantId], async (c) => {
    const member = await c.query(
      `SELECT 1 FROM company_memberships WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'`,
      [recipientId],
    );
    if (!member.rows[0]) return;
    const typed: NotificationPayload = { title: titleFromType(type), ...payload };
    await c.query(
      `INSERT INTO notifications (id, tenant_id, user_id, type, payload, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), tenantId, recipientId, type, JSON.stringify({ ...typed, actorId }), config.originSite],
    );
  });
}
