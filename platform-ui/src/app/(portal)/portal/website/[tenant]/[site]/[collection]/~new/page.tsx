import Link from "next/link";
import { loadPortalSiteContext, portalAuthorNames, resolveWebsiteAccess, websiteAccessOk } from "@/lib/portalWebsite";
import { createBlockedCopy, portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { mediaPublicBase } from "@/lib/webdeskMedia";
import { collectionLabel, defaultFields } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalWebsiteRefusal, WebsiteAccessRefused } from "@/components/portal/website/PortalWebsiteStates";
import { PortalItemEditor } from "@/components/portal/website/PortalItemEditor";

type Params = Promise<{ tenant: string; site: string; collection: string }>;
type Search = Promise<{ locale?: string }>;

// Create (WSK-49d). The segment is `~new` (not `new`) for the same reason as in the staff workspace: a slug may legitimately BE "new".
//
// A client may create a page only where `clientEditable.create.allowed` (§16j): the form is NOT built otherwise. The page says why in
// the BFF's own terms: a REQUIRED field only Gaiada can fill makes a client create impossible ("This collection has required fields only
// Gaiada can fill": it names them), and a collection where nothing is editable gives a client nothing to author.
export default async function PortalWebsiteNewItemPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant: tenantSlug, site, collection: collectionKey } = await params;
  const sp = await searchParams;
  const access = await resolveWebsiteAccess();
  if (!websiteAccessOk(access)) return <WebsiteAccessRefused refusal={access} />;
  const { userId, tenant, clientId, me } = access;
  const siteBase = portalWebsiteHref(tenantSlug, site);
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}`;
  const head = <PortalPageHead eyebrow="Your website" title="Website" />;

  const ctx = await loadPortalSiteContext(userId, tenant, clientId, tenantSlug, site);
  if (ctx.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={ctx} subject="this collection" retryHref={`${here}/~new`} /></>;
  const collection = ctx.data.collections.find((c) => c.key === collectionKey);
  if (!collection) return <>{head}<PortalWebsiteRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" /></>;
  const label = collectionLabel(collection);
  const crumbs = [{ label: "Website", href: "/portal/website" }, { label: ctx.data.siteInfo.name, href: siteBase }, { label, href: here }, { label: "New page" }];

  const blocked = createBlockedCopy(collection.clientEditable, collection.composition.fields);
  if (blocked) {
    return (
      <>
        <PortalPageHead eyebrow="Your website" title={`New page in ${label}`} />
        <Breadcrumbs items={crumbs} />
        <div className="wc-notice" role="note" data-testid="create-blocked">
          <h2>{blocked}</h2>
          <p>Ask Gaiada to create the page. Once it exists you can edit the fields that are yours.</p>
          <div className="wc-notice__actions"><Link href={here} className="lux-btn lux-btn--ghost lux-btn--sm">Back to {label}</Link></div>
        </div>
      </>
    );
  }

  const locale = collection.composition.localized === false ? ctx.data.tenant.defaultLocale : (sp.locale ?? ctx.data.tenant.defaultLocale);
  return (
    <div className="wc-page">
      <PortalPageHead eyebrow="Your website" title={`New page in ${label}`} />
      <Breadcrumbs items={crumbs} />
      <PortalItemEditor
        mode="create"
        scope={{ tenantSlug, siteId: site }}
        routeBase={siteBase}
        collection={collection}
        tenant={ctx.data.tenant}
        site={ctx.data.site}
        seed={{ locale, twinOf: null, slug: "", fields: defaultFields(collection.composition.fields ?? []), seo: {}, extraBlocks: [] }}
        authors={portalAuthorNames(me)}
        mediaPublicBase={mediaPublicBase()}
        readOnlyReason={null}
        clientId={clientId}
        viewerId={me.userId}
        editable={collection.clientEditable}
        requests={[]}
        listHref={here}
        requestsHref="/portal/website#requests"
      />
    </div>
  );
}
