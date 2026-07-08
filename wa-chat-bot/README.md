# Gaiada WhatsApp Bot — Trial Skeleton

A lean, runnable starting point: it reads work-group messages via WhatsApp, scrubs sensitive
identifiers, stores them, and answers questions / posts project-status digests using a free AI model.

> **Status:** production-grade ingestion/enrichment (P5a) **plus** a verified-only **action agent**
> (phases A–G: safety foundation → rich I/O → action framework → business writes → LLM intent →
> group admin → hardening). It now *does* real, authorized things in chats, not just read/answer.
> **Still gated on the legal check before real/regulated data ingestion** (see `../legal/`), and the
> action layer's live end-to-end verification needs the full stack up — see
> `../docs/superpowers/plans/2026-07-05-action-agent-phase-G-readiness.md`.

## What it does today

- Receives WhatsApp messages (via WAHA) on a webhook.
- **Group registry**: copy `config/groups.example.yaml` to `config/groups.yaml` to monitor only
  listed groups (hot-reloads). Unlisted groups are logged once and dropped. Without the file,
  every group the bot is in is monitored (trial mode).
- **Scrubs** card numbers (PAN) and labelled national IDs (KTP) before storing.
- Stores messages (sender identity encrypted) to a JSON file, or Postgres when `DATABASE_URL` is set.
- Responds when addressed: in a group via `/command`, `@bot`, or replying to the bot; in a DM always.
- Commands (pluggable skills): `/ping`, `/help`, `/summarize`, `/capture <note>` + `/captures`
  (private quick notes), `/actions` (action items from the chat incl. transcribed media).
- **Real actions (write) — verified-only, confirm-before-execute.** Beyond reading/answering,
  the bot performs authorized mutations: business writes (`/task create|assign|complete`,
  `/project create`) via the platform (Cerbos + RLS + audit), and group administration
  (`/group remove|promote|rename|pin`) via the chat surface. Natural language works too
  ("mark task X done") — it proposes the action; you confirm before anything runs. Every action
  is authorized (unlinked/unverified → step-up), confirmed (button or reply), rate-limited,
  idempotent, and written to an append-only audit; a runtime kill-switch
  (`POST /admin/actions/off`) disables all writes instantly. Design:
  `../docs/superpowers/specs/2026-07-05-wa-bot-action-agent-design.md`; incident response:
  `docs/runbooks/action-incident.md`; go-live checks:
  `../docs/superpowers/plans/2026-07-05-action-agent-phase-G-readiness.md`.
- **Telegram fallback**: set `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` and the same bot
  serves Telegram too (official API — no ban risk). See `docs/runbooks/wa-ban-recovery.md`.
- Q&A: mention `@bot` or DM a work question → answered from that chat's history + general knowledge.
- Digests at 12:00 & 18:00 (Asia/Singapore): opt-in groups get their own; the management group
  gets a combined digest grouped by category. `POST /digest/:chatId` triggers one manually.
- **Media enrichment**: voice notes are transcribed, images described (incl. visible text), PDFs
  extracted — via the Gateway, scrubbed before storing, and fed into digests. Since WAHA
  **2026.6.1 media download is free in core** (all former Plus features are), so this works
  out of the box; an unserved file is stored with a visible note instead of failing silently.

## Quickstart: run it on Telegram TODAY (no WAHA, no public URL, free)

Telegram is currently the primary live surface (WhatsApp/WAHA becomes primary once its number
is set up; Telegram then stays as the fallback). The bot long-polls Telegram, so it runs on any
machine with internet — no Docker, no webhook, no tunnel:

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token.
   Optionally `/setprivacy` → **Disable** so the bot can read group messages.
2. `cp .env.example .env`; set `TELEGRAM_BOT_TOKEN=<token>`, a random `GATEWAY_TOKEN`,
   and leave `TELEGRAM_WEBHOOK_SECRET` empty (empty = long-polling mode).
3. Two terminals: `npm run gateway` (or the standalone `../ai-gateway`) and `npm start`.
4. DM your bot "hello" → it replies (echo mode without a Gemini key; real AI with one).
   Add it to a test group and try `/ping`, `/summarize`, `/capture buy cement`, `/actions`.
