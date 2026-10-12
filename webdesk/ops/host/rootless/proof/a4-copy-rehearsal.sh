#!/usr/bin/env bash
# a4-copy-rehearsal.sh - P2 acceptance row A4: rehearse the cut-over's physical volume copy (M4 F6; plan §7, §9 A4).
#
#   sudo bash a4-copy-rehearsal.sh            run the rehearsal (refuses if any proof volume already exists)
#   sudo bash a4-copy-rehearsal.sh reset --yes   undo it: remove the three rootful throwaway volumes, any wdproof-a4-*
#                                              container/network, and the proof project's own containers and volumes
#
# Needs: proof-env.sh has run; the proof daemon is up (A1 VERIFY OK); the live image digests are on both daemons.
#
# WHAT IT PROVES (each as PASS/FAIL lines, then "passed=N failed=M"):
#   Proof volumes   `compose -p wdproof ... create --pull never --no-build` on the PROOF daemon makes the three
#                   volumes (and containers, unstarted) with the right labels; wd-volume-copy refuses a missing destination.
#   Postgres        newest ERP-side superuser dump + its globals restored into a throwaway ROOTFUL cluster (same digest,
#                   --network none), roles re-keyed to the proof passwords, every tenant webhook DISABLED, per-table row
#                   counts recorded, clean stop, `wd-volume-copy.sh copy` + verify into wdproof_webdesk_pgdata, then the
#                   copy is started alone on the proof daemon and its counts must equal the rootful ones.
#   RustFS          throwaway rootful RustFS (same digest, internal network), the repo's storage-bootstrap.mjs, ONE
#                   object written twice (two versions) with a ~1 day object-lock retention, ListObjectVersions +
#                   GetObjectRetention recorded, stop, copy + verify, started alone on the proof daemon: the two answers
#                   must be IDENTICAL (version ids, retain-until, sizes), and storage-bootstrap must report changes=0.
#   Redis           a delayed BullMQ-shaped job (zset member + job hash, due in ~1 day so nothing fires), SAVE, stop, copy
#                   + verify, started alone on the proof daemon: the same zset member and hash come back.
#
# SAFETY: runs only as root with the proof context (see proof-lib.sh). Rootful throwaways are named wdproof-a4-* and the
# rootful volumes wdproof_webdesk_{pgdata,rustfsdata,redisdata}; nothing else on the rootful daemon is created, stopped or
# removed. The proof daemon's egress guard allows the internet, so the copy of the database has EVERY tenant webhook
# disabled before it ever reaches that daemon, and the proof env turns mail/Zone-B events/OTLP off.
# Reads the dumps in /home/Hansel/gaiada-backups (never writes there). No secret is printed.
#
# KEEPS (A5 needs them): the three proof volumes, the evidence in /srv/wdproof/evidence/a4/, and the three ROOTFUL
# throwaway volumes (removed by A9, not here). Removes: the rootful throwaway containers and network (EXIT trap), and it
# stops the proof containers it started so that a5-stack.sh starts the whole stack cleanly.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=proof-lib.sh
. "$HERE/proof-lib.sh"

COPY_TOOL="$PROOF_TREE/ops/host/rootless/wd-volume-copy.sh"
BK_DIR="${WDPROOF_DUMP_DIR:-/home/Hansel/gaiada-backups}"
NET=wdproof-a4-net
PGC=wdproof-a4-pg
RFC=wdproof-a4-rustfs
RDC=wdproof-a4-redis
V_PG=wdproof_webdesk_pgdata
V_RF=wdproof_webdesk_rustfsdata
V_RD=wdproof_webdesk_redisdata
CLEAN_OK=0       # set once preflight passed: only then may the EXIT trap touch wdproof-a4-* throwaways
STARTED_PROOF=0  # set once this script starts a proof container: only then may the trap stop the proof stack
EV=""
W=""

cleanup() {
  [ "$CLEAN_OK" = 1 ] || return 0
  local c
  for c in "$PGC" "$RFC" "$RDC"; do rf_rm "$c"; done
  rf_net_rm "$NET" || true
  [ "$STARTED_PROOF" = 0 ] || wdc stop >/dev/null 2>&1 || true
  [ -z "$W" ] || rm -rf -- "$W"
}

# --- reset -----------------------------------------------------------------------------------------------------

