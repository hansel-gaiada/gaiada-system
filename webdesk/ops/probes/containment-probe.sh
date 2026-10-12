#!/usr/bin/env bash
# WebDesk containment probe set (design v2.3 §03, WSK-D34) — M4.
#
# Run ON gda-aicenter, as the operator with passwordless sudo. A suite proves the code; this proves the
# boundary, and a boundary can only be probed where it stands. Every probe carries a control that would
# make it fail if the property were absent: a deny probe that cannot fail proves nothing.
#
#   bash containment-probe.sh            # all six probes; exit 0 only if every probe passes
#   PROBE_ONLY=3 bash containment-probe.sh
#   WS4_HMAC_RETIRED=1 bash containment-probe.sh
#       M4 F1 phase 3 and after (infra/runbooks/webdesk-ws4-keys.md): the WS4 HMAC key is gone from both
#       sides, so probe 6 no longer lists WEBDESK_CONTROL_WS4_KEY as shared by design and FAILS if that
#       ERP value is found anywhere in the WebDesk surface. Leave unset until phase 3 is done.
#
# What it changes: nothing in the `webdesk` or `gaiada` projects. It starts short-lived throwaway
# containers named m4probe-* (removed on exit) on the `webdesk_default` and default `bridge` networks,
# and two throwaway compose projects m4probe-*-erp / m4probe-*-wd for the orphan probe.
#
# THE REPO IS PUBLIC. The raw output names host addresses and ports: keep it in a *.local.md file
# (gitignored), never in a committed doc. Secrets are never printed: the credential sweep prints key
# names and counts only.
set -uo pipefail

WD="${WEBDESK_DIR:-/home/Hansel/gaiada-webdesk/webdesk}"
ENVF="${WEBDESK_ENV_FILE:-/etc/webdesk/.env}"
ERP_ENV="${ERP_ENV_FILE:-/home/Hansel/gaiada/infra/compose/.env}"
PROJECT=webdesk
ERP_PROJECT=gaiada
NET=webdesk_default
PROBE_IMG="${PROBE_IMAGE:-node:22-alpine}"
RUN="m4probe-$(date +%s)"
ONLY="${PROBE_ONLY:-}"
WS4_HMAC_RETIRED="${WS4_HMAC_RETIRED:-0}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

