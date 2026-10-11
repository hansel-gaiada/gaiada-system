import { loadSiteContext, resolveAuthorNames } from "@/lib/webdeskContent";
import { mediaPublicBase } from "@/lib/webdeskMedia";
import { collectionLabel, defaultFields } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ItemEditor } from "@/components/webdesk/content/ItemEditor";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; collection: string }>;
type Search = Promise<{ locale?: string }>;

// Create. The segment is `~new` (not `new`) because an item slug may legitimately BE "new" — the slug
// grammar (`^[a-z0-9]+(?:[.-][a-z0-9]+)*$`) cannot contain a tilde, so this can never shadow an item.
// The same editor renders it: a new item must be filled in before it can be created at all (required
// selects have no default), so create is "the form, then Create", not a bare slug box.
export default async function WebsiteNewItemPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site, collection: collectionKey } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId);
  const siteBase = `${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}`;

  const ctx = await loadSiteContext(c.userId, c.company, tenant, site);
  if (ctx.kind !== "ok") return <WdRefusal result={ctx} subject="this collection" retryHref={`${here}/~new`} />;
  const collection = ctx.data.collections.find((x) => x.key === collectionKey);
  if (!collection) return <WdRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" />;

  const locale = collection.composition.localized === false ? ctx.data.tenant.defaultLocale : (sp.locale ?? ctx.data.tenant.defaultLocale);
  const authors = await resolveAuthorNames(c.userId, c.company);

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Content", href: c.contentBase }, { label: ctx.data.site.name, href: siteBase }, { label: collectionLabel(collection), href: here }, { label: "New item" }]} />
      <ItemEditor
        mode="create"
        scope={{ tenantSlug: tenant, siteId: site }}
        routeBase={siteBase}
        collection={collection}
        tenant={ctx.data.tenant}
        site={ctx.data.site}
        seed={{ locale, twinOf: null, slug: "", fields: defaultFields(collection.composition.fields ?? []), seo: {}, extraBlocks: [] }}
        authors={authors}
        mediaPublicBase={mediaPublicBase()}
        readOnlyReason={null}
      />
    </div>
  );
}
