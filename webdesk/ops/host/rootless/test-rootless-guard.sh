#!/usr/bin/env bash
# test-rootless-guard.sh - the LIVE packet harness for the rootless egress guard (M4 F6, plan
# docs/plans/2026-10-12-webdesk-rootless-plan.md section 9, check A2). It sends real packets from throwaway
# containers on the PROOF rootless daemon and, as a control for every host-side claim, from the ROOTFUL daemon's
# default bridge, which no WebDesk guard covers.
#
#   sudo bash test-rootless-guard.sh [--user wdproof-rootless] [--uid 941]
#                                    [--socket unix:///run/user/941/docker.sock] [--port 18380]
#                                    [--guard /usr/local/sbin/webdesk-rootless-guard.sh]
#                                    [--otlp-env /etc/default/wdproof-rootless-otlp] [--image node:22-alpine]
#   bash test-rootless-guard.sh --list       print the planned checks; needs no root and no docker
#   bash test-rootless-guard.sh --selftest   syntax + the pure helpers; needs no root and no docker (the CI gate)
#
# Run it on gda-aicenter, as root, AFTER install-rootless.sh apply --profile proof. Exit 0 only if every check and
# its control passed. It REFUSES the live instance (uid 940, user webdesk-rootless) and never touches the live
# project, the rootful WEBDESK-* chains or /etc/webdesk. It changes exactly two things and restores both on EXIT
# (even on failure): the proof's OTLP switch file, and the proof guard's rules (reloaded from the restored switch).
# "reload" is `systemctl reload webdesk-rootless-guard@<user>` (= guard apply), the same call the installer makes.
#
# "Dropped" means a TIMEOUT. A refusal (RST) is reported as FAIL on purpose: a DROP in OUTPUT must not answer.
set -uo pipefail

PROOF_USER=wdproof-rootless
PROOF_UID=941
SOCK=""
PORT=18380
GUARD=/usr/local/sbin/webdesk-rootless-guard.sh
OTLP_ENV=""
IMG="${PROBE_IMAGE:-node:22-alpine}"
MODE=run
LIVE_USER=webdesk-rootless
LIVE_UID=940
OTLP_ADDR=172.17.0.1
OTLP_PORT=4319
LISTEN='require("net").createServer(s=>{s.on("error",()=>{});s.end("x")}).listen(7000)'
# stdin: "host port" lines. Prints "dns ok|fail" then "host:port open|refused|timeout|error" per line.
PROBE_JS='
const net = require("net"), dns = require("dns");
const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
const tcp = (h, p) => new Promise((res) => { const s = net.connect({ host: h, port: +p });
  const d = (r) => { s.destroy(); res(`${h}:${p} ${r}`); };
  s.setTimeout(2500, () => d("timeout")); s.on("connect", () => d("open"));
  s.on("error", (e) => d(e.code === "ECONNREFUSED" ? "refused" : `error ${e.code || "?"}`)); });
const look = () => new Promise((res) => dns.lookup("example.com", (e) => res(`dns ${e ? "fail" : "ok"}`)));
Promise.all([look(), ...lines.map((l) => tcp(...l.split(" ")))]).then((r) => console.log(r.join("\n")));'

PASS=0
FAIL=0
ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
note() { echo "  note  $*"; }
sect() { echo "== $*"; }

# --- pure helpers (--selftest drives these) -------------------------------------------------------------------

