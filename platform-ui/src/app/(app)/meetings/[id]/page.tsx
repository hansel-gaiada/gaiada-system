import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { getSessionUserId } from "@/lib/session-server";
import { getMe } from "@/lib/platform";
import { getActiveTenant } from "@/lib/tenant";
import { getRecording, STATUS_LABEL, DRIVE_LABEL, formatDuration } from "@/lib/meetings";
import { RecordingWorkbench } from "@/components/meetings/RecordingWorkbench";
import { Card, Eyebrow, StatusBadge } from "@/components/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { formatDateTime } from "@/lib/format";
import type { ReactNode } from "react";

function mb(bytes: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// WS11 capture edge — recording detail + workbench (transcript → ingest → Drive).
export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");
  const me = await getMe(userId);
  const tenant = await getActiveTenant(me);
  if (!tenant) redirect("/meetings");
  const rec = await getRecording(userId, tenant, id);
  if (!rec) notFound();

  const meta: [string, ReactNode][] = [
    ["Kind", rec.kind === "video" ? "Audio + Video" : "Audio"],
    ["Meeting ID", rec.meeting_id],
    ["Length", formatDuration(rec.duration_sec)],
    ["Size", mb(rec.size_bytes)],
    ["Started", rec.started_at ? formatDateTime(rec.started_at) : "—"],
    ["Local file", rec.local_hint ?? "—"],
    // WD-02: once ingested, the recording carries the pipeline run id — link straight into its workspace.
    ["Pipeline run", rec.pipeline_run_id ? <Link href={`/pipeline/${rec.pipeline_run_id}`}>Open run workspace →</Link> : "Not ingested yet"],
  ];

  return (
    <>
      <div style={{ marginBottom: 22 }}>
        <Breadcrumbs items={[{ label: "Home", href: "/" }, { label: "Meetings", href: "/meetings" }, { label: rec.title ?? rec.meeting_id }]} />
        <Eyebrow style={{ color: "var(--erp-accent)", marginBottom: 8, display: "block" }}>Recording</Eyebrow>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 30, lineHeight: 1.1 }}>
            {rec.title ?? rec.meeting_id}
          </h1>
          <StatusBadge label={STATUS_LABEL[rec.status] ?? rec.status} />
          <StatusBadge label={DRIVE_LABEL[rec.drive_status] ?? rec.drive_status} />
        </div>
      </div>

      <div style={{ display: "grid", gap: 22, gridTemplateColumns: "minmax(0,1fr)" }}>
        <Card title="Details">
          <dl style={{ display: "grid", gridTemplateColumns: "160px 1fr", gap: "10px 16px", margin: 0 }}>
            {meta.map(([k, v]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt style={{ font: "500 13px var(--font-body)", color: "var(--ink-subtle)" }}>{k}</dt>
                <dd style={{ margin: 0, font: "400 13px var(--font-body)", color: "var(--ink-body)", wordBreak: "break-word" }}>{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="Workbench">
          <RecordingWorkbench rec={rec} />
        </Card>
      </div>
    </>
  );
}