ok()  { echo "  PASS  $*"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $*"; FAIL=$((FAIL + 1)); }
hdr() { echo; echo "== $*"; }
want() { [ -z "$ONLY" ] || [ "$ONLY" = "$1" ]; }

cleanup() {
  docker ps -aq --filter "name=^${RUN}" | xargs -r docker rm -f >/dev/null 2>&1
  for p in "${RUN}-erp" "${RUN}-wd"; do
    docker ps -aq --filter "label=com.docker.compose.project=$p" | xargs -r docker rm -f >/dev/null 2>&1
    docker network rm "${p}_default" >/dev/null 2>&1
  done
  rm -rf "$TMP"
}
trap cleanup EXIT

compose_wd() {
  (cd "$WD" && sudo -n docker compose --env-file "$ENVF" -p "$PROJECT" \
    -f docker-compose.yml -f docker-compose.aicenter.yml "$@")
}

# One TCP connect per target, all in parallel, from a throwaway container on network $1.
# Targets on stdin, one "host port" per line. Prints "host:port open|refused|timeout|error".
tcp_probe() {
  local net="$1"
  docker run --rm -i --name "${RUN}-tcp-$RANDOM" --network "$net" \
    --cpus 0.25 --memory 64m --pids-limit 64 --security-opt no-new-privileges:true \
    "$PROBE_IMG" node -e '
      const net = require("net");
      const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
      const one = (h, p) => new Promise((res) => {
        const s = net.connect({ host: h, port: +p });
        const done = (r) => { s.destroy(); res(`${h}:${p} ${r}`); };
        s.setTimeout(2500, () => done("timeout"));
        s.on("connect", () => done("open"));
        s.on("error", (e) => done(e.code === "ECONNREFUSED" ? "refused" : "error:" + e.code));
      });
      Promise.all(lines.map((l) => one(...l.trim().split(/\s+/)))).then((r) => console.log(r.join("\n")));
    '
}

# ---------------------------------------------------------------------------------------------------
# Facts every probe uses, discovered at run time (never hard-coded: the deny must follow the network)
WD_SUBNET="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
WD_GW="$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')"
WD_IPV6="$(docker network inspect "$NET" --format '{{.EnableIPv6}}')"
HOST_ADDRS="$(ip -4 -o addr show | awk '{split($4, a, "/"); print a[1]}' | grep -v '^127\.' | sort -u)"
WG_PEERS="$(sudo -n wg show all allowed-ips 2>/dev/null | awk '{for (i = 3; i <= NF; i++) {split($i, a, "/"); print a[1]}}' | sort -u)"
echo "webdesk network $NET subnet=$WD_SUBNET gateway=$WD_GW ipv6=$WD_IPV6"
echo "host addresses: $(echo $HOST_ADDRS)"
echo "wireguard peers: $(echo ${WG_PEERS:-none})"

# ---------------------------------------------------------------------------------------------------
if want 1; then
hdr "1 · Resolved-config port audit (AC 2): nothing published but the proxy, on 127.0.0.1"
compose_wd config --format json > "$TMP/resolved.json" 2>"$TMP/config.err" \
  || { bad "docker compose config failed: $(tail -1 "$TMP/config.err")"; }
# The checker: every published port must be the proxy's, bound to 127.0.0.1.
AUDIT='[.services | to_entries[] | .key as $s | (.value.ports // [])[]
        | select($s != "proxy" or (.host_ip // "") != "127.0.0.1")
        | "\($s) \(.host_ip // "0.0.0.0"):\(.published)->\(.target)"]'
if [ -s "$TMP/resolved.json" ]; then
  jq -r '.services | to_entries[] | "    \(.key): \([(.value.ports // [])[] | "\(.host_ip // "0.0.0.0"):\(.published)->\(.target)"] | join(", "))"' "$TMP/resolved.json"
  VIOL="$(jq -c "$AUDIT" "$TMP/resolved.json")"
  NPROXY="$(jq '[.services.proxy.ports // [] | .[] | select(.host_ip == "127.0.0.1")] | length' "$TMP/resolved.json")"
  if [ "$VIOL" = "[]" ] && [ "$NPROXY" -ge 1 ]; then ok "resolved config: only proxy publishes, on 127.0.0.1 ($NPROXY port)"; else bad "resolved config publishes: $VIOL"; fi
  # Control: the same checker on a copy whose proxy binds all interfaces, and one where api gains a port.
  jq '.services.proxy.ports[0].host_ip = ""' "$TMP/resolved.json" > "$TMP/ctl1.json"
  jq '.services.api.ports = [{"mode":"ingress","host_ip":"127.0.0.1","target":3000,"published":"3000","protocol":"tcp"}]' "$TMP/resolved.json" > "$TMP/ctl2.json"
  if [ "$(jq -c "$AUDIT" "$TMP/ctl1.json")" != "[]" ] && [ "$(jq -c "$AUDIT" "$TMP/ctl2.json")" != "[]" ]; then
    ok "control: the checker flags a 0.0.0.0 proxy and a published api port"
  else bad "control: the checker missed a planted publication"; fi
  # The running project must match the resolved config (a config nobody runs proves nothing).
  RUNNING="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')"
  CONFIGURED="$(jq -r '.services | keys[]' "$TMP/resolved.json" | sort | tr '\n' ' ')"
  [ "$RUNNING" = "$CONFIGURED" ] && ok "running services = resolved services ($RUNNING)" || bad "running [$RUNNING] != resolved [$CONFIGURED]"
  LIVEPUB="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}} {{.Ports}}' | grep -oE '[0-9.:\[\]]+->[0-9]+/(tcp|udp)' | grep -v '^127\.0\.0\.1:' || true)"
  [ -z "$LIVEPUB" ] && ok "live containers: every published port is on 127.0.0.1" || bad "live containers publish beyond loopback: $LIVEPUB"
fi
fi

# ---------------------------------------------------------------------------------------------------
if want 2; then
hdr "2 · Host nginx routes by hostname to the loopback Caddy; :80/:443 are nginx's (AC 2)"
OWN="$(sudo -n ss -ltnpH '( sport = :80 or sport = :443 )' | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | sort -u | tr '\n' ' ')"
[ "$OWN" = "nginx " ] && ok ":80/:443 listeners are all nginx" || bad ":80/:443 owned by: $OWN"
PROXY_PORT="$(jq -r '.services.proxy.ports[0].published' "$TMP/resolved.json" 2>/dev/null || echo 8380)"
NGX="$(sudo -n nginx -T 2>/dev/null | awk -v want="127.0.0.1:$PROXY_PORT" '
  /server_name/ { sn = $0 } /proxy_pass/ && index($0, want) { gsub(/;|server_name/, "", sn); gsub(/^ +| +$/, "", sn); print sn }' | sort -u | tr '\n' ' ')"
[ -n "$NGX" ] && ok "nginx vhosts proxying to 127.0.0.1:$PROXY_PORT: $NGX" || bad "no nginx vhost proxies to 127.0.0.1:$PROXY_PORT"
API_HOST="$(echo "$NGX" | tr ' ' '\n' | grep -m1 '^api\.' || echo api.erp.gaiada.com)"
code_type() { curl -sk -o "$TMP/body" -w '%{http_code} %{content_type}' "$@"; }
R1="$(code_type --resolve "$API_HOST:443:127.0.0.1" "https://$API_HOST/v1/t/m4-probe-no-such-tenant/collections")"
case "$R1" in 401\ application/problem+json*) ok "via nginx with Host $API_HOST -> WebDesk ($R1)";; *) bad "via nginx with Host $API_HOST -> $R1";; esac
# Control: same listener, a hostname nginx does not route to WebDesk, must NOT reach WebDesk.
R2="$(code_type --resolve "m4-probe.invalid:443:127.0.0.1" "https://m4-probe.invalid/v1/t/m4-probe-no-such-tenant/collections")"
case "$R2" in *problem+json*) bad "control: an unknown Host also reached WebDesk ($R2)";; *) ok "control: unknown Host is not routed to WebDesk ($R2)";; esac
R3="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PROXY_PORT/healthz")"
[ "$R3" = 200 ] && ok "Caddy answers on 127.0.0.1:$PROXY_PORT (/healthz 200)" || bad "Caddy loopback /healthz -> $R3"
for a in $HOST_ADDRS; do
  R4="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://$a:$PROXY_PORT/healthz" || true)"
  [ "$R4" = 000 ] && ok "Caddy is not reachable on $a:$PROXY_PORT" || bad "Caddy answers on $a:$PROXY_PORT ($R4)"
