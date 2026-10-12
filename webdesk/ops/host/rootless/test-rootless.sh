#!/usr/bin/env bash
# test-rootless.sh - unit tests for the PURE parts of the rootless WebDesk scripts (M4 F6, WSK-D73).
# No root, no docker, no iptables, no network: plain bash >= 4.4, coreutils, awk, sed, grep, GNU find.
#
#   bash webdesk/ops/host/rootless/test-rootless.sh        exit 0 only if every check passes
#
# What it pins: the guard's exact rule text and order and every input it must refuse; config -> rules end to
# end; the subordinate-range arithmetic against the ranges measured on gda-aicenter; rendering of the real
# files/ templates; the installer's argument rules and cgroup checks; the volume copy's uid mapping, manifest
# and argument rules; and that every consumer script resolves WebDesk's daemon with the same POSIX function.
# Each section runs in its own subshell (the scripts share helper names) and must print its END line.
set -uo pipefail
# The guard and the volume copy refuse group-writable files and dirs. A caller with umask 002 (sumopod's ubuntu user)
# would make the fixtures group-writable and 6 checks fail for the wrong reason. Pin the umask root has on the box.
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WD_TREE="$(cd "$HERE/../../.." && pwd)" # the webdesk/ tree
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

t_ok() { echo "  PASS  $*"; }
t_bad() { echo "  FAIL  $*"; }
assert() { local d=$1; shift; if "$@"; then t_ok "$d"; else t_bad "$d"; fi; }
refute() { local d=$1; shift; if "$@"; then t_bad "$d"; else t_ok "$d"; fi; }
quiet() { "$@" >/dev/null 2>&1; }
same() { # same <description> <expected> <actual>: exact text equality, with a diff on failure
  if [ "$2" = "$3" ]; then t_ok "$1"; else
    t_bad "$1"
    diff <(printf '%s\n' "$2") <(printf '%s\n' "$3") | head -20 | sed 's/^/        /'
  fi
}
refused() { # refused <description> <command...>: the command fails AND prints nothing on stdout
  local d=$1 out rc
  shift
  out="$("$@" 2>/dev/null)"
  rc=$?
  if [ "$rc" != 0 ] && [ -z "$out" ]; then t_ok "$d"; else t_bad "$d (rc=$rc, printed ${#out} bytes)"; fi
}
dies() { local d=$1; shift; if ("$@") >/dev/null 2>&1; then t_bad "$d (accepted)"; else t_ok "$d"; fi; }

# The ranges /etc/subuid and /etc/subgid hold on gda-aicenter (measured 2026-10-12); account names replaced
# (the repo is public), ranges exact.
MEASURED_SUBIDS='acct1:100000:65536
Hansel:165536:65536
acct3:231072:65536
acct4:296608:65536
acct5:493216:65536'

# The designed v4 rule set for the LIVE install (uid 940, its range, 127.0.0.1:8380, the GCP resolver, OTLP on).
WANT_V4='*filter
:WDRL940-SEL - [0:0]
:WDRL940-OUT - [0:0]
:WDRL940-DENY - [0:0]
-A WDRL940-SEL -m owner --uid-owner 940 -j WDRL940-OUT
-A WDRL940-SEL -m owner --uid-owner 700000000-700065535 -j WDRL940-OUT
-A WDRL940-OUT -s 127.0.0.1/32 -d 127.0.0.1/32 -o lo -p tcp -m tcp --sport 8380 -m conntrack --ctdir REPLY -j RETURN
-A WDRL940-OUT -m conntrack --ctdir REPLY -j WDRL940-DENY
-A WDRL940-OUT -d 169.254.169.254/32 -p udp -m udp --dport 53 -j RETURN
-A WDRL940-OUT -d 169.254.169.254/32 -p tcp -m tcp --dport 53 -j RETURN
-A WDRL940-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -m hashlimit --hashlimit-above 300/sec --hashlimit-burst 600 --hashlimit-mode srcip --hashlimit-name o940x060731 -j DROP
-A WDRL940-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -j RETURN
-A WDRL940-OUT -m addrtype --dst-type LOCAL -j WDRL940-DENY
-A WDRL940-OUT -d 0.0.0.0/8 -j WDRL940-DENY
-A WDRL940-OUT -d 10.0.0.0/8 -j WDRL940-DENY
-A WDRL940-OUT -d 100.64.0.0/10 -j WDRL940-DENY
-A WDRL940-OUT -d 127.0.0.0/8 -j WDRL940-DENY
-A WDRL940-OUT -d 169.254.0.0/16 -j WDRL940-DENY
-A WDRL940-OUT -d 172.16.0.0/12 -j WDRL940-DENY
-A WDRL940-OUT -d 192.0.0.0/24 -j WDRL940-DENY
-A WDRL940-OUT -d 192.168.0.0/16 -j WDRL940-DENY
-A WDRL940-OUT -d 198.18.0.0/15 -j WDRL940-DENY
-A WDRL940-OUT -d 224.0.0.0/4 -j WDRL940-DENY
-A WDRL940-OUT -d 240.0.0.0/4 -j WDRL940-DENY
-A WDRL940-OUT -j RETURN
-A WDRL940-DENY -m limit --limit 6/min --limit-burst 12 -j LOG --log-prefix "WDRL940-DENY " --log-uid
-A WDRL940-DENY -j DROP
COMMIT'

WANT_V6='*filter
:WDRL940-SEL - [0:0]
:WDRL940-DENY - [0:0]
-A WDRL940-SEL -m owner --uid-owner 940 -j WDRL940-DENY
-A WDRL940-SEL -m owner --uid-owner 700000000-700065535 -j WDRL940-DENY
-A WDRL940-DENY -m limit --limit 6/min --limit-burst 12 -j LOG --log-prefix "WDRL940-DENY6 " --log-uid
-A WDRL940-DENY -j DROP
COMMIT'

