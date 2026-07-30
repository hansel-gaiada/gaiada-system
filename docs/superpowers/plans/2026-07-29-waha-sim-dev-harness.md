# WAHA simulator — dev harness so the real number is non-blocking (2026-07-29)

Frozen contract for an `/army` build. Companion to `2026-07-29-wa-operability-hardening.md` —
that plan makes the WhatsApp path *correct*; this one makes it *buildable and verifiable without
touching the real number*.

## Why this exists

On 2026-07-29 the one real WhatsApp number became unpairable: creds cleared, Baileys logged
`not logged in, attempting registration...` → `Error: Connection Failure`, retrying every ~2s, and
WhatsApp refused the registration handshake so no QR was ever issued. Diagnosis (see the comment
above the `waha` service in `docker-compose.vps.yml`): an upstream WhatsApp-side throttle on the
number or egress IP, most likely earned by a ~2s reconnect storm during a Docker Desktop outage.
Image version was ruled out — `noweb-2026.7.1` was tested and behaved identically.

The remedy is to **wait it out with the session STOPPED** (retrying extends the throttle). That is
an open-ended wait, and it currently blocks: verifying the hardening work, building any new
WhatsApp feature, and demoing the ERP's WhatsApp surface.

**Owner decision (2026-07-29): the real number is out of the loop until it recovers. Development
continues against a simulator.** Everything stays on localhost / Docker / WSL — outside hosting is
non-negotiably off the table for now.

---

## ⚠️ GO-LIVE TEARDOWN — READ BEFORE PRODUCTION

**Everything in this document is dev scaffolding. None of it ships.** At go-live the simulator is
switched OFF and a real, warmed number takes over with the full safety set. Explicit owner
instruction, recorded here so it cannot be forgotten.

### Teardown checklist (all items required)

- [ ] `waha-sim` service removed from every compose overlay; image deleted; its volume pruned.
- [ ] `WAHA_URL` on every bot/worker instance points at the real `waha` service. No env anywhere
      still references the sim host, port, or API key.
- [ ] `SIM_MODE` (or equivalent) is **absent**, and the boot guard below has been exercised —
      the bot must refuse to start if a sim URL is configured outside dev.
- [ ] `_sim/*` driver routes are unreachable (the whole container is gone, so this is automatic —
      verify anyway).
- [ ] The **conformance checklist** (§7) has been re-run against real WAHA and every assumption is
      either confirmed or has a filed fix. Sim-verified behaviour is NOT production-verified.
- [ ] `docs/modules/MODULES.md` status moves from **PROTOTYPED** to **DEV-VERIFIED** only for what
      real WAHA actually confirmed.
- [ ] Fixture corpus (§4) refreshed from real traffic and any drift from the sim's assumptions
      written up.

### The safety set that must be live before the real number reconnects

The throttle was earned by our own retry behaviour. Do not reconnect a warmed number into an
unhardened stack — that repeats the incident on a fresh number.

- [ ] **Bounded reconnect with backoff** + terminal "operator action needed" state (hardening
      plan, Agent C item 1). This is the direct fix for the ban vector. Non-negotiable.
- [ ] **Transient-vs-credential distinction** so an invalidated session is never retried into a
      ban (Agent C item 2).
- [ ] **Global outbound ceiling** across all chats and surfaces (Agent B item 3).
- [ ] **Reply-path rate limit** + loop guard (Agent B items 1–2).
- [ ] **Kill switch verified across every outbound path** including digests, Q&A and media
      (Agent B item 4).
- [ ] **Out-of-band watchdog actually scheduled** and proven to fire (Agent D item 1) — the
      incident went unnoticed for hours.
- [ ] **`waha-sessions` volume in the nightly backup** — DONE 2026-07-29 in
      `infra/scripts/backup.sh` (`waha_sessions()`); confirm a restore drill has been run.
- [ ] Session STOPPED-by-default on first boot after the swap, so nothing auto-storms.

### Number warm-up protocol (before it becomes primary)

A brand-new number driven immediately by automation is the classic ban shape. For the warmed
number and any future standby:

1. Use the number as a **human** on a phone for days before any automation touches it — real
   two-way conversations, joined groups, a profile photo and name.