done
fi

# ---------------------------------------------------------------------------------------------------
if want 3; then
hdr "3 · Host Postgres is unreachable from the webdesk network, with controls (AC 6)"
PG_ADDRS="$(sudo -n ss -ltnH 'sport = :5432' | awk '{print $4}' | sed -E 's/:5432$//; s/^\[|\]$//g' | grep -v -E '^(127\.|::1)' | sort -u)"
echo "    host Postgres listens on (non-loopback): $(echo $PG_ADDRS)"
TARGETS="$( { for a in $PG_ADDRS $HOST_ADDRS $WD_GW; do echo "$a 5432"; done; } | sort -u)"
echo "$TARGETS" | tcp_probe "$NET" > "$TMP/p3-wd.txt"
sed 's/^/    from webdesk: /' "$TMP/p3-wd.txt"
grep -q ' open$' "$TMP/p3-wd.txt" && bad "host Postgres reachable from $NET" || ok "host Postgres: no address answers from $NET"
# Control A: the same probe from the default bridge (no deny) reaches Postgres — the probe CAN see it.
echo "$PG_ADDRS" | awk '{print $1, 5432}' | tcp_probe bridge > "$TMP/p3-ctl.txt"
sed 's/^/    from bridge:  /' "$TMP/p3-ctl.txt"
grep -q ' open$' "$TMP/p3-ctl.txt" && ok "control A: the same probe reaches host Postgres from the default bridge" \
  || bad "control A: host Postgres unreachable even without the deny — the probe proves nothing"
# Control B: from the webdesk network itself, a peer on its own bridge (the proxy :80) answers — the deny
# is specific to the host, not a dead probe network. (Not host nginx: the default-deny blocks the host.)
PROXY_IP="$(docker inspect "${PROJECT}-proxy-1" --format "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" 2>/dev/null)"
echo "$PROXY_IP 80" | tcp_probe "$NET" > "$TMP/p3-ctlb.txt"
grep -q ' open$' "$TMP/p3-ctlb.txt" && ok "control B: from $NET the webdesk proxy :80 answers (networking works)" \
  || bad "control B: nothing answers from $NET — the probe proves nothing"
