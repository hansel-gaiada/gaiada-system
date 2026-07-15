# Runbook — DB topology cutover (single shared role → per-service roles + split instances)

Moves a running stack from the OLD model (one `gaiada_app` role; `gaiada`/`gaiada_platform`/
`gaiada_knowledge` on one instance; Keycloak on H2; n8n on SQLite) to the topology in
`docs/superpowers/plans/2026-07-15-db-topology-separation-plan.md`:

- **core** Postgres: `gaiada_platform`, `gaiada_knowledge`, `gaiada_keycloak`, `gaiada_n8n` — each with
  an owner/migrator role + a restricted runtime role.
- **pg-bot** (new isolated instance): `gaiada_bot` (renamed from `gaiada`).
- **redis** (platform events) + **redis-bot** (bot BullMQ) split.

**Why a cutover (not a rolling change):** provisioning runs only on a FRESH volume
(`docker-entrypoint-initdb.d`), and the new compose points services at roles/DBs (`platform_app`,
`gaiada_bot@pg-bot`, …) that don't exist in the old volume. So a running old stack cannot be
hot-reconfigured — you re-provision fresh (Path A) or dump→restore into the new topology (Path B).

---

## 0. Decide the path

- **Path A — clean re-provision (RECOMMENDED for the current pre-prod state).** The stack holds only
  seed/test data (legal Gate 1 hasn't passed → no real employee data ingested). Wipe the changed
  volumes, redeploy, re-seed. Fastest, lowest-risk, no dump/restore edge cases.
- **Path B — data-preserving migration.** Use when there IS data to keep (post-Gate-1 / production).
  Dump the old DBs, bring up the new topology, restore with re-owned objects.

Both paths **preserve** the volumes that are expensive or one-way to recreate:
`waha-sessions` (WhatsApp login — avoids a QR re-scan) and `gateway-data` (the internal mTLS CA —
avoids re-issuing every service/sync cert).

---

## 1. Preconditions (both paths)

1. Latest code checked out (new `docker-compose.vps.yml`, `infra/db/init-cluster.sh`,
   `infra/db/init-bot.sh`, `automation/docker-compose.yml`).
2. **Update `.env`** (both `infra/compose/.env` and `automation/.env`):
   - Remove `POSTGRES_APP_PASSWORD`.
   - Add + fill (`openssl rand -hex 16` each): `PLATFORM_OWNER_PASSWORD`, `PLATFORM_APP_PASSWORD`,
     `SYNC_APP_PASSWORD`, `KNOWLEDGE_OWNER_PASSWORD`, `KNOWLEDGE_APP_PASSWORD`, `KEYCLOAK_DB_PASSWORD`,
     `N8N_DB_PASSWORD`, `BOT_OWNER_PASSWORD`, `BOT_APP_PASSWORD`.
   - `automation/.env`: set `N8N_DB_PASSWORD` (== core's) and `N8N_DB_HOST` (`postgres` if n8n shares
     the VPS network, else `host.docker.internal`).
3. `docker compose -f infra/compose/docker-compose.vps.yml config` → **valid** (catches missing vars).
4. Take a safety dump regardless of path (cheap insurance):
   ```sh
   infra/scripts/backup.sh   # note: on the OLD stack this still dumps gaiada/gaiada_platform/gaiada_knowledge
   ```
   (On the old stack, temporarily dump `gaiada` not `gaiada_bot`; keep the archive off-box.)

---

## 2. Path A — clean re-provision

```sh
cd infra/compose

# 2.1 Stop everything (both stacks).
docker compose -f docker-compose.vps.yml down
( cd ../../automation && docker compose down )

# 2.2 Remove ONLY the volumes whose content/ownership changes. KEEP waha-sessions + gateway-data.
#     (Project name is `gaiada` → volumes are `gaiada_<name>`; automation project is
#      `gaiada-automation`. Confirm with `docker volume ls`.)
docker volume rm gaiada_pg-data gaiada_kc-data gaiada_redis-data \
                 gaiada_hub-data gaiada_platform-files gaiada_bot-data
( cd ../../automation && docker volume rm gaiada-automation_n8n-data )
#   pg-bot-data / redis-bot-data don't exist yet — created fresh on up.
#   bot-data (LocalKms keys) is removed here because its keys only decrypt the OLD (wiped) messages;
#   a fresh gaiada_bot gets fresh keys. If you instead keep bot-data, that's harmless (orphaned keys).

# 2.3 Bring the new topology up. init-cluster.sh (core) + init-bot.sh (pg-bot) run on the fresh
#     volumes; platform migrate() runs as platform_owner and applies runtime grants; Keycloak + n8n
#     create their schema on Postgres; Keycloak re-imports the realm from ./keycloak.
docker compose -f docker-compose.vps.yml up -d
( cd ../../automation && docker compose up -d )

# 2.4 Re-seed the platform + automation service accounts, then import n8n workflows in the n8n UI.
docker compose -f docker-compose.vps.yml exec platform npm run seed:agency
docker compose -f docker-compose.vps.yml exec platform npm run seed:automation
```

Then jump to **§4 Verify**.

---

## 3. Path B — data-preserving migration

> Run §1 first. Do the dumps from the OLD stack BEFORE `down`.

### 3.1 Dump the old data (old stack still up)
```sh
cd infra/compose
docker compose -f docker-compose.vps.yml exec -T postgres pg_dump -U postgres --no-owner gaiada           > /tmp/old_bot.sql
docker compose -f docker-compose.vps.yml exec -T postgres pg_dump -U postgres --no-owner gaiada_platform  > /tmp/old_platform.sql
docker compose -f docker-compose.vps.yml exec -T postgres pg_dump -U postgres --no-owner gaiada_knowledge > /tmp/old_knowledge.sql
# Keycloak (H2 → export realm to JSON; H2 has no pg_dump path):
docker compose -f docker-compose.vps.yml exec keycloak /opt/keycloak/bin/kc.sh export \
  --dir /tmp/kc-export --users realm_file
docker compose -f docker-compose.vps.yml cp keycloak:/tmp/kc-export ./kc-export
# n8n (SQLite → export):
cd ../../automation
docker compose exec n8n n8n export:workflow --backup --output=/tmp/n8n-wf
docker compose exec n8n n8n export:credentials --backup --output=/tmp/n8n-cred
docker compose cp n8n:/tmp/n8n-wf ./n8n-wf && docker compose cp n8n:/tmp/n8n-cred ./n8n-cred
```

### 3.2 Stop old, remove the same volumes as Path A §2.2, bring up the new topology (§2.3 up only,
no seed yet).

