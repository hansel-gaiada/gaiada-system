import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { TeachState } from "@/components/departments/TeachState";
import { AccessDenied } from "@/components/social/AccessDenied";
import { NewPostForm } from "@/components/social/NewPostForm";
import { listPosts, listEngagements } from "@/lib/social";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string }>;

// Composer (SMM-11) — the master-post list + creation form. Editing a post's own fields and its
// per-network variants happens on composer/[postId] (this page only creates and lists).
export default async function DepartmentComposerPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const [engagements, posts] = await Promise.all([
    listEngagements(userId, tenant),
    listPosts(userId, tenant),
  ]);

  if (engagements.forbidden || posts.forbidden) {
    return (
      <Card title="Composer">
        <AccessDenied what="view or draft social posts" />
      </Card>
    );
  }

  const canCompose = can(me, "social.manage", tenant);
  const engagementById = new Map(engagements.data.map((e) => [e.id, e]));

  return (
    <Card title="Composer">
      {engagements.data.length === 0 ? (
        <TeachState
          glyph="✎"
          title="No engagements yet"
          body="A social-media engagement is the client retainer a post belongs to. One needs to exist before a post can be drafted — this console does not create engagements yet; ask a manager to set one up."
        />
      ) : canCompose ? (
        <div style={{ marginBottom: 18 }}>
          <NewPostForm tenantId={tenant} deptId={deptId} engagements={engagements.data} />
        </div>
      ) : null}

      {posts.data.length === 0 ? (
        <TeachState glyph="✎" title="No posts yet" body="Draft your first post using the form above." />
      ) : (
        <div className="dept-table-scroll erp-scroll" style={{ ["--dept-table-min" as string]: "680px" }}>
          <HairlineTable
            columns={[{ label: "Post" }, { label: "Engagement" }, { label: "Status" }, { label: "Scheduled" }, { label: "Variants" }]}
            rows={posts.data.map((p) => [
              <Link key="t" href={`/departments/${deptId}/composer/${p.id}`} style={{ font: "600 13px var(--font-body)" }}>{p.title}</Link>,
              engagementById.get(p.engagementId)?.name ?? "—",
              <StatusBadge key="s" label={p.status} />,
              p.scheduledAt ? new Date(p.scheduledAt).toLocaleString() : "—",
              String(p.variants.length),
            ])}
            tcols="2fr 1.4fr .9fr 1.3fr .7fr"
          />
        </div>
      )}
    </Card>
  );
}
