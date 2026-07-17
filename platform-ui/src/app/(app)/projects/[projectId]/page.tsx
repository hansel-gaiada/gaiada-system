import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getProject, listComments, listFiles } from "@/lib/entities";
import { postEntityComment, attachFileAction, deleteFileAction } from "@/lib/collabActions";
import { CommentThread } from "@/components/pm/CommentThread";
import { Attachments } from "@/components/Attachments";
import {
  getPmProject, listPmTasks, listMilestones, listDocs, assignableUnits,
  groupByStatus, computeTimeline, type PmTask,
} from "@/lib/pm";
import { moveTask, createPmTask, setProjectOwner, addMilestone, saveDoc } from "@/lib/pmActions";
import { archiveProject } from "../actions";
import { PageHeader } from "@/components/PageHeader";
import { Card, HairlineTable, StatusBadge } from "@/components/ui";
import { EmptyNote } from "@/components/systems/EmptyNote";
import { Board } from "@/components/pm/Board";
import { Gantt } from "@/components/pm/Gantt";
import { ProgressBar } from "@/components/pm/ProgressBar";
import { NewTaskForm } from "@/components/pm/NewTaskForm";
import { AssigneeEditor } from "@/components/pm/AssigneeEditor";
import { MilestoneForm } from "@/components/pm/MilestoneForm";
import { DocEditor } from "@/components/pm/DocEditor";
import "@/components/pm/pm.css";

type Params = Promise<{ projectId: string }>;
type Search = Promise<{ view?: string }>;
const VIEWS = ["board", "list", "timeline", "milestones", "docs"] as const;
type View = (typeof VIEWS)[number];

function who(t: PmTask): string {
  return t.assignee ? (t.assignee.responsibleName || t.assignee.refName) : "Unassigned";
}

