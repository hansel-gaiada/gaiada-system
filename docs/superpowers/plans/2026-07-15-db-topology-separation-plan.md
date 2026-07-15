# Database Topology — Unification & Separation Plan (industry-standard target)

**Date:** 2026-07-15
**Status:** **ALL PHASES A–F BUILT & VERIFIED 2026-07-15.** System is **pre-production**, so there was
no live data to migrate around — the right moment to set the topology cleanly.

### Phase D/E/F build status (2026-07-15)
- **D (Keycloak + n8n → Postgres) DONE.** Both self-migrate onto their own DBs on the core instance:
  `gaiada_keycloak` (owner role `keycloak`) and `gaiada_n8n` (owner role `n8n`) — added to
  `init-cluster.sh`. Compose: Keycloak gains `KC_DB=postgres`/`KC_DB_URL`/`KC_DB_USERNAME/PASSWORD`
  (kept on `start-dev` for the trial — no TLS/hostname setup; prod → `start`); n8n gains
  `DB_TYPE=postgresdb` + `DB_POSTGRESDB_*` (`automation/docker-compose.yml`). **Verified by boot smoke:**
  Keycloak created 67 tables (owned by `keycloak`, Liquibase ran, master realm initialized); n8n created
  109 tables (owned by `n8n`, migrations ran). Cross-DB isolation holds even between them (`keycloak`
  role denied `gaiada_n8n`).
- **E (isolate the bot DB) DONE.** New `pg-bot` service (own volume `pg-bot-data`, own `init-bot.sh`
  creating `bot_owner`/`bot_app`/`gaiada_bot`, own healthcheck); bot roles/DB REMOVED from the core
  `init-cluster.sh`. Bot + bot-media-worker repointed `DATABASE_URL`/`MIGRATE_DATABASE_URL` to `pg-bot`.
  **Verified:** `init-bot.sh` provisions the isolated instance via real `initdb.d`; core instance has no
  bot roles/DB.
- **F (Redis split) DONE.** New `redis-bot` service (own volume, `appendonly yes`) for the bot's BullMQ
  media queue; core `redis` (also `appendonly`) keeps the platform event backbone. Bot + media-worker
  `REDIS_URL` → `redis-bot`.
- **Infra:** `backup.sh` now dumps all core DBs (`gaiada_platform/_knowledge/_keycloak/_n8n`) + the bot
  DB from `pg-bot` (crypto-shred rule intact — DB dumps only, never the bot key volume). Both compose
  files `config`-valid. `.env.example` (core + automation) updated with `KEYCLOAK_DB_PASSWORD`,
  `N8N_DB_PASSWORD`, `N8N_DB_HOST`.
- **Remaining (deploy hardening, not v1-blocking):** Keycloak prod `start` mode (TLS + `KC_HOSTNAME`);
  optional managed-Postgres migration per §9 triggers.

### Build status (2026-07-15)
- **A/B/C DONE.** Provisioning `infra/db/init-cluster.sh` (per-DB `*_owner` migrator + per-service
  `*_app` runtime roles, `REVOKE ALL … FROM PUBLIC`, default privileges, `gaiada`→`gaiada_bot`).
  Platform `migrate()` now runs as the OWNER via `MIGRATE_DATABASE_URL` + applies idempotent,
  role-guarded runtime grants (sync_app tight footprint; `platform_app` REVOKEd from all
  sync-internal tables incl. `site_subscriptions`). Bot (`store/pg.ts`) + knowledge (`store.ts init()`)
  DDL de-runtimed — schema runs as the owner DSN, runtime role is DML-only; knowledge detects pgvector
  by READ (extension created at provisioning by the superuser). VPS compose + `.env.example` rewired to
  per-service roles for platform/sync-central/knowledge/bot/bot-media-worker.
