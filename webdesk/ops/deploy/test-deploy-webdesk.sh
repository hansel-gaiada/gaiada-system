#!/usr/bin/env bash
# Unit tests for the pure parts of deploy-webdesk.sh. No box, no real docker: a fake `docker` on PATH
# answers the two calls the helpers make. Run:  bash webdesk/ops/deploy/test-deploy-webdesk.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
PASS=0 FAIL=0
t_ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
t_bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
assert() { # <description> <command...>
  local d=$1
  shift
  if "$@"; then t_ok "$d"; else t_bad "$d"; fi
}
refute() {
  local d=$1
  shift
  if "$@"; then t_bad "$d"; else t_ok "$d"; fi
}

quiet() { "$@" >/dev/null 2>&1; }

# --- fake docker ---------------------------------------------------------------------------------------------
mkdir -p "$T/bin"
cat >"$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  "inspect --format {{.Image}} webdesk-api-1") echo "${FAKE_IMAGE_ID:-}"; [ -n "${FAKE_IMAGE_ID:-}" ] || exit 1 ;;
  "inspect --format {{.Config.Image}} webdesk-api-1") echo "${FAKE_IMAGE_REF:-webdesk-api:latest}" ;;
  compose\ *) echo "COMPOSE DOCKER_HOST=${DOCKER_HOST:-} IMG=${WEBDESK_API_IMAGE:-} $*" ;;
  *) echo "fake docker: unexpected call: $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH"

export WEBDESK_SUDO="" WEBDESK_ENV_FILE="$T/env" WEBDESK_DIR="$T/proj" HOME="$T/home"
mkdir -p "$T/proj" "$T/home"
# shellcheck disable=SC1091
. "$HERE/deploy-webdesk.sh"
set +e # the script sets -e for itself; the harness wants to keep going after a failed assertion

D1="sha256:$(printf 'a%.0s' $(seq 64))"
D2="sha256:$(printf 'b%.0s' $(seq 64))"

echo "== digest vs image id"
FAKE_IMAGE_ID="$D1" assert "running id read through (fake) docker inspect" test "$(FAKE_IMAGE_ID=$D1 running_image_id)" = "$D1"
assert "same id and digest -> no swap needed" image_matches_digest "$D1" "$D1"
refute "different id and digest -> refuse" image_matches_digest "$D2" "$D1"
refute "empty id is never a match" image_matches_digest "" "$D1"
assert "digest shape accepted" valid_digest "$D1"
refute "short digest refused" valid_digest "sha256:abc"
refute "tag with a slash refused" valid_tag "v1/../x"
assert "release tag accepted" valid_tag "v1.0.0-alpha.352"

echo "== CR refusal"
mkdir -p "$T/tree/scripts"
printf 'ok\nline\n' >"$T/tree/scripts/clean.sh"
assert "a clean tree passes" quiet check_no_cr "$T/tree"
printf 'bad\r\nline\r\n' >"$T/tree/scripts/planted.sh"
OUT="$(check_no_cr "$T/tree")"
refute "a planted CR file is refused" quiet check_no_cr "$T/tree"
assert "the offender is named" grep -q 'planted.sh' <<<"$OUT"
refute "the clean file is not named" grep -q 'clean.sh' <<<"$OUT"

echo "== pending migrations"
mkdir -p "$T/mig"
for f in 0001_a.sql 0002_b.sql 0003_c.sql migrate.mjs README.md; do : >"$T/mig/$f"; done
printf '0001_a.sql\n0002_b.sql\n' >"$T/ledger"
assert "only the file missing from the ledger is pending" test "$(pending_migrations "$T/mig" "$T/ledger")" = "0003_c.sql"
: >"$T/ledger"
assert "an empty ledger makes everything pending" test "$(pending_migrations "$T/mig" "$T/ledger" | wc -l | tr -d ' ')" = 3

