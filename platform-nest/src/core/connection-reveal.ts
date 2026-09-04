// VLT-3 (docs/plans/2026-09-04-client-hosting-credential-vault.md) — the HUMAN credential-reveal
// path. Rated the highest-risk ticket in the set: every other ticket widens a CHECK or adds a
// pointer column; this one opens a deliberate ciphertext -> plaintext -> human's screen path.
//
// ── WHY THIS RIDES `automation_approvals`, NOT A NEW TABLE OR THE D14 HUB-REDRIVE REGISTRY ────────
// `core/approval-executables.ts`'s registry re-drives an approved write THROUGH mcp-hub
// (`core/approval-execute.ts#attemptRedrive`) — machinery built for an AUTOMATION/AGENT principal's
// suspended MCP TOOL CALL. A human clicking "reveal" in the ERP UI is not that: there is no tool call
// to re-drive, and re-driving through the hub would hand mcp-hub a job it must never have (touching
// the credential vault). The precedent for "an approval that is not automation/agent, executed
// in-band" already exists twice in this codebase — `admin/iam-approval-execute.ts` (IAM overrides)
// and `core/github/repo-creation.ts` (GH-12) — both execute synchronously inside
// `automation-approvals.controller.ts#decide()`, on a fresh `origin` value `isIamRequest`/
// `isGithubRepoCreationRequest` deliberately do NOT recognise, gated by a SECOND, narrower
// `authorize()` call against the resource actually being touched (not just the generic `decide`
// gate). This file follows that exact shape, with one necessary difference: GH-12/IAM execute the
// real effect (create a repo, grant a role) the MOMENT a human approves. A credential reveal cannot
// do that — the person who must receive the plaintext is the ORIGINAL REQUESTER, not the decider who
// approved on their behalf (WS4's whole point is a DIFFERENT person deciding). So decide() here only
// LIFTS the gate (mints a TTL'd, single-use redemption right); a SEPARATE, later call by the
// requester actually decrypts. See `redeemConnectionReveal` below for that half.
//
// ── WHERE THE TTL AND THE SINGLE-USE GUARANTEE LIVE, AND WHY NO NEW TABLE/COLUMN WAS ADDED ────────
// `automation_approvals` (0014 + 0078) already carries everything a TTL'd, single-use grant needs:
//   * `decided_at` — stamped by decide()'s own UPDATE. The grant's clock starts here.
//   * `execution_status` (`pending -> executing -> executed|failed`, 0078) — the SAME atomic
//     `UPDATE ... WHERE execution_status = 'pending'` claim `approval-execute.ts` already uses for
//     its own single-use guarantee is reused verbatim below. Exactly one caller can win the claim.
//   * `execution_result` — deliberately NEVER used to store the plaintext (see `redeemConnectionReveal`'s
//     own note): `detail()`/`list()` on `automation-approvals.controller.ts` return this column
//     verbatim to every principal with `read`, which is a strictly larger population than "the one
//     person who redeemed the grant". Putting a secret there would leak it to every company_admin/
//     manager/module_manager/module_staff who can view the approvals inbox.
// No migration was needed for any of this — deliberately: this ticket's brief forbids touching
// `platform-nest/migrations/` (a concurrent session owns schema this turn), and every column used
// here already shipped in 0014/0078.
//
// ── WHY NO NEW CERBOS ACTION (`reveal`) WAS MINTED ──────────────────────────────────────────────────
// The plan's own §4 anticipated a new `core.integration_connection.reveal` permission key, which is a
// ONE-LINE catalog diff in the abstract but is NOT free in practice: EVERY literal Cerbos action in
// this codebase requires a matching `permission-catalog.json` entry (`cerbos-catalog-alignment.test.ts`
// (b)) AND a migration seeding that key into `permissions`/`role_permissions`
// (`permission-catalog.db.test.ts`, `role-permission-parity.db.test.ts`) — see IAM-14c
// (202608230730) and WSK-31 (202608271700) for the two precedents that shipped exactly that pairing.
// There is no way to add a literal action without also adding a migration, and this ticket's brief
// says not to. So `reveal` REUSES the EXISTING, ALREADY-SHIPPED `core.integration_connection.manage`
// action (IAM-14c, company_admin/manager/owner/platform_admin — the "administer ANY connection in the
// company" tier) as the Cerbos gate, both for who may FILE a request (the existing `update`/`manage`
// per-row tier, via `connectionAction()`) and — more importantly — for who may DECIDE one (always
// `manage`, unconditionally, regardless of row ownership; see the decide() branch in
// `automation-approvals.controller.ts`). This is a real, load-bearing authorization check, not a
// placeholder — it is simply built from a key that already exists rather than a new one. The gap this
// leaves: `manage` also governs ordinary connection administration (renaming, revoking), so a role
// that should approve reveals but never edit connections cannot be expressed today. Flagged as a
// named follow-up (see this ticket's own report), not built quietly around.
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { withTenants } from "../db";
import { decryptSecret } from "./secret-box";