2. First automated contact only with **numbers that already messaged us** — never cold outbound.
3. Ramp outbound volume gradually; keep the global ceiling low at first and raise it deliberately.
4. Never bulk-add to groups, never broadcast, never message a number that has not opted in.
5. Keep egress IP stable and not shared with anything else that talks to WhatsApp.
6. Prefer STOPPED over retrying whenever the session is unhealthy. Waiting is always cheaper than
   a throttle.

**Longer-term:** for anything client-facing where a multi-day outage or a number ban is
unacceptable, the official Meta WhatsApp Cloud API is the only option without permanent ban risk.
Unofficial Baileys-based stacks (WAHA, Evolution API, WPPConnect — all the same protocol layer)
carry that risk structurally; no amount of hardening removes it. Not a v1 decision, but it belongs
in the record.

---

## 1. Scope

**In:** a `waha-sim` container that speaks the WAHA HTTP surface this codebase actually calls,
fires realistic webhooks, serves media, models the session FSM including failure modes, and
exposes a driver API for tests and demos.

**Out (do not build):**
- Telegram simulation. Telegram is the live surface and works today; adding it roughly doubles the
  endpoint surface for no current unblock. Revisit only if fallback switchover needs testing.
- Anything in the hardening plan's "known-broken, out of scope" list: passwordless dev-login, role
  self-escalation, `AUTH_MODE=hybrid`, ingesting real data before the legal gate, `keys.json`
  custody.
- Any change to the real `waha` service beyond leaving its session STOPPED. **Do not bump the
  image on a hunch** — `noweb-2026.7.1` was tested and ruled out.

## 2. Non-negotiables

- **The real number stays untouched.** Never start, stop, logout or re-pair the real session.
  Never send a real WhatsApp message. The real `waha` service keeps its pinned
  `devlikeapro/waha:noweb-2026.6.2` image and its STOPPED session.
- **The sim must be impossible to reach from a production path.** It lives in the local dev
  overlay only — never in `docker-compose.vps.yml`. Loopback-bound. Its own API key, distinct from
  `WAHA_API_KEY`.
- **Boot guard:** the bot refuses to start when a sim URL is configured without an explicit dev
  flag. Fail closed, loud, at boot — not a warning in a log nobody reads.
- **Never widen the PII surface.** The sim's fixtures and driver payloads are synthetic. No real
  message text, phone numbers, or client identifiers in fixtures, logs or committed files.
- **Fail-soft parity:** the bot's existing behaviour when WAHA is unreachable must not regress.
  The sim being down is the same as WAHA being down.
- Tests are part of done. `wa-chat-bot`: `npm test` (408 passing — keep every one) +
  `npm run typecheck`. `platform-ui`: `npx vitest run src/components/systems/` + `npx tsc --noEmit`.
- Use ABSOLUTE paths for Write/Edit. Run commands with the PowerShell tool from the project dir.

## 3. The endpoint contract

Derived by reading the two call sites — this is the complete set, nothing more is needed.

### Messaging (`wa-chat-bot/src/waha.ts`, `WahaGateway`)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/sendText` | body `{session, chatId, text, reply_to?}` |
| POST | `/api/sendImage` | body `{session, chatId, file:{mimetype,url?,data?,filename?}, caption?}` |
| POST | `/api/sendVoice` | same shape |
| POST | `/api/sendFile` | same shape |
| PUT | `/api/reaction` | body `{session, messageId, reaction}` |
| POST | `/api/startTyping` / `/api/stopTyping` | body `{session, chatId}` |
| POST | `/api/{session}/groups/{chatId}/participants/add` \| `/remove` | body `{participants:[…]}` |
| POST | `/api/{session}/groups/{chatId}/admin/promote` \| `/demote` | body `{participants:[…]}` |
| PUT | `/api/{session}/groups/{chatId}/subject` | body `{subject}` |
| GET | `/api/{session}/groups/{chatId}/invite-code` | |

`pin` is `unsupported()` in the adapter — the sim does not need it.

Auth: `X-Api-Key` header. Every send is recorded in an inspectable outbox (see §5).