# Persistence: the deny must be re-applied at boot and must follow the network's real subnet.
if systemctl is-enabled webdesk-host-deny.service >/dev/null 2>&1; then
  sudo -n iptables -S INPUT | grep -q -- "-s $WD_SUBNET " \
    && ok "deny unit enabled at boot; the live INPUT rules name the live subnet $WD_SUBNET" \
    || bad "the live INPUT rules do not name the live subnet $WD_SUBNET (a recreated network escapes them)"
else bad "no boot-time unit re-applies the deny (iptables rules vanish on reboot)"; fi
fi

# ---------------------------------------------------------------------------------------------------
if want 4; then
hdr "4 · CPU, memory and pids limits on every service (AC 8)"
for c in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  read -r name cpu mem pids < <(docker inspect "$c" --format '{{.Name}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}')
  if [ "${cpu:-0}" -gt 0 ] && [ "${mem:-0}" -gt 0 ] && [ "${pids:-0}" -gt 0 ] 2>/dev/null; then
    ok "$name cpus=$(awk "BEGIN{print $cpu/1e9}") mem=$((mem / 1048576))MiB pids=$pids"
  else bad "$name cpus=$cpu mem=$mem pids=$pids"; fi
done
MISSING="$(jq -r '.services | to_entries[] | select((.value.cpus // 0) == 0 or (.value.mem_limit // 0) == 0 or (.value.pids_limit // 0) == 0) | .key' "$TMP/resolved.json" 2>/dev/null)"
[ -z "$MISSING" ] && ok "resolved config: every service declares cpus, mem_limit, pids_limit" || bad "resolved config lacks limits on: $MISSING"
# Control: the same check on a container started with no limits must fail.
docker run -d --name "${RUN}-nolimit" "$PROBE_IMG" sleep 30 >/dev/null
read -r cpu mem pids < <(docker inspect "${RUN}-nolimit" --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}}')
{ [ "${cpu:-0}" -gt 0 ] && [ "${mem:-0}" -gt 0 ] && [ "${pids:-0}" -gt 0 ]; } 2>/dev/null \
  && bad "control: an unlimited container passed the check" || ok "control: an unlimited container fails the check (cpus=$cpu mem=$mem pids=${pids:-unset})"
docker rm -f "${RUN}-nolimit" >/dev/null
fi

# ---------------------------------------------------------------------------------------------------
if want 5; then
hdr "5 · \`--remove-orphans\` on the ERP project cannot reach webdesk (AC 1)"
LBL="$(docker ps -a --filter "name=^webdesk-" --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2 != "webdesk"')"
[ -z "$LBL" ] && ok "every webdesk-* container carries project label 'webdesk'" || bad "webdesk containers outside the project: $LBL"
CROSS="$(docker ps -a --filter "label=com.docker.compose.project=$ERP_PROJECT" --format '{{.Names}}' | grep -c '^webdesk' || true)"
[ "$CROSS" = 0 ] && ok "no container in project '$ERP_PROJECT' is a webdesk container" || bad "$CROSS webdesk container(s) in project '$ERP_PROJECT'"
# Mechanism, with throwaway projects shaped like the real pair: two projects, one runs
# `up -d --remove-orphans` after dropping a service. Its own orphan must go (control); the other project's
# container must survive.
mkdir -p "$TMP/orph"
cat > "$TMP/orph/two.yml" <<YML
services:
  keep:  { image: $PROBE_IMG, command: ["sleep", "300"], mem_limit: 32m }
  drop:  { image: $PROBE_IMG, command: ["sleep", "300"], mem_limit: 32m }
YML
cat > "$TMP/orph/one.yml" <<YML
services:
  keep:  { image: $PROBE_IMG, command: ["sleep", "300"], mem_limit: 32m }
YML
cat > "$TMP/orph/wd.yml" <<YML
services:
  api:   { image: $PROBE_IMG, command: ["sleep", "300"], mem_limit: 32m }
