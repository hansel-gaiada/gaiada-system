import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listPortalChangeRequests, listPortalProjects, getPortalProfile } from "@/lib/portal-data";
import { changeRequestFormProps, changeRequestKindLabel, portalDate, type PortalChangeRequest } from "@/lib/portal";
import { Card } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { PortalLive } from "@/components/portal/PortalLive";
import { PortalChangeRequestForm } from "@/components/portal/PortalChangeRequestForm";
import { PortalPageHead, PortalStatus } from "@/components/portal/PortalBits";

// MI-04 — the client's own maintenance-intake surface: ask for a content edit, a design tweak, a new
// feature, or report a bug — and see what happened to it. Design doc:
// docs/superpowers/plans/2026-08-07-webdev-maintenance-intake-design.md §5.
//
// ── THE §5.1 RULING HOLDS HERE TOO ────────────────────────────────────────────────────────────────
// Submitting is a viewer-permitted act (ratified, test-pinned on the backend). This page never reads
// `profile.access.canSign` — only `access.wholeClient`, to size the project selector. See
// `changeRequestFormProps` in lib/portal.ts for where that's pinned.
export default async function PortalRequestsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) return <EmptyNote>No workspace selected.</EmptyNote>;

  const { requests, isPortalClient } = await listPortalChangeRequests(userId, tenant);

  // The form needs the caller's OWN scope shape (client-wide vs project-scoped), fetched even when
  // there are no requests yet so a first-time client can still submit one.
  const [profile, projects] = isPortalClient
    ? await Promise.all([getPortalProfile(userId, tenant), listPortalProjects(userId, tenant)])
    : [null, []];
  const formProps = profile
    ? changeRequestFormProps(profile, projects.map((p) => ({ id: p.id, name: p.name })))
    : null;

  const ordered = [...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return (
    <>
      <PortalPageHead
        eyebrow="Tell us what you need"
        title="Requests"
        lead="Ask for a content edit, a design tweak, a new feature, or report a bug — we'll triage it and let you know what's next."
        actions={<PortalLive topics={["requests"]} />}
      />

      {!isPortalClient ? (
        <EmptyNote>
          This is the client-facing portal. You&apos;re signed in as a staff member, so there is no
          client account to raise a request against.
        </EmptyNote>
      ) : (
        <div className="cp-stack">
          {formProps && (
            <Card title="New request">
              <PortalChangeRequestForm allowClientWide={formProps.allowClientWide} projects={formProps.projects} />
            </Card>
          )}

          <Card title={ordered.length > 0 ? "Your requests" : "Nothing submitted yet"}>
            {ordered.length === 0 ? (
              <EmptyNote>Nothing here yet — anything you ask for above shows up in this list.</EmptyNote>
            ) : (
              <div style={{ display: "grid", gap: 16 }}>
                {ordered.map((r) => <RequestRow key={r.id} r={r} />)}
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function RequestRow({ r }: { r: PortalChangeRequest }) {
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap", paddingBottom: 14, borderBottom: "1px solid var(--hairline)" }}>
      <div style={{ minWidth: 0, flex: "1 1 260px" }}>
        <div style={{ font: "500 14px/1.4 var(--font-body)", color: "var(--ink-strong)" }}>{r.title}</div>
        <div style={{ font: "400 12px/1.5 var(--font-body)", color: "var(--ink-subtle)" }}>
          {changeRequestKindLabel(r.kind)} · {r.projectName ?? "Whole account"} · {portalDate(r.createdAt)}
        </div>
        {r.body && (
          <p style={{ margin: "8px 0 0", font: "400 13px/1.5 var(--font-body)", color: "var(--ink-muted)" }}>
            {r.body}
          </p>
        )}
        {r.status === "declined" && r.declinedReason && (
          <div className="cp-callout cp-callout--calm" style={{ marginTop: 10 }}>
            {r.declinedReason}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
        <PortalStatus status={r.status} />
        {/* Deep-links to the EXISTING run workspace once triage has spawned one — never a new page,
            per the design doc's §5.2 idiom (client-notify.ts's deep-link standard). */}
        {r.pipelineRunId && (
          <Link href={`/portal/approvals/${r.pipelineRunId}`} className="btn" style={{ fontSize: 12, textDecoration: "none" }}>
            View delivery →
          </Link>
        )}
      </div>
    </div>
  );
}