do_reset() {
  [ "${1:-}" = --yes ] || die "reset removes the proof volumes and the three rootful throwaway volumes; pass --yes"
  hdr "reset (proof project + rootful wdproof-a4-* throwaways ONLY)"
  require_proof_context
  require_daemons
  CLEAN_OK=1
  local c v
  for c in "$PGC" "$RFC" "$RDC"; do rf_rm "$c"; done
  rf_net_rm "$NET" || true
  for v in "$V_PG" "$V_RF" "$V_RD"; do
    if dr volume inspect "$v" >/dev/null 2>&1; then rf_vol_rm "$v" >/dev/null && pass "removed rootful throwaway volume $v" || fail "could not remove rootful volume $v"; fi
  done
  if [ -f "$PROOF_ENV" ]; then
    wdc down --volumes --remove-orphans >/dev/null 2>&1 && pass "proof project '$PROOF_PROJECT' taken down with its volumes" || fail "wdc down -v failed"
  else
    warn "no proof env: the proof project was not touched"
  fi
  summary
}

# --- helpers ---------------------------------------------------------------------------------------------------

# newest globals-webdesk-<ts>.sql.gz that has a matching webdesk-<ts>.sql.gz: sets GLOBALS_F and DUMP_F.
pick_dumps() {
  local g ts
  GLOBALS_F="" DUMP_F=""
  while IFS= read -r g; do
    ts="${g##*/globals-webdesk-}"
    ts="${ts%.sql.gz}"
    [[ "$ts" =~ ^[0-9]{8}-[0-9]{6}$ ]] || continue
    if [ -f "$BK_DIR/webdesk-$ts.sql.gz" ]; then GLOBALS_F="$g"; DUMP_F="$BK_DIR/webdesk-$ts.sql.gz"; return 0; fi
  done < <(ls -1 "$BK_DIR"/globals-webdesk-*.sql.gz 2>/dev/null | sort -r)
  return 1
}

rf_redis_up() { [ "$(dr exec "$RDC" redis-cli ping 2>/dev/null)" = PONG ]; }
proof_redis_up() { [ "$(dp exec wdproof-redis-1 redis-cli ping 2>/dev/null)" = PONG ]; }
proof_healthy() { [ "$(dp inspect -f '{{.State.Health.Status}}' "$1" 2>/dev/null)" = healthy ]; }
# env file with only the named proof-env variables (0600, removed at exit); extra KEY=VALUE args are appended.
mk_envfile() {
  local f k v
  f="$(mk_tmp)"
  for k in "$@"; do
    case "$k" in
      *=*) printf '%s\n' "$k" >>"$f" ;;
      *) v="$(envget "$k")"; [ -z "$v" ] || printf '%s=%s\n' "$k" "$v" >>"$f" ;;
    esac
  done
  printf '%s\n' "$f"
}

S3_JS='
const S3 = require("@aws-sdk/client-s3");
const e = process.env;
const bucket = e.STORAGE_BUCKET_ARTIFACTS || "artifacts";
const key = "a4-rehearsal/object.txt";
const c = new S3.S3Client({ endpoint: e.STORAGE_ENDPOINT, region: e.STORAGE_REGION || "us-east-1", forcePathStyle: true,
  requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
  credentials: { accessKeyId: e.RUSTFS_ROOT_USER, secretAccessKey: e.RUSTFS_ROOT_PASSWORD } });
const iso = (d) => (d ? new Date(d).toISOString() : null);
async function put(body, mode, until) {
  return c.send(new S3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ObjectLockMode: mode, ObjectLockRetainUntilDate: until }));
}
async function write() {
  const until = new Date(Date.now() + 24 * 3600 * 1000);
  const out = [];
  for (const body of ["a4 rehearsal version one\n", "a4 rehearsal version two, longer than the first\n"]) {
    let m = "COMPLIANCE", r;
    try { r = await put(body, m, until); } catch (err) { m = "GOVERNANCE"; r = await put(body, m, until); }
    out.push({ mode: m, versionId: r.VersionId });
  }
  console.log(JSON.stringify(out));
}
async function dump() {
  const lv = await c.send(new S3.ListObjectVersionsCommand({ Bucket: bucket, Prefix: "a4-rehearsal/" }));
  const versions = [];
  for (const v of lv.Versions || []) {
    const rt = await c.send(new S3.GetObjectRetentionCommand({ Bucket: bucket, Key: v.Key, VersionId: v.VersionId }));
    versions.push({ Key: v.Key, VersionId: v.VersionId, IsLatest: v.IsLatest, Size: v.Size, ETag: v.ETag, LastModified: iso(v.LastModified),
      Retention: { Mode: rt.Retention && rt.Retention.Mode, RetainUntilDate: iso(rt.Retention && rt.Retention.RetainUntilDate) } });
  }
  const ver = await c.send(new S3.GetBucketVersioningCommand({ Bucket: bucket }));
  const lock = await c.send(new S3.GetObjectLockConfigurationCommand({ Bucket: bucket }));
  console.log(JSON.stringify({ bucket, versioning: ver.Status, lock: lock.ObjectLockConfiguration, deleteMarkers: (lv.DeleteMarkers || []).length, versions }, null, 2));
}
(e.A4_MODE === "write" ? write() : dump()).catch((err) => { console.error("A4_S3_ERROR", err.name, String(err.message || "").slice(0, 200)); process.exit(1); });
'

