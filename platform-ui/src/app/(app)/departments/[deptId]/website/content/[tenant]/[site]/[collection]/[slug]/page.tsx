import { loadEditorBundle, resolveAuthorNames } from "@/lib/webdeskContent";
import { collectionLabel } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ItemEditor } from "@/components/webdesk/content/ItemEditor";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; collection: string; slug: string }>;
type Search = Promise<{ locale?: string }>;

// The editor: `…/[collection]/[slug]?locale=en`. ONE call (`loadEditorBundle`) resolves the site, the
// collection's composition, the item and its default-locale twin; if ANY of those is a refusal the
// page returns <WdRefusal> and NO form is built — in particular "editorial unavailable" is a
// full-page notice, never a list or an editor (§10). A deleted item opens read-only with the reason.
export default async function WebsiteItemPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site, collection: collectionKey, slug } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId);
  const siteBase = `${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(slug)}${sp.locale ? `?locale=${encodeURIComponent(sp.locale)}` : ""}`;

  const [bundle, authors] = await Promise.all([
    loadEditorBundle(c.userId, c.company, tenant, site, collectionKey, slug, sp.locale ?? null),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (bundle.kind !== "ok") return <WdRefusal result={bundle} subject="this item" retryHref={here} />;
  const b = bundle.data;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[
        { label: "Website" }, { label: "Content", href: c.contentBase },
        { label: b.site.name, href: siteBase },
        { label: collectionLabel(b.collection), href: `${siteBase}/${encodeURIComponent(collectionKey)}` },
        { label: b.detail.item.slug },
      ]} />
      <ItemEditor
        key={`${b.detail.item.itemId}`}
        mode="edit"
        scope={{ tenantSlug: tenant, siteId: site }}
        routeBase={siteBase}
        collection={b.collection}
        tenant={b.tenant}
        site={b.site}
        bundle={b}
        authors={authors}
        readOnlyReason={b.detail.item.deletedAt ? "This item has been deleted. Its history is kept; an operator can reverse the deletion." : null}
      />
    </div>
  );
}
