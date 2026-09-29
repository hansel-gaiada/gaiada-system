import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalCentres, getPortalCentre } from "@/lib/clientCentre-data";
import { patchPortalCentreAction } from "@/lib/clientCentreActions";
import { getActivePortalClient, switchPortalClient } from "@/lib/portalCentreClient";
import { ClientCentreShell } from "@/components/client-centre/ClientCentreShell";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { EmptyNote } from "@/components/systems/EmptyNote";

// CC-D1 — the portal's Company tab. No client id in the URL (the plan's own route,
// `/portal/company/[[...section]]`): `GET /portal/centre` is the caller's OWN client list, one
// client goes straight in, several go through `getActivePortalClient`'s cookie (see
// `lib/portalCentreClient.ts` for why a cookie rather than a query param).
export default async function PortalCompanyPage({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { section } = await params;

  if (!tenant) {
    return (<><PortalPageHead eyebrow="Your company" title="Company" /><EmptyNote>No workspace selected.</EmptyNote></>);
  }

  const scope = await listPortalCentres(userId, tenant);
  if (scope.length === 0) {
    return (
      <>
        <PortalPageHead eyebrow="Your company" title="Company" />
        <EmptyNote>We couldn&apos;t find a company profile linked to your account. Ask your account manager.</EmptyNote>
      </>
    );
  }

  const clientId = await getActivePortalClient(scope);
  const profile = clientId ? await getPortalCentre(userId, tenant, clientId) : null;
  if (!clientId || !profile) {
    return (
      <>
        <PortalPageHead eyebrow="Your company" title="Company" />
        <EmptyNote>We couldn&apos;t load your company profile. Please try again shortly.</EmptyNote>
      </>
    );
  }

  return (
    <>
      <PortalPageHead eyebrow="Your company" title="Company" lead="Your organisation's Client Centre profile — the setup fields and connections our team uses for your account." />
      <ClientCentreShell
        clientId={clientId}
        basePath="/portal/company"
        segments={section ?? []}
        profile={profile}
        isPortal={true}
        patchAction={patchPortalCentreAction}
        switcherOptions={scope.map((s) => ({ clientId: s.clientId, clientName: s.clientName }))}
        onSwitchClient={switchPortalClient}
      />
    </>
  );
}
