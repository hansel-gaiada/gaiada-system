// The "click record → system follows" orchestration. Holds the helper's view of recordings and runs
// the local pipeline: record → (stop) → local whisper → register/transcript to the ERP → ingest →
// Drive upload. Everything is local-first; only the transcript text is sent into the delivery pipeline.
import { basename } from "node:path";
import { config, driveConfigured } from "./config.mjs";
import * as rec from "./recorder.mjs";
import { transcribeFile } from "./transcribe.mjs";
import { uploadToDrive } from "./drive.mjs";
import * as bff from "./platform.mjs";

/** @type {Map<string, any>} keyed by recording id (or a local temp id before registration). */
const jobs = new Map();
let current = null; // the id currently recording

const log = (job, msg) => { job.log = [...(job.log ?? []).slice(-20), `${new Date().toISOString()} ${msg}`]; };

export function list() {
  return [...jobs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
export function get(id) { return jobs.get(id); }
export function isRecording() { return rec.isRecording(); }

/** Start: register with the ERP (mint meetingId), then start ffmpeg to the meetingId-named file. */
export async function startRecord({ title, kind, clientId, projectId }) {
  if (rec.isRecording()) throw new Error("already recording");
  const reg = await bff.startRecording({ title, kind, clientId, projectId });
  const job = {
    id: reg.id, meetingId: reg.meetingId, title: title || reg.meetingId, kind,
    status: "recording", driveStatus: "none", file: null, transcript: null,
    startedAt: Date.now(), error: null, log: [],
  };
  jobs.set(job.id, job);
  current = job.id;
  try {
    const { file } = rec.start(kind, reg.meetingId);
    job.file = file;
    log(job, `recording → ${basename(file)}`);
  } catch (e) {
    job.status = "failed"; job.error = String(e.message ?? e); current = null;
    throw e;
  }
  return job;
}

/** Stop + run the full local pipeline. Returns the job; downstream steps continue async. */
export async function stopRecord() {
  if (!rec.isRecording() || !current) throw new Error("not recording");
  const job = jobs.get(current);
  current = null;
  const meta = await rec.stop();
  job.file = meta.file; job.durationSec = meta.durationSec; job.sizeBytes = meta.sizeBytes;
  job.status = "recorded";
  log(job, `stopped (${meta.durationSec}s, ${Math.round((meta.sizeBytes ?? 0) / 1e6)}MB)`);
  await bff.updateRecording(job.id, { status: "recorded", durationSec: meta.durationSec, sizeBytes: meta.sizeBytes, localHint: meta.file, endedAt: new Date().toISOString() });
  // Fire-and-forget the rest so the UI returns immediately; status is polled.
  runPipeline(job).catch((e) => { job.status = "failed"; job.error = String(e.message ?? e); log(job, `ERROR ${job.error}`); });
  return job;
}

/** transcribe → register transcript → ingest → Drive (reminder or auto-upload). */
async function runPipeline(job) {
  job.status = "transcribing"; log(job, "transcribing locally…");
  await bff.updateRecording(job.id, { status: "transcribing" });
  const text = await transcribeFile(job.file);
  job.transcript = text;
  await bff.setTranscript(job.id, text);
  job.status = "transcribed"; log(job, `transcript ${text.length} chars`);

  log(job, "ingesting → delivery pipeline…");
  const ing = await bff.ingest(job.id);
  if (ing.ok) { job.status = "ingested"; job.runId = ing.runId ?? null; log(job, `ingested → run ${String(job.runId ?? "").slice(0, 8)}`); }
  else { log(job, `ingest deferred: ${ing.reason}`); }

  // Drive: auto-upload if configured, else set a "remind me" nudge. Never blocks the pipeline.
  if (driveConfigured()) {
    job.driveStatus = "uploading"; log(job, "uploading to Drive…");
    await bff.markDrive(job.id, "uploading");
    try {
      const { fileId, webViewLink } = await uploadToDrive(job.file, `${job.title}.${job.kind === "video" ? "mp4" : "m4a"}`);
      job.driveStatus = "synced"; job.driveLink = webViewLink;
      await bff.markDrive(job.id, "synced", webViewLink, fileId);
      log(job, "synced to Drive");
    } catch (e) {
      job.driveStatus = "failed"; log(job, `Drive upload failed: ${e.message ?? e}`);
      await bff.markDrive(job.id, "failed");
    }
  } else {
    job.driveStatus = "pending";
    await bff.markDrive(job.id, "pending");
    log(job, "Drive not configured — reminder set");
  }
}

/** Manually (re-)upload a job's file to Drive. */
export async function uploadDrive(id) {
  const job = jobs.get(id);
  if (!job?.file) throw new Error("no local file for this recording");
  job.driveStatus = "uploading"; await bff.markDrive(id, "uploading");
  const { fileId, webViewLink } = await uploadToDrive(job.file, `${job.title}.${job.kind === "video" ? "mp4" : "m4a"}`);
  job.driveStatus = "synced"; job.driveLink = webViewLink;
  await bff.markDrive(id, "synced", webViewLink, fileId);
  return job;
}

/** Re-run ingest for a job (e.g. after the bridge was configured). */
export async function reingest(id) {
  const r = await bff.ingest(id);
  const job = jobs.get(id);
  if (job && r.ok) { job.status = "ingested"; job.runId = r.runId ?? null; }
  return r;
}
