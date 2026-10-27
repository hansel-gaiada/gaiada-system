import Link from "next/link";
import { contributorCtx } from "@/lib/contributorServer";
import { loadEditorBundle } from "@/lib/webdeskContent";
import { loadEditorialInitial } from "@/lib/webdeskEditorial";
import { ItemEditor } from "@/components/webdesk/content/ItemEditor";
import { ContributorRefusal } from "@/components/contributor/ContributorRefusal";

type Params = Promise<{ tenant: string; site: string; collection: string; slug: string }>;
type Search = Promise<{ locale?: string }>;

export const dynamic = "force-dynamic";

// M5-W1f: the editor in contributor mode: `/contributor/items/:tenant/:site/:collection/:slug?locale=en`. The same editor the staff use, with the
// publish bar, delete, writing assistant, version history and media library left out (see `ItemEditor`'s `contributorMode`). Every read here is one
// the W1d fence opens: the sites and collections, the item (with its `allowed`), the item's review record and comments. A refusal is words
// (`ContributorRefusal`), and the two-step notice for `assurance_high_required`; no form is ever built from a refused read.
export default async function ContributorItemPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { tenant, site, collection: collectionKey, slug } = await params;
  const sp = await searchParams;
  const c = await contributorCtx();
  if (c.kind !== "ok") return null;
  const siteBase = `/contributor/items/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const here = `${siteBase}/${encodeURIComponent(collectionKey)}/${encodeURIComponent(slug)}${sp.locale ? `?locale=${encodeURIComponent(sp.locale)}` : ""}`;
  if (!c.company) return <p data-testid="item-no-engagement" style={{ margin: 0 }}>You have no live engagement right now, so this item can&apos;t be opened.</p>;

  const bundle = await loadEditorBundle(c.userId, c.company, tenant, site, collectionKey, slug, sp.locale ?? null, { skipPublishReads: true });
  if (bundle.kind !== "ok") return <ContributorRefusal result={bundle} subject="this item" retryHref={here} />;
  const b = bundle.data;
  const editorial = await loadEditorialInitial(c.userId, c.company, tenant, site, b.detail);
  // The company directory (`/members`) is not open to a contributor, so only the caller's own name is known; other people read as a short id.
  const authors: Record<string, string> = { [c.me.userId]: c.me.name ?? c.me.email };

  return (
    <div className="wc-page">
      <p style={{ margin: "0 0 8px" }}><Link href="/contributor" data-testid="back-to-assignments">Back to my assignments</Link></p>
      <ItemEditor
        key={`${b.detail.item.itemId}`}
        mode="edit"
        contributorMode
        scope={{ tenantSlug: tenant, siteId: site }}
        routeBase={siteBase}
        collection={b.collection}
        tenant={b.tenant}
        site={b.site}
        bundle={b}
        authors={authors}
        editorial={editorial}
        readOnlyReason={b.detail.item.deletedAt ? "This item has been deleted." : null}
      />
    </div>
  );
}