### Session lifecycle (`wa-chat-bot/src/waha-admin.ts`)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/sessions/{s}` | → `{status, engine, me:{id,pushName}}`; **404 when the session was never created** (the adapter maps 404 → `STOPPED`) |
| POST | `/api/sessions` | body `{name, start, config:{noweb:{store:{enabled,fullSync}}}}`; must **409 or 422** when it already exists, so the adapter's `/start` fallback is exercised |
| POST | `/api/sessions/{s}/start` \| `/stop` \| `/logout` \| `/restart` | `/restart` should be answerable with 404/405 in one sim mode so the stop→start fallback path gets covered |
| GET | `/api/{s}/auth/qr?format=image` | returns a real PNG when in `SCAN_QR_CODE`, else 4xx (adapter maps to `{qr:null,status}`) |

Status strings pass through verbatim and must use WAHA's real vocabulary:
`STOPPED | STARTING | SCAN_QR_CODE | WORKING | FAILED`.

### Media serving

Inbound fixtures reference `media.url`. The sim serves those files over HTTP so the media worker →
gateway → whisper path runs for real. Cover at least: voice note (ogg/opus), image (jpeg), PDF,
and a URL that 404s (the worker must record an observable failure, not crash).

### Outbound webhook

POSTs to `WHATSAPP_HOOK_URL` (`http://bot:3001/webhook?token=…`) with `{event, payload}` for
`event ∈ {message, session.status}` — matching `WHATSAPP_HOOK_EVENTS` in compose.

**Retry semantics matter.** Real WAHA retries aggressively on non-200; the sim must too, because
Agent A's persist-then-ACK work is specifically about surviving that. Make the retry
policy configurable so a "webhook storm" can be driven deliberately.

## 4. Fixture rules — the anti-fiction guard

The failure mode of a simulator is that it becomes a convincing fiction and the team "shows
progress" against behaviour real WAHA never had. Two hard rules:

1. **Every payload the sim emits comes from a checked-in fixture file.** The sim never invents an
   envelope shape. Fixtures live in one directory, one file per scenario, and are the reviewable
   artifact.
2. **Fixtures must cover the engine-variance the code already defends against** — these were hard
   won and must not silently rot:
   - All five `@mention` locations `extractMentions` probes: `mentionedIds`, `mentions`,
     `_data.mentionedJidList`,
     `_data.message.extendedTextMessage.contextInfo.mentionedJid`, `_data.contextInfo.mentionedJid`.
   - Both reply-to-bot shapes: `_data.quotedMsg.fromMe` (WEBJS) and `replyTo.fromMe` (NOWEB).
   - `hasMedia` vs `media` present; `media.url` empty (WAHA served no file).
   - Sender-name variance: `notifyName`, `_data.notifyName`, `_data.pushName`.
   - System chats that must be dropped: `status@broadcast`, `*@broadcast`, `*@newsletter`.
   - Group (`@g.us`) and DM (`@c.us`) chat ids; `fromMe: true`.
   - Missing/absent `id` (rows legitimately have no `wa_message_id` — Agent A's nullable-safe
     unique index depends on this case existing).

Source fixtures from WAHA's documented payloads and the existing test stubs. Where a shape is
**assumed rather than observed**, mark it in the fixture file and add it to §7.

## 5. Driver API (`/_sim/*`)

The reason this is worth building — deterministic control of scenarios that are otherwise
unreachable.

| Endpoint | Purpose |
|---|---|
| `POST /_sim/inbound` | inject a message from a named fixture (+ overrides for chat/sender) |
| `POST /_sim/session/{state}` | force the FSM to any state, including `FAILED` |
| `POST /_sim/incident/connection-failure` | **replay 2026-07-29**: creds cleared, registration refused, no QR ever issued. The scenario Agent C's backoff work must be tested against |
| `POST /_sim/flood` | N messages in a window — drives Agent B's rate limit |
| `POST /_sim/loop` | repeated near-identical text / our own replies echoed back — drives the loop guard |
| `GET /_sim/outbox` | every send the bot made, for assertions and for eyeballing a demo |
| `POST /_sim/reset` | clear state between tests |
| `POST /_sim/webhook-storm` | duplicate deliveries + non-200 retries — drives Agent A's dedup and persist-then-ACK |