echo "== env rewrite helper (replace, append, never prints values)"
SECRET_A="s3cr3t-value-AAA"
SECRET_B="s3cr3t-value-BBB"
printf 'KEEP=1\nWEBDESK_API_IMAGE=old-value-xyz\nOTHER="quoted value"\n' >"$T/env"
OUT="$(set_env_var "$T/env" WEBDESK_API_IMAGE "$SECRET_A" 2>&1)"
assert "replace: prints nothing" test -z "$OUT"
assert "replace: line carries the new value" grep -qx "WEBDESK_API_IMAGE=$SECRET_A" "$T/env"
refute "replace: the old value is gone" grep -q 'old-value-xyz' "$T/env"
assert "replace: exactly one such line" test "$(grep -c '^WEBDESK_API_IMAGE=' "$T/env")" = 1
assert "replace: other lines untouched" grep -qx 'OTHER="quoted value"' "$T/env"
printf 'KEEP=1\n' >"$T/env"
OUT="$(set_env_var "$T/env" WEBDESK_API_IMAGE "$SECRET_B" 2>&1)"
assert "append: prints nothing" test -z "$OUT"
assert "append: line added" grep -qx "WEBDESK_API_IMAGE=$SECRET_B" "$T/env"
assert "append: KEEP still there" grep -qx 'KEEP=1' "$T/env"
printf 'KEEP=1' >"$T/env" # no trailing newline
set_env_var "$T/env" WEBDESK_API_IMAGE x >/dev/null 2>&1
assert "append after a file with no trailing newline keeps both lines" test "$(wc -l <"$T/env" | tr -d ' ')" = 2
printf 'A=1\nWEBDESK_API_IMAGE=v\nB=2\n' >"$T/env"
remove_env_var "$T/env" WEBDESK_API_IMAGE
refute "remove: key gone" grep -q '^WEBDESK_API_IMAGE=' "$T/env"
assert "remove: others kept" test "$(grep -c . "$T/env")" = 2
OUT="$(env_key_names)"
assert "key names listed without values" test "$OUT" = "$(printf 'A\nB')"

echo "== tools env file (subset, unquoted, DB host re-pointed, nothing printed)"
cat >"$T/env" <<'EOF'
# a comment
POSTGRES_SUPERUSER_PASSWORD=never-copied-pw
MIGRATE_DATABASE_URL=postgres://webdesk_migrator:pw1@localhost:8383/webdesk
OWNER_DATABASE_URL="postgres://webdesk_owner:pw2@127.0.0.1:8383/webdesk?sslmode=disable"
RUSTFS_ROOT_PASSWORD='quoted-root-pw'
STORAGE_ENDPOINT=http://rustfs:9000
EOF
OUT="$(make_tools_envfile "$T/tools.env" 2>&1)"
assert "prints nothing" test -z "$OUT"
assert "DB host re-pointed for the migrator" grep -qx 'MIGRATE_DATABASE_URL=postgres://webdesk_migrator:pw1@postgres:5432/webdesk' "$T/tools.env"
assert "owner URL unquoted, host re-pointed, query kept" grep -qx 'OWNER_DATABASE_URL=postgres://webdesk_owner:pw2@postgres:5432/webdesk?sslmode=disable' "$T/tools.env"
assert "single quotes stripped" grep -qx 'RUSTFS_ROOT_PASSWORD=quoted-root-pw' "$T/tools.env"
refute "keys outside the allowlist are not copied" grep -q 'never-copied-pw' "$T/tools.env"
assert "storage endpoint passes through" grep -qx 'STORAGE_ENDPOINT=http://rustfs:9000' "$T/tools.env"

echo "== already_current (WEBDESK_SKIP_IF_CURRENT: release.yml's automatic path)"
D=sha256:$(printf '%064d' 7)
REL="/x/docker-compose.yml,/x/docker-compose.aicenter.yml,/x/docker-compose.aicenter-release.yml"
mkdir -p "$T/ac/stage/migrations" "$T/ac/live/migrations"
printf 'a\n' >"$T/ac/stage/migrations/0001.sql"; printf 'a\n' >"$T/ac/live/migrations/0001.sql"
printf 'c\n' >"$T/ac/stage/docker-compose.yml"; printf 'c\n' >"$T/ac/live/docker-compose.yml"
ln -s /nowhere "$T/ac/stage/.env.control" 2>/dev/null || true
: >"$T/ac/pending"
assert "same digest, release overlay, no pending, same tree -> current" already_current "$D" "$D" "$REL" "$T/ac/pending" "$T/ac/stage" "$T/ac/live"
refute "a different running image -> not current" already_current "sha256:$(printf '%064d' 8)" "$D" "$REL" "$T/ac/pending" "$T/ac/stage" "$T/ac/live"
refute "running from the two-file (local) arrangement -> not current" already_current "$D" "$D" "/x/docker-compose.yml,/x/docker-compose.aicenter.yml" "$T/ac/pending" "$T/ac/stage" "$T/ac/live"
echo "0015_x.sql" >"$T/ac/pending2"
refute "a pending migration -> not current" already_current "$D" "$D" "$REL" "$T/ac/pending2" "$T/ac/stage" "$T/ac/live"
refute "no pending-migrations file (ledger unread) -> not current" already_current "$D" "$D" "$REL" "$T/ac/missing" "$T/ac/stage" "$T/ac/live"
printf 'changed\n' >"$T/ac/stage/docker-compose.yml"
refute "a changed release file -> not current" already_current "$D" "$D" "$REL" "$T/ac/pending" "$T/ac/stage" "$T/ac/live"
printf 'c\n' >"$T/ac/stage/docker-compose.yml"; printf 'b\n' >"$T/ac/stage/migrations/0002.sql"
refute "a file only the release has -> not current" already_current "$D" "$D" "$REL" "$T/ac/pending" "$T/ac/stage" "$T/ac/live"

