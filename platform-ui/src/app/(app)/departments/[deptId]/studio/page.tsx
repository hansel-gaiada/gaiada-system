import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor } from "@/lib/deptToolkits";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ImageStudio } from "@/components/creative/ImageStudio";

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

  return (
    <Card title="Image Studio">
      {hasStudio ? (
        <ImageStudio deptId={deptId} />
      ) : (
        <EmptyNote>The Image Studio isn&apos;t configured for this department.</EmptyNote>
      )}
    </Card>
  );
}
