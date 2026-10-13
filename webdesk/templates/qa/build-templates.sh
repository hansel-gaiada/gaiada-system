#!/usr/bin/env bash
# M6-P4d2 - a real install + build of both site templates, and of one scaffolded fullstack site, on Linux.
#
# Run inside a node:24-bookworm container (no secrets, no network beyond the npm registry), from a checkout
# or `git -c core.autocrlf=false archive` of the repo root:
#
#   docker run --rm -v "$PWD":/src:ro node:24-bookworm bash /src/webdesk/templates/qa/build-templates.sh /src
#
# Steps (each prints PASS/FAIL; the script exits 1 if any failed, and does not stop at the first failure):
#   1  static-astro: npm install + npm run build         (stub vendor tarballs stand in for the pinned SDK/blocks)
#   2  fullstack-next-nest: npm install                  (workspace: apps/web + apps/api)
#   3  fullstack-next-nest: npm run typecheck
#   4  fullstack-next-nest: npm run build                (next build + tsc)
#   5  scaffolder: one fullstack site (dry-run, the acme fixture) laid over the template
#   6  scaffolded site: npm install
#   7  scaffolded site: typecheck (tsc --noEmit)
#   8  scaffolded site: next build                       (its item/listing pages read content at build time: WEBDESK_HOST points at
#        the local HTTPS content stub, qa/content-stub.mjs, since the SDK module throws without a host)
#   9  scaffolded site: vitest run (offline tests only; the conformance probe self-skips with no WEBDESK_* env)
#   4b, 8b  Tailwind 4 really emitted utilities: a class used in a page (`.p-8`) is in the built CSS (a v4 build with a
#        wrong PostCSS/CSS setup succeeds and silently emits NO utilities)
#   10 npm audit --omit=dev is printed per project (informational, never fails the run)
#   11 (M6-P6f) the deploy job's scripts: the secret-name fixture and the offline script tests (plan.sh, write-stamp.sh,
#        deploy-from-secret.sh against a stub deploy.sh). Needs jq; the node image has none, so it is installed first.
#   12 each template's .webdesk/deploy/ copy equals webdesk/templates/_deploy/ (sync-deploy-scripts.mjs --check)
#   13 each site.yml keeps the credential shape (check-workflows.mjs); actionlint itself is run separately (see README)
#   14 fullstack: WEBDESK_STATIC_EXPORT=1 makes apps/web write a static site (out/index.html, out/404.html)
#   15 (M6-P6m) scaffolded site: WEBDESK_STATIC_EXPORT=1 exports it from fixture content served by the stub: out/index.html, the
#        listing page, a case-study item page per fixture slug (with its title), and the item page of an EMPTY collection builds
#        (its one placeholder renders the 404); the stub's request log proves the build really read through the SDK
set -uo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
WORK="$(mktemp -d)"
STUB_PID=""
trap '[ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$WORK"' EXIT
export CI=1 NEXT_TELEMETRY_DISABLED=1 npm_config_fund=false npm_config_update_notifier=false

FAILED=0
step() { # step <name> <dir> <command...>
  local name="$1" dir="$2"; shift 2
  local log="$WORK/$(echo "$name" | tr -c 'a-zA-Z0-9' _).log"
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    echo "PASS  $name"
  else
    echo "FAIL  $name   (last 25 log lines follow)"; tail -25 "$log" | sed 's/^/      | /'; FAILED=1
    return 1
  fi
}
css_has_utility() { # css_has_utility <apps/web dir> <class>: the built CSS is Tailwind 4 and holds that utility
  local css; css="$(cat "$1"/.next/static/css/*.css 2>/dev/null)"
  [ -n "$css" ] && printf '%s' "$css" | grep -q 'tailwindcss v4' && printf '%s' "$css" | grep -qF ".$2{"
}
copy_tree() { # copy_tree <from> <to>: no node_modules/.next/dist/.git
  mkdir -p "$2"; (cd "$1" && tar --exclude=node_modules --exclude=.next --exclude=dist --exclude=.git -cf - .) | (cd "$2" && tar -xf -)
}

# The scaffolded site reads content at build time through `https://$WEBDESK_HOST/v1/t/<tenant>/...`. Serve fixture content from a local
# HTTPS stub (throwaway self-signed cert, trusted via NODE_EXTRA_CA_CERTS). Only the build steps get these variables (with_stub):
# the offline vitest run (step 9) must still see no WEBDESK_* env.
STUB_PORT=18443
with_stub() { env WEBDESK_HOST="localhost:$STUB_PORT" WEBDESK_API_KEY=gate-fixture-key NODE_EXTRA_CA_CERTS="$WORK/stub.crt" "$@"; }
start_stub() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost" \n    -keyout "$WORK/stub.key" -out "$WORK/stub.crt" >"$WORK/openssl.log" 2>&1 || { cat "$WORK/openssl.log"; return 1; }
  : > "$WORK/stub-requests.log"
  node "$SRC/webdesk/templates/qa/content-stub.mjs" "$STUB_PORT" "$WORK/stub.crt" "$WORK/stub.key" "$WORK/stub-requests.log" >"$WORK/stub.out" 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 50); do grep -q listening "$WORK/stub.out" 2>/dev/null && return 0; sleep 0.1; done
  cat "$WORK/stub.out"; return 1
}
check_export() { # check_export <apps/web dir>: the static export holds the fixture content
  local out="$1/out" f
  for f in index.html case-studies/index.html case-studies/alpha/index.html case-studies/beta/index.html articles/index.html; do
    [ -f "$out/$f" ] || { echo "missing out/$f"; return 1; }
  done
  grep -q "Alpha case study" "$out/case-studies/alpha/index.html" || { echo "out/case-studies/alpha/index.html lacks the fixture title"; return 1; }
  grep -q "Beta case study" "$out/case-studies/index.html" || { echo "out/case-studies/index.html does not list the fixture items"; return 1; }
  [ -f "$out/articles/_none/index.html" ] || { echo "empty collection: no placeholder page out/articles/_none/index.html"; return 1; }
  grep -q "GET /v1/t/[^/]*/caseStudy" "$WORK/stub-requests.log" || { echo "the stub saw no content request: the build did not read through the SDK"; return 1; }
}

