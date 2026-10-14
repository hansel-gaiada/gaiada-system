import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalSimulatedEnvelope } from "@/lib/simulatedPsre-data";
import { portalSignSimulatedPsre } from "@/lib/portalActions";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { SimulatedEnvelopeBody } from "@/components/signing/SimulatedEnvelopeBody";
import { SimulatedSigningPanel } from "@/components/signing/SimulatedSigningPanel";

// PV5-11 — the client's signing page at the SIMULATED PSrE (review stage; owner ruling PV-D43).
//
// The client lands here after pressing "Sign with <label>" on the contract page. The banner at the top says plainly that
// this is not a real PSrE signature. Order is a correctness property, as on the contract page: the document and its hash,
// then who has signed, then the form, never the form first.
//
// `canSign` and `reason` are the backend's. A 404 (flag off, or not this client's envelope) is a 404 here too.
export default async function PortalSimulatedPsrePage({ params }: { params: Promise<{ envelopeId: string }> }) {
  const { envelopeId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const view = await getPortalSimulatedEnvelope(userId, tenant, envelopeId);
  if (!view) notFound();

  return (
    <>
      <PortalPageHead eyebrow={view.label ?? "Simulated signing"} title={`Sign: ${view.title}`} />
      <SimulatedEnvelopeBody view={view} variant="portal">
        <SimulatedSigningPanel
          view={view}
          variant="portal"
          action={portalSignSimulatedPsre}
          submitLabel="Sign at the simulated PSrE"
          back={{ href: `/portal/contracts/${view.contractId}`, label: "Back to the agreement" }}
        />
      </SimulatedEnvelopeBody>
    </>
  );
}
