#!/usr/bin/env bash
# Proves webdesk-egress-guard.sh on a Linux docker host against a THROWAWAY network (never the live one):
#   bash test-egress-guard.sh /path/to/webdesk-egress-guard.sh
# The guard's rules match only the throwaway network's subnet, so nothing else on the host is affected.
# Needs passwordless sudo and docker. Exit 0 only if every check passes.
set -uo pipefail
GUARD="$1"
NET="m4guard-$(date +%s)"
IMG="${PROBE_IMAGE:-node:22-alpine}"
RES="$(grep -m1 '^nameserver' /run/systemd/resolve/resolv.conf 2>/dev/null | awk '{print $2}')"
RES="${RES:-$(grep -m1 '^nameserver' /etc/resolv.conf | awk '{print $2}')}"
PASS=0; FAIL=0
ok() { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
guard() { sudo -n env WEBDESK_NETWORK="$NET" WEBDESK_RESOLVER="$RES" sh "$GUARD" "$@"; }
# The same with the OTLP exception on for $OTLP at $DOCKER0 (extra VAR=value words go before the script).
guard_otlp() { sudo -n env WEBDESK_NETWORK="$NET" WEBDESK_RESOLVER="$RES" WEBDESK_OTLP_PORT="$OTLP" WEBDESK_OTLP_ADDR="$DOCKER0" "$@" sh "$GUARD" apply; }
cleanup() {
  guard remove >/dev/null 2>&1
  docker rm -f "$NET-srv" "$NET-pub" "$NET-otlp" "$NET-other" >/dev/null 2>&1
  docker network rm "$NET" "$NET-ctl" >/dev/null 2>&1
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
SUBNET="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET")"
GW="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NET")"
# A peer on the same bridge (stands in for postgres), and a loopback-published one (stands in for Caddy).
docker run -d --name "$NET-srv" --network "$NET" --memory 64m "$IMG" node -e 'require("net").createServer(s=>{s.on("error",()=>{});s.end("x")}).listen(7000)' >/dev/null
docker run -d --name "$NET-pub" --network "$NET" --memory 64m -p 127.0.0.1:0:7000 "$IMG" node -e 'require("net").createServer(s=>{s.on("error",()=>{});s.end("x")}).listen(7000)' >/dev/null
sleep 2
SRV="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$NET-srv")"
PUBPORT="$(docker port "$NET-pub" 7000/tcp | head -1 | sed 's/.*://')"
HOST_ADDRS="$(ip -4 -o addr show | awk '{split($4, a, "/"); print a[1]}' | grep -v '^127\.' | sort -u)"
SSH_ADDR="$(echo "$HOST_ADDRS" | head -1)"
PRIV_PEER="$(ip -4 -o addr show | awk '$2 ~ /^wg/ {split($4, a, "/"); split(a[1], o, "."); print o[1]"."o[2]"."o[3]"."(o[4] == 1 ? 2 : 1)}' | head -1)"
echo "throwaway $NET subnet=$SUBNET gw=$GW resolver=$RES peer=$SRV wg-peer=${PRIV_PEER:-none}"

probe() {
  docker run --rm -i --network "${PROBE_NET:-$NET}" --memory 64m "$IMG" node -e '
    const net = require("net"), dns = require("dns");
    const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
    const tcp = (h, p) => new Promise((res) => { const s = net.connect({ host: h, port: +p });
      const d = (r) => { s.destroy(); res(`${h}:${p} ${r}`); };
      s.setTimeout(2500, () => d("timeout")); s.on("connect", () => d("open"));
      s.on("error", (e) => d(e.code === "ECONNREFUSED" ? "refused" : "error")); });
    const look = () => new Promise((res) => dns.lookup("github.com", (e, a) => res(`dns ${e ? "fail" : "ok"}`)));
    Promise.all([look(), ...lines.map((l) => tcp(...l.split(" ")))]).then((r) => console.log(r.join("\n")));'
}
TARGETS="$SRV 7000
$GW 22
$SSH_ADDR 22
169.254.169.254 80
1.1.1.1 443"
[ -n "$PRIV_PEER" ] && TARGETS="$TARGETS
$PRIV_PEER 22"
state() { grep -q "^$1 open$" "$2"; }

