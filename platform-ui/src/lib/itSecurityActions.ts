"use server";
// DW-7h (BFF §52.7): the three writes on IT > Network: sign a session out, block an address, lift a block.
//
// Same `ctx()`/`send()` convention as `financeAccountActions.ts` (session -> tenant -> platformFetch). A "use server" file may
// export only async functions and types, so the words and limits live in `itSecurityView.ts` and the shapes in `itSecurity.ts`.
//
// ── THE SERVER IS THE BOUNDARY, THIS FILE ONLY PUTS ITS ANSWERS IN WORDS ───────────────────────────────────────
// All three are `it_account` `disable` (PERMISSION-CONTRACT §42). The routes themselves refuse ending your own session,
// blocking your own address, a private address, and an address that three or more of the company's people use unless
// `confirmShared` is set. Those refusals carry the server's own sentence and a machine `reason`, and are passed through
// untouched: a second copy of the rules here is a second thing to drift, and `reason` is what a form branches on.
//
// `shared_address` (409) is the one a form answers: it carries `detail.users`, how many people connected from that address in
// the last 24 hours, so the form can ask "N people use this address, block anyway?" and send the same request again with
// `confirmShared`.
//
// The only checks made here are the shape ones the server makes first, so a blank form never costs a round trip.
import { revalidatePath } from "next/cache";
import { getSessionUserId } from "./session-server";
import { getMe, platformFetch, PlatformError } from "./platform";
import { getActiveTenant } from "./tenant";
import { canManageIT } from "./rbac";
import type { IpBlock } from "./itSecurity";

export type SecurityActionResult<T> =
  | { ok: true; result: T }
  | {
    ok: false;
    /** The server's own sentence, or ours for a refusal made before a request. */
    error: string;
    /** The machine code (`shared_address`, `blocks_yourself`, `revokes_yourself`, `already_blocked`, `not_active`, ...). */
    reason?: string;
    field?: string;
    /** `shared_address` only: how many of the company's people connected from that address in the last 24 hours. */
    users?: number;
  };

export type RevokeResult = { revoked: true; keycloak: "ended" | "not_found" | "failed" };

export interface BlockAddressInput {
  ip: string;
  reason: string;
  /** 1 to 720; 24 when left out. */
  hours?: number;
  /** Set only after the form has shown the `shared_address` question and the person said yes. */
  confirmShared?: boolean;
}

async function ctx(): Promise<{ userId: string; tenant: string; me: Awaited<ReturnType<typeof getMe>> } | { error: string }> {
  const userId = await getSessionUserId();
  if (!userId) return { error: "Session expired — sign in again." };
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return { error: "No active company selected." };
  return { userId, tenant, me };
}

/** `detail.users` rides the raw body of the 409 (`PlatformError.body`); read only what is the right shape. */
function usersOf(body: unknown): number | undefined {
  const users = (body as { detail?: { users?: unknown } } | null | undefined)?.detail?.users;
  return typeof users === "number" && Number.isFinite(users) ? users : undefined;
}

async function send<T>(path: string, body: unknown | undefined, what: string): Promise<SecurityActionResult<T>> {
  const c = await ctx();
  if ("error" in c) return { ok: false, error: c.error };
  // Defence in depth only (the `it.manage` the registry and the pages use): Cerbos decides, and a 403 below is said in words.
  if (!canManageIT(c.me, c.tenant)) return { ok: false, error: `You don't have permission to ${what}.` };
  try {
    const result = await platformFetch<T>(`/api/${c.tenant}/it/security${path}`, c.userId, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Every row on the four pages is re-read from the server after a write; none is carried over from this answer.
    revalidatePath("/it/network", "layout");
    return { ok: true, result };
  } catch (e) {
    if (e instanceof PlatformError) {
      if (e.status === 403) {
        return { ok: false, error: `You don't have permission to ${what}.`, ...(e.reason ? { reason: e.reason } : {}) };
      }
      const users = usersOf(e.body);
      return {
        ok: false,
        error: e.message,
        ...(e.reason ? { reason: e.reason } : {}),
        ...(e.field ? { field: e.field } : {}),
        ...(users !== undefined ? { users } : {}),
      };
    }
    // A timeout or a dropped connection: say so, and let the person try again.
    return { ok: false, error: "The request did not go through. Check your connection and try again." };
  }
}

/**
 * Sign a session out: `POST it/security/sessions/:sessionId/revoke` -> 200 `{revoked: true, keycloak}`. It is `revoked: true` even
 * when the identity provider failed, because the row alone cuts the ERP within 10 seconds; `keycloak` says what it did.
 * Refused: 404 (that session of that person was never seen here), 409 `revokes_yourself`.
 */
export async function revokeSession(userId: string, sessionId: string, reason?: string): Promise<SecurityActionResult<RevokeResult>> {
  if (!userId) return { ok: false, error: "Choose a person." };
  // A token with no `sid` is recorded as '' and cannot be addressed by a path; the person's login can be blocked instead.
  if (!sessionId) return { ok: false, error: "This connection has no session id, so it cannot be signed out one by one. Block the person's login in IT accounts instead." };
  const why = (reason ?? "").trim();
  return send(`/sessions/${encodeURIComponent(sessionId)}/revoke`, { userId, ...(why ? { reason: why } : {}) }, "sign people out");
}

/**
 * Block an address from this company's data: `POST it/security/blocks` -> 201 `IpBlock`. Refused: 400 (an invalid, private,
 * loopback or link-local address), 409 `blocks_yourself`, 409 `already_blocked` and 409 `shared_address` (with `users`), which
 * the form answers by asking and sending again with `confirmShared: true`.
 */
export async function blockAddress(input: BlockAddressInput): Promise<SecurityActionResult<IpBlock>> {
  const ip = (input.ip ?? "").trim();
  if (!ip) return { ok: false, error: "Enter the address to block.", field: "ip" };
  const reason = (input.reason ?? "").trim();
  if (reason.length < 3) return { ok: false, error: "Say why in a few words. The reason is kept with the block.", field: "reason" };
  if (reason.length > 500) return { ok: false, error: "The reason is at most 500 characters.", field: "reason" };
  const hours = input.hours ?? 24;
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) return { ok: false, error: "A block lasts 1 to 720 hours.", field: "hours" };
  return send("/blocks", { ip, reason, hours, ...(input.confirmShared ? { confirmShared: true } : {}) }, "block addresses");
}

/** Lift a block: `POST it/security/blocks/:blockId/lift` -> 200 `IpBlock`. Refused: 404, 409 `not_active` (already lifted or expired). */
export async function liftBlock(blockId: string): Promise<SecurityActionResult<IpBlock>> {
  if (!blockId) return { ok: false, error: "Choose a block." };
  return send(`/blocks/${encodeURIComponent(blockId)}/lift`, undefined, "lift blocks");
}
