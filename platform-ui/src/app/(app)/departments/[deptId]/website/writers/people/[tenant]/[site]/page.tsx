import { listCollections, listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listEditorialGrants } from "@/lib/webdeskEditorial";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { GrantsManager } from "@/components/webdesk/editorial/GrantsManager";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website -> Writers' room -> People -> site: who holds which writers' room role here. PUBLISHER TIER, decided by the BFF and not by
// guessing roles: the grants read is Cerbos `manage_editorial` (company admin, owner, Web Dev manager), so a 403 from it is the plain
// "you can't manage writers here" state, never an empty list and never a form.
export default async function WebsiteWritersPeoplePage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const base = `${c.writersBase}/people`;
  const here = `${base}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writers" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the writers" />;

  const grants = await listEditorialGrants(c.userId, c.company, t.slug, s.siteId);
  const crumbs = [{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "People", href: base }, { label: s.name }];
  if (grants.kind === "forbidden") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <Card title="Writers">
          <EmptyNote>
            <span data-testid="people-forbidden">You can&apos;t manage writers here. Only a publisher (a company admin or a Web Dev manager) can give and remove writers&apos; room roles. Ask one of them if you need a role on this site.</span>
          </EmptyNote>
        </Card>
      </div>
    );
  }
  if (grants.kind !== "ok") return <WdRefusal result={grants} subject="the writers" retryHref={here} />;

  const [collections, people] = await Promise.all([
    listCollections(c.userId, c.company, t.slug, s.siteId),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (collections.kind !== "ok") return <WdRefusal result={collections} subject="the site's collections" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <p className="wc-lede">Who holds a writers&apos; room role on {s.name}, and what each role covers. Roles are given per site, collection and language, and are checked again by the server every time.</p>
      <GrantsManager
        scope={{ tenantSlug: t.slug, siteId: s.siteId }}
        initial={grants.data}
        people={people}
        collections={collections.data.map((x) => x.key)}
        locales={t.locales}
      />
    </div>
  );
}
