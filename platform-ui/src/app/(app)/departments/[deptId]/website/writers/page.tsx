import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website -> Writers' room. Which site's review board to open. Same shape as Content, Media, Analytics and Leads: one site goes
// straight in, several are listed, a failed read is a refusal and never an empty list of sites.
export default async function WebsiteWritersIndexPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writers' room" retryHref={c.writersBase} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) redirect(`${c.writersBase}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room" }]} />
      <p className="wc-lede">Pick a website to see its review board: what is a draft, in review, waiting on changes or approved.</p>
      <SitesPanel sites={sites.data} contentBase={c.writersBase} />
    </div>
  );
}
