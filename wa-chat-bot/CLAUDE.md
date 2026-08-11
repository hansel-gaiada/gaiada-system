# CLAUDE.md — wa-chat-bot

Scope: `wa-chat-bot/` — the **chat surface** (WhatsApp via WAHA, Telegram as fallback). Root
`../CLAUDE.md` has program rules; `README.md` here has the run quickstart.

```
npm ci && npm run typecheck && npm test    # vitest
npm run dev            # tsx watch src/server.ts
npm run media-worker   # the dedicated media queue worker (separate process, on purpose)
npm run gateway        # local gateway shim (src/gateway/) — dev only
docker compose --profile db up -d          # Postgres (app role NOBYPASSRLS)
docker compose --profile queue up -d       # Redis / BullMQ
docker compose --profile kms up -d         # OpenBao
docker compose up -d waha                  # WAHA lives in this same compose file
```

Profiles are opt-in per dependency; WAHA has none, so a bare `up -d` starts it.

## Two invariants this service exists to respect

1. **The bot never holds a provider key.** All model calls go through the Gateway
   (`src/llm.ts`). If a completion fails, debug the Gateway seam, not a credential here.
2. **The bot never asserts identity.** `src/principal.ts` presents a named service identity and
   the platform/hub resolves the principal. Roles are never claimed client-side.

## The pipeline (fail-closed at the door)

webhook (**fail-closed**) → group registry (a `groups.yaml` in the bot's data dir, hot-reload;
template `config/groups.example.yaml`, and each test fixture has its own under `data/`) →
**PAN/KTP scrub
before persist** (`src/scrub.ts`) → crypto-shred store (file or Postgres with FORCE RLS) →
skills / Q&A reply. Digests at 12:00 / 18:00 (opt-in groups + categorized management), with
map-reduce for long windows. Media: pending queue → worker → Gateway `/media` → **scrubbed**
`media_text` → digests.

Scrub-before-persist is not a formality: it is the day-one gate, and `legal/` Gate 1 must be green
before any real employee data is ingested at all.

`src/surface.ts` + `surface.guard.test.ts` keep WhatsApp and Telegram behaviour from diverging —
add a capability to the surface abstraction, not to one transport.

## Operational realities

- **WAHA engine is pinned to NOWEB.** Changing engines changes session storage and re-pairing
  semantics; don't switch it casually.
- The live number needs a **QR pairing**, which is a human step and has repeatedly been the
  blocker. Telegram long-polling needs no public URL and is the surface to develop against.
- WAHA has been fully free since 2026.6.1 (former Plus features in core), so media + multi-session
  warm standby cost nothing to exercise.
- Runbooks for the two scenarios that matter: erasure-divestiture, wa-ban-recovery.
- `waha-admin.ts` / `admin-*.test.ts` back the bot admin console the UI proxies to.

## Tests

`vitest`; `phase1/phase2/phase5a.e2e.test.ts` are the end-to-end tiers. A green suite here does
**not** mean the live surface works — the recurring failure has been a scripted test passing while
a real inbound message took a different path. Drive the real surface before claiming DEV-VERIFIED.
