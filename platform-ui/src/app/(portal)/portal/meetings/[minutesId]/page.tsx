import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActivePortalCompany } from "@/lib/portal-company";
import { getPortalMeeting } from "@/lib/portal-data";
import { portalDate } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ArtifactMarkdown } from "@/components/pipeline/ArtifactMarkdown";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalFacts, PortalLink, PortalPageHead } from "@/components/portal/PortalBits";
import "@/components/pipeline/pipeline.css";

// PV4-08 — the minutes of one meeting that our team shared with the client (§29c). The payload is exactly
// `{id, title, meetingDate, bodyMd, sharedAt, sharedBy}`: no transcript, recording, participants or Drive link
// ever reach the portal. A draft, another client's minutes and an unknown id all answer 404 (one answer for all).
//
// `bodyMd` is rendered by `ArtifactMarkdown`, the same safe renderer the contract page uses for a contract's
// `bodyMd`: it builds React elements from parsed tokens, never an HTML string, and shows links as plain text.
export default async function PortalMeetingPage({ params }: { params: Promise<{ minutesId: string }> }) {
  const { minutesId } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = (await getActivePortalCompany(me))?.id ?? null;
  if (!tenant) return <EmptyNote>No client account is linked to your sign-in, so there is nothing to show here. Overview explains why.</EmptyNote>;

  const minutes = await getPortalMeeting(userId, tenant, minutesId);
  if (!minutes) notFound();

  return (
    <>
      <PortalPageHead
        eyebrow="Meeting notes"
        title={minutes.title}
        actions={<PortalLive topics={["projects"]} />}
      />
      <div className="cp-stack">
        <Card title="About this meeting">
          <PortalFacts
            rows={[
              { k: "Meeting date", v: portalDate(minutes.meetingDate) },
              {
                k: "Shared",
                v: `Shared on ${portalDate(minutes.sharedAt)}${minutes.sharedBy ? ` by ${minutes.sharedBy}` : ""}`,
              },
            ]}
          />
        </Card>
        <Card title="Notes">
          {minutes.bodyMd.trim() ? (
            <div style={{ padding: "12px 14px", background: "var(--wash)", borderRadius: 8 }}>
              <ArtifactMarkdown text={minutes.bodyMd} />
            </div>
          ) : (
            <EmptyNote>These notes are empty.</EmptyNote>
          )}
        </Card>
        <div><PortalLink href="/portal/projects">All your projects</PortalLink></div>
      </div>
    </>
  );
}
