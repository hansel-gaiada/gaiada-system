#!/usr/bin/env bash
# webdesk-rootless-guard.sh - the egress guard for a ROOTLESS WebDesk Docker daemon (M4 F6, WSK-D73;
# design v2.3 §03 AC 6 + AC 7). Design: docs/plans/2026-10-12-webdesk-rootless-plan.md §4.
#
# WHY A NEW GUARD. webdesk-egress-guard.sh (WSK-D63) matches the webdesk bridge's SOURCE SUBNET in INPUT and
# DOCKER-USER. A rootless daemon's bridges live inside RootlessKit's own network namespace, so no container
# packet ever crosses the host's INPUT or FORWARD chains. What reaches the host network namespace is
# slirp4netns (all container egress, re-originated from ordinary host sockets) and RootlessKit's builtin
# port driver (the published loopback port). Both are ordinary host processes running as the daemon user.
# This guard therefore matches the SOCKET OWNER in OUTPUT: the daemon user's uid AND its whole subordinate
# uid range (a process that leaves a container as a non-root container uid runs as one of those).
#
# What a socket owned by those uids may do, in rule order:
#   1. answer host nginx on the published loopback port(s), and nothing else: every other reply-direction
#      packet is dropped, so no listener of these uids (a rogue one, on any address) can serve the internet,
#      the VPC, the WireGuard mesh or the host;
#   2. DNS to the host's resolver(s), udp/tcp 53 only (slirp4netns forwards 10.0.2.3 there);
#   3. OPTIONAL, off by default: the T6a OTLP exception (WSK-D63 (2)), exactly tcp <addr>:<port> matched by
#      its ORIGINAL destination (the rootful daemon DNATs <docker0>:<port> to the collector in nat OUTPUT,
#      before filter OUTPUT sees the packet), behind a packet-rate cap;
#   4. never the host itself (every local address: loopback, docker0, wg0, the NIC), never a private, shared,
#      link-local, multicast or reserved range;
#   5. the public internet.
# IPv6: nothing at all. The host has no global IPv6, and dropping every v6 packet of these uids leaves no path
# around the v4 rules.
#
#   webdesk-rootless-guard.sh render <user>   print the v4 and v6 iptables-restore payloads; changes nothing
#   webdesk-rootless-guard.sh apply  <user>   load both atomically, hook OUTPUT, then write the marker
#   webdesk-rootless-guard.sh remove <user>   unhook and delete; REFUSES while any process of those uids runs
#   webdesk-rootless-guard.sh check  <user>   exit 0 only if the live rules are exactly what apply loaded from
#                                             the CURRENT config (drift and a stale config both fail)
#   webdesk-rootless-guard.sh status <user>
#
# FAIL CLOSED. apply writes $STATE_DIR/<user>.active only after both payloads loaded, and the daemon's user
# unit refuses to start without it (ExecStartPre). $STATE_DIR is on /run (tmpfs): after a reboot the daemon
# waits for this guard, which webdesk-rootless-guard@<user>.service runs before user@<uid>.service. A config
# that does not render changes nothing: the rules (and the marker) a previous apply loaded stay in place, and
# `check` fails until the config is fixed.
#
# Config (written by install-rootless.sh, parsed here, never sourced): $CONF_DIR/webdesk-rootless-<user>
#   RL_PUBLISHED_PORTS="8380"        loopback ports the daemon publishes (replies allowed on these only)
#   RL_RESOLVERS="169.254.169.254"   the host's resolvers, as slirp4netns reads them (udp/tcp 53 only)
#   RL_OTLP_ENV_FILE=/etc/webdesk/guard.env   optional; its WEBDESK_OTLP_PORT / _ADDR / _PPS keys are the
#                                    SAME switch the rootful guard reads (one switch for both guards)
#   RL_LOG=on                        rate-limited LOG of dropped packets (prefix WDRL<uid>-DENY, with uid)
# The uid comes from the passwd database and the range from /etc/subuid at every run, so the rules always
# follow the real account. Root only. Installed as /usr/local/sbin/webdesk-rootless-guard.sh.
set -euo pipefail