5. Group ids show up in the logs as `tg:-100...` — add them to `config/groups.yaml` to
   monitor them, and set `MANAGEMENT_GROUP_ID=tg:-100...` to receive digests on Telegram.

## Prerequisites

- Node 20+ (tested on 22), npm.
- Docker (to run WAHA).
- A spare, warmed-up WhatsApp number.
- (Optional now) a free Gemini API key — without it the bot runs in **echo mode** so you can test the plumbing first.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env
npm test                  # unit tests (no network needed)
```

### 1. Run WAHA (the WhatsApp gateway)

First set a `WEBHOOK_SECRET` in `.env` (any random string). The webhook is **fail-closed** — it
rejects every event unless the secret matches; the compose file injects it into the hook URL:

```bash
docker compose up -d     # uses docker-compose.yml here; reads WEBHOOK_SECRET from .env
```

Then open http://localhost:3000, start the `default` session, and **scan the QR code** with your
spare WhatsApp number. The session persists in a Docker volume, so you scan only once.

### 1b. Postgres store (optional — recommended on the VPS)

Without `DATABASE_URL` the bot uses a local JSON file. To run Postgres alongside WAHA
(same compose file; free, self-hosted, data stays on your box):

```bash
# set POSTGRES_SUPER_PASSWORD and POSTGRES_APP_PASSWORD in .env first
docker compose --profile db up -d
```

First boot creates a `gaiada_app` role (`NOSUPERUSER NOBYPASSRLS` — RLS is enforced on it;
never connect the bot as `postgres`). Then set in `.env`:

```bash
DATABASE_URL=postgres://gaiada_app:<POSTGRES_APP_PASSWORD>@localhost:5433/gaiada
```

Backups: `docker exec gaiada-postgres pg_dump -U postgres gaiada > backup.sql` (nightly cron).
Never back up `data/keys.json` into the same set — that's what keeps crypto-shred real.

### 2. Get a free AI key (optional but recommended)

Create a key at https://aistudio.google.com/app/apikey and put it in `.env` as `GEMINI_API_KEY`.
Leave it blank to run in echo mode first.

### 3. Run the Gateway + the bot (two processes)

The **Gateway** holds the AI key; the **bot** holds none and calls the Gateway. Set a
`GATEWAY_TOKEN` in `.env` (any random string), then in two terminals:

```bash
npm run gateway   # AI egress service on :3002 (holds GEMINI_API_KEY)
npm start         # the bot on :3001 (or: npm run dev)
```

You should see `Gaiada WA bot on :3001`. Health check: http://localhost:3001/health

### 4. Try it

- Add the bot's WhatsApp number to a test group (or DM it).
- DM it "hello" → it replies. In a group, send `/ping` → `pong`.
- Send a few messages, then `/summarize` → a project-status digest.
- `@bot what did we decide about X?` → an answer from the group's history.

## Trial simplifications (to harden later)

| Now (trial) | Harden to (see specs/plans) |
|---|---|
| Plaintext JSON file store | Managed Postgres + per-subject/per-entity **crypto-shred** encryption |
| Gemini key in the bot | Route all AI through the **Gateway** (no keys in the bot, DLP, failover) |
| Free AI tier | Paid tier with DPA + no-training, or local model, for real data |
| Manual `/digest` route | Scheduler at 12:00 & 18:00 GMT+8 |
| Bot resolves sender loosely | Platform-minted principal + assurance tiers (bot never asserts identity) |
| Context-aware KTP + basic PAN scrub | Fuller sensitive-data scrubber |
| Single process, single tenant | Multi-tenant + RLS, monorepo, observability |

## Project layout

```
src/
  config.ts       env/config
  scrub.ts        PAN/KTP redaction (tested)
  waha.ts         WhatsApp gateway adapter + normalize (tested)
  store.ts        file-backed message store + retention purge
  llm.ts          Gemini client (echo mode if no key)
  summarize.ts    digest + Q&A prompts
  bot.ts          scrub -> store -> (if addressed) reply (tested)
  server.ts       Fastify webhook + manual digest route
```
