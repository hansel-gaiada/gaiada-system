// Shared route helpers (Nest port). authorize() now THROWS (Nest maps the exception to a
// status) instead of writing to a Fastify reply — the only behavioural change from the
// Fastify core, and it produces the identical 403/401 responses. writeActivity/notify are
// unchanged (framework-agnostic).
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { currentVia, currentApproval } from "./request-context";
import { assemblePrincipal, auditDecision, sessionVersionCurrent, type Principal } from "../rbac/principal";
import { check, type Resource } from "../rbac/cerbos";
import { mailIntake } from "../mail/intake";

/**
 * ── NAMING THE CAUSE WHEN AN UNRESOLVED ENVELOPE IS THE CAUSE (2026-08-24) ───────────────────────
 *
 * An OBO envelope the AuthGuard could not resolve degrades to `ANONYMOUS` — deliberately; see
 * `Principal.oboUnresolved`. The degrade was silent, so the FIRST evidence of a bad identifier was
 * `403 not authorized: cerbos denied read on portal`, which describes the symptom and points at the
 * wrong layer. Someone chasing it reads the policy for a resource that was never involved.
 *
 * The decision is untouched: this appends to the REASON, never to the outcome. An anonymous
 * principal denies exactly as it did before — the sentence just ends by saying why it was anonymous.
 * The original reason stays FIRST so anything matching on it (the audit trail, the bot's error
 * handling, tests) keeps matching.
 *
 * Exported for `obo-unresolved.test.ts`, which pins the wording without standing up Cerbos and a
 * database to reach `authorize()`'s deny branch.
 */
export function explainDenial(principal: Principal, reason: string): string {
  const u = principal.oboUnresolved;
  if (!u) return reason;
  const why = {
    "no-identity-link": "it is not enrolled",
    "link-unverified": "its enrollment was never verified",
    "user-inactive": "the user it points at is not active",
  }[u.reason];
  return (
    `${reason} — you were authorized as an ANONYMOUS principal because the identity envelope ` +
    `${u.provider}:${u.externalId} could not be resolved (${why}); this is an identity problem, not a policy one`
  );
}

/** RBAC gate: throws ForbiddenException (403) on deny, UnauthorizedException (401) on a
 *  revoked session for mutations (D11). Returns void on allow. */