CONF_DIR="${WEBDESK_RL_CONF_DIR:-/etc/default}"
STATE_DIR="${WEBDESK_RL_STATE_DIR:-/run/webdesk-rootless-guard}"
SUBUID_FILE="${WEBDESK_RL_SUBUID_FILE:-/etc/subuid}"
IPT="${WEBDESK_IPTABLES:-/usr/sbin/iptables}"
IPT6="${WEBDESK_IP6TABLES:-/usr/sbin/ip6tables}"
IPT_RESTORE="${WEBDESK_IPTABLES_RESTORE:-/usr/sbin/iptables-restore}"
IPT6_RESTORE="${WEBDESK_IP6TABLES_RESTORE:-/usr/sbin/ip6tables-restore}"
# Everything that is not the public internet. 169.254.0.0/16 holds the metadata service; 10/8 holds the VPC
# and the WireGuard mesh; 172.16/12 holds docker0 and every rootful bridge; 127/8 is also covered by LOCAL.
DENY_V4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4"
OTLP_DEFAULT_ADDR=172.17.0.1
OTLP_DEFAULT_PPS=300

say() { printf '%s\n' "$*"; }
warn() { printf 'webdesk-rootless-guard: WARNING: %s\n' "$*" >&2; }
die() { printf 'webdesk-rootless-guard: %s\n' "$*" >&2; exit 1; }

# --- pure helpers (test-rootless.sh drives these; no root, no iptables) ---------------------------------------

