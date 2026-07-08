// On-behalf-of principal (WS2 §5, D4). The calling SERVICE authenticates with its token;
// the END USER arrives as an envelope (provider, external_id) that the hub — never the
// client — turns into a principal. There is no field a client could set to claim a role,
// and chat-surface envelopes can only ever mint LOW assurance. Unknown user → anonymous
// minimal principal (public tools only).
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
  // "verified" principals will come from the platform IdP (WS1) — never from an envelope.
  return { provider: envelope.provider, externalId: envelope.externalId, assurance: "low" };
}
