// WS11 build item 2 — pipeline orchestration tools + meeting extraction.
//
// These are the ACCESS surface the WS11 n8n workflows drive (backbone rule: n8n orchestrates,
// the hub accesses, the platform holds logic). The pipeline.* tools are thin fronts over the
// platform-nest pipeline endpoints (0017 / PipelineController), forwarding the caller's OBO
// envelope so the platform mints the principal, runs Cerbos + RLS, and emits the events that
// resume the workflow. The hub keeps no DB access and duplicates no authz.
//
// llm.extract is a Gateway-wrapped AI tool (no provider keys in the hub, D8): the dispatcher
// runs it three times (kind = prd | report | scope) — the "three separate targeted passes"
// decision. It returns { kind, content, confidence }; the confidence feeds the PRD-review gate.
//
// Deliberately NOT here: deciding a gate / recording a scope signature. Those are HUMAN actions
// taken in the ADNARA ERP / client portal via the platform BFF, not automation — n8n only opens
// gates and then waits for the `pipeline.gate.decided` / `scope.signed` event.
import { config } from "./config";
import { oboHeaders } from "./obo-headers";
import { registerTool } from "./registry";
import { gatewayComplete } from "./gateway-client";
import type { Principal } from "./principal";

async function platformGet(path: string, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    headers: {
      ...oboHeaders(principal, config.platformToken),
    },
  });
  if (res.status === 401 || res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

async function platformSend(method: "POST" | "PATCH", path: string, body: unknown, principal: Principal): Promise<string> {
  const res = await fetch(`${config.platformUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...oboHeaders(principal, config.platformToken),
    },
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? "platform denied the request");
  }
  if (!res.ok) throw new Error(`platform ${path} ${res.status}`);
  return JSON.stringify(await res.json());
}

const EXTRACT_KINDS: Record<string, string> = {
  prd: "a Product Requirements Document (problem, goals, users, functional requirements, acceptance criteria, out-of-scope)",
  report: "a concise internal status report (decisions made, risks, action items with owners)",
  scope: "a Scope Agreement (deliverables, commercial terms, timeline/milestones, assumptions, explicit exclusions)",
};

export function registerPipelineTools(): void {
  // ---- F-1 fix: recover client/project context the frozen dispatcher webhook cannot carry ----
  // The meeting-bot seam (WS11 §8) is frozen at { v, meetingId, tenantId, title, transcript } — no
  // clientId/projectId. But `meeting_recordings` (the capture-edge registry) DOES carry both, and
  // `pipeline.createRun` DOES accept clientId ("drives client-portal scoping") — it was simply never
  // read out of the row and forwarded. Rather than widen the frozen contract, the dispatcher now
  // looks the row up by the same meetingId it already has, via this READ tool over the EXISTING
  // `GET /:tenantId/meetings/recordings` registry endpoint (unmodified — no platform-nest change).
  // Recordings not created through the registry (e.g. a raw pasted-transcript test POST) simply have
  // no matching row, so this degrades to { clientId: null, projectId: null } — no regression.
  registerTool({
    name: "meeting.recordingContext",
    description:
      "Look up the client/project context (and any pipeline run already linked) recorded on a meeting_recordings row by the bot's stable meetingId. Returns { clientId, projectId, pipelineRunId } (all null if no matching recording row exists, or if no run is linked yet).",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        meetingId: { type: "string" },
      },
      required: ["tenantId", "meetingId"],
    },
    handler: async (args, principal) => {
      const meetingId = String(args.meetingId ?? "");
      if (!meetingId) return JSON.stringify({ clientId: null, projectId: null, pipelineRunId: null });
      const raw = await platformGet(`/api/${String(args.tenantId)}/meetings/recordings`, principal);
      let rows: Array<{ meeting_id?: string; client_id?: string | null; project_id?: string | null; pipeline_run_id?: string | null }> = [];
      try {
        rows = JSON.parse(raw);
      } catch {
        rows = [];
      }
      const row = rows.find((r) => r.meeting_id === meetingId);
      // WD-08-R2: dedupe responses on the dispatcher's webhook need the ALREADY-linked run id so a
      // re-posted meetingId doesn't come back with runId:null (cosmetic today because
      // meeting_recordings.pipeline_run_id is COALESCE-preserved, but the caller couldn't previously
      // learn which run it collided with).
      return JSON.stringify({ clientId: row?.client_id ?? null, projectId: row?.project_id ?? null, pipelineRunId: row?.pipeline_run_id ?? null });
    },
  });

  // ---- E1 fix (coordinator-directed correction) ----
  // The dispatcher's dedupe branch (n8n's own in-memory "have I seen this meetingId" marker,
  // set on FIRST SIGHT of a webhook post -- BEFORE any downstream work, including createRun)
  // needs to answer "does a run already exist for this meetingId", NOT "create one if not".
  // `pipeline.createRun` is the wrong tool for that branch even though its dedupe path resolves
  // the same authoritative column: if the first attempt set the marker and then failed before
  // ever creating a run (a hub hiccup, a failed extraction, etc.), a retry hitting the dedupe
  // branch would take createRun's INSERT path and mint a phantom run with no momRef/stages/
  // clientId -- and pipeline.run.created would fan out a scope-signoff gate for it. This tool is
  // a PURE READ, incapable of creating anything, so that failure mode cannot happen through it:
  // it fronts the same query pipeline.createRun's dedupe SELECT runs (`pipeline_runs WHERE
  // source_meeting_id = $1`, via GET /pipeline/runs?sourceMeetingId=... on the existing
  // pipeline_runs_meeting_idx), and returns null rather than ever inserting when nothing matches.
  registerTool({
    name: "pipeline.runBySourceMeeting",
    description:
      "Look up an existing pipeline run by the bot's stable meetingId (dedupe key), reading pipeline_runs.source_meeting_id -- the authoritative link set at run creation -- directly. Returns { runId } (null if no run has been created for this meetingId yet). Read-only: never creates or modifies anything, so it is safe to call from a branch that must not risk minting a duplicate/phantom run.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        sourceMeetingId: { type: "string" },
      },
      required: ["tenantId", "sourceMeetingId"],
    },
    handler: async (args, principal) => {
      const sourceMeetingId = String(args.sourceMeetingId ?? "");
      if (!sourceMeetingId) return JSON.stringify({ runId: null });
      const raw = await platformGet(
        `/api/${String(args.tenantId)}/pipeline/runs?sourceMeetingId=${encodeURIComponent(sourceMeetingId)}`,
        principal,
      );
      let rows: Array<{ id?: string }> = [];
      try {
        rows = JSON.parse(raw);
      } catch {
        rows = [];
      }
      return JSON.stringify({ runId: rows[0]?.id ?? null });
    },
  });

  // ---- Meeting extraction (AI, Gateway-wrapped) ----
  registerTool({
    name: "llm.extract",
    description:
      "Extract a structured artifact from meeting minutes via the governed AI Gateway. kind = prd | report | scope. Returns { kind, content, confidence } — confidence (0..1) reflects how completely the transcript specified this artifact.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["prd", "report", "scope"] },
        text: { type: "string", description: "The meeting minutes / transcript to extract from" },
      },
      required: ["kind", "text"],
    },
    handler: async (args) => {
      const kind = String(args.kind ?? "");
      const text = String(args.text ?? "");
      const target = EXTRACT_KINDS[kind];
      if (!target) throw new Error("kind must be prd|report|scope");
      if (!text.trim()) throw new Error("text required");
      const prompt =
        `You are extracting ${target} from the meeting minutes below.\n` +
        `Respond with ONLY a JSON object, no prose, of the exact form:\n` +
        `{"content": "<the artifact as markdown>", "confidence": <number 0..1>}\n` +
        `Set confidence to how completely the minutes specified this artifact (1 = fully specified, ` +
        `low = major gaps you had to guess).\n\nMEETING MINUTES:\n${text}`;
      const raw = await gatewayComplete(prompt);
      // Robust to non-compliant local models: parse JSON if present, else wrap the raw text.
      let content = raw;
      let confidence: number | null = null;
      try {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as { content?: unknown; confidence?: unknown };
          if (typeof parsed.content === "string") content = parsed.content;
          if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
        }
      } catch {
        // fall through with raw content + null confidence
      }
      return JSON.stringify({ kind, content, confidence });
    },
  });

  // ---- Pipeline state (thin over platform-nest PipelineController) ----
  registerTool({
    name: "pipeline.createRun",
    description:
      "Create a meeting-to-delivery pipeline run (optionally with initial stages). Dedupes on sourceMeetingId. Returns { id, deduped }.",
    minAssurance: "low",
    write: true,
    impact: "low", // creates orchestration state in-tenant; the real work is gated downstream
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        sourceMeetingId: { type: "string", description: "the bot's stable meeting id (dedupe key)" },
        title: { type: "string" },
        momRef: { type: "string", description: "storage ref to the generated minutes" },
        clientId: { type: "string", description: "the clients row this run belongs to (drives client-portal scoping)" },
        stages: {
          type: "array",
          description: "initial stages; may carry the extracted artifact + confidence so the dispatcher populates all three in one call",
          items: {
            type: "object",
            properties: {
              track: { type: "string", enum: ["delivery", "report", "scope"] },
              name: { type: "string" },
              status: { type: "string", enum: ["pending", "running", "awaiting_gate", "done", "failed"] },
              artifactRef: { type: "string" },
              confidence: { type: "number" },
            },
            required: ["track", "name"],
          },
        },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/pipeline/runs`, {
        sourceMeetingId: args.sourceMeetingId, title: args.title, momRef: args.momRef, clientId: args.clientId, stages: args.stages ?? [],
      }, principal),
  });

  registerTool({
    name: "pipeline.createStage",
    description: "Add a stage to a run (e.g. the delivery track's claude_design / claude_code / staging stages as it progresses). Returns { id }.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        runId: { type: "string" },
        track: { type: "string", enum: ["delivery", "report", "scope"] },
        name: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "awaiting_gate", "done", "failed"] },
        artifactRef: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["tenantId", "runId", "track", "name"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/pipeline/runs/${String(args.runId)}/stages`, {
        track: args.track, name: args.name, status: args.status, artifactRef: args.artifactRef, confidence: args.confidence,
      }, principal),
  });

  registerTool({
    name: "pipeline.updateRun",
    description:
      "Update a pipeline run's status (WD-05: parks a run 'blocked' once the bounded revise loop's escalation fires, so a later retrigger stops re-evaluating it). Emits pipeline.run.updated.",
    minAssurance: "low",
    write: true,
    impact: "low", // same tier as pipeline.createRun/updateStage — orchestration state only
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        runId: { type: "string" },
        status: { type: "string", enum: ["extracting", "delivery_active", "report_done", "scope_pending", "complete", "blocked"] },
      },
      required: ["tenantId", "runId"],
    },
    handler: (args, principal) =>
      platformSend("PATCH", `/api/${String(args.tenantId)}/pipeline/runs/${String(args.runId)}`, {
        status: args.status,
      }, principal),
  });

  registerTool({
    name: "pipeline.updateStage",
    description: "Advance/annotate a pipeline stage (status, artifactRef, confidence). Emits pipeline.stage.updated.",
    minAssurance: "low",
    write: true,
    impact: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        stageId: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "awaiting_gate", "done", "failed"] },
        artifactRef: { type: "string" },
        confidence: { type: "number" },
      },
      required: ["tenantId", "stageId"],
    },
    handler: (args, principal) =>
      platformSend("PATCH", `/api/${String(args.tenantId)}/pipeline/stages/${String(args.stageId)}`, {
        status: args.status, artifactRef: args.artifactRef, confidence: args.confidence,
      }, principal),
  });

  registerTool({
    name: "pipeline.openGate",
    description:
      "Open a human-in-the-loop gate (kind = prd_review|prd_sign|pm_review|customer_feedback|pm_approval|scope_signoff; actorSide = internal|client). Emits pipeline.gate.opened. n8n then WAITS for pipeline.gate.decided.",
    minAssurance: "low",
    write: true,
    impact: "low", // records a pending review request only — no business mutation (like approvals.request)
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        runId: { type: "string" },
        stageId: { type: "string" },
        kind: { type: "string", enum: ["prd_review", "prd_sign", "pm_review", "customer_feedback", "pm_approval", "scope_signoff"] },
        actorSide: { type: "string", enum: ["internal", "client"] },
        note: { type: "string" },
      },
      required: ["tenantId", "runId", "kind", "actorSide"],
    },
    handler: (args, principal) =>
      platformSend("POST", `/api/${String(args.tenantId)}/pipeline/gates`, {
        runId: args.runId, stageId: args.stageId, kind: args.kind, actorSide: args.actorSide, note: args.note,
      }, principal),
  });

  // ---- Reads (for a workflow to inspect run/gate state) ----
  registerTool({
    name: "pipeline.getRun",
    description: "Get a pipeline run with its stages, gates and scope sign-offs.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: { tenantId: { type: "string" }, runId: { type: "string" } },
      required: ["tenantId", "runId"],
    },
    handler: (args, principal) => platformGet(`/api/${String(args.tenantId)}/pipeline/runs/${String(args.runId)}`, principal),
  });

  // The rail's demand end. `code.scaffold` v2 is handed `prdArtifact`/`prototypeArtifact` — both
  // `pipeline_stages.artifact_ref` — and had no way to dereference either, which is what kept
  // PRD-driven scaffolding from running live. `ai-agents/src/code-scaffold/artifact-fetcher.ts`
  // already calls exactly this name; it was written against a contract that did not exist yet.
  //
  // Read-only, `low` assurance, and NOT a file reader: the platform side refuses any ref that no
  // pipeline stage in the tenant references, so holding this tool does not confer arbitrary file
  // access. It answers `{ resolvable: false, reason }` rather than failing when a ref is a URL or a
  // repo rather than stored text — a scaffolder needs to tell "cannot fetch" apart from "empty".
  registerTool({
    name: "pipeline.artifacts.get",
    description:
      "Resolve a pipeline stage's artifact_ref to its stored text (the signed PRD, the accepted " +
      "design). Returns resolvable:false with a reason when the ref is not stored content.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        artifactRef: { type: "string", description: "pipeline_stages.artifact_ref" },
      },
      required: ["tenantId", "artifactRef"],
    },
    handler: (args, principal) =>
      platformGet(
        `/api/${String(args.tenantId)}/pipeline/artifacts/content?ref=${encodeURIComponent(String(args.artifactRef))}`,
        principal,
      ),
  });

  registerTool({
    name: "pipeline.listGates",
    description: "List pipeline gates (default pending). Filter by status, actorSide, kind.",
    minAssurance: "low",
    inputSchema: {
      type: "object",
      properties: {
        tenantId: { type: "string" },
        status: { type: "string" },
        actorSide: { type: "string", enum: ["internal", "client"] },
        kind: { type: "string" },
      },
      required: ["tenantId"],
    },
    handler: (args, principal) => {
      const qs = new URLSearchParams();
      if (args.status) qs.set("status", String(args.status));
      if (args.actorSide) qs.set("actorSide", String(args.actorSide));
      if (args.kind) qs.set("kind", String(args.kind));
      const suffix = qs.toString() ? `?${qs.toString()}` : "";
      return platformGet(`/api/${String(args.tenantId)}/pipeline/gates${suffix}`, principal);
    },
  });
}
