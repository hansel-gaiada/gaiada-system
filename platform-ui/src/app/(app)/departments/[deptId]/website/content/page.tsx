import { redirect } from "next/navigation";
import { listSites } from "@/lib/webdeskContent";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SitesPanel } from "@/components/webdesk/content/SitesPanel";
import { WdRefusal } from "@/components/webdesk/content/WdRefusal";
import { requireWebsiteCtx } from "@/components/webdesk/content/serverCtx";

type Params = Promise<{ deptId: string }>;

// Website → Content. The sites this company can edit (`tenant.list?companyRef`, filtered server-side
// by the BFF — the cross-company wall is `resolveEditableSite`, not this page). With exactly one site
// (gaiada.com today) it redirects straight into it, as §10 specifies.
export default async function WebsiteContentPage({ params }: { params: Params }) {
  const { deptId } = await params;
  const c = await requireWebsiteCtx(deptId);
  const sites = await listSites(c.userId, c.company);
  // Early return BEFORE anything that could draw a list: a refusal is never an empty list (§10).
  if (sites.kind !== "ok") return <WdRefusal result={sites} subject="the Website workspace" retryHref={c.contentBase} />;

  const all = sites.data.tenants.flatMap((t) => t.sites.map((s) => ({ t, s })));
  if (all.length === 1) {
    redirect(`${c.contentBase}/${encodeURIComponent(all[0].t.slug)}/${encodeURIComponent(all[0].s.siteId)}`);
  }
  return (
    <div className="wc-page">
      <Breadcrumbs items={[{ label: "Website" }, { label: "Content" }]} />
      <p className="wc-lede">Edit the content of the websites this company runs on WebDesk. Changes are saved as drafts; publishing is requested separately and approved by someone with the right to.</p>
      <SitesPanel sites={sites.data} contentBase={c.contentBase} />
    </div>
  );
}
