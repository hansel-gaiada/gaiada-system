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

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
