// PV5-06 / PV5-11 - is a CERTIFIED (PSrE) signing provider set up?
//
// PV-D25 parked certified signing; PV-D43 (2026-10-14) unparks it for the REVIEW stage with a SIMULATED PSrE behind
// SIGNATURE_SIMULATION_ENABLED (src/signatures/registry.ts). With no provider, every contract signs in the attested tier,
// "Mark certified" answers 409, and a send that would land in the certified tier is refused rather than producing a
// contract nobody can sign. Callers only ever ask this one question; the answer is the provider's key, or null.
import { certifiedSigningAccount } from "../signatures/registry";

export function certifiedSigningProvider(): string | null {
  return certifiedSigningAccount()?.name ?? null;
}

export const NO_CERTIFIED_PROVIDER = "no certified signing provider is set up";
