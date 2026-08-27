import type { ControlPrincipal } from "../auth/control-principal";
import type { CommandMeta } from "../command-types";

export const POLICY_DECISION_POINT = Symbol("POLICY_DECISION_POINT");

export interface PolicyDecisionInput {
  principal: ControlPrincipal;
  meta: CommandMeta;
  tenantSlug: string | null; // null for the one platform-level command (tenant.provision)
  ws4ApprovalId: string | null;
  /**
   * WSK-22 — additive, optional so DevModePolicyDecisionPoint's existing destructuring (which
   * never reads these) keeps compiling untouched. The RAW `x-ws4-assertion` header value (design
   * §03 Layer 4: `{approvalId, commandHash, exp}` HMAC'd) — real-policy-decision-point.ts does
   * the actual signature/expiry/commandHash/single-use verification; `ws4ApprovalId` above stays
   * an unverified convenience field only (see real-control-channel-authenticator.ts's comment).
   */
  ws4AssertionHeader?: string | null;
  /**
   * WSK-22 — route params + request body merged, exactly what a real caller (Zone A) knows
   * before it asks for a WS4 approval. Used ONLY to recompute `commandHash` for comparison
   * against the assertion's claimed hash — never persisted, never logged.
   */
  args?: Record<string, unknown>;
}

export interface PolicyDecision {
  allow: boolean;
  reason?: string;
}

/**
 * §03 Layer 3 / §09 (WSK-D8): "Zone B runs its own Cerbos sidecar with its own policy set... it
 * never calls Zone A's Cerbos." Standing that sidecar up is infra/compose work this ticket does
 * not own (`webdesk/docker-compose.yml` is out of scope — see ../../../README.md's "required
 * changes" section). This interface is the seam: `DevModePolicyDecisionPoint` decides locally
 * from the token's declared scopes; a real Cerbos-backed implementation (a `check()` call against
 * Zone B's own sidecar) swaps in behind this same interface with no controller or guard change,
 * and WSK-D8 stays true for it too — this interface has no path back to Zone A by construction.
 */
export interface PolicyDecisionPoint {
  evaluate(input: PolicyDecisionInput): Promise<PolicyDecision>;
}
