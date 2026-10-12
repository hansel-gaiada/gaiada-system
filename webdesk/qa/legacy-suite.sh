#!/usr/bin/env bash
# WSK-18 / M4-T5 -- the `legacy` suite of linux-gate.sh: the August-era WebDesk checks nothing else ran.
# Runs INSIDE the gate's node runner. Every step prints exactly one machine-readable line, so
# linux-gate.sh can put each in the summary and none is silently absent:
#   LEGACY-STEP PASS <name> <secs>s
#   LEGACY-STEP FAIL <name> <secs>s rc=<n>
#   LEGACY-STEP SKIP <name>: <reason>
# Exit code is 1 if any step FAILed, else 0. A SKIP never counts as a pass and is always named.
#
# Environment (all optional, set by linux-gate.sh):
#   SUPERUSER_DATABASE_URL MIGRATE_DATABASE_URL APP_DATABASE_URL   the migrated gate database
#   STORAGE_ENDPOINT RUSTFS_ROOT_USER RUSTFS_ROOT_PASSWORD         the gate's RustFS (c4)
#   LEGACY_NO_DB=1     no database or object store in this run (local Node check): the steps that
#                      need them print SKIP, everything else runs.
#   LEGACY_DOCKER_SOCKET=1  the runner has the docker CLI + host socket (gate --with-docker-socket): the
#                      cross-machine determinism run (c1) starts its own two containers. Without it: SKIP.
set -uo pipefail

REPO="${LEGACY_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
WD="$REPO/webdesk"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAILS=0
NO_DB="${LEGACY_NO_DB:-0}"
SOCKET="${LEGACY_DOCKER_SOCKET:-0}"

# step <name> <command...>   (the command runs in a subshell; its output is shown, then the status line)
step() {
  local name="$1" t0 rc=0
  shift
  echo "##### $name"
  t0=$SECONDS
  ( set -eo pipefail; "$@" ) || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "LEGACY-STEP PASS $name $((SECONDS - t0))s"
  else
    FAILS=$((FAILS + 1))
    echo "LEGACY-STEP FAIL $name $((SECONDS - t0))s rc=$rc"
  fi
}
skip() { echo "##### $1"; echo "LEGACY-STEP SKIP $1: $2"; }
need_db() { # <name>: returns 0 when the step may run, else prints SKIP and returns 1
  if [ "$NO_DB" = 1 ] || [ -z "${APP_DATABASE_URL:-}" ] || [ -z "${SUPERUSER_DATABASE_URL:-}" ]; then
    skip "$1" "needs the gate database (LEGACY_NO_DB or URLs unset)"
    return 1
  fi
  return 0
}

# ---- 1. WSK-14 / WSK-64 delivery tests (no database; need `npm ci` in webdesk/api for tsx) ----
dv() { ( cd "$WD/api" && node --import tsx "../delivery/test/$1" ); }
step wsk14-breaking-change dv wsk14-breaking-change.test.mjs
step wsk14-composition-validator dv wsk14-composition-validator.test.mjs
step wsk14-renderer-invariant dv wsk14-renderer-invariant.test.mjs
# wsk64-snapshot-probe is a CLI that prints the vocabulary snapshot as JSON (the classifier test imports it);
# the step proves it still loads, runs against the live vocabulary and emits parseable, non-empty JSON.
probe() {
  ( cd "$WD/api" && node --import tsx ../delivery/test/wsk64-snapshot-probe.mjs > "$TMP/snap.json" )
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!s.vocabularyVersion||!s.primitives.length||!s.blocks)process.exit(1);console.log("snapshot ok, vocabulary "+s.vocabularyVersion)' "$TMP/snap.json"
}
step wsk64-snapshot-probe probe

# ---- 2. WSK-03/04 cross-path tenancy suite (rls.spec.sql's 15 PASS notices + api content routes + RLS integrity) ----
wsk04() { ( cd "$WD" && node scripts/wsk04-cross-path-suite.mjs ); }
if need_db wsk04-cross-path-suite; then step wsk04-cross-path-suite wsk04; fi

