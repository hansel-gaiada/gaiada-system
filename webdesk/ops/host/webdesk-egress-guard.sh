#!/bin/sh
# webdesk-egress-guard.sh — default-deny for the public delivery surface's containers (design v2.3 §03,
# AC 6; M4 containment probe 6). Replaces the 2026-09-04 port deny-list (5432, 6379, 11434, 4310), which
# the M4 probe found leaves every other host listener, the WireGuard peer and the cloud metadata service
# reachable from the webdesk network.
#
#   webdesk-egress-guard.sh apply [--otlp] | remove | status
#
# Installed on gda-aicenter as /usr/local/sbin/webdesk-egress-guard.sh, run at boot by
# webdesk-host-deny.service (ops/host/webdesk-host-deny.service). Root only.
#
# Every rule matches the webdesk network's SOURCE subnet, read from Docker at run time, so no ERP or
# neighbour traffic is ever matched. What stays open for webdesk containers:
#   * their own bridge (api -> postgres/redis/rustfs; with br_netfilter that traffic crosses FORWARD);
#   * DNS to the cloud resolver (Docker's embedded resolver forwards from the container's namespace);
#   * the public internet (tenant webhooks, mail, Turnstile, and the ERP by its PUBLIC hostname: the
#     OIDC issuer and the n8n bridge are https://erp.gaiada.online, which hairpins through the public IP);
#   * replies on connections the host opened (nginx -> 127.0.0.1:8380 -> Caddy).
# Everything else is dropped: every host listener on every host address, the WireGuard mesh, the cloud
# VPC, other docker bridges, link-local (the metadata service), CGNAT, loopback.
#
# THE ONE EXCEPTION (WSK-D63 (2), M4 T6a), OFF BY DEFAULT: WebDesk's OTLP push to the ERP collector's
# write-only receiver, published on the docker0 address. It is on only when WEBDESK_OTLP_PORT is set
# (or `apply --otlp` is passed, which means port 4319), and it opens exactly TCP <WEBDESK_OTLP_ADDR>:
# <port> (default address 172.17.0.1) and nothing else on that address or any other. A published port
# is reached by DNAT, so the packet crosses FORWARD (DOCKER-USER -> $CH_FWD) where the 172.16/12 drop
# would kill it; the FORWARD exception therefore matches the ORIGINAL destination (conntrack
# --ctorigdst/--ctorigdstport, which survives DNAT). Docker's userland proxy can answer instead, and
# that arrives in INPUT ($CH_IN), so that chain gets the matching rule. Both sit BEFORE the drops, and
# after a per-source packet-rate cap (hashlimit, WEBDESK_OTLP_PPS, default 300/s, burst 2x; 0 = no cap)
# that is the network-level half of the "rate-limited" requirement (the collector bounds spans/second).
# If the rate-limit module is missing the exception is NOT applied: the default stays default-deny.
set -eu

NET="${WEBDESK_NETWORK:-webdesk_default}"
CH_IN=WEBDESK-HOST-IN
CH_FWD=WEBDESK-EGRESS
IPT="${WEBDESK_IPTABLES:-/usr/sbin/iptables}"
RESOLVER="${WEBDESK_RESOLVER:-169.254.169.254}"
OLD_PORTS="5432 6379 11434 4310"
OTLP_ADDR="${WEBDESK_OTLP_ADDR:-172.17.0.1}"
OTLP_PORT="${WEBDESK_OTLP_PORT:-}"
OTLP_PPS="${WEBDESK_OTLP_PPS:-300}"
OTLP_DEFAULT_PORT=4319

