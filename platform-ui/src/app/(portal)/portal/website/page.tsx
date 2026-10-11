import Link from "next/link";
import { buildRequestViews, listPortalRequests, listPortalSites, resolveWebsiteAccess, websiteAccessOk } from "@/lib/portalWebsite";
import { switchWebsiteClient } from "@/lib/portalWebsiteActions";
import { PORTAL_COPY, portalWebsiteHref, splitRequests, type RequestView } from "@/lib/portalWebsiteModel";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalWebsiteRefusal, WebsiteAccessRefused } from "@/components/portal/website/PortalWebsiteStates";
import { PortalRequestsPanel } from "@/components/portal/website/PortalRequestsPanel";
import "@/components/webdesk/content/content.css";

// WSK-49d — the client portal's Website area: the client's own editors edit and publish their website here.
//
// The page GUARDS ITSELF: a viewer without a `client_website_editor` grant for the active client (a staff member, a contact without the
// grant, anyone who typed the URL) gets the plain "You don't have website editing access" page, never a confident empty list. The BFF
// refuses them as well; this is the words, not the wall.
//
// Two things on this page: the client's LINKED sites (only those: §16j's site wall), and the client's publish requests (WSK-D58),
// where a colleague's batch is approved. Pages are reached site -> collection -> page.
export default async function PortalWebsitePage() {
  const access = await resolveWebsiteAccess();
  if (!websiteAccessOk(access)) return <WebsiteAccessRefused refusal={access} />;
  const { userId, tenant, clientId, clientName, clients } = access;
  const head = <PortalPageHead eyebrow="Your website" title="Website" lead="Edit the text and images of your website, preview your changes, and publish them." />;

  const [sites, requests] = await Promise.all([
    listPortalSites(userId, tenant, clientId),
    listPortalRequests(userId, tenant, clientId, "all"),
  ]);
  if (sites.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={sites} subject="your website" retryHref="/portal/website" /></>;

  // Name the pages of the requests that are shown (the waiting ones, and the latest few decided).
  let views: RequestView[] | null = null;
  let requestsProblem: string | null = null;
  if (requests.kind === "ok") {
    const { pending, decided } = splitRequests(requests.data);
    views = await buildRequestViews(userId, tenant, clientId, [...pending, ...decided], sites.data.sites);
  } else {
    requestsProblem = requests.kind === "unavailable" ? PORTAL_COPY.unavailable : "You can't see publish requests right now.";
  }
  const waiting = views?.filter((r) => r.status === "pending").length ?? 0;

  return (
    <>
      {head}
      <div className="cp-stack">
        {clients.length > 1 && (
          <Card title="Which website">
            <form action={switchWebsiteClient} style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="lux-field">
                <label className="lux-field__label" htmlFor="website-client">Showing the website of</label>
                <select id="website-client" name="clientId" className="lux-field__control" defaultValue={clientId}>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Show</button>
            </form>
          </Card>
        )}

        <Card title={clients.length > 1 ? `Sites of ${clientName}` : "Your sites"}>
          {sites.data.sites.length === 0 ? (
            <EmptyNote>{PORTAL_COPY.noSites}</EmptyNote>
          ) : (
            <div className="wc-sites" data-testid="sites">
              {sites.data.sites.map((s) => (
                <Link key={`${s.tenantSlug}/${s.siteId}`} href={portalWebsiteHref(s.tenantSlug, s.siteId)} className="wc-site" data-testid={`site-${s.siteId}`}>
                  <span className="wc-site__name">{s.name}</span>
                  <span className="wc-muted">Languages: {s.locales.join(", ")}</span>
                  <span className="wc-muted">Open to edit its pages</span>
                </Link>
              ))}
            </div>
          )}
        </Card>

        <section id="requests" aria-labelledby="requests-h">
          <h2 id="requests-h" className="wc-sr">Publish requests</h2>
          <Card title={`Publish requests${waiting > 0 ? ` (${waiting} waiting)` : ""}`} hint="A group of pages published together needs one person to ask and another person from your company to approve.">
            <PortalRequestsPanel clientId={clientId} requests={views} loadProblem={requestsProblem} />
          </Card>
        </section>
      </div>
    </>
  );
}
