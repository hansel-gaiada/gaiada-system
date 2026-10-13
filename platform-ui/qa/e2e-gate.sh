#!/usr/bin/env bash
# Run ONE platform-ui Playwright spec on the Linux test server (sumopod), against a fresh clone of a pushed branch.
#
#   scp platform-ui/qa/e2e-gate.sh sumopod:~/dw2g/ && \
#   ssh sumopod 'nohup bash ~/dw2g/e2e-gate.sh <branch> <project> <spec> [runs] [smoke] > ~/dw2g/run-1.log 2>&1 & echo started'
#   then poll:  ssh sumopod 'tail -5 ~/dw2g/run-1.log'
#
#   e.g.  e2e-gate.sh dw/2g workspace-shell e2e/workspace-shell.spec.ts 2 smoke
#   runs   how many times to run the spec on the one build (default 2: the same sha twice shows it is not flaky)
#   smoke  also run the existing `smoke` project once, as a sanity check
#
# RULES (sumopod is a shared box with ~47 production-ish containers; parallel gates have taken it down):
#   - ONE gate at a time. This script refuses to start when the 1-minute load is above 4.
#   - Never run it in the foreground over ssh (the harness kills a silent session): nohup it, then poll the log.
#   - No ports are published; the container and the run directory are removed on exit (container-written files
#     are root-owned, hence sudo -n rm).
# The clone is the public repo, so the run tests exactly what was pushed; its sha is printed first.
# Under DEMO_MODE with no backend most of the OTHER e2e specs are red by baseline: run only your own spec.
set -u
BRANCH="${1:?usage: e2e-gate.sh <branch> <project> <spec> [runs] [smoke]}"
PROJECT="${2:?need a playwright project}"
SPEC="${3:?need a spec path under platform-ui}"
RUNS="${4:-2}"
SMOKE="${5:-}"
BASE="$HOME/dw2g"
D="$BASE/run-$$"
C="dw2g-e2e-$$"

load=$(cut -d' ' -f1 /proc/loadavg)
if awk -v l="$load" 'BEGIN { exit !(l > 4) }'; then echo "load $load is above 4: not starting"; exit 3; fi

cleanup() { docker rm -f "$C" >/dev/null 2>&1; sudo -n rm -rf "$D" 2>/dev/null || rm -rf "$D"; }
trap cleanup EXIT

echo "### e2e gate $(date -Is) load=$load branch=$BRANCH project=$PROJECT spec=$SPEC runs=$RUNS"
mkdir -p "$BASE"
git clone --quiet --depth 1 -b "$BRANCH" https://github.com/hansel-gaiada/gaiada-system.git "$D" || { echo "clone FAILED"; exit 1; }
echo "sha: $(git -C "$D" rev-parse HEAD)"

docker run --rm --name "$C" --memory 6g --cpus 2 -v "$D:/w" -w /w/platform-ui -e HOME=/tmp \
  -e RUNS="$RUNS" -e PROJECT="$PROJECT" -e SPEC="$SPEC" -e SMOKE="$SMOKE" \
  mcr.microsoft.com/playwright:v1.62.1-noble bash -lc '
  set -u
  npm ci --no-audit --no-fund >/tmp/ci.log 2>&1 || { echo "npm ci FAILED"; tail -20 /tmp/ci.log; exit 1; }
  npx playwright install chromium >/tmp/pwi.log 2>&1 || { echo "playwright install FAILED"; tail -10 /tmp/pwi.log; exit 1; }
  # The same production build CI uses (`next start` below), DEMO_MODE so no backend is needed.
  DEMO_MODE=1 DEMO_MODE_ACK_NON_PRODUCTION=1 SESSION_SECRET=e2e-only-not-a-secret npx next build >/tmp/build.log 2>&1 \
    || { echo "next build FAILED"; tail -30 /tmp/build.log; exit 1; }
  echo "next build ok"
  rc=0
  for i in $(seq 1 "$RUNS"); do
    echo "=== run $i/$RUNS: $PROJECT $SPEC"
    CI=1 DEMO_MODE_ACK_NON_PRODUCTION=1 SESSION_SECRET=e2e-only-not-a-secret npx playwright test --project="$PROJECT" "$SPEC" --reporter=line 2>&1
    r=$?; echo "=== run $i exit $r"; [ $r -eq 0 ] || rc=$r
  done
  if [ -n "$SMOKE" ]; then
    echo "=== smoke project"
    CI=1 DEMO_MODE_ACK_NON_PRODUCTION=1 SESSION_SECRET=e2e-only-not-a-secret npx playwright test --project=smoke --grep @smoke --reporter=line 2>&1
    r=$?; echo "=== smoke exit $r"; [ $r -eq 0 ] || rc=$r
  fi
  exit $rc
'
echo "### e2e gate exit $? $(date -Is)"
