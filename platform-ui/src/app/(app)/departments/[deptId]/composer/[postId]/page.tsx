import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { can } from "@/lib/rbac";
import { Card } from "@/components/ui";
import { AccessDenied } from "@/components/social/AccessDenied";
import { PostFieldsForm } from "@/components/social/PostFieldsForm";
import { VariantCard } from "@/components/social/VariantCard";
import { BackendPending } from "@/components/BackendPending";
import { getPost, listAccounts } from "@/lib/social";
import "@/components/departments/departments.css";

type Params = Promise<{ deptId: string; postId: string }>;

// Composer detail (SMM-11) — one master post + its per-network variants, editing against the real
// SMM-01/02/08 endpoints. Validation renders INLINE (ValidationList.tsx, via each VariantCard),
// keyed on the `rule` token per docs/FRONTEND-BFF-CONTRACT.md §19's binding rule.
//
// "Add a network" has no control here — `GET .../accounts` does not exist yet (lib/social.ts's
// header, discrepancy #2: SMM-05/07, the account-connect flow, are still unbuilt), so there is no
// way to look up a connectable account to attach a NEW variant to. Rendered as BackendPending
// rather than a text-input accountId field, which would silently accept an id nobody could verify.
export default async function DepartmentComposerPostPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, postId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const result = await getPost(userId, tenant, postId);

  if (result.forbidden) {
    return (
      <Card title="Composer">
        <AccessDenied what="view or edit this post" />
      </Card>
    );
  }
  if (!result.data) notFound();
  const post = result.data;

  const canDeletePost = can(me, "social.post.delete", tenant);

  // Quota strips (SMM-12) read the SMM-05 connector registry so each variant can show its own
  // account's live quota probe. A 403 here is rendered per-variant (QuotaStrip's own honesty
  // rule) rather than blocking the whole post — the operator can still read/edit content while
  // being told plainly that the quota figure is unavailable, never a fabricated zero.
  const accounts = await listAccounts(userId, tenant);
  const accountById = new Map(accounts.data.map((a) => [a.id, a]));

  return (
    <>
      <Card title={post.title}>
        <PostFieldsForm tenantId={tenant} deptId={deptId} post={post} canDelete={canDeletePost} />
      </Card>

      <Card title={`Per-network variants (${post.variants.length})`}>
        {post.variants.length === 0 ? (
          <p style={{ margin: "0 0 16px", font: "400 13px var(--font-body)", color: "var(--erp-ink-50)" }}>
            No per-network content yet.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
            {post.variants.map((v) => (
              <VariantCard
                key={v.id} tenantId={tenant} variant={v} canDelete={canDeletePost}
                account={accountById.get(v.accountId)} accountsForbidden={accounts.forbidden}
              />
            ))}
          </div>
        )}
        <BackendPending
          what="Add a network variant needs a connected account to attach it to — the account-connect flow (SMM-07) and its listing endpoint haven't shipped yet."
          contract="GET /api/:tenantId/modules/social/accounts (SMM-05/07, not yet built)"
        />
      </Card>
    </>
  );
}
