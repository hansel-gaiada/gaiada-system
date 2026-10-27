import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getDesignQueue } from "@/lib/socialDesignQueue-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { DesignQueueList } from "@/components/social/DesignQueueList";
import "@/components/social/cycles.css";
import "@/components/social/design-queue.css";

type Params = Promise<{ deptId: string }>;
type SearchParams = Promise<{ cursor?: string | string[] }>;

const first = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

// SCP-1h (BFF §63.6.6, §63.17): the designer's queue. The posts the caller may design now: in the design step, or back for a design change, whose
// month request's task names them (Creatives), plus every in-team post when they hold the in-team designer role. The server narrows every row by those
// two facts, so the list is what they can act on and nothing else; a person with neither gets an honest empty list, never somebody else's work.
// A revision shows the note that asked for it. Each row opens the post page (`{D}/posts/[postId]`), where the designer starts, adds designs and submits.
// A refused read is "no access" and a failed one is "cannot tell", never an empty queue.
export default async function DesignQueuePage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // The queue belongs to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const cursor = first((await searchParams).cursor) ?? null;
  const queue = await getDesignQueue(userId, tenant, { cursor });

  if (queue.kind === "forbidden") return <ReadRefusal subject="the design queue" kind="forbidden" />;
  if (queue.kind === "unavailable") return <ReadRefusal subject="The design queue" kind="unavailable" reason={queue.reason} />;

  const { items, nextCursor } = queue.data;
  const here = `/departments/${encodeURIComponent(deptId)}/design-queue`;
  return (
    <Card title="Design queue">
      <p className="scp-lede">
        The posts waiting for your design. A post that came back for a change shows the note that asked for it. Open a post to start it, add your designs
        and send it for the final check.
      </p>
      {items.length === 0 ? (
        <p className="scp-note" role="status">
          {cursor ? "There are no more posts in your queue." : "You have no posts to design right now. A post appears here once it is approved for design and is yours to design."}
        </p>
      ) : (
        <DesignQueueList items={items} deptId={deptId} />
      )}
      {(cursor || nextCursor) && (
        <nav className="scp-dq__pager" aria-label="Design queue pages">
          {cursor && <Link className="scp-link" href={here}>Back to the start</Link>}
          {nextCursor && <Link className="scp-link" href={`${here}?cursor=${encodeURIComponent(nextCursor)}`}>More posts</Link>}
        </nav>
      )}
    </Card>
  );
}