# addrs_from_ip: stdin is `ip -4 -o addr` output; prints every non-loopback IPv4 address, sorted, unique.
addrs_from_ip() { awk '{ split($4, a, "/"); if (a[1] !~ /^127\./) print a[1] }' | sort -u; }
# wg_peers_from: stdin is `wg show all allowed-ips`; prints each peer's single IPv4 (/32) address.
wg_peers_from() { awk '{ for (i = 3; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/32$/) { sub(/\/32$/, "", $i); print $i } }' | sort -u; }
# res <file> <host:port>: the recorded state of a probe target ("" if absent).
res() { awk -v t="$2" '$1 == t { print $2; exit }' "$1"; }
answers() { case "$(res "$1" "$2")" in open | refused) return 0 ;; *) return 1 ;; esac; } # a control: anything but timeout/error
is_uint() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac; }
# conf_get <file> <KEY>: last KEY=value line, quotes stripped (the guard's own parser).
conf_get() {
  local v
  v="$(sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -n 1 || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}
burst_lines() { local i; for ((i = 0; i < $1; i++)); do echo "$2 $3"; done; }
# hashlimit_name: stdin is `iptables -S <chain>`; prints the first --hashlimit-name.
hashlimit_name() { sed -n 's/.*--hashlimit-name \([^ ]*\).*/\1/p' | head -n 1; }
count_ctorigdst() { grep -c -- '--ctorigdst' || true; }

print_plan() {
  cat <<'EOF'
test-rootless-guard.sh planned checks (proof instance only; each "dropped" check has a control)
 0 preflight   root; refuse uid 940 / user webdesk-rootless / a switch under /etc/webdesk; proof user, socket, guard
               config, probe image on BOTH daemons, declared port and port+1 free, guard `check` passes at start
 1 must work   (proof daemon)   own user-defined-network peer; DNS of a public name; TCP 1.1.1.1:443
               control: the same three from the ROOTFUL default bridge
 2 dropped     (proof daemon, expect TIMEOUT) 169.254.169.254:80 ; every host IPv4 address :22 ; 172.17.0.1 on
               5432 6379 4310 9443 ; one WireGuard peer :22 ; 10.0.2.2:22 (slirp host alias: NO rootful control exists)
               control: each host target answers (open or refused) from the ROOTFUL default bridge
 3 published   host -> 127.0.0.1:<declared> answers (and serves its byte); undeclared 127.0.0.1:<declared+1> and
               0.0.0.0:<free> time out from the host (reply mute); controls: the listener is up on the proof's own
               bridge, and the same publishes on the ROOTFUL daemon answer from the host
 4 OTLP        switch off: 172.17.0.1:4319 dropped, no ctorigdst rule (control: host and rootful bridge reach it);
               WEBDESK_OTLP_PORT=4319 + reload: it connects; 4319 on another host address, another port on 172.17.0.1,
               5432 and :22 stay dropped; WEBDESK_OTLP_PPS=2 + reload: a 40-connection burst is not fully admitted
               (control: at the default cap all 40 are); a new hashlimit table name; switch off + reload: no
               ctorigdst rule remains; switch file restored exactly
 5 IPv6        ip6tables holds the proof chain's drop-all, both selectors, one OUTPUT jump
 6 drift       a harmless appended rule makes `check` FAIL; reload; `check` PASSES
 7 cleanup     (trap, also on failure) every throwaway container and network on both daemons removed; switch file
               restored; guard reloaded and `check` passing; final "passed=N failed=M"; exit 0 only if M=0
EOF
}

selftest() {
  local f=0 t
  chk() { if "$@"; then echo "  PASS  selftest: $DESC"; else echo "  FAIL  selftest: $DESC"; f=$((f + 1)); fi; }
  DESC="bash -n parses this file"; chk bash -n "${BASH_SOURCE[0]}"
  DESC="addrs_from_ip drops loopback, keeps the rest"
  t="$(printf '%s\n' '1: lo    inet 127.0.0.1/8 scope host lo' '2: ens4    inet 10.148.0.15/32 scope global ens4' '3: docker0    inet 172.17.0.1/16 brd x scope global docker0' | addrs_from_ip | tr '\n' ' ')"
  chk test "$t" = "10.148.0.15 172.17.0.1 "
  DESC="wg_peers_from takes /32 peers only"
  t="$(printf 'wg0\tKEY=\t10.88.0.2/32\nwg0\tKEY2=\t10.88.0.3/32 192.168.5.0/24\nwg0\tKEY3=\t(none)\n' | wg_peers_from | tr '\n' ' ')"
  chk test "$t" = "10.88.0.2 10.88.0.3 "
  DESC="res reads one target and answers() rejects a timeout"
  printf 'dns ok\n1.2.3.4:22 timeout\n1.2.3.4:23 refused\n1.2.3.4:24 open\n' >"${TMPDIR:-/tmp}/wdrl-self.$$"
  chk test "$(res "${TMPDIR:-/tmp}/wdrl-self.$$" 1.2.3.4:24)" = open
  DESC="answers(): refused and open answer, timeout does not"
  chk bash -c "$(declare -f res answers); answers ${TMPDIR:-/tmp}/wdrl-self.$$ 1.2.3.4:23 && ! answers ${TMPDIR:-/tmp}/wdrl-self.$$ 1.2.3.4:22"
  rm -f "${TMPDIR:-/tmp}/wdrl-self.$$"
  DESC="burst_lines prints N lines"; chk test "$(burst_lines 40 172.17.0.1 4319 | wc -l | tr -d ' ')" = 40
  DESC="hashlimit_name + count_ctorigdst"
  t='-A WDRL941-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -m hashlimit --hashlimit-above 2/sec --hashlimit-name o941xabc123 -j DROP'
  chk test "$(printf '%s\n' "$t" | hashlimit_name)" = o941xabc123
  DESC="count_ctorigdst counts rules"; chk test "$(printf '%s\n%s\n' "$t" x | count_ctorigdst)" = 1
  DESC="conf_get strips quotes"; printf 'RL_PUBLISHED_PORTS="18380"\n' >"${TMPDIR:-/tmp}/wdrl-conf.$$"
  chk test "$(conf_get "${TMPDIR:-/tmp}/wdrl-conf.$$" RL_PUBLISHED_PORTS)" = 18380
  rm -f "${TMPDIR:-/tmp}/wdrl-conf.$$"
  DESC="the plan names the 8 sections"; chk test "$(print_plan | grep -c '^ [0-9] ')" = 8
  echo "selftest: $f failure(s)"
  [ "$f" = 0 ]
}

# --- arguments ------------------------------------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --list) MODE=list; shift ;;
    --selftest) MODE=selftest; shift ;;
    --user | --uid | --socket | --port | --guard | --otlp-env | --image)
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in
        --user) PROOF_USER=$2 ;; --uid) PROOF_UID=$2 ;; --socket) SOCK=$2 ;; --port) PORT=$2 ;;
        --guard) GUARD=$2 ;; --otlp-env) OTLP_ENV=$2 ;; --image) IMG=$2 ;;
      esac
      shift 2 ;;
    -h | --help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1 (try --list or --selftest)" >&2; exit 2 ;;
  esac
