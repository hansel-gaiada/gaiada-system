#!/bin/sh
# Nightly Postgres backup for the gaiada VPS stack. Install via crontab (see the runbook):
#   0 3 * * * /path/to/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
#
# Backs up every application database, across BOTH instances (DB topology plan):
#   core instance (service `postgres`):
#     gaiada_platform  — the platform / ERP (clients, deliverables, agency, audit, sync outbox)
#     gaiada_knowledge — the WS8 derived knowledge store
#     gaiada_keycloak  — the IdP (realm, users, sessions)
#     gaiada_n8n       — automation workflow defs + execution history
#   bot instance (service `pg-bot`, isolated):
#     gaiada_bot       — the WhatsApp bot store (messages, schedule)
# Missing any one silently loses that surface's data.
#
# Plus ONE volume — the WAHA session store (see waha_sessions() below for why it is safe).
#
# CRYPTO-SHRED RULE: this backs up the DATABASES ONLY (plus the WAHA volume). Never add the
# bot's data volume (it contains data/keys.json — key material must never live in the same
# backup set, or destroyed keys become recoverable and the shred is void). The WAHA volume is
# a DIFFERENT volume and holds no crypto-shred key material, so it does not breach the rule.
set -eu

BACKUP_DIR="${BACKUP_DIR:-$HOME/gaiada-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Compose file list, as ready-made `-f` flags (intentionally unquoted at use so multiple files
# expand). On a host-Postgres box (gda-aicenter) the base file ALONE is an invalid project —
# postgres/redis are profile-disabled there, so every `depends_on` naming them fails resolution,
# `docker compose ps` errors out, and the running-check below then matches nothing and "skips
# cleanly". That silently produced a backup set with NO gaiada_bot dump while exiting 0.
#
# 2026-08-03: this used to require the CALLER to pass both files, and the caller that matters most
# didn't. deploy.yml has COMPOSE_FILES in its job env but never forwarded it over the `ssh vps`
# that runs this script, so the deploy got the single-file default and died at the backup gate —
# `service "knowledge" depends on undefined service "postgres": invalid compose project` — which
# is a HARD FAIL for the whole deploy, since the backup is deliberately the gate for migrations.
# It surfaced only after deploy.yml's rsync step (which runs BEFORE the backup) put a newer
# vps.yml on the box; the previous run had backed up fine minutes earlier against the older file.
#
# So the overlay is now picked up AUTOMATICALLY whenever it sits next to the base file, rather
# than depending on every call site remembering. Explicitly setting COMPOSE_FILES still wins.
_compose_dir="$(dirname "$0")/../compose"
if [ -z "${COMPOSE_FILES:-}" ]; then
  COMPOSE_FILES="-f $_compose_dir/docker-compose.vps.yml"
  # hostdata = the host-Postgres topology. Present on gda-aicenter, absent on an all-in-compose
  # box, and harmless to layer when the services it disables are the ones it also defines.
  [ -f "$_compose_dir/docker-compose.hostdata.yml" ] &&
    COMPOSE_FILES="$COMPOSE_FILES -f $_compose_dir/docker-compose.hostdata.yml"
fi
# Compose project is `gaiada` (see the compose `name:`), so the volume is prefixed.
WAHA_VOLUME="${WAHA_VOLUME:-gaiada_waha-sessions}"

# PG_HOST set (and not the compose service name) means the core cluster lives on the HOST, not in
# compose — the gda-aicenter topology, where Postgres is shared with other projects. There is no
# container to `exec` into, so dump straight from the host cluster as the postgres superuser via
# peer auth. The bot instance stays containerized either way and keeps the compose path.
CORE_ON_HOST=false
case "${PG_HOST:-postgres}" in postgres|"") ;; *) CORE_ON_HOST=true ;; esac