# s3run <rootful|proof> <network> <write|dump>: run the S3 client inside the api image (node + AWS SDK), script on stdin.
s3run() {
  local where=$1 net=$2 mode=$3 n="wdproof-a4-s3c-$RANDOM"
  if [ "$where" = rootful ]; then
    rf_run "$n" --rm -i --network "$net" --env-file "$CLENV" -e "A4_MODE=$mode" --cap-drop ALL --security-opt no-new-privileges:true \
      --pids-limit 128 --memory 256m --cpus 0.3 --entrypoint node "$API" - <<<"$S3_JS"
  else
    dp run --rm -i --name "$n" --network "$net" --env-file "$CLENV" -e "A4_MODE=$mode" --cap-drop ALL --security-opt no-new-privileges:true \
      --pids-limit 128 --memory 256m --cpus 0.3 --entrypoint node "$API" - <<<"$S3_JS"
  fi
}

# bootstrap <rootful|proof> <network>: the repo's storage-bootstrap.mjs, run in the api image (node + AWS SDK in /app).
# The script resolves the SDK from ../api/node_modules relative to itself, so it is mounted at /app/scripts/ and
# findings fall through to /app/node_modules.
bootstrap() {
  local where=$1 net=$2 n="wdproof-a4-sb-$RANDOM"
  local common=(--rm --network "$net" --env-file "$CLENV" --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 128 --memory 256m --cpus 0.3
    -v "$PROOF_TREE/scripts/storage-bootstrap.mjs:/app/scripts/storage-bootstrap.mjs:ro" --entrypoint node)
  if [ "$where" = rootful ]; then rf_run "$n" "${common[@]}" "$API" /app/scripts/storage-bootstrap.mjs
  else dp run --name "$n" "${common[@]}" "$API" /app/scripts/storage-bootstrap.mjs; fi
}

# copy_vol <volume>: wd-volume-copy copy (which verifies) from the rootful daemon to the proof daemon.
copy_vol() {
  local v=$1 out="$W/copy-$1.out" rc
  bash "$COPY_TOOL" copy --from rootful --to "$PROOF_SOCK" --volume "$v" --image "$HELPER" --keep "$EV/manifest-${v#wdproof_webdesk_}" >"$out" 2>&1
  rc=$?
  tail -n 4 "$out" | sed 's/^/        /'
  if [ "$rc" = 0 ] && grep -q "^VERIFIED $v" "$out"; then pass "wd-volume-copy copy + verify $v: VERIFIED"; return 0; fi
  fail "wd-volume-copy $v failed (exit $rc); full output in $out"
  cp -f "$out" "$EV/copy-$v.out" 2>/dev/null || true
  return 1
}

# --- steps -----------------------------------------------------------------------------------------------------