export default async function ProjectWorkspace({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { projectId } = await params;
  const { view: rawView } = await searchParams;
  const view: View = (VIEWS as readonly string[]).includes(rawView ?? "") ? (rawView as View) : "board";

  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) notFound();

  const [pm, base, tasks, milestones, docs, assignable, comments, files] = await Promise.all([
    getPmProject(userId, tenant, projectId),
    getProject(userId, tenant, projectId).catch(() => null),
    listPmTasks(userId, tenant, projectId),
    listMilestones(userId, tenant, projectId),
    listDocs(userId, tenant, projectId),
    assignableUnits(userId, tenant),
    listComments(userId, tenant, "project", projectId),
    listFiles(userId, tenant, "project", projectId),
  ]);

  if (!pm && !base) notFound();
  const name = base?.name ?? pm?.name ?? "Project";
  const status = base?.status ?? pm?.status ?? "active";
  const progress = pm?.progress ?? 0;
  const owner = pm?.owner ?? null;

  const tab = (v: View, label: string) => (
    <Link href={`/projects/${projectId}?view=${v}`} className={`pm-tab${view === v ? " pm-tab--active" : ""}`}>{label}</Link>
  );

  return (
    <>
      <PageHeader
        eyebrow="Project"
        title={name}
        actions={
          <>
            <Link href={`/projects/${projectId}/edit`} className="lux-btn lux-btn--ghost lux-btn--sm">Edit</Link>
            <form action={archiveProject.bind(null, projectId)}><button type="submit" className="lux-btn lux-btn--ghost lux-btn--sm">Archive</button></form>
          </>
        }
      />

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", marginBottom: 18, alignItems: "center" }}>
        <div><span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.5, display: "block", marginBottom: 6 }}>Status</span><StatusBadge label={status} /></div>
        <div><span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.5, display: "block", marginBottom: 6 }}>Progress</span><ProgressBar value={progress} /></div>
        <div>
          <span className="type-eyebrow" style={{ fontSize: 10, opacity: 0.5, display: "block", marginBottom: 6 }}>Owner</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ font: "400 14px var(--font-body)", color: "var(--text-primary)" }}>
              {owner ? (owner.responsibleName || owner.refName) : "Unassigned"}
              {owner && owner.kind !== "person" ? ` · ${owner.refName}` : ""}
            </span>
            <AssigneeEditor label={owner ? "Reassign" : "Assign owner"} assignable={assignable} current={owner} save={setProjectOwner.bind(null, projectId)} />
          </div>
        </div>
      </div>

      <NewTaskForm assignable={assignable} milestones={milestones} create={createPmTask.bind(null, projectId)} />

      <div className="pm-tabs">
        {tab("board", "Board")}{tab("list", "List")}{tab("timeline", "Timeline")}{tab("milestones", "Milestones")}{tab("docs", "Docs")}
      </div>

      {view === "board" && (
        tasks.length === 0 ? <Card><EmptyNote>No tasks yet — create the first one above.</EmptyNote></Card>
          : <Board columns={groupByStatus(tasks)} move={moveTask} />
      )}

      {view === "list" && (
        <Card>
          {tasks.length === 0 ? <EmptyNote>No tasks yet.</EmptyNote> : (
            <HairlineTable
              columns={[{ label: "Task" }, { label: "Assignee" }, { label: "Status" }, { label: "Progress" }, { label: "Due", align: "right" }]}
              rows={tasks.map((t) => [
                <Link key="t" href={`/tasks/${t.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{t.title}</Link>,
                who(t),
                <StatusBadge key="s" label={t.status} />,
                <ProgressBar key="p" value={t.progress} />,
                t.dueDate ?? "—",
              ])}
              tcols="2fr 1.2fr 1fr 1.2fr 0.8fr"
            />
          )}
        </Card>
      )}

      {view === "timeline" && (() => {
        const tl = computeTimeline(tasks);
        return (
          <Card>
            {tl ? <Gantt timeline={tl} /> : <EmptyNote>Add start/due dates to tasks to see them on the timeline.</EmptyNote>}
          </Card>
        );
      })()}

      {view === "milestones" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card><MilestoneForm add={addMilestone.bind(null, projectId)} /></Card>
          {milestones.length === 0 && <Card><EmptyNote>No milestones yet.</EmptyNote></Card>}
          {milestones.map((mst) => {
            const mtasks = tasks.filter((t) => t.milestoneId === mst.id);
            return (
              <Card key={mst.id} title={mst.name} headerRight={<span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}><StatusBadge label={mst.status} /><span style={{ font: "400 12px var(--font-body)", color: "var(--erp-ink-50)" }}>{mst.dueDate ?? "—"}</span></span>}>
                {mtasks.length === 0 ? <EmptyNote>No tasks in this milestone.</EmptyNote> : (
                  <HairlineTable
                    columns={[{ label: "Task" }, { label: "Assignee" }, { label: "Status" }, { label: "Progress", align: "right" }]}
                    rows={mtasks.map((t) => [
                      <Link key="t" href={`/tasks/${t.id}`} style={{ color: "var(--text-primary)", textDecoration: "none" }}>{t.title}</Link>,
                      who(t),
                      <StatusBadge key="s" label={t.status} />,
                      <ProgressBar key="p" value={t.progress} />,
                    ])}
                    tcols="2fr 1.2fr 1fr 1.2fr"
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}

      {view === "docs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card title="New doc"><DocEditor save={saveDoc.bind(null, projectId)} /></Card>
          {docs.length === 0 && <Card><EmptyNote>No docs yet.</EmptyNote></Card>}
          {docs.map((d) => (
            <Card key={d.id} title={d.title} headerRight={<DocEditor doc={d} save={saveDoc.bind(null, projectId)} />}>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "400 13px/1.6 var(--font-body)", color: "var(--text-primary)" }}>{d.body}</pre>
              <p style={{ margin: "10px 0 0", font: "400 11px var(--font-body)", color: "var(--erp-ink-50)" }}>{d.author ? `${d.author} · ` : ""}{d.updatedAt ? new Date(d.updatedAt).toLocaleDateString("en-GB") : ""}</p>
            </Card>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24, display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
        <Card title={`Attachments${files.length ? ` · ${files.length}` : ""}`}>
          <Attachments files={files} canEdit={true} attach={attachFileAction.bind(null, "project", projectId)} remove={deleteFileAction.bind(null, "project", projectId)} />
        </Card>
        <Card title="Discussion">
          <CommentThread comments={comments} post={postEntityComment.bind(null, "project", projectId)} />
        </Card>
      </div>
    </>
  );
}