YML
docker compose -p "${RUN}-wd" -f "$TMP/orph/wd.yml" up -d --quiet-pull >/dev/null 2>&1
docker compose -p "${RUN}-erp" -f "$TMP/orph/two.yml" up -d --quiet-pull >/dev/null 2>&1
docker compose -p "${RUN}-erp" -f "$TMP/orph/one.yml" up -d --remove-orphans >/dev/null 2>&1
n_drop="$(docker ps -aq --filter "label=com.docker.compose.project=${RUN}-erp" --filter "label=com.docker.compose.service=drop" | wc -l)"
n_wd="$(docker ps -q --filter "label=com.docker.compose.project=${RUN}-wd" | wc -l)"
[ "$n_drop" = 0 ] && ok "control: --remove-orphans removed the ERP-side orphan" || bad "control: the orphan survived — the mechanism was not exercised"
[ "$n_wd" = 1 ] && ok "the other project's container survived --remove-orphans" || bad "the other project's container was removed"
fi

# ---------------------------------------------------------------------------------------------------
if want 6; then
hdr "6 · Egress sweep: no ERP credential in the surface, no route to an ERP service"
# 6a. Credentials. ERP secret-like values (>= 12 chars) from the ERP env; looked for in every webdesk
# container's environment, the project tree, /etc/webdesk, and every file mounted into a container.
sudo -n cat "$ERP_ENV" | grep -E '^[A-Z0-9_]+=' | grep -E '^[A-Z0-9_]*(SECRET|PASSWORD|PASS|TOKEN|KEY|PEPPER|CREDENTIAL|DATABASE_URL|_DSN)[A-Z0-9_]*=' \
  | sed -E 's/^([A-Z0-9_]+)=["'"'"']?([^"'"'"']*)["'"'"']?$/\1\t\2/' > "$TMP/erp-secrets.tsv"
# A connection URL's credential is its password, not the whole URL.
awk -F'\t' '{ v = $2; if (v ~ /:\/\/[^:\/]+:[^@]+@/) { sub(/^[a-z+]+:\/\/[^:\/]+:/, "", v); sub(/@.*/, "", v) } if (length(v) >= 12) print $1 "\t" v }' \
  "$TMP/erp-secrets.tsv" > "$TMP/erp-needles.tsv"
NNEEDLE="$(wc -l < "$TMP/erp-needles.tsv")"
for c in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  docker inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}'
done > "$TMP/wd-env.txt"
SCAN_DIRS="$WD /etc/webdesk"
for c in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  docker inspect "$c" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{println .Source}}{{end}}{{end}}'
done | sort -u > "$TMP/wd-mounts.txt"
HITS=""
# Designed shared values, each authorising nothing beyond WebDesk itself:
#   WEBDESK_EVENT_SECRET    — the B->A event HMAC (design §03 channel 1; a forged fact is noise, not authority)
#   WEBDESK_CONTROL_WS4_KEY — the WS4 v1 approval HMAC: the ERP signs, WebDesk verifies (= its
#                             WEBDESK_APPROVAL_ASSERTION_KEY); it is accepted only by WebDesk's own control plane.
#                             M4 F1 replaces it with an Ed25519 key WebDesk holds only the public half of;
#                             after phase 3 (WS4_HMAC_RETIRED=1) it is no longer shared, and finding its value
#                             in the surface is a FAIL like any other ERP secret.
SHARED_BY_DESIGN="WEBDESK_EVENT_SECRET WEBDESK_CONTROL_WS4_KEY"
if [ "$WS4_HMAC_RETIRED" = 1 ]; then
  SHARED_BY_DESIGN="WEBDESK_EVENT_SECRET"
  echo "    WS4_HMAC_RETIRED=1: WEBDESK_CONTROL_WS4_KEY is NOT shared by design (M4 F1 phase 3)"
fi
while IFS=$'\t' read -r k v; do
  case " $SHARED_BY_DESIGN " in *" $k "*) echo "    shared by design: $k"; continue;; esac
  if grep -qF -- "$v" "$TMP/wd-env.txt" \
     || sudo -n grep -rqsF -- "$v" $SCAN_DIRS $(cat "$TMP/wd-mounts.txt") 2>/dev/null; then HITS="$HITS $k"; fi
