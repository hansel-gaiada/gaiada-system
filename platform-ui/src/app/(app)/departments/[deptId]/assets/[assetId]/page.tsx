import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { toolkitFor, deptTabs } from "@/lib/deptToolkits";
import { activeCompany } from "@/lib/companyContext";
import { listComments } from "@/lib/entities";
import { postEntityComment } from "@/lib/collabActions";
import { readAssetVersions, readAssetReviews } from "@/lib/creativeReviews-data";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { CommentThread } from "@/components/pm/CommentThread";
import { AssetActions, ReviewChip, ReviewRounds, VersionHistory } from "@/components/creative/AssetDetail";

type Params = Promise<{ deptId: string; assetId: string }>;

// Asset detail (DW-6h, contract §35.6): the version history, the review rounds, the one thread that follows every version
// (generic comments on `creative_asset`, keyed by the group key), and the actions. `[assetId]` may be any version of the
// asset; the page shows that version and offers the actions that can work for it. The server authorises every read and
// every action; a refused read is shown as a refusal, never as an empty list.
export default async function AssetDetailPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId, assetId } = await params;
  if (!tenant) notFound();

  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();

  const hasAssets = deptTabs(toolkitFor(activeCompany(me, tenant)?.vertical, dept.name)).some((t) => t.path === "assets");
  if (!hasAssets) {
    return (
      <Card title="Asset">
        <EmptyNote>The Asset Library isn&apos;t configured for this department.</EmptyNote>
      </Card>
    );
  }

  const [versions, rounds] = await Promise.all([
    readAssetVersions(userId, tenant, assetId),
    readAssetReviews(userId, tenant, assetId),
  ]);
  const back = (
    <p><Link href={`/departments/${encodeURIComponent(deptId)}/assets`}>Back to the Asset Library</Link></p>
  );
  if (versions.kind !== "ok") {
    return (
      <Card title="Asset">
        {back}
        <ReadRefusal subject="this asset" kind={versions.kind} reason={versions.kind === "unavailable" ? versions.reason : undefined} inline />
      </Card>
    );
  }
  const list = versions.data;
  const latest = list.find((v) => v.isLatest) ?? list[0] ?? null;
  const current = list.find((v) => v.id === assetId) ?? latest;
  if (!current || !latest) notFound();

  // One thread per asset: the group key, so it follows every version.
  const comments = await listComments(userId, tenant, "creative_asset", current.versionGroupId);

  return (
    <div className="cs-detail">
      <Card title={current.name}>
        {back}
        <div className="cs-detail__head">
          <span>Viewing v{current.versionNo} of {latest.versionNo}</span>
          <ReviewChip review={latest.review} />
        </div>
        <AssetActions deptId={deptId} latest={latest} current={current} rounds={rounds} meId={me.userId} />
      </Card>
      <Card title="Version history">
        <VersionHistory result={versions} currentId={current.id} meId={me.userId} />
      </Card>
      <Card title="Review rounds">
        <ReviewRounds result={rounds} />
      </Card>
      <Card title="Discussion">
        <CommentThread comments={comments} post={postEntityComment.bind(null, "creative_asset", current.versionGroupId)} />
      </Card>
    </div>
  );
}
