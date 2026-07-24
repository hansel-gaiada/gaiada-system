import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ImageStudio } from "@/components/creative/ImageStudio";

type Params = Promise<{ deptId: string }>;

// Image Studio sub-tab (Creatives → Studio group) — the client-side image
// auto-correction & grading workspace. The saved-asset library lives in its own
// sibling "Asset Library" sub-tab (../assets). Only departments whose toolkit
// declares the "studio" tab (Creatives) expose it; anyone else falls through.
export default async function ImageStudioPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasStudio = deptTabs(toolkitFor(dept.name)).some((t) => t.path === "studio");
  if (!hasStudio) {
    return (
      <Card title="Image Studio">
        <EmptyNote>The Image Studio isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  return (
    <Card title="Image Studio">
      <ImageStudio deptId={deptId} />
    </Card>
  );
}