## 6. What this unlocks (the feature-decision surface)

The owner's stated goal is to review the build and decide feature additions. With the sim, these
move from untestable to demoable:

1. **Media pipeline end to end** — voice/image → worker → gateway → whisper → scrubbed
   `media_text` → digest.
2. **Digests** — 12:00/18:00 sweeps, opt-in groups, categorized management digest, per-group
   watermark resume after a mid-sweep crash.
3. **Group registry + admin actions** — add/remove/promote/demote/subject/invite-code, and the
   ERP's Group Registry surface writing `groups.yaml`.
4. **Multi-session warm standby (hardening item 5)** — the sim can host two sessions, so failover
   logic is *buildable and testable now*. Only the physical SIM swap remains at go-live. This is
   the biggest single unblock.
5. **ERP WhatsApp Connect UI** — a real (fake) QR PNG makes `WhatsAppConnect.tsx` and
   `StatusCard.tsx` genuinely demoable instead of placeholder.
6. **Reactions, typing, the numbered-button confirmation FSM** — all outbound paths exercised
   against a real HTTP surface.
7. **Session resilience** — backoff sequences, terminal states, ingestion-stall detection, and the
   transient-vs-credential distinction, all deterministic.

## 7. Conformance checklist (re-run against real WAHA at go-live)

A living list, maintained by whoever builds the sim. Every entry is a behaviour the sim
**assumes**. Start with at least:

- [ ] `POST /api/sessions` really returns 409/422 (not 400/500) when the session exists.
- [ ] `GET /api/sessions/{s}` really 404s for a never-created session.
- [ ] `/restart` exists on `noweb-2026.6.2` (or the stop→start fallback is the real path).
- [ ] QR endpoint's exact non-`SCAN_QR_CODE` status codes.
- [ ] Webhook retry count, interval and backoff on non-200.
- [ ] Whether `session.status` fires for every transition or only some.
- [ ] Media URL lifetime and auth requirements.
- [ ] Group endpoint response shapes (the adapter returns the raw body as `ref`).
- [ ] Reaction on NOWEB — does `PUT /api/reaction` succeed without a `chatId`?
- [ ] Which mention field NOWEB actually populates in practice.

**Status language:** everything verified only against the sim is **PROTOTYPED** in
`docs/modules/MODULES.md`. It becomes **DEV-VERIFIED** only after the corresponding conformance
item is confirmed against real WAHA. Do not blur this — it is the whole point of the checklist.

## 8. Lane ownership

| Agent | Owns (exclusive) |
|---|---|
| **S1 — sim service** | `waha-sim/**` (new project: server, FSM, endpoint surface, media serving, webhook emitter, retry policy) |
| **S2 — fixtures + driver** | `waha-sim/fixtures/**`, the `/_sim/*` driver routes, and the conformance checklist doc |
| **S3 — wiring + guards** | `infra/compose/docker-compose.local.yml` (sim service, loopback, own key), `wa-chat-bot/src/config.ts` (APPEND keys only — never reorder or change existing defaults), the fail-closed boot guard |
| **S4 — scenario tests** | new test files only, driving the sim: incident replay, flood, loop, webhook storm, media paths, digest sweep |

Shared-file rules: only **S3** touches compose and `config.ts`. **S1** and **S2** must not edit
`wa-chat-bot/**` — if the bot needs a change, S3 makes it. S4 adds test files only, never
production source.

## 9. Definition of done

- `waha-sim` runs in the local overlay; `docker compose … up -d` brings up a bot that reaches it.
- The 2026-07-29 incident replays deterministically and the bot's response is observable.
- All three suites green, including the existing 408 bot tests.
- The real `waha` service is untouched and its session still STOPPED.
- Boot guard proven: a sim URL without the dev flag refuses to start.
- Conformance checklist committed with every assumption listed.
- `docs/modules/MODULES.md` + `CHANGELOG.md` updated, `waha-sim` at **PROTOTYPED**.
- **This document's go-live teardown section is linked from the WhatsApp operations runbook** so
  the scaffolding cannot be forgotten at cutover.
