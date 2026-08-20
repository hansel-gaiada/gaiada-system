// On-behalf-of principal (WS2 §5, D4). The calling SERVICE authenticates with its token;
// the END USER arrives as an envelope (provider, external_id) that the hub — never the
// client — turns into a principal. There is no field a client could set to claim a role,
// and chat-surface envelopes can only ever mint LOW assurance. Unknown user → anonymous
// minimal principal (public tools only).
import { isAutomation } from "./automation-policy";

export type Assurance = "anonymous" | "low" | "verified";

export interface Principal {
  provider: string;
  externalId: string;
  assurance: Assurance;
  /**
   * ── THE CO-AUTHOR (2026-08-20) ────────────────────────────────────────────────────────────────
   * When an AGENT drives this call on a human's behalf, this is the agent's id. The envelope still
   * names the HUMAN — authority, permission and accountability stay with them, and Cerbos still
   * decides on them — so this is purely additive: it mints no rights and no policy needs
   * re-reasoning. The owner's framing is git's `Co-Authored-By`: author = the human, co-author = the
   * agent, recorded ALONGSIDE, never INSTEAD ([agent-attribution-gate]).
   *
   * ⚠ IT IS ALSO LOAD-BEARING FOR THE D14 IMPACT GATE, which is the defect that made this urgent.
   * `runAgent` sends the requesting human's OBO envelope verbatim ("an agent can never act with more
   * authority than the human it serves"), so before this field the hub saw `provider: "whatsapp"` for
   * an agent-driven call and `isAutomation()` — literally `provider === "n8n"` — was false. The
   * medium/high-impact suspend branch sat INSIDE that check, so an agent could run a HIGH-impact
   * write completely unattended while an n8n workflow doing the same thing suspended for approval.
   *
   * A client cannot use this to gain anything: it only ever ADDS the impact gate (see
   * `isUnattended`), and it is not consulted by the assurance rank, the workflow scope, or Cerbos.
   * Setting it can restrict a call; it can never widen one.
   */
  agent?: string;
}

export interface OboEnvelope {
  provider?: string;
  externalId?: string;
  /** The agent driving the call, if any — see `Principal.agent`. */
  agent?: string;
}

export function mintPrincipal(envelope: OboEnvelope): Principal {
  if (!envelope.provider || !envelope.externalId) {
    // An anonymous principal keeps its agent marker: an unauthenticated agent-driven call is still
    // agent-driven, and dropping it here would hand back the pre-2026-08-20 hole for the one caller
    // shape that deserves it least.
    return { provider: "none", externalId: "anonymous", assurance: "anonymous", ...agentOf(envelope) };
  }
  // "verified" is NEVER minted from an envelope alone — see elevateAssurance below for the only
  // path to it. An envelope names an identity; it can never assert the authority to trust it.
  return {
    provider: envelope.provider,
    externalId: envelope.externalId,
    assurance: "low",
    ...agentOf(envelope),
  };
}

/** Omitted rather than set to `""`/undefined when absent, so a principal that is NOT agent-driven is
 *  byte-identical to one minted before this field existed — every pre-existing audit ref and rate-limit
 *  key keeps its exact shape. */
function agentOf(envelope: OboEnvelope): { agent?: string } {
  const a = typeof envelope.agent === "string" ? envelope.agent.trim() : "";
  return a ? { agent: a } : {};
}

/**
 * Is this caller UNATTENDED — nobody watching at execution time?
 *
 * This is the predicate the D14 impact gate needs, and `isAutomation` was the wrong one for it.
 * `isAutomation` answers "is this an n8n workflow", which is the right question for the
 * workflow-scope allow-list and the wrong question for "should a medium/high write suspend".
 *
 * Two kinds of caller are unattended: an n8n workflow, and an agent acting for a human who is not
 * sitting there approving each step. A human on an interactive surface is attended by definition —
 * they are the human, and the write they just asked for does not need their own approval.
 */
export function isUnattended(principal: Principal): boolean {
  return isAutomation(principal.provider) || !!principal.agent;
}

// ────────────────────────── assurance elevation (design §2, 2026-08-06) ──────────────────────────
//
// The one path from `low` to `verified`. Before this existed, nothing in the codebase minted
// `verified`, so every `minAssurance: "verified"` tool — most consequentially D14-14's
// `approvals.resolveExecute` — was statically unreachable and the whole agent-write half of D14 was
// inert. Design: docs/superpowers/plans/2026-08-06-assurance-minting-design.md.
//
// THE RULE, three conjuncts, ALL fail-closed. Read the design doc before touching any of them.
//
//  1. CALLER ENTITLEMENT (`callerEntitled`) — the request authenticated with HUB_ASSURANCE_TOKEN, a
//     service token distinct from HUB_SERVICE_TOKEN and held only by services that ARE the platform
//     IdP or act directly under it (platform-nest, ai-agents). This is what keeps `principal.ts`'s
//     founding rule literally true — "chat-surface envelopes can only ever mint LOW assurance" — even
//     for a chat identity whose D4 link IS verified: the bot holds only the ordinary token, so a
//     WhatsApp session stays `low`. Identity comes from the envelope; the AUTHORITY to call that
//     identity verified comes from the caller. Unset token ⇒ nobody ever elevates ⇒ behaviour is
//     byte-for-byte what it was before this function existed.
//
//  2. NOT AUTOMATION — refused for an n8n principal even WITH the elevated token, and this one is a
//     binding architect ruling, not a defensive default. §A13 of the SEO/SEM provider addendum
//     (2026-07-30) makes the assurance gate THE control that keeps automation away from
//     money-spending `search.*` tools, resting explicitly on "every n8n principal is minted
//     assurance:'low' by construction". Two controls hold that line — no AUTOMATION_ALLOWLIST entry
//     (SM-55) and low assurance. Elevating n8n would silently delete the second. Pinned by
//     assurance.test.ts's "an n8n principal is never elevated, even with the elevated token".
//
//  3. PLATFORM PROOF (`vouched`) — the platform, asked over POST /principal/resolve, resolved this
//     envelope to a real ACTIVE non-revoked user through a DUAL-PROOF-VERIFIED identity link
//     (see platformVouchesFor in revocation.ts for what each part of that is derived from). Not the
//     caller's claim: the platform's answer.
//
// Anonymous principals are never elevated: conjunct 3 cannot be satisfied without a resolved userId,
// and the resolver refuses to even ask about an anonymous envelope.
export function elevateAssurance(
  principal: Principal,
  entitlement: { callerEntitled: boolean; vouched: boolean },
): Principal {
  if (!entitlement.callerEntitled || !entitlement.vouched) return principal;
  if (principal.assurance !== "low") return principal; // anonymous stays anonymous; never downgrade
  if (isAutomation(principal.provider)) return principal; // conjunct 2 — the §A13 line
  return { ...principal, assurance: "verified" };
}
