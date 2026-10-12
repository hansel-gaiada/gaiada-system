import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website -> Writers' room -> People. Which site's writers to manage. Whether the viewer MAY manage them is the BFF's answer on the
// next page (a 403 there is "you can't manage writers here"); this page only lists the company's sites.
export default async function WebsiteWritersPeopleIndexPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId, "writers");
  const base = `${c.writersBase}/people`;
  const sites = await listSites(c.userId, c.company);
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the writers' room" retryHref={base} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) redirect(`${base}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Writers' room", href: c.writersBase }, { label: "People" }]} />
      <p className="wc-lede">Pick a website to see who holds writers&apos; room roles on it and to give or remove them.</p>
      <SitesPanel sites={sites.data} contentBase={base} />
    </div>
  );
}
