import Link from "next/link";
import { redirect } from "next/navigation";
import { listPortalItems, listPortalRequests, loadPortalSiteContext, portalAuthorNames, resolveWebsiteAccess, websiteAccessOk } from "@/lib/portalWebsite";
import { collectionEditability, createBlockedCopy, PORTAL_COPY, portalWebsiteHref } from "@/lib/portalWebsiteModel";
import { collectionLabel } from "@/lib/webdeskContentModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalWebsiteRefusal, WebsiteAccessRefused } from "@/components/portal/website/PortalWebsiteStates";
import { PortalItemsTable } from "@/components/portal/website/PortalItemsTable";
import "@/components/webdesk/content/content.css";

// `tenant` is the WEBDESK tenant slug of the site (a route segment), NEVER the ERP company: the company always comes from
// `getActivePortalCompany` (via `resolveWebsiteAccess`), so a URL can never switch which company's data is read (PV-D10).
type Params = Promise<{ tenant: string; site: string; collection: string }>;
type Search = Promise<{ locale?: string; state?: string; q?: string; cursor?: string }>;

// The states a client can filter by. `deleted` is deliberately absent: a client never sees a deleted page, and the BFF answers 400 to
// a request for one, so the page never sends it (a hand-typed `?state=deleted` is dropped, not forwarded).
const STATES: { value: string; label: string }[] = [
  { value: "", label: "Any state" }, { value: "live", label: "Live" }, { value: "draft", label: "Draft, not live" }, { value: "pending", label: "Changes not published" },
];

