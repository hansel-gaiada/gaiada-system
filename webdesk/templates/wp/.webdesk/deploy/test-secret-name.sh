#!/usr/bin/env bash
# test-secret-name.sh - runs secret-name.sh, the exact code the site workflows call, against the fixture that
# platform-nest's siteDeploySecretName() is also tested against (secret-name.fixture.json). Needs bash and jq.
# (tr -d backslash-r below: a jq built for Windows ends its lines with CRLF; on Linux it is a no-op.)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/secret-name.fixture.json"
fail=0; n=0

while IFS=$'\t' read -r slug env_ id want; do
  n=$((n + 1))
  got="$(bash "$HERE/secret-name.sh" "$slug" "$env_" "$id" 2>/dev/null)"; rc=$?
  if [ "$rc" = 0 ] && [ "$got" = "$want" ]; then echo "PASS  ($slug, $env_, $id) -> $got"
  else echo "FAIL  ($slug, $env_, $id): wanted $want, got '$got' (exit $rc)"; fail=1; fi
done < <(jq -r '.cases[] | [.slug, .environment, (.repositoryId | tostring), .name] | @tsv' "$FIX" | tr -d '\r')

while IFS=$'\t' read -r why slug env_ id; do
  n=$((n + 1))
  out="$(bash "$HERE/secret-name.sh" "$slug" "$env_" "$id" 2>/dev/null)"; rc=$?
  if [ "$rc" = 2 ] && [ -z "$out" ]; then echo "PASS  refused: $why"
  else echo "FAIL  not refused: $why (exit $rc, printed '$out')"; fail=1; fi
done < <(jq -r '.refusals[] | [.why, .slug, .environment, (.repositoryId | tostring)] | @tsv' "$FIX" | tr -d '\r')

# Two sites never share a name: the fixture's own cases are pairwise distinct.
dups="$(jq -r '[.cases[].name] | group_by(.) | map(select(length > 1)) | length' "$FIX")"
if [ "$dups" = 0 ]; then echo "PASS  no two fixture cases share a name"; else echo "FAIL  the fixture repeats a name"; fail=1; fi

if [ "$fail" = 0 ]; then echo "### secret-name PASS ($n cases)"; exit 0; fi
echo "### secret-name FAIL"; exit 1
