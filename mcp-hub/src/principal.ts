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
}

export interface OboEnvelope {
  provider?: string;
  externalId?: string;
}

export function mintPrincipal(envelope: OboEnvelope): Principal {
  if (!envelope.provider || !envelope.externalId) {
    return { provider: "none", externalId: "anonymous", assurance: "anonymous" };
  }
  // "verified" is NEVER minted from an envelope alone — see elevateAssurance below for the only
  // path to it. An envelope names an identity; it can never assert the authority to trust it.
  return { provider: envelope.provider, externalId: envelope.externalId, assurance: "low" };
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
