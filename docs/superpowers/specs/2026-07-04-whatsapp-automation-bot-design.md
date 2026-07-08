# WhatsApp Automation Bot — Design Spec

**Date:** 2026-07-04
**Status:** Draft for review
**Scope:** Full system across three delivery phases plus a cross-cutting AI-provider/failover layer. MCP *server* creation is out of scope here and will be brainstormed separately (this spec covers the bot as an MCP *client*).

---

## 1. Purpose & Overview

An internal WhatsApp bot for company department, project, and management groups that:

1. **Summarizes** each monitored group's conversation twice daily (12:00 and 18:00, GMT+8), producing a **project-status–oriented digest**.
2. Delivers a **combined, category-grouped digest to the management group**, and posts each group's own summary back into it **when that group is opted in**.
3. **Answers questions and runs workflows** on request — in groups (via @mention, `/command`, or reply-to-bot) and in DMs — using the group's own chat history + general knowledge now, and live company DB data later.
4. **Enriches media** shared in chats — transcribes voice notes, describes images/video, extracts document text — so it all feeds summaries and Q&A.
5. **Interacts with a company MCP server** (to be built separately) for DB and other actions.

**Non-goals / explicit deferrals:**
- The company MCP server and the company database schema do not exist yet; this spec designs the bot to consume them behind interfaces. Concrete DB/MCP wiring lands in Phase 3.
- Mass/outbound marketing messaging is out of scope (and would raise ban risk).

---

## 2. Key Decisions (locked)

| Area | Decision | Rationale |
|---|---|---|
| WhatsApp connection | Unofficial engine, behind a swappable `WhatsAppGateway` interface; **WAHA** as default adapter (Evolution/Baileys swappable) | Official Cloud API cannot passively read group chatter; gateway isolates the risky layer behind a stable REST+webhook contract |
| Runtime | Node.js + TypeScript | WAHA/Baileys ecosystem is Node-native; good fit for webhooks + async media |
| Architecture | **Modular monolith** + supporting containers (WAHA, Postgres, Redis) | Right-sized for internal use; splits into services later if needed |
| Storage | **Persist messages** (text + media metadata + extracted text) to Postgres; do not archive raw media bytes by default | Enables re-summarization, Q&A over history, audit, restart recovery |
| Default LLM | **Google Gemini free tier**, behind a swappable `LLMProvider` interface | Smart, generous free tier, native vision. *Free tier may train on data — see §8 privacy* |
| Transcription | **Local faster-whisper**, behind a `Transcriber` interface | Free, private, multilingual |
| Vision | **Gemini vision** for images; video = keyframes (ffmpeg) described by Gemini + audio track via faster-whisper | Reuses default provider; covers video without full-frame processing |
| Doc extraction | **Local** libraries (pdf-parse, mammoth, xlsx); OCR (tesseract) / vision fallback for scanned PDFs | Private, free, no AI needed for born-digital docs |
| Scheduler | cron pinned to **Asia/Singapore (GMT+8)**, 12:00 & 18:00 | Requirement |
| Async work | **Redis + BullMQ** worker for the media pipeline | Heavy processing off the request path |
| AI provider strategy | **All AI capabilities behind interfaces, routed via a `CapabilityRouter`** with ordered provider chains, health checks, circuit-breaker **hot-swap failover**, and cost cap + alert on paid fallback | Prod target is all-local processing on own servers, auto-failover to paid cloud when local is down |

---

## 3. Cross-Cutting: AI Provider Abstraction & Hot-Swap Failover

Every AI capability sits behind a capability interface: `LLMProvider` (chat/summarize + tool-calling), `VisionDescriber`, `Transcriber`, `DocExtractor`.

Each interface is fronted by a **`CapabilityRouter`** that provides no-restart failover:

- **Ordered provider chain per capability, config-driven.** Example production config:
  ```yaml
  providers:
    llm:        [local_ollama,  gemini_paid]
    vision:     [local_llava,   gemini_paid]
    transcribe: [local_whisper, openai_whisper]
    docs:       [local_extract]
  ```
  Initial (local infra not yet stood up):
  ```yaml
  providers:
    llm:        [gemini_free]
    vision:     [gemini_free]
    transcribe: [local_whisper]
    docs:       [local_extract]
  ```
  Switching to "local-primary, paid-fallback" is a **config change, not code**.

- **Circuit breaker + health probes.** Each provider exposes a lightweight health check. After N consecutive failures/timeouts (e.g., local server down), the breaker opens and the router hot-swaps to the next provider in the chain. A background probe closes the breaker and **routes back to the primary automatically** when it recovers.