done < "$TMP/erp-needles.tsv"
NCTR="$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l)"
[ "$NNEEDLE" -ge 5 ] || bad "only $NNEEDLE ERP secret values found to look for — the sweep would prove nothing"
[ -z "$HITS" ] && ok "0 of $NNEEDLE ERP secret values found in $NCTR containers' env, $SCAN_DIRS, $(wc -l < "$TMP/wd-mounts.txt") bind mounts" \
  || bad "ERP secret values present in the surface:$HITS"
# Control: plant one ERP value in a throwaway file under the scan path's twin; the same grep must find it.
CTL="$(head -1 "$TMP/erp-needles.tsv" | cut -f2)"; printf 'X=%s\n' "$CTL" > "$TMP/planted"
grep -qF -- "$CTL" "$TMP/planted" && ok "control: a planted ERP value is found by the same match" || bad "control: planted value not found"
rm -f "$TMP/planted"

# 6b. Routes. From the webdesk network: every ERP container's exposed ports, every host listener on every
# host address, the wireguard peers, the cloud metadata service. Only host nginx :80/:443 may answer,
# plus ONE exception while the guard has it on: <docker0 address>:<WEBDESK_OTLP_PORT> (WSK-D63 (2)). That
# port on any other address, and every other port on docker0, is still a FAIL.
for c in $(docker ps -q --filter "label=com.docker.compose.project=$ERP_PROJECT"); do
  ips="$(docker inspect "$c" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}')"
  ports="$(docker inspect "$c" --format '{{range $p, $_ := .Config.ExposedPorts}}{{println $p}}{{end}}' | grep /tcp | cut -d/ -f1)"
  for ip in $ips; do for p in $ports; do echo "$ip $p"; done; done
done > "$TMP/t-erp.txt"
HOST_PORTS="$(sudo -n ss -ltnH | awk '{print $4}' | grep -v -E '^(127\.|\[::1\]|\[::ffff:127)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un)"
# The ONE allowed exception (WSK-D63 (2)): WebDesk's OTLP push to <docker0 address>:<WEBDESK_OTLP_PORT>,
# allowed ONLY while the guard has it on. "On" is read from the live FORWARD rule (its original-destination
# match), never from the variable alone; the variable, when set, is an expectation the live rule must meet.
OTLP_RULE="$(sudo -n iptables -S WEBDESK-EGRESS 2>/dev/null | grep -E -- '--ctorigdst [0-9.]+(/32)? --ctorigdstport [0-9]+ -j RETURN' | head -1)"
OTLP_ADDR=""; OTLP_LIVE_PORT=""
if [ -n "$OTLP_RULE" ]; then
  OTLP_ADDR="$(echo "$OTLP_RULE" | sed -E 's/.*--ctorigdst ([0-9.]+).*/\1/')"
  OTLP_LIVE_PORT="$(echo "$OTLP_RULE" | sed -E 's/.*--ctorigdstport ([0-9]+).*/\1/')"
fi
DOCKER0_ADDR="$(ip -4 -o addr show docker0 2>/dev/null | awk '{split($4, a, "/"); print a[1]}' | head -1)"
OTLP_ALLOWED=""
if [ -n "$OTLP_LIVE_PORT" ]; then
  if [ "$OTLP_ADDR" = "$DOCKER0_ADDR" ] && { [ -z "${WEBDESK_OTLP_PORT:-}" ] || [ "$WEBDESK_OTLP_PORT" = "$OTLP_LIVE_PORT" ]; }; then
    OTLP_ALLOWED="$OTLP_ADDR:$OTLP_LIVE_PORT"
    echo "    guard has the OTLP exception ON: $OTLP_ALLOWED (the only host port allowed besides nginx :80/:443)"
    HOST_PORTS="$(printf '%s\n%s\n' "$HOST_PORTS" "$OTLP_LIVE_PORT" | sort -un)"   # probe it on EVERY host address even with no listener in ss
  else
    bad "guard OTLP exception is not the docker0 address / expected port: rule=$OTLP_ADDR:$OTLP_LIVE_PORT docker0=$DOCKER0_ADDR expected-port=${WEBDESK_OTLP_PORT:-any}"
  fi
elif [ -n "${WEBDESK_OTLP_PORT:-}" ]; then
  bad "WEBDESK_OTLP_PORT=$WEBDESK_OTLP_PORT is expected but the guard has no OTLP exception ON"
