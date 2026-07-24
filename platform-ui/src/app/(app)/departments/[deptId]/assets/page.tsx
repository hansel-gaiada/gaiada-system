import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { AssetLibrary } from "@/components/creative/AssetLibrary";
import { listCreativeAssets } from "@/lib/creative";

type Params = Promise<{ deptId: string }>;

// Asset Library sub-tab (Creatives → Studio group). The persisted-asset library
// (saved originals + grade params) doubles as the phase-2 AI's training set —
// surfaced here so the team can review captures and curate exemplars. Split out
// of the Image Studio tab in the 2026-07-23 IA redesign so each has room. Gated
// on the toolkit declaring the "assets" tab; anyone else falls through.
export default async function AssetLibraryPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasAssets = deptTabs(toolkitFor(dept.name)).some((t) => t.path === "assets");
  if (!hasAssets) {
    return (
      <Card title="Asset Library">
        <EmptyNote>The Asset Library isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  const assets = await listCreativeAssets(userId, tenant);

  return (
    <Card title="Saved assets & training set">
      <AssetLibrary assets={assets} />
    </Card>
  );
}
