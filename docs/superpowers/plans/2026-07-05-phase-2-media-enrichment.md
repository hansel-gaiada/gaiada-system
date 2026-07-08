# Phase 2 — Media Enrichment — Implementation Plan

> **For agentic workers:** task-structured; expand to bite-sized TDD before executing. Update `2026-07-05-CHECKLIST.md`.

**Goal:** Voice notes, images/video, and documents shared in monitored groups become text that feeds summaries and Q&A — with the ingestion scrubber applied to all extracted text before persistence.

**Consumes from Phase 0/1:** `WhatsAppGateway` (media download), `scrub`, `encryptField`, `db`, `gatewayChat`/vision via Gateway, BullMQ.

---

### Task 2.1 — Media intake + enqueue
- **Files:** `packages/app/src/media/intake.ts`, extend `messages` (`media_status`, `media_type`, `media_mime`, `media_duration`, `media_text`), test.
- **Produces:** on a media message, persist with `media_ref` + `media_status='pending'` and enqueue a BullMQ job **eagerly on receipt**.
- **Test:** media message → row with `pending` + a job enqueued.

### Task 2.2 — Media worker (separate entrypoint)
- **Files:** `packages/app/src/media/worker.ts` (own process entrypoint), test.
- **Produces:** concurrency-limited worker that pulls a job, downloads the file via the WA gateway to a temp path, routes by type, calls the processor, writes `media_text`, sets `media_status='done'`; on final failure → `failed` + placeholder. Bytes discarded after processing (keep `media_ref`).
- **Test:** job for a fixture → processor invoked → `media_text` set; forced failure → `failed` + placeholder, no crash.

### Task 2.3 — Transcriber (audio/voice)
- **Files:** `packages/media/src/transcriber.ts` (interface + faster-whisper adapter), test with a short fixture ogg.
- **Produces:** `Transcriber.transcribe(path): Promise<string>`. **Test:** fixture audio → non-empty transcript (adapter faked in CI; real run manual).

### Task 2.4 — VisionDescriber (images + video)
- **Files:** `packages/media/src/vision.ts` (Gemini via Gateway), test.
- **Produces:** `describeImage(path)`; `describeVideo(path)` = ffmpeg keyframes → describe + audio track → `Transcriber`. **Test:** fixture jpg → caption (fake Gateway in CI).

### Task 2.5 — DocExtractor
- **Files:** `packages/media/src/docs.ts`, test with a 1-page pdf/docx/xlsx.
- **Produces:** `extract(path, mime): Promise<string>` (pdf-parse / mammoth / xlsx; OCR fallback for image-only pdf). **Test:** fixture doc → extracted text.

### Task 2.6 — Scrub media-derived text before persist
- **Files:** wire `scrub` into `worker.ts` before writing `media_text`; test.
- **Test:** a PAN spoken in a transcription / shown in an OCR'd image is `[REDACTED-CARD]` in stored `media_text` (the day-one guarantee extends to media). **Critical.**

### Task 2.7 — Summaries consume media_text
- **Files:** modify `summarize/digest.ts` to include ready `media_text`; test.
- **Test:** a transcribed voice note's content appears in the digest; a still-`pending` item degrades to a placeholder without blocking the run.

### Task 2.8 — Phase integration test
- **Files:** `packages/app/test/phase2.e2e.test.ts`.
- **Test:** enqueue a fixture-media job → `media_text` populated (scrubbed) → run a digest → assert it appears. Commit.

---

## Self-review
- Covers WA bot spec §6. Reuses the Phase-0 scrubber on all extracted text (day-one guarantee). Vision/transcription route through the Gateway/local per the provider config — no keys in the worker.