preflight() {
  hdr "preflight"
  require_proof_context
  require_daemons
  require_proof_files
  [ -r "$COPY_TOOL" ] || die "REFUSED: $COPY_TOOL is missing (the proof tree lacks the rootless tooling)"
  local v c
  for v in "$V_PG" "$V_RF" "$V_RD"; do
    if dr volume inspect "$v" >/dev/null 2>&1; then die "REFUSED: rootful volume $v already exists (a previous run; 'a4-copy-rehearsal.sh reset --yes' removes it)"; fi
    if dp volume inspect "$v" >/dev/null 2>&1; then die "REFUSED: proof volume $v already exists (a previous run, or the stack ran; 'reset --yes' removes it)"; fi
  done
  for c in "$PGC" "$RFC" "$RDC"; do
    if rf_exists "$c"; then die "REFUSED: rootful container $c already exists"; fi
  done
  if dr network inspect "$NET" >/dev/null 2>&1; then die "REFUSED: rootful network $NET already exists"; fi
  [ -d "$BK_DIR" ] || die "REFUSED: $BK_DIR is missing"
  pick_dumps || die "REFUSED: no globals-webdesk-<ts>.sql.gz with a matching webdesk-<ts>.sql.gz in $BK_DIR"
  gzip -t "$GLOBALS_F" && gzip -t "$DUMP_F" || die "REFUSED: a dump failed gzip -t"
  pass "dump pair: $(basename "$DUMP_F") + $(basename "$GLOBALS_F")"

  CLEAN_OK=1
  # A previous run's evidence moves aside, never mixes in: wd-volume-copy's --keep refuses an existing manifest dir
  # (found in P2 A4 run 3, 2026-10-12), and A5/A7 read THIS run's counts from the fixed path $PROOF_EVID/a4.
  if [ -e "$PROOF_EVID/a4" ]; then
    mv "$PROOF_EVID/a4" "$PROOF_EVID/a4.prev-$(date -u +%Y%m%dT%H%M%SZ)" || die "cannot move the previous a4 evidence aside"
    info "previous a4 evidence moved to $PROOF_EVID/a4.prev-*"
  fi
  EV="$(ev_dir a4)"
  W="$(mktemp -d -p "$EV" work.XXXXXX)" || die "cannot make a work dir"

  PG_IMG="$(proof_image '^postgres:')"
  REDIS_IMG="$(proof_image '^redis:')"
  RUSTFS_IMG="$(proof_image '^rustfs/rustfs:')"
  API="$(envget WEBDESK_API_IMAGE)"
  local i
  for i in "$PG_IMG" "$REDIS_IMG" "$RUSTFS_IMG"; do
    [[ "$i" == *@sha256:* ]] || die "the compose project resolves an image without a digest ('$i')"
    dr image inspect "$i" >/dev/null 2>&1 || die "REFUSED: $i is not on the rootful daemon"
    dp image inspect "$i" >/dev/null 2>&1 || die "REFUSED: $i is not on the proof daemon"
  done
  pass "images (same digests on both daemons): postgres, redis, rustfs"

  # The copy helper: node:22-bookworm, same digest on both sides (wd-volume-copy refuses otherwise).
  local hd
  hd="$(dr image inspect node:22-bookworm --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | grep -E '^node@sha256:[0-9a-f]{64}$' | head -n 1 || true)"
  hd="${hd#node@}"
  if [ -z "$hd" ]; then
    hd="$(dr image inspect node:22-bookworm --format '{{.Id}}' 2>/dev/null || true)"
    [[ "$hd" =~ ^sha256:[0-9a-f]{64}$ ]] || die "cannot determine the digest of the rootful node:22-bookworm"
    warn "node:22-bookworm has no RepoDigest; using its image id as the digest (containerd store: id = manifest digest)"
  fi
  HELPER="node:22-bookworm@$hd"
  if ! dp image inspect "$HELPER" >/dev/null 2>&1; then
    info "pulling the copy helper $HELPER onto the proof daemon (through its egress guard)"
    dp pull "$HELPER" >/dev/null 2>&1 || die "cannot pull $HELPER on the proof daemon"
  fi
  [ "$(dp image inspect --format '{{.Id}}' "$HELPER")" = "$(dr image inspect --format '{{.Id}}' "$HELPER")" ] \
    && pass "copy helper $HELPER: same image id on both daemons" || die "the helper's image id differs between the daemons"
  stage_api_image || die "the api image is not staged"
}

create_proof_volumes() {
  hdr "proof volumes (compose create on the proof daemon; nothing starts)"
  local out
  out="$(wdc create --pull never --no-build 2>&1)" || { fail "compose create failed: $(printf '%s' "$out" | tail -n 5 | tr '\n' ' ')"; die "cannot continue without the proof project"; }
  pass "compose -p wdproof create --pull never --no-build"
  local v
  for v in "$V_PG" "$V_RF" "$V_RD"; do
    if [ "$(dp volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$v" 2>/dev/null)" = "$PROOF_PROJECT" ]; then pass "proof volume $v exists, labelled project $PROOF_PROJECT"; else fail "proof volume $v is missing or unlabelled"; fi
  done
}