subnet() {
  s="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET" 2>/dev/null || true)"
  case "$s" in */*) echo "$s" ;; *) echo "webdesk-egress-guard: network $NET has no IPv4 subnet" >&2; exit 1 ;; esac
}

unhook() {
  # Remove every jump to our chains, whatever subnet it named (a recreated network must not leave a
  # stale jump behind), then the chains themselves.
  for pair in "INPUT $CH_IN" "DOCKER-USER $CH_FWD"; do
    set -- $pair
    $IPT -S "$1" 2>/dev/null | grep -- "-j $2\$" | sed 's/^-A /-D /' | while read -r rule; do
      # shellcheck disable=SC2086
      $IPT $rule
    done
  done
  for ch in "$CH_IN" "$CH_FWD"; do
    $IPT -F "$ch" 2>/dev/null || true
    $IPT -X "$ch" 2>/dev/null || true
  done
}

# Decide whether the OTLP exception is on, and with what. Prints the port, or nothing when it is off.
# A malformed value never opens anything: it leaves the exception off and says so.
otlp_port() {
  p="$OTLP_PORT"
  if [ -z "$p" ] && [ "${1:-}" = "--otlp" ]; then p="$OTLP_DEFAULT_PORT"; fi
  if [ -z "$p" ]; then return 0; fi
  case "$p" in ''|*[!0-9]*) echo "webdesk-egress-guard: WARNING: WEBDESK_OTLP_PORT is not a number; OTLP exception OFF" >&2; return 0 ;; esac
  case "$OTLP_PPS" in ''|*[!0-9]*) echo "webdesk-egress-guard: WARNING: WEBDESK_OTLP_PPS is not a number; OTLP exception OFF" >&2; return 0 ;; esac
  case "$OTLP_ADDR" in ''|*[!0-9.]*) echo "webdesk-egress-guard: WARNING: WEBDESK_OTLP_ADDR is not an IPv4 address; OTLP exception OFF" >&2; return 0 ;; esac
  if [ "$p" -lt 1 ] || [ "$p" -gt 65535 ]; then echo "webdesk-egress-guard: WARNING: WEBDESK_OTLP_PORT out of range; OTLP exception OFF" >&2; return 0; fi
  echo "$p"
}

# Add the OTLP exception to one chain: the packet-rate cap first, then the RETURN. Returns non-zero (and
# adds NO RETURN) if the cap cannot be added, so a missing module can never leave an uncapped door.
#   otlp_rules <chain> <hashlimit-name-suffix> <iptables match args...>
otlp_rules() {
  chain="$1"; tag="$2"; shift 2
  if [ "$OTLP_PPS" -gt 0 ]; then
    burst=$((OTLP_PPS * 2))
    $IPT -A "$chain" "$@" -m hashlimit --hashlimit-name "wd-otlp-$tag" --hashlimit-mode srcip --hashlimit-above "$OTLP_PPS/second" --hashlimit-burst "$burst" -j DROP 2>/dev/null || return 1
  fi
  $IPT -A "$chain" "$@" -j RETURN
}

apply() {
  S="$(subnet)"
  PORT="$(otlp_port "${1:-}")"
  FAILED=0
  unhook
  # Container -> the host itself: nothing but replies (and, when on, the one OTLP port; userland-proxy path).
  $IPT -N "$CH_IN"
  if [ -n "$PORT" ]; then
    otlp_rules "$CH_IN" in -d "$OTLP_ADDR" -p tcp --dport "$PORT" || { FAILED=1; echo "webdesk-egress-guard: WARNING: rate-limit module unavailable; OTLP INPUT exception NOT applied" >&2; }
  fi
  $IPT -A "$CH_IN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A "$CH_IN" -j DROP
  $IPT -I INPUT 1 -s "$S" -j "$CH_IN"
  # Container -> anywhere else: own bridge, DNS, the public internet.
  $IPT -N "$CH_FWD"
  # The OTLP exception comes first so its rate cap sees every packet of the flow, established or not.
  if [ -n "$PORT" ]; then
    otlp_rules "$CH_FWD" fwd -p tcp -m conntrack --ctorigdst "$OTLP_ADDR" --ctorigdstport "$PORT" || { FAILED=1; echo "webdesk-egress-guard: WARNING: rate-limit module unavailable; OTLP FORWARD exception NOT applied" >&2; }
  fi
  $IPT -A "$CH_FWD" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A "$CH_FWD" -d "$S" -j RETURN
  $IPT -A "$CH_FWD" -d "$RESOLVER" -p udp --dport 53 -j RETURN
  $IPT -A "$CH_FWD" -d "$RESOLVER" -p tcp --dport 53 -j RETURN
  for d in 169.254.0.0/16 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4; do
    $IPT -A "$CH_FWD" -d "$d" -j DROP
  done
  $IPT -I DOCKER-USER 1 -s "$S" -j "$CH_FWD"
  # The superseded port deny-list is now a subset of $CH_IN; remove it so one mechanism remains.
  for p in $OLD_PORTS; do $IPT -D INPUT -s "$S" -p tcp --dport "$p" -j DROP 2>/dev/null || true; done
  if [ -n "$PORT" ] && [ "$FAILED" = 0 ]; then echo "webdesk-egress-guard: applied for $NET ($S); OTLP exception ON: tcp $OTLP_ADDR:$PORT (cap ${OTLP_PPS}/s per source)"
  elif [ -n "$PORT" ]; then echo "webdesk-egress-guard: applied for $NET ($S); OTLP exception requested but NOT fully applied (see warnings): default-deny holds"
  else echo "webdesk-egress-guard: applied for $NET ($S); OTLP exception OFF"; fi
}

case "${1:-}" in
  apply) apply "${2:-}" ;;
  remove) unhook; echo "webdesk-egress-guard: removed" ;;
  status)
    echo "network $NET subnet $(subnet)"
    $IPT -S INPUT | grep -- "-j $CH_IN" || echo "no INPUT jump"
    $IPT -S DOCKER-USER | grep -- "-j $CH_FWD" || echo "no DOCKER-USER jump"
    $IPT -S "$CH_IN" 2>/dev/null || true
    $IPT -S "$CH_FWD" 2>/dev/null || true ;;
  *) echo "usage: $0 apply [--otlp]|remove|status" >&2; exit 2 ;;
esac
