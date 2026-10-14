import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getStaffSimulatedEnvelope } from "@/lib/simulatedPsre-data";
import { countersignSimulatedPsreAction } from "@/lib/contractsActions";
import { PageHeader } from "@/components/PageHeader";
import { SimulatedEnvelopeBody } from "@/components/signing/SimulatedEnvelopeBody";
import { SimulatedSigningPanel } from "@/components/signing/SimulatedSigningPanel";
import "@/components/clients/billing/billing.css";

// PV5-11 — our company's countersigner signs at the SIMULATED PSrE (review stage; owner ruling PV-D43).
//
// Reached from "Countersign at <label>" on the client's billing tab. Same banner and layout as the client's page. Whether
// THIS caller may sign is the backend's `canSign` (only a company owner), with its `reason` in words when not; nothing
// here reads a role. A 404 (flag off, or out of scope) is a 404 here too.
export default async function StaffSimulatedPsrePage({ params }: { params: Promise<{ envelopeId: string }> }) {
  const { envelopeId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const view = await getStaffSimulatedEnvelope(userId, tenant, envelopeId);
  if (!view) notFound();

  return (
    <>
      <PageHeader title={`Countersign: ${view.title}`} />
      <SimulatedEnvelopeBody view={view} variant="staff">
        <SimulatedSigningPanel
          view={view}
          variant="staff"
          action={countersignSimulatedPsreAction}
          submitLabel="Countersign at the simulated PSrE"
          back={{ href: `/clients/${view.clientId}/billing`, label: "Back to contracts and billing" }}
          clientId={view.clientId}
        />
      </SimulatedEnvelopeBody>
    </>
  );
}
