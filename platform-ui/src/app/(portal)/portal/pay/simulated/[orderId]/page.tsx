import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getSimulatedPayment } from "@/lib/portal-data";
import { money, simulatedStatusText } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalSimulatedPayment } from "@/components/portal/PortalSimulatedPayment";
import { PortalFacts, PortalLink, PortalPageHead } from "@/components/portal/PortalBits";

// PV-D41 (owner, 2026-10-14: "simulate midtrans for now") — the SIMULATED hosted payment page of the review stage. In
// `simulated` mode the payment provider's "hosted page" is this page: it says plainly that no real money moves, shows the
// invoice number and amount, and offers three outcomes. The choice is recorded by the BFF, which has the simulated
// provider send its signed notice to our webhook; the payment itself is written only by that notice's normal path.
// The BFF answers 404 (and so this page) whenever the simulation is off, or the order is not one of the caller's.
export default async function SimulatedPaymentPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here.</EmptyNote>;

  const sim = await getSimulatedPayment(userId, tenant, orderId);
  if (!sim) notFound();

  return (
    <>
      <PortalPageHead
        eyebrow="Payment"
        title="Simulated payment"
        lead="Simulated payment (review stage): no real money moves."
      />
      <div className="cp-stack">
        <Card title="What you are paying">
          <PortalFacts
            rows={[
              ...(sim.invoiceNo ? [{ k: "Invoice no.", v: sim.invoiceNo, strong: true }] : []),
              { k: "Amount", v: money(sim.amount, sim.currency), strong: true },
              { k: "Status", v: simulatedStatusText(sim.transactionStatus) },
            ]}
          />
        </Card>
        <Card title="Choose what happens" hint="This page stands in for the payment provider while the ERP is being reviewed.">
          {sim.canAct ? (
            <PortalSimulatedPayment orderId={sim.orderId} />
          ) : (
            <EmptyNote>Nothing more can be done on this simulated payment.</EmptyNote>
          )}
        </Card>
        <PortalLink href={`/portal/invoices/${sim.invoiceId}`}>Back to the invoice</PortalLink>
      </div>
    </>
  );
}
