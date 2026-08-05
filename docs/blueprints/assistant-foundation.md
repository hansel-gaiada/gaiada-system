# ERP Assistant — Foundation & Plan

> **Status: `PLANNED`** — design only, no code. Proposed module id `assistant`, first version `0.1.0`
> at first commit. Status vocabulary per [`docs/modules/MODULES.md`](../modules/MODULES.md).
>
> **Brainstormed / decisions locked:** 2026-08-04. Next step per repo convention: an architect
> design doc (`docs/superpowers/specs/`), then `/army` decomposition.

The conversational front door to Hermes and the agent brigade, inside the ERP: a rich assistant
workspace with streaming replies, previous sessions, visible capabilities, and managed memory.

---

## 1. Why this is net-new (measured baseline, 2026-08-04)

The engine is real. The surface does not exist.

| Piece | State | Relevance |
|---|---|---|
| Agent runtime | Real — [`ai-agents/src/orchestrator.ts`](../../ai-agents/src/orchestrator.ts), `specialists.ts`, `write-agent.ts`, `runner/queue.ts`, `models/registry.ts`, evals, trainer | The roster + handoff target |
| Episodic memory | Real — [`ai-agents/src/memory/episodic-pg.ts`](../../ai-agents/src/memory/episodic-pg.ts), provenance/trust, tenant pre-filter, `eraseTenant` | Run history + the feedback sink |
| Knowledge RAG | Live (pgvector, two tiers) on gda-aicenter | Citations |
| Provider fan-out | `ai-gateway-go` — DLP scrub, budget, audit, failover chain | The model path |
| Hermes reachability | Proven twice: `hermes-gateway` shim + MCP bidirectional | The brain |
| Tool catalog | `mcp-hub` + [`mcp-tools.controller.ts`](../../platform-nest/src/modules/mcp-tools.controller.ts) | The capabilities panel |
| **Chat surface in the ERP** | **None.** Only WhatsApp (Rhea) is conversational | This document |
| **Threads / sessions** | **None anywhere.** No conversation table; the agent loop takes one `goal` string | Net-new data model |

### The five constraints that actually shape the design