export async function authorize(principal: Principal, resource: Resource, action: string): Promise<void> {
  const decision = await check(principal, resource, action);
  if (!decision.allow) {
    const reason = explainDenial(principal, decision.reason);
    await auditDecision(
      resource.tenantId ?? null, principal, action, resource.kind, resource.id ?? null, false, reason,
    );
    throw new ForbiddenException(`not authorized: ${reason}`);
  }

  // ── DELEGATION: THE SECOND CHECK (2026-08-22) ───────────────────────────────────────────────────
  // Owner-accepted model: effective permission = persona scope ∩ acting user's permissions. The
  // caller has just been authorized above; if this call is made ON BEHALF OF a human, that human must
  // independently be authorized for the SAME resource and action, and either denial refuses.
  //
  // ⚠ ORDER MATTERS FOR WHAT THE ERROR SAYS, NOT FOR THE OUTCOME. The caller is checked first so a
  // persona lacking the capability outright is refused for its OWN missing reach rather than
  // reporting a denial about the human — which would read as "Alice may not do this" when the truth
  // is "this persona may not, for anyone".
  //
  // ⚠ THE INTERSECTION IS THE SAFETY PROPERTY. This can only ever NARROW: both must allow, so
  // presenting an `actFor` never grants the caller anything it lacked. That is why the header behind
  // it is safe to accept from a first-party service, and it is pinned by test rather than asserted
  // here.
  if (principal.actFor && principal.actFor.userId !== principal.userId) {
    const onBehalfOf = await assemblePrincipal(principal.actFor.userId, principal.assurance);
    if (!onBehalfOf) {
      // An unresolvable acting user fails CLOSED. The alternative — proceeding with the caller's own
      // authority — would silently convert a delegated call into a full-authority one, which is the
      // exact escalation this field exists to prevent.
      await auditDecision(
        resource.tenantId ?? null, principal, action, resource.kind, resource.id ?? null, false,
        `act-for user not resolvable: ${principal.actFor.userId}`,
      );
      throw new ForbiddenException("not authorized: the user this call acts for is unknown or inactive");
    }
    // The acting user is checked WITHOUT `actFor`, or the recursion would never terminate. It also
    // carries the caller's `via`, so a denial audits with the same channel the caller arrived on.
    const delegated = await check({ ...onBehalfOf, via: principal.via }, resource, action);
    if (!delegated.allow) {
      await auditDecision(
        resource.tenantId ?? null, principal, action, resource.kind, resource.id ?? null, false,
        `act-for denied for ${principal.actFor.userId}: ${delegated.reason}`,
      );
      throw new ForbiddenException(`not authorized on behalf of that user: ${delegated.reason}`);
    }
    // ⚠ NO D11 SESSION CHECK FOR THE ACTING USER, AND ITS ABSENCE IS THE STRONGER GUARANTEE.
    // D11 exists because a principal assembled EARLIER (a live session, a long-lived token) can go
    // stale after a disable or role change, so its `session_version` is compared against the row. The
    // acting user's principal is assembled HERE, at decision time, from the database — so there is no
    // stale window to close and the comparison could never fail. Freshness is structural rather than
    // checked: a human who is disabled resolves to null and refuses above, and a human whose roles
    // shrank is denied by the check immediately above on the very next call.
    //
    // A `sessionVersionCurrent(onBehalfOf)` call here would look reassuring and assert nothing, which
    // is worse than no check at all — it would invite someone later to believe delegation had a
    // revocation path it does not need.
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
 *
 * ── GH-04 WIDENING (2026-08-31): `entityId` now accepts `null`, and the function now RETURNS the
 * generated row id ────────────────────────────────────────────────────────────────────────────────
 * Both are additive, not opt-in parameters — no existing call site changes shape or behaviour.
 *
 *  - `entityId: string | null`. Every pre-GH-04 caller passes a real DB row's uuid. GitHub's own
 *    per-repo registry (`github_repos`, GH-05) does not exist in this checkout, so a GitHub-op
 *    ledger row (core/github/ledger.ts) has no uuid to put here YET — and a non-uuid string (a repo
 *    `org/name`) would fail the column's uuid cast, not silently store wrong data. `null` is what
 *    the schema already allows (`target_entity_id uuid` — nullable); this only unlocks passing it.
 *    Once GH-05/06 land, a GitHub caller can pass the real `github_repos.id` and stop passing null.
 *  - Return type `Promise<string>`. §4.4 of the GitHub blueprint requires a commit trailer
 *    `Gaiada-Activity: <activities.id>` — the id of THIS row, minted before the GitHub call it
 *    records the attempt for. Returning the id `writeActivity` already generates (`newId()` below)
 *    is the correlation handle GH-04's ledger wrapper and GH-07's webhook reverse-mapping need; it
 *    costs nothing to callers that ignore the return value, which is all 263 of them today.
 */
export async function writeActivity(
  tenantId: string,
  actorId: string | null,
  verb: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<string> {
  const via = currentVia();
  const withVia = via && metadata.via === undefined ? { ...metadata, via } : metadata;
  // The APPROVAL behind this write, if one was required (202608261100). Ambient for the same reason
  // `via` is: this function has 263 call sites, and threading a parameter through them would make
  // attribution OPT-IN — whose failure mode is that the site somebody forgets is the site that
  // mattered, with nothing failing when they forget.
  //
  // NULL here is not "we lost it": it means no approval was required, which is the ordinary case.
  // The DB CHECK enforces the pairing (an approver without a channel is rejected), so a half-recorded
  // approval cannot be stored at all.
  const appr = currentApproval();
  const id = newId();
  await withTenants([tenantId], (c) =>
    c.query(
      `INSERT INTO activities (id, tenant_id, actor_id, verb, target_entity_type, target_entity_id, metadata, origin_site,
                               approved_by, approval_channel, executed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, tenantId, actorId, verb, entityType, entityId, JSON.stringify(withVia), config.originSite,
       appr?.approvedBy ?? null, appr?.channel ?? null, appr?.executedBy ?? null],
    ),
  );
  return id;
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