# ---------------------------------------------------------------------------------------------------------------
section_guard() {
  # shellcheck disable=SC1091
  . "$HERE/webdesk-rootless-guard.sh"
  set +e
  local got L A
  # No root here: the test's own uid plays root for the switch-file ownership check.
  TRUSTED_UID="$(stat -c %u "$T")"
  # live args: tag uid first last ports resolvers otlp-addr otlp-port pps log
  L=(WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1)

  echo "== guard: the exact v4 rule set"
  got="$(render_v4 "${L[@]}" 4319 300 on)"
  same "render_v4 (live, OTLP on, log on) = the designed rule set, line for line" "$WANT_V4" "$got"
  lineno() { printf '%s\n' "$got" | grep -n -F -- "$1" | head -1 | cut -d: -f1; }
  assert "replies on the published port are allowed before any reply is denied" \
    test "$(lineno '--sport 8380')" -lt "$(lineno '--ctdir REPLY -j WDRL940-DENY')"
  assert "DNS is allowed before the link-local range is denied" \
    test "$(lineno '--dport 53 -j RETURN')" -lt "$(lineno '-d 169.254.0.0/16')"
  assert "the OTLP rate cap precedes the OTLP RETURN" test "$(lineno 'hashlimit')" -lt "$(lineno '--ctorigdstport 4319 -j RETURN')"
  assert "the OTLP RETURN precedes the host (LOCAL) deny" test "$(lineno '--ctorigdstport 4319 -j RETURN')" -lt "$(lineno '--dst-type LOCAL')"
  assert "the host (LOCAL) deny precedes the private-range denies" test "$(lineno '--dst-type LOCAL')" -lt "$(lineno '-d 10.0.0.0/8')"
  assert "the last OUT rule is the bare RETURN (the public internet)" \
    test "$(printf '%s\n' "$got" | grep '^-A WDRL940-OUT' | tail -1)" = "-A WDRL940-OUT -j RETURN"
  refute "no ACCEPT anywhere: the guard only RETURNs, DROPs or LOGs" grep -q -- '-j ACCEPT' <<<"$got"
  local cidr missing=""
  for cidr in $DENY_V4; do grep -qx -- "-A WDRL940-OUT -d $cidr -j WDRL940-DENY" <<<"$got" || missing="$missing $cidr"; done
  assert "every non-public range is denied (10/8: VPC + WireGuard; 169.254/16: metadata; 172.16/12: docker0)" test -z "$missing"

  echo "== guard: variants"
  got="$(render_v4 "${L[@]}" '' 300 on)"
  same "OTLP off = the on-payload minus exactly its two OTLP lines" "$(grep -v ctorigdst <<<"$WANT_V4")" "$got"
  got="$(render_v4 "${L[@]}" 4319 0 on)"
  refute "OTLP cap 0: no hashlimit rule" grep -q hashlimit <<<"$got"
  assert "OTLP cap 0: the RETURN stays" grep -qx -- '-A WDRL940-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -j RETURN' <<<"$got"
  got="$(render_v4 "${L[@]}" 4319 300 off)"
  same "log off = the on-payload minus exactly its LOG line" "$(grep -v -- '-j LOG' <<<"$WANT_V4")" "$got"
  got="$(render_v4 WDRL941 941 700065536 700131071 "18380 18381" "169.254.169.254 10.0.0.2" 172.17.0.1 '' 300 off)"
  assert "two ports: one reply-allow line each" test "$(grep -c -- '--ctdir REPLY -j RETURN' <<<"$got")" = 2
  assert "two resolvers: udp + tcp 53 for each" test "$(grep -c -- '--dport 53 -j RETURN' <<<"$got")" = 4
  assert "the proof instance: its own tag and range" grep -qx -- '-A WDRL941-SEL -m owner --uid-owner 700065536-700131071 -j WDRL941-OUT' <<<"$got"

  echo "== guard: every malformed input renders NOTHING"
  refused "a tag that is not WDRL<n>" render_v4 XDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 '' 300 on
  refused "a uid that is not a number" render_v4 WDRL940 9x0 700000000 700065535 8380 169.254.169.254 172.17.0.1 '' 300 on
  refused "the daemon uid inside its own range" render_v4 WDRL940 700000005 700000000 700065535 8380 169.254.169.254 172.17.0.1 '' 300 on
  refused "a range that ends before it starts" render_v4 WDRL940 940 700065535 700000000 8380 169.254.169.254 172.17.0.1 '' 300 on
  refused "no published port" render_v4 WDRL940 940 700000000 700065535 '' 169.254.169.254 172.17.0.1 '' 300 on
  refused "port 0" render_v4 WDRL940 940 700000000 700065535 0 169.254.169.254 172.17.0.1 '' 300 on
  refused "port 65536" render_v4 WDRL940 940 700000000 700065535 65536 169.254.169.254 172.17.0.1 '' 300 on
  refused "a port with a letter" render_v4 WDRL940 940 700000000 700065535 80a 169.254.169.254 172.17.0.1 '' 300 on
  refused "no resolver" render_v4 WDRL940 940 700000000 700065535 8380 '' 172.17.0.1 '' 300 on
  refused "resolver 256.1.1.1" render_v4 WDRL940 940 700000000 700065535 8380 256.1.1.1 172.17.0.1 '' 300 on
  refused "resolver 1.2.3" render_v4 WDRL940 940 700000000 700065535 8380 1.2.3 172.17.0.1 '' 300 on
  refused "a resolver given as a CIDR" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254/32 172.17.0.1 '' 300 on
  refused "OTLP on with address 172.17.0.256" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.256 4319 300 on
  refused "OTLP on with port 70000" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 70000 300 on
  refused "OTLP on with a non-numeric cap" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 4319 fast on
  refused "log neither on nor off" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 '' 300 maybe

  echo "== guard: IPv6"
  same "render_v6 = drop every IPv6 packet of the uid set" "$WANT_V6" "$(render_v6 WDRL940 940 700000000 700065535 on)"
  refute "v6 log off: no LOG rule" grep -q -- '-j LOG' <<<"$(render_v6 WDRL940 940 700000000 700065535 off)"
  refused "v6: the uid inside its range" render_v6 WDRL940 700000001 700000000 700065535 on
  refused "v6: a bad tag" render_v6 WDRL 940 700000000 700065535 on

  echo "== guard: helpers"
  assert "is_ipv4 0.0.0.0" is_ipv4 0.0.0.0
  assert "is_ipv4 255.255.255.255" is_ipv4 255.255.255.255
  refute "is_ipv4 256.0.0.1" is_ipv4 256.0.0.1
  refute "is_ipv4 1.2.3" is_ipv4 1.2.3
  refute "is_ipv4 a.b.c.d" is_ipv4 a.b.c.d
  printf '%s\nwebdesk-rootless:700000000:65536\n' "$MEASURED_SUBIDS" >"$T/g.subuid"
  assert "subid_range by name" test "$(subid_range "$T/g.subuid" webdesk-rootless 940)" = "700000000 65536"
  printf '%s\n940:700000000:65536\n' "$MEASURED_SUBIDS" >"$T/g.subuid2"
  assert "subid_range by uid" test "$(subid_range "$T/g.subuid2" webdesk-rootless 940)" = "700000000 65536"
  printf 'webdesk-rootless:700000000:65536\nwebdesk-rootless:800000000:65536\n' >"$T/g.dup"
  refused "subid_range: two entries for the user" subid_range "$T/g.dup" webdesk-rootless 940
  refused "subid_range: no entry" subid_range "$T/g.subuid" nobody-here 12345
  printf 'webdesk-rootless:700000000:0\n' >"$T/g.zero"
  refused "subid_range: a zero-length range" subid_range "$T/g.zero" webdesk-rootless 940
  printf 'A="x y"\nB='"'"'q'"'"'\n  C=1\nC=2\n' >"$T/g.conf"
  assert "conf_get strips double quotes" test "$(conf_get "$T/g.conf" A)" = "x y"
  assert "conf_get strips single quotes" test "$(conf_get "$T/g.conf" B)" = "q"
  assert "conf_get: the last line wins" test "$(conf_get "$T/g.conf" C)" = "2"
  assert "conf_get: a missing key is empty" test -z "$(conf_get "$T/g.conf" D)"
  assert "in_uid_set: the daemon uid" in_uid_set 940 940 700000000 700065535
  assert "in_uid_set: the last subuid" in_uid_set 700065535 940 700000000 700065535
  refute "in_uid_set: one past the range" in_uid_set 700065536 940 700000000 700065535
  refute "in_uid_set: webdesk-svc (999)" in_uid_set 999 940 700000000 700065535

  echo "== guard: config file -> rules (load_cfg, with a stand-in passwd lookup)"
  getent() { [ "$1" = passwd ] && [ "$2" = webdesk-rootless ] && echo "webdesk-rootless:x:940:940::/var/lib/webdesk-rootless:/usr/sbin/nologin"; }
  CONF_DIR="$T/etc-default"
  SUBUID_FILE="$T/g.subuid"
  mkdir -p "$CONF_DIR"
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/guard.env"
  printf 'RL_ROLE=live\nRL_UID=940\nRL_PUBLISHED_PORTS="8380"\nRL_RESOLVERS="169.254.169.254"\nRL_OTLP_ENV_FILE=%s\nRL_OPERATOR=Hansel\nRL_LOG=on\n' \
    "$T/guard.env" >"$CONF_DIR/webdesk-rootless-webdesk-rootless"
  got="$( (load_cfg webdesk-rootless && payload_v4 "$OTLP_PORT") 2>&1)"
  same "the live config + guard.env (WEBDESK_OTLP_PORT=4319) render exactly the designed rule set" "$WANT_V4" "$got"
  local h_on h_off
  h_on="$( (load_cfg webdesk-rootless && cfg_hash) 2>/dev/null)"
  printf 'WEBDESK_OTLP_PORT=43x9\n' >"$T/guard.env"
  got="$( (load_cfg webdesk-rootless && payload_v4 "$OTLP_PORT") 2>"$T/warn")"
  refute "a malformed OTLP port leaves the exception OFF" grep -q ctorigdst <<<"$got"
  assert "  ... and says so" grep -q 'stays OFF' "$T/warn"
  rm -f "$T/guard.env"
  got="$( (load_cfg webdesk-rootless && payload_v4 "$OTLP_PORT") 2>/dev/null)"
  same "no OTLP switch file = the exception OFF" "$(grep -v ctorigdst <<<"$WANT_V4")" "$got"
  h_off="$( (load_cfg webdesk-rootless && cfg_hash) 2>/dev/null)"
  assert "the config hash changes when the OTLP switch flips (check catches a stale guard)" test -n "$h_on" -a "$h_on" != "$h_off"
  SUBUID_FILE="$T/g.dup"
  dies "load_cfg refuses a user with two subuid entries" load_cfg webdesk-rootless

  echo "== guard: the OTLP switch is not trusted blindly (M3)"
  # an OTLP address/port that the loader must refuse; each leaves the exception OFF and says so
  otlp_case() { # otlp_case <env-file-content> [mode]: prints "<ctorigdst lines> | <warning>"
    printf '%b' "$1" >"$T/guard.env"
    chmod "${2:-644}" "$T/guard.env"
    local out w
    out="$( (load_cfg webdesk-rootless && payload_v4 "$OTLP_PORT") 2>"$T/warn")"
    w="$(cat "$T/warn")"
    printf '%s | %s' "$(grep -c ctorigdst <<<"$out")" "$w"
  }
  SUBUID_FILE="$T/g.subuid"
  same "a good switch (172.17.0.1 is local, port 4319): the exception is ON" "2 | " "$(otlp_case 'WEBDESK_OTLP_PORT=4319\n')"
  assert "WEBDESK_OTLP_ADDR=169.254.169.254 (the metadata service) is refused" \
    grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=80\nWEBDESK_OTLP_ADDR=169.254.169.254\n')"
  assert "link-local 169.254.1.1 is refused even with a high port" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=169.254.1.1\n')"
  assert "loopback 127.0.0.1 is refused" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=127.0.0.1\n')"
  assert "an address outside the allow-list (8.8.8.8) is refused" \
    grep -q "^0 | .*not in the guard's allow-list" <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=8.8.8.8\n')"
  assert "another host-local address (10.0.0.5, a VPC address) is refused: only docker0 is allowed" \
    grep -q "^0 | .*not in the guard's allow-list" <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=10.0.0.5\n')"
  assert "an ERP bridge address (172.18.0.10, the collector's container) is refused" \
    grep -q "^0 | .*not in the guard's allow-list" <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=172.18.0.10\n')"
  # N2: the decision must not depend on live interfaces (docker0 can be missing at boot). With `ip` failing,
  # the explicit docker0 address is still accepted.
  same "the docker0 address is accepted even when no interface carries it (boot race, N2)" "2 | " \
    "$(ip() { return 1; }; otlp_case 'WEBDESK_OTLP_PORT=4319\nWEBDESK_OTLP_ADDR=172.17.0.1\n')"
  assert "port 22 is refused" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=22\n')"
  assert "port 80 (privileged) is refused" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=80\n')"
  assert "port 1023 is refused" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=1023\n')"
  assert "port 1024 is accepted" grep -q '^2 | ' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=1024\n')"
  assert "port 65535 is accepted" grep -q '^2 | ' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=65535\n')"
  assert "port 65536 is refused" grep -q '^0 | .*stays OFF' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=65536\n')"
  refused "render_v4 itself refuses an OTLP port 22" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 22 300 on
  refused "render_v4 itself refuses an OTLP port 443" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 172.17.0.1 443 300 on
  refused "render_v4 itself refuses the metadata address" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 169.254.169.254 4319 300 on
  refused "render_v4 itself refuses loopback as the OTLP address" render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 127.0.0.1 4319 300 on
  # ownership and writability of the file and its directory
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/guard.env"
  chmod 644 "$T/guard.env"
  same "a root-owned (here: TRUSTED_UID-owned), 0644 file in a 0755/0700 directory is trusted" "" "$(untrusted_reason "$T/guard.env")"
  local saved=$TRUSTED_UID
  TRUSTED_UID=$((saved + 1))
  assert "a switch file not owned by the trusted uid is refused" grep -q 'is not owned by uid' <<<"$(untrusted_reason "$T/guard.env")"
  TRUSTED_UID=$saved
  mkdir -p "$T/wdir"
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/wdir/guard.env"
  chmod 644 "$T/wdir/guard.env"
  chmod 664 "$T/guard.env"
  if [ "$(stat -c %a "$T/guard.env")" != 664 ]; then echo "  note  this shell ignores chmod: the mode and ownership checks run on the Linux gate"; else
    assert "a group-writable switch file is refused" grep -q 'group- or other-writable' <<<"$(untrusted_reason "$T/guard.env")"
    assert "  ... and the loader leaves the exception OFF, and says it refused the file" grep -q '^0 | .*refusing the OTLP switch' <<<"$(otlp_case 'WEBDESK_OTLP_PORT=4319\n' 664)"
    chmod 646 "$T/guard.env"
    assert "an other-writable switch file is refused" grep -q 'group- or other-writable' <<<"$(untrusted_reason "$T/guard.env")"
    chmod 644 "$T/guard.env"
    chmod 777 "$T/wdir"
    assert "a world-writable directory is refused" grep -q 'directory .* group- or other-writable' <<<"$(untrusted_reason "$T/wdir/guard.env")"
    chmod 775 "$T/wdir"
    assert "a group-writable directory is refused" grep -q 'directory .* group- or other-writable' <<<"$(untrusted_reason "$T/wdir/guard.env")"
    chmod 755 "$T/wdir"
    same "the same directory at 0755 is fine" "" "$(untrusted_reason "$T/wdir/guard.env")"
  fi
  assert "a directory owned by someone else (webdesk-svc owns /etc/webdesk) is refused" \
    grep -q 'directory .* is not owned by uid' <<<"$( stat() { if [ "$1" = -c ] && [ "$2" = %u ] && [ "$3" = "$T/wdir" ]; then echo 999; else command stat "$@"; fi; }; untrusted_reason "$T/wdir/guard.env")"
  TRUSTED_UID=$saved
  ln -s "$T/guard.env" "$T/guard.lnk" 2>/dev/null
  if [ -L "$T/guard.lnk" ]; then assert "a symlinked switch file is refused" grep -q 'symlink' <<<"$(untrusted_reason "$T/guard.lnk")"; else echo "  note  no real symlinks in this shell: symlink case runs on the Linux gate"; fi
  rm -f "$T/guard.env"

  echo "== guard: m2 - a changed rate or port makes a NEW hashlimit table"
  local n1 n2 n3 n4
  hn() { render_v4 WDRL940 940 700000000 700065535 8380 169.254.169.254 "${1:-172.17.0.1}" "$2" "$3" on | sed -n 's/.*--hashlimit-name \([^ ]*\) .*/\1/p'; }
  n1="$(hn 172.17.0.1 4319 300)"; n2="$(hn 172.17.0.1 4319 600)"; n3="$(hn 172.17.0.1 4320 300)"; n4="$(hn 172.17.0.1 4319 300)"
  assert "the hashlimit name differs when the rate changes" test -n "$n1" -a "$n1" != "$n2"
  assert "the hashlimit name differs when the port changes" test "$n1" != "$n3"
  assert "the same settings keep the same name (a plain reload does not leak tables)" test "$n1" = "$n4"
  assert "the name is at most 15 characters (the kernel's limit)" test "${#n1}" -le 15 -a "${#n2}" -le 15
  assert "a 5-digit uid still fits in 15 characters" test "$(render_v4 WDRL59999 59999 700000000 700065535 8380 169.254.169.254 172.17.0.1 4319 300 on | sed -n 's/.*--hashlimit-name \([^ ]*\) .*/\1/p' | tr -d '\n' | wc -c)" -le 15

  echo "== guard: check logic on synthetic iptables output (fake iptables on PATH)"
  # A fake iptables family keeps a tiny ruleset in files, so apply / check / remove run end to end without root.
  # The fake never exits 0 on something it does not understand, so a changed call shape fails the test.
  local FB="$T/fakebin"
  mkdir -p "$FB"
  cat >"$FB/iptables" <<'FAKE'
#!/usr/bin/env bash
# fake iptables / ip6tables: state in $FAKE_DIR/<prog>.OUTPUT and <prog>.chain.<name>
prog="$(basename "$0")"
st="$FAKE_DIR/$prog"
[ "${1:-}" = -w ] && shift
cmd=${1:-}
shift || true
case "$cmd" in
  -C) grep -qxF -- "-A $1 $2 $3" "$st.$1" 2>/dev/null ;;
  -I) { printf -- '-A %s %s %s\n' "$1" "$3" "$4"; cat "$st.$1" 2>/dev/null || true; } >"$st.new" && mv "$st.new" "$st.$1" ;;
  -D) awk -v l="-A $1 $2 $3" '$0 == l && !d { d = 1; next } { print }' "$st.$1" >"$st.new" && mv "$st.new" "$st.$1" ;;
  -S) if [ "$1" = OUTPUT ]; then echo "-P OUTPUT ACCEPT"; cat "$st.OUTPUT" 2>/dev/null; else
        [ -f "$st.chain.$1" ] || exit 1
        echo "-N $1"; cat "$st.chain.$1"
      fi ;;
  -F) [ -f "$st.chain.$1" ] || exit 1; : >"$st.chain.$1" ;;
  -X) [ -f "$st.chain.$1" ] || exit 1; rm -f "$st.chain.$1" ;;
  *) echo "fake iptables: unsupported: $cmd $*" >&2; exit 2 ;;
