import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { ReactNode } from "react";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { listClientDeliverables, listProjects } from "@/lib/entities";
import { listAllPmTasksPaged } from "@/lib/pm";
import { readResult } from "@/lib/readResult";
import { getClientOverview } from "@/lib/clientHub";
import { listPipelineRunsWithGates, GATE_LABEL } from "@/lib/pipeline";
import { listChangeRequests } from "@/lib/webdevChangeRequests-data";
import { KIND_LABEL, STATUS_LABEL as CR_STATUS_LABEL } from "@/lib/webdevChangeRequests";
import { listRecordings, STATUS_LABEL, formatDuration } from "@/lib/meetings";
import { NO_PROJECT_LABEL, clientGatesOf, groupByProject, postReviewItems } from "@/lib/clientWork";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { ReadRefusal } from "@/components/systems/ReadRefusal";
import { ClientVisibilityMarker } from "@/components/clients/ClientVisibilityMarker";
import { RecordControls } from "@/components/meetings/RecordControls";
import { ScheduleMeetingPanel } from "@/components/meetings/ScheduleMeetingPanel";
import { formatDate, formatDateTime } from "@/lib/format";
import { can } from "@/lib/rbac";
import { listThreads } from "@/lib/conversation-data";
import { startConversationAction } from "@/lib/conversationActions";
import { ThreadList } from "@/components/clients/conversation/ThreadList";
import { StartConversation } from "@/components/clients/conversation/StartConversation";

