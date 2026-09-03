import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { PortfolioPanel } from "@/components/webdesk/PortfolioPanel";
import { SiteRegistryPanel } from "@/components/webdesk/SiteRegistryPanel";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { fetchSiteRegistry, fetchContractPinStatuses, safeConsoleRead } from "@/lib/webdesk";
import { fetchPortfolio } from "@/lib/webdeskPortfolio.server";
import { fetchMonitoringFeed } from "@/lib/siteMonitoring-data";

type Params = Promise<{ deptId: string }>;

// The estate portfolio (design v2.0 §07) — Web Dev's ONE site surface as of 2026-09-03.
//
// ── WHAT MERGED INTO HERE, AND WHY ─────────────────────────────────────────────────────────────
// This page had a sibling one level up at `sites/` labelled "Operations". It called the SAME
// endpoint, flattened it with the same helper, grouped it by server with a verbatim copy of the
// same function, and drew the same filter chips — the only difference was its column set, whose
// headline column ("Health — last recorded") was fed by `webdev_sites.last_http_status` /
// `last_seen_at`, two columns **nothing in this program has ever written**. Every row read "Not
// checked", permanently, and the summary line claimed "0 showing a problem" about an estate nobody
// was checking.
//
// Owner decision: that tab is deleted (`sites/` now redirects here), health belongs to
// Business > Monitoring — the surface that actually probes, tracks uptime, opens incidents and
// watches cert expiry — and the Zone B DEPLOYMENT registry that used to sit beneath it moves here,
// below the inventory, because it is site-shaped data and this is now the site page.
//
// ── THE THREE READS ARE INDEPENDENT ────────────────────────────────────────────────────────────
//   1. `fetchPortfolio` — Zone A's own tables (`webdev_sites` ⋈ `projects`/`clients`/
//      `search_properties`). No egress, never stale, no DegradeBanner (see webdeskPortfolio.ts).
//   2. `fetchMonitoringFeed` — the MONITORING module (a different module, separately enabled, with
//      its own RLS module gate), joined to these rows by domain in the BFF. It carries its own
//      availability so the column can tell "nothing is watching this" from "nobody could ask".
//   3. `fetchSiteRegistry` (+ its contract pins) — the Zone B pipeline control plane, a SEPARATE
//      Cerbos action and a legitimately-empty table until the pipeline provisions something.
// Each degrades on its own: the inventory must render when Zone B 404s "module not enabled here",
// the registry must render if the inventory is refused, and a company with monitoring switched off
// must still get its full inventory. One being unavailable never blanks the others.
//
// `safeConsoleRead` draws the same 404="module not enabled here" / 403="genuinely refused" split
// every other webdev reader draws. Coalescing either into an empty portfolio would be a confident
// wrong answer — and on THIS page the worst possible one, because an empty portfolio reads as "we
// operate no sites" rather than "you cannot see them".
export default async function SitePortfolioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const portfolioRead = await safeConsoleRead(() => fetchPortfolio(userId, tenant));

  // The monitoring bridge (the honest replacement for the deleted Operations tab's dead health
  // column). A THIRD independent read against a DIFFERENT module: it carries its own availability
  // so the column can distinguish "nothing is watching this" from "monitoring is off here / you may
  // not ask" — see siteMonitoring-data.ts for why `lib/monitoring.ts`'s own reader is wrong for
  // this. It never gates the portfolio: an unavailable feed costs the column its certainty, not the
  // page its rows.
  const monitoring = await fetchMonitoringFeed(userId, tenant);

  // The Zone B registry is only asked for once — its own action, its own failure. `pinsRead` is
  // skipped entirely when the registry itself is unavailable: pins ABOUT sites we could not read
  // are not a partial answer, they are noise.
  const registryRead = await safeConsoleRead(() => fetchSiteRegistry(userId, tenant));
  const pinsRead = registryRead.ok
    ? await safeConsoleRead(() => fetchContractPinStatuses(userId, tenant))
    : null;

  // Both unavailable for the SAME reason: say it once rather than stacking two identical notices.
  if (!portfolioRead.ok && !registryRead.ok) {
    if (portfolioRead.reason === "not_enabled" && registryRead.reason === "not_enabled") {
      return (
        <Card title="Site portfolio">
          <EmptyNote>WebDesk isn&apos;t turned on for this company yet.</EmptyNote>
        </Card>
      );
    }
    return <ReadRefusal subject="the site portfolio" kind="forbidden" />;
  }

  return (
    <>
      {portfolioRead.ok ? (
        <PortfolioPanel
          data={portfolioRead.data}
          basePath={`/departments/${deptId}/sites/portfolio`}
          monitoring={monitoring}
        />
      ) : portfolioRead.reason === "not_enabled" ? null : (
        <ReadRefusal subject="the site portfolio" kind="forbidden" />
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
