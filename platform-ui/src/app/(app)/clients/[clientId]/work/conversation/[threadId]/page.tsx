import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { can } from "@/lib/rbac";
import { readResult } from "@/lib/readResult";
import { getThreadSnapshot } from "@/lib/conversation-data";
import {
  createChangeRequestFromMessageAction, discardDraftAction, editDraftAction, editMessageAction, loadThreadAction,
  postMessageAction, retractMessageAction, sendDraftAction, setThreadStatusAction,
} from "@/lib/conversationActions";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ThreadView, type ThreadActions } from "@/components/clients/conversation/ThreadView";

// PV4-09 — one conversation thread, under the client hub's Projects area. The hub tab matcher
// (`isHubTabActive`) keeps "Projects" lit for everything under `/work/`, so this page needs no nav change.
//
// The thread is read here once (server-rendered, so the first paint has the messages); after that the client
// component polls every 20 s while the page is visible (design decision 6: no staff live channel).
// A refused read says so in words, never "no messages". A thread that belongs to a different client than the URL
// names is a 404: the URL must not let a thread be read under the wrong client's header.
export default async function ConversationThreadPage({ params }: { params: Promise<{ clientId: string; threadId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId, threadId } = await params;
  if (!tenant) notFound();

  const res = await readResult(getThreadSnapshot(userId, tenant, threadId));
  if (res.kind === "forbidden") return <ReadRefusal subject="this conversation" kind="forbidden" />;
  if (res.kind === "unavailable") {
    // A 404 on the thread is a genuine absence, not a refusal.
    if (/not found/i.test(res.reason) || /^platform 404/.test(res.reason)) notFound();
    return <ReadRefusal subject="this conversation" kind="unavailable" reason={res.reason} />;
  }
  if (res.data.thread.clientId !== clientId) notFound();

  const actions: ThreadActions = {
    load: loadThreadAction,
    post: postMessageAction,
    setStatus: setThreadStatusAction,
    createChangeRequest: createChangeRequestFromMessageAction,
    edit: editMessageAction,
    retract: retractMessageAction,
    send: sendDraftAction.bind(null, clientId),
    discard: discardDraftAction.bind(null, clientId),
    editDraft: editDraftAction,
  };

  return (
    <div className="ch-sections">
      <p style={{ margin: 0, font: "400 13px var(--font-body)" }}>
        <Link href={`/clients/${clientId}/work#conversation`} style={{ color: "var(--erp-accent)", textUnderlineOffset: 3 }}>← All conversations with {res.data.thread.clientName}</Link>
      </p>
      <ThreadView initial={res.data} canWrite={can(me, "client.write", tenant)} actions={actions} />
    </div>
  );
}