dump() { # <compose-service> <db>
  OUT="$BACKUP_DIR/$2-$STAMP.sql.gz"
  if [ "$1" = "postgres" ] && [ "$CORE_ON_HOST" = true ]; then
    sudo -n -u postgres pg_dump "$2" | gzip > "$OUT"
  else
    # Skip cleanly when the service isn't part of the active profile set (e.g. pg-bot with the
    # `bot` profile off) — a missing optional lane must not fail the backup that gates migrations.
    # Distinguish "this optional lane is off" (skip, fine) from "compose can't read the project
    # at all" (FAIL loudly). The old code swallowed stderr and treated both as a clean skip, so a
    # broken invocation reported success while backing up nothing.
    if ! RUNNING="$(docker compose $COMPOSE_FILES ps --status running --format '{{.Service}}' 2>&1)"; then
      echo "backup FAILED: cannot read compose project (service $1): $RUNNING" >&2
      return 1
    fi
    if ! printf '%s\n' "$RUNNING" | grep -qx "$1"; then
      echo "backup SKIPPED: service $1 not running (profile off?)" >&2
      return 0
    fi
    docker compose $COMPOSE_FILES exec -T "$1" pg_dump -U postgres "$2" | gzip > "$OUT"
  fi
  echo "backup ok: $OUT"
}

# The WAHA session store (Baileys pairing credentials). Losing this volume forces a fresh QR
# scan — and a re-pair is NOT reliably available on demand: on 2026-07-29 WhatsApp refused the
# registration handshake for hours after a reconnect storm, leaving no way back in. That makes
# this volume the most operationally valuable thing on the box.
#
# SECURITY: the contents are full WhatsApp ACCOUNT credentials — anyone holding them can act as
# the number. Treat the artifact as a secret: 0600, and never sync it anywhere shared/unencrypted.
#
# CONSISTENCY: Baileys writes creds continuously, so this is a crash-consistent snapshot. It
# restores in practice but is not guaranteed; for a clean copy, stop the session first
# (POST /api/sessions/{s}/stop — keeps auth, no re-scan) and re-run.
waha_sessions() {
  OUT="$BACKUP_DIR/waha-sessions-$STAMP.tar.gz"
  if ! docker volume inspect "$WAHA_VOLUME" >/dev/null 2>&1; then
    echo "backup SKIPPED: volume $WAHA_VOLUME not found (set WAHA_VOLUME to override)" >&2
    return 0
  fi
  # tar to stdout (no host bind-mount) so this works identically on Linux, WSL and Docker Desktop.
  docker run --rm -v "$WAHA_VOLUME":/src:ro alpine tar czf - -C /src . > "$OUT"
  chmod 600 "$OUT"
  echo "backup ok: $OUT"
}

# ── Stacks that live in their OWN compose project (webdesk, gaiada-social) ───────────────────────
# `dump()` above cannot reach these. It resolves a service through `docker compose $COMPOSE_FILES`,
# which is the `gaiada` project (vps.yml + hostdata.yml); webdesk and gaiada-social are SEPARATE
# projects with their own directories, networks and databases — deliberately so, for Zone B
# isolation. So they are addressed by CONTAINER NAME instead.
#
# Why this exists at all: both stacks were consolidated onto gda-aicenter from sumopod (WebDesk on
# 2026-08-31, Postiz on 2026-09-01) and NEITHER was added here. Measured 2026-09-02: the nightly run
# produced dumps for gaiada_platform/knowledge/keycloak/n8n/bot and waha sessions, and nothing for
# `webdesk` (250 migrated tenants) or `postiz`. The only surviving copies were the original stacks
# still running on sumopod — which means the "soak period" was silently doing the job a backup should
# do, and sumopod could not have been decommissioned without destroying the sole copy.
#
# The role note matters and is not incidental: webdesk's cluster uses the owner/app split, and
# `pg_dump -U webdesk_owner` FAILS with "permission denied" because the owner cannot read its own
# tables under that model. Dump as the container's own superuser.
dump_container() { # <container> <pg-user> <db>
  OUT="$BACKUP_DIR/$3-$STAMP.sql.gz"
  if ! docker ps --format '{{.Names}}' | grep -qx "$1"; then
    # An absent stack is a clean skip, matching the profile-off precedent above — this script gates
    # migrations and must not fail a box that simply does not host that stack.
    echo "backup SKIPPED: container $1 not running (stack not on this host?)" >&2
    return 0
  fi
  if ! docker exec -i "$1" pg_dump -U "$2" "$3" | gzip > "$OUT"; then
    echo "backup FAILED: pg_dump $3 from $1 as $2" >&2
    return 1
  fi
  # A gzip of an empty/failed dump is ~20 bytes and would rotate in looking like a real backup.
  SZ="$(wc -c < "$OUT")"
  if [ "$SZ" -lt 1000 ]; then
    echo "backup FAILED: $OUT is only ${SZ}B — refusing to keep a dump that cannot be a database" >&2
    rm -f "$OUT"
    return 1
  fi
  chmod 600 "$OUT"
  echo "backup ok: $OUT (${SZ}B)"
}

