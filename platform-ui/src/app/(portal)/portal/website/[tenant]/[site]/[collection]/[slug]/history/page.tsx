import {
  getPortalVersion, listPortalRequests, listPortalVersions, loadPortalSiteContext, portalAuthorNames, resolvePortalItemBySlug, resolveWebsiteAccess,
} from "@/lib/portalWebsite";
import { portalRestoreVersionAndOpenAction } from "@/lib/portalWebsiteActions";
import { portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { collectionLabel, diffContent, splitVersionContent } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { HistoryPanel } from "@/components/webdesk/content/HistoryPanel";
import { NoWebsiteAccess, PortalWebsiteRefusal } from "@/components/portal/website/PortalWebsiteStates";

type Params = Promise<{ tenant: string; site: string; collection: string; slug: string }>;
type Search = Promise<{ locale?: string; compare?: string }>;

// …/[slug]/history (WSK-49d) — the page's versions, who made each, a diff against what is live, and "Restore as draft". The shared
// `HistoryPanel` in CLIENT MODE: no content hash, and restore goes through the portal's route (which has the same stale-base and
// "only what you could have changed" refusals as saving, in the same words). A deleted page's history is not readable to a client.
export default async function PortalWebsiteItemHistoryPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant: tenantSlug, site, collection: collectionKey, slug } = await params;
  const sp = await searchParams;
  const access = await resolveWebsiteAccess();
  if (!access) return <NoWebsiteAccess />;
  const { userId, tenant, clientId, me } = access;
  const siteBase = portalWebsiteHref(tenantSlug, site);
  const itemBase = `${siteBase}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(slug)}`;
  const head = <PortalPageHead eyebrow="Your website" title="Version history" />;

  const ctx = await loadPortalSiteContext(userId, tenant, clientId, tenantSlug, site);
  if (ctx.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={ctx} subject="this page's history" retryHref={`${itemBase}/history`} /></>;
  const collection = ctx.data.collections.find((x) => x.key === collectionKey);
  if (!collection) return <>{head}<PortalWebsiteRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" /></>;
  const locale = collection.composition.localized === false ? ctx.data.tenant.defaultLocale : (sp.locale ?? ctx.data.tenant.defaultLocale);
  const localeQs = `?locale=${encodeURIComponent(locale)}`;

  const item = await resolvePortalItemBySlug(userId, tenant, clientId, tenantSlug, site, collectionKey, slug, locale);
  if (item.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={item} subject="this page" retryHref={`${itemBase}/history${localeQs}`} /></>;
  const [versions, requests] = await Promise.all([
    listPortalVersions(userId, tenant, clientId, tenantSlug, site, item.data.itemId),
    listPortalRequests(userId, tenant, clientId, "all"),
  ]);
  if (versions.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={versions} subject="this page's versions" retryHref={`${itemBase}/history${localeQs}`} /></>;

  // `?compare=n` — field-level diff of version n against what is live, with the collection's own labels.
  let compare: Parameters<typeof HistoryPanel>[0]["compare"] = null;
  const n = Number(sp.compare);
  if (sp.compare && Number.isInteger(n)) {
    const live = item.data.publishedVersion;
    if (live === null) {
      compare = { version: n, problem: "Nothing is live for this page, so there is nothing to compare against." };
    } else {
      const [mine, theirs] = await Promise.all([
        getPortalVersion(userId, tenant, clientId, tenantSlug, site, item.data.itemId, n),
        getPortalVersion(userId, tenant, clientId, tenantSlug, site, item.data.itemId, live),
      ]);
      if (mine.kind !== "ok" || theirs.kind !== "ok") {
        compare = { version: n, problem: "Couldn't read the versions to compare. This is not a statement that they are identical." };
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
      <PortalPageHead eyebrow="Your website" title={`History of ${item.data.title || item.data.slug}`} />
      <Breadcrumbs items={[
        { label: "Website", href: "/portal/website" }, { label: ctx.data.siteInfo.name, href: siteBase },
        { label: collectionLabel(collection), href: `${siteBase}/${encodeURIComponent(collectionKey)}` },
        { label: slug, href: `${itemBase}${localeQs}` }, { label: "History" },
      ]} />
      <HistoryPanel
        scope={{ tenantSlug, siteId: site }}
        item={item.data}
        versions={versions.data}
        authors={portalAuthorNames(me, requests.kind === "ok" ? requests.data : [])}
        historyHref={`${itemBase}/history${localeQs}`}
        editorHref={`${itemBase}${localeQs}`}
        compare={compare}
        restoreAndOpen={portalRestoreVersionAndOpenAction.bind(null, clientId)}
        clientMode
      />
    </div>
  );
}
