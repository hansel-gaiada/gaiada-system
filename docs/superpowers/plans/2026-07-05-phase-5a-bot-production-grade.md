# Phase 5a — Bot to Production Grade (full-fidelity, no shortcuts)

> Governing: `2026-07-05-phase-5-full-fidelity.md` (BINDING mandate) + day-one spec +
> whatsapp-automation-bot-design spec. TDD; commit per task; update the checklist.
> WAHA ≥2026.6.1: all former Plus features free — media + multi-session fully usable.

- [ ] **5a.1 Redis + BullMQ media queue** — add `redis` service to both compose files; `media_status='pending'` rows enqueue a BullMQ job on receipt (webhook path); keep the store-poller as a reconciler for missed jobs (never a silent drop). Tests: enqueue on media intake; worker consumes; reconciler catches an unenqueued pending row.
- [ ] **5a.2 Media worker as its own process** — `src/media-worker.ts` entrypoint (BullMQ consumer, concurrency-limited via env); requires DATABASE_URL (PG store); compose gets a `bot-media-worker` service. FileStore mode keeps the in-process poller (dev only). Tests: worker entrypoint processes a job end-to-end with fakes.
- [ ] **5a.3 faster-whisper transcriber (local-first)** — self-hosted via `whisper.cpp`/faster-whisper server container (compose service, CPU ok for trial); gateway MEDIA_CHAIN gains a `whisper` provider for `audio/*` ahead of gemini. Tests: provider adapter with fake server; chain routes audio→whisper, image→gemini.
- [ ] **5a.4 Video + docs extraction** — ffmpeg keyframes (N frames → vision describe) + audio track → transcriber; `mammoth` (docx), `xlsx` (sheets) local extraction; OCR fallback for image-only PDFs (via vision). Tests: fixture files per type; scrub still applied (extend the critical 2.6 test to every new type).
- [ ] **5a.5 Fuller scrubber (day-one spec)** — expand patterns: unlabelled NIK w/ province-code validation, phone numbers (opt-in), bank account patterns (labelled), email (opt-in), NPWP; shared ruleset published to ai-gateway copy (keep-in-sync note → consider extracting a versioned ruleset file both copy verbatim). Property tests + false-positive corpus.
- [ ] **5a.6 Map-reduce summarizer** — window > token threshold → chunk → per-chunk summaries → reduce to the sectioned digest; deterministic chunk boundaries. Tests: oversized fixture window produces one digest containing facts from first AND last chunk.
- [ ] **5a.7 Telegram media** — poller/webhook capture photo/voice/document file_ids → `getFile` download path in the media worker (Bot API serves files free); same scrub pipeline. Tests: TG update with voice → pending row → worker processes via Bot API URL.
- [ ] **5a.8 Scheduler + state to PG** — `schedule_state` + `groups` tables (RLS) when DATABASE_URL set (file fallback stays for dev); per-slot/day idempotency lock (INSERT ... ON CONFLICT DO NOTHING claim). Tests: double-fire same slot/day runs once; registry can hydrate from DB.
- [ ] **5a.9 Retire the interim rag.ts shim** — delete `wa-chat-bot/src/rag.ts`(+test); `/doc`-style retrieval goes through the WS8 knowledge service (`knowledge.search` via hub) with the sender envelope. Add a `/know <question>` skill: hub knowledge.search → gateway summarize w/ citations. Tests: skill forwards envelope; denial → step-up.
- [ ] **5a.10 OpenBao replaces LocalKms (0.4)** — compose `openbao` service (dev mode locally; ISOLATED VPS in prod per runbook); `OpenBaoKms` transit adapter (create/delete key = shred, encrypt/decrypt data keys, HMAC); **Kms interface goes async** (refactor envelope/encode/store call paths); LocalKms remains the no-OpenBao dev fallback. Re-run the day-one shred drill against OpenBao. Runbook: unseal (Shamir 3-of-5), off-box snapshot, break-glass.
- [ ] **5a.11 Drive connector for /capture (D8.4)** — governed connector service route through the gateway boundary (audit + DLP), Google OAuth creds user-supplied; graceful "not configured" until then. Tests with fake Drive API.
- [ ] **5a.12 Phase e2e + docs** — full-fidelity e2e: TG voice note → whisper transcript (fake) → scrubbed → digest; WA doc → extraction → digest; checklist + READMEs updated; all suites green.

**Order:** 5a.10 (async Kms refactor first — touches the most code) → 5a.1/5a.2 → 5a.3/5a.4 →
5a.5 → 5a.6 → 5a.7 → 5a.8 → 5a.9 → 5a.11 → 5a.12.