pg_throwaway_ready() { dr logs "$PGC" 2>&1 | grep -c 'PostgreSQL init process complete' >/dev/null && dr exec "$PGC" pg_isready -q -U "$SU" -d "$DB"; }
pgq() { dr exec -i "$PGC" psql -U "$SU" -d "$DB" -X -q -A -t -v ON_ERROR_STOP=1 "$@"; }

a4_postgres() {
  hdr "A4 Postgres: restore the newest superuser dump into a throwaway ROOTFUL cluster"
  SU="$(envget POSTGRES_SUPERUSER)"; DB="$(envget POSTGRES_DB)"
  local OWN MIG APP OWNP MIGP APPP
  OWN="$(envget POSTGRES_OWNER_USER)"; MIG="$(envget POSTGRES_MIGRATOR_USER)"; APP="$(envget POSTGRES_APP_USER)"
  OWNP="$(envget POSTGRES_OWNER_PASSWORD)"; MIGP="$(envget POSTGRES_MIGRATOR_PASSWORD)"; APPP="$(envget POSTGRES_APP_PASSWORD)"
  local x
  for x in "$SU" "$DB" "$OWN" "$MIG" "$APP"; do is_ident "$x" || die "a role or database name in the proof env is not a plain identifier"; done
  [ -n "$OWNP" ] && [ -n "$MIGP" ] && [ -n "$APPP" ] || die "a proof role password is empty"

  rf_vol_create "$V_PG" >/dev/null && pass "rootful throwaway volume $V_PG created" || die "cannot create $V_PG"
  local pgenv
  pgenv="$(mk_envfile "POSTGRES_USER=$SU" "POSTGRES_PASSWORD=$(envget POSTGRES_SUPERUSER_PASSWORD)" "POSTGRES_DB=$DB")"
  rf_run "$PGC" -d --network none --cpus 0.5 --memory 1g --pids-limit 256 --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID --security-opt no-new-privileges:true \
    --env-file "$pgenv" -v "$V_PG:/var/lib/postgresql/data" "$PG_IMG" >/dev/null || die "cannot start the throwaway postgres"
  wait_until 120 pg_throwaway_ready && pass "throwaway postgres is up (same digest, --network none)" || die "the throwaway postgres never became ready"

  # globals: drop the lines that (re)create / re-key the bootstrap superuser itself
  local kept dropped
  dropped="$(gzip -dc "$GLOBALS_F" | grep -cE "^(CREATE|ALTER) ROLE \"?$SU\"?([ ;]|$)" || true)"
  [ "${dropped:-0}" -ge 1 ] && pass "globals: $dropped line(s) about the bootstrap superuser '$SU' skipped" || fail "globals: no CREATE/ALTER ROLE line for the superuser '$SU' found (is POSTGRES_SUPERUSER the live one?)"
  gzip -dc "$GLOBALS_F" | grep -vE "^(CREATE|ALTER) ROLE \"?$SU\"?([ ;]|$)" \
    | dr exec -i "$PGC" psql -U "$SU" -d "$DB" -X -q -v ON_ERROR_STOP=0 >"$W/globals.out" 2>&1
  kept="$(grep -c 'ERROR' "$W/globals.out" || true)"
  if [ "${kept:-0}" = 0 ]; then pass "globals restored with no ERROR"; else fail "globals restore reported $kept ERROR line(s):"; grep 'ERROR' "$W/globals.out" | head -n 5 | cut -c1-160 | sed 's/^/        /'; fi

  gzip -dc "$DUMP_F" | dr exec -i "$PGC" psql -U "$SU" -d "$DB" -X -q -v ON_ERROR_STOP=1 >"$W/dump.out" 2>&1
  if [ "${PIPESTATUS[1]}" = 0 ]; then pass "dump restored with ON_ERROR_STOP"; else fail "dump restore stopped on an error:"; grep 'ERROR' "$W/dump.out" | head -n 3 | cut -c1-160 | sed 's/^/        /'; die "cannot continue without the restored database"; fi

  # roles: proof passwords (statements travel on stdin); webdesk_backup stays exactly as it arrived.
  pgq <<SQL >/dev/null && pass "owner, migrator and app roles re-keyed to the proof passwords; DB-level grants as init-roles.sh sets them" || fail "ALTER ROLE / DB grants failed"
