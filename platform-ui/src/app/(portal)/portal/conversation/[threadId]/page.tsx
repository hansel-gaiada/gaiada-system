import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalConversation } from "@/lib/portal-data";
import { threadTitle } from "@/lib/portal";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalLink, PortalPageHead } from "@/components/portal/PortalBits";
import { PortalThreadView } from "@/components/portal/PortalThreadView";

// PV4-08 — one conversation. Opening it marks it read on the server (`GET` detail, §29a). A thread outside the
// caller's scope answers 404 (never 403: no existence oracle), which `getPortalConversation` reads as null.
// The client component below holds the message list, the reply box and the edit/remove controls; this page only
// loads, frames and keeps it fresh (`conversation` topic; polling is always armed under PortalLive).
export default async function PortalThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const detail = await getPortalConversation(userId, tenant, threadId);
  if (!detail) notFound();
  const { thread, messages } = detail;

  return (
    <>
      <PortalPageHead
        eyebrow={thread.general ? (thread.clientName ?? "General") : (thread.projectName ?? "Conversation")}
        title={threadTitle(thread)}
        actions={<PortalLive topics={["conversation"]} />}
      />
      <div className="cp-stack">
        <PortalThreadView thread={thread} messages={messages} tenant={tenant} serverNow={new Date().toISOString()} />
        <div><PortalLink href="/portal/conversation">All conversations</PortalLink></div>
      </div>
    </>
  );
}
