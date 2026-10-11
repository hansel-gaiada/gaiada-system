#!/usr/bin/env bash
# WebDesk restore drill, box side (M4 T3). Reads a plain `webdesk-*.sql.gz` dump on STDIN, restores it
# into a THROWAWAY postgres:16-alpine with --network none, verifies it, prints timings, removes it.
#
# The laptop side decrypts the offsite copy (the age key lives only on the operator laptop) and pipes
# it here, so plaintext never lands on sumopod and only transits SSH:
#
#   F=$(ssh sumopod 'ls -1 ~/erp-offsite/data/webdesk-*.sql.gz.age | tail -1'); B=$(basename "$F" .age)
#   scp sumopod:"$F" sumopod:"$F.sha256" .
#   age -d -i ~/.ssh/gaiada-backup-age "$B.age" > "$B" && sha256sum -c "$B.age.sha256"   # the line already names $B
#   ssh gda-aicenter 'bash ~/gaiada-webdesk/webdesk/ops/scripts/webdesk-restore-drill.sh' < "$B"
#   shred -u "$B"
#
# Verifies, against the dump itself (COPY blocks) and against FORCE RLS:
#   1. psql applies the whole dump with ON_ERROR_STOP;
#   2. every table's restored row count equals the dump's COPY row count;
#   3. at least one tenant and one content item came back;
#   4. RLS came back with the schema: N tables enabled + forced, and webdesk_app with no tenant GUC
#      reads 0 content items (the policies bite) while the restore superuser reads them all.
# Optional: EXPECT_FORCED_TABLES=<n> (live: count of public tables with RLS enabled AND forced — not the checker's tenant-scoped count) and EXPECT_ITEMS=<n> make 3/4 exact.
set -euo pipefail
IMG="${DRILL_IMAGE:-postgres:16-alpine}"
NAME="m4drill-$(date +%s)"
T0=$(date +%s.%N)
t() { awk -v a="$T0" -v b="$(date +%s.%N)" 'BEGIN{printf "%.1fs", b-a}'; }
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cat > "$WORK/dump.sql.gz"
[ -s "$WORK/dump.sql.gz" ] || fail "nothing on stdin"
gzip -t "$WORK/dump.sql.gz" || fail "stdin is not a valid gzip"
echo "received $(wc -c < "$WORK/dump.sql.gz") bytes  [$(t)]"

# What the dump says it holds: table -> COPY rows.
gzip -dc "$WORK/dump.sql.gz" | awk '
  incopy { if ($0 == "\\.") incopy = 0; else rows[name]++; next }
  /^COPY public\./ { name = $2; sub(/^public\./, "", name); gsub(/"/, "", name); rows[name] += 0; incopy = 1; next }
  END { for (t in rows) print t, rows[t] }' | sort > "$WORK/expected.txt"
echo "dump holds $(wc -l < "$WORK/expected.txt") tables with data blocks"

docker run -d --name "$NAME" --network none --memory 512m --cpus 0.5 --pids-limit 128 \
  -e POSTGRES_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -dc A-Za-z0-9)" -e POSTGRES_DB=webdesk \
  "$IMG" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -q -U postgres -d webdesk 2>/dev/null && break; sleep 1; done
docker exec "$NAME" pg_isready -q -U postgres -d webdesk || fail "throwaway postgres never became ready"
# The dump's GRANTs name the cluster's roles; a real restore target has them (init-roles.sh).
docker exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U postgres -d webdesk <<'SQL'
CREATE ROLE webdesk_owner NOLOGIN NOBYPASSRLS;
CREATE ROLE webdesk_migrator NOLOGIN NOBYPASSRLS;
CREATE ROLE webdesk_app NOLOGIN NOBYPASSRLS;
CREATE ROLE webdesk_backup NOLOGIN BYPASSRLS;
SQL
echo "throwaway ready  [$(t)]"

gzip -dc "$WORK/dump.sql.gz" | docker exec -i "$NAME" psql -q -v ON_ERROR_STOP=1 -U postgres -d webdesk \
  > "$WORK/restore.log" 2>&1 || { tail -5 "$WORK/restore.log" >&2; fail "psql stopped on an error"; }
echo "restored  [$(t)]"

# No `-i`: inside the `while read` loop below, an attached stdin would swallow the loop's input.
q() { docker exec "$NAME" psql -At -U postgres -d webdesk "$@" < /dev/null; }
: > "$WORK/actual.txt"
while read -r tbl _; do
  echo "$tbl $(q -c "SELECT count(*) FROM public.\"$tbl\"")" >> "$WORK/actual.txt"
done < "$WORK/expected.txt"
sort -o "$WORK/actual.txt" "$WORK/actual.txt"
if ! diff -u "$WORK/expected.txt" "$WORK/actual.txt" > "$WORK/diff.txt"; then cat "$WORK/diff.txt" >&2; fail "row counts differ from the dump"; fi
echo "row counts: $(wc -l < "$WORK/actual.txt") tables, every one equal to the dump"

TENANTS=$(awk '$1 == "tenants" {print $2}' "$WORK/actual.txt")
ITEMS=$(awk '$1 == "content_items" {print $2}' "$WORK/actual.txt")
[ "${TENANTS:-0}" -gt 0 ] || fail "zero tenants restored"
[ "${ITEMS:-0}" -gt 0 ] || fail "zero content items restored"
[ -z "${EXPECT_ITEMS:-}" ] || [ "$ITEMS" = "$EXPECT_ITEMS" ] || fail "content_items $ITEMS, expected $EXPECT_ITEMS"
FORCED=$(q -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity")
[ -z "${EXPECT_FORCED_TABLES:-}" ] || [ "$FORCED" = "$EXPECT_FORCED_TABLES" ] || fail "$FORCED forced-RLS tables, expected $EXPECT_FORCED_TABLES"
AS_APP=$(q -c "SET ROLE webdesk_app; SELECT count(*) FROM public.content_items" | tail -1)
[ "$AS_APP" = 0 ] || fail "webdesk_app with no tenant GUC read $AS_APP content items: RLS did not come back"
echo "tenants=$TENANTS content_items=$ITEMS; RLS: $FORCED tables enabled+forced; webdesk_app without a tenant reads 0 of $ITEMS items"
echo "DRILL OK  total $(t)"
