import { getVersion, listVersions, loadSiteContext, resolveAuthorNames, resolveItemBySlug } from "@/lib/webdeskContent";
import { collectionLabel, diffContent, splitVersionContent } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { HistoryPanel } from "@/components/webdesk/content/HistoryPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string; collection: string; slug: string }>;
type Search = Promise<{ locale?: string; compare?: string }>;

// …/[slug]/history — versions (author resolved in the ERP), diff against live, Restore as draft.
export default async function WebsiteItemHistoryPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site, collection: collectionKey, slug } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId);
  const siteBase = `${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const itemBase = `${siteBase}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(slug)}`;

  const ctx = await loadSiteContext(c.userId, c.company, tenant, site);
  if (ctx.kind !== "ok") return <WdRefusal result={ctx} subject="this item's history" retryHref={`${itemBase}/history`} />;
  const collection = ctx.data.collections.find((x) => x.key === collectionKey);
  if (!collection) return <WdRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" />;
  const locale = collection.composition.localized === false ? ctx.data.tenant.defaultLocale : (sp.locale ?? ctx.data.tenant.defaultLocale);
  const localeQs = `?locale=${encodeURIComponent(locale)}`;

  const item = await resolveItemBySlug(c.userId, c.company, tenant, site, collectionKey, slug, locale);
  if (item.kind !== "ok") return <WdRefusal result={item} subject="this item" retryHref={`${itemBase}/history${localeQs}`} />;
  const [versions, authors] = await Promise.all([
    listVersions(c.userId, c.company, tenant, site, item.data.itemId),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (versions.kind !== "ok") return <WdRefusal result={versions} subject="this item's versions" retryHref={`${itemBase}/history${localeQs}`} />;

  // `?compare=n` — field-level diff of version n against what is live. Computed from the two stored
  // versions with the collection's own composition, so labels are the editor's labels.
  let compare: Parameters<typeof HistoryPanel>[0]["compare"] = null;
  const n = Number(sp.compare);
  if (sp.compare && Number.isInteger(n)) {
    const live = item.data.publishedVersion;
    if (live === null) {
      compare = { version: n, problem: "Nothing is live for this item, so there is nothing to diff against." };
    } else {
      const [mine, theirs] = await Promise.all([
        getVersion(c.userId, c.company, tenant, site, item.data.itemId, n),
        getVersion(c.userId, c.company, tenant, site, item.data.itemId, live),
      ]);
      if (mine.kind !== "ok" || theirs.kind !== "ok") {
        const bad = mine.kind !== "ok" ? mine : theirs;
        compare = { version: n, problem: `Couldn't read the versions to compare (${bad.kind === "unavailable" ? bad.reason : bad.kind}). This is not a statement that they are identical.` };
      } else {
        compare = {
          version: n, liveVersion: live,
          changes: diffContent(
            collection.composition,
            splitVersionContent(collectionKey, theirs.data.blocks, theirs.data.seo),
            splitVersionContent(collectionKey, mine.data.blocks, mine.data.seo),
          ),
        };
      }
    }
  }

  return (
    <div className="wc-page">
      <Breadcrumbs items={[
        { label: "Website" }, { label: "Content", href: c.contentBase }, { label: ctx.data.site.name, href: siteBase },
        { label: collectionLabel(collection), href: `${siteBase}/${encodeURIComponent(collectionKey)}` },
        { label: slug, href: `${itemBase}${localeQs}` }, { label: "History" },
      ]} />
      <HistoryPanel
        scope={{ tenantSlug: tenant, siteId: site }}
        item={item.data}
        versions={versions.data}
        authors={authors}
        historyHref={`${itemBase}/history${localeQs}`}
        editorHref={`${itemBase}${localeQs}`}
        compare={compare}
      />
    </div>
  );
}
