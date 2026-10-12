import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website -> Writers' room -> Dashboard. Which site's dashboard to open. One site goes straight in, several are listed, a failed read is
// a refusal and never an empty list of sites.
export default async function WebsiteWritersDashboardIndexPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const base = `${c.writersBase}/dashboard`;
  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writer dashboard" retryHref={base} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) redirect(`${base}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "Dashboard" }]} />
      <p className="wc-lede">Pick a website to see how its published articles are doing.</p>
      <SitesPanel sites={sites.data} contentBase={base} />
    </div>
  );
}