echo "== before"; echo "$TARGETS" | probe | tee /tmp/$NET.before | sed 's/^/    /'
guard apply | sed 's/^/    /'
echo "== after";  echo "$TARGETS" | probe | tee /tmp/$NET.after | sed 's/^/    /'
A=/tmp/$NET.after
state "$SRV:7000" $A && ok "own bridge still works (peer :7000)" || bad "own bridge broken"
grep -q '^dns ok$' $A && ok "DNS still resolves (via $RES)" || bad "DNS broken"
state "1.1.1.1:443" $A && ok "public internet still reachable" || bad "internet blocked"
[ "$(timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$PUBPORT; head -c1 <&3" 2>/dev/null)" = x ] && ok "host -> loopback-published container still answers (replies pass)" || bad "loopback-published container unreachable from the host"
state "$GW:22" $A && bad "host sshd via the network gateway still reachable" || ok "host sshd via the gateway blocked"
state "$SSH_ADDR:22" $A && bad "host sshd via $SSH_ADDR still reachable" || ok "host sshd via $SSH_ADDR blocked"
state "169.254.169.254:80" $A && bad "metadata/link-local still reachable" || ok "link-local :80 blocked"
if [ -n "$PRIV_PEER" ]; then state "$PRIV_PEER:22" $A && bad "wireguard peer still reachable" || ok "wireguard peer blocked"; fi
# Controls: what was blocked after must have been open before, or the check proves nothing.
B=/tmp/$NET.before
for t in "$GW:22" "$SSH_ADDR:22"; do state "$t" $B && ok "control: $t was open before the guard" || echo "  note  $t was already closed before the guard (not a control)"; done
# ---- the one exception: WebDesk's OTLP push to a port published on the docker0 address (WSK-D63 (2)) ----
# A stand-in listener on the DEFAULT bridge, published on docker0 and on a second host address (so "that
# port on any other host address" has a real listener to be blocked from), and a second listener on a
# different port. A published port is reached from the guarded network through DNAT -> FORWARD, so this
# proves the --ctorigdst rule (the 172.16/12 drop would otherwise kill it).
DOCKER0="$(ip -4 -o addr show docker0 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | head -1)"
if [ -z "$DOCKER0" ]; then
  echo "  note  no docker0 address on this host: the OTLP exception checks were SKIPPED"
else
  OTLP=$((24000 + RANDOM % 1000)); OTHER=$((OTLP + 1))
  ALT="$(echo "$HOST_ADDRS" | grep -v "^$DOCKER0\$" | head -1)"
  PUBS="-p $DOCKER0:$OTLP:7000"; PUBO="-p $DOCKER0:$OTHER:7000"
  [ -n "$ALT" ] && { PUBS="$PUBS -p $ALT:$OTLP:7000"; PUBO="$PUBO -p $ALT:$OTHER:7000"; }
  LISTEN='require("net").createServer(s=>{s.on("error",()=>{});s.end("x")}).listen(7000)'
  # shellcheck disable=SC2086
  docker run -d --name "$NET-otlp" --memory 64m $PUBS "$IMG" node -e "$LISTEN" >/dev/null
  # shellcheck disable=SC2086
  docker run -d --name "$NET-other" --memory 64m $PUBO "$IMG" node -e "$LISTEN" >/dev/null
  sleep 2
  OT="$DOCKER0 $OTLP
$DOCKER0 $OTHER"
  [ -n "$ALT" ] && OT="$OT