esac
FAKE
  cat >"$FB/iptables-restore" <<'FAKE'
#!/usr/bin/env bash
prog="$(basename "$0")"; prog="${prog%-restore}"
st="$FAKE_DIR/$prog"
in="$(cat)"
[ -z "${FAKE_RESTORE_FAIL_ALL:-}" ] || { echo "fake restore: forced failure" >&2; exit 1; }
if [ -n "${FAKE_RESTORE_FAIL_MATCH:-}" ] && grep -q -- "$FAKE_RESTORE_FAIL_MATCH" <<<"$in"; then echo "fake restore: forced failure on $FAKE_RESTORE_FAIL_MATCH" >&2; exit 1; fi
printf '%s\n' "$in" >"$st.last-restore"
while IFS= read -r line; do
  case "$line" in
    :*) c="${line#:}"; c="${c%% *}"; : >"$st.chain.$c" ;;
    -A\ *) c="${line#-A }"; c="${c%% *}"; printf '%s\n' "$line" >>"$st.chain.$c" ;;
  esac
done <<<"$in"
FAKE
  cp "$FB/iptables" "$FB/ip6tables"
  cp "$FB/iptables-restore" "$FB/ip6tables-restore"
  chmod +x "$FB"/*
  export FAKE_DIR="$T/fakestate"
  mkdir -p "$FAKE_DIR"
  IPT="$FB/iptables" IPT6="$FB/ip6tables" IPT_RESTORE="$FB/iptables-restore" IPT6_RESTORE="$FB/ip6tables-restore"
  STATE_DIR="$T/gstate"
  need_root() { :; }
  SUBUID_FILE="$T/g.subuid"
  rm -f "$T/guard.env"
  load_cfg webdesk-rootless
  fresh() { rm -rf "$FAKE_DIR" "$STATE_DIR"; mkdir -p "$FAKE_DIR"; unset FAKE_RESTORE_FAIL_ALL FAKE_RESTORE_FAIL_MATCH; }
  chk_out() { cmd_check 2>&1; }
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  assert "apply against the fake iptables succeeds" test $? = 0
  assert "  ... it wrote the marker" test -e "$STATE_DIR/webdesk-rootless.active"
  assert "  ... both address families hold their OUTPUT jump" test "$(cat "$FAKE_DIR/iptables.OUTPUT")" = "-A OUTPUT -j WDRL940-SEL" -a "$(cat "$FAKE_DIR/ip6tables.OUTPUT")" = "-A OUTPUT -j WDRL940-SEL"
  assert "  ... the v4 chains hold exactly the rendered rules (no OTLP line, switch absent)" \
    test "$(grep -c '^-A WDRL940-OUT' "$FAKE_DIR/iptables.chain.WDRL940-OUT")" = "$(payload_v4 '' | grep -c '^-A WDRL940-OUT')"
  assert "check PASSES right after apply" quiet cmd_check
  # m1: our jump first, then any other rule -> must still pass (it failed falsely before: sed 1,/re/ never ends on line 1)
  printf -- '-A OUTPUT -d 10.1.1.1/32 -j ACCEPT\n' >>"$FAKE_DIR/iptables.OUTPUT"
  assert "m1: our jump FIRST followed by a foreign rule: check passes" quiet cmd_check
  printf -- '-A OUTPUT -j WDRL941-SEL\n' >>"$FAKE_DIR/ip6tables.OUTPUT"
  assert "m1: our jump first followed by another instance's selector: check passes" quiet cmd_check
  printf -- '-A OUTPUT -j WDRL941-SEL\n-A OUTPUT -j WDRL940-SEL\n' >"$FAKE_DIR/iptables.OUTPUT"
  assert "another instance's selector BEFORE ours is allowed (it accepts nothing)" quiet cmd_check
  printf -- '-A OUTPUT -d 10.1.1.1/32 -j ACCEPT\n-A OUTPUT -j WDRL940-SEL\n' >"$FAKE_DIR/iptables.OUTPUT"
  refute "m1: a foreign rule BEFORE our jump: check FAILS" quiet cmd_check
  assert "  ... and names the offending rule" grep -q 'rules precede the guard in OUTPUT: -A OUTPUT -d 10.1.1.1/32 -j ACCEPT' <<<"$(chk_out)"
  printf -- '-A OUTPUT -j WDRL940-SEL\n' >"$FAKE_DIR/iptables.OUTPUT"
  assert "check passes again once the order is restored" quiet cmd_check
  printf -- '-A OUTPUT -j WDRL940-SEL\n-A OUTPUT -j WDRL940-SEL\n' >"$FAKE_DIR/iptables.OUTPUT"
  refute "two OUTPUT jumps: check FAILS" quiet cmd_check
  printf -- '-A OUTPUT -j WDRL940-SEL\n' >"$FAKE_DIR/iptables.OUTPUT"
  rm -f "$FAKE_DIR/iptables.chain.WDRL940-OUT"
  refute "a flushed/missing chain: check FAILS (drift)" quiet cmd_check
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  : >"$FAKE_DIR/iptables.chain.WDRL940-DENY"
  refute "an emptied chain: check FAILS (drift)" quiet cmd_check
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  rm -f "$STATE_DIR/webdesk-rootless.active"
  refute "no marker: check FAILS" quiet cmd_check
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/guard.env"
  chmod 644 "$T/guard.env"
  load_cfg webdesk-rootless
  refute "the OTLP switch flipped without a reload: check FAILS (stale guard)" quiet cmd_check
  rm -f "$T/guard.env"
  load_cfg webdesk-rootless
  # failure paths of apply
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  assert "precondition: a marker exists" test -e "$STATE_DIR/webdesk-rootless.active"
  export FAKE_RESTORE_FAIL_ALL=1
  ( cmd_apply ) >/dev/null 2>&1
  local rc=$?
  assert "apply: a payload that fails to load exits non-zero" test "$rc" -ne 0
  refute "apply: ... and removes the marker (the daemon cannot start unguarded)" test -e "$STATE_DIR/webdesk-rootless.active"
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/guard.env"
  chmod 644 "$T/guard.env"
  load_cfg webdesk-rootless
  export FAKE_RESTORE_FAIL_MATCH=ctorigdst
  ( cmd_apply ) >"$T/apply.out" 2>&1
  assert "apply: an OTLP payload the kernel refuses is retried WITHOUT it, and the guard is ACTIVE" test -e "$STATE_DIR/webdesk-rootless.active"
  assert "  ... with OTLP reported OFF" grep -q 'OTLP OFF' "$T/apply.out"
  refute "  ... and no OTLP rule loaded" grep -q ctorigdst "$FAKE_DIR/iptables.chain.WDRL940-OUT"
  unset FAKE_RESTORE_FAIL_MATCH
  refute "  ... and check FAILS until it is fixed (stale vs the requested config)" quiet cmd_check
  rm -f "$T/guard.env"
  load_cfg webdesk-rootless
  fresh
  ( cmd_apply ) >/dev/null 2>&1
  processes_in_set() { echo 4242; }
  ( cmd_remove ) >"$T/rm.out" 2>&1
  rc=$?
  assert "remove REFUSES while a process of the uid set runs" test "$rc" -ne 0
  assert "  ... says which pid" grep -q 'REFUSED: pid 4242' "$T/rm.out"
  assert "  ... and the guard stays: jump, chains and marker" test -e "$STATE_DIR/webdesk-rootless.active" -a -s "$FAKE_DIR/iptables.OUTPUT" -a -f "$FAKE_DIR/iptables.chain.WDRL940-OUT"
  processes_in_set() { echo; }
  ( cmd_remove ) >/dev/null 2>&1
  refute "remove with no process left unhooks the jump" test -s "$FAKE_DIR/iptables.OUTPUT"
  refute "  ... deletes the chains" test -f "$FAKE_DIR/iptables.chain.WDRL940-OUT" -o -f "$FAKE_DIR/ip6tables.chain.WDRL940-SEL"
  refute "  ... and the marker" test -e "$STATE_DIR/webdesk-rootless.active"
  echo "  END   guard"
}

# ---------------------------------------------------------------------------------------------------------------
section_install() {
  # shellcheck disable=SC1091
  . "$HERE/install-rootless.sh"
  set +e
  local out

  echo "== install: subordinate ranges against the ranges measured on gda-aicenter"
  printf '%s\n' "$MEASURED_SUBIDS" >"$T/i.subuid"
  out="$(subid_overlaps "$T/i.subuid" 700000000 65536 webdesk-rootless 940)"
  assert "the live range 700000000:65536 overlaps nothing" test $? = 0 -a -z "$out"
  assert "the proof range 700065536:65536 overlaps nothing" quiet subid_overlaps "$T/i.subuid" 700065536 65536 wdproof-rootless 941
  printf '%s\nwebdesk-rootless:700000000:65536\n' "$MEASURED_SUBIDS" >"$T/i.subuid2"
  assert "live and proof ranges are adjacent, not overlapping" quiet subid_overlaps "$T/i.subuid2" 700065536 65536 wdproof-rootless 941
  assert "the user's own exact entry is not an overlap (re-run is idempotent)" quiet subid_overlaps "$T/i.subuid2" 700000000 65536 webdesk-rootless 940
  out="$(subid_overlaps "$T/i.subuid" 558751 1 x 1)"
  assert "the last id of the highest existing range (558751) is an overlap, and it is named" test $? = 1 -a "$out" = "acct5:493216:65536"
  assert "the first id after it (558752) is free" quiet subid_overlaps "$T/i.subuid" 558752 65536 x 1
  assert "exactly the gap between the two highest existing ranges (362144, 131072 ids) is free" quiet subid_overlaps "$T/i.subuid" 362144 131072 x 1
  refute "one id more (131073) reaches the next range" quiet subid_overlaps "$T/i.subuid" 362144 131073 x 1
  printf 'webdesk-rootless:700000000:1000\n' >"$T/i.subuid3"
  refute "the same user with another count IS an overlap (a hand-edited entry)" quiet subid_overlaps "$T/i.subuid3" 700000000 65536 webdesk-rootless 940
  printf '940:700000000:65536\n# comment\nbroken line\n' >"$T/i.subuid4"
  assert "an entry keyed by uid is the user's own; malformed lines are ignored" quiet subid_overlaps "$T/i.subuid4" 700000000 65536 webdesk-rootless 940
  assert "has_subid_entry finds the exact entry" has_subid_entry "$T/i.subuid2" webdesk-rootless 940 700000000 65536
  refute "has_subid_entry: another count is not the entry" has_subid_entry "$T/i.subuid3" webdesk-rootless 940 700000000 65536

  echo "== install: the real templates render completely"
  local F="$HERE/files" R
  R="$(render_template "$F/webdesk-rootless.conf.in" USER=webdesk-rootless ROLE=live UID=940 PORT=8380 RESOLVERS=169.254.169.254 OTLP_ENV=/etc/webdesk/guard.env OPERATOR=Hansel OTLP_CREATED=0)"
  assert "guard config: ports, resolver, the shared OTLP switch, role" \
    test "$(grep -E '^RL_(ROLE|PUBLISHED_PORTS|RESOLVERS|OTLP_ENV_FILE)=' <<<"$R" | tr '\n' ' ')" = 'RL_ROLE=live RL_PUBLISHED_PORTS="8380" RL_RESOLVERS="169.254.169.254" RL_OTLP_ENV_FILE=/etc/webdesk/guard.env '
  printf '%s\n' "$R" >"$T/rendered.conf"
  R="$(render_template "$F/user-at.conf.in" USER=webdesk-rootless UID=940)"
  assert "user@940 drop-in: wants the guard instance" grep -qx 'Wants=webdesk-rootless-guard@webdesk-rootless.service' <<<"$R"
  assert "user@940 drop-in: ordered after it" grep -qx 'After=webdesk-rootless-guard@webdesk-rootless.service' <<<"$R"
  assert "user@940 drop-in: delegates exactly cpu memory pids (WSK-D72), not io or cpuset" grep -qx 'Delegate=cpu memory pids' <<<"$R"
  refute "user@940 drop-in: no io / cpuset delegation anywhere" grep -Eq '^Delegate=.*(io|cpuset)' <<<"$R"
  # N1: user@.service runs as User=%i, so only the `+` prefix makes the check run as root.
  assert "user@940 drop-in: ExecStartPre=+ runs the guard's check AS ROOT for this user (m5, N1)" grep -qx 'ExecStartPre=+/usr/local/sbin/webdesk-rootless-guard.sh check webdesk-rootless' <<<"$R"
  refute "user@940 drop-in: no ExecStartPre without the + (it would run as the user and die)" grep -Eq '^ExecStartPre=[^+]' <<<"$R"
  R="$(render_template "$F/slice.conf.in" USER=webdesk-rootless UID=940 CPU_QUOTA=100% MEMORY_MAX=5G TASKS_MAX=4096)"
  assert "slice envelope: CPUQuota=100% MemoryMax=5G TasksMax=4096 (WSK-D72: 1.0 vCPU)" \
    test "$(grep -E '^(CPUQuota|MemoryMax|TasksMax)=' <<<"$R" | tr '\n' ' ')" = "CPUQuota=100% MemoryMax=5G TasksMax=4096 "
  R="$(render_template "$F/docker.service.in" USER=webdesk-rootless OPERATOR=Hansel)"
  assert "docker.service refuses to start without the guard marker" grep -qx 'ExecStartPre=/usr/bin/test -e /run/webdesk-rootless-guard/webdesk-rootless.active' <<<"$R"
  assert "docker.service grants the operator, non-fatally" grep -qx 'ExecStartPost=-/usr/local/lib/webdesk-rootless/grant-socket.sh Hansel %t' <<<"$R"
  local e missing=""
  for e in NET=slirp4netns PORT_DRIVER=builtin DISABLE_HOST_LOOPBACK=true SLIRP4NETNS_SANDBOX=true SLIRP4NETNS_SECCOMP=true DETACH_NETNS=false; do
    grep -qx "Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_$e" <<<"$R" || missing="$missing $e"
  done
  assert "docker.service pins slirp4netns, builtin ports, no host loopback, sandbox, seccomp, no detach-netns" test -z "$missing"
  R="$(render_template "$F/daemon.json.in" DATA_ROOT=/var/lib/webdesk-rootless/docker)"
  assert "daemon.json: data root" grep -q '"data-root": "/var/lib/webdesk-rootless/docker"' <<<"$R"
  assert "daemon.json: containerd image store (image id = digest)" grep -q '"containerd-snapshotter": true' <<<"$R"
  assert "daemon.json: systemd cgroup driver pinned" grep -q 'native.cgroupdriver=systemd' <<<"$R"
  refute "daemon.json: nothing on 172.17/16 (the host's docker0, the OTLP address, must not be shadowed)" grep -q '172\.17\.' <<<"$R"
  if command -v python3 >/dev/null 2>&1; then
    assert "daemon.json parses as JSON" quiet python3 -c 'import json,sys; json.load(sys.stdin)' <<<"$R"
  elif command -v jq >/dev/null 2>&1; then
    assert "daemon.json parses as JSON" quiet jq . <<<"$R"
  else echo "  note  no python3/jq: daemon.json JSON check skipped"; fi
  refute "the guard unit is not ordered after the rootful docker.service" grep -q '^After=.*docker' "$F/webdesk-rootless-guard@.service"
  refused "a template with a token left unrendered is refused (docker.service without OPERATOR)" render_template "$F/docker.service.in" USER=webdesk-rootless
  refused "a value with | is refused" render_template "$F/slice.conf.in" USER=a UID=1 CPU_QUOTA='1|0' MEMORY_MAX=1G TASKS_MAX=1
  refused "a value with & is refused" render_template "$F/slice.conf.in" USER=a UID=1 CPU_QUOTA='1&' MEMORY_MAX=1G TASKS_MAX=1
  refused "a value with a backslash is refused" render_template "$F/slice.conf.in" USER=a UID=1 CPU_QUOTA='1\1' MEMORY_MAX=1G TASKS_MAX=1
  refused "a value with a newline is refused" render_template "$F/slice.conf.in" USER=a UID=1 CPU_QUOTA=$'1\n2' MEMORY_MAX=1G TASKS_MAX=1
  refused "a lower-case key is refused" render_template "$F/slice.conf.in" user=a UID=1 CPU_QUOTA=1% MEMORY_MAX=1G TASKS_MAX=1

  echo "== install: host facts"
  printf '# managed\nnameserver 169.254.169.254\nnameserver 169.254.169.254\nnameserver fe80::1\nsearch x\nnameserver 10.0.0.2\n' >"$T/resolv"
  assert "resolvers_of: IPv4 only, de-duplicated, in order" test "$(resolvers_of "$T/resolv")" = "169.254.169.254 10.0.0.2"
  assert "version_ge 6.1 5.11 (the box's kernel)" version_ge 6.1 5.11
  refute "version_ge 5.10 5.11" version_ge 5.10 5.11
  assert "version_ge 252 247 (the box's systemd)" version_ge 252 247
  assert "version_ge equal" version_ge 247 247

  echo "== install: arguments"
  out="$( (parse_args apply --profile live && echo "$RL_USER $RL_UID $SUB_START $SUB_END $PORT $CPU_QUOTA $MEMORY_MAX $TASKS_MAX $OTLP_ENV $ETC_ACCESS $TREE $ROLE $OPERATOR") 2>&1)"
  assert "live profile" test "$out" = "webdesk-rootless 940 700000000 700065535 8380 100% 5G 4096 /etc/webdesk/guard.env 1 /home/Hansel/gaiada-webdesk/webdesk live Hansel"
  out="$( (parse_args plan --profile proof && echo "$RL_USER $RL_UID $SUB_START $SUB_END $PORT $CPU_QUOTA $MEMORY_MAX $TASKS_MAX $OTLP_ENV $ETC_ACCESS [$TREE] $ROLE") 2>&1)"
  assert "proof profile" test "$out" = "wdproof-rootless 941 700065536 700131071 18380 50% 4G 2048 /etc/default/wdproof-rootless-otlp 0 [] proof"
  out="$( (parse_args apply --profile proof --etc-access --tree /srv/wdproof/webdesk --port 28380 && echo "$ETC_ACCESS $TREE $PORT") 2>&1)"
  assert "proof with --etc-access --tree --port (the P2 rehearsal)" test "$out" = "1 /srv/wdproof/webdesk 28380"
  out="$( (parse_args check && echo "$PROFILE $USER_AT_DROPIN $SLICE_DROPIN $SOCK") 2>&1)"
  assert "derived paths: drop-ins and socket" test "$out" = "live /etc/systemd/system/user@940.service.d/50-webdesk-rootless.conf /etc/systemd/system/user-940.slice.d/50-webdesk-rootless.conf /run/user/940/docker.sock"
  dies "an unknown mode" parse_args install
  dies "an unknown profile" parse_args apply --profile staging
  dies "an unknown option" parse_args apply --force
  dies "an option without its value" parse_args apply --uid
  dies "a privileged port" parse_args apply --port 80
  dies "a uid below 100" parse_args apply --uid 50
  dies "a subid start below 100000" parse_args apply --subid-start 5000
  dies "CPUQuota 0%" parse_args apply --cpu-quota 0%
  dies "MemoryMax in T" parse_args apply --memory-max 5T
  dies "a relative OTLP switch path" parse_args apply --otlp-env etc/guard.env
  dies "a tree path with .." parse_args apply --tree /srv/../root
  dies "the daemon user = the operator" parse_args apply --user hansel --operator hansel
  dies "an upper-case daemon user name" parse_args apply --user WebDesk
  out="$( (parse_args apply --operator Hansel.ops && echo "$OPERATOR") 2>&1)"
  assert "an existing mixed-case operator account is accepted (the box's is Hansel)" test "$out" = "Hansel.ops"

  echo "== install: cgroup checks (fake cgroup tree)"
  CGROUP_ROOT="$T/cg"
  parse_args check --profile live
  mkdir -p "$CGROUP_ROOT/user.slice/user-940.slice/user@940.service"
  printf 'cpuset cpu io memory pids\n' >"$CGROUP_ROOT/user.slice/user-940.slice/user@940.service/cgroup.controllers"
  printf '100000 100000\n' >"$CGROUP_ROOT/user.slice/user-940.slice/cpu.max"
  printf '5368709120\n' >"$CGROUP_ROOT/user.slice/user-940.slice/memory.max"
  printf '4096\n' >"$CGROUP_ROOT/user.slice/user-940.slice/pids.max"
  assert "delegated: cpu memory pids present" delegated
  assert "envelope_ok: CPUQuota=100% -> 100000 100000, 5G -> 5368709120, 4096" envelope_ok
  printf 'max 100000\n' >"$CGROUP_ROOT/user.slice/user-940.slice/cpu.max"
  refute "envelope_ok fails when the CPU quota is gone" envelope_ok
  printf 'memory pids\n' >"$CGROUP_ROOT/user.slice/user-940.slice/user@940.service/cgroup.controllers"
  refute "delegated fails without the cpu controller" delegated

  echo "== install: B1 - root never writes through the daemon user's tree"
  # Without root: as_user runs the command as the test's own user. The symlink attack is what matters here:
  # ~/.config/systemd/user -> a root-only directory ("etc"). The helper must refuse and write nothing there.
  as_user() { "$@"; }
  local H="$T/home" E="$T/etc-sys"
  HOME_DIR="$H"
  RL_USER=wdtest
  mkdir -p "$H/.config/systemd" "$E"
  echo '[Service]' >"$T/unit.in"
  assert "user_write creates the missing parent directories and the file" quiet user_write "$T/unit.in" "$H/.config/docker/daemon.json" 0644
  same "  ... with the content" "[Service]" "$(cat "$H/.config/docker/daemon.json")"
  same "  ... and the mode" "644" "$(stat -c %a "$H/.config/docker/daemon.json")"
  ln -s "$E" "$T/probe-link" 2>/dev/null
  if [ ! -L "$T/probe-link" ]; then echo "  note  this shell cannot make real symlinks (Git Bash copies): the symlink-attack checks run on the Linux gate"; else
    ln -s "$E" "$H/.config/systemd/user"
    refute "user_write refuses a symlinked directory in the path (the attack: ~/.config/systemd/user -> /etc/systemd/system)"       quiet user_write "$T/unit.in" "$H/.config/systemd/user/docker.service" 0644
    same "  ... and wrote nothing into the target" "" "$(ls -A "$E")"
    refute "user_link refuses the same symlinked directory" quiet user_link "$H/.config/systemd/user/default.target.wants/docker.service" ../docker.service
    same "  ... and made nothing there" "" "$(ls -A "$E")"
    refute "user_dir refuses a symlinked data root" quiet bash -c '. "$1"; HOME_DIR=$2; as_user() { "$@"; }; ln -s "$3" "$2/docker"; user_dir "$2/docker" 0700' _ "$HERE/install-rootless.sh" "$H" "$E"
    same "  ... and chmod nothing there" "" "$(ls -A "$E")"
    rm -f "$H/.config/systemd/user" "$H/docker"
    mkdir -p "$H/.config/systemd/user"
    ln -s "$E/victim" "$H/.config/systemd/user/docker.service"
    refute "user_write refuses a symlinked destination file" quiet user_write "$T/unit.in" "$H/.config/systemd/user/docker.service" 0644
    same "  ... and wrote nothing through it" "" "$(ls -A "$E")"
    refute "a path outside the home is refused" quiet user_write "$T/unit.in" "$E/x" 0644
    refute "a .. path is refused" quiet user_write "$T/unit.in" "$H/../etc-sys/x" 0644
    mv "$H" "$T/home-real" && ln -s "$T/home-real" "$H"
    refute "a symlinked home (the anchor itself) is refused" quiet user_write "$T/unit.in" "$H/f" 0644
    rm -f "$H"; mv "$T/home-real" "$H"
    assert "user_link creates the enablement symlink as the user" quiet user_link "$H/.config/systemd/user/default.target.wants/docker.service" ../docker.service
    same "  ... pointing at ../docker.service" "../docker.service" "$(readlink "$H/.config/systemd/user/default.target.wants/docker.service")"
    assert "user_dir creates the data root 0700" quiet user_dir "$H/docker" 0700
    same "  ... mode 700" "700" "$(stat -c %a "$H/docker")"
  fi
  # The static guard: no root-side install/ln/chown/rm names a path in the user's tree.
  refute "do_home contains no root install/ln/chown/rm on the user's tree" bash -c     "sed -n '/^do_home() {/,/^}/p' '$HERE/install-rootless.sh' | grep -E '(^|[^_a-z])(install|ln|chown|rm) '| grep -v 'rm -rf \"\$t\"'"
  echo "== install: remove reads the facts back from passwd and its own config (M1, M2)"
  local RM="$T/rm"
  mkdir -p "$RM"
  getent() { [ "$1" = passwd ] && [ "$2" = wdproof-rootless ] && echo "wdproof-rootless:x:941:941::/var/lib/wdproof-rootless:/usr/sbin/nologin"; }
  printf 'wdproof-rootless:700065536:65536\n' >"$RM/subuid"
  cp "$RM/subuid" "$RM/subgid"
  # rm_conf <role> <uid> <otlp-file> <created>
  rm_conf() { printf 'RL_ROLE=%s\nRL_UID=%s\nRL_OTLP_ENV_FILE=%s\nRL_OTLP_CREATED=%s\n' "$1" "$2" "$3" "$4" >"$RM/conf"; }
  # rr <extra parse_args options...>: what resolve_remove settles on, or its refusal
  rr() {
    (
      parse_args remove --profile proof "$@" || exit 1
      CONF_FILE="$RM/conf" SUBUID_FILE="$RM/subuid" SUBGID_FILE="$RM/subgid"
      resolve_remove || exit 1
      echo "$RL_UID $SUB_START $SUB_END [$OTLP_REMOVE] $USER_AT_DROPIN"
    ) 2>&1
  }
  rm_conf proof 941 /etc/default/wdproof-rootless-otlp 1
  same "remove derives the uid from passwd, the range from /etc/subuid, the switch from its own record" \
    "941 700065536 700131071 [/etc/default/wdproof-rootless-otlp] /etc/systemd/system/user@941.service.d/50-webdesk-rootless.conf" "$(rr)"
  assert "an explicit --uid that matches passwd is accepted" test "$(rr --uid 941 | cut -d' ' -f1)" = 941
  refute "a typo --uid 1001 is refused (it would stop user@1001.service)" quiet rr --uid 1001
  assert "  ... with a message naming passwd" grep -q 'passwd database' <<<"$(rr --uid 1001)"
  rm_conf proof 942 /etc/default/wdproof-rootless-otlp 1
  assert "a config whose RL_UID differs from passwd is refused" grep -q 'REFUSED: .*RL_UID=942' <<<"$(rr)"
  rm -f "$RM/conf"
  assert "an absent config is refused (no default role)" grep -q 'REFUSED: .*absent' <<<"$(rr)"
  printf 'RL_UID=941\n' >"$RM/conf"
  assert "a config with no RL_ROLE is refused, not defaulted to proof" grep -q "REFUSED: remove is for a PROOF install only" <<<"$(rr)"
  rm_conf live 941 /etc/webdesk/guard.env 0
  assert "a config that says live is refused" grep -q 'REFUSED: remove is for a PROOF install only' <<<"$(rr)"
  rm_conf proof 941 /etc/default/wdproof-rootless-otlp 1
  assert "--subid-start that differs from /etc/subuid is refused" grep -q 'REFUSED: --subid-start' <<<"$(rr --subid-start 700000000)"
  printf 'wdproof-rootless:700065536:65536\nwdproof-rootless:900000000:65536\n' >"$RM/subuid"
  assert "two subuid entries for the user are refused" grep -q 'exactly one entry' <<<"$(rr)"
  printf 'wdproof-rootless:700065536:65536\n' >"$RM/subuid"
  printf 'wdproof-rootless:700000000:65536\n' >"$RM/subgid"
  assert "a subgid range that differs from the subuid range is refused" grep -q 'does not hold the same range' <<<"$(rr)"
  cp "$RM/subuid" "$RM/subgid"
  # M2
  assert "--otlp-env /etc/webdesk/guard.env is refused for a proof at parse time (the live guard's switch)" \
    grep -q 'must not use a switch under /etc/webdesk' <<<"$(rr --otlp-env /etc/webdesk/guard.env)"
  assert "--otlp-env pointing anywhere but the recorded switch is refused by remove" \
    grep -q 'differs from the switch recorded' <<<"$(rr --otlp-env /etc/default/other)"
  rm_conf proof 941 /etc/default/wdproof-rootless-otlp 0
  same "a switch the install did NOT create is never deleted" "941 700065536 700131071 [] /etc/systemd/system/user@941.service.d/50-webdesk-rootless.conf" "$(rr)"
  rm_conf proof 941 /etc/webdesk/guard.env 1
  assert "a recorded switch under /etc/webdesk is refused even if marked created" grep -q 'REFUSED: the recorded switch' <<<"$(rr)"
  rm_conf proof 941 'relative/switch' 1
  assert "a recorded relative path is refused" grep -q 'not an absolute path' <<<"$(rr)"
  refute "do_remove never runs a recursive rm (rm -r/-rf)" bash -c "sed -n '/^do_remove() {/,/^}/p' '$HERE/install-rootless.sh' | grep -Eq 'rm -[a-z]*r'"
  assert "do_remove deletes the switch with rm -f on OTLP_REMOVE only" bash -c "sed -n '/^do_remove() {/,/^}/p' '$HERE/install-rootless.sh' | grep -q 'rm -f \"\$OTLP_REMOVE\"'"
  refute "do_remove never names the command-line OTLP_ENV" bash -c "sed -n '/^do_remove() {/,/^}/p' '$HERE/install-rootless.sh' | grep -q 'OTLP_ENV'"
  unset -f getent
  echo "== install: tests that must be able to fail (docker info, runuser)"
  rl_docker() { return 1; }
  refute "no_warnings is FALSE when the daemon does not answer (it used to pass)" quiet no_warnings
  rl_docker() { echo 'WARNING: No cpu cfs quota support' >&2; }
  refute "no_warnings is false on a missing-cpu warning" quiet no_warnings
  rl_docker() { echo 'WARNING: Running in rootless-mode without cgroups' >&2; }
  refute "no_warnings is false on a cgroup warning" quiet no_warnings
  rl_docker() { echo 'WARNING: No cpuset support' >&2; echo 'WARNING: No io.weight support' >&2; }
  assert "no_warnings ignores cpuset / io (not delegated by design)" quiet no_warnings
  rl_docker() { echo 'Server: fine'; }
  assert "no_warnings is true on a clean answer" quiet no_warnings
  unset -f rl_docker
  local EV="$T/etcv"
  mkdir -p "$EV"
  : >"$EV/ok" ; : >"$EV/secret"
  ETC_READ_OK="$EV/ok"
  ETC_READ_NO="$EV/secret"
  # an as_user that behaves like the real one: can read ok and /etc/os-release, not secret, cannot list /etc/webdesk
  as_user() { case "$*" in true | "test -r /etc/os-release" | "test -r $EV/ok") return 0 ;; esac; return 1; }
  ETC_ROOT="$EV"
  assert "etc_access_ok passes with a correct as_user" quiet etc_access_ok
  as_user() { return 1; }
  refute "etc_access_ok is FALSE when runuser itself fails (every negative would otherwise pass)" quiet etc_access_ok
  as_user() { case "$*" in true | "test -r /etc/os-release") return 0 ;; esac; return 1; }
  refute "etc_access_ok is false when the user cannot read a file it must read" quiet etc_access_ok
  as_user() { case "$*" in "test -r /etc/os-release" | "test -r $EV/ok" | "test -r $EV/secret") return 0 ;; esac; return 1; }
  refute "etc_access_ok is false when positive control 'true' fails" quiet etc_access_ok
  as_user() { return 0; }
  refute "etc_access_ok is false when the user can read a secret" quiet etc_access_ok
  as_user() { case "$*" in true | "test -r /etc/os-release" | "test -r $EV/ok") return 0 ;; esac; return 1; }
  ETC_READ_NO="$EV/absent"
  refute "etc_access_ok is false when a file it should find unreadable is simply absent" quiet etc_access_ok
  echo "  END   install"
}

# ---------------------------------------------------------------------------------------------------------------
section_copy() {
  # shellcheck disable=SC1091
  . "$HERE/wd-volume-copy.sh"
  set +e

  echo "== volume copy: arguments and names"
  assert "host: rootful" valid_host rootful
  assert "host: the live rootless socket" valid_host unix:///run/user/940/docker.sock
  refute "host: uid 0" valid_host unix:///run/user/0/docker.sock
  refute "host: the rootful socket path" valid_host unix:///var/run/docker.sock
  refute "host: tcp" valid_host tcp://127.0.0.1:2375
  refute "host: a path escape" valid_host unix:///run/user/940/../0/docker.sock
  assert "volume: webdesk_webdesk_pgdata (the measured live name)" valid_volume webdesk_webdesk_pgdata
  refute "volume: a slash" valid_volume a/b
  refute "volume: a leading dash" valid_volume -x
  assert "image: node:22-bookworm" valid_image node:22-bookworm
  assert "image: digest-pinned" valid_image "node:22-bookworm@sha256:$(printf '%064d' 0)"
  refute "image: a shell metacharacter" valid_image 'node;rm'
  (parse_args --from rootful --to unix:///run/user/940/docker.sock --volume webdesk_webdesk_pgdata && echo "$FROM|$TO|$VOL|$TOVOL|$REPLACE") >"$T/c.args" 2>&1
  assert "a cut-over copy parses; the destination name defaults to the source's" \
    test "$(cat "$T/c.args")" = "rootful|unix:///run/user/940/docker.sock|webdesk_webdesk_pgdata|webdesk_webdesk_pgdata|0"
  dies "the same daemon on both sides" parse_args --from rootful --to rootful --volume v
  dies "a bad --to" parse_args --from rootful --to unix:///tmp/x.sock --volume v
  dies "a missing volume" parse_args --from rootful --to unix:///run/user/940/docker.sock
  dies "a relative --keep" parse_args --from rootful --to unix:///run/user/940/docker.sock --volume v --keep tmp/x
  dies "an option without its value" parse_args --from rootful --to unix:///run/user/940/docker.sock --volume

  echo "== volume copy: the uid mapping verify relies on"
  assert "the daemon uid is container root" test "$(ns_id 940 940 700000000 65536)" = 0
  assert "the first subuid is container uid 1" test "$(ns_id 700000000 940 700000000 65536)" = 1
  assert "postgres (container uid 70) = host 700000069" test "$(ns_id 700000069 940 700000000 65536)" = 70
  assert "rustfs (container uid 10001) = host 700010000" test "$(ns_id 700010000 940 700000000 65536)" = 10001
  assert "the last subuid is container uid 65536" test "$(ns_id 700065535 940 700000000 65536)" = 65536
  assert "one past the range is unmappable" test "$(ns_id 700065536 940 700000000 65536)" = "?700065536"
  assert "webdesk-svc (999) is unmappable" test "$(ns_id 999 940 700000000 65536)" = "?999"
  printf './PG_VERSION\tf 600 700000069 700000069 3 abc 1700000000\n.\td 700 700000069 700000069 - - 1700000001\n' >"$T/c.host"
  assert "map_manifest rewrites both owner columns and keeps the mtime" \
    test "$(map_manifest 940 940 700000000 65536 700000000 65536 <"$T/c.host" | tr '\t' '|' | tr '\n' ';')" = "./PG_VERSION|f 600 70 70 3 abc 1700000000;.|d 700 70 70 - - 1700000001;"
  # The pipeline shape the tool really runs (a manifest streamed into has_unmapped), under pipefail, with ~190 KiB
  # (three pipe buffers) and the match on line 1: a consumer that exits at the first match would SIGPIPE the writer.
  big() { awk -v n=2000 'BEGIN { printf "./unmapped\tf 600 ?999 70 1 x 5\n"; for (i = 1; i <= n; i++) printf "./f%05d\tf 600 70 70 3 %064d 7\n", i, i }'; }
  assert "the test input is larger than a pipe buffer (>64 KiB)" test "$(big | wc -c)" -gt 131072
  (set -o pipefail; big | has_unmapped)
  assert "has_unmapped finds a ?<id> owner on line 1 of a >64 KiB stream, in a pipeline, under pipefail" test $? = 0
  (set -o pipefail; big | sed 1d | has_unmapped)
  refute "has_unmapped: the same stream with that line removed passes, in a pipeline, under pipefail" test $? = 0
  (set -o pipefail; big | grep -q '?')
  if [ $? = 0 ]; then echo "  note  the naive early-exit consumer did not SIGPIPE the writer on this shell: the control is inconclusive here"; else
    t_ok "control: a consumer that exits at the first match (grep -q) DOES fail this pipeline under pipefail, so the check above can fail"; fi
  big >"$T/c.big"
  assert "has_unmapped on a file argument too" has_unmapped "$T/c.big"
  sed 1d "$T/c.big" >"$T/c.clean"
  refute "has_unmapped: a fully mapped manifest passes" has_unmapped "$T/c.clean"
  printf './what?\tf 600 70 70 1 x 5\n' >"$T/c.q"
  refute "has_unmapped: a ? in the PATH is not an owner" has_unmapped "$T/c.q"
  printf 'u:1:2\nwdproof-rootless:700065536:65536\n' >"$T/c.sub"
  assert "subid_of: one entry" test "$(subid_of "$T/c.sub" wdproof-rootless 941)" = "700065536 65536"
  printf 'x:1:2\nx:3:4\n' >"$T/c.sub2"
  refute "subid_of: two entries fail" quiet subid_of "$T/c.sub2" x 5

  echo "== volume copy: the manifest"
  if ! find /dev/null -maxdepth 0 -printf '' >/dev/null 2>&1; then echo "  note  find has no -printf: manifest checks skipped"; else
    mkdir -p "$T/src/sub dir" "$T/src/empty"
    printf 'hello\n' >"$T/src/a.txt"
    printf 'pg\n' >"$T/src/sub dir/b file"
    ln -s a.txt "$T/src/link" 2>/dev/null || true
    manifest "$T/src" >"$T/m1"
    local n
    n="$(wc -l <"$T/m1" | tr -d ' ')"
    assert "one line per entry (root, 2 dirs, 2 files, maybe a symlink)" test "$n" -ge 5
    assert "a file's line carries its sha256" grep -q "$(sha256sum <"$T/src/a.txt" | cut -d' ' -f1)" "$T/m1"
    assert "a path with a space is quoted, not split" grep -q 'sub\\ dir/b\\ file' "$T/m1"
    assert "directories carry no size, but a whole-second mtime" grep -qE '^\.	d [0-7]+ [0-9]+ [0-9]+ - - [0-9]+$' "$T/m1"
    assert "a file's line ends with its whole-second mtime" grep -qE "^\./a\.txt	f [0-7]+ [0-9]+ [0-9]+ 6 [0-9a-f]{64} [0-9]+$" "$T/m1"
    assert "sorted (LC_ALL=C)" test "$(cut -f1 "$T/m1")" = "$(cut -f1 "$T/m1" | LC_ALL=C sort)"
    cp -a "$T/src" "$T/dst"
    manifest "$T/dst" >"$T/m2"
    same "a faithful copy has the same manifest" "$(cat "$T/m1")" "$(cat "$T/m2")"
    printf 'hellO\n' >"$T/dst/a.txt"
    touch -r "$T/src/a.txt" "$T/dst/a.txt"
    refute "one changed byte is caught" test "$(manifest "$T/dst")" = "$(cat "$T/m1")"
    printf 'hello\n' >"$T/dst/a.txt"
    touch -d @1700000000 "$T/dst/a.txt"
    touch -d @1700000500 "$T/src/a.txt"
    refute "an mtime-only difference is caught" test "$(manifest "$T/dst")" = "$(manifest "$T/src")"
    touch -r "$T/src/a.txt" "$T/dst/a.txt"
    assert "  ... and equal again once the mtimes agree" test "$(manifest "$T/dst")" = "$(manifest "$T/src")"
  fi

  echo "== volume copy: M4 - a --replace may not empty the rollback copy or a volume a stack still references"
  (parse_args --from unix:///run/user/940/docker.sock --to rootful --volume v --replace --replace-rootful-rollback-copy && echo "$REPLACE $REPLACE_RB") >"$T/c.rb" 2>&1
  assert "the explicit flag parses" test "$(cat "$T/c.rb")" = "1 1"
  dies "--replace-rootful-rollback-copy without --replace is refused" parse_args --from rootful --to unix:///run/user/940/docker.sock --volume v --replace-rootful-rollback-copy
  same "no flag, a ROOTFUL destination: refused" "refused" "$(replace_refusal rootful 0 0 | grep -q 'ROLLBACK copy' && echo refused)"
  same "no flag, a rootless destination with no container: allowed" "" "$(replace_refusal unix:///run/user/940/docker.sock 0 0)"
  same "no flag, a rootless destination a (stopped) container references: refused" "refused" \
    "$(replace_refusal unix:///run/user/940/docker.sock 2 0 | grep -q '2 container' && echo refused)"
  same "the explicit flag allows a rootful destination" "" "$(replace_refusal rootful 0 1)"
  same "the explicit flag allows a referenced volume" "" "$(replace_refusal unix:///run/user/940/docker.sock 3 1)"
  # cmd_copy end to end with stub daemons: nothing may be emptied before the refusal
  EMPTIED="$T/emptied"
  dk() { # dk <HOST> docker-args...
    shift
    case "$1 ${2:-}" in
      "image inspect") echo sha256:stub ;;
      "volume inspect") return 0 ;;
      "ps -q") return 0 ;;
      "ps -aq") printf '%s' "$STUB_REFS" ;;
    esac
    return 0
  }
  helper() { # helper <HOST> docker-run-args...
    case "$*" in
      *"find /dst -mindepth 1 -delete"*) : >"$EMPTIED"; return 0 ;;
      *"find /dst -mindepth 1 -maxdepth 1"*) printf 5 ;;
      *"--entrypoint stat"*) echo "0 0 755" ;;
    esac
    return 0
  }
  cp_run() { ( FROM=$1 TO=$2 VOL=v TOVOL=v IMAGE=node:22 REPLACE=1 REPLACE_RB=${3:-0} KEEP=""; cmd_verify() { echo VERIFY-REACHED; }; cmd_copy ) 2>&1; }
  rm -f "$EMPTIED"; STUB_REFS=""
  out="$(cp_run unix:///run/user/940/docker.sock rootful)"
  assert "cmd_copy: swapped --from/--to with --replace toward rootful is REFUSED" grep -q 'REFUSED --replace' <<<"$out"
  refute "  ... and the destination was not emptied" test -e "$EMPTIED"
  out="$(cp_run rootful unix:///run/user/940/docker.sock)"
  assert "cmd_copy: --replace into a rootless volume with no container proceeds" grep -q 'emptying' <<<"$out"
  assert "  ... and empties it" test -e "$EMPTIED"
  rm -f "$EMPTIED"; STUB_REFS="abc123"
  out="$(cp_run rootful unix:///run/user/940/docker.sock)"
  assert "cmd_copy: --replace of a volume a STOPPED container references is REFUSED (not_in_use only sees running ones)" grep -q 'REFUSED --replace' <<<"$out"
  refute "  ... and the destination was not emptied" test -e "$EMPTIED"
  out="$(cp_run rootful unix:///run/user/940/docker.sock 1)"
  assert "cmd_copy: the explicit flag lets it through" grep -q 'emptying' <<<"$out"
  rm -f "$EMPTIED"; STUB_REFS=""
  out="$(cp_run unix:///run/user/940/docker.sock rootful 1)"
  assert "cmd_copy: the explicit flag lets a rootful rollback copy be overwritten" grep -q 'emptying' <<<"$out"

  echo "== volume copy: M5 - a source the copy cannot reproduce is refused"
  printf '%s\n' '27 SCHILY.xattr.user.k=v' '30 SCHILY.acl.access=user::rw-' | count_xattr_records >"$T/x.n"
  same "count_xattr_records counts SCHILY.xattr and SCHILY.acl records" 2 "$(cat "$T/x.n")"
  same "count_xattr_records: a stream with none counts 0" 0 "$(printf 'plain file data\nSCHILY mentioned loosely\n' | count_xattr_records)"
  # a stream > 64 KiB with the record first: the counter must read it all (no SIGPIPE on the writer under pipefail)
  (set -o pipefail; { echo '28 SCHILY.xattr.user.a=b'; awk 'BEGIN { for (i = 0; i < 4000; i++) print "filler line number " i " xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }'; } | count_xattr_records >"$T/x.n2")
  assert "count_xattr_records reads a >64 KiB stream to the end, in a pipeline, under pipefail" test "$(cat "$T/x.n2")" = 1
  same "scan_verdict: nothing found, no refusal" "" "$(scan_verdict 0 0 '')"
  assert "scan_verdict: xattr/ACL records are refused" grep -q 'extended attributes or POSIX ACLs (3 records)' <<<"$(scan_verdict 3 0 '')"
  assert "scan_verdict: hard links are refused and named" grep -q 'multiply-linked.*first: /src/a /src/b' <<<"$(scan_verdict 0 2 '/src/a /src/b ')"
  assert "scan_verdict: garbage from the scan is refused, not read as zero" grep -q 'no usable answer' <<<"$(scan_verdict '' 0 '')"
  # scan_source against stub helpers
  helper() {
    case "$*" in
      *"--entrypoint tar"*) printf '%s\n' "$STUB_TAR" ;;
      *"--entrypoint find"*) printf '%s' "$STUB_FIND" ;;
    esac
    return 0
  }
  FROM=rootful VOL=v IMAGE=node:22
  STUB_TAR="plain" STUB_FIND=""
  out="$( (scan_source) 2>&1)"
  assert "scan_source: a clean source passes and says what it ran" grep -q 'source scan: no extended attributes' <<<"$out"
  STUB_TAR="27 SCHILY.xattr.user.k=v" STUB_FIND=""
  out="$( (scan_source) 2>&1)"
  assert "scan_source: a source with an xattr is refused with a clear message" grep -q 'extended attributes or POSIX ACLs' <<<"$out"
  STUB_TAR="plain" STUB_FIND="/src/data/a
/src/data/b"
  out="$( (scan_source) 2>&1)"
  assert "scan_source: a source with a hard link is refused and the paths are named" grep -q 'multiply-linked.*/src/data/a' <<<"$out"
  helper() { return 3; }
  out="$( (scan_source) 2>&1)"
  assert "scan_source: a failing helper is an error, not a clean source" grep -q 'scan of v on rootful failed' <<<"$out"
  dk() { shift; case "$1 ${2:-}" in "ps -aq") printf 'a\nb\n' ;; esac; }
  same "refs_count counts the containers, running or stopped" 2 "$(refs_count rootful v)"
  dk() { shift; case "$1 ${2:-}" in "ps -aq") : ;; esac; }
  same "refs_count: none is 0" 0 "$(refs_count rootful v)"
  unset -f dk helper

  echo "== volume copy: m4 - --keep must be a new path"
  mkdir -p "$T/kp"
  KEEP="$T/kp/exists"
  mkdir -p "$KEEP"
  chmod 755 "$KEEP"
  out="$( (prepare_work_dir) 2>&1)"
  assert "an existing --keep directory is refused" grep -q 'already exists' <<<"$out"
  same "  ... and its mode was not touched" "755" "$(stat -c %a "$KEEP")"
  printf x >"$T/kp/afile"
  KEEP="$T/kp/afile"
  assert "an existing --keep file is refused" grep -q 'already exists' <<<"$( (prepare_work_dir) 2>&1)"
  KEEP="$T/kp/new"
  out="$(prepare_work_dir)"
  same "a new path is created and returned" "$T/kp/new" "$out"
  assert "  ... as a directory" test -d "$T/kp/new"
  KEEP="$T/kp/new"
  assert "  ... and a second use of the same path is refused" grep -q 'already exists' <<<"$( (prepare_work_dir) 2>&1)"
  KEEP="$T/kp/nodir/x"
  assert "a --keep whose parent is missing is refused" grep -q 'not a plain directory' <<<"$( (prepare_work_dir) 2>&1)"
  if [ "$(chmod 777 "$T/kp"; stat -c %a "$T/kp")" = 777 ]; then
    KEEP="$T/kp/new2"
    assert "a world-writable parent is refused" grep -q 'group- or other-writable' <<<"$( (prepare_work_dir) 2>&1)"
    refute "  ... and nothing was created" test -e "$T/kp/new2"
    chmod 755 "$T/kp"
    same "a created --keep is 0700" "700" "$(stat -c %a "$T/kp/new")"
  else echo "  note  this shell ignores chmod: the parent-mode and 0700 checks run on the Linux gate"; fi
  KEEP=""
  assert "no --keep: a fresh temp directory" test -d "$(prepare_work_dir)"
  echo "  END   copy"
}