done
case "$MODE" in
  list) print_plan; exit 0 ;;
  selftest) selftest; exit $? ;;
esac

die() { echo "REFUSED: $*" >&2; exit 2; }
is_uint "$PROOF_UID" && is_uint "$PORT" || die "--uid and --port must be numbers"
[[ "$PROOF_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]] || die "bad --user"
[ "$PROOF_UID" != "$LIVE_UID" ] && [ "$PROOF_USER" != "$LIVE_USER" ] || die "uid $LIVE_UID / $LIVE_USER is the LIVE instance; this harness is for the proof only"
[ -n "$SOCK" ] || SOCK="unix:///run/user/$PROOF_UID/docker.sock"
TAG="WDRL$PROOF_UID"
UNIT="webdesk-rootless-guard@$PROOF_USER.service"
CONF="/etc/default/webdesk-rootless-$PROOF_USER"
UNDECL=$((PORT + 1))
RUN="wdrl-t1-$(date +%s)"

[ "$(id -u)" = 0 ] || die "run as root (sudo): it reads iptables and the guard's state"
for c in docker ip iptables ip6tables timeout awk sed wg ss getent; do command -v "$c" >/dev/null 2>&1 || die "missing command: $c"; done
[ "$(getent passwd "$PROOF_USER" | cut -d: -f3)" = "$PROOF_UID" ] || die "user $PROOF_USER is not uid $PROOF_UID"
[ -r "$CONF" ] || die "no guard config $CONF (install-rootless.sh apply --profile proof writes it)"
[ -x "$GUARD" ] || die "guard not executable: $GUARD"
[ -S "${SOCK#unix://}" ] || die "no proof docker socket at ${SOCK#unix://}"
[ -n "$OTLP_ENV" ] || OTLP_ENV="$(conf_get "$CONF" RL_OTLP_ENV_FILE)"
[ -n "$OTLP_ENV" ] || die "the proof guard config names no RL_OTLP_ENV_FILE and no --otlp-env was given"
case "$OTLP_ENV" in /etc/webdesk | /etc/webdesk/*) die "the OTLP switch $OTLP_ENV is under /etc/webdesk (the live guard's)" ;; esac
[ "$(conf_get "$CONF" RL_PUBLISHED_PORTS)" = "$PORT" ] || die "--port $PORT is not the config's RL_PUBLISHED_PORTS ($(conf_get "$CONF" RL_PUBLISHED_PORTS))"
[ "$(conf_get "$CONF" RL_ROLE)" != live ] || die "$CONF says role live"

dk_proof() { env -u DOCKER_CONTEXT DOCKER_HOST="$SOCK" docker "$@"; }
dk_root() { env -u DOCKER_HOST -u DOCKER_CONTEXT docker "$@"; }
dk_proof image inspect "$IMG" >/dev/null 2>&1 || die "$IMG is not on the PROOF daemon (pull it there first; this harness never pulls)"
dk_root image inspect "$IMG" >/dev/null 2>&1 || die "$IMG is not on the ROOTFUL daemon (pull it there first; this harness never pulls)"
port_free() { ! ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"; }
free_port() { local p; while :; do p=$((28000 + RANDOM % 4000)); port_free "$p" && { echo "$p"; return; }; done; }
port_free "$PORT" || die "port $PORT is already bound (is the proof stack up? stop it first)"
port_free "$UNDECL" || die "port $UNDECL is already bound"
"$GUARD" check "$PROOF_USER" >/dev/null 2>&1 || die "the proof guard's own check FAILS before we start (run: $GUARD apply $PROOF_USER, then check)"

# --- state, cleanup ---------------------------------------------------------------------------------------------

T="$(mktemp -d)"
CT_PROOF=() CT_ROOT=() NET_PROOF=() NET_ROOT=()
SW_EXISTED=0 SW_STAT=""
if [ -e "$OTLP_ENV" ]; then
  SW_EXISTED=1; cp -a "$OTLP_ENV" "$T/switch.orig"; SW_STAT="$(stat -c '%a %u %g' "$OTLP_ENV")"
fi
STARTED=1

reload_guard() { # reload = guard apply; through the unit when it exists, as the installer does
  local out
  if systemctl cat "$UNIT" >/dev/null 2>&1 && out="$(systemctl reload "$UNIT" 2>&1)"; then return 0; fi
  note "systemctl reload $UNIT unavailable or failed (${out:-no unit}); using: guard apply"
  "$GUARD" apply "$PROOF_USER" >"$T/apply.out" 2>&1 || { sed 's/^/    /' "$T/apply.out"; return 1; }
}
set_switch() { # set_switch <content>: root 0644 file; an existing file keeps its owner and mode
  [ -e "$OTLP_ENV" ] || install -m 0644 -o root -g root /dev/null "$OTLP_ENV"
  printf '%s' "$1" >"$OTLP_ENV"
}
restore_switch() {
  if [ "$SW_EXISTED" = 1 ]; then cp -a "$T/switch.orig" "$OTLP_ENV"; else rm -f "$OTLP_ENV"; fi
}

cleanup() {
  local rc=$? n
  trap - EXIT INT TERM
  [ "$STARTED" = 1 ] || exit "$rc"
  echo "== 7 cleanup"
  for n in "${CT_PROOF[@]:-}"; do [ -z "$n" ] || dk_proof rm -f "$n" >/dev/null 2>&1; done
  for n in "${CT_ROOT[@]:-}"; do [ -z "$n" ] || dk_root rm -f "$n" >/dev/null 2>&1; done
  for n in "${NET_PROOF[@]:-}"; do [ -z "$n" ] || dk_proof network rm "$n" >/dev/null 2>&1; done
  for n in "${NET_ROOT[@]:-}"; do [ -z "$n" ] || dk_root network rm "$n" >/dev/null 2>&1; done
  if [ -z "$(dk_proof ps -aq --filter "name=$RUN" 2>/dev/null)$(dk_root ps -aq --filter "name=$RUN" 2>/dev/null)" ]; then
    ok "no throwaway container of run $RUN remains on either daemon"
  else bad "throwaway containers of run $RUN remain"; fi
  if [ -z "$(dk_proof network ls -q --filter "name=$RUN" 2>/dev/null)$(dk_root network ls -q --filter "name=$RUN" 2>/dev/null)" ]; then
    ok "no throwaway network of run $RUN remains on either daemon"
  else bad "throwaway networks of run $RUN remain"; fi
  restore_switch
  if [ "$SW_EXISTED" = 1 ]; then
    if cmp -s "$T/switch.orig" "$OTLP_ENV" && [ "$(stat -c '%a %u %g' "$OTLP_ENV")" = "$SW_STAT" ]; then ok "switch file $OTLP_ENV is exactly as it was (content, mode, owner)"
    else bad "switch file $OTLP_ENV differs from its state at start"; fi
  else
    if [ ! -e "$OTLP_ENV" ]; then ok "switch file $OTLP_ENV absent again, as at start"; else bad "switch file $OTLP_ENV should be absent"; fi
  fi
  if reload_guard && "$GUARD" check "$PROOF_USER" >"$T/final-check.out" 2>&1; then ok "guard reloaded from the restored switch and its check passes"
  else bad "guard check does not pass after cleanup"; sed 's/^/    /' "$T/final-check.out" 2>/dev/null; fi
  rm -rf "$T"
  echo "passed=$PASS failed=$FAIL"
  [ "$FAIL" = 0 ] && [ "$rc" = 0 ] && exit 0
  exit 1
}
trap cleanup EXIT
trap 'echo "interrupted" >&2; exit 130' INT TERM

# --- probes -----------------------------------------------------------------------------------------------------

probe() { # probe <proof|root> [network]; targets "host port" on stdin
  local d=$1 net=${2:-} a=()
  [ -z "$net" ] || a=(--network "$net")
  "dk_$d" run --rm -i "${a[@]}" --memory 64m "$IMG" node -e "$PROBE_JS"
}
hprobe() { # host-side TCP connect from this root shell: open | refused | timeout
  timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null
  case $? in 0) echo open ;; 124) echo timeout ;; *) echo refused ;; esac
}
hserves() { timeout 5 bash -c "exec 3<>/dev/tcp/$1/$2; IFS= read -r -N1 -t 3 b <&3; [ \"\$b\" = x ]" 2>/dev/null; }
listener() { # listener <proof|root> <name> [docker run args...]: a tiny TCP server on :7000
  local d=$1 n=$2
  shift 2
  if [ "$d" = proof ]; then CT_PROOF+=("$n"); else CT_ROOT+=("$n"); fi
  "dk_$d" run -d --name "$n" --memory 64m "$@" "$IMG" node -e "$LISTEN" >/dev/null
}
mknet() { # mknet <proof|root> <name>
  if [ "$1" = proof ]; then NET_PROOF+=("$2"); else NET_ROOT+=("$2"); fi
  "dk_$1" network create "$2" >/dev/null
}
cip() { "dk_$1" inspect -f "{{(index .NetworkSettings.Networks \"$3\").IPAddress}}" "$2"; }
expect_open() { [ "$(res "$1" "$2")" = open ] && ok "$3" || bad "$3 (got: $(res "$1" "$2"))"; }
expect_dropped() { # expect_dropped <file> <host:port> <description>
  case "$(res "$1" "$2")" in
    timeout) ok "$3: dropped (timeout)" ;;
    open) bad "$3: REACHABLE (guard hole)" ;;
    *) bad "$3: got '$(res "$1" "$2")', not a timeout (a DROP in OUTPUT must not answer; check slirp/RST)" ;;
  esac
}
# expect_unreachable <file> <host:port> <description>: for slirp's host alias 10.0.2.2 only. With
# --disable-host-loopback, slirp4netns rejects it INSIDE its own process, before any host socket exists, so the OUTPUT
# guard never sees it and the answer is an error, not a timeout (measured on gda-aicenter 2026-10-12, P2 A2 run 1).
# The property is "never reaches the host": the target port must be one the host LISTENS on (sshd on 0.0.0.0:22), so
# reaching it would read "open". Anything but open passes; the error code is printed.
expect_unreachable() {
  local r code
  r="$(res "$1" "$2")"
  code="$(awk -v t="$2" '$1 == t { print $3; exit }' "$1")"
  case "$r" in
    open) bad "$3: REACHABLE (host loopback through slirp)" ;;
    *) ok "$3: not reachable ($r${code:+ $code}; slirp refuses it in-process with host loopback disabled)" ;;
  esac
}
control() { # control <file> <host:port> <description>: the target answers (open|refused) from the unguarded path
  if answers "$1" "$2"; then ok "control: $3 answers ($(res "$1" "$2")) from the rootful default bridge"
  else bad "control: $3 does NOT answer from the rootful default bridge ($(res "$1" "$2")); its dropped-check proves nothing"; fi
}

echo "test-rootless-guard: user=$PROOF_USER uid=$PROOF_UID socket=$SOCK port=$PORT(undeclared $UNDECL) switch=$OTLP_ENV image=$IMG run=$RUN"
HOST_ADDRS="$(ip -4 -o addr show | addrs_from_ip)"
ALT="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)"
{ [ -n "$ALT" ] && [ "$ALT" != "$OTLP_ADDR" ]; } || ALT="$(echo "$HOST_ADDRS" | grep -v "^$OTLP_ADDR\$" | head -n 1)"
echo "host addresses: $(echo $HOST_ADDRS)  other-address=${ALT:-none}"
WG_CANDS="$(wg show all allowed-ips 2>/dev/null | wg_peers_from | head -n 5)"

# --- 1 + 2: must work, must be dropped ------------------------------------------------------------------------

sect "1 must work (proof daemon), controls on the rootful default bridge"
mknet proof "$RUN-net"; mknet root "$RUN-net"
listener proof "$RUN-peer" --network "$RUN-net"; listener root "$RUN-peer" --network "$RUN-net"
sleep 2
PEER_P="$(cip proof "$RUN-peer" "$RUN-net")"; PEER_R="$(cip root "$RUN-peer" "$RUN-net")"
echo "peer proof=$PEER_P rootful=$PEER_R"
printf '%s 7000\n' "$PEER_P" | probe proof "$RUN-net" >"$T/peer.proof"
printf '%s 7000\n' "$PEER_R" | probe root "$RUN-net" >"$T/peer.root"
expect_open "$T/peer.proof" "$PEER_P:7000" "a peer on its own user-defined network answers (proof)"
expect_open "$T/peer.root" "$PEER_R:7000" "control: the same peer check on the rootful side"

# Targets reached from the host. The rootful control runs first so a wireguard peer that answers can be chosen.
HT="169.254.169.254 80"
for a in $HOST_ADDRS; do HT="$HT
$a 22"; done
for p in 5432 6379 4310 9443; do HT="$HT
$OTLP_ADDR $p"; done
for w in $WG_CANDS; do HT="$HT
$w 22"; done
{ echo "$HT"; echo "1.1.1.1 443"; } | probe root >"$T/ctl.root"
WGPEER=""
for w in $WG_CANDS; do answers "$T/ctl.root" "$w:22" && { WGPEER=$w; break; }; done
PT="$(echo "$HT" | grep -v -E "^($(echo $WG_CANDS | tr ' ' '|' | sed 's/\./\\./g')) 22\$" || true)"
[ -z "$WGPEER" ] || PT="$PT
$WGPEER 22"
{ echo "$PT"; echo "10.0.2.2 22"; echo "1.1.1.1 443"; } | grep -v '^$' | probe proof >"$T/drop.proof"
sed 's/^/    proof  /' "$T/drop.proof"; sed 's/^/    rootful /' "$T/ctl.root"
grep -q '^dns ok$' "$T/drop.proof" && ok "DNS of a public name resolves (proof)" || bad "DNS does not resolve from the proof daemon"
grep -q '^dns ok$' "$T/ctl.root" && ok "control: DNS resolves from the rootful bridge" || bad "control: DNS fails from the rootful bridge"
expect_open "$T/drop.proof" "1.1.1.1:443" "TCP 1.1.1.1:443 connects (proof)"
expect_open "$T/ctl.root" "1.1.1.1:443" "control: 1.1.1.1:443 connects from the rootful bridge"

sect "2 must be dropped (proof), controls from the rootful default bridge"
expect_dropped "$T/drop.proof" "169.254.169.254:80" "metadata 169.254.169.254:80"
control "$T/ctl.root" "169.254.169.254:80" "metadata 169.254.169.254:80"
for a in $HOST_ADDRS; do
  expect_dropped "$T/drop.proof" "$a:22" "host address $a:22"
  control "$T/ctl.root" "$a:22" "host address $a:22"
done
for p in 5432 6379 4310 9443; do
  expect_dropped "$T/drop.proof" "$OTLP_ADDR:$p" "$OTLP_ADDR:$p"
  control "$T/ctl.root" "$OTLP_ADDR:$p" "$OTLP_ADDR:$p"
done
if [ -n "$WGPEER" ]; then
  expect_dropped "$T/drop.proof" "$WGPEER:22" "WireGuard peer $WGPEER:22"
  control "$T/ctl.root" "$WGPEER:22" "WireGuard peer $WGPEER:22"
elif [ -n "$WG_CANDS" ]; then
  bad "WireGuard peers exist ($(echo $WG_CANDS)) but none answers :22 from the rootful bridge: no control, the claim is unproven"
else
  note "no WireGuard peer on this host (wg show all allowed-ips is empty): the peer check was SKIPPED"
fi
ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '^(0\.0\.0\.0|\*|127\.0\.0\.1):22$' \
  || bad "precondition: the host does not listen on 127.0.0.1:22 / 0.0.0.0:22, so the 10.0.2.2:22 check proves nothing"
expect_unreachable "$T/drop.proof" "10.0.2.2:22" "slirp host alias 10.0.2.2:22 (= host loopback)"
note "10.0.2.2:22 has NO rootful control: the address exists only inside slirp4netns"

# --- 3 published ports ----------------------------------------------------------------------------------------

sect "3 published ports"
ANYP="$(free_port)"; CPORT="$(free_port)"; CANY="$(free_port)"
[ -n "$ALT" ] || ALT=127.0.0.1
listener proof "$RUN-decl" --network "$RUN-net" -p "127.0.0.1:$PORT:7000"
listener proof "$RUN-undecl" --network "$RUN-net" -p "127.0.0.1:$UNDECL:7000"
listener proof "$RUN-any" --network "$RUN-net" -p "0.0.0.0:$ANYP:7000"
listener root "$RUN-cpub" -p "127.0.0.1:$CPORT:7000"
listener root "$RUN-cany" -p "0.0.0.0:$CANY:7000"
sleep 3
{ for n in decl undecl any; do echo "$(cip proof "$RUN-$n" "$RUN-net") 7000"; done; } | probe proof "$RUN-net" >"$T/pub.inner"
for n in decl undecl any; do
  ip_="$(cip proof "$RUN-$n" "$RUN-net")"
  expect_open "$T/pub.inner" "$ip_:7000" "control: the $n listener is up inside the proof daemon ($ip_:7000)"
done
hserves 127.0.0.1 "$PORT" && ok "declared 127.0.0.1:$PORT answers from the host and serves its byte" || bad "declared 127.0.0.1:$PORT does not answer from the host (got: $(hprobe 127.0.0.1 "$PORT"))"
for t in "127.0.0.1 $UNDECL" "127.0.0.1 $ANYP" "$ALT $ANYP"; do
  set -- $t
  r="$(hprobe "$1" "$2")"
  case "$r" in
    timeout) ok "undeclared publish $1:$2 times out from the host (reply mute)" ;;
    open) bad "undeclared publish $1:$2 ANSWERS (the reply mute is broken)" ;;
    *) bad "undeclared publish $1:$2 got '$r', not a timeout (is the port driver up?)" ;;
  esac
done
[ "$(hprobe 127.0.0.1 "$CPORT")" = open ] && ok "control: a rootful publish on 127.0.0.1:$CPORT answers from the host" || bad "control: rootful 127.0.0.1:$CPORT does not answer"
[ "$(hprobe "$ALT" "$CANY")" = open ] && ok "control: a rootful publish on 0.0.0.0:$CANY answers on $ALT" || bad "control: rootful 0.0.0.0:$CANY does not answer on $ALT"
for n in decl undecl any; do dk_proof rm -f "$RUN-$n" >/dev/null 2>&1; done
for n in cpub cany; do dk_root rm -f "$RUN-$n" >/dev/null 2>&1; done

# --- 4 OTLP exception -----------------------------------------------------------------------------------------

sect "4 OTLP exception ($OTLP_ADDR:$OTLP_PORT, switch $OTLP_ENV)"
chain_ct() { iptables -w -S "$TAG-OUT" 2>/dev/null | count_ctorigdst; }
OT="$OTLP_ADDR $OTLP_PORT
$OTLP_ADDR $((OTLP_PORT + 1))
$OTLP_ADDR 5432
$OTLP_ADDR 22"
[ -z "$ALT" ] || OT="$OT
$ALT $OTLP_PORT"
printf '%s\n' "$OT" | probe root >"$T/otlp.ctl"
[ "$(hprobe "$OTLP_ADDR" "$OTLP_PORT")" = open ] && ok "precondition: the ERP collector listens on $OTLP_ADDR:$OTLP_PORT (host connect)" || bad "precondition: nothing answers on $OTLP_ADDR:$OTLP_PORT from the host; the open-checks below cannot pass"
control "$T/otlp.ctl" "$OTLP_ADDR:$OTLP_PORT" "$OTLP_ADDR:$OTLP_PORT"
control "$T/otlp.ctl" "$OTLP_ADDR:$((OTLP_PORT + 1))" "$OTLP_ADDR:$((OTLP_PORT + 1))"
[ -z "$ALT" ] || control "$T/otlp.ctl" "$ALT:$OTLP_PORT" "$ALT:$OTLP_PORT"

set_switch ""; reload_guard || bad "reload with the switch empty failed"
printf '%s\n' "$OT" | probe proof >"$T/otlp.off"
expect_dropped "$T/otlp.off" "$OTLP_ADDR:$OTLP_PORT" "switch off: $OTLP_ADDR:$OTLP_PORT"
[ "$(chain_ct)" = 0 ] && ok "switch off: no ctorigdst rule in $TAG-OUT" || bad "switch off but a ctorigdst rule exists in $TAG-OUT"

set_switch "WEBDESK_OTLP_PORT=$OTLP_PORT
"
reload_guard || bad "reload with WEBDESK_OTLP_PORT=$OTLP_PORT failed"
[ "$(chain_ct)" -ge 1 ] && ok "switch on: $TAG-OUT holds the ctorigdst rule" || bad "switch on but no ctorigdst rule (the guard refused the switch file? see its warning)"
"$GUARD" check "$PROOF_USER" >"$T/on-check.out" 2>&1 && ok "guard check passes with the exception on" || { bad "guard check FAILS with the exception on"; sed 's/^/    /' "$T/on-check.out"; }
NAME_DEFAULT="$(iptables -w -S "$TAG-OUT" | hashlimit_name)"
printf '%s\n' "$OT" | probe proof >"$T/otlp.on"
sed 's/^/    on  /' "$T/otlp.on"
expect_open "$T/otlp.on" "$OTLP_ADDR:$OTLP_PORT" "switch on: $OTLP_ADDR:$OTLP_PORT connects (ERP collector)"
expect_dropped "$T/otlp.on" "$OTLP_ADDR:$((OTLP_PORT + 1))" "switch on: another port on $OTLP_ADDR ($((OTLP_PORT + 1)))"
expect_dropped "$T/otlp.on" "$OTLP_ADDR:5432" "switch on: $OTLP_ADDR:5432"
expect_dropped "$T/otlp.on" "$OTLP_ADDR:22" "switch on: $OTLP_ADDR:22"
[ -z "$ALT" ] || expect_dropped "$T/otlp.on" "$ALT:$OTLP_PORT" "switch on: port $OTLP_PORT on another host address ($ALT)"

# The cap bites: 2 pps (burst 4) cannot admit 40 connections; the default cap admits them (control).
burst_lines 40 "$OTLP_ADDR" "$OTLP_PORT" | probe proof >"$T/burst.default"
N_DEF="$(grep -c "^$OTLP_ADDR:$OTLP_PORT open\$" "$T/burst.default" || true)"
set_switch "WEBDESK_OTLP_PORT=$OTLP_PORT
WEBDESK_OTLP_PPS=2
"
reload_guard || bad "reload with WEBDESK_OTLP_PPS=2 failed"
NAME_CAPPED="$(iptables -w -S "$TAG-OUT" | hashlimit_name)"
burst_lines 40 "$OTLP_ADDR" "$OTLP_PORT" | probe proof >"$T/burst.capped"
N_CAP="$(grep -c "^$OTLP_ADDR:$OTLP_PORT open\$" "$T/burst.capped" || true)"
[ "$N_CAP" -lt 40 ] && ok "cap 2 pps: a 40-connection burst admitted $N_CAP, not all 40" || bad "cap 2 pps: all 40 connections admitted"
[ "$N_DEF" -gt "$N_CAP" ] && ok "control: at the default cap the same burst admitted $N_DEF (> $N_CAP)" || bad "control: the default cap admitted $N_DEF, not more than the 2 pps cap ($N_CAP); the burst proves nothing"
if [ -n "$NAME_DEFAULT" ] && [ -n "$NAME_CAPPED" ] && [ "$NAME_DEFAULT" != "$NAME_CAPPED" ]; then ok "a changed cap makes a NEW hashlimit table name ($NAME_DEFAULT -> $NAME_CAPPED)"
else bad "hashlimit name did not change with the cap ($NAME_DEFAULT -> $NAME_CAPPED)"; fi
{ [ -e "/proc/net/ipt_hashlimit/$NAME_CAPPED" ] && ok "/proc/net/ipt_hashlimit/ lists the new table $NAME_CAPPED"; } || bad "/proc/net/ipt_hashlimit/$NAME_CAPPED does not exist"

# Off again: empty the port, reload; no ctorigdst rule may remain.
set_switch "WEBDESK_OTLP_PORT=
"
reload_guard || bad "reload with the port emptied failed"
[ "$(chain_ct)" = 0 ] && ok "switch off again: no ctorigdst rule remains in $TAG-OUT" || bad "switch off again but a ctorigdst rule remains"
printf '%s\n' "$OT" | probe proof >"$T/otlp.off2"
expect_dropped "$T/otlp.off2" "$OTLP_ADDR:$OTLP_PORT" "switch off again: $OTLP_ADDR:$OTLP_PORT"
restore_switch
reload_guard || bad "reload after restoring the switch failed"
if [ "$SW_EXISTED" = 1 ]; then
  cmp -s "$T/switch.orig" "$OTLP_ENV" && [ "$(stat -c '%a %u %g' "$OTLP_ENV")" = "$SW_STAT" ] && ok "switch file restored exactly to its state at start" || bad "switch file not restored exactly"
else [ ! -e "$OTLP_ENV" ] && ok "switch file absent again, as at start" || bad "switch file should be absent"; fi

# --- 5 IPv6 ---------------------------------------------------------------------------------------------------

sect "5 IPv6"
V6="$(ip6tables -w -S 2>/dev/null)"
echo "$V6" | grep -q -- "^-A $TAG-DENY -j DROP\$" && ok "ip6tables: $TAG-DENY ends in a drop-all" || bad "ip6tables: no '-A $TAG-DENY -j DROP'"
[ "$(echo "$V6" | grep -c -- "^-A $TAG-SEL -m owner --uid-owner .* -j $TAG-DENY\$")" = 2 ] && ok "ip6tables: both uid selectors (daemon uid and subuid range) lead to the drop-all" || bad "ip6tables: $TAG-SEL does not send both selectors to $TAG-DENY"
[ "$(echo "$V6" | grep -c -- "^-A OUTPUT -j $TAG-SEL\$")" = 1 ] && ok "ip6tables: exactly one OUTPUT jump to $TAG-SEL" || bad "ip6tables: OUTPUT does not jump to $TAG-SEL exactly once"
note "no packet probe for IPv6: the host has no global IPv6, so a control cannot exist; the rules are the evidence"

# --- 6 drift --------------------------------------------------------------------------------------------------

sect "6 drift"
"$GUARD" check "$PROOF_USER" >/dev/null 2>&1 && ok "baseline: check passes before the drift" || bad "baseline: check fails before the drift"
iptables -w -A "$TAG-DENY" -s 192.0.2.254/32 -j RETURN # after the final DROP: harmless, never matches
"$GUARD" check "$PROOF_USER" >"$T/drift.out" 2>&1 && bad "check PASSES with an extra rule appended to $TAG-DENY (drift undetected)" || ok "check FAILS with an extra rule appended to $TAG-DENY"
reload_guard || bad "reload after the drift failed"
"$GUARD" check "$PROOF_USER" >"$T/repair.out" 2>&1 && ok "reload repairs it: check passes" || { bad "check still FAILS after reload"; sed 's/^/    /' "$T/repair.out"; }

exit 0