ALTER ROLE "$OWN" WITH PASSWORD '$OWNP';
ALTER ROLE "$MIG" WITH PASSWORD '$MIGP';
ALTER ROLE "$APP" WITH PASSWORD '$APPP';
ALTER DATABASE "$DB" OWNER TO "$OWN";
REVOKE ALL ON DATABASE "$DB" FROM PUBLIC;
GRANT CONNECT ON DATABASE "$DB" TO "$MIG", "$APP", webdesk_backup;
SQL

  # NO delivery to a real customer endpoint from a daemon that can reach the internet
  local n_all n_on
  n_all="$(pgq -c "UPDATE public.tenant_webhooks SET enabled = false RETURNING 1" | grep -c . || true)"
  n_on="$(pgq -c "SELECT count(*) FROM public.tenant_webhooks WHERE enabled")"
  if [ "$n_on" = 0 ]; then pass "tenant webhooks disabled in the copy ($n_all row(s) updated; 0 enabled remain)"; else fail "$n_on tenant webhook(s) are STILL enabled in the copy"; fi
  info "columns whose name suggests an outbound target (review: names only): $(pgq -c "SELECT string_agg(table_name || '.' || column_name, ' ' ORDER BY table_name, column_name) FROM information_schema.columns WHERE table_schema = 'public' AND column_name ~* '(url|webhook|callback|endpoint|hook)'")"

  pgq -c "$COUNTS_SQL" >"$EV/counts.rootful.txt"
  local nt tn
  nt="$(grep -c . "$EV/counts.rootful.txt" || true)"
  tn="$(awk '$1 == "tenants" { print $2 }' "$EV/counts.rootful.txt")"
  if [ "${nt:-0}" -gt 0 ] && [ "${tn:-0}" -gt 0 ]; then pass "row counts recorded: $nt tables, tenants=$tn (-> $EV/counts.rootful.txt)"; else fail "row counts look empty (tables=$nt, tenants=${tn:-none})"; fi

  rf_stop "$PGC" -t 120 >/dev/null
  local pg_exit pg_tail
  pg_exit="$(dr inspect -f '{{.State.ExitCode}}' "$PGC" 2>/dev/null)"
  pg_tail="$(dr logs --tail 3 "$PGC" 2>&1 | tr '\n' '|')"
  if [ "$pg_exit" = 0 ] && dr logs "$PGC" 2>&1 | grep -c 'database system is shut down' >/dev/null; then pass "postgres stopped cleanly (fast shutdown, exit 0)"; else fail "postgres did not stop cleanly (exit ${pg_exit:-?}; last log lines: ${pg_tail})"; fi

  copy_vol "$V_PG" || return 1

  STARTED_PROOF=1
  wdc up -d --no-build --no-deps postgres >/dev/null 2>&1 || { fail "cannot start the copied postgres on the proof daemon"; return 1; }
  wait_until 120 proof_healthy wdproof-postgres-1 && pass "the COPIED cluster starts on the proof daemon and is healthy" || { fail "the copied cluster is not healthy on the proof daemon"; return 1; }
  dp exec wdproof-postgres-1 psql -U "$SU" -d "$DB" -X -A -t -c "$COUNTS_SQL" >"$EV/counts.proof-a4.txt" 2>/dev/null
  if diff -q "$EV/counts.rootful.txt" "$EV/counts.proof-a4.txt" >/dev/null; then pass "per-table row counts on the proof daemon equal the rootful ones ($nt tables)"; else fail "row counts differ after the copy:"; diff "$EV/counts.rootful.txt" "$EV/counts.proof-a4.txt" | head -n 10 | sed 's/^/        /'; fi
  [ "$(dp exec wdproof-postgres-1 psql -U "$SU" -d "$DB" -X -A -t -c 'SELECT count(*) FROM public.tenant_webhooks WHERE enabled' 2>/dev/null)" = 0 ] \
    && pass "no tenant webhook is enabled on the proof copy" || fail "an enabled tenant webhook exists on the proof copy"
  wdc stop postgres >/dev/null 2>&1
}

