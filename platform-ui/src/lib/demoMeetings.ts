import "server-only";
// TEMP DEMO MODE — stateful in-memory store for the meeting-recordings registry (WS11 capture edge),
// mirroring demoPm.ts. Module-level state persists per dev-server process, resets on restart. Active
// only via DEMO_MODE=1; routed from demoFixtures.getDemoResponse. Lets the whole record → transcript →
// ingest → Drive flow work with no backend. Safe to delete once the real backend is up.

interface DemoRec {
  id: string;
  meeting_id: string;
  client_id: string | null;
  project_id: string | null;
  title: string | null;
  kind: "audio" | "video";
  status: "recording" | "recorded" | "transcribing" | "transcribed" | "ingested" | "failed";
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  size_bytes: number | null;
  local_hint: string | null;
  transcript: string | null;
  transcript_ref: string | null;
  drive_status: "none" | "pending" | "uploading" | "synced" | "failed";
  drive_file_id: string | null;
  drive_link: string | null;
  pipeline_run_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

let seq = 500;
const nid = (p: string) => `${p}-${++seq}`;
// A fixed clock so demo output is stable within a process (Date.now is fine in demo-only code).
const now = () => new Date().toISOString();

const RECORDINGS: DemoRec[] = [
  {
    id: "rec-demo-1",
    meeting_id: "mtg-northwind-kickoff",
    client_id: "cl-1",
    project_id: "p-web-1",
    title: "Northwind — site redesign kickoff",
    kind: "video",
    status: "ingested",
    started_at: "2026-07-18T02:00:00Z",
    ended_at: "2026-07-18T03:05:00Z",
    duration_sec: 3900,
    size_bytes: 512_000_000,
    local_hint: "C:/Gaiada/Recordings/northwind-kickoff.mp4",
    transcript: "Client wants a full redesign focused on conversion. Priority: homepage + checkout. Deadline end of Q3. Budget flexible for phase 1.",
    transcript_ref: null,
    drive_status: "synced",
    drive_file_id: "drv-demo-1",
    drive_link: "https://drive.google.com/file/d/drv-demo-1",
    pipeline_run_id: "run-demo-1",
    created_by: "demo-hansel",
    created_at: "2026-07-18T02:00:00Z",
    updated_at: "2026-07-18T03:10:00Z",
  },
  {
    id: "rec-demo-2",
    meeting_id: "mtg-cedar-scope",
    client_id: "cl-2",
    project_id: "p-seo-1",
    title: "Cedar Group — SEO scope call",
    kind: "audio",
    status: "transcribed",
    started_at: "2026-07-20T06:00:00Z",
    ended_at: "2026-07-20T06:40:00Z",
    duration_sec: 2400,
    size_bytes: 42_000_000,
    local_hint: "C:/Gaiada/Recordings/cedar-scope.m4a",
    transcript: "Scope: technical SEO audit + content gap analysis. 3-month engagement. Monthly reporting.",
    transcript_ref: null,
    drive_status: "pending",
    drive_file_id: null,
    drive_link: null,
    pipeline_run_id: null,
    created_by: "demo-hansel",
    created_at: "2026-07-20T06:00:00Z",
    updated_at: "2026-07-20T06:42:00Z",
  },
];

interface DemoResult { status: number; json: unknown }
const ok = (json: unknown): DemoResult => ({ status: 200, json });

function pub(r: DemoRec) {
  // The list view drops the heavy transcript; detail returns it.
  const { transcript, transcript_ref, local_hint, drive_file_id, ...rest } = r;
  void transcript; void transcript_ref; void local_hint; void drive_file_id;
  return rest;
}

/** Returns a DemoResult for any /meetings/recordings route, or null if it doesn't match. */
export function meetingsDemo(method: string, p: string, params: URLSearchParams, body?: string): DemoResult | null {
  const m = method.toUpperCase();

  const startM = p.match(/^\/api\/[^/]+\/meetings\/recordings\/start$/);
  if (startM && m === "POST") {
    const b = JSON.parse(body || "{}");
    const rec: DemoRec = {
      id: nid("rec"), meeting_id: `mtg-${nid("d")}`, client_id: b.clientId ?? null, project_id: b.projectId ?? null,
      title: b.title ?? null, kind: b.kind === "video" ? "video" : "audio", status: "recording",
      started_at: now(), ended_at: null, duration_sec: null, size_bytes: null, local_hint: null,
      transcript: null, transcript_ref: null, drive_status: "none", drive_file_id: null, drive_link: null,
      pipeline_run_id: null, created_by: "demo-hansel", created_at: now(), updated_at: now(),
    };
    RECORDINGS.unshift(rec);
    return { status: 201, json: { id: rec.id, meetingId: rec.meeting_id, deduped: false } };
  }

  const transM = p.match(/^\/api\/[^/]+\/meetings\/recordings\/([^/]+)\/transcript$/);
  if (transM && m === "POST") {
    const rec = RECORDINGS.find((r) => r.id === transM[1]);
    if (!rec) return { status: 404, json: { error: "recording not found" } };
    const b = JSON.parse(body || "{}");
    rec.transcript = String(b.text ?? ""); rec.status = "transcribed"; rec.updated_at = now();
    return ok({ id: rec.id, status: "transcribed", chars: rec.transcript.length });
  }

  const ingestM = p.match(/^\/api\/[^/]+\/meetings\/recordings\/([^/]+)\/ingest$/);
  if (ingestM && m === "POST") {
    const rec = RECORDINGS.find((r) => r.id === ingestM[1]);
    if (!rec) return { status: 404, json: { error: "recording not found" } };
    if (!rec.transcript) return { status: 400, json: { error: "no transcript to ingest" } };
    // Demo: simulate a successful dispatch (real bridge is proxied server-side in prod).
    rec.status = "ingested"; rec.pipeline_run_id = rec.pipeline_run_id ?? nid("run"); rec.updated_at = now();
    return ok({ ok: true, runId: rec.pipeline_run_id, deduped: false });
  }

  const driveM = p.match(/^\/api\/[^/]+\/meetings\/recordings\/([^/]+)\/drive$/);
  if (driveM && m === "POST") {
    const rec = RECORDINGS.find((r) => r.id === driveM[1]);
    if (!rec) return { status: 404, json: { error: "recording not found" } };
    const b = JSON.parse(body || "{}");
    rec.drive_status = b.status ?? "pending"; if (b.driveLink) rec.drive_link = b.driveLink; rec.updated_at = now();
    return ok({ id: rec.id, driveStatus: rec.drive_status });
  }

  const detailM = p.match(/^\/api\/[^/]+\/meetings\/recordings\/([^/]+)$/);
  if (detailM && !startM) {
    const rec = RECORDINGS.find((r) => r.id === detailM[1]);
    if (m === "PATCH") {
      if (!rec) return { status: 404, json: { error: "recording not found" } };
      const b = JSON.parse(body || "{}");
      if (b.status) rec.status = b.status;
      if (b.title != null) rec.title = b.title;
      if (b.durationSec != null) rec.duration_sec = Number(b.durationSec);
      if (b.sizeBytes != null) rec.size_bytes = Number(b.sizeBytes);
      if (b.localHint != null) rec.local_hint = b.localHint;
      if (b.endedAt != null) rec.ended_at = b.endedAt;
      rec.updated_at = now();
      return ok({ id: rec.id, status: rec.status });
    }
    if (!rec) return { status: 404, json: { error: "recording not found" } };
    return ok(rec); // detail includes transcript
  }

  const listM = p.match(/^\/api\/[^/]+\/meetings\/recordings$/);
  if (listM && m === "GET") {
    const status = params.get("status"), clientId = params.get("clientId"), projectId = params.get("projectId");
    let rows = RECORDINGS;
    if (status) rows = rows.filter((r) => r.status === status);
    if (clientId) rows = rows.filter((r) => r.client_id === clientId);
    if (projectId) rows = rows.filter((r) => r.project_id === projectId);
    return ok(rows.map(pub));
  }

  return null;
}
