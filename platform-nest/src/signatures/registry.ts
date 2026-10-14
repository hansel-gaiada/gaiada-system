// PV5-11 — which certified-signature provider (PSrE) this server signs through, if any.
//
// ── OFF UNLESS SWITCHED ON ──────────────────────────────────────────────────────────────────────────
// Today the only provider is the SIMULATED PSrE (owner ruling PV-D43, review stage), and it exists only while
// SIGNATURE_SIMULATION_ENABLED is on. Off, `certifiedSigningAccount()` answers null and every caller treats that exactly
// as before PV5-11: "Mark certified" and a certified send answer 409 `no_certified_provider`, the simulator's pages and
// `POST /api/webhooks/signatures/simulated` answer 404. Read at CALL time (never cached at import), so a test, or a
// restart with new env, switches it without a second code path.
//
// The real PSrE (VIDA, PV-D25) becomes a second account here, configured by its own credentials. Two providers are never
// "certified" at once: a contract records the provider its envelope is at (contracts.signature_provider), and that
// envelope keeps being processed by its own provider's name (`signatureAccountNamed`) even if the default moves.
import { config } from "../config";
import type { SignatureProviderAccount } from "./provider";
import { simulatedAccount } from "./simulated-provider";

/** The provider new certified contracts sign through, or null when certified signing is not set up. */
export function certifiedSigningAccount(): SignatureProviderAccount | null {
  return config.signatureSimulationEnabled ? simulatedAccount : null;
}

/** The provider behind `/api/webhooks/signatures/:provider` (and behind an existing envelope), or null when it is
 *  unknown or switched off. */
export function signatureAccountNamed(name: string): SignatureProviderAccount | null {
  const a = certifiedSigningAccount();
  return a && a.name === name ? a : null;
}

/** What the read routes tell the UI about certified signing on this server (never a guess in the browser). */
export interface CertifiedSigningInfo {
  available: boolean;
  provider: string | null;
  label: string | null;
  simulated: boolean;
}

export function certifiedSigningInfo(): CertifiedSigningInfo {
  const a = certifiedSigningAccount();
  return a ? { available: true, provider: a.name, label: a.label, simulated: a.simulated } : { available: false, provider: null, label: null, simulated: false };
}

/** The one boot line. Loud when the simulation is on, so a server that still has it on says so on every start. */
export function describeSignaturesConfig(): string {
  if (config.signatureSimulationEnabled) {
    return "[signatures:simulation-enabled] SIGNATURE_SIMULATION_ENABLED is ON (PV-D43, review stage only): certified " +
      "contracts are signed through a SIMULATED PSrE, labelled as such everywhere. It is not a certified signature. " +
      "Turn it off before the ERP holds real client data (infra/runbooks/certified-signing-simulated.md).";
  }
  return "[signatures] certified signing is off: no certified provider is set up (mark-certified and a certified send answer 409)";
}
