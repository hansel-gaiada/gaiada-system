import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getDepartment } from "@/lib/departments";
import { activeCompany } from "@/lib/companyContext";
import { workspaceFor } from "@/lib/workspaces";
import { getWaiting } from "@/lib/socialMessages-data";
import { Card } from "@/components/ui";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { MessagesList } from "@/components/social/MessagesList";
import "@/components/social/cycles.css";
import "@/components/social/messages.css";

type Params = Promise<{ deptId: string }>;

// SCP-1j (BFF §63.7 `GET waiting`, §63.14 `follow_up`; plan §8 row 1j): the Social Media Messages page. Who holds each of YOUR posts: the client's officer
// sees the posts of their own clients that someone else holds (the copywriter, the Social Media head or the GM, the designer, the client), grouped by holder, with
// how long each has waited and when the holder was last reminded, and a Follow up button that posts the `follow_up` action. A client-held post also opens the
// client's conversation (PV-4). Opening a post goes to `{D}/posts/[postId]` (SCP-1e).
//
// The registry row (`messages`, workspaces.ts) has no gate: anyone with a social read tier may open it, and a person who is nobody's officer reads an honest
// empty state. A refused read is the house "no access" state and a failed one says it cannot tell, never "nothing is waiting".
export default async function SocialMessagesPage({ params }: { params: Params }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { deptId } = await params;
  if (!tenant) notFound();
  const dept = await getDepartment(userId, tenant, deptId);
  if (!dept) notFound();
  // Messages belong to the Social Media workspace only.
  if (workspaceFor(activeCompany(me, tenant)?.vertical, dept.name).key !== "social-media") notFound();

  const waiting = await getWaiting(userId, tenant);
  if (waiting.kind === "forbidden") {
    return <ReadRefusal subject="your Social Media messages" kind="forbidden" detail="Reading them needs a Social Media read tier (the social_staff role, or a manager)." />;
  }
  if (waiting.kind === "unavailable") return <ReadRefusal subject="Your Social Media messages" kind="unavailable" reason={waiting.reason} />;

  return (
    <Card title="Messages">
      <p className="scp-lede" style={{ margin: "0 0 12px" }}>
        Who holds each of your posts. When a post you look after sits with a copywriter, the Social Media head, the GM, a designer or the client, it is listed
        here, and Follow up reminds the holder once a day.
      </p>
      {waiting.data.length === 0 ? (
        <p className="scp-note" role="status">
          Nothing of yours is waiting on anyone. When you send a post on and someone else holds it, it shows up here.
        </p>
      ) : (
        <MessagesList groups={waiting.data} deptId={deptId} nowIso={new Date().toISOString()} />
      )}
    </Card>
  );
}
