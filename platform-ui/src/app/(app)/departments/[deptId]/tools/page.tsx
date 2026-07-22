import { redirect } from "next/navigation";

type Params = Promise<{ deptId: string }>;

// Build Tools folded into Home as a compact launcher row (decision #10/Q4:
// "Build Tools tab merges into Home ... old route redirects"). This route is
// kept only so existing links/bookmarks still land somewhere useful.
export default async function BuildToolsRedirectPage({ params }: { params: Params }) {
  const { deptId } = await params;
  redirect(`/departments/${deptId}`);
}
