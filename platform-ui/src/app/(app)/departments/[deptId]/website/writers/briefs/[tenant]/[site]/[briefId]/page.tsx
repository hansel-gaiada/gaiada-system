import { listSites, resolveAuthorNames } from "@/lib/webdeskContent";
import { getBrief } from "@/lib/webdeskCalendar";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { BriefView } from "@/components/webdesk/editorial/BriefView";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";

type Params = Promise<{ deptId: string; tenant: string; site: string; briefId: string }>;

// Website -> Writers' room -> a brief (read-only). The BFF decides whether this caller may read it (`assign` on the brief's collection and
// locale, or `comment` on the linked item). A brief the caller may not read, or that does not exist on this site, is the same plain
// "not found or not yours": the BFF does not tell them apart either. Any other refusal is a notice.
export default async function WebsiteWritersBriefPage({ params }: { params: Params }) {
  const { deptId, tenant, site, briefId } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const siteBase = `${encodeURIComponent(tenant)}/${encodeURIComponent(site)}`;
  const boardHref = `${c.writersBase}/${siteBase}`;

  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="this brief" retryHref={boardHref} />;
  const t = sites.data.tenants.find((x) => x.slug === tenant);
  const s = t?.sites.find((x) => x.siteId === site);
  if (!t || !s) return <WdRefusal result={{ kind: "not_found", slug: "site-not-found" }} subject="this brief" />;

  const [brief, authors] = await Promise.all([getBrief(c.userId, c.company, t.slug, s.siteId, briefId), resolveAuthorNames(c.userId, c.company)]);
  // The BFF answers an unknown or another site's brief with a plain 404 (no problem slug): the shared mapper calls that "not served".
  // Here it is a real answer.
  if (brief.kind === "not_enabled" && brief.reason === "not_served") {
    return <Card title="Brief not found"><EmptyNote>This brief doesn&apos;t exist on this site, or you can&apos;t read it.</EmptyNote></Card>;
  }
  if (brief.kind !== "ok") return <WdRefusal result={brief} subject="this brief" retryHref={boardHref} />;

  const b = brief.data;
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: s.name, href: boardHref }, { label: b.topic }]} />
      <h2 style={{ margin: 0 }}>{b.topic}</h2>
      <BriefView brief={b} boardHref={boardHref} calendarHref={`${c.writersBase}/calendar/${siteBase}`} authors={authors} />
    </div>
  );
}
