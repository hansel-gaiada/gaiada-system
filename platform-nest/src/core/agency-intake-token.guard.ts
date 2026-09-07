// AD-2 — IntakeTokenGuard. The prospect's ENTIRE authorization for the two routes in
// agency-intake-portal.controller.ts: a capability token, never a platform session.
//
// Design: docs/superpowers/plans/2026-09-05-agency-discovery-intake-design.md §2, §5.1.
//
// ── WHY THIS GUARD DOES NOT CALL Cerbos AND DOES NOT BUILD A Principal (design §5.1) ────────────────
// "The prospect is not a principal." Inventing a derived role for them (the way `client` is derived
// for the portal) would be the single most dangerous thing this feature could do — 0072:32 records
// that the `client` derived role satisfies exactly one policy file, and that invariant is easy to
// destroy silently by adding a second caller who is "sort of a client". So this guard's decision is
// binary and self-contained: the token is valid, unused (for THIS route — see below), unexpired,
// unrevoked, and names a real lead. Nothing here reads `rbac/cerbos.ts`, `rbac/principal.ts`, or
// touches `req.principal` at all — a handler behind this guard that later tried `authorize()` would
// crash on a missing principal, which is the correct failure mode, not a silent allow.
//
// ── THE :tenantId PATH SEGMENT IS A SCOPE, NOT A TRUSTED CLAIM ──────────────────────────────────────
// See agency-intake-tokens.service.ts's header for the full reasoning: the token is a flat opaque
// secret (design §2.2), `agency_intake_tokens` is FORCE-RLS tenant-walled with no cross-tenant
// bootstrap policy, so SOME tenant id must scope the lookup, and the route's own `:tenantId` segment
// (the same convention every `/api/:tenantId/*` route in this codebase uses) is the only value
// available before the token has been resolved. It authorizes nothing by itself: `tenantId` and
// `leadId` on `req.intakeToken` come from the RESOLVED ROW, never echoed from the path or the body,
// and a token that does not actually belong to the named tenant simply fails to resolve (RLS excludes
// the row), which reads identically to an unknown token — no existence oracle either way.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { findIntakeTokenByPlaintext, type IntakeTokenKind } from "./agency-intake-tokens.service";

/** Typed, not prose (agentic-native bar criterion 2 and 5 — design §8): a refusal must be a code a
 *  caller can branch on, never a message string to pattern-match. `open_intake_not_enabled` is its
 *  own reason rather than folded into `token_invalid` because the two causes want different next
 *  actions from an operator: "get a real token" vs. "this feature genuinely isn't available yet,
 *  see AD-9". */
export type IntakeAuthFailReason =
  | "token_missing"
  | "token_invalid"
  | "token_expired"
  | "token_used"
  | "token_revoked"
  | "open_intake_not_enabled";

/** Attached to the request by this guard, and read by the controller as the ONLY source of
 *  `tenantId`/`leadId`/`tokenId` for the write path — design §5.1's "0075 rule 1" applied to a
 *  caller who is not even a user. The controller must never re-derive these from the body or from
 *  `:tenantId` directly (that param is this guard's OWN scoping input, already validated against
 *  the resolved row by construction: RLS guarantees `row.tenantId === the :tenantId this guard used`
 *  or the row would never have been found at all). */
export interface IntakeContext {
  tokenId: string;
  tenantId: string;
  leadId: string | null;
  kind: IntakeTokenKind;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Carried through for the controller's own logging/decisions; NEVER used by this guard to hard
   *  -refuse a POST — see the canActivate note below for why that would break design §6.1's
   *  idempotent-retry contract. */
  usedAt: string | null;
}

export interface IntakeRequest extends FastifyRequest {
  intakeToken: IntakeContext;
}

function typedRefusal(reason: IntakeAuthFailReason): never {
  if (reason === "open_intake_not_enabled") {
    // A real, understood capability, not a 401 — the caller successfully named a live 'open' token
    // row; the feature it wants is simply not turned on in v1 (design §2.1, AD-9).
    throw new ForbiddenException({
      statusCode: 403, reason, message: `${reason}: kind="open" intake is schema-admitted but v1's endpoint refuses it (see AD-9)`,
    });
  }
  throw new UnauthorizedException({ statusCode: 401, reason, message: reason });
}

@Injectable()
export class IntakeTokenGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<IntakeRequest>();

    // Design §2.2: the header ONLY, never a query parameter (nginx access logs, Referer headers on
    // any outbound link from the page, browser history). The prospect page reads the token from the
    // URL FRAGMENT (never sent to a server) and replays it here — that half is the frontend's job
    // (design §9.1), not this guard's, but the guard is the enforcement point for "never accept it
    // any other way".
    const header = req.headers["x-intake-token"];
    const plaintext = Array.isArray(header) ? header[0] : header;
    if (!plaintext) typedRefusal("token_missing");

    const tenantId = (req.params as Record<string, string> | undefined)?.tenantId;
    // Malformed routing (no :tenantId segment matched) can't happen through this controller's own
    // route declarations, but this guard must never assume its own wiring — refuse rather than call
    // findIntakeTokenByPlaintext with an empty scope, which withTenants([""], ...) would reject with
    // an unrelated database error instead of a typed refusal.
    if (!tenantId) typedRefusal("token_invalid");

    const row = await findIntakeTokenByPlaintext(tenantId, plaintext);
    if (!row) typedRefusal("token_invalid");
    if (row.kind === "open") typedRefusal("open_intake_not_enabled");
    if (row.revokedAt) typedRefusal("token_revoked");
    if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) typedRefusal("token_expired");

    // ── `token_used` IS DELIBERATELY NOT ENFORCED HERE FOR A POST ─────────────────────────────────
    // The submit route's OWN transaction re-reads `used_at` UNDER an advisory lock (design §6.1) and
    // returns 200 with the EXISTING submission id when it finds the token already used — that is the
    // deliberate idempotent-retry path for a double-click or a network retry after a dropped
    // response, and it is explicitly NOT an error (§6.1: "a retry is not an error"). This guard's own
    // read runs BEFORE that lock and is therefore only ever a stale-or-current snapshot, never the
    // authoritative one (the exact DEF-2 shape pipeline-lock.ts:17-25 documents: a check outside the
    // lock changes nothing about what happens inside it). If this guard hard-refused every POST
    // against an already-used token, a legitimate retry arriving after the first request's commit
    // would get 401 `token_used` instead of the 200 design §6.1 requires — silently breaking the one
    // behaviour that section exists to guarantee.
    //
    // For every OTHER method (today: the questionnaire GET) there is no such contract to protect, and
    // refusing typed `token_used` is the more honest answer than quietly serving the question set to
    // a token that has already done its one job.
    if (row.usedAt && req.method !== "POST") typedRefusal("token_used");

    req.intakeToken = {
      tokenId: row.id, tenantId: row.tenantId, leadId: row.leadId, kind: row.kind,
      expiresAt: row.expiresAt, revokedAt: row.revokedAt, usedAt: row.usedAt,
    };
    return true;
  }
}
