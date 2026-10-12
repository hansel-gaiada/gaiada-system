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
#   8  scaffolded site: next build
#   9  scaffolded site: vitest run (offline tests only; the conformance probe self-skips with no WEBDESK_* env)
#   4b, 8b  Tailwind 4 really emitted utilities: a class used in a page (`.p-8`) is in the built CSS (a v4 build with a
#        wrong PostCSS/CSS setup succeeds and silently emits NO utilities)
#   10 npm audit --omit=dev is printed per project (informational, never fails the run)
set -uo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
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
  step "8  scaffolded site: next build" "$WORK/site/apps/web" npm run build
  step "8b scaffolded site: built CSS has the .p-8 utility (Tailwind 4)" "$WORK/site" css_has_utility apps/web p-8
  step "9  scaffolded site: vitest run (offline)" "$WORK/site/apps/web" npm test
  ( cd "$WORK/site" && echo "--- audit scaffolded site (omit dev)" && npm audit --omit=dev 2>&1 | tail -4 ) || true
else
  FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then echo "### build-templates PASS"; exit 0; fi
echo "### build-templates FAIL"; exit 1