- **Cost governance on paid fallback (cap + alert).** The router tracks paid-fallback usage. On crossing a configurable daily/monthly cap it **alerts** (log + message to the management group) and **degrades** (stops using paid → placeholders) rather than incurring unbounded cost during a long outage.

- **Graceful degradation.** If every provider in a chain is unavailable, callers receive a typed failure: summaries emit a placeholder, media is marked `failed`, Q&A replies "temporarily unavailable." Nothing crashes.

---

## 4. System Architecture

Modular monolith (single TS codebase, multiple entrypoints) + containers.

```
WhatsApp  ──►  WAHA (gateway container)  ──webhook──►  Webhook Receiver
                                                            │
                                                     Ingestion/Normalizer
                                                            │
                                    ┌───────────────────────┼───────────────────────┐
                                    ▼                        ▼                        ▼
                             Message Store            Media job enqueue         Interaction Layer
                              (Postgres)              (Redis/BullMQ)            (trigger→route→reply)
                                    │                        │                        │
                                    │                 Media Worker            Q&A / Workflow / Agent
                                    │              (whisper/vision/docs)             │
                                    ▼                        │                        │
                              Scheduler (cron GMT+8) ────► Summarizer ◄───────────────┘
                                                            │        (all AI calls via CapabilityRouter)
                                                            ▼
                                                        Delivery
                                             (management digest + opt-in group summaries)
```

**Processes:** (1) main app (webhook receiver, interaction layer, scheduler, delivery); (2) media worker. Shared code, separate entrypoints.

---

## 5. Phase 1 — Ingestion + Summarization Core (+ Interaction Rails)

The headline feature. Text-only (media handled in Phase 2; company DB in Phase 3).

### 5.1 Components
1. **`WhatsAppGateway` interface** + WAHA adapter — connect, receive events, send messages, list groups.
2. **Webhook receiver** — HTTP endpoint for WAHA message events.
3. **Ingestion/normalizer** — gateway payload → internal `Message` shape.
4. **Message store** (Postgres) — persists messages, groups, schedule state, and the bot's own outbound messages.
5. **Group registry** — **auto-discovery** (logs all groups the bot is in, with IDs/names) + **YAML config** curation (category, opt-in, management flag), hot-reloadable. Groups not listed are logged but not monitored.
6. **Scheduler** — cron @ 12:00 & 18:00 Asia/Singapore.
7. **`LLMProvider` interface** + Gemini adapter (via `CapabilityRouter`).
8. **Summarizer** — per group, builds the project-status prompt, calls the router.
9. **Delivery** — posts each opt-in group's digest into it; assembles + posts the category-grouped combined digest to the management group.
10. **Interaction layer** — trigger detection, intent routing, Q&A responder, workflow registry (scaffold).

### 5.2 Time-window model
Each run summarizes messages **since the previous run**, tracked by persisted `last_run_at` per slot:
- **12:00 run** covers **18:00 (prev day) → 12:00**.
- **18:00 run** covers **12:00 → 18:00**.
- Persisted timestamp closes gaps if the bot was down. First-ever run caps lookback at 24h. Zero-message groups are reported "quiet" (or skipped for per-group delivery).

### 5.3 Summary format (project-status oriented)
Extracted purely from the window's conversation (no external schedule in Phase 1):
- **Discussion summary** — brief narrative recap of what the group discussed.
- **Projects — ongoing & new** — each project + current progress/status.
- **Needs help / not finished** — open projects, help-requests, blockers.
- **Behind schedule** — anything flagged delayed/at-risk *(inferred from chat language, e.g. "delayed", "still blocked", "waiting on approval", "no update since Monday")*.
- **Open questions (unanswered)** — questions nobody replied to in the window.
- **Answered questions** — questions that were resolved, with the resolution.

~150–300 words/group. The management digest concatenates these grouped by category with group-name headers. Oversized windows use map-reduce (chunk → summarize chunks → combine).

> **Caveat (documented expectation):** "Behind schedule" / "needs help" are *inferred from chat* in Phase 1. Cross-referencing real deadlines/schedules requires the company DB and lands in Phase 3.

### 5.4 Interaction layer (scaffold now, grows in Phase 3)
- **Trigger detector** fires when ANY of: bot is **@mentioned**; message starts with the **command prefix** (`/`); message is a **reply to one of the bot's own messages**; or it's a **DM** (always).
- **Intent router** — `/`-command matching a registered workflow → **workflow dispatcher**; otherwise → **Q&A responder**.
- **Workflow registry** — `register(name, handler)` + dispatch + `/help` listing. Ships with a trivial `/ping` to prove the path; real workflows added in Phase 3 with no core changes.
- **Q&A responder (Phase 1 scope)** — answers about the group's **own stored chat history** (recency/keyword retrieval in Phase 1; upgraded to pgvector RAG in Phase 3) **+ general LLM knowledge**. Company-DB questions are deferred to Phase 3. Reply-to-bot enables short follow-up threads (keeps last N turns as context).