# ---------------------------------------------------------------------------------------------------------------
section_roundtrip() {
  # The installer renders the guard's config; the guard must parse exactly that into the designed rule set.
  # Both scripts are sourced (installer first; the shared helper names have the same meaning in both).
  # shellcheck disable=SC1091
  . "$HERE/install-rootless.sh"
  # shellcheck disable=SC1091
  . "$HERE/webdesk-rootless-guard.sh"
  set +e
  echo "== install -> guard: the rendered config is the config the guard parses"
  getent() { [ "$1" = passwd ] && [ "$2" = webdesk-rootless ] && echo "webdesk-rootless:x:940:940::/var/lib/webdesk-rootless:/usr/sbin/nologin"; }
  CONF_DIR="$T/rt"
  SUBUID_FILE="$T/rt.subuid"
  mkdir -p "$CONF_DIR"
  printf '%s\nwebdesk-rootless:700000000:65536\n' "$MEASURED_SUBIDS" >"$SUBUID_FILE"
  printf 'WEBDESK_OTLP_PORT=4319\n' >"$T/rt.guard.env"
  chmod 644 "$T/rt.guard.env"
  TRUSTED_UID="$(stat -c %u "$T")"
  render_template "$HERE/files/webdesk-rootless.conf.in" USER=webdesk-rootless ROLE=live UID=940 PORT=8380 \
    RESOLVERS=169.254.169.254 OTLP_ENV="$T/rt.guard.env" OPERATOR=Hansel OTLP_CREATED=0 >"$CONF_DIR/webdesk-rootless-webdesk-rootless"
  same "installer-rendered config + the live OTLP switch -> the designed v4 rule set" "$WANT_V4" \
    "$( (load_cfg webdesk-rootless && payload_v4 "$OTLP_PORT") 2>&1)"
  same "  ... and the designed v6 rule set" "$WANT_V6" "$( (load_cfg webdesk-rootless && payload_v6) 2>&1)"
  echo "  END   roundtrip"
}

