import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listKinds } from "@/lib/monitoring";
import { listClients } from "@/lib/entities";
import { NewMonitorForm } from "@/components/monitoring/NewMonitorForm";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

export const metadata = { title: "New monitor" };
export const dynamic = "force-dynamic";

// `searchParams` (Next 15: async) carries an optional seed from a deep link. The Web Dev portfolio
// links here with `?domain=&clientId=` for a consented site nothing is watching yet — the one
// action that closes a real coverage gap, and previously a form the operator had to retype the
// domain into. `clientId` is validated against the pickable list inside the form, never trusted.
type SearchParams = Promise<{ domain?: string; clientId?: string }>;

export default async function NewMonitorPage({ searchParams }: { searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [kinds, clients] = await Promise.all([listKinds(userId, tenant), listClients(userId, tenant)]);
  const { domain, clientId } = await searchParams;

  return (
    <>
      <p style={{ marginBottom: 12 }}>
        <Link href="/monitoring">← Monitoring</Link>
      </p>
      <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 4 }}>New monitor</h1>
      <p style={{ opacity: 0.7, marginBottom: 20, fontSize: 14 }}>
        Adding a monitor here is what starts the checks — nothing is probed until one exists.
      </p>

      {clients.length === 0 ? (
        <EmptyNote>
          No clients exist in this company yet. A monitor has to belong to one, so add a client
          first — including for your own properties.
          {domain ? <> You arrived here to monitor <strong>{domain}</strong>; that is still the right
          thing to do, but it needs a client to belong to first.</> : null}
        </EmptyNote>
      ) : (
        <Card title="Details">
          <NewMonitorForm
            tenantId={tenant}
            kinds={kinds}
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
            prefill={{ domain, clientId }}
          />
        </Card>
      )}
    </>
  );
}
