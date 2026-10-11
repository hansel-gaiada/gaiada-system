import { listPortalMedia, loadPortalSiteContext, portalAuthorNames, resolveWebsiteAccess, websiteAccessOk } from "@/lib/portalWebsite";
import { portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { mediaPublicBase } from "@/lib/webdeskMedia";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalWebsiteRefusal, WebsiteAccessRefused } from "@/components/portal/website/PortalWebsiteStates";
import { PortalMediaLibrary } from "@/components/portal/website/PortalMediaLibrary";

// `tenant` is the WEBDESK tenant slug of the site (a route segment), NEVER the ERP company: the company always comes from
// `getActivePortalCompany` (via `resolveWebsiteAccess`), so a URL can never switch which company's data is read (PV-D10).
type Params = Promise<{ tenant: string; site: string }>;

// The site's images and files (WSK-49d). The shared media library in CLIENT MODE: browse, upload, and edit a file's title, alt text and
// tags. NO delete and no "where it's used": the client BFF has neither (§16j: "There is NO route to delete media"). Uploads go from the
// browser straight to WebDesk exactly as in the staff UI.
//
// `~media` (a tilde cannot start a collection key) so this page can never shadow a collection of the same name.
export default async function PortalWebsiteMediaPage({ params }: { params: Params }) {
  const { tenant: tenantSlug, site } = await params;
  const access = await resolveWebsiteAccess();
  if (!websiteAccessOk(access)) return <WebsiteAccessRefused refusal={access} />;
  const { userId, tenant, clientId, me } = access;
  const siteBase = portalWebsiteHref(tenantSlug, site);
  const here = portalWebsiteHref(tenantSlug, site, "~media");
  const head = <PortalPageHead eyebrow="Your website" title="Images and files" />;

  const [ctx, list] = await Promise.all([
    loadPortalSiteContext(userId, tenant, clientId, tenantSlug, site),
    listPortalMedia(userId, tenant, clientId, tenantSlug, site),
  ]);
  if (ctx.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={ctx} subject="the media library" retryHref={here} /></>;
  // "WebDesk is unavailable" must never read as "the library is empty": a refused list draws no grid.
  if (list.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={list} subject="the media library" retryHref={here} /></>;

  return (
    <div className="wc-page">
      <PortalPageHead eyebrow="Your website" title="Images and files" lead={`The images and files ${ctx.data.siteInfo.name} uses. Alt text is written per language (${ctx.data.tenant.locales.join(", ")}).`} />
      <Breadcrumbs items={[{ label: "Website", href: "/portal/website" }, { label: ctx.data.siteInfo.name, href: siteBase }, { label: "Images and files" }]} />
      <PortalMediaLibrary
        clientId={clientId}
        mode="manage"
        scope={{ tenantSlug, siteId: site }}
        routeBase={siteBase}
        locales={ctx.data.tenant.locales}
        initial={{ list: list.data, loadedAt: new Date().toISOString() }}
        authors={portalAuthorNames(me)}
        publicBase={mediaPublicBase()}
      />
    </div>
  );
}
