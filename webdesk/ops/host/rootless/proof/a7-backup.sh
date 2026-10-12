#!/usr/bin/env bash
# a7-backup.sh - P2 acceptance row A7: the nightly backup, the backup-role check and the restore drill, all against the
# PROOF stack on the proof daemon (M4 F6; plan §9 A7). Run after a5-stack.sh (the stack must be running).
#
#   sudo bash a7-backup.sh
#
# 1. webdesk-backup-nightly.sh  with WEBDESK_DOCKER_HOST=<proof socket> WEBDESK_PG_CONTAINER=wdproof-postgres-1
#    WEBDESK_BACKUP_DIR=/srv/wdproof/backups. NEVER ~/gaiada-backups: sumopod pulls that offsite every night, so a proof dump
#    there would be shipped, age-encrypted and kept 90 days. The script hard-codes the proof dir and refuses anything else.
#    Must print `webdesk-backup ok file=... tenants=N` with N>0 (the BYPASSRLS role arrived intact in the physical copy).
# 2. ensure-backup-role.sh      same container/daemon: must print `unchanged` (the role, its read-only grants and the
#    migrator's default privileges came across the copy; this is a check, not a setup step).
# 3. webdesk-restore-drill.sh   fed THAT dump on stdin: a throwaway postgres on the PROOF daemon (--network none, digest-pinned
#    image) must print DRILL OK. The drill's own checks: every table's restored row count equals the dump's COPY count,
#    tenants and content items came back, and FORCE RLS is intact (webdesk_app with no tenant GUC reads 0 rows).
# Evidence (root 0700): /srv/wdproof/evidence/a7/.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=proof-lib.sh
. "$HERE/proof-lib.sh"

BDIR=/srv/wdproof/backups
PGCT=wdproof-postgres-1
EV=""

svc_running() { [ "$(dp inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }
psql_proof() { dp exec "$PGCT" psql -U "$(envget POSTGRES_SUPERUSER)" -d "$(envget POSTGRES_DB)" -X -A -t "$@"; }

main() {
  hdr "preflight"
  require_proof_context
  require_daemons
  require_proof_files
  svc_running "$PGCT" || die "REFUSED: $PGCT is not running on the proof daemon (run a5-stack.sh first)"
  case "$(realpath -m "$BDIR")" in /srv/wdproof/backups) ;; *) die "REFUSED: backup dir '$BDIR' is not /srv/wdproof/backups" ;; esac
  local pg_img
  pg_img="$(proof_image '^postgres:')"
  [[ "$pg_img" == *@sha256:* ]] || die "cannot resolve the digest-pinned postgres image"
  EV="$(ev_dir a7)"
  install -d -m 0700 "$BDIR"
  pass "backup dir is $BDIR (never ~/gaiada-backups)"

  hdr "1. webdesk-backup-nightly.sh against the proof Postgres"
  local out rc file bytes tables tenants a4t a4n
  out="$(env -u WEBDESK_DB -u KEEP_DAYS WEBDESK_DOCKER_HOST="$PROOF_SOCK" WEBDESK_PG_CONTAINER="$PGCT" WEBDESK_BACKUP_DIR="$BDIR" \
    bash "$PROOF_TREE/ops/scripts/webdesk-backup-nightly.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >"$EV/nightly.out"
  printf '%s\n' "$out" | tail -n 3 | sed 's/^/        /'
  if [ "$rc" = 0 ] && [[ "$out" =~ webdesk-backup\ ok\ file=([^[:space:]]+)\ bytes=([0-9]+)\ tables=([0-9]+)\ tenants=([0-9]+) ]]; then
    file="${BASH_REMATCH[1]}" bytes="${BASH_REMATCH[2]}" tables="${BASH_REMATCH[3]}" tenants="${BASH_REMATCH[4]}"
    pass "webdesk-backup ok: $bytes bytes, tables=$tables tenants=$tenants"
    [ "$tenants" -gt 0 ] && pass "tenants>0: the backup role bypasses RLS on the copied cluster" || fail "tenants=0"
    case "$file" in "$BDIR"/webdesk-*.sql.gz) pass "the dump is in $BDIR: $(basename "$file")" ;; *) fail "the dump is NOT under $BDIR: $file" ;; esac
    a4n="$(grep -c . "$PROOF_EVID/a4/counts.rootful.txt" 2>/dev/null || true)"
    a4t="$(awk '$1 == "tenants" { print $2 }' "$PROOF_EVID/a4/counts.rootful.txt" 2>/dev/null || true)"
    if [ -n "$a4t" ] && [ "$a4t" = "$tenants" ]; then pass "tenants=$tenants equals A4's count"; else info "tenants=$tenants vs A4's '${a4t:-n/a}' (the api may have changed it; compare by hand)"; fi
    if [ -n "$a4n" ] && [ "$a4n" = "$tables" ]; then pass "tables=$tables equals A4's table count"; else info "tables=$tables vs A4's ${a4n:-n/a} public tables"; fi
  else
    fail "the nightly backup did not print 'webdesk-backup ok' (exit $rc)"
    die "cannot continue without a dump"
  fi

  hdr "2. ensure-backup-role.sh must print 'unchanged'"
  out="$(env -u WEBDESK_DB -u WEBDESK_MIGRATOR_ROLE WEBDESK_DOCKER_HOST="$PROOF_SOCK" WEBDESK_PG_CONTAINER="$PGCT" sh "$PROOF_TREE/ops/scripts/ensure-backup-role.sh" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >"$EV/ensure-backup-role.out"
  printf '%s\n' "$out" | tail -n 2 | sed 's/^/        /'
  if [ "$rc" = 0 ] && [[ "$out" == *"unchanged"* ]]; then pass "ensure-backup-role.sh: unchanged"; else fail "ensure-backup-role.sh did not print 'unchanged' (exit $rc)"; fi

  hdr "3. the restore drill, fed that dump, on the proof daemon"
  local forced
  forced="$(psql_proof -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity" 2>/dev/null)"
  [[ "$forced" =~ ^[0-9]+$ ]] || die "cannot count the forced-RLS tables of the proof DB"
  out="$(env -u EXPECT_ITEMS WEBDESK_DOCKER_HOST="$PROOF_SOCK" DRILL_IMAGE="$pg_img" EXPECT_FORCED_TABLES="$forced" \
    bash "$PROOF_TREE/ops/scripts/webdesk-restore-drill.sh" <"$file" 2>&1)"
  rc=$?
  printf '%s\n' "$out" >"$EV/restore-drill.out"
  printf '%s\n' "$out" | tail -n 6 | sed 's/^/        /'
  if [ "$rc" = 0 ] && [[ "$out" == *"DRILL OK"* ]]; then pass "restore drill: DRILL OK ($forced forced-RLS tables expected and found)"; else fail "restore drill did not print DRILL OK (exit $rc)"; fi
  if [ -z "$(dp ps -aq --filter 'name=^m4drill-')" ]; then pass "the drill's throwaway was removed from the proof daemon"; else fail "an m4drill-* container is left on the proof daemon"; fi

  info "evidence: $EV    dump kept at $file (A9 deletes /srv/wdproof)"
  info "next: bash $HERE/a8-reboot-standin.sh"
  summary
}

main "$@"
