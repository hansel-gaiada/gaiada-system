// PV5-14 / owner ruling PV-D40 (2026-10-13, interim for the dev stage): a SIMULATED second factor.
//
// Live Keycloak emits no `amr` claim, so `assuranceFor()` (./oidc.ts) never yields "high" and every
// high-assurance rule (PV-D26 bank details, finance tax configure and file, period close, AP release, ...)
// is unreachable for everyone. The owner ruled to KEEP those rules and to simulate the factor while live
// holds mock data: "skip mfa now ... simulate it, so we dont have to remove it but rather have buttons to
// simulate mfa. and we can proof the system works at the same time."
//
// So this file adds nothing to any policy. It adds one way of reaching the "high" tier the policies already
// read, and every property of that way is deliberately narrower than a real second factor:
//
//   * FLAG-GATED. `MFA_SIMULATION_ENABLED` (config.mfaSimulationEnabled), default OFF. Off, nothing here runs:
//     `applySimulatedStepUp` returns the principal untouched WITHOUT touching Redis, the routes answer 404 and
//     `authorize()` adds no hint. Behaviour is identical to the code before PV5-14.
//   * SESSION-BOUND. The step-up is keyed on the IdP SESSION (`sid`, or Keycloak's older `session_state`) of
//     the token that asked for it, hashed together with the user id. Those claims are inside the IdP's
//     signature, so a caller cannot name another session. Another browser of the SAME user is another IdP
//     session and stays "linked". A token with no session claim cannot be stepped up at all (fail closed).
//   * SHORT-LIVED. 15 minutes (STEP_UP_TTL_MS), checked against the stored `expiresAt` on every request (the
//     Redis TTL only collects garbage), so the clock seam below can prove the fall-back without waiting.
//   * STAFF, INTERACTIVE, HUMAN ONLY. Only a principal that arrived on the OIDC bearer path (an interactive
//     sign-in) can ask, and only `users.kind = 'employee'` with an ACTIVE staff membership. Portal (client)
//     principals, `automation` and `bot` accounts are refused. Anything arriving on the service-token paths
//     (an OBO envelope, an agent, a D14 re-drive, the dev x-user-id header) never has an IdP session, so it
//     can neither ask nor be stepped up: an agent never inherits a human's step-up.
//   * AUDITED AND LABELLED. Each step-up writes an `auth.step_up_simulated` activity row into every company
//     the person is staff of, logs `[auth:mfa-simulated]` once, and marks the principal
//     `assuranceSource: "simulated"` (sent to Cerbos alongside `assurance: "high"`, and returned by /api/me),
//     so nothing downstream can mistake it for a real second factor.
//
// A real `amr` login is untouched: it is "high" before this code runs, and this code only ever looks at a
// "linked" principal.
//
// Storage is Redis (REDIS_URL, the event backbone's server), one key per (user, IdP session). No table: the
// state is ephemeral by design and the audit lives in `activities`. Redis unavailable => no step-up (the
// POST answers 503; the per-request read fails closed to "linked").
import { createHash } from "node:crypto";
import { config } from "../config";
import { getRedis } from "../events/redis";
import type { Principal } from "../rbac/principal";
import { check, type Resource } from "../rbac/cerbos";

/** 15 minutes, per PV-D40 / the PV5-14 ticket. */
export const STEP_UP_TTL_MS = 15 * 60 * 1000;

const KEY_PREFIX = "auth:stepup:sim:v1:";

/** What a step-up record holds. `userId` is re-checked on read so a key can never lend its state to anyone else. */
export interface StepUpRecord {
  userId: string;
  expiresAt: string; // ISO
  createdAt: string; // ISO
}

// ── clock seam (tests prove the fall-back after expiry without waiting 15 minutes) ──────────────────────────
let clock: () => number = () => Date.now();
export function setStepUpClockForTest(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}
export function stepUpNow(): number {
  return clock();
}

/** The IdP session a verified token belongs to: Keycloak's `sid`, else the older `session_state`. Both are
 *  inside the token's signature. Null when neither is a non-empty string: such a token cannot be stepped up. */
