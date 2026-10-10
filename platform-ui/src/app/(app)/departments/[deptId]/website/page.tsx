import { redirect } from "next/navigation";

// The "Website" group's primary-strip link points at its first tab (Content); this keeps the bare
// group path (`/departments/:id/website`) from being a 404 for anyone who types or bookmarks it.
export default async function WebsiteIndex({ params }: { params: Promise<{ deptId: string }> }) {
  const { deptId } = await params;
  redirect(`/departments/${deptId}/website/content`);
}
