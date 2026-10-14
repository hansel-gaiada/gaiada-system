// PV5-11 — who may put a signature on a certified contract at the provider: a PERSON, signing in their own session.
//
// Agents never sign (plan PV5-11; PV3-06's countersign executable refuses a certified contract too). A request that
// arrives through an agent or bot channel (`via`), on behalf of someone else (`actFor`, an OBO envelope or a D14
// re-drive), or as an `automation` / `bot` account is refused with 403 before anything is read. This is authorization,
// so it runs right after the Cerbos check and before any validation.
import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "../rbac/principal";

export const SIGNER_MUST_BE_A_PERSON = "signer_must_be_a_person";

export function requirePersonSigner(p: Principal): void {
  if (!p.userId || p.via || p.actFor || p.kind === "automation" || p.kind === "bot") {
    throw new ForbiddenException({
      message: "a certified signature is made by a person in their own session; agents, automations and re-driven approvals never sign",
      reason: SIGNER_MUST_BE_A_PERSON,
    });
  }
}