### 5.5 Data model (Postgres)
- **`groups`**: `id` (WA group id), `name`, `category`, `opt_in` bool, `is_management` bool, `monitored` bool, `discovered_at`.
- **`messages`**: `id`, `group_id`, `sender_id`, `sender_name`, `wa_message_id`, `timestamp`, `type`, `text`, `from_bot` bool, `media_ref` (nullable), `raw` jsonb.
- **`summaries`**: `id`, `group_id`, `window_start`, `window_end`, `run_slot` (noon/evening), `content`, `created_at`.
- **`schedule_state`**: `slot`, `last_run_at`.

### 5.6 Config (`config/groups.yaml`)
```yaml
timezone: Asia/Singapore
schedule: { noon: "12:00", evening: "18:00" }
command_prefix: "/"
management_group_id: "1203...@g.us"
groups:
  - id: "1111...@g.us"
    name: "Dept — Engineering"
    category: "Department"
    opt_in: true      # gets its own summary posted back
  - id: "2222...@g.us"
    name: "Project X"
    category: "Project"
    opt_in: false     # only feeds the management digest
```

### 5.7 Error handling
- Gateway down / webhook gaps: WAHA reconnects; we rely on persisted messages, not live state. Missed windows caught by `last_run_at`.
- LLM failure/rate limit: `CapabilityRouter` handles retry/failover; on final failure deliver `"summary unavailable for <group>"` so one group's failure doesn't block the digest.
- Send failures: logged and retried; the management digest is attempted even if a per-group post fails.

### 5.8 Testing
- Unit: normalizer, window calculation, config loader, prompt builder, digest assembler, trigger detector, intent router (fixtures, no network).
- Contract tests for `WhatsAppGateway` and `LLMProvider` (fake adapters).
- Integration: seed messages → run summarization → assert stored summaries + delivery calls; interaction: simulate each trigger → assert routing + reply.

---

## 6. Phase 2 — Media Enrichment Pipeline

### 6.1 Flow
Media message → stored with a `media_ref` and `media_status=pending` → **processing job enqueued eagerly on receipt** (so enriched text is ready before summaries) → media worker downloads the file from the gateway, routes by type, runs the processor, writes extracted text to `media_text`, sets `media_status=done`.

### 6.2 Processors (each behind an interface, routed via `CapabilityRouter`)
- **`Transcriber`** — voice notes/audio → local faster-whisper.
- **`VisionDescriber`** — images → Gemini vision caption; **video** → ffmpeg keyframes described by Gemini **+** audio track via faster-whisper.
- **`DocExtractor`** — PDF/docx/xlsx/txt → local extraction; scanned/image-only PDFs → OCR (tesseract) or route pages through `VisionDescriber`.

### 6.3 Infra
- Redis + BullMQ; a separate **media worker** entrypoint, concurrency-limited so whisper/ffmpeg don't overwhelm the host.
- Files downloaded to temp, processed, bytes discarded by default (keep `media_ref` to re-fetch). Optional archive toggle later. Size caps configurable.

### 6.4 Data model additions
- `messages.media_text` (nullable), `messages.media_status` (`pending`/`done`/`failed`), `messages.media_type`, `messages.media_mime`, `messages.media_duration`.

### 6.5 Error handling
- Per-processor retry/backoff; on final failure `media_status=failed` + placeholder (`[voice note — transcription failed, 0:42]`) so the message still counts in summaries.
- Unsupported/oversized files: skip with logged placeholder.
- Summaries use whatever `media_text` is ready; still-`pending` items degrade to placeholder rather than blocking the run.

### 6.6 Testing
- Unit per processor with small fixtures (short ogg, jpg, 1-page pdf).
- Contract tests for `Transcriber`/`VisionDescriber`/`DocExtractor` (fake adapters — no model calls in CI).
- Integration: enqueue fixture job → assert `media_text` populated → assert it appears in a generated summary.

---

## 7. Phase 3 — Conversational Q&A + MCP Tool Layer

Upgrades the Phase 1 interaction rails into a tool-using agent with live company data. (The MCP *server* is designed separately; here the bot is an MCP *client*.)

### 7.1 Agent architecture
Tool-using agent loop: `LLMProvider` (with tool-calling) receives the question + available tools, decides which to call, the agent executes and feeds results back, iterating until it can answer. Tool sources:
- **MCP client** — bot connects as a client to the company **MCP server(s)** (also local in prod). MCP tools discovered at runtime and exposed to the agent. Built against the MCP protocol, tested with a fake MCP server; real wiring is a config/connection change.
- **Local tools** — chat-history retrieval **upgraded to pgvector RAG**; the workflow registry from Phase 1 now populated with **real workflows**.
- **Loop guard** — max tool-call iterations to prevent runaway loops.