# ── Cluster ROLES — without these, none of the dumps above is actually restorable ────────────────
# Found 2026-09-02 by restore-testing a webdesk dump into a clean container: the DATA restored
# perfectly (30 tables, 250 tenants, matching live exactly) but four statements failed with
# `role "webdesk_app" does not exist` / `role "webdesk_migrator" does not exist`. Every GRANT and
# every OWNER assignment silently did not apply.
#
# That is a worse outcome than a failed restore, and it applies to the ERP's own databases too, not
# just the consolidated stacks: `pg_dump` NEVER emits roles (they are cluster-level, not per-database)
# and nothing here dumped globals. The host cluster alone carries 8 of them — platform_owner,
# platform_app, knowledge_owner, knowledge_app, sync_app, keycloak, n8n, gaiada_exporter.
#
# Why that is severe HERE specifically rather than a tidiness point: this estate runs FORCE RLS with
# an owner/app role split, and its policies are written against those role names. Restore the data
# without them and you get a database the application cannot read at all — every policy references a
# role that does not exist — while the restore itself looks like it worked.
#
# NOTE: globals include role password HASHES, so these files are secret-bearing. 0600, same as the
# rest, and never anywhere world-readable.
dump_globals() { # <label> [container] [pg-user]
  OUT="$BACKUP_DIR/globals-$1-$STAMP.sql.gz"
  if [ -z "${2:-}" ]; then
    sudo -n -u postgres pg_dumpall --globals-only | gzip > "$OUT"
  else
    docker ps --format '{{.Names}}' | grep -qx "$2" || { echo "backup SKIPPED: globals $1 (container $2 absent)" >&2; return 0; }
    docker exec -i "$2" pg_dumpall -U "$3" --globals-only | gzip > "$OUT"
  fi
  SZ="$(wc -c < "$OUT")"
  if [ "$SZ" -lt 200 ]; then
    echo "backup FAILED: $OUT is only ${SZ}B — a cluster always has roles" >&2
    rm -f "$OUT"; return 1
  fi
  chmod 600 "$OUT"
  echo "backup ok: $OUT (${SZ}B)"
}

mkdir -p "$BACKUP_DIR"
for DB in gaiada_platform gaiada_knowledge gaiada_keycloak gaiada_n8n; do dump postgres "$DB"; done
dump pg-bot gaiada_bot
waha_sessions

# Roles for every cluster this box hosts. Restore order in a real recovery is globals FIRST, then
# the per-database dumps — the reverse leaves the GRANTs unapplied, which is the bug found above.
dump_globals host
dump_globals webdesk webdesk-postgres-1 postgres
dump_globals social gaiada-social-social-postgres-1 postiz
dump_globals temporal gaiada-social-social-temporal-postgres-1 temporal

# WebDesk (WSK) — `postgres`, not `webdesk_owner`; see the role note above.
dump_container webdesk-postgres-1 postgres webdesk
# gaiada-social (Postiz) + its Temporal pair. Temporal's two databases are useless apart: the
# visibility store is rebuilt from, and must match, the main one.
dump_container gaiada-social-social-postgres-1 postiz postiz
dump_container gaiada-social-social-temporal-postgres-1 temporal temporal
dump_container gaiada-social-social-temporal-postgres-1 temporal temporal_visibility

# Rotate all dumps on the same schedule. The second glob is NOT redundant: these dumps are named
# after their own databases (`webdesk-`, `postiz-`, `temporal-`), so `gaiada*` never matches them and
# they would otherwise accumulate forever.
find "$BACKUP_DIR" -name 'gaiada*-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
find "$BACKUP_DIR" -name 'waha-sessions-*.tar.gz' -mtime "+$KEEP_DAYS" -delete
for P in webdesk postiz temporal temporal_visibility; do
  find "$BACKUP_DIR" -name "$P-*.sql.gz" -mtime "+$KEEP_DAYS" -delete
done
find "$BACKUP_DIR" -name 'globals-*.sql.gz' -mtime "+$KEEP_DAYS" -delete