$ALT $OTLP
$ALT $OTHER"
  echo "== otlp exception: stand-ins on docker0=$DOCKER0 ports $OTLP (the exception) and $OTHER, other address=${ALT:-none}"
  # Control: from a SECOND throwaway network the guard never touches, every stand-in answers, so a block
  # below is the guard's doing. Same cross-bridge path (DNAT -> FORWARD) as the guarded probes; NOT the
  # default bridge, where reaching your own gateway's published port is a hairpin Docker does not
  # reliably do (that was a false FAIL on sumopod, 2026-10-11). Waits for the stand-ins under load.
  docker network create "$NET-ctl" >/dev/null
  C=/tmp/$NET.otlp.ctl
  for _ in 1 2 3 4 5 6 7 8; do
    echo "$OT" | PROBE_NET="$NET-ctl" probe > $C
    state "$DOCKER0:$OTLP" $C && state "$DOCKER0:$OTHER" $C && break
    sleep 2
  done
  sed 's/^/    ctl  /' $C
  if state "$DOCKER0:$OTLP" $C && state "$DOCKER0:$OTHER" $C; then ok "control: both stand-ins answer from an unguarded throwaway network"; else bad "control: stand-ins do not answer unguarded; the OTLP checks prove nothing"; fi
  # Exception OFF (the guard is applied without it above): the very same port is blocked.
  echo "$OT" | probe | tee /tmp/$NET.otlp.off | sed 's/^/    off  /'
  O=/tmp/$NET.otlp.off
  if state "$DOCKER0:$OTLP" $O; then bad "exception OFF: $DOCKER0:$OTLP is reachable (default-deny broken)"; else ok "exception OFF: $DOCKER0:$OTLP blocked"; fi
  if sudo -n iptables -S | grep 'WEBDESK-' | grep -q -- '--ctorigdst'; then bad "exception OFF but a --ctorigdst rule exists"; else ok "exception OFF: no ctorigdst/OTLP rule in the chains"; fi
  # Exception ON.
  guard_otlp | sed 's/^/    /'
  { printf '%s\n' "$TARGETS"; echo "$OT"; } | probe | tee /tmp/$NET.otlp.on | sed 's/^/    on   /'
  O=/tmp/$NET.otlp.on
  if state "$DOCKER0:$OTLP" $O; then ok "exception ON: $DOCKER0:$OTLP reachable (published port, through DNAT/FORWARD)"; else bad "exception ON: $DOCKER0:$OTLP still blocked"; fi
  if state "$DOCKER0:$OTHER" $O; then bad "exception ON: another port on $DOCKER0 ($OTHER) is reachable"; else ok "exception ON: another port on $DOCKER0 ($OTHER) stays blocked"; fi
  if [ -n "$ALT" ]; then
    if state "$ALT:$OTLP" $O; then bad "exception ON: the same port on another host address ($ALT:$OTLP) is reachable"; else ok "exception ON: the same port on another host address stays blocked"; fi
    if state "$ALT:$OTHER" $O; then bad "exception ON: $ALT:$OTHER is reachable"; else ok "exception ON: another port on another host address stays blocked"; fi
  fi
  if state "$GW:22" $O; then bad "exception ON: host sshd via the gateway became reachable"; else ok "exception ON: host sshd via the gateway still blocked"; fi
  if state "$SSH_ADDR:22" $O; then bad "exception ON: host sshd via $SSH_ADDR became reachable"; else ok "exception ON: host sshd via $SSH_ADDR still blocked"; fi
  if state "169.254.169.254:80" $O; then bad "exception ON: metadata service became reachable"; else ok "exception ON: metadata service still blocked"; fi
  if grep -q '^dns ok$' $O && state "1.1.1.1:443" $O && state "$SRV:7000" $O; then ok "exception ON: DNS, the internet and the own bridge still work"; else bad "exception ON: DNS/internet/own bridge broke"; fi
  RULES="$(sudo -n iptables -S | grep 'WEBDESK-')"
  if echo "$RULES" | grep -Eq -- "-A WEBDESK-EGRESS -p tcp -m conntrack --ctorigdst $DOCKER0(/32)? --ctorigdstport $OTLP -j RETURN"; then ok "FORWARD rule matches the original destination (ctorigdst)"; else bad "no ctorigdst RETURN for $DOCKER0:$OTLP in WEBDESK-EGRESS"; fi
  if echo "$RULES" | grep -Eq -- "-A WEBDESK-HOST-IN -d $DOCKER0(/32)? -p tcp -m tcp --dport $OTLP -j RETURN"; then ok "INPUT rule opens $DOCKER0:$OTLP (userland-proxy path)"; else bad "no --dport RETURN for $DOCKER0:$OTLP in WEBDESK-HOST-IN"; fi
  if echo "$RULES" | grep -q 'hashlimit'; then ok "the packet-rate cap (hashlimit) is in the chains ($(echo "$RULES" | grep -c hashlimit) rules)"; else bad "no hashlimit rule: the exception is uncapped"; fi
  # The exception rules sit BEFORE the drops.
  FIRST_DROP="$(sudo -n iptables -S WEBDESK-EGRESS | grep -n -- '-j DROP' | grep -v hashlimit | head -1 | cut -d: -f1)"
  RET="$(sudo -n iptables -S WEBDESK-EGRESS | grep -n -- "--ctorigdstport $OTLP -j RETURN" | head -1 | cut -d: -f1)"
  if [ -n "$RET" ] && [ -n "$FIRST_DROP" ] && [ "$RET" -lt "$FIRST_DROP" ]; then ok "the OTLP RETURN precedes the first DROP"; else bad "the OTLP RETURN does not precede the drops (ret=$RET drop=$FIRST_DROP)"; fi
  # Re-apply with it on is idempotent.
  A1="$(sudo -n iptables -S | grep -c 'WEBDESK-')"; guard_otlp >/dev/null; A2="$(sudo -n iptables -S | grep -c 'WEBDESK-')"
  if [ "$A1" = "$A2" ]; then ok "re-apply with the exception on is idempotent ($A1 rules)"; else bad "re-apply with the exception on changed the rule count ($A1 -> $A2)"; fi
  # The cap bites: at 2 packets/s (burst 4) a 40-connection burst cannot all be admitted.
  guard_otlp WEBDESK_OTLP_PPS=2 >/dev/null
  BURST="$(for _ in $(seq 40); do echo "$DOCKER0 $OTLP"; done)"
  NOPEN="$(echo "$BURST" | probe | grep -c "^$DOCKER0:$OTLP open$" || true)"
  if [ "$NOPEN" -lt 40 ]; then ok "rate cap: a 40-connection burst at 2 pps admitted $NOPEN, not all 40"; else bad "rate cap: all 40 connections were admitted at 2 pps"; fi
  guard_otlp >/dev/null
  if echo "$OT" | probe | grep -q "^$DOCKER0:$OTLP open$"; then ok "after restoring the default cap the port answers again"; else bad "the port did not recover after the cap was restored"; fi
  # Exception OFF again: the same port is blocked, and no OTLP rule is left.
  guard apply >/dev/null
  echo "$OT" | probe > /tmp/$NET.otlp.off2
  if state "$DOCKER0:$OTLP" /tmp/$NET.otlp.off2; then bad "exception turned OFF again but $DOCKER0:$OTLP is still reachable"; else ok "exception turned OFF again: $DOCKER0:$OTLP blocked"; fi
  if sudo -n iptables -S | grep 'WEBDESK-' | grep -q -- '--ctorigdst'; then bad "exception OFF again but a ctorigdst rule remains"; else ok "exception OFF again: no OTLP rule remains"; fi
  rm -f /tmp/$NET.otlp.ctl /tmp/$NET.otlp.off /tmp/$NET.otlp.on /tmp/$NET.otlp.off2
fi
N1="$(sudo -n iptables -S | grep -c 'WEBDESK-')"
guard apply >/dev/null; N2="$(sudo -n iptables -S | grep -c 'WEBDESK-')"
[ "$N1" = "$N2" ] && ok "apply is idempotent ($N1 rules)" || bad "second apply changed the rule count ($N1 -> $N2)"
guard remove >/dev/null; N3="$(sudo -n iptables -S | grep -c 'WEBDESK-' || true)"
[ "$N3" = 0 ] && ok "remove leaves no WEBDESK- rule or chain" || bad "remove left $N3 rules"
echo "== $PASS passed, $FAIL failed"
rm -f /tmp/$NET.before /tmp/$NET.after
[ "$FAIL" = 0 ]
