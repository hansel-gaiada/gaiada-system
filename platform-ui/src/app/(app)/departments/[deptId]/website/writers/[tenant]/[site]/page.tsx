import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getEditorialBoard } from "@/lib/webdeskEditorial";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { WritersBoard } from "@/components/webdesk/editorial/WritersBoard";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string; tenant: string; site: string }>;
type Search = Promise<{ state?: string; collection?: string; cursor?: string }>;

// Website -> Writers' room -> site: the review board. The site must be one of this company's (listSites is the company wall), then
// the board comes from `GET …/editorial/board`. A refusal is a notice, never an empty board; a scoped caller gets no counts
// (`countsWithheld`) and the board says so instead of showing zeros.
export default async function WebsiteWritersBoardPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { deptId, tenant, site } = await params;
  const sp = await searchParams;
  const c = await requireWebsiteCtx(deptId, "writers");
  const here = `${c.writersBase}/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the review board" retryHref={here} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="the review board" />;

  const [board, authors] = await Promise.all([
    getEditorialBoard(c.userId, c.company, t.slug, s.siteId, { state: sp.state, collection: sp.collection, cursor: sp.cursor }),
    resolveAuthorNames(c.userId, c.company),
  ]);
  if (board.kind !== "ok") return <WdRefusal result={board} subject="the review board" retryHref={here} />;

  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: s.name }]} />
      <WritersBoard
        board={board.data}
        editorBase={`${c.contentBase}/${encodeURIComponent(t.slug)}/${encodeURIComponent(s.siteId)}`}
        authors={authors}
        filters={{ state: sp.state, collection: sp.collection }}
        filterAction={here}
        peopleHref={`${c.writersBase}/people/${encodeURIComponent(t.slug)}/${encodeURIComponent(s.siteId)}`}
      />
    </div>
  );
}
