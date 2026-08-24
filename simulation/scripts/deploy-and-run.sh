#!/usr/bin/env bash
# Ship the harness to the box and run it there.
#
# WHY IT RUNS ON THE BOX AND NOT ON A LAPTOP
# ------------------------------------------
# Three reasons, all of which came up while building this:
#   1. The credentials stay put. The harness needs PLATFORM_SERVICE_TOKEN and AGENT_RUNNER_TOKEN; on
#      the box it inherits them from `infra/compose/.env` through compose. Running it anywhere else
#      would mean copying two service tokens onto a developer machine.
#   2. The agent runner has no published port. `agent-runner:3006` is reachable only from inside
#      `gaiada_default`, and the agent strand is the one that makes the office canvas animate.
#   3. It is meant to be CONTINUOUS. A simulation that dies when a laptop sleeps or a session ends
#      is not a continuous simulation.
#
# Usage:
#   ./deploy-and-run.sh                        # build + start a fast pass
#   SIM_MODE=live ./deploy-and-run.sh          # start the live-paced loop
#   SIM_MAX_TICKS=3 ./deploy-and-run.sh        # bounded smoke run
#   ./deploy-and-run.sh --logs                 # follow the running driver
#   ./deploy-and-run.sh --stop                 # stop it
#   ./deploy-and-run.sh --status               # summary of the newest corpus
set -euo pipefail

SSH_HOST="${SSH_HOST:-gda-aicenter}"
REMOTE_DIR="${REMOTE_DIR:-/home/Hansel/gaiada/simulation}"
LOG_DIR="${LOG_DIR:-/var/lib/gaiada-sim/logs}"
PROJECT="gaiada-sim"
COMPOSE="docker compose -p $PROJECT -f docker-compose.simulation.yml"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-run}" in
  --logs)
    exec ssh -t "$SSH_HOST" "cd $REMOTE_DIR && $COMPOSE logs -f --tail=80"
    ;;
  --stop)
    # Deliberately NOT --remove-orphans (see the compose file's header).
    ssh "$SSH_HOST" "cd $REMOTE_DIR && $COMPOSE down"
    echo "==> stopped"
    exit 0
    ;;
  --status)
    ssh "$SSH_HOST" "sudo -n ls -1t $LOG_DIR 2>/dev/null | head -5; echo ---; \
      LATEST=\$(sudo -n ls -1t $LOG_DIR 2>/dev/null | head -1); \
      [ -n \"\$LATEST\" ] && sudo -n head -c 4000 $LOG_DIR/\$LATEST/summary.json || echo 'no corpus yet'"
    exit 0
    ;;
  run) ;;
  *) echo "usage: $0 [--logs|--stop|--status]" >&2; exit 2 ;;
esac

if [ ! -f "$LOCAL_DIR/roster.generated.json" ]; then
  echo "ERR: roster.generated.json missing — run ./build-roster.sh first" >&2
  exit 1
fi

echo "==> preparing $SSH_HOST:$REMOTE_DIR"
ssh "$SSH_HOST" "mkdir -p $REMOTE_DIR && sudo -n mkdir -p $LOG_DIR && sudo -n chown 1000:1000 $LOG_DIR"

# The password file is root-only 0600 on the host, and the container runs as the unprivileged `node`
# user (uid 1000), which cannot read it through a bind mount. Hand ownership to that uid and keep it
# owner-read-only. This is a simulation-only credential on a dev estate; the alternative (running the
# container as root) is a worse trade for the same outcome.
ssh "$SSH_HOST" "if sudo -n test -f /etc/gaiada/sim-staff.pw; then \
    sudo -n chown 1000:1000 /etc/gaiada/sim-staff.pw && sudo -n chmod 0400 /etc/gaiada/sim-staff.pw && \
    echo '    password file readable by the container (human path enabled)'; \
  else \
    echo '    NOTE: /etc/gaiada/sim-staff.pw absent — human identity path will be skipped'; \
    sudo -n install -d -m 0755 /etc/gaiada; : > /tmp/sim-staff.placeholder; \
    sudo -n cp /tmp/sim-staff.placeholder /etc/gaiada/sim-staff.pw; \
    sudo -n chown 1000:1000 /etc/gaiada/sim-staff.pw; sudo -n chmod 0400 /etc/gaiada/sim-staff.pw; \
    rm -f /tmp/sim-staff.placeholder; \
  fi"

echo "==> syncing source"
# --delete so a removed file on the laptop is removed on the box. The estate's own deploy once
# shipped without --delete and left a stale file running; not repeating that here.
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude .git \
  "$LOCAL_DIR/" "$SSH_HOST:$REMOTE_DIR/"

echo "==> building and starting (mode=${SIM_MODE:-fast} maxTicks=${SIM_MAX_TICKS:-0})"
ssh "$SSH_HOST" "cd $REMOTE_DIR && \
  SIM_MODE='${SIM_MODE:-fast}' \
  SIM_RUN_ID='${SIM_RUN_ID:-}' \
  SIM_MAX_TICKS='${SIM_MAX_TICKS:-0}' \
  SIM_TICK_SECONDS='${SIM_TICK_SECONDS:-}' \
  SIM_DRY_RUN='${SIM_DRY_RUN:-0}' \
  $COMPOSE up -d --build"

echo "==> started. Follow with:  $0 --logs"