# ---------------------------------------------------------------------------------------------------------------
section_consumers() {
  echo "== consumers: one switch, one function"
  local ref f fn body missing="" differ=""
  ref="$WD_TREE/ops/deploy/deploy-webdesk.sh"
  fn() { sed -n '/^wd_docker_host() {$/,/^}$/p' "$1"; }
  body="$(fn "$ref")"
  assert "deploy-webdesk.sh defines wd_docker_host" test -n "$body"
  for f in ops/probes/containment-probe.sh ops/scripts/webdesk-backup-nightly.sh ops/scripts/ensure-backup-role.sh ops/scripts/webdesk-restore-drill.sh; do
    [ -f "$WD_TREE/$f" ] || { missing="$missing $f"; continue; }
    [ "$(fn "$WD_TREE/$f")" = "$body" ] || differ="$differ $f"
  done
  assert "every consumer exists" test -z "$missing"
  assert "the probe, nightly backup, backup-role and restore drill carry the byte-identical function" test -z "$differ"
  # ensure-backup-role.sh is /bin/sh: run the very same function under sh.
  { printf '%s\n' "$body"; printf 'wd_docker_host\n'; } >"$T/wdh.sh"
  local sock=unix:///run/user/940/docker.sock
  printf 'WEBDESK_DOCKER_HOST=%s\n' "$sock" >"$T/switch"
  assert "sh: no variable, no switch -> rootful" test "$(env -u WEBDESK_DOCKER_HOST WEBDESK_DOCKER_SWITCH="$T/none" sh "$T/wdh.sh")" = ""
  assert "sh: the switch file -> its socket" test "$(env -u WEBDESK_DOCKER_HOST WEBDESK_DOCKER_SWITCH="$T/switch" sh "$T/wdh.sh")" = "$sock"
  assert "sh: an explicit empty variable beats the switch" test "$(env WEBDESK_DOCKER_HOST= WEBDESK_DOCKER_SWITCH="$T/switch" sh "$T/wdh.sh")" = ""
  refute "sh: a tcp:// value is refused" quiet env WEBDESK_DOCKER_HOST=tcp://x:2375 sh "$T/wdh.sh"
  refute "sh: uid 0 is refused" quiet env WEBDESK_DOCKER_HOST=unix:///run/user/0/docker.sock sh "$T/wdh.sh"
  echo "  END   consumers"
}

PASS=0 FAIL=0 BROKEN=""
for s in guard install roundtrip copy consumers; do
  out="$( ("section_$s") 2>&1)"
  printf '%s\n' "$out"
  PASS=$((PASS + $(grep -c '^  PASS' <<<"$out")))
  FAIL=$((FAIL + $(grep -c '^  FAIL' <<<"$out")))
  grep -q "^  END   $s\$" <<<"$out" || BROKEN="$BROKEN $s"
done
echo
if [ -n "$BROKEN" ]; then echo "  FAIL  section(s) stopped early:$BROKEN"; FAIL=$((FAIL + 1)); fi
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
