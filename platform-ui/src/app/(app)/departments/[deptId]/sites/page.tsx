import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { SiteRegistryPanel } from "@/components/webdesk/SiteRegistryPanel";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { fetchSiteRegistry, fetchContractPinStatuses, safeConsoleRead } from "@/lib/webdesk";

type Params = Promise<{ deptId: string }>;

// WSK-24 — the Sites tab, registry view (design docs/blueprints/webdesk-design.md §08 "Console UX").
// Reads WSK-23's console BFF (docs/FRONTEND-BFF-CONTRACT.md §24) via `lib/webdesk.ts` — the
// canonical shapes are WSK-23's, not restated here. `safeConsoleRead` gives the same 404="module not
// enabled here" / 403="genuinely refused" split every other webdev reader in this codebase already
// draws (see lib/webdevProvisionedSites-data.ts's header) — coalescing either into an empty registry
// would be a confident wrong answer, not an honest one.
export default async function SitesRegistryPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const registryRead = await safeConsoleRead(() => fetchSiteRegistry(userId, tenant));
  if (!registryRead.ok) {
    if (registryRead.reason === "not_enabled") {
      return (
        <Card title="Sites">
          <EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote>
        </Card>
      );
    }
    return <ReadRefusal subject="the WebDesk site registry" kind="forbidden" />;
  }

  // The contract-pins read is a SEPARATE Cerbos action (`webdev_contract_snapshot:read` vs
  // `webdev_provisioned_site:read`, §24) — a principal can legitimately be allowed one and refused
  // the other, so this is its own safeConsoleRead rather than assumed to succeed alongside the
  // registry read above.
  const pinsRead = await safeConsoleRead(() => fetchContractPinStatuses(userId, tenant));

  return (
    <SiteRegistryPanel
      deptId={deptId}
      sites={registryRead.data.sites}
      meta={registryRead.data.meta}
      pins={pinsRead.ok ? pinsRead.data : []}
      pinsAvailable={pinsRead.ok}
    />
  );
}