### 7.2 Access control (role + scope) — runs BEFORE any DB/MCP tool call
- Resolve requester (sender number) + location (group/DM) → role + allowed data scopes.
- Management group → broad queries; a project group → only its own project's scope; unknown senders → chat-history/general only, DB tools withheld.
- The guard filters which MCP tools the agent can even see, and validates tool arguments against scope.
- Every DB-backed answer written to an **audit log**. Permission denials return a clear "not authorized" message and are logged.

### 7.3 Ties back to earlier phases
- **"Behind schedule" gets real** — summaries can optionally cross-reference actual schedules/deadlines from the DB via MCP instead of pure chat inference.
- **Providers stay local-first** with the same hot-swap failover (the agent's LLM is just another routed capability).

### 7.4 Data model additions
- `interactions` (audit): `id`, `sender_id`, `group_id`, `question`, `tools_used` jsonb, `answer`, `created_at`.
- `message_embeddings` (pgvector) for RAG.
- `permissions`/`roles` config (YAML + optional DB overrides): sender/group → role → scopes.

### 7.5 Error handling
- MCP server unreachable → degrade to chat-history/general answer + tell the user DB is unavailable (no crash).
- Tool errors surfaced to the agent for a graceful reply.

### 7.6 Testing
- Unit: permission guard (role/scope matrix), workflow dispatch, RAG retrieval.
- Contract test against a **fake MCP server** exposing sample tools.
- Integration: role-scoped question → agent selects allowed tool → answer + audit row written; plus a denied case.

---

## 8. Privacy, Safety & Operational Notes

- **Private data → model choice matters.** Gemini free tier may train on submitted data. For private company chats, graduate to a paid tier or **local models in prod** (the stated target). The `CapabilityRouter` makes this a config change.
- **All-local prod target.** Production runs all processing on own servers (Ollama LLM, local vision, faster-whisper, local doc extraction, local MCP server). Paid cloud is an **automatic fallback only when local is down**, governed by cap + alert.
- **Ban-risk mitigation** (internal usage is low-risk but non-zero): use an **aged, warmed-up, disposable** WhatsApp number; stable IP; throttle outbound with human-like delays; no cold-messaging. Design number recovery (re-scan) as a quick operation via the gateway. Treat the number as replaceable.
- **Consent:** internal, consenting groups; document that the bot is present and summarizing. **(Superseded by the D2 hard compliance gate — this is not sufficient on its own.)**

### 8.1 D6 resolution — ban resilience (LOCKED, adversarial review)

WhatsApp is a **single point of failure** for the anchor deliverable. A *session drop* (re-scan same number) differs sharply from a **permanent ban** (new number belongs to zero groups → re-invite by every admin + re-notice). The official Cloud API cannot read/post ordinary groups, so it is **not** a hedge.

- **Warm standby number:** keep ONE pre-warmed number as a **passive member of every monitored group** (shadow linked device; stays silent until activated). Enables fast failover instead of an estate-wide scramble. (Standby stays passive; activating it re-exposes the same behavioral ban risk.)
- **Ban-recovery runbook** (distinct from session-drop): activate standby → scripted re-add from the `groups` table → auto re-post the compliance notice → backfill the `last_run_at` gap window.
- **Telegram parity (fallback):** build Telegram alongside WhatsApp so a ban degrades to Telegram (official API, no ban risk) rather than halting. Trade: added surface for a solo builder + groups must also exist on Telegram.
- **Named risk acceptance:** the unofficial-client ToS violation is recorded as an explicit, owned, accepted business risk — recalibrated to **"medium-probability, high-blast-radius"** — tracked in the compliance track (not a silent assumption).

---

## 9. Delivery Sequence

1. **Phase 1** — ingestion + persistence + auto-discover/config groups + scheduled project-status digests (management + opt-in groups) + interaction rails (chat-history/general Q&A, workflow scaffold, all four triggers) + `CapabilityRouter` (initially single-provider chains).
2. **Phase 2** — media enrichment (local whisper, Gemini vision + video keyframes/audio, local doc extraction) via BullMQ workers.
3. **Phase 3** — tool-using agent, MCP client for company DB, pgvector RAG, real workflows, role/scope access control + audit; enable local-primary/paid-fallback chains.

**Next brainstorm (separate spec):** the **company MCP server** — the tools it exposes, the DB it fronts, and its own local-first deployment.
