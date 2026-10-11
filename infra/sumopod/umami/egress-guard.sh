#!/bin/sh
# DOCKER-USER rules for the Umami project. Run as root (umami-egress-guard.service does).
#   egress-guard.sh apply    idempotent: add the rules if missing
#   egress-guard.sh remove   delete them
#   egress-guard.sh status   print them
#
# Rule 1 (egress): the `edge` network is the only non-internal one (10.211.91.0/28, docker-compose.yml).
#   Nothing in it may OPEN a connection outward. Replies to published-port traffic are ESTABLISHED and pass;
#   the app and db are on an `internal: true` network and need no rule at all.
# Rule 2 (read-gate, only matters if the `erp-read` profile runs): published port 18743 on wg0 may be reached
#   from gda-aicenter (10.88.0.1) only. Docker DNAT runs before ufw, so ufw cannot do this; DOCKER-USER sees
#   the packet after DNAT, hence conntrack's ORIGINAL destination port.
set -eu
EDGE_SUBNET="${EDGE_SUBNET:-10.211.91.0/28}"
READ_PORT="${UMAMI_READ_PORT:-18743}"
ERP_PEER="${ERP_PEER:-10.88.0.1}"

R1="-s $EDGE_SUBNET -m conntrack --ctstate NEW -m comment --comment umami-edge-no-egress -j DROP"
R2="-i wg0 -p tcp -m conntrack --ctorigdstport $READ_PORT ! -s $ERP_PEER -m comment --comment umami-read-gate-peer-only -j DROP"

case "${1:-status}" in
  apply)
    # shellcheck disable=SC2086
    iptables -C DOCKER-USER $R1 2> /dev/null || iptables -I DOCKER-USER 1 $R1
    # shellcheck disable=SC2086
    iptables -C DOCKER-USER $R2 2> /dev/null || iptables -I DOCKER-USER 1 $R2
    ;;
  remove)
    # shellcheck disable=SC2086
    iptables -D DOCKER-USER $R1 2> /dev/null || true
    # shellcheck disable=SC2086
    iptables -D DOCKER-USER $R2 2> /dev/null || true
    ;;
  status)
    iptables -S DOCKER-USER | grep umami || echo "no umami rules present"
    ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 1 ;;
esac
