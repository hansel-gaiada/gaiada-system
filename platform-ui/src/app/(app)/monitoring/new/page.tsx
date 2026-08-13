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

export default async function NewMonitorPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);

  if (!tenant) {
    return <EmptyNote>Select a company from the top bar.</EmptyNote>;
  }

  const [kinds, clients] = await Promise.all([listKinds(userId, tenant), listClients(userId, tenant)]);

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
        </EmptyNote>
      ) : (
        <Card title="Details">
          <NewMonitorForm
            tenantId={tenant}
            kinds={kinds}
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
          />
        </Card>
      )}
    </>
  );
}