echo "== M4 F6: which daemon (WEBDESK_DOCKER_HOST, else the host switch file, else rootful)"
SOCK=unix:///run/user/940/docker.sock
SW="$T/webdesk-docker"
wdh() { (unset WEBDESK_DOCKER_HOST; export WEBDESK_DOCKER_SWITCH="$SW"; wd_docker_host); }
wdh_env() { (export WEBDESK_DOCKER_SWITCH="$SW" WEBDESK_DOCKER_HOST="$1"; wd_docker_host); }
rm -f "$SW"
assert "no variable, no switch file -> rootful (empty)" test "$(wdh)" = ""
assert "  ... and that is a success, not an error" quiet wdh
printf '# written at the cut-over\nWEBDESK_DOCKER_HOST=%s\n' "$SOCK" >"$SW"
assert "switch file -> its socket" test "$(wdh)" = "$SOCK"
printf 'WEBDESK_DOCKER_HOST=unix:///run/user/941/docker.sock\nWEBDESK_DOCKER_HOST="%s"\n' "$SOCK" >"$SW"
assert "switch file: the last line wins, quotes stripped" test "$(wdh)" = "$SOCK"
assert "an explicit empty variable beats the switch file (explicitly rootful)" test "$(wdh_env "")" = ""
assert "an explicit variable beats the switch file" test "$(wdh_env unix:///run/user/941/docker.sock)" = "unix:///run/user/941/docker.sock"
refute "tcp:// is refused" quiet wdh_env tcp://127.0.0.1:2375
refute "the rootful socket path is refused" quiet wdh_env unix:///var/run/docker.sock
refute "a non-numeric uid is refused" quiet wdh_env unix:///run/user/abc/docker.sock
refute "uid 0 is refused" quiet wdh_env unix:///run/user/0/docker.sock
refute "a path escape is refused" quiet wdh_env unix:///run/user/940/../0/docker.sock
printf 'WEBDESK_DOCKER_HOST=unix:///tmp/evil.sock\n' >"$SW"
refute "a malformed switch file is refused, never silently rootful" quiet wdh
assert "project name webdesk accepted" valid_project webdesk
assert "project name wdproof accepted" valid_project wdproof
refute "project name with a slash refused" valid_project "web/desk"
refute "upper-case project name refused" valid_project "WebDesk"
assert "default project is webdesk, network webdesk_default, api webdesk-api-1" test "$PROJECT $NET $API_CT $PG_CT" = "webdesk webdesk_default webdesk-api-1 webdesk-postgres-1"
assert "WEBDESK_PROJECT=wdproof derives every name from it" test "$(WEBDESK_PROJECT=wdproof bash -c '. "$1"; echo "$PROJECT $NET $API_CT $PG_CT"' _ "$HERE/deploy-webdesk.sh" 2>/dev/null)" = "wdproof wdproof_default wdproof-api-1 wdproof-postgres-1"
unset DOCKER_HOST
F3="-f docker-compose.yml -f docker-compose.aicenter.yml -f docker-compose.aicenter-release.yml"
WD_DOCKER_HOST=""
assert "compose, rootful: no DOCKER_HOST reaches docker (unchanged behaviour)" \
  test "$(compose "$T/proj" 1 img@x config -q)" = "COMPOSE DOCKER_HOST= IMG=img@x compose --env-file $T/env -p webdesk $F3 config -q"
WD_DOCKER_HOST="$SOCK"
assert "compose, rootless: the socket is passed through (sudo) env explicitly" \
  test "$(compose "$T/proj" 1 img@x config -q)" = "COMPOSE DOCKER_HOST=$SOCK IMG=img@x compose --env-file $T/env -p webdesk $F3 config -q"
assert "compose, rootless, two-file form: the socket still reaches docker, no image pin" \
  test "$(compose "$T/proj" 0 "" ps)" = "COMPOSE DOCKER_HOST=$SOCK IMG= compose --env-file $T/env -p webdesk -f docker-compose.yml -f docker-compose.aicenter.yml ps"
WD_DOCKER_HOST=""

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