fi
for a in $HOST_ADDRS; do for p in $HOST_PORTS; do echo "$a $p"; done; done > "$TMP/t-host.txt"
for a in $WG_PEERS; do for p in 22 80 443 3000 3100 4317 4318 5432 5433 6379 8080 9090 9093; do echo "$a $p"; done; done > "$TMP/t-wg.txt"
echo "169.254.169.254 80" > "$TMP/t-meta.txt"
cat "$TMP"/t-*.txt | sort -u | tcp_probe "$NET" > "$TMP/p6.txt"
echo "    probed $(wc -l < "$TMP/p6.txt") targets: $(wc -l < "$TMP/t-erp.txt") ERP container ports, $(wc -l < "$TMP/t-host.txt") host address:port, $(wc -l < "$TMP/t-wg.txt") wireguard, 1 metadata"
OPEN="$(grep ' open$' "$TMP/p6.txt" | awk '{print $1}' | grep -v -E ':(80|443)$' || true)"
if [ -n "$OTLP_ALLOWED" ]; then
  # Positive: the exception does what it is for. A rule with no listener behind it means no telemetry is flowing.
  if echo "$OPEN" | grep -q -x -F "$OTLP_ALLOWED"; then ok "OTLP exception: $OTLP_ALLOWED answers from $NET"; else bad "OTLP exception is ON but $OTLP_ALLOWED does not answer from $NET (collector down, or the rule is wrong)"; fi
  # Negative: that port on any OTHER host address stays in OPEN, so the host-listener check below fails it.
  OPEN="$(echo "$OPEN" | grep -v -x -F "$OTLP_ALLOWED" || true)"
fi
OPEN_NGX="$(grep ' open$' "$TMP/p6.txt" | awk '{print $1}' | grep -E ':(80|443)$' | grep -F -f <(echo "$HOST_ADDRS" | sed 's/$/:/') || true)"
[ -n "$OPEN_NGX" ] && echo "    allowed (host nginx): $(echo $OPEN_NGX)"
for t in $(grep -F -f <(awk '{print $1":"$2}' "$TMP/t-erp.txt") "$TMP/p6.txt" | grep ' open$' | awk '{print $1}'); do bad "ERP container reachable: $t"; done
grep -F -f <(awk '{print $1":"$2}' "$TMP/t-erp.txt") "$TMP/p6.txt" | grep -q ' open$' || ok "no ERP container port answers ($(wc -l < "$TMP/t-erp.txt") probed)"
for t in $(echo "$OPEN" | grep -F -f <(awk '{print $1":"$2}' "$TMP/t-host.txt") || true); do bad "host listener reachable: $t ($(sudo -n ss -ltnpH "sport = :${t##*:}" | sed -E 's/.*users:\(\("([^"]+)".*/\1/' | sort -u | tr '\n' ' '))"; done
echo "$OPEN" | grep -q -F -f <(awk '{print $1":"$2}' "$TMP/t-host.txt") || ok "no host listener other than nginx :80/:443 answers"
for t in $(echo "$OPEN" | grep -F -f <(awk '{print $1":"$2}' "$TMP/t-wg.txt") || true); do bad "wireguard peer reachable: $t"; done
[ -n "$WG_PEERS" ] && { echo "$OPEN" | grep -q -F -f <(awk '{print $1":"$2}' "$TMP/t-wg.txt") || ok "no wireguard peer port answers"; }
grep -q '^169.254.169.254:80 open$' "$TMP/p6.txt" && bad "cloud metadata service reachable (169.254.169.254:80)" || ok "cloud metadata service unreachable"
# Control: the same probe container reaches the internet (WebDesk needs it: tenant webhooks, mail).
echo "1.1.1.1 443" | tcp_probe "$NET" | grep -q ' open$' && ok "control: the same probe reaches the internet (1.1.1.1:443)" \
  || bad "control: no internet from $NET — the route sweep proves nothing"
[ "$WD_IPV6" = false ] && ok "IPv6 disabled on $NET (no v6 path around the v4 rules)" || bad "IPv6 enabled on $NET — the v4 deny does not cover it"
fi

echo
echo "== $PASS passed, $FAIL failed  (run $RUN, $(date -u +%Y-%m-%dT%H:%M:%SZ), $(hostname))"
[ "$FAIL" = 0 ]
