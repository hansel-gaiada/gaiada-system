// Shared route helpers (Nest port). authorize() now THROWS (Nest maps the exception to a
// status) instead of writing to a Fastify reply — the only behavioural change from the
// Fastify core, and it produces the identical 403/401 responses. writeActivity/notify are
// unchanged (framework-agnostic).
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { currentVia } from "./request-context";
import { auditDecision, sessionVersionCurrent, type Principal } from "../rbac/principal";
import { check, type Resource } from "../rbac/cerbos";
import { mailIntake } from "../mail/intake";

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

/**
 * The audit row. ONE choke point, which is why [agent-attribution-gate]'s interim fix lands here.
 *
 * ── `via` IS STAMPED AMBIENTLY, NOT PASSED ───────────────────────────────────────────────────────
 * `actor_id` stays exactly what it was: the HUMAN. Authority, permission and accountability are
 * theirs, Cerbos decided on them, and an agent can never do what its principal could not. The agent
 * is recorded ALONGSIDE, in `metadata.via` — the owner's `Co-Authored-By` framing, where author and
 * co-author are different fields and the co-author never displaces the author.
 *
 * It comes from request context rather than a seventh parameter because this function has 263 call
 * sites. Threading it would have been ~229 mechanical edits AND would have made attribution opt-in —
 * and the failure mode of an opt-in audit field is that the site somebody forgets is the site that
 * mattered, with nothing failing when they forget. See `core/request-context.ts`.
 *
 * Outside a request scope (a consumer loop, a sweep, a unit test) `currentVia()` is undefined and this
 * writes precisely the row it always did. An attribution mechanism must never be able to break a
 * write; the most it may do is add nothing.
 *
 * A caller that passes its own `metadata.via` WINS — the executor re-driving an approved write knows
 * the original filing channel, which is better provenance than the channel of the retry.
 */
export async function writeActivity(
  tenantId: string,
  actorId: string | null,
  verb: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const via = currentVia();
  const withVia = via && metadata.via === undefined ? { ...metadata, via } : metadata;
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), tenantId, actorId, verb, entityType, entityId, JSON.stringify(withVia), config.originSite],
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

/** Best-effort in-app notification (5c.3); skips self and non-members.
 *
 *  MAIL-05 (design §7.2/A5): once the `notifications` row commits, this calls the mail tap
 *  (`mailIntake`) exactly once — the ENTIRE mail-triggering surface. It runs AFTER `withTenants`
 *  returns (so a mail failure can never roll back the notification insert — mail tables are
 *  GLOBAL and go through their own `withGlobal` connection regardless) and is wrapped in
 *  try/catch: a thrown mail error is logged loudly and NEVER rethrown, so it can never fail the
 *  write path that called `notify()` to announce itself (test-pinned in `src/mail/tap.test.ts`). */
export async function notify(
  tenantId: string,
  recipientId: string | null,
  actorId: string | null,
  type: string,
  payload: NotificationPayload = {},
): Promise<void> {
  if (!recipientId || recipientId === actorId) return;
  const notificationId = newId();
  const committed = await withTenants([tenantId], async (c) => {
    // The recipient must belong to this tenant — as staff/service (company_memberships) OR as an
    // external client portal contact (client_contacts, W0).
    //
    // WHY THE SECOND BRANCH EXISTS: this check used to be memberships-only and returned SILENTLY on
    // a miss — no error, no log. Client contacts are not company members, so **every** notification
    // addressed to a client vanished without trace. That is the precise failure the "clients are
    // notified and on the same page from the start" requirement exists to prevent, in its least
    // detectable form: the send looks successful at every call site.
    //
    // Kept as an EXISTS union rather than two queries so a recipient is admitted by either identity
    // without the caller having to know which kind of person it is addressing — every existing
    // notify() call site keeps working unchanged, and client-facing events reach clients for free.
    const member = await c.query(
      `SELECT 1 WHERE EXISTS (
         SELECT 1 FROM company_memberships
          WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'
       ) OR EXISTS (
         SELECT 1 FROM client_contacts
          WHERE user_id = $1 AND deleted_at IS NULL AND status = 'active'
       )`,
      [recipientId],
    );
    if (!member.rows[0]) return null;
    const typed: NotificationPayload = { title: titleFromType(type), ...payload };
    await c.query(
      `INSERT INTO notifications (id, tenant_id, user_id, type, payload, origin_site)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [notificationId, tenantId, recipientId, type, JSON.stringify({ ...typed, actorId }), config.originSite],
    );
    return typed;
  });
  if (!committed) return;
  try {
    await mailIntake({ notificationId, tenantId, userId: recipientId, type, payload: committed });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mail-intake] tap failed (type=${type}, recipient=${recipientId}):`, (err as Error)?.message ?? err);
  }
}