# ---- 3. WSK-18 P3 gate c2 / c3 (DB-free: artifacts come from the static fixtures) ----
c2() {
  ( cd "$WD/api" && node ../scripts/check-contract-coherence.mjs --selftest )
  for t in acme globex; do
    ( cd "$WD/api" && node --import tsx ../qa/p3-gate/generate-fixture-artifacts.mts --tenant "$t" --out "$TMP/art-$t" )
    node "$WD/scripts/check-contract-coherence.mjs" --dir "$TMP/art-$t"
  done
}
step c2-contract-coherence c2
c3() {
  ( cd "$WD/api" && node --import tsx ../scripts/check-unknown-block-rejection.mjs --selftest )
  ( cd "$WD/api" && node --import tsx ../scripts/check-unknown-block-rejection.mjs )
}
step c3-unknown-block-rejection c3

# ---- 4. c1 cross-machine determinism, c4 artifact-URL expiry ----
step c1-determinism-selftest node "$WD/scripts/check-determinism-crossmachine.mjs" --selftest
if [ "$SOCKET" = 1 ]; then
  step c1-determinism-crossmachine node "$WD/scripts/check-determinism-crossmachine.mjs" --docker --tenants acme,globex
else
  skip c1-determinism-crossmachine "needs the docker socket (it starts two independent node containers itself; rerun the gate with --with-docker-socket)"
fi
step c4-artifact-url-expiry-selftest node "$WD/scripts/check-artifact-url-expiry.mjs" --selftest
c4() { # the gate's own RustFS, root credentials (the script creates its own probe bucket)
  STORAGE_ACCESS_KEY_ID="$RUSTFS_ROOT_USER" STORAGE_SECRET_ACCESS_KEY="$RUSTFS_ROOT_PASSWORD" \
    node "$WD/scripts/check-artifact-url-expiry.mjs"
}
if [ "$NO_DB" = 1 ] || [ -z "${STORAGE_ENDPOINT:-}" ] || [ -z "${RUSTFS_ROOT_USER:-}" ]; then
  skip c4-artifact-url-expiry "needs the gate's RustFS (STORAGE_ENDPOINT/RUSTFS_ROOT_* unset or LEGACY_NO_DB)"
else
  step c4-artifact-url-expiry c4
fi

# ---- 5. WSK-15 codegen double-run gate against the gate database (seeds two throwaway tenants, removes them) ----
codegen() {
  local rc=0
  ( cd "$WD" && SEED_DATABASE_URL="$SUPERUSER_DATABASE_URL" node qa/legacy-seed-tenants.mjs seed ) || return 1
  ( cd "$WD/api" && npm run codegen:gate -- --tenants qa-p3-acme,qa-p3-globex ) || rc=$?
  ( cd "$WD" && SEED_DATABASE_URL="$SUPERUSER_DATABASE_URL" node qa/legacy-seed-tenants.mjs clean ) || rc=$?
  return $rc
}
if need_db wsk15-codegen-gate; then step wsk15-codegen-gate codegen; fi

# ---- 5b. M6-P4r-a: the COMPILED generator (dist/codegen/generator.mjs, the one the api image ships) ----
# DB-free: bundles the generator, then generates the acme/globex fixtures twice with plain `node` (no tsx)
# in two separate processes, byte-compares them, and byte-compares them with the tsx generator's output.
codegen_dist() { ( cd "$WD/api" && npm run codegen:gate:dist ); }
step m6-p4ra-codegen-gate-dist codegen_dist

# ---- 6. webdesk/deploy (CI webdesk-light runs it; the gate did not) ----
deploy() { ( cd "$WD/deploy" && npm ci && npm run typecheck && npm test ); }
step deploy-typecheck-test deploy

# ---- 7. ops checks ----
step ops-check-cdn-bypass-selftest node "$WD/ops/scripts/check-cdn-bypass.mjs" --selftest
step ops-check-otlp-write-only-selftest node "$WD/ops/scripts/check-otlp-write-only.mjs" --selftest
step ops-test-deploy-webdesk bash "$WD/ops/deploy/test-deploy-webdesk.sh"
step ops-test-rootless bash "$WD/ops/host/rootless/test-rootless.sh"   # M4 F6: pure parts, no root/docker

[ "$FAILS" -eq 0 ]
