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
cleanup() {
  guard remove >/dev/null 2>&1
  docker rm -f "$NET-srv" "$NET-pub" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
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
  docker run --rm -i --network "$NET" --memory 64m "$IMG" node -e '
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
N1="$(sudo -n iptables -S | grep -c 'WEBDESK-')"
guard apply >/dev/null; N2="$(sudo -n iptables -S | grep -c 'WEBDESK-')"
[ "$N1" = "$N2" ] && ok "apply is idempotent ($N1 rules)" || bad "second apply changed the rule count ($N1 -> $N2)"
guard remove >/dev/null; N3="$(sudo -n iptables -S | grep -c 'WEBDESK-' || true)"
[ "$N3" = 0 ] && ok "remove leaves no WEBDESK- rule or chain" || bad "remove left $N3 rules"
echo "== $PASS passed, $FAIL failed"
rm -f /tmp/$NET.before /tmp/$NET.after
[ "$FAIL" = 0 ]
