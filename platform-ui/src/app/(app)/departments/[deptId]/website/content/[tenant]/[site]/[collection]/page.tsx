import Link from "next/link";
import { redirect } from "next/navigation";
import { listItems, loadSiteContext, resolveAuthorNames } from "@/lib/webdeskContent";
import { collectionLabel } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ItemsPanel } from "@/components/webdesk/content/ItemsPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; collection: string }>;
type Search = Promise<{ locale?: string; state?: string; q?: string; cursor?: string }>;

// Website → Content → site → collection: the item list (locale / state / pending / search filters).
// A SINGLETON collection opens its editor directly (§10): one document per locale, so a list of one
// is noise. If the singleton has no item yet it goes straight to the create form.
export default async function WebsiteCollectionPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site, collection: collectionKey } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId);
  const siteBase = `${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}`;

  const ctx = await loadSiteContext(c.userId, c.company, tenant, site);
  if (ctx.kind !== "ok") return <WdRefusal result={ctx} subject="this collection" retryHref={here} />;
  const collection = ctx.data.collections.find((x) => x.key === collectionKey);
  if (!collection) return <WdRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" />;
  const defaultLocale = ctx.data.tenant.defaultLocale;

  if (collection.composition.singleton) {
    const all = await listItems(c.userId, c.company, tenant, site, collectionKey, { limit: 100 });
    if (all.kind !== "ok") return <WdRefusal result={all} subject="this document" retryHref={here} />;
    const want = sp.locale ?? defaultLocale;
    const hit = all.data.items.find((i) => i.locale === want) ?? all.data.items.find((i) => i.locale === defaultLocale) ?? all.data.items[0];
    if (hit) redirect(`${here}/${encodeURIComponent(hit.slug)}?locale=${encodeURIComponent(hit.locale)}`);
    redirect(`${here}/~new?locale=${encodeURIComponent(want)}`);
  }

  const [list, authors] = await Promise.all([
    listItems(c.userId, c.company, tenant, site, collectionKey, { locale: sp.locale, state: sp.state, q: sp.q, cursor: sp.cursor }),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (list.kind !== "ok") return <WdRefusal result={list} subject={`the ${collectionLabel(collection)} list`} retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Content", href: c.contentBase }, { label: ctx.data.site.name, href: siteBase }, { label: collectionLabel(collection) }]} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <p className="wc-lede">{collection.composition.ui?.description ?? `${collectionLabel(collection)} — ${collection.counts.items} items, ${collection.counts.live} live, ${collection.counts.pendingChanges} with pending changes.`}</p>
        <Link href={`${here}/~new?locale=${encodeURIComponent(sp.locale ?? defaultLocale)}`} className="lux-btn lux-btn--solid lux-btn--sm" data-testid="new-item">New item</Link>
      </div>
      <ItemsPanel
        list={list.data}
        locales={ctx.data.tenant.locales}
        filters={{ locale: sp.locale, state: sp.state, q: sp.q }}
        editorBase={here}
        authors={authors}
        filterAction={here}
      />
    </div>
  );
}