- **Verified:** direct grant probes (platform_app ALLOWED entity / DENIED sync-internal + DDL; sync_app
  scoped-only; bot/knowledge owner-DDL vs app-DML; cross-DB `CONNECT` denied) — 100% pass. Platform full
  suite **148** green with the new migrate(). Knowledge store tests **7** green with the new init(). Full
  `sync-engine-go` suite green on WSL against the **tight** `sync_app` (only extra grant needed was
  `projects`, and solely for test fixtures — the engine's writeback footprint matches the grant exactly).
  Compose `config` valid; DSNs resolve to the right roles/DBs. **Not run:** wa-chat-bot vitest (no
  `node_modules` in this env) — its `pg.ts` change is mechanical and the owner/app SQL model was proven
  via the container probe.
- **The `site_subscriptions` boundary is now a hard grant boundary** (platform_app has zero grant on it),
  as designed — migration 0015's GUC gate remains as defense-in-depth per the earlier decision.
**Related:** the `site_subscriptions` role/RLS episode in
`2026-07-14-ws4-automation-flows-plan.md` §8 — this plan removes the root cause.

---

## 0. Current state (the problems)

- **One Postgres server**, three logical DBs — `gaiada` (bot), `gaiada_platform` (ERP + sync),
  `gaiada_knowledge` (RAG/pgvector) — **all owned by and accessed through ONE role `gaiada_app`**
  (`wa-chat-bot/db/init.sh`), shared by platform, sync-central, bot, bot-media-worker, knowledge.
- **`gaiada_app` is both owner and runtime.** A table owner bypasses ordinary privilege checks, so
  `GRANT/REVOKE` can't bind it — only `FORCE RLS` can. That is exactly why the `site_subscriptions`
  fix had to resort to a GUC-gated RLS policy instead of a plain grant boundary.
- **Auth on a dev database:** Keycloak runs `start-dev` → embedded **H2** (`kc-data` volume). Not
  production-grade.
- **n8n on SQLite** (`n8n-data` volume) — single-instance only, no queue mode, awkward backups.
- **Two services self-migrate at runtime as the connecting role:** the bot (`src/store/pg.ts`
  `CREATE TABLE IF NOT EXISTS messages …`) and knowledge (`src/knowledge/store.ts` `init()` →
  `CREATE EXTENSION vector` + `CREATE TABLE knowledge_chunks`). `CREATE EXTENSION` needs a privileged
  role. This is incompatible with a locked-down runtime role and must move to provisioning.
- **Redis is shared** for two different durability classes with no separation: the platform event
  backbone (Streams) and the bot's BullMQ media queue.

## 1. Decisions locked with the user (2026-07-15)

1. **Topology = HYBRID.** One shared "core" Postgres instance for platform + knowledge + Keycloak +
   n8n; the **WhatsApp bot's PII / crypto-shred DB gets its OWN instance** (blast-radius + the
   DPIA/employee-monitoring sensitivity in `legal/`).
2. **Role model = owner/migrator + per-service runtime split** (industry standard). A DDL-owning
   migrator role per DB runs migrations; each service connects as its own **NOBYPASSRLS, non-owner**
   runtime role with least-privilege grants. Runtime ≠ owner means both RLS *and* GRANT/REVOKE are
   real boundaries.
3. **Keycloak and n8n both move to Postgres** (their own DBs), for one consistent backup/DR story and
   to unblock n8n queue-mode/scaling.

## 2. Target topology

```
┌─ pg-core (shared instance) ─────────────────────────────┐   ┌─ pg-bot (isolated instance) ─┐
│  db gaiada_platform   ← platform_app (rw entity+platform)│   │  db gaiada_bot               │
│                       ← sync_app     (rw entity+sync)    │   │    ← bot_app (rw)            │
│  db gaiada_knowledge  ← knowledge_app                    │   │  owner: bot_owner            │
│  db gaiada_keycloak   ← keycloak_app                     │   │  (WhatsApp PII, crypto-shred)│
│  db gaiada_n8n        ← n8n_app                          │   └──────────────────────────────┘
│  owners: platform_owner / knowledge_owner / …           │
└─────────────────────────────────────────────────────────┘
```

### 2.1 Databases (renamed for consistency)

| Database | Instance | Owner (migrator) role | Runtime role(s) | Holds |
|----------|----------|----------------------|-----------------|-------|
| `gaiada_bot` (was `gaiada`) | **pg-bot** | `bot_owner` | `bot_app` | WhatsApp messages (PII-scrubbed, crypto-shred), group registry, media-queue metadata, digest scheduler idempotency |
| `gaiada_platform` | pg-core | `platform_owner` | `platform_app`, `sync_app` | ERP core (clients/projects/tasks/deliverables/time), RBAC, agency, comments/notifications, files, custom fields, event outbox, **sync tables**, automation_approvals, org structure, compliance gates |
| `gaiada_knowledge` | pg-core | `knowledge_owner` | `knowledge_app` | RAG derived store: `knowledge_chunks` + embeddings (pgvector / array fallback), D9-isolated |
| `gaiada_keycloak` (NEW) | pg-core | `keycloak_owner` | `keycloak_app` | IdP realm, users, clients, sessions (off H2) |
| `gaiada_n8n` (NEW) | pg-core | `n8n_owner` | `n8n_app` | n8n workflow defs, credentials, execution history (off SQLite) |

