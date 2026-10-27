import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website -> Writers' room -> Uploads awaiting review (M5-W1q, WSK-D84). Which site's quarantine to open. Whether the viewer MAY review is the
// BFF's answer on the next page (a 403 there is "you can't review uploads here"); this page only lists the company's sites.
export default async function WebsiteWritersUploadsIndexPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const base = `${c.writersBase}/uploads`;
  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writers' room" retryHref={base} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) redirect(`${base}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "Uploads awaiting review" }]} />
      <p className="wc-lede">Pick a website to see the files freelance writers have uploaded and that wait for your decision.</p>
      <SitesPanel sites={sites.data} contentBase={base} />
    </div>
  );
}