/** `automation_approvals.workflow_id` for this request kind. Mirrors `GITHUB_CREATE_REPO_WORKFLOW`'s
 *  own naming convention (`github/repo-creation.ts`). */
export const INTEGRATION_CONNECTION_REVEAL_WORKFLOW = "integration_connection:reveal";
export const INTEGRATION_CONNECTION_REVEAL_TOOL = "core.revealConnectionCredential";

/** Mirrors `isGithubRepoCreationRequest()`'s shape exactly: origin AND workflow_id must both match. */
export function isIntegrationConnectionRevealRequest(origin: string, workflowId: string | null): boolean {
  return origin === "credential_reveal" && workflowId === INTEGRATION_CONNECTION_REVEAL_WORKFLOW;
}

/** Default 15 minutes (the plan's stated default, §6 OQ-2.6.c). A `let`, not a `const`, ONLY so
 *  tests can drive a real, expired grant without a fake clock — mirrors `webdev.controller.ts`'s
 *  `setProvisionProviderForTests` test-seam idiom. Nothing in production ever calls the setter. */
let REVEAL_GRANT_TTL_MS = 15 * 60 * 1000;
export function setRevealGrantTtlMsForTests(ms: number | null): void {
  REVEAL_GRANT_TTL_MS = ms ?? 15 * 60 * 1000;
}
export function revealGrantTtlMs(): number {
  return REVEAL_GRANT_TTL_MS;
}

export type RevealDenialReason =
  | "no_such_grant"
  | "not_your_grant"
  | "grant_not_approved"
  | "grant_already_used"
  | "grant_expired"
  | "connection_gone"
  | "no_token_to_reveal";

export type RedeemOutcome =
  | { ok: true; value: string; revealedAt: string; connectionId: string }
  | { ok: false; reason: RevealDenialReason };

interface ApprovalGrantRow {
  id: string;
  origin: string;
  workflow_id: string | null;
  status: string;
  execution_status: string;
  requested_by: string | null;
  decided_at: Date | null;
  tool_args: unknown;
}

/** Redeem an approved reveal grant. ONE atomic transaction — claim, TTL check, decrypt, counters —
 *  so a crash mid-redeem rolls everything back to `pending` (never leaves the row wedged
 *  `executing` the way the network-bound D14 executor must; there is no network call here, so
 *  nothing forces a two-phase split). `FOR UPDATE` serializes concurrent redemption attempts on the
 *  SAME row through ordinary Postgres row locking — the second caller's `SELECT ... FOR UPDATE`
 *  blocks until the first transaction commits or rolls back, then observes the now-non-`pending`
 *  state and is refused. That is what makes single-use true even without the two-step claim pattern
 *  the hub-bound executor needs. */
