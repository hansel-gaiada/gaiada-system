import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { listQuarantine } from "@/lib/webdeskMediaReview";
import { QUEUE_FORBIDDEN_COPY } from "@/lib/webdeskMediaReviewModel";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Card } from "@/components/ui";
import { QuarantinePanel } from "@/components/webdesk/media/QuarantinePanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;

// Website -> Writers' room -> Uploads awaiting review -> site (M5-W1q, WSK-D84): the contributor upload quarantine. WHO may review is the BFF's
// answer (Cerbos `webdesk_media_asset:review`), not a guess from roles: a 403 on the queue read is the plain "you can't review uploads here"
// state, never an empty list. What each row's buttons do follows that upload's own `allowed.review`.
export default async function WebsiteWritersUploadsPage({ params }: { params: Params }) {
  const { deptId, tenant, site } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const base = `${c.writersBase}/uploads`;
  const here = `${base}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the uploads" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the uploads" />;

  const queue = await listQuarantine(c.userId, c.company, t.slug, s.siteId);
  const crumbs = [{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "Uploads awaiting review", href: base }, { label: s.name }];
  if (queue.kind === "forbidden") {
    return (
      <div className="wc-page">
        <Breadcrumbs items={crumbs} />
        <Card title="Uploads awaiting review">
          <EmptyNote>
            <span data-testid="uploads-forbidden">{QUEUE_FORBIDDEN_COPY}</span>
          </EmptyNote>
        </Card>
      </div>
    );
  }
  if (queue.kind !== "ok") return <WdRefusal result={queue} subject="the uploads" retryHref={here} />;

  const people = await resolveAuthorNames(c.userId, c.company);
  return (
    <div className="wc-page">
      <Breadcrumbs items={crumbs} />
      <p className="wc-lede">Files freelance writers uploaded to {s.name}. Each one is held until you accept it; nothing here is public.</p>
      <QuarantinePanel scope={{ tenantSlug: t.slug, siteId: s.siteId }} initial={queue.data} people={people} />
    </div>
  );
}
