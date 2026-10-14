import "server-only";
// PV5-11 — READERS for the simulated PSrE signing pages.
//
//   portal  GET /api/:t/portal/simulated-psre/envelopes/:envelopeId   -> SimulatedEnvelopeView
//   staff   GET /api/:t/simulated-psre/envelopes/:envelopeId          -> SimulatedEnvelopeView
//
// Both answer 404 when the server's `SIGNATURE_SIMULATION_ENABLED` flag is off or the envelope is out of the caller's
// scope: the page renders notFound(). A 403 reads the same here (a staff member opening a portal link, or the other way
// round). Anything else (a 500, a network failure) propagates into the route's error boundary, never an empty page.
import { platformFetch, PlatformError } from "./platform";
import type { SimulatedEnvelopeView } from "./simulatedPsre";

async function read(path: string, userId: string): Promise<SimulatedEnvelopeView | null> {
  try {
    return await platformFetch<SimulatedEnvelopeView>(path, userId);
  } catch (e) {
    if (e instanceof PlatformError && (e.status === 404 || e.status === 403)) return null;
    throw e;
  }
}

export function getPortalSimulatedEnvelope(userId: string, tenant: string, envelopeId: string): Promise<SimulatedEnvelopeView | null> {
  return read(`/api/${tenant}/portal/simulated-psre/envelopes/${encodeURIComponent(envelopeId)}`, userId);
}

export function getStaffSimulatedEnvelope(userId: string, tenant: string, envelopeId: string): Promise<SimulatedEnvelopeView | null> {
  return read(`/api/${tenant}/simulated-psre/envelopes/${encodeURIComponent(envelopeId)}`, userId);
}
