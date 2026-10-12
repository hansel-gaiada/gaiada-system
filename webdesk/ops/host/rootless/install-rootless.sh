#!/usr/bin/env bash
# install-rootless.sh - install, verify or remove a rootless Docker daemon for WebDesk on gda-aicenter
# (M4 F6, WSK-D73). Plan: docs/plans/2026-10-12-webdesk-rootless-plan.md §2.1-§2.4, phases P2 and P3.
#
#   sudo bash install-rootless.sh plan   [--profile live|proof] [overrides]   print every action, change nothing
#   sudo bash install-rootless.sh apply  [--profile live|proof] [overrides]   converge (idempotent; re-run is safe)
#   sudo bash install-rootless.sh check  [--profile live|proof] [overrides]   exit 0 only if the end state holds
#   sudo bash install-rootless.sh remove  --profile proof                     undo a PROOF install (refuses live)
#
# Profiles. Overrides: --user --uid --subid-start --port --operator --cpu-quota --memory-max --tasks-max
# --otlp-env, and --allow-restart.
#   live   webdesk-rootless, uid/gid 940, subuid/subgid 700000000:65536, publishes 127.0.0.1:8380,
#          slice CPUQuota=100% MemoryMax=5G TasksMax=4096, OTLP switch /etc/webdesk/guard.env (absent = off)
#   proof  wdproof-rootless, uid/gid 941, subuid/subgid 700065536:65536, publishes 127.0.0.1:18380,
#          slice CPUQuota=50% MemoryMax=4G TasksMax=2048, OTLP switch /etc/default/wdproof-rootless-otlp
# Why 940/941: free on the box, and no process there runs as them (a rootful container image's default uid
# would collide: uid 999 is redis inside every rootful redis:alpine container, which is why webdesk-svc is
# not used). Why 700000000+: above useradd's SUB_UID_MAX (600100000), so no future human account is ever
# given an overlapping range; the box already has five 65536-ranges between 100000 and 558751.
#
# What apply does, in order (each step is skipped when it already holds):
#   1 preflight: Debian 12, kernel >= 5.11, cgroup v2, systemd >= 247, rootless extras = docker-ce version, the
#     uid is free and unused by any process, the subordinate range overlaps nothing in /etc/subuid or /etc/subgid
#   2 apt: uidmap slirp4netns (dbus-user-session and acl are already on gda-aicenter)
#   3 the system user (nologin, locked, home /var/lib/<user> 0700, no other group) and its subuid/subgid range
#   4 the egress guard (script, unit instance, config): enabled and ACTIVE before anything of the user runs
#   5 systemd drop-ins: user@<uid>.service (guard first; Delegate) and the user-<uid>.slice envelope
#   6 the user's docker.service and daemon.json, rendered from files/, enabled for default.target
#   7 linger: the user manager, and with it the daemon, starts now and at every boot
#   8 verify (also what `check` runs)
# It NEVER restarts a running LIVE daemon (that restarts WebDesk) unless --allow-restart is given.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILES="$HERE/files"
GUARD_SRC="$HERE/webdesk-rootless-guard.sh"
GUARD_BIN=/usr/local/sbin/webdesk-rootless-guard.sh
GUARD_UNIT=/etc/systemd/system/webdesk-rootless-guard@.service
GRANT_BIN=/usr/local/lib/webdesk-rootless/grant-socket.sh
SUBUID_FILE="${WEBDESK_RL_SUBUID_FILE:-/etc/subuid}"
SUBGID_FILE="${WEBDESK_RL_SUBGID_FILE:-/etc/subgid}"
SUB_UID_MAX_AUTO=600100000

say() { printf '%s\n' "$*"; }
die() { printf 'install-rootless: %s\n' "$*" >&2; exit 1; }

# --- pure helpers (test-rootless.sh drives these) -------------------------------------------------------------

