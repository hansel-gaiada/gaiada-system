import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { OperationsConsole } from "@/components/webdesk/OperationsConsole";
import { SiteRegistryPanel } from "@/components/webdesk/SiteRegistryPanel";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { fetchSiteRegistry, fetchContractPinStatuses, safeConsoleRead } from "@/lib/webdesk";
import { fetchPortfolio } from "@/lib/webdeskPortfolio.server";

type Params = Promise<{ deptId: string }>;

// The Web Dev OPERATIONS console (repurposed from the old "Sites" registry, which duplicated the
// Portfolio inventory). Two stacked concerns, most-actionable first:
//
//   1. OperationsConsole — every site's health and quick-investigate links, grouped by server. This
//      is the "something broke, where do I look" surface, fed by the SAME portfolio read the
//      inventory uses (webdev_sites + last-recorded HTTP status). It is why this page still exists:
//      Portfolio answers "what do we have", this answers "is it up and how do I get to it".
//
//   2. SiteRegistryPanel — the Zone B pipeline deployment registry (provisioned sites, contract
//      pins, release/deploy state). Legitimately empty until the pipeline provisions a site; kept
//      below the health view rather than as the headline, because a 0-row registry as the first
//      thing you see is exactly what made the old tab feel redundant.
//
// Each read degrades on its own (`safeConsoleRead` / `safeConsoleRead`-style): the health view can
// render while the Zone B registry 404s "module not enabled here", and vice-versa — one being
// unavailable must never blank the other.
export default async function WebDevOperationsPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  // 1 · the health/operations view over the whole estate (portfolio rows).
  const portfolioRead = await safeConsoleRead(() => fetchPortfolio(userId, tenant));

  // 2 · the Zone B provisioned registry + its contract pins (a SEPARATE Cerbos action, so its own read).
  const registryRead = await safeConsoleRead(() => fetchSiteRegistry(userId, tenant));
  const pinsRead = registryRead.ok
    ? await safeConsoleRead(() => fetchContractPinStatuses(userId, tenant))
    : null;

  // If BOTH the operations read and the registry read are unavailable for the same reason, say so
  // once rather than stacking two identical notices.
  if (!portfolioRead.ok && !registryRead.ok) {
    if (portfolioRead.reason === "not_enabled" && registryRead.reason === "not_enabled") {
      return (
        <Card title="Operations">
          <EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote>
        </Card>
      );
    }
    return <ReadRefusal subject="the Web Dev operations console" kind="forbidden" />;
  }

  return (
    <>
      {portfolioRead.ok ? (
        <OperationsConsole data={portfolioRead.data} />
      ) : portfolioRead.reason === "not_enabled" ? null : (
        <ReadRefusal subject="site health" kind="forbidden" />
      )}

      {registryRead.ok ? (
        <SiteRegistryPanel
          deptId={deptId}
          sites={registryRead.data.sites}
          meta={registryRead.data.meta}
          pins={pinsRead?.ok ? pinsRead.data : []}
          pinsAvailable={Boolean(pinsRead?.ok)}
        />
      ) : null}
    </>
  );
}
