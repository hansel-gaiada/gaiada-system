#!/usr/bin/env bash
# run.sh - the M6-P6e harness driver. Run it ON sumopod (never on a laptop: owner rule, no local Docker):
#
#   rsync/tar webdesk/templates/_deploy to the box, then:   bash <dir>/harness/run.sh
#
# It builds one image, starts a private compose project (p6e-harness: sshd, rogue sshd, vsftpd with explicit
# TLS, rogue vsftpd, plain-FTP vsftpd, nginx over HTTPS, a client), runs cases.sh inside the client and
# prints PASS or FAIL per case. NO host ports are published. Everything it created (containers, network,
# volumes, image) is removed on every exit path; nothing else on the host is touched.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
P=p6e-harness
LOG="${P6E_LOG:-/tmp/p6e-harness.log}"

rnd() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12; }
export PW_A="Canary-Pw-Alpha-$(rnd)"   # recognisable throwaway credentials: the canary the cases hunt for
export PW_B="Canary-Pw-Bravo-$(rnd)"

teardown() {
  echo "### teardown: removing project $P (containers, network, volumes) and its image"
  docker compose -p "$P" down -v --remove-orphans --timeout 5 >/dev/null 2>&1
  docker rmi p6e-harness-img:local >/dev/null 2>&1
  [ -n "${P6E_KEEP:-}" ] || rm -f "$LOG.daemons"
  left="$(docker ps -a --filter "label=com.docker.compose.project=$P" -q | wc -l)"
  echo "### teardown done: $left containers of $P left"
}
trap teardown EXIT

echo "### starting $P on $(hostname)"
docker compose -p "$P" up -d --build 2>&1 | tail -3
for i in $(seq 1 40); do
  docker compose -p "$P" exec -T client bash -c 'exec 3<>/dev/tcp/sshd/22 && exec 4<>/dev/tcp/ftps/21 && exec 5<>/dev/tcp/ftp-plain/21 && exec 6<>/dev/tcp/https/443' >/dev/null 2>&1 && break
  sleep 1
done
docker compose -p "$P" ps --format '{{.Name}} {{.Status}}'

# P6E_CASES: p6e (default: the transport cases of M6-P6e) | p6f (the per-site secret, wp theme-only and static cases of M6-P6f) | all
rc=0
: >"$LOG"
for set in ${P6E_CASES:-p6e}; do
  case "$set" in
    p6e) script=cases.sh ;;
    p6f) script=cases-p6f.sh ;;
    all) script="cases.sh cases-p6f.sh" ;;
    *) echo "unknown P6E_CASES '$set'"; exit 2 ;;
  esac
  for sc in $script; do
    docker compose -p "$P" exec -T -e PW_A -e PW_B -e P6E_TRANSPORTS client bash "/harness/$sc" 2>&1 | tee -a "$LOG"
    [ "${PIPESTATUS[0]}" = 0 ] || rc=1
  done
done

echo
echo "================ daemon-side evidence ================"
docker compose -p "$P" logs --no-color --no-log-prefix >"$LOG.daemons" 2>&1
echo "--- vsftpd (ftps) refusals of principal a on b's root:"
docker compose -p "$P" logs --no-color ftps 2>&1 | grep -E '"550|"530' | sed 's/^[^|]*| *//' | head -6
echo "--- vsftpd (ftp-plain): any PASS command seen from the deploy client? (the TLS-forcing client must never send one)"
docker compose -p "$P" logs --no-color ftp-plain 2>&1 | grep -c "FTP command.*\"PASS" | sed 's/^/    PASS commands: /'
echo "--- sshd (real): accepted and failed logins"
docker compose -p "$P" logs --no-color sshd 2>&1 | grep -E 'Accepted|Failed|refused' | sed 's/^[^|]*| *//' | sed 's/ port [0-9]* ssh2//' | sort | uniq -c | head -6
echo "--- sshd-rogue: did any client ever authenticate to the hijacker?"
docker compose -p "$P" logs --no-color sshd-rogue 2>&1 | grep -cE 'Accepted' | sed 's/^/    accepted logins: /'
if grep -qF -e "$PW_A" -e "$PW_B" "$LOG.daemons"; then echo "FAIL  6b a canary credential is in a DAEMON log"; rc=1; else echo "PASS  6b the canary credentials are in none of the daemon logs either ($(wc -l <"$LOG.daemons") lines)"; fi
if grep -qF -e "$PW_A" -e "$PW_B" "$LOG"; then echo "FAIL  6c a canary credential is in the harness transcript"; rc=1; else echo "PASS  6c the canary credentials are not in this transcript"; fi

echo "### harness exit status: $rc"
exit "$rc"
