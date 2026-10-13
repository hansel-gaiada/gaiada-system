import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { listPortalCentres, getPortalCentre, getPortalCentreResults } from "@/lib/clientCentre-data";
import { patchPortalCentreAction } from "@/lib/clientCentreActions";
import { legacySectionRedirect, parseSectionRoute } from "@/lib/clientCentre";
import { websiteEditorClients } from "@/lib/portalWebsiteAccess";
import { PORTAL_WEBSITE_HREF } from "@/lib/portalNav";
import { getActivePortalClient, switchPortalClient } from "@/lib/portalCentreClient";
import { ClientCentreShell } from "@/components/client-centre/ClientCentreShell";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { EmptyNote } from "@/components/systems/EmptyNote";

// CC-D1 — the portal's Business tab (CC-D9: labelled "Company" until alpha.342; the URL
// stays `/portal/company` so links already sent to clients keep working). No client id in the URL (the plan's own route,
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
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  const { section } = await params;
  // PV6-01: an old `<area>/settings` or leaf-page link (a bookmark) lands on the area's Setup.
  const legacy = legacySectionRedirect("/portal/company", section);
  if (legacy) redirect(legacy);

  if (!tenant) {
    return (<><PortalPageHead eyebrow="Your business" title="Business" /><EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote></>);
  }

  const scope = await listPortalCentres(userId, tenant);
  if (scope.length === 0) {
    return (
      <>
        <PortalPageHead eyebrow="Your business" title="Business" />
        <EmptyNote>We couldn&apos;t find a company profile linked to your account. Ask your account manager.</EmptyNote>
      </>
    );
  }

  const clientId = await getActivePortalClient(scope);
  const profile = clientId ? await getPortalCentre(userId, tenant, clientId) : null;
  if (!clientId || !profile) {
    return (
      <>
        <PortalPageHead eyebrow="Your business" title="Business" />
        <EmptyNote>We couldn&apos;t load your company profile. Please try again shortly.</EmptyNote>
      </>
    );
  }

  // PV6-03: ONE results read per render, and only where results are shown: Home (the per-area counts) and an
  // area's results part. A website editor's website card links to the Website tab; everyone else reads it.
  const route = parseSectionRoute(section);
  const wantsResults = route.kind === "home" || (route.kind === "section" && route.part === "results");
  const results = wantsResults ? await getPortalCentreResults(userId, tenant, clientId) : undefined;
  const websiteHref = websiteEditorClients(me.roles, scope.map((s) => s.clientId)).includes(clientId) ? PORTAL_WEBSITE_HREF : null;

  return (
    <>
      <PortalPageHead eyebrow="Your business" title="Business" lead="How your business is set up — the details and connections our team uses to work on your account." />
      <ClientCentreShell
        clientId={clientId}
        basePath="/portal/company"
        segments={section ?? []}
        profile={profile}
        isPortal={true}
        results={results}
        websiteHref={websiteHref}
        patchAction={patchPortalCentreAction}
        switcherOptions={scope.map((s) => ({ clientId: s.clientId, clientName: s.clientName }))}
        onSwitchClient={switchPortalClient}
      />
    </>
  );
}