export async function redeemConnectionReveal(
  tenantId: string,
  connectionId: string,
  approvalId: string,
  requesterId: string,
): Promise<RedeemOutcome> {
  return withTenants([tenantId], async (c) => {
    const found = await c.query<ApprovalGrantRow>(
      `SELECT id, origin, workflow_id, status, execution_status, requested_by, decided_at, tool_args
         FROM automation_approvals WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [approvalId],
    );
    const row = found.rows[0];
    if (!row || !isIntegrationConnectionRevealRequest(row.origin, row.workflow_id)) {
      return { ok: false, reason: "no_such_grant" as const };
    }
    const args = row.tool_args as { connectionId?: unknown } | null;
    if (args?.connectionId !== connectionId) {
      // The grant exists but was filed for a DIFFERENT connection — never bind a redemption to a
      // connection the approval never named. Reported the same as "doesn't exist" (no information
      // disclosure about a grant that isn't the caller's business).
      return { ok: false, reason: "no_such_grant" as const };
    }
    // Never self-grantable is enforced at decide() time (the decider check), but the requester
    // binding is enforced HERE too, independently: only the principal that FILED the request may
    // ever redeem it. Reported distinctly from "no such grant" so a caller who found someone else's
    // approvalId gets a loud 403, not a silent "file a new one" signal.
    if (row.requested_by !== requesterId) {
      return { ok: false, reason: "not_your_grant" as const };
    }
    if (row.status !== "approved") {
      return { ok: false, reason: "grant_not_approved" as const };
    }
    if (row.execution_status !== "pending") {
      // Either already consumed (`executed`), mid-flight (`executing` — cannot happen without a
      // concurrent caller inside this same locked row, which FOR UPDATE already serializes against),
      // or terminally `failed` (a prior expiry). All three mean: no plaintext, ever, a second time.
      return { ok: false, reason: "grant_already_used" as const };
    }
    const decidedAt = row.decided_at ? row.decided_at.getTime() : 0;
    if (!decidedAt || Date.now() - decidedAt > revealGrantTtlMs()) {
      await c.query(
        `UPDATE automation_approvals
            SET execution_status = 'failed', execution_error = 'grant_expired', updated_at = now()
          WHERE id = $1`,
        [approvalId],
      );
      return { ok: false, reason: "grant_expired" as const };
    }

    const conn = await c.query<{ access_token_enc: string | null }>(
      `SELECT access_token_enc FROM integration_connections WHERE id = $1 AND deleted_at IS NULL`,
      [connectionId],
    );
    if (!conn.rows[0]) return { ok: false, reason: "connection_gone" as const };
    const enc = conn.rows[0].access_token_enc;
    if (!enc) return { ok: false, reason: "no_token_to_reveal" as const };
    const plaintext = decryptSecret(enc);

    // `execution_result` NEVER carries the plaintext — see this file's header. Only a non-sensitive
    // marker, because the approvals list/detail endpoints return this column to every `read`-holding
    // principal, a strictly larger population than "the one person who just redeemed this grant".
    await c.query(
      `UPDATE automation_approvals
          SET execution_status = 'executed', executed_at = now(), executed_by = $2,
              execution_result = $3::jsonb, updated_at = now()
        WHERE id = $1`,
      [approvalId, requesterId, JSON.stringify({ revealed: true })],
    );
    await c.query(
      `UPDATE integration_connections
          SET last_revealed_at = now(), reveal_count = reveal_count + 1
        WHERE id = $1`,
      [connectionId],
    );

    return { ok: true, value: plaintext, revealedAt: new Date().toISOString(), connectionId };
  });
}

/** Maps a `RedeemOutcome`'s denial reason onto an HTTP exception. Kept as one function so the
 *  controller's `redeem()` handler and any future caller (e.g. a retry surface) throw identically. */
export function throwForRevealDenial(reason: RevealDenialReason): never {
  switch (reason) {
    case "no_such_grant":
    case "connection_gone":
      throw new NotFoundException(reason);
    case "not_your_grant":
      throw new ForbiddenException(reason);
    case "grant_not_approved":
    case "grant_already_used":
    case "grant_expired":
    case "no_token_to_reveal":
      throw new BadRequestException(reason);
    default: {
      const never: never = reason;
      throw new Error(`unhandled reveal denial reason: ${String(never)}`);
    }
  }
}