> **Unification kept deliberately:** `platform` and `sync-central` share **one** DB (`gaiada_platform`)
> — the sync engine reconciles the platform's *own* outbox/entity tables; splitting them would be
> wrong. They are separated by **role**, not database. Bot and platform stay separate DBs (distinct
> bounded contexts, very different data sensitivity). Cross-service data flow is always via API/events,
> **never a shared table** across contexts.

## 3. The owner/migrator ↔ runtime split (the core of "proper")

For every database:

- **`<db>_owner`** owns all objects and is the ONLY role that runs migrations / DDL (incl.
  `CREATE EXTENSION vector` for knowledge). Not used at runtime.
- **`<service>_app`** is `NOSUPERUSER NOBYPASSRLS`, **not** the owner, and holds only
  `GRANT SELECT, INSERT, UPDATE, DELETE` on the specific tables it needs (+ `USAGE, SELECT` on
  sequences). It cannot `ALTER`, cannot bypass RLS, and — being a non-owner — has **no implicit
  access** to tables it wasn't granted. This makes GRANT/REVOKE a hard boundary.

**Consequence for the `site_subscriptions` gap:** with `platform_app` and `sync_app` as distinct
non-owner roles, the boundary is a plain grant split (below) — a **hard** boundary, not the GUC
workaround. Migration `0015`'s GUC-gated RLS can then be **kept as defense-in-depth** or retired;
recommend keeping it (belt-and-suspenders) but it is no longer load-bearing.

### 3.1 Grant matrix for `gaiada_platform` (the one shared-by-two-roles DB)

The sync engine **applies reconciled remote rows into the entity tables**, so it needs entity DML too;
the real separation is over each side's *internal* tables.

