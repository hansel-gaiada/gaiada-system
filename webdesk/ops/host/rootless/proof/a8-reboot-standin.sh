#!/usr/bin/env bash
# a8-reboot-standin.sh - P2 acceptance row A8: a reboot stand-in for the proof daemon (M4 F6; plan §9 A8, §3/§5).
# Run after a5-stack.sh (the proof stack must be running). It only ever stops/starts the PROOF user manager
# (user@941.service), the PROOF guard instance and PROOF's linger flag.
#
#   sudo bash a8-reboot-standin.sh
#
# 1. systemctl stop user@941        -> no process of uid 941 or of its subuid range remains, the guard unit is still
#                                      ACTIVE, `guard check` still passes, nothing listens on 127.0.0.1:18380.
# 2. loginctl disable-linger, then enable-linger -> the user manager starts, the daemon starts, `unless-stopped` brings the
#                                      stack back by itself, and healthz on 18380 answers 200.
# 3. FAIL-CLOSED: stop user@941 again, stop the guard unit, and make the guard's CONFIG invalid (a temporary edit of
#    /etc/default/webdesk-rootless-wdproof-rootless, RL_PUBLISHED_PORTS="x"; restored by the EXIT trap and by step 4). Then
#    `systemctl start user@941` must FAIL (its ExecStartPre runs `guard check` as root; the guard dependency cannot render):
#    no daemon socket, no process of the set, nothing on 18380.
# 4. restore the config, `systemctl start` the guard (the unit is inactive, so `reload` cannot apply; a `reload` is then run
#    on the now-active unit), `systemctl start user@941`: the stack is back and healthz is 200.
# 5. systemd-analyze verify on the guard instance and user@941.service, and the ordering of the two (guard before user@941).
# 6. THE LIVE STACK IS UNTOUCHED: every container of the live `webdesk` compose project has the same StartedAt, running state
#    and restart count before and after (checked after every step). Read-only `docker inspect`; no live container is stopped.
#
# SAFETY: root, proof context (proof-lib.sh), proof user only. The only file edited is the proof guard config, backed up to
# /srv/wdproof/evidence/a8/ first and restored by cleanup() on ANY exit (also ^C), which then restarts the guard, linger and
# user@941 if they are not up. Takes a few minutes (daemon stop/start dominate).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=proof-lib.sh
. "$HERE/proof-lib.sh"

UNIT="user@${PROOF_UID}.service"
MARKER="/run/webdesk-rootless-guard/${PROOF_USER}.active"
ARMED=0
EV=""
CONF_BAK=""
SUB_FIRST=""
SUB_LAST=""
LIVE_BEFORE=""
PUBLIC_HOST="${WEBDESK_PUBLIC_HOST:-api.erp.gaiada.com}"

cleanup() {
  [ "$ARMED" = 1 ] || return 0
  if [ -f "$CONF_BAK" ] && ! cmp -s "$CONF_BAK" "$PROOF_CONF"; then
    cat "$CONF_BAK" >"$PROOF_CONF" && echo "  INFO  cleanup: restored $PROOF_CONF"
  fi
  systemctl reset-failed "$PROOF_GUARD_UNIT" "$UNIT" >/dev/null 2>&1 || true
  systemctl is-active --quiet "$PROOF_GUARD_UNIT" || systemctl start "$PROOF_GUARD_UNIT" >/dev/null 2>&1 || true
  loginctl enable-linger "$PROOF_USER" >/dev/null 2>&1 || true
  systemctl is-active --quiet "$UNIT" || systemctl start "$UNIT" >/dev/null 2>&1 || true
}

# --- observations ----------------------------------------------------------------------------------------------