is_uint() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac; [ "${#1}" -le 10 ]; }
is_port() { is_uint "${1:-}" && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
is_user() { [[ "${1:-}" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; }
is_ipv4() {
  local a b c d x
  [[ "${1:-}" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
  IFS=. read -r a b c d <<<"$1"
  for x in "$a" "$b" "$c" "$d"; do [ "$((10#$x))" -le 255 ] || return 1; done
}

# subid_range <subuid-file> <user> <uid> -> "start count". Exactly one entry, by name or by uid, or fail.
subid_range() {
  local f=$1 u=$2 id=$3 lines s c
  [ -r "$f" ] || return 1
  lines="$(awk -F: -v u="$u" -v id="$id" 'NF == 3 && ($1 == u || $1 == id) { print $2, $3 }' "$f")"
  [ -n "$lines" ] && [ "$(printf '%s\n' "$lines" | wc -l)" -eq 1 ] || return 1
  read -r s c <<<"$lines"
  is_uint "$s" && is_uint "$c" && [ "$c" -ge 1 ] && [ "$s" -ge 1 ] || return 1
  printf '%s %s\n' "$s" "$c"
}

# conf_get <file> <KEY>: the last KEY=value line, surrounding quotes stripped. The file is parsed, never run.
conf_get() {
  local v
  v="$(sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -n 1 || true)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

# render_v4 <tag> <uid> <sub-first> <sub-last> <ports> <resolvers> <otlp-addr> <otlp-port|''> <otlp-pps> <log on|off>
# Prints the filter-table payload for `iptables-restore --noflush`. Declaring a chain in the payload flushes it,
# so a reload replaces the three chains atomically and touches nothing else. Validates EVERY input first and
# prints nothing at all when one is wrong: a malformed value must never become a half-written rule set.
render_v4() {
  local tag=$1 uid=$2 s=$3 e=$4 ports=$5 resolvers=$6 oaddr=$7 oport=$8 opps=$9 log=${10}
  local p r d
  [[ "$tag" =~ ^WDRL[0-9]{1,10}$ ]] || return 1
  is_uint "$uid" && is_uint "$s" && is_uint "$e" && [ "$e" -ge "$s" ] || return 1
  [ "$uid" -lt "$s" ] || [ "$uid" -gt "$e" ] || return 1 # the daemon uid is never inside its own range
  [ -n "$ports" ] || return 1
  for p in $ports; do is_port "$p" || return 1; done
  [ -n "$resolvers" ] || return 1
  for r in $resolvers; do is_ipv4 "$r" || return 1; done
  if [ -n "$oport" ]; then is_port "$oport" && is_ipv4 "$oaddr" && is_uint "$opps" || return 1; fi
  case "$log" in on | off) ;; *) return 1 ;; esac
  local SEL="$tag-SEL" OUT="$tag-OUT" DENY="$tag-DENY"
  printf '*filter\n:%s - [0:0]\n:%s - [0:0]\n:%s - [0:0]\n' "$SEL" "$OUT" "$DENY"
  printf -- '-A %s -m owner --uid-owner %s -j %s\n' "$SEL" "$uid" "$OUT"
  printf -- '-A %s -m owner --uid-owner %s-%s -j %s\n' "$SEL" "$s" "$e" "$OUT"
  # 1. Replies to host nginx on the published loopback port(s); then NO other reply of any kind.
  for p in $ports; do
    printf -- '-A %s -s 127.0.0.1/32 -d 127.0.0.1/32 -o lo -p tcp -m tcp --sport %s -m conntrack --ctdir REPLY -j RETURN\n' "$OUT" "$p"
  done
  printf -- '-A %s -m conntrack --ctdir REPLY -j %s\n' "$OUT" "$DENY"
  # 2. DNS to the resolver(s) only.
  for r in $resolvers; do
    printf -- '-A %s -d %s/32 -p udp -m udp --dport 53 -j RETURN\n' "$OUT" "$r"
    printf -- '-A %s -d %s/32 -p tcp -m tcp --dport 53 -j RETURN\n' "$OUT" "$r"
  done
  # 3. The optional OTLP exception, by ORIGINAL destination, behind its packet-rate cap (0 = no cap).
  if [ -n "$oport" ]; then
    if [ "$opps" -gt 0 ]; then
      printf -- '-A %s -p tcp -m conntrack --ctorigdst %s/32 --ctorigdstport %s -m hashlimit --hashlimit-above %s/sec --hashlimit-burst %s --hashlimit-mode srcip --hashlimit-name %s -j DROP\n' \
        "$OUT" "$oaddr" "$oport" "$opps" "$((opps * 2))" "otlp${tag#WDRL}"
    fi
    printf -- '-A %s -p tcp -m conntrack --ctorigdst %s/32 --ctorigdstport %s -j RETURN\n' "$OUT" "$oaddr" "$oport"
  fi
  # 4. The host itself, then every non-public range.
  printf -- '-A %s -m addrtype --dst-type LOCAL -j %s\n' "$OUT" "$DENY"
  for d in $DENY_V4; do printf -- '-A %s -d %s -j %s\n' "$OUT" "$d" "$DENY"; done
  # 5. The public internet.
  printf -- '-A %s -j RETURN\n' "$OUT"
  if [ "$log" = on ]; then
    printf -- '-A %s -m limit --limit 6/min --limit-burst 12 -j LOG --log-prefix "%s " --log-uid\n' "$DENY" "$DENY"
  fi
  printf -- '-A %s -j DROP\n' "$DENY"
  printf 'COMMIT\n'
}

# render_v6 <tag> <uid> <sub-first> <sub-last> <log on|off>: every IPv6 packet of these uids is dropped.
render_v6() {
  local tag=$1 uid=$2 s=$3 e=$4 log=$5
  [[ "$tag" =~ ^WDRL[0-9]{1,10}$ ]] || return 1
  is_uint "$uid" && is_uint "$s" && is_uint "$e" && [ "$e" -ge "$s" ] || return 1
  [ "$uid" -lt "$s" ] || [ "$uid" -gt "$e" ] || return 1
  case "$log" in on | off) ;; *) return 1 ;; esac
  local SEL="$tag-SEL" DENY="$tag-DENY"
  printf '*filter\n:%s - [0:0]\n:%s - [0:0]\n' "$SEL" "$DENY"
  printf -- '-A %s -m owner --uid-owner %s -j %s\n' "$SEL" "$uid" "$DENY"
  printf -- '-A %s -m owner --uid-owner %s-%s -j %s\n' "$SEL" "$s" "$e" "$DENY"
  if [ "$log" = on ]; then
    printf -- '-A %s -m limit --limit 6/min --limit-burst 12 -j LOG --log-prefix "%s6 " --log-uid\n' "$DENY" "$DENY"
  fi
  printf -- '-A %s -j DROP\n' "$DENY"
  printf 'COMMIT\n'
}

# in_uid_set <uid> <daemon-uid> <first> <last>: is this process uid the daemon's or one of its range?
in_uid_set() { [ "$1" = "$2" ] || { [ "$1" -ge "$3" ] && [ "$1" -le "$4" ]; }; }

# --- config ---------------------------------------------------------------------------------------------------

# load_cfg <user>: sets RL_USER RL_UID SUB_FIRST SUB_LAST TAG PORTS RESOLVERS LOG OTLP_ADDR OTLP_PORT OTLP_PPS CONF
load_cfg() {
  RL_USER="${1:-}"
  is_user "$RL_USER" || die "usage: $0 render|apply|remove|check|status <user>"
  CONF="$CONF_DIR/webdesk-rootless-$RL_USER"
  [ -r "$CONF" ] || die "no config $CONF (install-rootless.sh writes it)"
  RL_UID="$(getent passwd "$RL_USER" | cut -d: -f3 || true)"
  is_uint "$RL_UID" || die "user $RL_USER does not exist"
  local r
  r="$(subid_range "$SUBUID_FILE" "$RL_USER" "$RL_UID")" || die "$RL_USER needs exactly one entry in $SUBUID_FILE"
  read -r SUB_FIRST r <<<"$r"
  SUB_LAST=$((SUB_FIRST + r - 1))
  TAG="WDRL$RL_UID"
  PORTS="$(conf_get "$CONF" RL_PUBLISHED_PORTS)"
  RESOLVERS="$(conf_get "$CONF" RL_RESOLVERS)"
  LOG="$(conf_get "$CONF" RL_LOG)"
  LOG="${LOG:-on}"
  OTLP_ADDR="" OTLP_PORT="" OTLP_PPS=""
  local of
  of="$(conf_get "$CONF" RL_OTLP_ENV_FILE)"
  if [ -n "$of" ] && [ -r "$of" ]; then
    OTLP_PORT="$(conf_get "$of" WEBDESK_OTLP_PORT)"
    OTLP_ADDR="$(conf_get "$of" WEBDESK_OTLP_ADDR)"
    OTLP_PPS="$(conf_get "$of" WEBDESK_OTLP_PPS)"
  fi
  OTLP_ADDR="${OTLP_ADDR:-$OTLP_DEFAULT_ADDR}"
  OTLP_PPS="${OTLP_PPS:-$OTLP_DEFAULT_PPS}"
  if [ -n "$OTLP_PORT" ] && ! { is_port "$OTLP_PORT" && is_ipv4 "$OTLP_ADDR" && is_uint "$OTLP_PPS"; }; then
    warn "malformed OTLP settings in $of: the OTLP exception stays OFF (default-deny holds)"
    OTLP_PORT=""
  fi
}

payload_v4() { render_v4 "$TAG" "$RL_UID" "$SUB_FIRST" "$SUB_LAST" "$PORTS" "$RESOLVERS" "$OTLP_ADDR" "$1" "$OTLP_PPS" "$LOG"; }
payload_v6() { render_v6 "$TAG" "$RL_UID" "$SUB_FIRST" "$SUB_LAST" "$LOG"; }

# --- root-only actions ----------------------------------------------------------------------------------------

need_root() { [ "$(id -u)" = 0 ] || die "root only"; }

# ensure_jump <iptables> <chain>: exactly one `-j <chain>` in OUTPUT, inserted at the top if missing.
ensure_jump() {
  local ipt=$1 ch=$2 n
  "$ipt" -w -C OUTPUT -j "$ch" 2>/dev/null || "$ipt" -w -I OUTPUT 1 -j "$ch"
  n="$("$ipt" -w -S OUTPUT | grep -c -- "^-A OUTPUT -j $ch\$" || true)"
  while [ "$n" -gt 1 ]; do "$ipt" -w -D OUTPUT -j "$ch"; n=$((n - 1)); done
}

snapshot() { # live canonical rules of our chains, v4 then v6
  { "$IPT" -w -S "$TAG-SEL"; "$IPT" -w -S "$TAG-OUT"; "$IPT" -w -S "$TAG-DENY"; } 2>/dev/null
  echo "--- v6"
  { "$IPT6" -w -S "$TAG-SEL"; "$IPT6" -w -S "$TAG-DENY"; } 2>/dev/null
}

# A render failure hashes as an empty payload, which never equals a hash apply stored: check then FAILs.
cfg_hash() { { payload_v4 "$OTLP_PORT" || true; payload_v6 || true; } | sha256sum | cut -d' ' -f1; }

one_line() { printf '%s' "$1" | tr '\n' ' '; }

cmd_apply() {
  need_root
  local v4 v6 applied_otlp="$OTLP_PORT" err
  v4="$(payload_v4 "$OTLP_PORT")" || die "refusing to render: invalid config in $CONF (the rules already loaded, if any, stay)"
  v6="$(payload_v6)" || die "refusing to render the v6 payload (the rules already loaded, if any, stay)"
  install -d -m 0755 "$STATE_DIR"
  if ! err="$(printf '%s\n' "$v4" | "$IPT_RESTORE" -w --noflush 2>&1)"; then
    if [ -n "$OTLP_PORT" ]; then
      warn "v4 payload with the OTLP exception failed ($(one_line "$err")); retrying WITHOUT it: default-deny holds"
      applied_otlp=""
      v4="$(payload_v4 "")"
      printf '%s\n' "$v4" | "$IPT_RESTORE" -w --noflush || { rm -f "$STATE_DIR/$RL_USER.active"; die "v4 payload failed: guard NOT active"; }
    else
      rm -f "$STATE_DIR/$RL_USER.active"
      die "v4 payload failed ($(one_line "$err")): guard NOT active"
    fi
  fi
  printf '%s\n' "$v6" | "$IPT6_RESTORE" -w --noflush || { rm -f "$STATE_DIR/$RL_USER.active"; die "v6 payload failed: guard NOT active"; }
  ensure_jump "$IPT" "$TAG-SEL"
  ensure_jump "$IPT6" "$TAG-SEL"
  snapshot >"$STATE_DIR/$RL_USER.rules"
  { payload_v4 "$applied_otlp"; payload_v6; } | sha256sum | cut -d' ' -f1 >"$STATE_DIR/$RL_USER.applied"
  printf 'uid=%s range=%s-%s ports=%s otlp=%s at=%s\n' "$RL_UID" "$SUB_FIRST" "$SUB_LAST" "$PORTS" \
    "${applied_otlp:+$OTLP_ADDR:$applied_otlp}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATE_DIR/$RL_USER.active"
  chmod 0644 "$STATE_DIR/$RL_USER.active" "$STATE_DIR/$RL_USER.rules" "$STATE_DIR/$RL_USER.applied"
  local otlp_msg=OFF
  [ -z "$applied_otlp" ] || otlp_msg="ON $OTLP_ADDR:$applied_otlp (cap ${OTLP_PPS}/s)"
  say "webdesk-rootless-guard: ACTIVE for $RL_USER (uid $RL_UID + $SUB_FIRST-$SUB_LAST): replies only on 127.0.0.1:{$PORTS}, DNS to {$RESOLVERS}, OTLP $otlp_msg, no host/private/link-local, no IPv6"
}

processes_in_set() { # prints the first pid whose uid is the daemon's or in its range
  ps -e -o pid= -o uid= | awk -v u="$RL_UID" -v s="$SUB_FIRST" -v e="$SUB_LAST" '$2 == u || ($2 >= s && $2 <= e) { print $1; exit }'
}

cmd_remove() {
  need_root
  local pid
  pid="$(processes_in_set)"
  [ -z "$pid" ] || die "REFUSED: pid $pid runs as $RL_USER's uid range; stop user@$RL_UID.service first (the guard stays ACTIVE)"
  rm -f "$STATE_DIR/$RL_USER.active"
  local ipt ch
  for ipt in "$IPT" "$IPT6"; do
    while "$ipt" -w -C OUTPUT -j "$TAG-SEL" 2>/dev/null; do "$ipt" -w -D OUTPUT -j "$TAG-SEL"; done
    for ch in "$TAG-SEL" "$TAG-OUT" "$TAG-DENY"; do "$ipt" -w -F "$ch" 2>/dev/null || true; done
    for ch in "$TAG-SEL" "$TAG-OUT" "$TAG-DENY"; do "$ipt" -w -X "$ch" 2>/dev/null || true; done
  done
  rm -f "$STATE_DIR/$RL_USER.rules" "$STATE_DIR/$RL_USER.applied"
  say "webdesk-rootless-guard: removed for $RL_USER (no process of its uid range was running)"
}

cmd_check() {
  need_root
  local fails=0 want live ipt first n ns
  ok() { say "  PASS  $*"; }
  bad() { say "  FAIL  $*"; fails=$((fails + 1)); }
  if [ -e "$STATE_DIR/$RL_USER.active" ]; then ok "marker $STATE_DIR/$RL_USER.active present"; else bad "no marker: the daemon cannot (re)start"; fi
  want="$(cfg_hash)"
  if [ "$want" = "$(cat "$STATE_DIR/$RL_USER.applied" 2>/dev/null)" ]; then ok "live rule set was rendered from the CURRENT config"
  else bad "config differs from what was applied (stale guard, or the OTLP exception failed to load): run apply"; fi
  live="$(snapshot)"
  if [ -s "$STATE_DIR/$RL_USER.rules" ] && [ "$live" = "$(cat "$STATE_DIR/$RL_USER.rules")" ]; then ok "live chains $TAG-* are exactly what apply loaded"
  else bad "live chains $TAG-* drifted from what apply loaded"; fi
  for ipt in "$IPT" "$IPT6"; do
    if [ "$("$ipt" -w -S OUTPUT | grep -c -- "^-A OUTPUT -j $TAG-SEL\$" || true)" = 1 ]; then ok "$(basename "$ipt"): one OUTPUT jump to $TAG-SEL"
    else bad "$(basename "$ipt"): OUTPUT does not jump to $TAG-SEL exactly once"; fi
    # Nothing may run before our jump except other instances' selector jumps (none of them accepts anything).
    first="$("$ipt" -w -S OUTPUT | grep '^-A OUTPUT' | sed -n "1,/-j $TAG-SEL\$/p" | grep -v -E -- '-j WDRL[0-9]+-SEL$' || true)"
    if [ -z "$first" ]; then ok "$(basename "$ipt"): no rule precedes the guard in OUTPUT"; else bad "$(basename "$ipt"): rules precede the guard in OUTPUT: $(one_line "$first")"; fi
  done
  ns="$(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf 2>/dev/null | sort -u | tr '\n' ' ')"
  for n in $ns; do
    case " $RESOLVERS " in *" $n "*) ;; *) say "  WARN  host resolver $n is not in RL_RESOLVERS: container DNS will fail (a liveness problem, not a hole)" ;; esac
  done
  [ "$fails" = 0 ]
}

cmd_status() {
  say "user $RL_USER uid $RL_UID range $SUB_FIRST-$SUB_LAST chains $TAG-*"
  cat "$STATE_DIR/$RL_USER.active" 2>/dev/null || say "marker: ABSENT"
  "$IPT" -w -S OUTPUT 2>/dev/null | grep -- "-j $TAG-SEL" || say "no v4 OUTPUT jump"
  "$IPT6" -w -S OUTPUT 2>/dev/null | grep -- "-j $TAG-SEL" || say "no v6 OUTPUT jump"
  snapshot
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    render | apply | remove | check | status) load_cfg "${2:-}" ;;
    *) die "usage: $0 render|apply|remove|check|status <user>" ;;
  esac
  case "$cmd" in
    render)
      payload_v4 "$OTLP_PORT" || die "invalid config in $CONF"
      echo "# --- v6"
      payload_v6 || die "invalid config in $CONF"
      ;;
    apply) cmd_apply ;;
    remove) cmd_remove ;;
    check) cmd_check ;;
    status) cmd_status ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
