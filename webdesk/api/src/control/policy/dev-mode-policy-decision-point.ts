// WSK-21 — DEV-MODE STUB. Real policy: does the principal's token carry the command's required
// scope (§03 Layer 3), and — for HIGH-impact commands — is a WS4 assertion present (§03 Layer
// 4). No Cerbos call, no cross-zone read (WSK-D8 holds even for the stub: nothing here ever
// reaches Zone A). WSK-22/WSK-31 is where this becomes a real Cerbos `check()` call against Zone
// B's own sidecar + policy set — see policy-decision-point.ts's header.
import { Injectable } from "@nestjs/common";
import type { PolicyDecisionPoint, PolicyDecisionInput, PolicyDecision } from "./policy-decision-point";

@Injectable()
export class DevModePolicyDecisionPoint implements PolicyDecisionPoint {
  async evaluate(input: PolicyDecisionInput): Promise<PolicyDecision> {
    const { principal, meta, ws4ApprovalId } = input;

    if (!principal.scopes.includes(meta.scope)) {
      return { allow: false, reason: `principal lacks required scope '${meta.scope}' for command '${meta.command}'` };
    }

    if (meta.impactClass === "high" && !ws4ApprovalId) {
      return {
        allow: false,
        reason:
          `command '${meta.command}' is HIGH-impact and always requires a WS4 assertion ` +
          `(design §03 Layer 4) — none was presented`,
      };
    }

    return { allow: true };
  }
}