set_pids() { ps -e -o pid= -o uid= | awk -v u="$PROOF_UID" -v s="$SUB_FIRST" -v e="$SUB_LAST" '$2 == u || ($2 >= s && $2 <= e) { print $1 }'; }
no_set_pids() { [ -z "$(set_pids)" ]; }
port_listening() { ss -ltn "sport = :$PROOF_PORT" 2>/dev/null | grep -q ":$PROOF_PORT"; }
port_silent() { ! port_listening; }
healthz_200() { [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Host: $PUBLIC_HOST" "http://127.0.0.1:$PROOF_PORT/healthz")" = 200 ]; }
guard_active() { [ "$(systemctl is-active "$PROOF_GUARD_UNIT" 2>/dev/null)" = active ]; }
guard_check() { "$PROOF_GUARD_BIN" check "$PROOF_USER" >/dev/null 2>&1; }
unit_active() { [ "$(systemctl is-active "$UNIT" 2>/dev/null)" = active ]; }
sock_absent() { [ ! -S "$PROOF_SOCK_PATH" ]; }
all_running() {
  local s
  for s in proxy api postgres redis rustfs; do
    [ "$(dp inspect -f '{{.State.Running}}' "wdproof-$s-1" 2>/dev/null)" = true ] || return 1
  done
}
stack_back() { all_running && healthz_200; }
live_snapshot() {
  local id
  for id in $(dr ps -aq --filter 'label=com.docker.compose.project=webdesk'); do
    dr inspect -f '{{.Name}} started={{.State.StartedAt}} running={{.State.Running}} restarts={{.RestartCount}}' "$id"
  done | sort
}
live_untouched() { # <label>
  local now
  now="$(live_snapshot)"
  if [ "$now" = "$LIVE_BEFORE" ]; then pass "live stack untouched $1 ($(printf '%s\n' "$now" | grep -c .) containers, StartedAt/running/restarts identical)"
  else fail "LIVE STACK CHANGED $1:"; diff <(printf '%s\n' "$LIVE_BEFORE") <(printf '%s\n' "$now") | sed 's/^/        /'; fi
}

main() {
  hdr "preflight"
  require_proof_context
  require_daemons
  require_proof_files
  command -v systemctl >/dev/null && command -v loginctl >/dev/null && command -v ss >/dev/null || die "systemctl, loginctl and ss are required"
  [ -x "$PROOF_GUARD_BIN" ] || die "REFUSED: $PROOF_GUARD_BIN is not installed"
  local r
  r="$(awk -F: -v u="$PROOF_USER" -v id="$PROOF_UID" '$1 == u || $1 == id { print $2, $3; exit }' /etc/subuid)"
  [[ "$r" =~ ^([0-9]+)\ ([0-9]+)$ ]] || die "no subuid range for $PROOF_USER in /etc/subuid"
  SUB_FIRST="${BASH_REMATCH[1]}"; SUB_LAST=$((SUB_FIRST + BASH_REMATCH[2] - 1))
  pass "proof uid set: $PROOF_UID + $SUB_FIRST-$SUB_LAST"
  all_running && pass "the proof stack is running (5 containers)" || die "REFUSED: the proof stack is not running (run a5-stack.sh first)"
  healthz_200 && pass "healthz on $PROOF_PORT = 200 before we start" || die "REFUSED: healthz on $PROOF_PORT is not 200 before we start"
  guard_active && guard_check && pass "the proof guard is ACTIVE and passes check" || die "REFUSED: the proof guard is not active/clean before we start"
  unit_active || die "REFUSED: $UNIT is not active"
  LIVE_BEFORE="$(live_snapshot)"
  printf '%s\n' "$LIVE_BEFORE" | grep -q '^/webdesk-api-1 ' || die "REFUSED: the live container webdesk-api-1 was not found; cannot prove the live stack untouched"
  info "live StartedAt before: $(printf '%s\n' "$LIVE_BEFORE" | grep '^/webdesk-api-1 ' | cut -d' ' -f2)"
  EV="$(ev_dir a8)"
  CONF_BAK="$EV/guard-config.orig"
  cat "$PROOF_CONF" >"$CONF_BAK" || die "cannot back up $PROOF_CONF"
  ARMED=1

  hdr "1. systemctl stop $UNIT (the reboot's shutdown half)"
  timeout 240 systemctl stop "$UNIT" && pass "systemctl stop $UNIT" || fail "systemctl stop $UNIT failed or timed out"
  wait_until 120 no_set_pids && pass "no process of uid $PROOF_UID or $SUB_FIRST-$SUB_LAST remains" || { fail "processes of the proof set remain: $(set_pids | tr '\n' ' ')"; }
  guard_active && pass "the guard unit is still ACTIVE" || fail "the guard unit is no longer active"
  guard_check && pass "guard check still passes (marker, rules, jump order)" || fail "guard check FAILS after the stop"
  port_silent && pass "nothing listens on 127.0.0.1:$PROOF_PORT" || fail "something still listens on $PROOF_PORT"
  live_untouched "after step 1"

  hdr "2. linger off then on: the stack must return by itself"
  loginctl disable-linger "$PROOF_USER" && pass "loginctl disable-linger" || fail "disable-linger failed"
  [ ! -e "/var/lib/systemd/linger/$PROOF_USER" ] && pass "linger flag removed" || fail "linger flag still present"
  unit_active && fail "$UNIT came back with linger OFF" || pass "$UNIT stays down with linger off"
  loginctl enable-linger "$PROOF_USER" && pass "loginctl enable-linger" || fail "enable-linger failed"
  wait_until 120 unit_active && pass "$UNIT started by linger" || fail "$UNIT did not start after enable-linger"
  wait_until 240 stack_back && pass "the stack returned by itself (unless-stopped): 5 containers running, healthz on $PROOF_PORT = 200" \
    || { fail "the stack did not come back within 240 s (running: $(dp ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' '))"; }
  live_untouched "after step 2"

  hdr "3. fail closed: guard stopped, config broken, then start $UNIT"
  timeout 240 systemctl stop "$UNIT" && pass "systemctl stop $UNIT" || fail "stop failed"
  wait_until 120 no_set_pids && pass "the proof set is gone" || fail "processes of the proof set remain"
  timeout 60 systemctl stop "$PROOF_GUARD_UNIT" && pass "systemctl stop $PROOF_GUARD_UNIT" || fail "could not stop the guard (it refuses while processes of the set run)"
  guard_active && fail "the guard is still active" || pass "the guard unit is not active"
  [ ! -e "$MARKER" ] && pass "the guard marker is gone ($MARKER)" || fail "the guard marker still exists"
  sed -i 's/^RL_PUBLISHED_PORTS=.*/RL_PUBLISHED_PORTS="x"/' "$PROOF_CONF"
  grep -q '^RL_PUBLISHED_PORTS="x"$' "$PROOF_CONF" && pass "temporary edit made: RL_PUBLISHED_PORTS=\"x\" (restored by trap and step 4)" || die "could not edit $PROOF_CONF"
  if "$PROOF_GUARD_BIN" render "$PROOF_USER" >/dev/null 2>&1; then fail "the broken config STILL renders (the test would prove nothing)"; else pass "the broken config no longer renders"; fi
  if guard_check; then fail "guard check passes with the broken config"; else pass "guard check FAILS with the broken config"; fi
  if timeout 120 systemctl start "$UNIT" >"$EV/failclosed-start.out" 2>&1; then fail "systemctl start $UNIT SUCCEEDED with the guard broken: NOT fail-closed"; else pass "systemctl start $UNIT FAILED (as required)"; fi
  sleep 3
  unit_active && fail "$UNIT is active" || pass "$UNIT is not active"
  no_set_pids && pass "no process of the proof set exists" || fail "processes of the proof set exist: $(set_pids | tr '\n' ' ')"
  sock_absent && pass "no daemon socket ($PROOF_SOCK_PATH)" || fail "the daemon socket exists"
  port_silent && pass "nothing on 127.0.0.1:$PROOF_PORT" || fail "something listens on $PROOF_PORT"
  healthz_200 && fail "healthz answers 200 with the guard broken" || pass "healthz on $PROOF_PORT does not answer"
  guard_active && fail "the guard unit is active with a broken config" || pass "the guard unit is not active"
  info "why it failed (journal): $(journalctl -u "$UNIT" -n 40 --no-pager 2>/dev/null | grep -iE 'ExecStartPre|check|refus|status=' | tail -n 3 | cut -c1-200 | tr '\n' '|')"
  live_untouched "after step 3"

  hdr "4. restore, start the guard, start $UNIT"
  cat "$CONF_BAK" >"$PROOF_CONF"
  cmp -s "$CONF_BAK" "$PROOF_CONF" && pass "guard config restored byte for byte" || fail "guard config NOT restored"
  systemctl reset-failed "$PROOF_GUARD_UNIT" "$UNIT" >/dev/null 2>&1
  timeout 60 systemctl start "$PROOF_GUARD_UNIT" && pass "systemctl start $PROOF_GUARD_UNIT" || fail "the guard did not start with the restored config"
  timeout 60 systemctl reload "$PROOF_GUARD_UNIT" && pass "systemctl reload $PROOF_GUARD_UNIT (re-applies; works on the active unit)" || fail "reload failed"
  guard_active && guard_check && pass "the guard is ACTIVE and passes check" || fail "the guard is not clean after the restore"
  timeout 240 systemctl start "$UNIT" && pass "systemctl start $UNIT" || fail "$UNIT did not start after the repair"
  wait_until 240 stack_back && pass "the stack is back after the repair; healthz on $PROOF_PORT = 200" || fail "the stack did not come back within 240 s"
  live_untouched "after step 4"

  hdr "5. unit graph"
  local vout
  vout="$(systemd-analyze verify "$PROOF_GUARD_UNIT" "$UNIT" 2>&1)"
  if [ -z "$vout" ]; then pass "systemd-analyze verify: clean for $PROOF_GUARD_UNIT and $UNIT"
  else fail "systemd-analyze verify printed:"; printf '%s\n' "$vout" | head -n 10 | cut -c1-200 | sed 's/^/        /'; fi
  printf '%s\n' "$vout" >"$EV/analyze-verify.out"
  local after wants
  after="$(systemctl show "$UNIT" -p After --value)"
  wants="$(systemctl show "$UNIT" -p Wants --value)"
  case " $after " in *" $PROOF_GUARD_UNIT "*) pass "$UNIT is ordered After= $PROOF_GUARD_UNIT" ;; *) fail "$UNIT is not ordered after the guard" ;; esac
  case " $wants " in *" $PROOF_GUARD_UNIT "*) pass "$UNIT Wants= $PROOF_GUARD_UNIT" ;; *) fail "$UNIT does not want the guard" ;; esac
  case " $(systemctl show "$PROOF_GUARD_UNIT" -p Before --value) " in *" $UNIT "*) pass "the guard is ordered Before= $UNIT" ;; *) fail "the guard is not ordered before $UNIT" ;; esac
  systemctl show "$UNIT" -p ExecStartPre --value 2>/dev/null | grep -q 'webdesk-rootless-guard.sh' && pass "$UNIT has the guard check as ExecStartPre" || fail "$UNIT has no guard ExecStartPre"
  systemd-analyze critical-chain "$UNIT" --no-pager 2>/dev/null | head -n 8 | sed 's/^/        /'

  hdr "6. the live stack, end to end"
  live_untouched "at the end"
  info "live webdesk-api-1 StartedAt after: $(live_snapshot | grep '^/webdesk-api-1 ' | cut -d' ' -f2)"
  info "evidence: $EV"
  summary
}

main "$@"
