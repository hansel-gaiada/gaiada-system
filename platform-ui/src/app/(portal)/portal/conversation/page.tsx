import { redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalProfile, listPortalConversations, listPortalProjects } from "@/lib/portal-data";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalPageHead } from "@/components/portal/PortalBits";
import { PortalStartConversation } from "@/components/portal/PortalStartConversation";
import { PortalThreadList } from "@/components/portal/PortalThreadList";

// PV4-08 — Conversation: every thread the client can see, grouped by project, with the client-wide "General"
// thread pinned on top for a client-wide contact (`canUseGeneral`, the server's answer: PV4-Q1). Threads come back
// already scoped by the BFF (portal-scope + `conversationThreadInPortalScope`); nothing here filters by who may see
// what. `?project=<id>` preselects that project in the "Start a conversation" form (the project page links here).
export default async function PortalConversationPage({ searchParams }: { searchParams: Promise<{ project?: string }> }) {
  const { project } = await searchParams;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const [{ threads, canUseGeneral }, projects, profile] = await Promise.all([
    listPortalConversations(userId, tenant),
    listPortalProjects(userId, tenant),
    getPortalProfile(userId, tenant),
  ]);
  const open = projects.filter((p) => !(p.finished ?? false));
  const clients = (profile?.clients ?? []).map((c) => ({ id: c.id, name: c.name }));

  return (
    <>
      <PortalPageHead
        eyebrow="Talk to our team"
        title="Conversation"
        lead="Ask a question, share a file or follow up on a decision. Your messages and our replies stay here, by project."
        actions={<PortalLive topics={["conversation"]} />}
      />
      <div className="cp-stack">
        <Card title="Start a conversation">
          <PortalStartConversation
            projects={open.map((p) => ({ id: p.id, name: p.name }))}
            canUseGeneral={canUseGeneral}
            clients={clients}
            defaultProjectId={project}
          />
        </Card>
        <Card title="Your conversations">
          <PortalThreadList threads={threads} canUseGeneral={canUseGeneral} />
        </Card>
      </div>
    </>
  );
}
