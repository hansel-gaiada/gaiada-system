import Link from "next/link";
import { loadSiteContext } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { CollectionsPanel } from "@/components/webdesk/content/CollectionsPanel";
import { RequestKeyPanel } from "@/components/webdesk/content/RequestKeyPanel";
import { can } from "@/lib/rbac";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website → Content → site: the collections, grouped by `composition.ui.group`, with items by locale,
// live count and PENDING CHANGES per collection. Below them, "API keys": ask for a read/write key for one of the site's environments
// (files an approval; nothing is created until someone else approves). The control renders only for a user whose role can pass the
// BFF's gate (`webdev.promote` mirrors Cerbos `promote` on `webdev_provisioned_site`); everyone else sees nothing, not a disabled button.
export default async function WebsiteSitePage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId);
  const here = `${c.contentBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const ctx = await loadSiteContext(c.userId, c.company, tenant, site);
  if (ctx.kind !== "ok") return <WdRefusal result={ctx} subject="this site's content" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Content", href: c.contentBase }, { label: ctx.data.site.name }]} />
      <p className="wc-lede">
        {ctx.data.site.name} · locales {ctx.data.tenant.locales.join(", ")} (default {ctx.data.tenant.defaultLocale}). Pending changes are drafts whose head differs from what is live.
      </p>
      <CollectionsPanel collections={ctx.data.collections} siteBase={here} />
      <p className="wc-lede" data-testid="media-link">
        Images and files: <Link href={`/departments/${encodeURIComponent(deptId)}/website/media/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`}>open this site&apos;s media library</Link>.
      </p>
      <RequestKeyPanel
        allowed={can(c.me, "webdev.promote", c.company)}
        scope={{ tenantSlug: tenant, siteId: site }}
        environments={ctx.data.site.environments}
      />
    </div>
  );
}
