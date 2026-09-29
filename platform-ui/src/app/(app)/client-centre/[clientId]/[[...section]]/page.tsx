import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClientCentre, listClientCentres } from "@/lib/clientCentre-data";
import { patchClientCentreAction, switchStaffCentreClient } from "@/lib/clientCentreActions";
import { ClientCentreShell } from "@/components/client-centre/ClientCentreShell";
import { PageHeader } from "@/components/PageHeader";

// CC-D1 — the staff Client Centre workspace: CMC's layout for ONE client, rendered with ERP
// components. `[[...section]]` carries everything after the client id (`parseSectionRoute` in
// `lib/clientCentre.ts` reads it) — home, company settings, a section's overview/settings, or one
// of its leaf pages, all in a single catch-all so a new registry section never needs a new route file.
export default async function ClientCentrePage({
  params,
}: {
  params: Promise<{ clientId: string; section?: string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/client-centre");
  const { clientId, section } = await params;

  const profile = await getClientCentre(userId, tenant, clientId);
  if (!profile) notFound();

  // The switcher list re-fetches the tenant's whole roster — the same list the `/client-centre`
  // landing page shows. Only rendered when there's more than one client, so a tenant with a single
  // client (or a backend that hasn't landed this endpoint yet) never pays for a dropdown of one.
  const roster = await listClientCentres(userId, tenant).catch(() => []);

  return (
    <>
      <PageHeader title={profile.clientName} />
      <ClientCentreShell
        clientId={clientId}
        basePath={`/client-centre/${clientId}`}
        segments={section ?? []}
        profile={profile}
        isPortal={false}
        patchAction={patchClientCentreAction}
        staffClientHref={`/clients/${clientId}`}
        switcherOptions={roster.map((r) => ({ clientId: r.clientId, clientName: r.clientName }))}
        onSwitchClient={switchStaffCentreClient}
      />
    </>
  );
}
