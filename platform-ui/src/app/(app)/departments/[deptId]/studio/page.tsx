import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { activeCompany } from "@/lib/companyContext";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ImageStudio } from "@/components/creative/ImageStudio";
import { readAssetVersions } from "@/lib/creativeReviews-data";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ versionOf?: string | string[] }>;

// Image Studio sub-tab (Creatives → Studio group) — the client-side image
// auto-correction & grading workspace. The saved-asset library lives in its own
// sibling "Asset Library" sub-tab (../assets). Only departments whose toolkit
// declares the "studio" tab (Creatives) expose it; anyone else falls through.
export default async function ImageStudioPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasStudio = deptTabs(toolkitFor(activeCompany(me, tenant)?.vertical, dept.name)).some((t) => t.path === "studio");
  if (!hasStudio) {
    return (
      <Card title="Image Studio">
        <EmptyNote>The Image Studio isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  // DW-6h §35.6: `?versionOf=<assetId>` (the asset detail's "Edit in Image Studio") offers "Save as a new version of <name>".
  // The asset is looked up through the versions reader (the server authorises); anything unreadable simply offers no version save.
  const sp = await searchParams;
  const raw = Array.isArray(sp.versionOf) ? sp.versionOf[0] : sp.versionOf;
  let versionOf: { id: string; name: string } | undefined;
  if (raw) {
    const v = await readAssetVersions(userId, tenant, raw);
    if (v.kind === "ok") {
      const latest = v.data.find((x) => x.isLatest) ?? v.data[0];
      if (latest) versionOf = { id: latest.id, name: latest.name };
    }
  }

  return (
    <Card title="Image Studio">
      <ImageStudio deptId={deptId} versionOf={versionOf} />
    </Card>
  );
}
