import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listMedia, mediaPublicBase } from "@/lib/webdeskMedia";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MediaLibrary } from "@/components/webdesk/content/MediaLibrary";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website → Media → site: the site's media library (WSK-43c). Two reads before anything is drawn: the site (for its locales,
// which are the languages alt text is written in) and the first page of assets. If EITHER is a refusal the page returns the
// refusal and NO grid is built: "WebDesk is unavailable" must never read as "the library is empty". Everything after that
// (filters, paging, uploads, edits, deletes) is the client component talking to server actions.
export default async function WebsiteMediaPage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "media");
  const here = `${c.mediaBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const [sites, list, authors] = await Promise.all([
    listSites(c.userId, c.company),
    listMedia(c.userId, c.company, tenant, site, { limit: 48 }),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the media library" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the media library" />;
  if (list.kind !== "ok") return <WdRefusal result={list} subject="the media library" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Media", href: c.mediaBase }, { label: s.name }]} />
      <p className="wc-lede">
        The images and files {s.name} uses. A media field in the content editor picks from here. Alt text is written per language ({t.locales.join(", ")}; default {t.defaultLocale}).
      </p>
      <MediaLibrary
        mode="manage"
        scope={{ tenantSlug: tenant, siteId: site }}
        routeBase={`${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`}
        locales={t.locales}
        initial={{ list: list.data, loadedAt: new Date().toISOString() }}
        authors={authors}
        publicBase={mediaPublicBase()}
      />
    </div>
  );
}
