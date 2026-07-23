import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ImageStudio } from "@/components/creative/ImageStudio";
import { AssetLibrary } from "@/components/creative/AssetLibrary";
import { listCreativeAssets } from "@/lib/creative";

type Params = Promise<{ deptId: string }>;

// Image Studio tab — the creative department's client-side image auto-correction
// & grading workspace. Only departments whose toolkit declares the "studio" tab
// (Creatives) expose it; anyone else falls through to a note.
export default async function ImageStudioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasStudio = toolkitFor(dept.name).tabs.some((t) => t.path === "studio");
  if (!hasStudio) {
    return (
      <Card title="Image Studio">
        <EmptyNote>The Image Studio isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  // The persisted-asset library (originals + grade params) doubles as the phase-2 AI's
  // training set — surfaced here so the team can review captures and curate exemplars.
  const assets = await listCreativeAssets(userId, tenant);

  return (
    <>
      <Card title="Image Studio">
        <ImageStudio deptId={deptId} />
      </Card>
      <Card title="Saved assets & training set" style={{ marginTop: 16 }}>
        <AssetLibrary assets={assets} />
      </Card>
    </>
  );
}