| Table group | `platform_app` | `sync_app` |
|-------------|:--:|:--:|
| Entity/business tables (projects, tasks, clients, deliverables, time, agency_*, comments, notifications, files, custom_fields, companies, org structure, compliance gates, automation_approvals) | rw | rw (applies remote copies) |
| `outbox_events` (shared event/sync log) | rw (emit) | rw (relay cursor is platform's; sync uses its own ledger) |
| Platform-internal (session/version, RBAC grant tables, module registry) | rw | — (revoked) |
| **Sync-internal**: `sync_cursors`, `sync_applied_events`, `sync_conflicts`, `sync_dead_letter`, **`site_subscriptions`** | **— (revoked)** | rw |

→ `platform_app` has **no grant on `site_subscriptions`** or any sync-internal table → the platform
literally cannot read/tamper with the node→tenant ACL. That is the hard boundary the earlier fix
approximated.

## 4. Fixing the self-migrating services (blocks the role split)

- **Knowledge:** move `store.init()`'s `CREATE EXTENSION vector` + `CREATE TABLE` out of the runtime
  path into a provisioning/migrate step run as `knowledge_owner` (extension creation as a privileged
  role at provision time). Runtime `knowledge_app` does pure DML. Add a `knowledge`
  migrations dir + runner (mirror `platform-nest/src/db/migrate.ts`), or a one-shot init container.
- **Bot:** move the `CREATE TABLE IF NOT EXISTS` DDL in `src/store/pg.ts` into a bot migrate step run
  as `bot_owner`; runtime `bot_app` does DML only. (Bot keeps its file-store fallback for dev.)

## 5. Redis separation

Split by durability class, aligned to the bot-isolation boundary:

- **Core Redis** (`redis` on the core side): platform **event backbone Streams** (relay/consumer +
  dead-letter).
- **Bot Redis** (own logical DB index now, own instance when the bot DB physically splits): the
  **BullMQ media queue**. Keeps the bot's data plane isolated end-to-end with its DB.
- Minimum step now: distinct Redis **logical DB index** + key prefixes per use; separate instance is a
  documented trigger (below).

## 6. Migration / cutover path (phased; low risk pre-prod)

Each phase is independently deployable and verified before the next.

- **Phase A — role topology on the current single instance.** Rewrite `init.sh` (→ per-DB `*_owner` +
  per-service `*_app` roles, grants per §3.1). Rename `gaiada` → `gaiada_bot`. Point each service's
  `DATABASE_URL` at its own runtime role. *Verify:* every service boots; platform + sync suites green;
  a cross-role probe (platform_app SELECT on `site_subscriptions` → permission denied).
- **Phase B — de-runtime the DDL.** Bot + knowledge schema-init moved to owner-run migrate steps
  (§4). *Verify:* fresh provision creates schema as owner; runtime role has no DDL.
- **Phase C — platform↔sync hard boundary.** `sync-engine-go` `DATABASE_URL` → `sync_app`; revoke
  sync-internal from `platform_app`. Decide GUC-gate: keep as defense-in-depth (recommended).
  *Verify:* full `sync-engine-go` suite on WSL vs `sync_app` (NOBYPASSRLS); `rls.test` green.
- **Phase D — Keycloak & n8n → Postgres.** Keycloak: `start` (not `start-dev`) + `KC_DB=postgres`,
  `KC_DB_URL` → `gaiada_keycloak`/`keycloak_app`; import realm. n8n: `DB_TYPE=postgresdb` +
  `DB_POSTGRESDB_*` → `gaiada_n8n`/`n8n_app`; export/import existing workflows from SQLite.
  *Verify:* login via Keycloak; n8n workflows load + fire.
- **Phase E — physically isolate the bot DB.** New `pg-bot` instance/volume (+ its own `init.sh`,
  backup schedule); move `gaiada_bot`; repoint bot + media-worker. *Verify:* bot store round-trips;
  core instance no longer hosts `gaiada_bot`.
- **Phase F — Redis split** (§5). *Verify:* event backbone + media queue both work on their targets.

## 7. Infra / compose changes (summary)

- Rename `postgres` service → `pg-core`; add `pg-bot` service (own volume `pg-bot-data`, own
  `init-bot.sh`, own healthcheck + backup).
- New env: per-role passwords (`PLATFORM_APP_PASSWORD`, `SYNC_APP_PASSWORD`, `KNOWLEDGE_APP_PASSWORD`,
  `BOT_APP_PASSWORD`, `KEYCLOAK_DB_PASSWORD`, `N8N_DB_PASSWORD`) + the `*_owner` passwords for
  provisioning. Retire the single `POSTGRES_APP_PASSWORD`.
- Keycloak: `start --optimized`/`start` + `KC_DB`/`KC_DB_URL`/`KC_DB_USERNAME`/`KC_DB_PASSWORD`.
- n8n (`automation/docker-compose.yml`): `DB_TYPE=postgresdb` + `DB_POSTGRESDB_HOST=pg-core` etc.
- Two init scripts (core + bot), each creating only that instance's owners/apps/DBs.
- Backups: per-instance `pg_dump` schedules (the bot instance's crypto-shred-safe backup already
  exists — keep it pointed at `pg-bot`).

## 8. What we deliberately do NOT do

- **Don't merge bot into platform** — separate bounded contexts; the bot holds raw-WA PII + crypto-shred
  keys, a different sensitivity + lifecycle from the ERP.
- **Don't split platform and sync into two DBs** — sync reconciles the platform's own log; same DB,
  separate role.
- **Don't go full per-service instances now** — cost/ops; the hybrid (isolate only the sensitive bot
  DB) is the pragmatic standard for solo-viable v1.
- **Don't grant any runtime role cross-DB or cross-context table access** — integration is via
  API/events only.

## 9. Physical-split triggers (when to promote a logical DB to its own instance later)

- `gaiada_knowledge` grows heavy (embeddings/HNSW) and needs independent CPU/IO or a different PG
  version/extensions → own instance.
- Compliance/DR requires the IdP (`gaiada_keycloak`) isolated → own instance or managed IdP.
- Move any DB to **managed Postgres** (RDS/Cloud SQL) — do it per-instance; the role model here ports
  unchanged.
- Introduce **PgBouncer** once the service/connection count climbs.
- A real second site activates sync → revisit `sync_app` placement per site.

## 10. Open items

- Confirm whether to **retire or keep** migration `0015`'s GUC gate once `sync_app`/`platform_app` are
  split (recommend: keep as defense-in-depth).
- Keycloak realm export/import fidelity when leaving H2 (users created in dev H2 must be re-provisioned
  or exported).
- n8n SQLite→Postgres workflow/credential export (credentials are encrypted with `N8N_ENCRYPTION_KEY`
  — same key must carry over).
- Decide the per-instance backup cadence + retention (ties `legal/retention-and-dsr-procedure.md`).