// A collection's pages (WSK-49d): each page's state, a filter, "New page" where a client may create one (and, where not, why),
// and the two ways to publish (WSK-D58). A SINGLE-PAGE collection opens its editor directly, as in the staff workspace.
export default async function PortalWebsiteCollectionPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant: tenantSlug, site, collection: collectionKey } = await params;
  const sp = await searchParams;
  const access = await resolveWebsiteAccess();
  if (!websiteAccessOk(access)) return <WebsiteAccessRefused refusal={access} />;
  const { userId, tenant, clientId, me } = access;
  const siteBase = portalWebsiteHref(tenantSlug, site);
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}`;
  const head = <PortalPageHead eyebrow="Your website" title="Website" />;

  const ctx = await loadPortalSiteContext(userId, tenant, clientId, tenantSlug, site);
  if (ctx.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={ctx} subject="this collection" retryHref={here} /></>;
  const collection = ctx.data.collections.find((c) => c.key === collectionKey);
  if (!collection) return <>{head}<PortalWebsiteRefusal result={{ kind: "not_found", slug: "collection-not-found" }} subject="this collection" /></>;
  const defaultLocale = ctx.data.tenant.defaultLocale;
  const editable = collection.clientEditable;
  const label = collectionLabel(collection);

  if (collection.composition.singleton) {
    const all = await listPortalItems(userId, tenant, clientId, tenantSlug, site, collectionKey, { limit: 100 });
    if (all.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={all} subject="this page" retryHref={here} /></>;
    const want = sp.locale ?? defaultLocale;
    const hit = all.data.items.find((i) => i.locale === want) ?? all.data.items.find((i) => i.locale === defaultLocale) ?? all.data.items[0];
    if (hit) redirect(`${here}/${encodeURIComponent(hit.slug)}?locale=${encodeURIComponent(hit.locale)}`);
    if (editable.create.allowed) redirect(`${here}/~new?locale=${encodeURIComponent(want)}`);
    return (
      <>
        <PortalPageHead eyebrow="Your website" title={label} />
        <Breadcrumbs items={[{ label: "Website", href: "/portal/website" }, { label: ctx.data.siteInfo.name, href: siteBase }, { label }]} />
        <EmptyNote>{createBlockedCopy(editable, collection.composition.fields) ?? PORTAL_COPY.noItems}</EmptyNote>
      </>
    );
  }

  const state = STATES.some((s) => s.value === sp.state) ? sp.state : undefined;
  const filters = { locale: sp.locale, state, q: sp.q };
  const filtered = !!(filters.locale || filters.state || filters.q);
  const [list, pendingReqs] = await Promise.all([
    listPortalItems(userId, tenant, clientId, tenantSlug, site, collectionKey, { locale: filters.locale, state: filters.state, q: filters.q, cursor: sp.cursor }),
    listPortalRequests(userId, tenant, clientId, "pending"),
  ]);
  if (list.kind !== "ok") return <>{head}<PortalWebsiteRefusal result={list} subject={`the ${label} pages`} retryHref={here} /></>;

  const pendingIds = pendingReqs.kind === "ok" ? [...new Set(pendingReqs.data.flatMap((r) => r.itemIds))] : [];
  const authors = portalAuthorNames(me, pendingReqs.kind === "ok" ? pendingReqs.data : [], list.data.authors);
  const labelOf = Object.fromEntries(list.data.items.map((i) => [i.itemId, i.title || i.slug]));
  const e = collectionEditability(editable);
  const blocked = createBlockedCopy(editable, collection.composition.fields);
  const nextHref = list.data.page.hasMore && list.data.page.cursor
    ? `${here}?${new URLSearchParams({ ...(filters.locale ? { locale: filters.locale } : {}), ...(filters.state ? { state: filters.state } : {}), ...(filters.q ? { q: filters.q } : {}), cursor: list.data.page.cursor }).toString()}`
    : null;

  return (
    <>
      <PortalPageHead eyebrow="Your website" title={label} lead={collection.composition.ui?.description ?? `${collection.counts.items} pages, ${collection.counts.live} live, ${collection.counts.pendingChanges} with changes not published.`} />
      <Breadcrumbs items={[{ label: "Website", href: "/portal/website" }, { label: ctx.data.siteInfo.name, href: siteBase }, { label }]} />
      <div className="wc-page">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <p className="wc-lede" data-testid="editable-note">
            <span className={`wc-chip${e.any ? " wc-chip--ok" : ""}`}>{e.label}</span>{" "}
            {e.any ? "Fields marked “Managed by Gaiada” are read-only for you." : PORTAL_COPY.nothingEditable}
          </p>
          {editable.create.allowed
            ? <Link href={`${here}/~new?locale=${encodeURIComponent(filters.locale ?? defaultLocale)}`} className="lux-btn lux-btn--solid lux-btn--sm" data-testid="new-item">New page</Link>
            : <p className="wc-muted" data-testid="create-blocked" role="note">{blocked}</p>}
        </div>

        {pendingReqs.kind !== "ok" && (
          <div className="wc-banner wc-banner--warn" role="note" data-testid="pending-unknown">
            <span className="wc-banner__body">Couldn&apos;t check which pages are already in a publish request, so none are marked below. A page you add to a new request may already be in another.</span>
          </div>
        )}

        <form method="get" action={here} className="wc-filter" aria-label="Filter pages">
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="f-locale">Language</label>
            <select id="f-locale" name="locale" className="lux-field__control" defaultValue={filters.locale ?? ""}>
              <option value="">All languages</option>
              {ctx.data.tenant.locales.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
          </div>
          <div className="lux-field">
            <label className="lux-field__label" htmlFor="f-state">State</label>
            <select id="f-state" name="state" className="lux-field__control" defaultValue={filters.state ?? ""}>
              {STATES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="lux-field wc-filter__q">
            <label className="lux-field__label" htmlFor="f-q">Search</label>
            <input id="f-q" name="q" className="lux-field__control" defaultValue={filters.q ?? ""} placeholder="Title or page address" />
          </div>
          <button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Apply</button>
          {filtered && <Link href={here} className="lux-btn lux-btn--ghost lux-btn--sm">Clear</Link>}
        </form>

        {list.data.items.length === 0 ? (
          <Card title="Pages"><EmptyNote>{filtered ? "No pages match these filters." : PORTAL_COPY.noItems}</EmptyNote></Card>
        ) : (
          <PortalItemsTable
            clientId={clientId} scope={{ tenantSlug, siteId: site }} editorBase={here} items={list.data.items}
            pendingIds={pendingIds} viewerId={me.userId} authors={authors} labelOf={labelOf} defs={collection.composition.fields}
          />
        )}
        {nextHref && <div className="wc-pager"><Link href={nextHref} className="lux-btn lux-btn--ghost lux-btn--sm">Next page</Link></div>}
      </div>
    </>
  );
}
