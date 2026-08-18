// P2-09 — the expiry sweep, and the loop that starts the position drift sweep.
//
// Design: docs/superpowers/plans/2026-08-13-iam-phase2-design.md §3.4 (drift detector + expiry
// sweep). P2-05 built `sweepPositionDrift()` but left it unstarted; P2-08 started WRITING
// `user_roles.expires_at` and explicitly recorded that nothing acts on it yet. This file closes both
// halves, in that order of importance:
//
// ── WHY THE EXPIRY HALF IS NOT COSMETIC ────────────────────────────────────────────────────────
// `assemblePrincipal()` does NOT filter on `expires_at` — a grant with a past expiry is fully live
// until a row is deleted. So before this file, "expires_at is set" meant nothing at all: a temporary
// grant was permanent, and an override with a 90-day box was forever. Anything that WRITES an expiry
// without something that ENFORCES it is a half-built guarantee, which is the failure mode this
// program keeps finding, so the sweep ships in the same session as the writer.
//
// ⚠ It remains a SWEEP, not a filter: between the moment a grant expires and the next tick, the
// grant is still live. The durable fix is a resolution-time filter in `assemblePrincipal()` (one
// `AND (expires_at IS NULL OR expires_at > now())`), which belongs with IAM-SEC-06's
// resolution-source filter rather than here — recorded, not assumed away. The sweep is what makes
// the expiry real and audited; the filter would make it instant.
import { withGlobal, withTenants } from "../db";
import { config } from "../config";
import { emitEvent } from "../events/outbox.service";
import { revokeGrantById } from "./grant-write.service";
import { sweepPositionDrift } from "./position-reconciler";

export interface ExpirySweepResult {
  expired: number;
  revoked: number;
  usersBumped: number;
}

/**
 * Revoke every `user_roles` row whose `expires_at` has passed, bump each affected user's session,
 * and audit it. Routed through P2-04's choke point (`revokeGrantById`) rather than a bespoke DELETE,
 * so the writer-guard suite stays true and there is still exactly one deleting statement.
 *
 * Deliberately does NOT touch reconciler-managed rows: `managed_by`/`managed_by_position` grants are
 * owned by their reconciler, which would restore them on the next pass — and neither reconciler sets
 * an expiry, so such a row would be a bug elsewhere, not something for this sweep to paper over. It
 * is reported instead.
 */
export async function sweepExpiredGrants(): Promise<ExpirySweepResult> {
  const due = await withGlobal((c) =>
    c.query<{
      id: string; user_id: string; role: string; scope_type: string; scope_id: string | null;
      managed_by: string | null; managed_by_position: string | null; origin_approval_id: string | null;
    }>(
      `SELECT ur.id, ur.user_id, r.name AS role, ur.scope_type, ur.scope_id,
              ur.managed_by, ur.managed_by_position, ur.origin_approval_id
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
        WHERE ur.expires_at IS NOT NULL AND ur.expires_at <= now()
        ORDER BY ur.expires_at`,
    ),
  );

  let revoked = 0;
  const bumped = new Set<string>();
  const skippedManaged: string[] = [];

  for (const row of due.rows) {
    if (row.managed_by || row.managed_by_position) {
      skippedManaged.push(row.id);
      continue;
    }
    const deleted = await withGlobal((c) => revokeGrantById(c, row.id, row.user_id));
    if (!deleted) continue;
    revoked++;
    bumped.add(row.user_id);
    // The audit trail lands in the tenant's own outbox when the grant is tenant-scoped; a global or
    // org-unit-scoped expiry has no single tenant to file under, so it is logged instead of being
    // filed against a tenant it does not belong to.
    if (row.scope_type === "company" && row.scope_id) {
      await withTenants([row.scope_id], (c) =>
        emitEvent(c, row.scope_id!, "role_grant", row.id, "role_grant.expired", {
          userId: row.user_id, role: row.role, scopeType: row.scope_type, scopeId: row.scope_id,
          originApprovalId: row.origin_approval_id,
        }),
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[GRANT-EXPIRY-SWEEP] revoked non-company-scoped grant ${row.id} (${row.role} @ ` +
          `${row.scope_type}:${row.scope_id ?? "null"}) for user ${row.user_id} — no tenant outbox to file under`,
      );
    }
  }

  for (const userId of bumped) {
    await withGlobal((c) =>
      c.query(`UPDATE users SET session_version = session_version + 1, updated_at = now() WHERE id = $1`, [userId]),
    );
  }

  if (skippedManaged.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[GRANT-EXPIRY-SWEEP] ${skippedManaged.length} EXPIRED grant(s) are reconciler-managed and were ` +
        `left alone (a managed grant should never carry an expiry — investigate the writer): ` +
        `${skippedManaged.join(", ")}`,
    );
  }

  return { expired: due.rows.length, revoked, usersBumped: bumped.size };
}

/**
 * The P2-09 loop: the position drift sweep (P2-05's, previously never started) plus the expiry sweep
 * above, on one timer. Same shape as `startDriftSweepLoop` (the service reconciler's) — a
 * self-rescheduling `setTimeout` chain rather than `setInterval`, so a slow tick cannot overlap
 * itself.
 *
 * Gated on `positionSyncEnabled` by the callers it invokes: `sweepPositionDrift()` returns zeroes
 * when the flag is off. The EXPIRY sweep is deliberately NOT flag-gated — expiries are written by
 * P2-08's grant surface, which is not behind the position flag, so gating the sweep on it would leave
 * expired grants live in exactly the configuration that can create them.
 */
export function startPositionMaintenanceLoop(intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (stopped) return;
    try {
      const expiry = await sweepExpiredGrants();
      if (expiry.revoked > 0) {
        // eslint-disable-next-line no-console
        console.warn("[GRANT-EXPIRY-SWEEP] expired grants revoked:", expiry);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("grant expiry sweep tick failed:", (err as Error).message);
    }
    try {
      const drift = await sweepPositionDrift();
      if (drift.drifted > 0) {
        // §3.4 is explicit that drift is DETECTED and REPORTED, never auto-healed: a sweep that
        // silently rewrote grants would make an estate-wide reconciler bug invisible.
        // eslint-disable-next-line no-console
        console.warn("[POSITION-DRIFT-SWEEP] drift detected (reported, NOT auto-healed):", drift);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("position drift sweep tick failed:", (err as Error).message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  void tick();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
