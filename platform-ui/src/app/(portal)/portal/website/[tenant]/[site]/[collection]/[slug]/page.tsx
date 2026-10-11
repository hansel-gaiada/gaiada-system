import { loadPortalEditorBundle, portalAuthorNames, resolveWebsiteAccess, websiteAccessOk } from "@/lib/portalWebsite";
import { collectionEditability, PORTAL_COPY, portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { mediaPublicBase } from "@/lib/webdeskMedia";
import { collectionLabel } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalWebsiteRefusal, WebsiteAccessRefused } from "@/components/portal/website/PortalWebsiteStates";
import { PortalItemEditor } from "@/components/portal/website/PortalItemEditor";

// `tenant` is the WEBDESK tenant slug of the site (a route segment), NEVER the ERP company: the company always comes from
// `getActivePortalCompany` (via `resolveWebsiteAccess`), so a URL can never switch which company's data is read (PV-D10).
type Params = Promise<{ tenant: string; site: string; collection: string; slug: string }>;
type Search = Promise<{ locale?: string }>;

// The page editor (WSK-49d): the staff item editor in CLIENT MODE. ONE call (`loadPortalEditorBundle`) resolves the site, the collection
// (with the BFF's `clientEditable` verdict), the item and its default-language twin; if ANY of those is a refusal the page returns the
// refusal and NO form is built, so "the service is down" is never drawn as an empty form. Fields only Gaiada can change render read-only
// ("Managed by Gaiada."); `seo` is read-only whatever the composition says.
export default async function PortalWebsiteItemPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant: tenantSlug, site, collection: collectionKey, slug } = await params;
  const sp = await searchParams;
  const access = await resolveWebsiteAccess();
  if (!websiteAccessOk(access)) return <WebsiteAccessRefused refusal={access} />;
  const { userId, tenant, clientId, me } = access;
  const siteBase = portalWebsiteHref(tenantSlug, site);
  const listHref = `${siteBase}/${encodeURIComponent(collectionKey)}`;
  const here = `${listHref}/${encodeURIComponent(slug)}${sp.locale ? `?locale=${encodeURIComponent(sp.locale)}` : ""}`;

  const bundle = await loadPortalEditorBundle(userId, tenant, clientId, tenantSlug, site, collectionKey, slug, sp.locale ?? null);
  if (bundle.kind !== "ok") {
    return <><PortalPageHead eyebrow="Your website" title="Website" /><PortalWebsiteRefusal result={bundle} subject="this page" retryHref={here} /></>;
  }
  const b = bundle.data;
  const e = collectionEditability(b.clientEditable);

  return (
    <div className="wc-page">
      <PortalPageHead eyebrow="Your website" title={collectionLabel(b.collection)} />
      <Breadcrumbs items={[
        { label: "Website", href: "/portal/website" }, { label: b.site.name, href: siteBase },
        { label: collectionLabel(b.collection), href: listHref }, { label: b.detail.item.slug },
      ]} />
      {!e.any && (
        <div className="wc-banner wc-banner--info" role="note" data-testid="nothing-editable">
          <span className="wc-banner__body">{PORTAL_COPY.nothingEditable} You can read this page and preview it.</span>
        </div>
      )}
      <PortalItemEditor
        key={b.detail.item.itemId}
        mode="edit"
        scope={{ tenantSlug, siteId: site }}
        routeBase={siteBase}
        collection={b.collection}
        tenant={b.tenant}
        site={b.site}
        bundle={b}
        authors={portalAuthorNames(me, b.requests ?? [])}
        mediaPublicBase={mediaPublicBase()}
        readOnlyReason={null}
        clientId={clientId}
        viewerId={me.userId}
        editable={b.clientEditable}
        requests={b.requests}
        listHref={listHref}
        requestsHref="/portal/website#requests"
      />
    </div>
  );
}
