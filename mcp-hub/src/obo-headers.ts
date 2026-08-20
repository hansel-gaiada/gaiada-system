import type { Principal } from "./principal";

/**
 * The OBO envelope, as headers, in ONE place.
 *
 * ── WHY THIS EXISTS (2026-08-20) ─────────────────────────────────────────────────────────────────
 * Fourteen call sites across eight files hand-built `{Authorization, x-obo-provider,
 * x-obo-external-id}`. Adding the agent co-author ([agent-attribution-gate]) meant touching all
 * fourteen — and, worse, meant the fifteenth would be written without it, silently dropping
 * attribution for whichever tool group came next. The bug would look like "that one tool's audit rows
 * don't say which agent", which nobody notices until they need it.
 *
 * So the envelope becomes a function. `x-obo-agent` is omitted entirely when the principal is not
 * agent-driven, so a non-agent call sends byte-identical headers to what it sent before this file
 * existed.
 */
/** Takes only the envelope fields, not a whole `Principal`: several call sites hold a structural
 *  `{provider, externalId}` and widening THEM to include `agent` is what stops attribution being
 *  dropped by a type that never mentioned it. `assurance` is irrelevant to a header. */
export type OboSubject = Pick<Principal, "provider" | "externalId" | "agent">;

export function oboHeaders(principal: OboSubject, platformToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${platformToken}`,
    "x-obo-provider": principal.provider,
    "x-obo-external-id": principal.externalId,
    // The co-author. The envelope above still names the HUMAN — authority is unchanged; this is
    // recorded alongside, never instead.
    ...(principal.agent ? { "x-obo-agent": principal.agent } : {}),
  };
}
