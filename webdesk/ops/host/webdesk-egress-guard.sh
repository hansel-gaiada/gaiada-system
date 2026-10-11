#!/bin/sh
# webdesk-egress-guard.sh — default-deny for the public delivery surface's containers (design v2.3 §03,
# AC 6; M4 containment probe 6). Replaces the 2026-09-04 port deny-list (5432, 6379, 11434, 4310), which
# the M4 probe found leaves every other host listener, the WireGuard peer and the cloud metadata service
# reachable from the webdesk network.
#
#   webdesk-egress-guard.sh apply | remove | status
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
set -eu

NET="${WEBDESK_NETWORK:-webdesk_default}"
CH_IN=WEBDESK-HOST-IN
CH_FWD=WEBDESK-EGRESS
IPT=/usr/sbin/iptables
RESOLVER="${WEBDESK_RESOLVER:-169.254.169.254}"
OLD_PORTS="5432 6379 11434 4310"

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

apply() {
  S="$(subnet)"
  unhook
  # Container -> the host itself: nothing but replies.
  $IPT -N "$CH_IN"
  $IPT -A "$CH_IN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  $IPT -A "$CH_IN" -j DROP
  $IPT -I INPUT 1 -s "$S" -j "$CH_IN"
  # Container -> anywhere else: own bridge, DNS, the public internet.
  $IPT -N "$CH_FWD"
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
  echo "webdesk-egress-guard: applied for $NET ($S)"
}

case "${1:-}" in
  apply) apply ;;
  remove) unhook; echo "webdesk-egress-guard: removed" ;;
  status)
    echo "network $NET subnet $(subnet)"
    $IPT -S INPUT | grep -- "-j $CH_IN" || echo "no INPUT jump"
    $IPT -S DOCKER-USER | grep -- "-j $CH_FWD" || echo "no DOCKER-USER jump"
    $IPT -S "$CH_IN" 2>/dev/null || true
    $IPT -S "$CH_FWD" 2>/dev/null || true ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