export_and_check() { with_stub env WEBDESK_STATIC_EXPORT=1 npm run build && check_export "$PWD"; }

echo "node $(node -v), npm $(npm -v), source $SRC"

# ---- static-astro ------------------------------------------------------------------------------------
copy_tree "$SRC/webdesk/templates/static-astro" "$WORK/astro"
# the template references two vendored tarballs that code.scaffold adds; stub them so a clean install works
for n in blocks sdk; do
  mkdir -p "$WORK/stub/$n" "$WORK/astro/vendor"
  printf '{"name":"@gaiada/webdesk-%s","version":"0.0.0"}\n' "$n" > "$WORK/stub/$n/package.json"
  (cd "$WORK/stub/$n" && npm pack --silent >/dev/null 2>&1 && mv ./*.tgz "$WORK/astro/vendor/webdesk-$n.tgz")
done
step "1  static-astro: npm install + build" "$WORK/astro" bash -c 'npm install --no-audit && npm run build'
( cd "$WORK/astro" && echo "--- audit static-astro (omit dev)" && npm audit --omit=dev 2>&1 | tail -4; echo "--- audit static-astro (all)" && npm audit 2>&1 | tail -4 ) || true

# ---- fullstack-next-nest -----------------------------------------------------------------------------
copy_tree "$SRC/webdesk/templates/fullstack-next-nest" "$WORK/full"
step "2  fullstack-next-nest: npm install" "$WORK/full" npm install --no-audit
step "3  fullstack-next-nest: typecheck" "$WORK/full" npm run typecheck
step "4  fullstack-next-nest: build" "$WORK/full" npm run build
step "4b fullstack-next-nest: built CSS has the .p-8 utility (Tailwind 4)" "$WORK/full" css_has_utility apps/web p-8
( cd "$WORK/full" && echo "--- audit fullstack (omit dev)" && npm audit --omit=dev 2>&1 | tail -4; echo "--- audit fullstack (all)" && npm audit 2>&1 | tail -4 ) || true

# ---- one scaffolded fullstack site ----------------------------------------------------------------------
copy_tree "$SRC" "$WORK/repo"   # the scaffolder reads webdesk/templates and ai-agents sources from this copy
if step "5a ai-agents: npm install (scaffolder deps)" "$WORK/repo/ai-agents" npm install --no-audit \
   && step "5  scaffolder: one fullstack site over the template" "$WORK/repo/ai-agents" \
        npx tsx ../webdesk/templates/qa/scaffold-fullstack-site.mts "$WORK/site"; then
  step "6  scaffolded site: npm install" "$WORK/site" npm install --no-audit
  step "7  scaffolded site: typecheck" "$WORK/site" npm run typecheck
  start_stub || { echo "FAIL  could not start the content stub"; FAILED=1; }
  step "8  scaffolded site: next build (content from the local stub)" "$WORK/site/apps/web" with_stub npm run build
  step "8b scaffolded site: built CSS has the .p-8 utility (Tailwind 4)" "$WORK/site" css_has_utility apps/web p-8
  step "9  scaffolded site: vitest run (offline)" "$WORK/site/apps/web" npm test
  step "15 scaffolded site: static export (WEBDESK_STATIC_EXPORT=1) holds the fixture content" "$WORK/site/apps/web" export_and_check
  ( cd "$WORK/site" && echo "--- audit scaffolded site (omit dev)" && npm audit --omit=dev 2>&1 | tail -4 ) || true
else
  FAILED=1
fi

# ---- the deploy job's scripts, copies and workflows (M6-P6f) --------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  (apt-get update -qq && apt-get install -y -qq --no-install-recommends jq) >"$WORK/apt-jq.log" 2>&1 || { echo "FAIL  11 could not install jq"; tail -5 "$WORK/apt-jq.log"; FAILED=1; }
fi
step "11 deploy scripts: secret-name fixture + offline script tests" "$WORK/repo" bash -c 'bash webdesk/templates/_deploy/test-secret-name.sh | tail -1 && bash webdesk/templates/_deploy/test-scripts.sh | tail -3'
step "12 the templates' .webdesk/deploy copies equal _deploy/" "$WORK/repo" node webdesk/templates/sync-deploy-scripts.mjs --check
step "13 the three site.yml files keep the credential shape" "$WORK/repo" node webdesk/templates/check-workflows.mjs
step "14 fullstack: WEBDESK_STATIC_EXPORT=1 writes a static apps/web/out" "$WORK/full" bash -c 'WEBDESK_STATIC_EXPORT=1 npm run build -w apps/web && test -f apps/web/out/index.html && test -f apps/web/out/404.html'

if [ "$FAILED" -eq 0 ]; then echo "### build-templates PASS"; exit 0; fi
echo "### build-templates FAIL"; exit 1
