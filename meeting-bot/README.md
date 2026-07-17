# meeting-bot (WS11 build item 11 — STUB)

The meeting-to-delivery pipeline (`../automation/workflows/mtg-dispatcher.json`) is triggered by a
meeting bot that records a call and POSTs a completed recording to the dispatcher webhook. The choice
of recording provider (self-hosted Recall.ai-style vs. a SaaS transcriber webhook) is a **deferred
decision** (WS11 plan §10). Until then, this is a **contract-faithful stub**: a tiny poster that lets
you drive the whole pipeline from a pasted transcript, exactly as the real bot will.

## The contract (frozen — the real bot must match)

```
POST {N8N}/webhook/mtg/recording-complete
headers: x-gaiada-bridge-secret: <N8N_BRIDGE_SECRET>
body: {
  v: 1,
  meetingId: string,     // stable id — the dispatcher dedupes on it (delivery is at-least-once)
  tenantId: string,
  title?: string,
  transcript: string,    // v1 requires the transcript; audioRef-only transcription is a later enhancement
  participants?: [...], startedAt?: string
}
-> { ok, runId, deduped, prdConfidence }
```

## Use the stub

Needs Node 18+ (global fetch). No dependencies.

```bash
N8N_URL=http://localhost:5678 \
N8N_BRIDGE_SECRET=... \
AGENCY_TENANT_ID=... \
node submit.mjs ./sample-transcript.txt "Acme kickoff" mtg-demo-1
```

It reads the transcript file, builds the v1 envelope, and POSTs it. The dispatcher then runs
llm.summarize (MOM) + three llm.extract passes and creates the pipeline run; the run's
`pipeline.run.created` event fans out to the scope/report tracks, and the delivery track waits on the
PRD + scope sign-offs. Inspect progress in **platform-ui → Delivery Pipeline** or the client portal.

## What the real bot adds (later)

- Join/record the call (provider SDK) and produce `transcript` (or `audioRef` + let the dispatcher
  transcribe via `media.transcribe`).
- Resolve `tenantId`/`clientId` from the calendar invite or meeting metadata.
- Emit a stable `meetingId` for dedupe.
Everything downstream is already built and unchanged — only this ingestion edge is swapped.