1. **`/agents` is goal-shaped, not chat.** Submit a goal → poll a table → read a run transcript
   ([`intelligence.controller.ts:114-178`](../../platform-nest/src/admin/intelligence.controller.ts#L114-L178)).
   Multi-turn is net-new: threads, message history, context assembly, compaction.

2. **The transcript authz rule is the central constraint.** Triggering a goal and reading a run
   transcript are `isElevated`-only *by design* — a transcript can contain tool output fetched under
   the triggering user's authority. **A chat is a transcript.** So the assistant cannot inherit that
   rule; it must execute tools under the *chatting user's own* Cerbos principal, which is precisely
   what makes an owner-private, non-elevated transcript safe. See §6.

3. **Streaming is half-built.** `POST /complete/stream` exists ([`server.go:616`](../../ai-gateway-go/internal/server/server.go#L616))
   and `StreamingProvider` is already declared ([`provider.go:17`](../../ai-gateway-go/internal/providers/provider.go#L17)),
   but **no provider implements it** — `ollama.go` / `openai.go` hardcode `"stream": false`, so the
   route emits the whole answer as one SSE chunk. The wire contract is stable; the providers are not.

4. **`hermes-gateway` cannot carry a chat as-is.** It `execFile`s `hermes -z <prompt>` once per
   request, buffers stdout, and scrapes an ANSI box for the reply. No incremental output, no session
   continuity, and headless Hermes keeps tool approvals ON — an unapproved tool just times out to a
   502. Streaming + session mapping is a real workstream (§5).

5. **D14 blocks the write half.** Approving a suspended automation write still executes nothing.
   The assistant makes that gap *user-visible*, which is an argument for closing it, not a reason to
   hide it (§7).

---

## 2. Decisions locked (2026-08-04, owner)

| # | Decision | Consequence |
|---|---|---|
| **D-A** | **Read + propose writes.** Q&A over ERP + knowledge; write intents become proposals in the existing approvals surface. | D14 resume path becomes a **hard dependency** for the write half. v1 must state plainly in the UI that an approved write does not yet execute. |
| **D-B** | **One Hermes front door + a visible agent roster.** Not per-department personas. | Persona work stays deferred per the agentic-native plan. The existing brigade appears as a roster you can hand a longer task to — chat and the goal-runner stay one system. |
| **D-C** | **Full page + drawer.** `/assistant` workspace *and* the omnipresent `@drawer` mount. | One engine, two mounts. The drawer is mostly layout once the page exists. |
| **D-D** | **Real streaming now, Hermes-connected, dev-stage ready.** | Implement `StreamingProvider` per provider and stream Hermes' stdout. Build against local/dev providers (Ollama, echo) — real keys and the real brain land at **staging**, so nothing may hard-depend on a production credential. |

---

## 3. Architecture

```
platform-ui  /assistant page  +  @drawer mount        (one engine, two mounts)
     |  POST message  ->  GET SSE stream
platform-nest  modules/assistant/                      (NEW)
     |    threads+messages store, context assembly, compaction,
     |    tool broker (caller's authority), approvals bridge, SSE relay
     +--> ai-gateway-go  POST /complete/stream         (real deltas, per provider)
     |         +--> ollama | openai | claude | gemini  (implement StreamingProvider)
     |         +--> hermes-gateway                     (streamed spawn + session map)
     +--> mcp-hub                                      (tool catalog + execution)
     +--> ai-agents                                    (roster, handoff -> goal run, episodic)
     +--> knowledge RAG                                (retrieval + citations)
```

The BFF is the only thing the UI talks to. Every model call still goes through `ai-gateway-go` so
DLP scrub, budget, audit and the failover chain stay in the path — the assistant gets no side door.

---

## 4. Data model

New tenant-scoped tables, RLS + the composite tenant-scoped FK convention, behind a new
`assistant` module gate (remember `app_module_allowed` is a **two-sided handshake** — the row's
module must match the request-declared `app.scopes` GUC).

Migration numbers: use the next unused per the ledger (`0077` as of 2026-08-04 — **verify at build
time**, sessions share this checkout).

| Table | Holds |
|---|---|
| `assistant_threads` | id, company_id, owner user_id, title, brain (provider/model), `hermes_session_id`, status (active/archived), pinned, last_message_at, rolling token/cost counters, compaction summary ref |
| `assistant_messages` | thread_id, seq, role (`user`/`assistant`/`tool`/`system`), content + structured parts, provider, model, tokens, latency_ms, error_kind |
| `assistant_tool_calls` | message_id, tool name + MCP server, redacted args, result summary, status, `authority_user_id`, `approval_id`, duration |
| `assistant_memory` | user- and/or company-scoped durable facts & preferences, provenance + trust (mirroring the episodic conventions), source_thread_id, pinned, confirmed_at |
| attachments | **reuse** the existing files reference-attach mechanism — do not invent a second one |

### Four memories, kept deliberately distinct

This separation is most of what makes the surface feel rich rather than gimmicky:

1. **Thread memory** — the transcript itself, plus a per-thread compaction summary once it outgrows
   the window. Resuming an old session is exact, not approximate.
2. **User memory** (`assistant_memory`) — durable preferences and facts, **editable and deletable**
   in a visible panel. Writes are *proposals*: the assistant asks "remember this?" and only a
   confirmed row becomes trusted. Unconfirmed rows are recorded but never fed as fact — the same
   quarantine discipline as untrusted episodic feedback.
3. **Org knowledge** — the existing pgvector RAG, read-only, always **cited**.
4. **Episodic** — agent run history; surfaced through the roster and fed by message feedback.

---

## 5. Streaming and the Hermes connection (D-D)

### Gateway providers

Implement `CompleteStream` on each provider: Ollama (`"stream": true`, NDJSON lines), OpenAI-compatible
(`stream: true`, SSE `delta` parse — this also covers Ollama Cloud), Claude (messages SSE), Gemini
(`streamGenerateContent`). The route already prefers a `StreamingProvider` and falls back, so this
lands provider-by-provider without a flag day.

**Design point that needs deciding, not deferring:** DLP scrub currently runs over a whole response
body. Token-wise scrubbing can miss a PII string split across two chunks. Either scrub on a
boundary-buffered window (emit only up to the last safe boundary) or hold-and-scan a small trailing
buffer. Naive per-token scrub is a leak, and it would leak *silently*.

### Hermes

`hermes-gateway` needs three changes to carry a chat:

1. **`spawn`, not buffered `execFile`** — stream stdout to SSE as it arrives, with a line-oriented
   incremental version of the existing ANSI/box parser (today's `extractChatReply` needs the whole
   buffer, so it can't be reused unchanged).
2. **Session mapping** — Hermes has its own session/resume concept (it prints `Session:` / `Resume…`).
   Persist it on `assistant_threads.hermes_session_id` and pass `--resume`, so an ERP thread and a
   Hermes session are the same conversation rather than two divergent histories.
3. **Tool boundary decided explicitly** — headless Hermes tool approvals are ON and time out to 502.
   The assistant's ERP tools therefore run through **our** broker (MCP hub, caller's authority),
   not through Hermes' own tool loop. Hermes is the language brain; the ERP authority stays ours.
   `--yolo` is not an acceptable shortcut here.

Hermes is one selectable brain among several (per-thread picker). If Hermes is unavailable, the
gateway failover chain still applies — see OQ-6 for whether that is silent or surfaced.

### Transport

`EventSource` cannot POST, so the contract is a **POST-then-GET pair**: post the message, get back a
stream URL, open SSE on it. Events: `token`, `tool_call`, `tool_result`, `approval_required`,
`usage`, `done`, `error` — consumed by a **pure reducer** (aivory's `agenticReducer` shape, §8) with
guards for malformed, duplicate and orphaned events, plus auto-complete when `done` arrives without a
terminal event. Client side needs an **idle timeout + `AbortController`** (aivory uses 120s) so a
stalled upstream fails visibly instead of hanging; render through a **typewriter smoother** so pacing
is even regardless of chunk size. nginx needs the same buffering-off SSE treatment already applied by
hand for the portal stream — otherwise it works locally and dies behind the proxy.

---

### Proposed BFF contract

All tenant-scoped and owner-private; to be added to `FRONTEND-BFF-CONTRACT.md` as `PENDING`.

| Method + path | Purpose |
|---|---|
| `GET /api/:t/assistant/threads` | List (paginated, search, pinned-first) |
| `POST /api/:t/assistant/threads` | Create (optional page context + brain) |
| `GET /api/:t/assistant/threads/:id` | Thread + paged messages + tool calls |
| `PATCH /api/:t/assistant/threads/:id` | Rename / pin / archive / change brain |
| `DELETE /api/:t/assistant/threads/:id` | Delete (hard, with memory link cleanup) |
| `POST /api/:t/assistant/threads/:id/messages` | Send → `{ messageId, streamUrl }` |
| `GET /api/:t/assistant/threads/:id/stream` | SSE: `token`, `tool_call`, `tool_result`, `approval_required`, `usage`, `done`, `error` |
| `POST /api/:t/assistant/threads/:id/stop` | Cancel in-flight (must cancel upstream, not just detach) |
| `GET /api/:t/assistant/capabilities` | Tools + modules **this caller** can use (MCP ∩ Cerbos ∩ module gates) |
| `GET·POST·DELETE /api/:t/assistant/memory` | User memory: list / propose-or-confirm / delete |
| `POST /api/:t/assistant/messages/:id/feedback` | ↑/↓ → episodic `HumanFeedback` (trust rules apply) |
| `POST /api/:t/assistant/threads/:id/handoff` | Create an agent goal from the thread; link the run |

---

## 6. Authorization

- **Threads are private to `(owner, company)`.** Owner-only read. No implicit elevated backdoor —
  admin access to someone's thread is a separate, audited action, not a side effect of being admin.
- **Tools execute as the chatting user.** Cerbos principal = that user, never a service principal.
  This is the property that makes a non-elevated transcript safe (constraint #2).
- **New Cerbos policy kinds** `assistant_thread`, `assistant_memory`. Two known traps: a *new* policy
  file is not hot-reloaded over the Windows bind mount, and an **unlisted kind is a silent DENY** that
  reads like a logic bug; deploys need the Cerbos-restart step.
- **Company scope** — switching companies must re-scope the thread list, not merely filter the view.
- **DLP** on every prompt and attachment through the gateway.
- **Erasure** — `eraseTenant` must reach threads, messages, tool calls and memory (OQ-1).

---

## 7. Writes are proposals (D-A + D14)

A write intent becomes a proposal card in the thread → the existing WS4 approvals surface → the
approver decides. v1 renders `proposed` / `sent for approval` / `approved` states and says plainly
that **approval does not yet execute** (D14 has no resume path — verified, deliberate deferral).

Sequencing follows from that: everything else can ship without D14; only the last phase depends on it.

---

## 8. UI composition

**`/assistant` (full page)**

- **Left rail — sessions:** search, pinned, grouped by date, rename / archive / delete, per-thread
  brain badge. This is the "previous sessions" requirement.
- **Center — thread:** markdown + code blocks, streaming cursor, stop, regenerate, edit-and-resend,
  copy, collapsible tool-call cards showing *what ran under whose authority*, knowledge citations,
  message feedback (↑/↓ → episodic).
- **Right rail (collapsible) — context inspector:** brain/model picker, company + department scope,
  **capabilities** list (MCP tools ∩ Cerbos ∩ module gates — what *this* user can actually do),
  **memory** panel (view/edit/delete/pin), attachments, token + cost meter, **agent roster** with
  hand-off to a goal run you can then watch.
- **Composer:** multiline, attach, slash-commands, and `@`-mentions of real ERP entities
  (project / task / client / person) that resolve into typed context refs rather than plain text.
  Voice input reuses the existing recorder.
- **Empty state:** capability cards — doubles as the discoverability answer.

**`@drawer` mount** — same engine, thread pinned to the current page's context, "open in full page"
promotes it to the workspace.

**Dark theme + a11y native from the start.** Missing dark theme is a known platform-wide gap; do not
add another surface to that debt.

### Reference implementation: aivory / "Aira" (owner's live project)

`Others/aivory/avry-user-dashboard` (and the near-identical `avry-console`) is a running,
owner-built chat surface. It is the design bar for this work, and several of its choices are
better than what §8 originally specified. What to lift, near-verbatim:

| Aivory piece | Take-away |
|---|---|
| `hooks/useChat.ts` (~230 lines) | **One hook is the whole engine** — messages, sessions, streaming, follow-ups all in one place; both the page and the FAB consume it |
| `lib/streaming.ts` → `streamConsoleResponse` | Real SSE as an **async generator**, plus a **client-side idle timeout** (120s) with `AbortController`. A stalled upstream must not hang the UI forever — this was missing from §5 |
| `typewriterStream` | A **smoothing layer over real deltas**. This is the honest fix for chunky output: keep the transport real and make the *render* even-paced. Answers the D-D trade-off without faking the transport |
| `lib/agenticReducer.ts` | The stream carries **structured agentic events** (`agentic_start`, `phase_start`, …), fed through a **pure reducer** to immutable state, with guards for malformed/orphaned/duplicate events and auto-complete when `agentic_end` never arrives. Adopt this shape for our `tool_call`/`tool_result` events — not ad-hoc `setState` in the SSE loop |
| `components/sidebar/` — `ConversationHistory`, `ConversationGroup`, `PinnedChats`, `SearchBar` | Exactly the session rail §8 asks for; the date-grouping + pinned split is already solved |
| `ThinkingIndicator`, `PhaseBox`, `SubStepIndicator` | Progress rendering for multi-step work |
| `FollowUpChips`, `SuggestionChips`, `MessageActions`, `ActionList` | Post-reply affordances — cheap, and most of what makes a chat feel finished |
| `intentClassifier` + `intentBoundaries` + `RoutingSuggestBanner` | Suggest a hand-off instead of a bad answer. Maps directly onto our agent roster (D-B) |
| `lib/userContextState.ts`, `lib/aivory-assistant/contextBuilder.ts` | Context assembly as its own module, separate from the chat loop |
| `UploadMenu`, `AttachmentCard`, `FileDropzone`, `FileAttachmentBar` | Attachment UX, incl. the data-URL image vs text-file split in `handleSend` |
| `parseLLMResponse`, `normalizeAssistantText` | Output hygiene as an explicit step — do not render raw model text |
| `ModeContext.agentTarget` | The brain/target picker as context, not prop-drilling |
| `AivoryAssistant.tsx` / `AiraFloatingAssistant.tsx` | The FAB/floating mount = our `@drawer` mount, same engine (**proves D-C is cheap once the page exists**) |

**Where the ERP must deliberately diverge — these are not oversights in aivory, they are consequences
of the ERP's tenancy model:**

1. **Persistence.** Aivory keeps sessions in `localStorage` (`aivory_chat_sessions`, with
   `QuotaExceededError` handling). The ERP cannot: threads must be server-side for tenant isolation,
   RLS, `eraseTenant` reach, audit, and multi-device continuity. This is the single biggest structural
   difference — the whole of §4 exists because of it.
2. **Tool authority.** Aivory has no per-row multi-tenant authz over ERP entities; ours executes every
   tool under the chatting user's Cerbos principal (§6).
3. **Writes.** Aivory acts directly; ours must route medium+ writes through the D14 gate (§7).
4. **Company scope.** No analogue in aivory — ours is scoped by the company switcher.
5. **Transport topology.** Aivory proxies through Next route handlers (`app/api/console/stream`).
   Ours puts the SSE relay in platform-nest, where authz, DLP and audit already live; the Next layer
   stays a thin client.

---

## 9. Build sequence

Phase 0 is blocking; after it, phases 1–5 are largely independent of D14.

| Phase | Content | Gate |
|---|---|---|
| **0. Foundations** | Migrations + RLS + module gate; Cerbos policies (with restart step); BFF module skeleton + contract; `CompleteStream` on Ollama; **DLP-on-stream decision implemented** | Blocking |
| **1. Thread engine** | Threads/messages CRUD, context assembly + compaction, POST→SSE relay end-to-end on a local provider; minimal full page (rail + thread + real streaming + stop) | Real deltas visible in the browser |
| **2. Hermes** | Streamed spawn, incremental box parser, session mapping, brain picker | A thread resumes as the same Hermes session |
| **3. Capabilities** | Tool broker under caller authority, capabilities panel, knowledge citations | A tool call is attributable to a user |
| **4. Memory** | `assistant_memory` + propose/confirm panel; message feedback → episodic | User can delete a memory and see the effect |
| **5. Roster + drawer** | Hand-off to agent goals + run watching; `@drawer` mount | — |
| **6. Write proposals** | Approvals bridge, proposal cards | **Depends on D14 for execution** |
| **QA** | End-to-end drive + dark theme / a11y / responsive pass | Merge gate |

Per D-D: every phase must run on dev-stage providers. No phase may hard-depend on a production key.

---

## 10. Open questions for the owner

| # | Question | Default if unanswered |
|---|---|---|
| OQ-1 | Thread/message retention and erasure reach — does `eraseTenant` hard-delete assistant data? | Yes, hard-delete; retention unlimited until told otherwise |
| OQ-2 | Does the **client portal** get an assistant? (It is a deliberately separate interface with 4-layer isolation) | **Out** of v1 |
| OQ-3 | Per-user cost ceiling, or only the existing per-tenant gateway budget? | Per-tenant only in v1, per-user meter shown but not enforced |
| OQ-4 | Confirm the assistant may read everything the user can read (e.g. a manager's full team scope) | Yes — Cerbos is authoritative |
| OQ-5 | Voice output (TTS), or input only? | Input only |
| OQ-6 | If Hermes is down, fail the thread loudly or fail over silently to another brain? | Fail over, but **label the reply** with the brain that served it |

---

## 11. Related

- [`docs/superpowers/plans/2026-08-03-agentic-native-erp-plan.md`](../superpowers/plans/2026-08-03-agentic-native-erp-plan.md) — the readiness bar; personas deferred (see D-B)
- [`docs/blueprints/erp-whatsapp-and-agent-runtime-e2e.md`](./erp-whatsapp-and-agent-runtime-e2e.md) — the agent runtime contract this reuses
- [`docs/FRONTEND-BFF-CONTRACT.md`](../FRONTEND-BFF-CONTRACT.md) — add the `assistant/*` endpoints as `PENDING`
- [`docs/modules/MODULES.md`](../modules/MODULES.md) — register module `assistant` at first code
