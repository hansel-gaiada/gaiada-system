import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getClientCentre } from "@/lib/clientCentre-data";
import { getClient } from "@/lib/entities";
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
//
// ── THE AREA NOTE (PV3-09) ────────────────────────────────────────────────────────────────────────
// "The client sees and edits this profile": true because this area IS the portal's own Business area. Both
// routes serve one `CentreProfile` DTO from one store (`toCentreProfileDTO`), with no staff-only field in it
// (checked 2026-10-12: clientName, status, businessType, profile, connections, departments, customConnections,
// revision, updatedAt, updatedBy, canEdit, and the portal's PATCH writes the same rows). The portal hides the
// INTERNAL sentinel client (`NOT is_internal` on its centre routes), so for that client the note would be
// false: it is shown only when the clients list says `isInternal === false`, and is omitted for `true` and for
// a missing field (an older backend), never defaulted. A project-scoped or viewer contact may be read-only
// there; the note says what the area is, and the shell's own read-only line says what a given person may do.
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

  const [profile, client] = await Promise.all([
    getClientCentre(userId, tenant, clientId),
    // Only for `isInternal`; a failed read just omits the note (it claims nothing).
    getClient(userId, tenant, clientId).catch(() => null),
  ]);
  if (!profile) notFound();

  return (
    <>
      {client?.isInternal === false && (
        <p className="ch-area-note">The client sees and edits this profile.</p>
      )}
      <ClientCentreShell
        clientId={clientId}
        basePath={`/clients/${clientId}/profile`}
        segments={section ?? []}
        profile={profile}
        isPortal={false}
        patchAction={patchClientCentreAction}
      />
    </>
  );
}