export function sessionIdFromClaims(claims: Record<string, unknown>): string | null {
  for (const k of ["sid", "session_state"]) {
    const v = claims[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The opaque per-(user, IdP session) reference the step-up is bound to. Hashing keeps the raw session id out
 *  of Redis keys, logs and activity rows, and folds the user in so one session id can never serve two users. */
export function sessionRefFor(userId: string, sessionId: string): string {
  return createHash("sha256").update(`${userId}\n${sessionId}`).digest("hex");
}

const keyFor = (sessionRef: string) => `${KEY_PREFIX}${sessionRef}`;

/** Store a step-up for this (user, session). Throws if Redis is unavailable (the caller answers 503). */
export async function recordSimulatedStepUp(userId: string, sessionRef: string): Promise<StepUpRecord> {
  const now = stepUpNow();
  const rec: StepUpRecord = {
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + STEP_UP_TTL_MS).toISOString(),
  };
  // PX = the TTL, so a record is collected even if nothing reads it again. Validity is still decided by
  // `expiresAt` on read (readActiveStepUp), never by the TTL alone.
  await getRedis().set(keyFor(sessionRef), JSON.stringify(rec), "PX", STEP_UP_TTL_MS);
  return rec;
}

/** Remove a step-up (used to roll back when its audit row could not be written). Best effort. */
export async function clearSimulatedStepUp(sessionRef: string): Promise<void> {
  try {
    await getRedis().del(keyFor(sessionRef));
  } catch {
    /* best effort: the record expires on its own within STEP_UP_TTL_MS */
  }
}

/** The ACTIVE step-up for this (user, session), or null: absent, expired, unreadable, or for another user. */
export async function readActiveStepUp(userId: string, sessionRef: string): Promise<StepUpRecord | null> {
  let raw: string | null;
  try {
    raw = await getRedis().get(keyFor(sessionRef));
  } catch (e) {
    console.error(`[auth:step-up-store] could not read a simulated step-up (failing closed to "linked"): ${(e as Error).message}`);
    return null;
  }
  if (!raw) return null;
  let rec: StepUpRecord;
  try {
    rec = JSON.parse(raw) as StepUpRecord;
  } catch {
    return null;
  }
  if (rec?.userId !== userId) return null;
  const exp = Date.parse(rec.expiresAt);
  if (!Number.isFinite(exp) || exp <= stepUpNow()) return null;
  return rec;
}

/**
 * The ONLY place a simulated step-up raises assurance. Called by the OIDC path (./oidc.ts) after the principal
 * is assembled; every other path (OBO envelope, agent, D14 re-drive, dev header) never calls it.
 *
 * Returns the principal unchanged unless ALL hold: the flag is on; the principal is exactly "linked" (a real
 * `amr` "high" is never relabelled); it is a human employee (`kind === "employee"`); the token named an IdP
 * session; and an unexpired record for this (user, session) exists.
 */
export async function applySimulatedStepUp(principal: Principal, sessionRef: string | null): Promise<Principal> {
  if (!config.mfaSimulationEnabled) return principal;
  if (principal.assurance !== "linked") return principal;
  if (!principal.userId || !sessionRef) return principal;
  if (principal.kind !== "employee") return principal;
  const rec = await readActiveStepUp(principal.userId, sessionRef);
  if (!rec) return principal;
  return { ...principal, assurance: "high", assuranceSource: "simulated", assuranceExpiresAt: rec.expiresAt };
}

/**
 * PV5-14: does a Cerbos denial come down to ASSURANCE alone? `authorize()` (core/http.ts) asks this after a
 * denial so the 403 can carry `reason: "assurance_required"`, which is what lets the UI say "This action needs a
 * second factor" and offer the simulated one, instead of guessing from the caller's assurance.
 *
 * It re-asks Cerbos with the SAME principal and resource at "high". Authorization-neutral: the request is already
 * denied and stays denied; this only decides what the refusal SAYS. Asked only when the flag is on and only for
 * the principal a step-up could actually help (an interactive-looking "linked" employee with no agent or
 * delegation on it), so every other denial is byte-identical to before. Any error => false (plain refusal).
 */
export async function deniedOnlyForAssurance(principal: Principal, resource: Resource, action: string): Promise<boolean> {
  if (!config.mfaSimulationEnabled) return false;
  if (principal.assurance !== "linked" || !principal.userId || principal.kind !== "employee") return false;
  if (principal.via || principal.actFor) return false;
  try {
    return (await check({ ...principal, assurance: "high" }, resource, action)).allow;
  } catch {
    return false;
  }
}
