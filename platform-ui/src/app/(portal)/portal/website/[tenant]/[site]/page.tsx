import Link from "next/link";
import { loadPortalSiteContext, resolveWebsiteAccess } from "@/lib/portalWebsite";
import { collectionEditability, PORTAL_COPY, portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { collectionLabel, groupCollections } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { NoWebsiteAccess, PortalWebsiteRefusal } from "@/components/portal/website/PortalWebsiteStates";
import "@/components/webdesk/content/content.css";

type Params = Promise<{ tenant: string; site: string }>;

// Website -> a site: its collections, each saying whether anything in it is yours to edit. The page says so per collection from the
// BFF's own `clientEditable` verdict (§16j), not from a guess: "You can edit this", "You can edit some fields", or "Managed by Gaiada".
export default async function PortalWebsiteSitePage({ params }: { params: Params }) {
  const { tenant: tenantSlug, site } = await params;
  const access = await resolveWebsiteAccess();
  if (!access) return <NoWebsiteAccess />;
  const here = portalWebsiteHref(tenantSlug, site);
  const head = <PortalPageHead eyebrow="Your website" title="Website" />;

  const ctx = await loadPortalSiteContext(access.userId, access.tenant, access.clientId, tenantSlug, site);
  if (ctx.kind !== "ok") {
    return <>{head}<Breadcrumbs items={[{ label: "Website", href: "/portal/website" }, { label: "Site" }]} /><PortalWebsiteRefusal result={ctx} subject="this site" retryHref={here} /></>;
  }
  const { siteInfo, collections } = ctx.data;

  return (
    <>
      <PortalPageHead eyebrow="Your website" title={siteInfo.name} lead={`Languages: ${siteInfo.locales.join(", ")}. Choose a collection to see its pages.`} />
      <Breadcrumbs items={[{ label: "Website", href: "/portal/website" }, { label: siteInfo.name }]} />
      <div className="cp-stack">
        {collections.length === 0 ? (
          <Card title="Collections"><EmptyNote>{PORTAL_COPY.noCollections}</EmptyNote></Card>
        ) : (
          <div className="wc-page" data-testid="collections">
            {groupCollections(collections).map(({ group, collections: cs }) => (
              <section key={group} aria-label={group}>
                <h2 className="wc-group-head">{group}</h2>
                <div className="wc-scroll">
                  <table className="wc-table">
                    <thead>
                      <tr><th scope="col">Collection</th><th scope="col">Who edits it</th><th scope="col" className="wc-table__num">Pages</th><th scope="col" className="wc-table__num">Live</th><th scope="col" className="wc-table__num">Changes not published</th></tr>
                    </thead>
                    <tbody>
                      {cs.map((c) => {
                        const e = collectionEditability((c as (typeof collections)[number]).clientEditable);
                        return (
                          <tr key={c.key} data-testid={`collection-${c.key}`} data-editable={e.any || undefined}>
                            <td>
                              <Link href={portalWebsiteHref(tenantSlug, site, c.key)}>{collectionLabel(c)}</Link>
                              {c.composition.singleton && <span className="wc-muted"> · single page</span>}
                              {c.composition.ui?.description && <div className="wc-muted">{c.composition.ui.description}</div>}
                            </td>
                            <td><span className={`wc-chip${e.any ? " wc-chip--ok" : ""}`} data-testid="editable-chip">{e.label}</span></td>
                            <td className="wc-table__num">{c.counts.items}</td>
                            <td className="wc-table__num">{c.counts.live}</td>
                            <td className="wc-table__num">{c.counts.pendingChanges > 0 ? <span className="wc-chip wc-chip--warn">{c.counts.pendingChanges}</span> : 0}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        )}
        <p className="wc-lede" data-testid="media-link">
          Images and files: <Link href={portalWebsiteHref(tenantSlug, site, "~media")}>open this site&apos;s media library</Link>.
        </p>
      </div>
    </>
  );
}