a4_rustfs() {
  hdr "A4 RustFS: throwaway rootful RustFS, bootstrap, one object x2 with retention, copy, compare"
  local rfenv
  rf_net_create "$NET" >/dev/null && pass "rootful throwaway network $NET (internal: no route out)" || die "cannot create $NET"
  rf_vol_create "$V_RF" >/dev/null && pass "rootful throwaway volume $V_RF created" || die "cannot create $V_RF"
  rfenv="$(mk_envfile RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD)"
  rf_run "$RFC" -d --network "$NET" --cpus 0.5 --memory 512m --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges:true \
    --env-file "$rfenv" -v "$V_RF:/data" "$RUSTFS_IMG" >/dev/null || die "cannot start the throwaway rustfs"
  wait_until 90 dr exec "$RFC" curl -fsS http://127.0.0.1:9000/health && pass "throwaway rustfs answers /health" || die "the throwaway rustfs never became healthy"

  CLENV="$(mk_envfile RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY WEBDESK_BACKUP_ACCESS_KEY_ID \
    WEBDESK_BACKUP_SECRET_ACCESS_KEY STORAGE_BUCKET_MEDIA STORAGE_BUCKET_VIDEO STORAGE_BUCKET_UPLOADS STORAGE_BUCKET_ARTIFACTS WEBDESK_BACKUP_BUCKET \
    WEBDESK_STORAGE_LOCK_DAYS STORAGE_REGION "STORAGE_ENDPOINT=http://$RFC:9000")"

  local out last
  out="$(bootstrap rootful "$NET" 2>&1)"
  last="$(printf '%s\n' "$out" | tail -n 1)"
  if [[ "$last" =~ ^STORAGE_BOOTSTRAP\ changes=([0-9]+)$ ]] && [ "${BASH_REMATCH[1]}" -gt 0 ]; then pass "storage-bootstrap.mjs on the throwaway: $last"; else fail "storage-bootstrap.mjs did not finish cleanly; last lines:"; printf '%s\n' "$out" | tail -n 4 | cut -c1-200 | sed 's/^/        /'; return 1; fi

  out="$(s3run rootful "$NET" write 2>&1)" || { fail "writing the object failed: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ' | cut -c1-200)"; return 1; }
  printf '%s\n' "$out" >"$EV/rustfs.written.json"
  pass "object written twice with object-lock retention: $(printf '%s' "$out" | tr -d '\n' | sed -E 's/"versionId":"[^"]*"/"versionId":"…"/g' | cut -c1-160)"
  s3run rootful "$NET" dump >"$EV/rustfs.before.json" 2>"$W/s3dump.err" || { fail "ListObjectVersions / GetObjectRetention failed: $(tail -n 2 "$W/s3dump.err" | tr '\n' ' ')"; return 1; }
  local nv
  nv="$(grep -c '"VersionId"' "$EV/rustfs.before.json" || true)"
  if [ "$nv" = 2 ] && grep -q '"RetainUntilDate": "' "$EV/rustfs.before.json"; then pass "before: 2 versions, each with a retain-until date (-> $EV/rustfs.before.json)"; else fail "before: expected 2 versions with retention, found $nv"; fi

  rf_stop "$RFC" -t 30 >/dev/null && pass "throwaway rustfs stopped" || fail "could not stop the throwaway rustfs"
  copy_vol "$V_RF" || return 1

  STARTED_PROOF=1
  wdc up -d --no-build --no-deps rustfs >/dev/null 2>&1 || { fail "cannot start the copied rustfs on the proof daemon"; return 1; }
  wait_until 120 proof_healthy wdproof-rustfs-1 && pass "the COPIED rustfs starts on the proof daemon and is healthy" || { fail "the copied rustfs is not healthy"; return 1; }
  sed -i "s#^STORAGE_ENDPOINT=.*#STORAGE_ENDPOINT=http://rustfs:9000#" "$CLENV"
  s3run proof "${PROOF_PROJECT}_default" dump >"$EV/rustfs.after.json" 2>"$W/s3dump2.err" || { fail "after-copy list failed: $(tail -n 2 "$W/s3dump2.err" | tr '\n' ' ')"; return 1; }
  if diff -u "$EV/rustfs.before.json" "$EV/rustfs.after.json" >"$W/rustfs.diff"; then
    pass "ListObjectVersions + GetObjectRetention IDENTICAL before and after (version ids, retain-until, sizes, etags, last-modified)"
  else
    fail "RustFS answers differ after the copy:"; head -n 20 "$W/rustfs.diff" | sed 's/^/        /'
  fi
  out="$(bootstrap proof "${PROOF_PROJECT}_default" 2>&1)"
  last="$(printf '%s\n' "$out" | tail -n 1)"
  if [ "$last" = "STORAGE_BOOTSTRAP changes=0" ]; then pass "storage-bootstrap.mjs against the COPY: changes=0 (buckets, lock, policies, service users all carried)"; else fail "storage-bootstrap.mjs against the copy: '$last' (expected changes=0)"; printf '%s\n' "$out" | tail -n 3 | cut -c1-200 | sed 's/^/        /'; fi
  wdc stop rustfs >/dev/null 2>&1
}

a4_redis() {
  hdr "A4 Redis: a delayed BullMQ-shaped job survives the copy"
  rf_vol_create "$V_RD" >/dev/null && pass "rootful throwaway volume $V_RD created" || die "cannot create $V_RD"
  rf_run "$RDC" -d --network none --cpus 0.2 --memory 256m --pids-limit 128 --cap-drop ALL --cap-add CHOWN --cap-add SETGID --cap-add SETUID \
    --security-opt no-new-privileges:true -v "$V_RD:/data" "$REDIS_IMG" >/dev/null || die "cannot start the throwaway redis"
  wait_until 30 rf_redis_up && pass "throwaway redis is up (compose service shape: no command, no config)" || die "the throwaway redis never answered"
  local now due score id=a4rehearsal1
  now="$(date +%s%3N)"; due=$((now + 86400000)); score=$((due * 4096))
  dr exec "$RDC" redis-cli ZADD bull:webdesk-mail:delayed "$score" "$id" >/dev/null
  dr exec "$RDC" redis-cli HSET "bull:webdesk-mail:$id" name send-mail \
    data '{"to":"a4-rehearsal@example.invalid","subject":"A4 rehearsal"}' opts '{"delay":86400000,"attempts":5}' \
    timestamp "$now" delay 86400000 priority 0 atm 0 >/dev/null
  [ "$(dr exec "$RDC" redis-cli SAVE)" = OK ] && pass "delayed job written (due in ~1 day, so nothing fires) and SAVEd" || fail "redis SAVE failed"
  { dr exec "$RDC" redis-cli ZRANGE bull:webdesk-mail:delayed 0 -1 WITHSCORES; dr exec "$RDC" redis-cli HGETALL "bull:webdesk-mail:$id" | paste - - | sort; } >"$EV/redis.before.txt"
  [ "$(grep -c . "$EV/redis.before.txt")" -ge 8 ] && pass "recorded the zset member and the job hash (-> $EV/redis.before.txt)" || fail "the job did not land"
  rf_stop "$RDC" -t 30 >/dev/null && pass "throwaway redis stopped (SIGTERM, saves)" || fail "could not stop the throwaway redis"
  copy_vol "$V_RD" || return 1

  STARTED_PROOF=1
  wdc up -d --no-build --no-deps redis >/dev/null 2>&1 || { fail "cannot start the copied redis on the proof daemon"; return 1; }
  wait_until 60 proof_redis_up && pass "the COPIED redis starts on the proof daemon" || { fail "the copied redis does not answer"; return 1; }
  { dp exec wdproof-redis-1 redis-cli ZRANGE bull:webdesk-mail:delayed 0 -1 WITHSCORES; dp exec wdproof-redis-1 redis-cli HGETALL "bull:webdesk-mail:$id" | paste - - | sort; } >"$EV/redis.after.txt"
  if diff -u "$EV/redis.before.txt" "$EV/redis.after.txt" >"$W/redis.diff"; then pass "the delayed job (zset member + score + hash) is IDENTICAL after the copy"; else fail "the delayed job differs after the copy:"; head -n 12 "$W/redis.diff" | sed 's/^/        /'; fi
  wdc stop redis >/dev/null 2>&1
}

main() {
  case "${1:-}" in
    reset) shift; do_reset "$@"; return ;;
    "") ;;
    *) die "usage: $0 [reset --yes]" ;;
  esac
  preflight
  create_proof_volumes
  a4_postgres
  a4_rustfs
  a4_redis

  hdr "leave the proof project clean for A5"
  wdc stop >/dev/null 2>&1 && pass "the single-service proof starts are stopped (volumes and containers stay)" || fail "wdc stop failed"
  STARTED_PROOF=0
  info "evidence: $EV"
  info "KEPT for A5: proof volumes $V_PG $V_RF $V_RD (project $PROOF_PROJECT)"
  info "KEPT until A9 (rootful throwaway volumes): $V_PG $V_RF $V_RD   <- remove with A9 / 'a4-copy-rehearsal.sh reset --yes'"
  info "next: bash $HERE/a5-stack.sh"
  summary
}

main "$@"