// CC-3 — the Work tab; PV3-05 — now the hub's PROJECTS area (the label changed, the URL did not).
//
// One page for everything about the work, in this order:
//   1. projects, with their tasks grouped under them
//   1b. conversation (PV4-09) — the threads with this client, "awaiting our reply" first
//   2. deliverables
//   3. approvals — this client's pipeline runs with their client-side gates
//   4. requests — change requests, and post reviews
//   5. meetings — the "Scheduled" and "Meetings" cards, lifted unchanged from People
// The portal's Projects area carries the same family (projects, approvals, deliverables, requests, post
// reviews), so staff and client no longer disagree about where the work lives.
//
// ── EVERY READ REFUSES EXPLICITLY ───────────────────────────────────────────────────────────────
// A denied or failed read renders `<ReadRefusal>`; an empty list means the read succeeded and found
// nothing. No `.catch(() => [])` on this page: it used to wrap the projects read in one, so a 403 read
// "This client has no projects yet".
//   ⚠ One residual: `listAllPmTasksPaged` (lib/pm.ts) folds a 403/404 on `/pm/tasks` into an empty
//   page internally, so a refused TASK read still reads as "no tasks". That reader is shared with
//   the PM surface and is outside this ticket; the wrapper below catches everything else it throws.
//
// ── READS ARE SERVER-FILTERED ───────────────────────────────────────────────────────────────────
// Projects, tasks, deliverables, runs, change requests and recordings all push `clientId` down to SQL.
// Narrowing in the browser stops being a filter once a tenant has more rows than one page.
//
// ── VISIBILITY MARKERS (PV3-09) ─────────────────────────────────────────────────────────────────
// Every row says who sees it ("Client sees this" / "Internal"), from the backend's `clientVisible` only
// (BFF §22d, trap 9). A row whose payload lacks the field renders no marker, never a guess. Projects,
// tasks, deliverables, runs and their gates, change requests, post reviews and meetings are all marked.
// Tasks and meetings read Internal by the backend's own rule: the portal lists neither.
export default async function ClientWorkPage({ params }: { params: Promise<{ clientId: string }> }) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  const { clientId } = await params;
  if (!tenant) notFound();

  const [projectsRes, tasksRes, deliverablesRes, runsRes, changeRequestsRes, overviewRes, meetingsResult, upcomingResult, threadsRes] =
    await Promise.all([
      readResult(listProjects(userId, tenant, clientId)),
      // `includeClosed` defaults to true in the reader; kept explicit because "Done" tasks are part of
      // the story a client's work tells — a project reading 100% with nothing listed is not a finding.
      readResult(listAllPmTasksPaged(userId, tenant, { clientId, includeClosed: true })),
      listClientDeliverables(userId, tenant, clientId),
      listPipelineRunsWithGates(userId, tenant, { clientId }),
      listChangeRequests(userId, tenant, { clientId }),
      // The layout fetched this already; it carries the outstanding post reviews (see postReviewItems).
      readResult(getClientOverview(userId, tenant, clientId)),
      // WD-07: recordings scoped to this client, plus RecordControls with clientId pre-filled.
      listRecordings(userId, tenant, { clientId }),
      // W1 (D-3): what is coming up for this client, server-filtered to future scheduled rows.
      listRecordings(userId, tenant, { clientId, scheduled: "upcoming" }),
      // PV4-09: this client's conversation threads (BFF §29b). A refusal renders as one, never as "no conversations".
      readResult(listThreads(userId, tenant, { clientId })),
    ]);

  const projects = projectsRes.kind === "ok" ? projectsRes.data : [];
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  /** A project column value: a name, the "not tied" label, or "—" when we cannot say. */
  const projectCell = (id: string | null | undefined): string => {
    if (id === undefined) return "—"; // an older platform omits the column: unknown, not "no project"
    if (id === null) return NO_PROJECT_LABEL;
    return projectName.get(id) ?? "—";
  };

  // Unwrapped as contacts/page.tsx did: `refusal` carries the reason a panel is empty, which is exactly
  // the distinction that was being lost.
  const meetings = meetingsResult.kind === "ok" ? meetingsResult.data : [];
  const meetingsRefusal = meetingsResult.kind === "ok" ? null : meetingsResult;
  const upcoming = upcomingResult.kind === "ok" ? upcomingResult.data : [];
  const upcomingRefusal = upcomingResult.kind === "ok" ? null : upcomingResult;

  function renderProjects(): ReactNode {
    if (projectsRes.kind !== "ok") {
      return <ReadRefusal subject="this client's projects" kind={projectsRes.kind} reason={reasonOf(projectsRes)} />;
    }
    if (projects.length === 0) {
      return (
        <EmptyNote>
          This client has no projects yet. Create one from <Link href="/projects" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>Projects</Link> and it
          will appear here — along with its tasks and milestones.
        </EmptyNote>
      );
    }
    // ── TASKS ARE GROUPED BY PROJECT, NOT LISTED FLAT ─────────────────────────────────────────────
    // A flat task list is what `/tasks` already is. The reason to look at work through a client is to see
    // which of THEIR projects is moving and which is stuck, so the project is the unit and the tasks hang
    // off it. A project with no tasks still renders — an empty project is a finding, not a row to hide.
    const tasksKnown = tasksRes.kind === "ok";
    const tasks = tasksRes.kind === "ok" ? tasksRes.data : [];
    const byProject = new Map<string, typeof tasks>();
    for (const t of tasks) {
      const list = byProject.get(t.projectId);
      if (list) list.push(t);
      else byProject.set(t.projectId, [t]);
    }
    // Tasks whose project is not in this client's project list. Should be empty — both reads apply the
    // same server-side client predicate — so if it is ever non-empty the two filters disagree, which is
    // worth SHOWING rather than silently dropping. An orphan here means one of them is wrong.
    const projectIds = new Set(projects.map((p) => p.id));
    const orphans = tasks.filter((t) => !projectIds.has(t.projectId));
    return (
      <>
        {tasksRes.kind !== "ok" && (
          <ReadRefusal subject="this client's tasks" kind={tasksRes.kind} reason={reasonOf(tasksRes)} inline />
        )}
        {projects.map((p) => {
          const own = byProject.get(p.id) ?? [];
          const done = own.filter((t) => t.status === "done").length;
          const overdue = own.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < todayIso()).length;
          return (
            <Card
              key={p.id}
              title={p.name}
              headerRight={
                <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                  {overdue > 0 && <StatusBadge label={`${overdue} overdue`} />}
                  <StatusBadge label={p.status} />
                  <ClientVisibilityMarker clientVisible={p.clientVisible} />
                </span>
              }
            >
              <p style={{ margin: "0 0 10px", font: "400 12px var(--font-body)", color: "var(--ink-muted)" }}>
                {!tasksKnown ? "Tasks cannot be read right now" : own.length === 0 ? "No tasks yet" : `${done}/${own.length} tasks done`}
                {p.due_date ? ` · due ${formatDate(p.due_date)}` : ""}
                {" · "}
                <Link href={`/projects/${p.id}`} style={{ color: "var(--erp-accent)", textDecoration: "underline", textUnderlineOffset: 3 }}>
                  open project
                </Link>
              </p>
              {!tasksKnown ? null : own.length === 0 ? (
                <EmptyNote>Nothing has been broken down on this project yet.</EmptyNote>
              ) : (
                <HairlineTable
                  columns={[{ label: "Task" }, { label: "Status" }, { label: "Ball" }, { label: "Due" }]}
                  rows={own.map((t) => [
                    <span key="t">
                      <Link href={`/tasks/${t.id}`} style={{ color: "var(--ink-strong)", textDecoration: "none" }}>
                        {t.title}
                      </Link>
                      <ClientVisibilityMarker clientVisible={t.clientVisible} />
                    </span>,
                    <StatusBadge key="s" label={t.status} />,
                    t.assignee?.refName ?? "—",
                    t.dueDate ? formatDate(t.dueDate) : "—",
                  ])}
                />
              )}
            </Card>
          );
        })}
        {orphans.length > 0 && (
          <Card title={`Tasks outside this client's projects · ${orphans.length}`} hint="This should be empty. If it is not, the project filter and the task filter disagree about which projects belong to this client — surfaced rather than dropped, because a dropped row is invisible.">
            <HairlineTable
              columns={[{ label: "Task" }, { label: "Project" }]}
              rows={orphans.map((t) => [t.title, t.projectName])}
            />
          </Card>
        )}
      </>
    );
  }

  function renderPostReviews(overview: NonNullable<Awaited<ReturnType<typeof getClientOverview>>>): ReactNode {
    const items = postReviewItems(overview);
    return (
      <Card
        title={`Post reviews${items.length ? ` · ${items.length}` : ""}`}
        hint="Outstanding reviews only: posts the client has been asked to approve, and posts they sent back for changes. Reviews already approved are not listed here yet, because no staff list of a client's post reviews exists."
      >
        {items.length === 0 ? (
          <EmptyNote>No post reviews are outstanding for this client.</EmptyNote>
        ) : (
          <HairlineTable
            columns={[{ label: "Post" }, { label: "Where it stands" }, { label: "Waiting on" }]}
            rows={items.map((i) => [
              <span key="p">{i.context}<ClientVisibilityMarker clientVisible={i.clientVisible} /></span>,
              i.label,
              i.side === "us" ? "Us" : "The client",
            ])}
            tcols="2fr 2fr 1fr"
          />
        )}
      </Card>
    );
  }

  return (
    <div className="ch-sections">
      <Section id="projects" title="Projects">
        {renderProjects()}
      </Section>

      <Section id="conversation" title="Conversation">
        {threadsRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's conversations" kind={threadsRes.kind} reason={reasonOf(threadsRes)} />
        ) : (
          <Card
            title={`Conversations${threadsRes.data.length ? ` · ${threadsRes.data.length}` : ""}`}
            hint="Messages between this client and our team. The client reads and answers them in their portal."
          >
            <ThreadList threads={threadsRes.data} clientId={clientId} />
            {can(me, "client.write", tenant) && (
              <StartConversation
                clientId={clientId}
                clientName={overviewRes.kind === "ok" && overviewRes.data ? overviewRes.data.client.name : "this client"}
                projects={projects.map((p) => ({ id: p.id, name: p.name }))}
                start={startConversationAction}
              />
            )}
          </Card>
        )}
      </Section>

      <Section id="deliverables" title="Deliverables">
        {deliverablesRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's deliverables" kind={deliverablesRes.kind} reason={reasonOf(deliverablesRes)} />
        ) : (
          <Card title={`Deliverables${deliverablesRes.data.length ? ` · ${deliverablesRes.data.length}` : ""}`}>
            {deliverablesRes.data.length === 0 ? (
              <EmptyNote>No deliverables for this client.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Deliverable" }, { label: "Project" }, { label: "Status" }, { label: "Due", align: "right" }]}
                rows={deliverablesRes.data.map((d) => [
                  <span key="n">{d.name}<ClientVisibilityMarker clientVisible={d.clientVisible} /></span>,
                  projectCell(d.project_id ?? null),
                  <StatusBadge key="s" label={d.status} />,
                  formatDate(d.due_date),
                ])}
                tcols="2fr 1.4fr 1fr 1fr"
              />
            )}
          </Card>
        )}
      </Section>

      <Section id="approvals" title="Approvals">
        {runsRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's pipeline runs and approvals" kind={runsRes.kind} reason={reasonOf(runsRes)} />
        ) : (
          <Card
            title={`Pipeline runs and client approvals${runsRes.data.length ? ` · ${runsRes.data.length}` : ""}`}
            hint="Each run's client-side gates: the sign-offs and feedback the client has to give. Open a run to decide or edit it."
          >
            {runsRes.data.length === 0 ? (
              <EmptyNote>No pipeline runs for this client.</EmptyNote>
            ) : (
              <HairlineTable
                columns={[{ label: "Run" }, { label: "Project" }, { label: "Status" }, { label: "Client approvals" }]}
                rows={runsRes.data.map((r) => {
                  const gates = clientGatesOf(r.gates);
                  return [
                    <span key="t">
                      <Link href={`/pipeline/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>{r.title ?? r.id}</Link>
                      <ClientVisibilityMarker clientVisible={r.clientVisible} />
                    </span>,
                    projectCell(r.project_id),
                    <StatusBadge key="s" label={r.status} />,
                    gates === null ? (
                      <span key="g">Open the run to see its approvals.</span>
                    ) : gates.length === 0 ? (
                      <span key="g">No client approvals on this run.</span>
                    ) : (
                      <span key="g" style={{ display: "grid", gap: 4 }}>
                        {gates.map((g) => (
                          <span key={g.id} style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                            {GATE_LABEL[g.kind] ?? g.kind}
                            <StatusBadge label={g.status === "pending" ? "pending" : (g.decision ?? "decided")} />
                            <ClientVisibilityMarker clientVisible={g.clientVisible} />
                          </span>
                        ))}
                      </span>
                    ),
                  ];
                })}
                tcols="2fr 1.4fr 1fr 2.4fr"
              />
            )}
          </Card>
        )}
      </Section>

      <Section id="requests" title="Requests">
        {changeRequestsRes.kind !== "ok" ? (
          <ReadRefusal subject="this client's change requests" kind={changeRequestsRes.kind} reason={reasonOf(changeRequestsRes)} />
        ) : (
          <Card title={`Change requests${changeRequestsRes.data.length ? ` · ${changeRequestsRes.data.length}` : ""}`}>
            {changeRequestsRes.data.length === 0 ? (
              <EmptyNote>No change requests for this client.</EmptyNote>
            ) : (
              <div style={{ display: "grid", gap: 16 }}>
                {groupByProject(changeRequestsRes.data, (cr) => ({ id: cr.projectId, name: cr.projectName })).map((g) => (
                  <div key={g.projectId ?? "none"}>
                    <h4 className="ch-group__title">{g.projectName}</h4>
                    <HairlineTable
                      columns={[{ label: "Request" }, { label: "Kind" }, { label: "Status" }, { label: "Filed", align: "right" }]}
                      rows={g.rows.map((cr) => [
                        <span key="n">{cr.title}<ClientVisibilityMarker clientVisible={cr.clientVisible} /></span>,
                        KIND_LABEL[cr.kind] ?? cr.kind,
                        <StatusBadge key="s" label={CR_STATUS_LABEL[cr.status] ?? cr.status} />,
                        formatDate(cr.createdAt),
                      ])}
                      tcols="2.4fr 1fr 1fr 1fr"
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        {overviewRes.kind !== "ok" || !overviewRes.data ? (
          <ReadRefusal
            subject="this client's post reviews"
            kind={overviewRes.kind === "forbidden" ? "forbidden" : "unavailable"}
            reason={overviewRes.kind === "unavailable" ? overviewRes.reason : undefined}
          />
        ) : (
          renderPostReviews(overviewRes.data)
        )}
      </Section>

      <Section id="meetings" title="Meetings">
        {/* Lifted unchanged from People (contacts/page.tsx, CC-D8 / WD-07 / W1). AGN-3: these two are
            PANELS on a client page, not the page's subject, so a refusal renders inline beside the
            rest — but it IS rendered; the unwrapped values below carry the reason a panel is empty. */}
        <Card title={`Scheduled${upcoming.length ? ` · ${upcoming.length}` : ""}`}>
          {upcomingRefusal ? (
            <ReadRefusal
              subject="this client's scheduled meetings"
              kind={upcomingRefusal.kind}
              reason={upcomingRefusal.kind === "unavailable" ? upcomingRefusal.reason : undefined}
              inline
            />
          ) : null}
          <ScheduleMeetingPanel clientId={clientId} upcoming={upcoming} />
        </Card>
        <Card title={`Meetings${meetings.length ? ` · ${meetings.length}` : ""}`}>
          {meetingsRefusal ? (
            <ReadRefusal
              subject="this client's meetings"
              kind={meetingsRefusal.kind}
              reason={meetingsRefusal.kind === "unavailable" ? meetingsRefusal.reason : undefined}
              inline
            />
          ) : null}
          <RecordControls clientId={clientId} />
          {meetings.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <HairlineTable
                columns={[{ label: "Meeting" }, { label: "Status" }, { label: "Length" }, { label: "Recorded", align: "right" }]}
                rows={meetings.map((r) => [
                  <span key="t">
                    <Link href={`/meetings/${r.id}`} style={{ color: "inherit", fontWeight: 600 }}>{r.title ?? r.meeting_id}</Link>
                    <ClientVisibilityMarker clientVisible={r.clientVisible} />
                  </span>,
                  <StatusBadge key="s" label={STATUS_LABEL[r.status] ?? r.status} />,
                  formatDuration(r.duration_sec),
                  formatDateTime(r.created_at),
                ])}
                tcols="2fr 1fr .8fr 1fr"
              />
            </div>
          )}
        </Card>
      </Section>
    </div>
  );
}

/** One area of the page: an `<h2>` (the layout's PageHeader owns the page's only `<h1>`) over its cards. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="ch-section">
      <h2 id={`${id}-h`} className="ch-section__title">{title}</h2>
      <div className="ch-section__body">{children}</div>
    </section>
  );
}

function reasonOf(r: { kind: string; reason?: string }): string | undefined {
  return r.kind === "unavailable" ? r.reason : undefined;
}

/** Local `today` in ISO, computed once per render. Not imported from `pmUrgency` because this page
 *  needs only a string comparison against `dueDate` (also a `YYYY-MM-DD` string), and string
 *  comparison on ISO dates is correct without parsing either side into a Date. */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