is_uint() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac; [ "${#1}" -le 10 ]; }
is_user() { [[ "${1:-}" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; }

# subid_overlaps <file> <start> <count> <self-user> <self-uid>: prints every entry whose range intersects
# [start, start+count) other than this user's own EXACT entry; returns 1 if it printed any.
subid_overlaps() {
  local f=$1 s=$2 c=$3 u=$4 id=$5
  [ -r "$f" ] || return 0
  awk -F: -v s="$s" -v c="$c" -v u="$u" -v id="$id" '
    NF != 3 || $2 !~ /^[0-9]+$/ || $3 !~ /^[0-9]+$/ { next }
    ($1 == u || $1 == id) && $2 == s && $3 == c { next }
    { a = $2 + 0; b = $2 + $3 - 1; e = s + c - 1; if (a <= e && s <= b) { print; hit = 1 } }
    END { exit hit ? 1 : 0 }' "$f"
}

# has_subid_entry <file> <user> <uid> <start> <count>: exactly this user's range is present.
has_subid_entry() {
  awk -F: -v u="$2" -v id="$3" -v s="$4" -v c="$5" '($1 == u || $1 == id) && $2 == s && $3 == c { f = 1 } END { exit f ? 0 : 1 }' "$1" 2>/dev/null
}

# render_template <template> KEY=VALUE...: substitutes @KEY@; refuses a value that could break out of the sed
# expression or the file format, and fails if any @TOKEN@ is left unrendered.
render_template() {
  local t=$1 kv k v out
  local -a expr=()
  shift
  for kv in "$@"; do
    k=${kv%%=*}
    v=${kv#*=}
    [[ "$k" =~ ^[A-Z_]+$ ]] || return 1
    case "$v" in *'|'* | *'\'* | *'&'* | *$'\n'*) return 1 ;; esac
    expr+=(-e "s|@$k@|$v|g")
  done
  out="$(sed "${expr[@]}" "$t")" || return 1
  if printf '%s\n' "$out" | grep -Eq '@[A-Z_]+@'; then return 1; fi
  printf '%s\n' "$out"
}

# resolvers_of <resolv.conf>: the IPv4 nameservers, de-duplicated, space-separated.
resolvers_of() {
  awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && !seen[$2]++ { printf "%s%s", sep, $2; sep = " " }' "$1" 2>/dev/null
}

# version_ge <a> <b>: dotted numeric compare (a >= b)
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

# --- options --------------------------------------------------------------------------------------------------

parse_args() {
  MODE="${1:-}"
  case "$MODE" in plan | apply | check | remove) shift ;; *) die "usage: $0 plan|apply|check|remove [--profile live|proof] [overrides]" ;; esac
  PROFILE=live
  ALLOW_RESTART=0
  declare -gA OVR=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) PROFILE="${2:-}"; shift 2 ;;
      --allow-restart) ALLOW_RESTART=1; shift ;;
      --user | --uid | --subid-start | --port | --operator | --cpu-quota | --memory-max | --tasks-max | --otlp-env)
        [ $# -ge 2 ] || die "$1 needs a value"
        OVR["$1"]="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  case "$PROFILE" in
    live) RL_USER=webdesk-rootless RL_UID=940 SUB_START=700000000 PORT=8380 CPU_QUOTA=100% MEMORY_MAX=5G TASKS_MAX=4096 OTLP_ENV=/etc/webdesk/guard.env ROLE=live ;;
    proof) RL_USER=wdproof-rootless RL_UID=941 SUB_START=700065536 PORT=18380 CPU_QUOTA=50% MEMORY_MAX=4G TASKS_MAX=2048 OTLP_ENV=/etc/default/wdproof-rootless-otlp ROLE=proof ;;
    *) die "--profile must be live or proof" ;;
  esac
  OPERATOR=Hansel
  SUB_COUNT=65536
  RL_USER="${OVR[--user]:-$RL_USER}"
  RL_UID="${OVR[--uid]:-$RL_UID}"
  SUB_START="${OVR[--subid-start]:-$SUB_START}"
  PORT="${OVR[--port]:-$PORT}"
  OPERATOR="${OVR[--operator]:-$OPERATOR}"
  CPU_QUOTA="${OVR[--cpu-quota]:-$CPU_QUOTA}"
  MEMORY_MAX="${OVR[--memory-max]:-$MEMORY_MAX}"
  TASKS_MAX="${OVR[--tasks-max]:-$TASKS_MAX}"
  OTLP_ENV="${OVR[--otlp-env]:-$OTLP_ENV}"
  is_user "$RL_USER" && is_user "$OPERATOR" || die "bad user/operator name"
  is_uint "$RL_UID" && is_uint "$SUB_START" && is_uint "$PORT" && is_uint "$TASKS_MAX" || die "uid, subid start, port and tasks-max must be numbers"
  [ "$RL_UID" -ge 100 ] && [ "$RL_UID" -lt 60000 ] || die "uid $RL_UID outside 100-59999"
  [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "port must be 1024-65535 (unprivileged)"
  [[ "$CPU_QUOTA" =~ ^[0-9]{1,3}%$ ]] && [[ "$MEMORY_MAX" =~ ^[0-9]+[KMG]$ ]] || die "bad --cpu-quota or --memory-max"
  case "$OTLP_ENV" in /*) ;; *) die "--otlp-env must be an absolute path" ;; esac
  SUB_END=$((SUB_START + SUB_COUNT - 1))
  HOME_DIR="/var/lib/$RL_USER"
  DATA_ROOT="$HOME_DIR/docker"
  CONF_FILE="/etc/default/webdesk-rootless-$RL_USER"
  USER_AT_DROPIN="/etc/systemd/system/user@$RL_UID.service.d/50-webdesk-rootless.conf"
  SLICE_DROPIN="/etc/systemd/system/user-$RL_UID.slice.d/50-webdesk-rootless.conf"
  UNIT_FILE="$HOME_DIR/.config/systemd/user/docker.service"
  DAEMON_JSON="$HOME_DIR/.config/docker/daemon.json"
  RUNTIME="/run/user/$RL_UID"
  SOCK="$RUNTIME/docker.sock"
  GUARD_UNIT_INSTANCE="webdesk-rootless-guard@$RL_USER.service"
  RESOLVERS=""
  CHANGED_DAEMON=0
  FAILS=0
}

# --- runner ---------------------------------------------------------------------------------------------------

step() { # step "<what>" cmd...   (plan: print it; apply/remove: do it)
  local what=$1
  shift
  if [ "$MODE" = plan ]; then
    printf '  PLAN  %s\n        %s\n' "$what" "$(printf '%q ' "$@")"
    return 0
  fi
  printf '  DO    %s\n' "$what"
  "$@"
}

# put_file <rendered-src> <dest> <mode> <owner:group> [daemon]: write when content, mode or owner differ.
put_file() {
  local src=$1 dst=$2 mode=$3 own=$4 tag=${5:-}
  if [ -f "$dst" ] && cmp -s "$src" "$dst" && [ "$(stat -c '%a %U:%G' "$dst")" = "${mode#0} $own" ]; then
    say "  OK    $dst (unchanged)"
    return 0
  fi
  [ "$tag" = daemon ] && CHANGED_DAEMON=1
  step "write $dst ($mode $own)" install -D -m "$mode" -o "${own%%:*}" -g "${own##*:}" "$src" "$dst"
}

user_systemctl() { # systemctl --user as the daemon user, without a login session
  runuser -u "$RL_USER" -- env XDG_RUNTIME_DIR="$RUNTIME" DBUS_SESSION_BUS_ADDRESS="unix:path=$RUNTIME/bus" systemctl --user "$@"
}

rl_docker() { docker -H "unix://$SOCK" "$@"; }

pass() { say "  PASS  $*"; }
fail() { say "  FAIL  $*"; FAILS=$((FAILS + 1)); }
chk() { # chk "<what>" cmd...
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}

# --- 1 preflight ----------------------------------------------------------------------------------------------

preflight() {
  say "== 1 preflight ($PROFILE: $RL_USER uid $RL_UID, subids $SUB_START-$SUB_END, 127.0.0.1:$PORT)"
  [ "$(id -u)" = 0 ] || die "root only"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = debian ] && [ "${VERSION_ID%%.*}" -ge 12 ] || die "Debian 12 or later only (found ${PRETTY_NAME:-unknown})"
  version_ge "$(uname -r | cut -d- -f1)" 5.11 || die "kernel $(uname -r) < 5.11: no rootless overlayfs"
  [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || die "cgroup v2 is required (resource limits in rootless mode)"
  version_ge "$(systemctl --version | awk 'NR == 1 { print $2 }')" 247 || die "systemd >= 247 required"
  command -v dockerd-rootless.sh >/dev/null && command -v rootlesskit >/dev/null || die "docker-ce-rootless-extras is not installed"
  local v1 v2
  v1="$(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || true)"
  v2="$(dpkg-query -W -f='${Version}' docker-ce-rootless-extras 2>/dev/null || true)"
  [ -n "$v1" ] && [ "$v1" = "$v2" ] || die "docker-ce ($v1) and docker-ce-rootless-extras ($v2) differ"
  [ -x /usr/sbin/iptables-restore ] && [ -x /usr/sbin/ip6tables-restore ] || die "iptables-restore / ip6tables-restore missing"
  id "$OPERATOR" >/dev/null 2>&1 || die "operator $OPERATOR does not exist"
  [ -f "$GUARD_SRC" ] && [ -d "$FILES" ] || die "run from a checkout: $GUARD_SRC and $FILES must exist"
  local cur
  cur="$(getent passwd "$RL_USER" | cut -d: -f3 || true)"
  if [ -n "$cur" ]; then
    [ "$cur" = "$RL_UID" ] || die "$RL_USER exists with uid $cur, not $RL_UID"
  else
    [ -z "$(getent passwd "$RL_UID" || true)" ] || die "uid $RL_UID belongs to another account"
    [ -z "$(getent group "$RL_UID" || true)" ] || die "gid $RL_UID belongs to another group"
    # A process already running as this uid would be a rootful container whose image uses it: that process
    # would own the daemon's files after an escape. Pick another uid.
    if ps -e -o uid= | awk -v u="$RL_UID" '$1 == u { f = 1 } END { exit f ? 0 : 1 }'; then
      die "a process already runs as uid $RL_UID (a rootful container?): choose another --uid"
    fi
  fi
  local hits
  for f in "$SUBUID_FILE" "$SUBGID_FILE"; do
    hits="$(subid_overlaps "$f" "$SUB_START" "$SUB_COUNT" "$RL_USER" "$RL_UID" || true)"
    [ -z "$hits" ] || die "range $SUB_START-$SUB_END overlaps $f: $(printf '%s' "$hits" | tr '\n' ' ')"
  done
  [ "$SUB_START" -gt "$SUB_UID_MAX_AUTO" ] || say "  NOTE  $SUB_START is inside useradd's automatic range; a future account could be offered it"
  local freekb
  freekb="$(df -Pk /var/lib | awk 'NR == 2 { print $4 }')"
  [ "${freekb:-0}" -ge 5242880 ] || die "less than 5 GiB free under /var/lib"
  RESOLVERS="$(resolvers_of /etc/resolv.conf)"
  [ -n "$RESOLVERS" ] || die "no IPv4 nameserver in /etc/resolv.conf"
  say "  OK    host checks; resolvers: $RESOLVERS"
}

# --- 2..7 apply -----------------------------------------------------------------------------------------------

do_packages() {
  say "== 2 packages"
  local p missing=""
  for p in uidmap slirp4netns dbus-user-session acl; do
    dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q 'ok installed' || missing="$missing $p"
  done
  if [ -z "$missing" ]; then say "  OK    uidmap slirp4netns dbus-user-session acl installed"; return 0; fi
  # shellcheck disable=SC2086
  step "apt-get install$missing" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing
}

do_user() {
  say "== 3 user + subordinate ids"
  if getent group "$RL_USER" >/dev/null; then say "  OK    group $RL_USER"; else
    step "group $RL_USER gid $RL_UID" groupadd --system --gid "$RL_UID" "$RL_USER"
  fi
  if getent passwd "$RL_USER" >/dev/null; then say "  OK    user $RL_USER"; else
    step "system user $RL_USER (nologin, locked, home $HOME_DIR)" useradd --system --uid "$RL_UID" --gid "$RL_UID" \
      --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin --comment "WebDesk rootless Docker daemon (WSK-D73)" "$RL_USER"
  fi
  step "home $HOME_DIR 0700" chmod 0700 "$HOME_DIR"
  if has_subid_entry "$SUBUID_FILE" "$RL_USER" "$RL_UID" "$SUB_START" "$SUB_COUNT"; then say "  OK    subuid $SUB_START:$SUB_COUNT"; else
    step "subuid $SUB_START-$SUB_END" usermod --add-subuids "$SUB_START-$SUB_END" "$RL_USER"
  fi
  if has_subid_entry "$SUBGID_FILE" "$RL_USER" "$RL_UID" "$SUB_START" "$SUB_COUNT"; then say "  OK    subgid $SUB_START:$SUB_COUNT"; else
    step "subgid $SUB_START-$SUB_END" usermod --add-subgids "$SUB_START-$SUB_END" "$RL_USER"
  fi
}

do_guard() {
  say "== 4 egress guard (before anything of $RL_USER runs)"
  local t
  t="$(mktemp -d)"
  render_template "$FILES/webdesk-rootless.conf.in" USER="$RL_USER" ROLE="$ROLE" UID="$RL_UID" PORT="$PORT" \
    RESOLVERS="$RESOLVERS" OTLP_ENV="$OTLP_ENV" OPERATOR="$OPERATOR" >"$t/conf" || die "cannot render the guard config"
  put_file "$GUARD_SRC" "$GUARD_BIN" 0755 root:root
  put_file "$FILES/webdesk-rootless-guard@.service" "$GUARD_UNIT" 0644 root:root
  put_file "$FILES/grant-socket.sh" "$GRANT_BIN" 0755 root:root
  put_file "$t/conf" "$CONF_FILE" 0644 root:root
  if [ "$ROLE" = proof ] && [ ! -e "$OTLP_ENV" ]; then step "empty OTLP switch for the proof ($OTLP_ENV)" install -m 0644 /dev/null "$OTLP_ENV"; fi
  rm -rf "$t"
  step "systemd daemon-reload" systemctl daemon-reload
  step "enable $GUARD_UNIT_INSTANCE" systemctl enable "$GUARD_UNIT_INSTANCE"
  if [ "$MODE" = apply ] && systemctl is-active --quiet "$GUARD_UNIT_INSTANCE"; then
    step "re-apply the guard (reload = apply; never a stop)" systemctl reload "$GUARD_UNIT_INSTANCE"
  else
    step "start $GUARD_UNIT_INSTANCE" systemctl start "$GUARD_UNIT_INSTANCE"
  fi
  if [ "$MODE" = apply ]; then
    [ -e "/run/webdesk-rootless-guard/$RL_USER.active" ] || die "the guard did not become ACTIVE: stopping before anything of $RL_USER runs"
    say "  OK    guard ACTIVE"
  fi
}

do_systemd() {
  say "== 5 systemd: user@$RL_UID drop-in, user-$RL_UID.slice envelope"
  local t
  t="$(mktemp -d)"
  render_template "$FILES/user-at.conf.in" USER="$RL_USER" UID="$RL_UID" >"$t/at" || die "render user@ drop-in"
  render_template "$FILES/slice.conf.in" USER="$RL_USER" UID="$RL_UID" CPU_QUOTA="$CPU_QUOTA" MEMORY_MAX="$MEMORY_MAX" \
    TASKS_MAX="$TASKS_MAX" >"$t/slice" || die "render slice drop-in"
  put_file "$t/at" "$USER_AT_DROPIN" 0644 root:root
  put_file "$t/slice" "$SLICE_DROPIN" 0644 root:root
  rm -rf "$t"
  step "systemd daemon-reload" systemctl daemon-reload
}

do_home() {
  say "== 6 the daemon user's docker.service + daemon.json"
  local t
  t="$(mktemp -d)"
  render_template "$FILES/docker.service.in" USER="$RL_USER" OPERATOR="$OPERATOR" >"$t/unit" || die "render docker.service"
  render_template "$FILES/daemon.json.in" DATA_ROOT="$DATA_ROOT" >"$t/json" || die "render daemon.json"
  put_file "$t/unit" "$UNIT_FILE" 0644 "$RL_USER:$RL_USER" daemon
  put_file "$t/json" "$DAEMON_JSON" 0644 "$RL_USER:$RL_USER" daemon
  rm -rf "$t"
  local wants="$HOME_DIR/.config/systemd/user/default.target.wants"
  if [ -L "$wants/docker.service" ]; then say "  OK    docker.service enabled for default.target"; else
    # The enablement symlink `systemctl --user enable` would make; made by root, then handed over below.
    step "enable docker.service for default.target" sh -c "install -d '$wants' && ln -sfn ../docker.service '$wants/docker.service'"
  fi
  # install -D created the parent directories as root: the whole ~/.config belongs to the daemon user.
  step "own ~/.config" chown -R "$RL_USER:$RL_USER" "$HOME_DIR/.config"
  step "data root $DATA_ROOT" install -d -m 0710 -o "$RL_USER" -g "$RL_USER" "$DATA_ROOT"
}

do_linger_and_daemon() {
  say "== 7 linger + the daemon"
  if [ -e "/var/lib/systemd/linger/$RL_USER" ]; then say "  OK    linger on"; else
    step "loginctl enable-linger $RL_USER (user manager now and at every boot)" loginctl enable-linger "$RL_USER"
  fi
  [ "$MODE" = apply ] || return 0
  local i
  for i in $(seq 1 60); do [ -S "$RUNTIME/bus" ] && break; sleep 1; done
  [ -S "$RUNTIME/bus" ] || die "the user manager of $RL_USER did not come up ($RUNTIME/bus missing)"
  user_systemctl daemon-reload
  if ! user_systemctl is-active --quiet docker.service; then
    step "start the rootless daemon" user_systemctl start docker.service
  elif [ "$CHANGED_DAEMON" = 1 ]; then
    if [ "$ROLE" = live ] && [ "$ALLOW_RESTART" != 1 ]; then
      say "  WARN  the daemon's config changed but the LIVE daemon was NOT restarted (that restarts WebDesk):"
      say "        re-run with --allow-restart inside a window"
    else
      step "restart the rootless daemon (config changed)" user_systemctl restart docker.service
    fi
  else
    say "  OK    rootless daemon active, config unchanged"
  fi
  for i in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 1; done
  [ -S "$SOCK" ] || die "no $SOCK after 60 s: journalctl _UID=$RL_UID -n 50"
}

# --- 8 verify (= check) ---------------------------------------------------------------------------------------

proc_cmdline() { # proc_cmdline <uid> <exact-name>: the first such process's argv, space-joined
  local pid
  pid="$(pgrep -u "$1" -x "$2" | head -n1 || true)"
  [ -n "$pid" ] && tr '\0' ' ' <"/proc/$pid/cmdline"
}
has_all() { # has_all <haystack> <needle>...
  local hay=$1 n
  shift
  [ -n "$hay" ] || return 1
  for n in "$@"; do case "$hay" in *"$n"*) ;; *) return 1 ;; esac; done
}
lacks() { [ -n "$1" ] && case "$1" in *"$2"*) return 1 ;; *) return 0 ;; esac; }
user_ok() {
  [ "$(id -u "$RL_USER")" = "$RL_UID" ] && [ "$(id -nG "$RL_USER")" = "$RL_USER" ] &&
    [ "$(getent passwd "$RL_USER" | cut -d: -f7)" = /usr/sbin/nologin ] &&
    [ "$(passwd -S "$RL_USER" | awk '{ print $2 }')" = L ]
}
subids_ok() { grep -qx "$RL_USER:$SUB_START:$SUB_COUNT" "$SUBUID_FILE" && grep -qx "$RL_USER:$SUB_START:$SUB_COUNT" "$SUBGID_FILE"; }
delegated() { # cpu memory pids are delegated to user@<uid>.service
  local ctl c
  ctl=" $(cat "/sys/fs/cgroup/user.slice/user-$RL_UID.slice/user@$RL_UID.service/cgroup.controllers" 2>/dev/null) "
  for c in cpu memory pids; do case "$ctl" in *" $c "*) ;; *) return 1 ;; esac; done
}
envelope_ok() { # the slice's own cgroup files carry the envelope
  local d="/sys/fs/cgroup/user.slice/user-$RL_UID.slice" want_cpu want_mem
  want_cpu="$(( ${CPU_QUOTA%\%} * 1000 )) 100000"
  want_mem="$(numfmt --from=iec "$MEMORY_MAX")"
  [ "$(cat "$d/cpu.max")" = "$want_cpu" ] && [ "$(cat "$d/memory.max")" = "$want_mem" ] && [ "$(cat "$d/pids.max")" = "$TASKS_MAX" ]
}
# A missing cgroup controller shows as a `docker info` WARNING naming it; other warnings are not this check's.
no_warnings() { ! rl_docker info 2>&1 >/dev/null | grep -Eiq 'WARNING:.*(cgroup|cpu|memory|pids|io\.|cpuset|swap)'; }
only_operator() { # nobody but the owner and the operator can reach the socket
  [ $(( 8#$(stat -c %a "$SOCK") & 7 )) = 0 ] && [ $(( 8#$(stat -c %a "$RUNTIME") & 7 )) = 0 ] &&
    [ "$(getfacl -cp "$SOCK" 2>/dev/null | grep -E '^user:[^:]+:' | cut -d: -f2 | tr '\n' ' ')" = "$OPERATOR " ]
}

verify() {
  say "== 8 verify ($PROFILE: $RL_USER)"
  local info rk sl
  chk "user $RL_USER: uid $RL_UID, nologin, password locked, no supplementary group" user_ok
  chk "subuid + subgid $RL_USER:$SUB_START:$SUB_COUNT" subids_ok
  chk "linger on" test -e "/var/lib/systemd/linger/$RL_USER"
  chk "guard: $GUARD_BIN check $RL_USER" "$GUARD_BIN" check "$RL_USER"
  chk "cpu memory pids delegated to user@$RL_UID.service" delegated
  chk "envelope on user-$RL_UID.slice: CPUQuota=$CPU_QUOTA MemoryMax=$MEMORY_MAX TasksMax=$TASKS_MAX" envelope_ok
  if ! info="$(rl_docker info --format '{{json .SecurityOptions}} {{.CgroupDriver}} {{.CgroupVersion}} {{json .DriverStatus}}' 2>/dev/null)"; then
    fail "the daemon at $SOCK does not answer"
  else
    case "$info" in *name=rootless*) pass "daemon reports rootless" ;; *) fail "daemon does NOT report rootless: $info" ;; esac
    case "$info" in *" systemd 2 "*) pass "cgroup driver systemd, cgroup v2" ;; *) fail "cgroup driver/version: $info" ;; esac
    case "$info" in *io.containerd.snapshotter.v1*) pass "containerd image store (image id = manifest digest, as deploy-webdesk.sh needs)" ;;
      *) fail "not the containerd image store: deploy-webdesk.sh's digest check would break" ;; esac
  fi
  chk "docker info prints no WARNING (no missing cgroup controller)" no_warnings
  rk="$(proc_cmdline "$RL_UID" rootlesskit || true)"
  sl="$(proc_cmdline "$RL_UID" slirp4netns || true)"
  chk "rootlesskit: slirp4netns, builtin port driver, host loopback disabled, sandbox + seccomp forced" \
    has_all "$rk" --net=slirp4netns --port-driver=builtin --disable-host-loopback --slirp4netns-sandbox=true --slirp4netns-seccomp=true
  chk "rootlesskit runs WITHOUT --detach-netns (dockerd and --net=host stay in RootlessKit's netns)" lacks "$rk" --detach-netns
  chk "slirp4netns: --enable-sandbox --enable-seccomp --disable-host-loopback" has_all "$sl" --enable-sandbox --enable-seccomp --disable-host-loopback
  chk "operator $OPERATOR reaches the socket as itself" runuser -u "$OPERATOR" -- docker -H "unix://$SOCK" version --format '{{.Server.Version}}'
  chk "no account but the owner and $OPERATOR can reach the socket" only_operator
  if [ "$FAILS" = 0 ]; then say "VERIFY OK ($PROFILE: $RL_USER)"; else say "VERIFY FAILED: $FAILS check(s)"; fi
  [ "$FAILS" = 0 ]
}

# --- remove (proof only) --------------------------------------------------------------------------------------

do_remove() {
  [ "$(id -u)" = 0 ] || die "root only"
  local role
  role="$(sed -n 's/^RL_ROLE=//p' "$CONF_FILE" 2>/dev/null | tail -n1)"
  [ "$ROLE" = proof ] && [ "${role:-proof}" = proof ] || die "REFUSED: remove is for a PROOF install only (this is $RL_USER, role ${role:-$ROLE})"
  say "== remove the proof install of $RL_USER"
  step "disable linger" loginctl disable-linger "$RL_USER"
  step "stop user@$RL_UID.service (daemon and containers)" systemctl stop "user@$RL_UID.service"
  local i
  for i in $(seq 1 30); do
    ps -e -o uid= | awk -v u="$RL_UID" -v s="$SUB_START" -v e="$SUB_END" '$1 == u || ($1 >= s && $1 <= e) { f = 1 } END { exit f ? 0 : 1 }' || break
    sleep 1
  done
  step "stop + disable the guard (remove refuses while any process of the range runs)" systemctl disable --now "$GUARD_UNIT_INSTANCE"
  step "drop-ins and config" rm -rf "$(dirname "$USER_AT_DROPIN")" "$(dirname "$SLICE_DROPIN")" "$CONF_FILE" "$OTLP_ENV"
  step "systemd daemon-reload" systemctl daemon-reload
  step "subuid/subgid $SUB_START-$SUB_END" usermod --del-subuids "$SUB_START-$SUB_END" --del-subgids "$SUB_START-$SUB_END" "$RL_USER"
  if findmnt -rno TARGET | grep -q "^$HOME_DIR"; then die "mounts remain under $HOME_DIR: not deleting the user"; fi
  step "delete $RL_USER and its home (images, volumes, state)" userdel -r "$RL_USER"
  say "removed. Shared files stay ($GUARD_BIN, $GUARD_UNIT, $GRANT_BIN, packages): the live install uses them."
}

# --- main -----------------------------------------------------------------------------------------------------

main() {
  parse_args "$@"
  case "$MODE" in
    plan | apply)
      preflight
      do_packages
      do_user
      do_guard
      do_systemd
      do_home
      do_linger_and_daemon
      if [ "$MODE" = apply ]; then verify; else say "plan only: nothing was changed"; fi
      ;;
    check)
      [ "$(id -u)" = 0 ] || die "root only"
      verify
      ;;
    remove) do_remove ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
