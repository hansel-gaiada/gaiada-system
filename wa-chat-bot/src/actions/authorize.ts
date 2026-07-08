// The real authorizer: the bot never decides authorization itself. It asks the hub's
// `authz.check` tool (Phase D) using the sender's OBO envelope; the platform resolves the
// D4 identity and asks Cerbos. Fail-closed: an unlinked/unverified identity → step-up; any
// other error → deny (never allow on uncertainty).
import { HubDeniedError } from "../hub";
import { config } from "../config";
import type { Authorizer } from "./types";

export function makeHubAuthorizer(): Authorizer {
  return async (_principal, action, ctx) => {
    try {
      const raw = await ctx.hub("authz.check", {
        resource: action.cerbos.resource,
        action: action.cerbos.action,
        chatId: ctx.chatId,
        // The chat group maps to a company; the platform route is /:tenantId/authz/check.
        tenantId: config.defaultTenantId,
      });
      const parsed = JSON.parse(raw) as { decision?: "allow" | "deny" | "stepup"; reason?: string };
      if (parsed.decision === "allow" || parsed.decision === "deny" || parsed.decision === "stepup") {
        return { decision: parsed.decision, reason: parsed.reason };
      }
      return { decision: "deny", reason: "authorization returned an unexpected response" };
    } catch (err) {
      if (err instanceof HubDeniedError) {
        return { decision: "stepup", reason: "That needs a verified login. Ask an admin to link and verify your account, then try again." };
      }
      // Fail closed — never allow a write when we cannot confirm authorization.
      return { decision: "deny", reason: `Authorization is unavailable right now: ${(err as Error).message}` };
    }
  };
}
