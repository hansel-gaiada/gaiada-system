import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClientCentre } from "@/lib/clientCentre-data";
import { patchClientCentreAction } from "@/lib/clientCentreActions";
import { ClientCentreShell } from "@/components/client-centre/ClientCentreShell";

// CC-D8 — the client hub's Profile tab: CMC's layout (business type, department tree, setup fields,
// connections) for ONE client. It used to be its own workspace at `/client-centre/[clientId]`; that
// gave staff two pages per client, so it now lives under the hub and that route redirects here.
//
// The hub LAYOUT renders the client name, breadcrumbs and tab strip, so this page renders only the
// shell. There is no client switcher: moving between clients is the Clients list's job, the same as
// on every other hub tab. `[[...section]]` carries everything after `profile/` (`parseSectionRoute`
// reads it), so a new registry section never needs a new route file.
export default async function ClientProfilePage({
  params,
}: {
  params: Promise<{ clientId: string; section?: string[] }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();
  const { clientId, section } = await params;

  const profile = await getClientCentre(userId, tenant, clientId);
  if (!profile) notFound();

  return (
    <ClientCentreShell
      clientId={clientId}
      basePath={`/clients/${clientId}/profile`}
      segments={section ?? []}
      profile={profile}
      isPortal={false}
      patchAction={patchClientCentreAction}
    />
  );
}