### 3.3 Restore, re-owning objects to the new owner roles
```sh
cd infra/compose
# Restore as the OWNER role with --no-owner so objects belong to that owner; init-cluster's
# ALTER DEFAULT PRIVILEGES then auto-grants the *_app roles on the restored tables.
docker compose -f docker-compose.vps.yml exec -T postgres \
  psql -U platform_owner  -d gaiada_platform  < /tmp/old_platform.sql
docker compose -f docker-compose.vps.yml exec -T postgres \
  psql -U knowledge_owner -d gaiada_knowledge < /tmp/old_knowledge.sql
# Bot data moves to the ISOLATED instance. KEEP the old bot-data (LocalKms keys) volume mounted on
# the bot so the restored encrypted rows stay decryptable (do NOT wipe bot-data in Path B §3.2).
docker compose -f docker-compose.vps.yml exec -T pg-bot \
  psql -U bot_owner -d gaiada_bot < /tmp/old_bot.sql
```
- **Keycloak:** the new Postgres-backed Keycloak imports `./keycloak` on first boot; if you need the
  exact old users/sessions, import the §3.1 realm JSON (`kc.sh import` or admin console) instead.
- **n8n:** in the new Postgres-backed n8n, `n8n import:workflow`/`import:credentials` from §3.1 (same
  `N8N_ENCRYPTION_KEY` must carry over or credentials won't decrypt).

### 3.4 Restart platform so migrate() re-applies runtime grants over the restored schema
```sh
docker compose -f docker-compose.vps.yml restart platform
```
(`migrate()` is idempotent: schema is already present from the dump; it re-runs `RUNTIME_GRANTS_SQL`,
granting `sync_app` its footprint and revoking sync-internal from `platform_app`.)

---

## 4. Verify (both paths)

```sh
cd infra/compose
# 4.1 Services healthy.
docker compose -f docker-compose.vps.yml ps
infra/scripts/healthcheck.sh   # if wired

# 4.2 Role boundaries hold (the point of the whole exercise):
#   platform_app CANNOT touch the sync ACL / cannot DDL
docker compose -f docker-compose.vps.yml exec postgres \
  psql -U platform_app -d gaiada_platform -c "SELECT count(*) FROM site_subscriptions"   # expect: permission denied
docker compose -f docker-compose.vps.yml exec postgres \
  psql -U platform_app -d gaiada_platform -c "CREATE TABLE x(i int)"                       # expect: permission denied
#   cross-DB isolation
docker compose -f docker-compose.vps.yml exec postgres \
  psql -U platform_app -d gaiada_keycloak -c "SELECT 1"                                    # expect: FATAL permission denied for database
docker compose -f docker-compose.vps.yml exec pg-bot \
  psql -U bot_app -d gaiada_bot -c "SELECT count(*) FROM messages"                          # expect: ok (0+ rows)

# 4.3 App surfaces: platform /health, Keycloak login (realm loaded), n8n UI lists workflows,
#     bot store round-trips, sync-central idle-ok. Fire one automation flow end-to-end.
```

Expected: the first three probes are DENIED; the bot query succeeds. That confirms least privilege +
isolation are live.

---

## 5. Rollback

- **Path A:** you kept the §1.4 dump + the old images/compose in git history. To revert: `down`, restore
  the old volumes from a snapshot (if taken) or redeploy the previous commit and re-provision the old
  way. Because Path A wipes volumes, rollback = redeploy-old + restore-from-dump, so **take the §1.4
  dump and a `docker run --rm -v <vol>:/v -v $PWD:/b alpine tar czf /b/<vol>.tgz /v` snapshot of each
  removed volume first** if you want a true rollback.
- **Path B:** the old volumes are untouched until you remove them in §3.2 — defer that removal until
  after §4 passes, so rollback is just `down` + redeploy-old pointing at the retained old volumes.

---

## Executed 2026-07-15 (Path A, on the live pre-prod subset)

Done against the running subset (platform/mcp-hub/ai-gateway/cerbos/redis/postgres + automation n8n;
bot/keycloak/waha were not running so weren't started). Outcome: new roles + DBs provisioned, platform
migrated as `platform_owner` + runtime `platform_app`, n8n moved SQLite→`gaiada_n8n`, re-seeded, 8
workflows re-imported + published, and the **client.created → bridge → n8n → mcp-hub → platform chain
verified end-to-end** (onboarding project + task + notification created; n8n execution `success`).
Boundary re-checks on the live DB pass (`platform_app` denied `site_subscriptions` + denied cross-DB
to `gaiada_keycloak`).

**Two host-port publishes were required** for the STANDALONE automation stack (n8n on its own compose
network) to reach core services via `host.docker.internal` / `mcp-hub:host-gateway`:
`postgres` → `127.0.0.1:55433` (for `gaiada_n8n`; note 5432/5433 were taken/Windows-reserved) and
`mcp-hub` → `127.0.0.1:3003` (workflows call `http://mcp-hub:3003`). Both localhost-only. If instead you
attach n8n to the `gaiada` network, drop these publishes and use in-network DNS.

**n8n gotchas hit:** (1) `update:workflow --all` is removed — activate per-workflow with
`publish:workflow --id=<id>`; (2) CLI-published workflows only register their webhooks after an n8n
**restart** (the running process doesn't hot-register them) — restart n8n before firing bridge events;
(3) the first UI visit still shows the owner-setup wizard (n8n-data was wiped).

## Notes

- **Crypto-shred stays intact:** dumps are DB-only; the bot's `keys.json` lives in the `bot-data`
  volume and is NEVER in a DB dump/backup set (see `infra/scripts/backup.sh`). Path B keeps `bot-data`
  so restored encrypted rows remain decryptable; Path A wipes both together (keys + their data).
- **Keycloak prod hardening (separate task):** this cutover keeps Keycloak on `start-dev` (no TLS/
  hostname). Moving to `start` (production mode: `KC_HOSTNAME` + TLS) is a deploy-hardening follow-up,
  independent of the DB topology.
- After cutover, the old `wa-chat-bot/db/init.sh` is unused by the VPS stack (superseded by
  `infra/db/init-cluster.sh` + `init-bot.sh`); it remains only for the bot's standalone local-dev
  compose.
