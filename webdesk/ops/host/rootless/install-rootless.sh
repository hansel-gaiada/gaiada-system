#!/usr/bin/env bash
# install-rootless.sh - install, verify or remove a rootless Docker daemon for WebDesk on gda-aicenter
# (M4 F6, WSK-D73). Design and phases: docs/plans/2026-10-12-webdesk-rootless-plan.md (§3, P2/P3).
#
#   sudo bash install-rootless.sh plan   [--profile live|proof] [options]   print every action, change nothing
#   sudo bash install-rootless.sh apply  [--profile live|proof] [options]   converge (idempotent; re-run is safe)
#   sudo bash install-rootless.sh check  [--profile live|proof] [options]   exit 0 only if the end state holds
#   sudo bash install-rootless.sh remove  --profile proof [options]         undo a PROOF install (refuses live)
#
# Options (override the profile): --user --uid --subid-start --port --operator --cpu-quota --memory-max
#   --tasks-max --otlp-env --tree DIR, the flag --etc-access (give the daemon user search access to the
#   /etc/webdesk bind sources; on in live, the proof uses it to rehearse), and --allow-restart.
#
# Profiles:
#   live   webdesk-rootless, uid/gid 940, subuid/subgid 700000000:65536, publishes 127.0.0.1:8380,
#          slice CPUQuota=100% MemoryMax=5G TasksMax=4096, OTLP switch /etc/webdesk/guard.env (absent = off),
#          /etc/webdesk search access on, project tree /home/Hansel/gaiada-webdesk/webdesk
#   proof  wdproof-rootless, uid/gid 941, subuid/subgid 700065536:65536, publishes 127.0.0.1:18380,
#          slice CPUQuota=50% MemoryMax=4G TasksMax=2048, OTLP switch /etc/default/wdproof-rootless-otlp,
#          no /etc/webdesk access and no project tree unless given
# Why 940/941: free on the box, no process runs as them, and away from the uids container images use (999 is
# redis inside redis:alpine; under the rootful daemon three such processes run as host uid 999 =
# webdesk-svc, which is why webdesk-svc is not the daemon user). Why 700000000+: above useradd's
# SUB_UID_MAX (600100000), so no future account is ever given an overlapping range; /etc/subuid and
# /etc/subgid already hold five 65536-ranges between 100000 and 558751 (measured 2026-10-12).
#
# What apply does, in order (each step is skipped when it already holds):
#   1 preflight: Debian 12, kernel >= 5.11, cgroup v2, systemd >= 247, rootless extras = docker-ce version, the
#     uid is free and unused by any process, the subordinate range overlaps nothing in /etc/subuid or /etc/subgid
#   2 apt: uidmap slirp4netns (dbus-user-session and acl are already on gda-aicenter)
#   3 the system user (nologin, locked, home /var/lib/<user> 0700, no other group) and its subuid/subgid range
#   4 the egress guard (script, unit instance, config): enabled and ACTIVE before anything of the user runs
#   5 systemd drop-ins: user@<uid>.service (guard first; Delegate) and the user-<uid>.slice envelope
#   6 the user's docker.service and daemon.json, rendered from files/, enabled for default.target
#   7 bind sources: search-only (x) ACL for the daemon user on /etc/webdesk and its three public subdirectories
#   8 linger: the user manager, and with it the daemon, starts now and at every boot
#   9 verify (also what `check` runs)
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
CGROUP_ROOT="${WEBDESK_RL_CGROUP_ROOT:-/sys/fs/cgroup}"
SUB_UID_MAX_AUTO=600100000
# The api's bind sources (docker-compose.aicenter.yml). The directories get a search-only ACL; the files must
# then be readable, the secrets beside them must NOT be, and the directory must not be listable.
ETC_DIRS="/etc/webdesk /etc/webdesk/certs /etc/webdesk/editorial /etc/webdesk/ws4"
ETC_READ_OK="/etc/webdesk/certs/ca-cert.pem /etc/webdesk/editorial/editorial.jwks.json /etc/webdesk/ws4/ws4.jwks.json"
ETC_READ_NO="/etc/webdesk/.env /etc/webdesk/.env.control"
# Bind sources inside the project tree (the base compose file).
TREE_READ_OK="proxy/Caddyfile postgres/init-roles.sh"

say() { printf '%s\n' "$*"; }
die() { printf 'install-rootless: %s\n' "$*" >&2; exit 1; }

# --- pure helpers (test-rootless.sh drives these) -------------------------------------------------------------

is_uint() { case "${1:-}" in '' | *[!0-9]*) return 1 ;; esac; [ "${#1}" -le 10 ]; }
is_user() { [[ "${1:-}" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; }              # an account THIS script creates
is_account() { [[ "${1:-}" =~ ^[A-Za-z_][A-Za-z0-9_.-]{0,31}$ ]]; }    # an existing one (the operator is "Hansel")
is_abs_path() { [[ "${1:-}" =~ ^/[A-Za-z0-9._/-]*$ ]] && case "$1" in *..*) return 1 ;; esac; }

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
  # No `printf | grep -q` anywhere in these scripts: under pipefail an early grep exit can SIGPIPE the writer and
  # turn a match into a failure. Match on a here-string (or a file) instead.
  if grep -Eq '@[A-Z_]+@' <<<"$out"; then return 1; fi
  printf '%s\n' "$out"
}

# resolvers_of <resolv.conf>: the IPv4 nameservers, de-duplicated, space-separated.
resolvers_of() {
  awk '$1 == "nameserver" && $2 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && !seen[$2]++ { printf "%s%s", sep, $2; sep = " " }' "$1" 2>/dev/null
}

# version_ge <a> <b>: dotted numeric compare (a >= b)
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }

# cfg_get <file> <KEY>: the last KEY=value line, one pair of surrounding double quotes stripped. Parsed, never sourced.
cfg_get() {
  local v
  v="$(sed -n "s/^[[:space:]]*$2=//p" "$1" 2>/dev/null | tail -n 1 || true)"
  v="${v#\"}"
  printf '%s' "${v%\"}"
}

# --- options --------------------------------------------------------------------------------------------------

usage() { die "usage: $0 plan|apply|check|remove [--profile live|proof] [--user N] [--uid N] [--subid-start N] [--port N] [--operator N] [--cpu-quota P%] [--memory-max NG] [--tasks-max N] [--otlp-env PATH] [--tree DIR] [--etc-access] [--allow-restart]"; }

parse_args() {
  MODE="${1:-}"
  case "$MODE" in plan | apply | check | remove) shift ;; *) usage ;; esac
  PROFILE=live
  ALLOW_RESTART=0
  local etc_flag=""
  declare -gA OVR=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) [ $# -ge 2 ] || die "--profile needs a value"; PROFILE="$2"; shift 2 ;;
      --allow-restart) ALLOW_RESTART=1; shift ;;
      --etc-access) etc_flag=1; shift ;;
      --user | --uid | --subid-start | --port | --operator | --cpu-quota | --memory-max | --tasks-max | --otlp-env | --tree)
        [ $# -ge 2 ] || die "$1 needs a value"
        OVR["$1"]="$2"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  case "$PROFILE" in
    live) RL_USER=webdesk-rootless RL_UID=940 SUB_START=700000000 PORT=8380 CPU_QUOTA=100% MEMORY_MAX=5G TASKS_MAX=4096
      OTLP_ENV=/etc/webdesk/guard.env ROLE=live ETC_ACCESS=1 TREE=/home/Hansel/gaiada-webdesk/webdesk ;;
    proof) RL_USER=wdproof-rootless RL_UID=941 SUB_START=700065536 PORT=18380 CPU_QUOTA=50% MEMORY_MAX=4G TASKS_MAX=2048
      OTLP_ENV=/etc/default/wdproof-rootless-otlp ROLE=proof ETC_ACCESS=0 TREE="" ;;
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
  TREE="${OVR[--tree]:-$TREE}"
  [ -z "$etc_flag" ] || ETC_ACCESS=1
  is_user "$RL_USER" || die "bad daemon user name (lower case, [a-z_][a-z0-9_-]*)"
  is_account "$OPERATOR" || die "bad operator name"
  [ "$RL_USER" != "$OPERATOR" ] || die "the daemon user and the operator must differ"
  is_uint "$RL_UID" && is_uint "$SUB_START" && is_uint "$PORT" && is_uint "$TASKS_MAX" || die "uid, subid start, port and tasks-max must be numbers"
  [ "$RL_UID" -ge 100 ] && [ "$RL_UID" -lt 60000 ] || die "uid $RL_UID outside 100-59999"
  [ "$SUB_START" -ge 100000 ] || die "subid start $SUB_START is below 100000"
  [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || die "port must be 1024-65535 (unprivileged)"
  [[ "$CPU_QUOTA" =~ ^[1-9][0-9]{0,2}%$ ]] && [[ "$MEMORY_MAX" =~ ^[1-9][0-9]*[KMG]$ ]] || die "bad --cpu-quota or --memory-max"
  is_abs_path "$OTLP_ENV" || die "--otlp-env must be an absolute path"
  [ -z "$TREE" ] || is_abs_path "$TREE" || die "--tree must be an absolute path"
  # A proof must never share the live guard's switch: remove and the proof's own probes toggle it.
  if [ "$ROLE" = proof ]; then
    case "$OTLP_ENV" in /etc/webdesk/*) die "a proof install must not use a switch under /etc/webdesk (that is the live guard's)" ;; esac
  fi
  derive_paths
  CHANGED_DAEMON=0
  STARTED_NOW=0
  FAILS=0
  RESOLVERS=""
}

# derive_paths: everything that follows from RL_USER, RL_UID, SUB_START and SUB_COUNT (remove re-derives it once
# the uid has been read back from the passwd database).
derive_paths() {
  SUB_END=$((SUB_START + SUB_COUNT - 1))
  [ "$RL_UID" -lt "$SUB_START" ] || [ "$RL_UID" -gt "$SUB_END" ] || die "uid $RL_UID lies inside its own subordinate range"
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

# --- writes into the daemon user's tree (B1) -----------------------------------------------------------------
# The daemon user OWNS its home, so it can replace any directory in it with a symlink. Root must therefore never
# install, ln, chown or rm inside that tree: `install -D` follows a symlinked parent, and `ln ~/.config/systemd/user
# -> /etc/systemd/system` would turn the next apply into a root write of /etc/systemd/system/docker.service. Every
# such write runs AS the daemon user (what that user can reach it could always reach), with the content on stdin,
# and ALSO refuses a symlinked or foreign-owned path component (defence in depth, and what the tests can drive
# without root).
as_user() { runuser -u "$RL_USER" -- "$@"; }
# shellcheck disable=SC2016
USER_WRITE_SH='
set -eu
anchor=$1 dest=$2 kind=$3 arg=${4:-}
umask 077
refuse() { echo "user-write: refused: $*" >&2; exit 3; }
case "$anchor$dest" in *..*) refuse ".. in a path" ;; esac
case "$dest" in "$anchor"/*) ;; *) refuse "$dest is outside $anchor" ;; esac
me=$(id -u)
[ -d "$anchor" ] && [ ! -L "$anchor" ] || refuse "$anchor is not a plain directory"
[ "$(stat -c %u "$anchor")" = "$me" ] || refuse "$anchor is not owned by uid $me"
p=$anchor
rest=${dest%/*}
rest=${rest#"$anchor"}
set -f
IFS=/
for c in $rest; do
  [ -n "$c" ] || continue
  p=$p/$c
  [ ! -L "$p" ] || refuse "$p is a symlink"
  [ -e "$p" ] || mkdir "$p"
  [ -d "$p" ] || refuse "$p is not a directory"
  [ "$(stat -c %u "$p")" = "$me" ] || refuse "$p is not owned by uid $me"
done
unset IFS
case "$kind" in
  file)
    [ ! -L "$dest" ] && [ ! -d "$dest" ] || refuse "$dest is a symlink or a directory"
    t=$dest.wd-new.$$
    cat >"$t"
    chmod "$arg" "$t"
    mv -f "$t" "$dest" ;;
  link)
    [ -L "$dest" ] || [ ! -e "$dest" ] || refuse "$dest exists and is not a symlink"
    ln -sfn "$arg" "$dest" ;;
  dir)
    [ ! -L "$dest" ] || refuse "$dest is a symlink"
    [ -d "$dest" ] || mkdir "$dest"
    [ "$(stat -c %u "$dest")" = "$me" ] || refuse "$dest is not owned by uid $me"
    chmod "$arg" "$dest" ;;
  *) refuse "unknown kind $kind" ;;
esac
'
user_write() { as_user sh -c "$USER_WRITE_SH" user-write "$HOME_DIR" "$2" file "$3" <"$1"; }  # <src> <dest> <mode>
user_link() { as_user sh -c "$USER_WRITE_SH" user-write "$HOME_DIR" "$1" link "$2" </dev/null; } # <dest> <target>
user_dir() { as_user sh -c "$USER_WRITE_SH" user-write "$HOME_DIR" "$1" dir "$2" </dev/null; }  # <dest> <mode>

# put_user_file <rendered-src> <dest> <mode>: put_file for a path inside the daemon user's tree.
put_user_file() {
  local src=$1 dst=$2 mode=$3
  # shellcheck disable=SC2016
  if as_user sh -c 'f=$1; [ ! -L "$f" ] && [ -f "$f" ] && cmp -s - "$f" && [ "$(stat -c %a "$f")" = "$2" ]' user-cmp "$dst" "${mode#0}" <"$src" 2>/dev/null; then
    say "  OK    $dst (unchanged)"
    return 0
  fi
  CHANGED_DAEMON=1
  step "write $dst ($mode, written as $RL_USER)" user_write "$src" "$dst" "$mode"
}

# home_ok: the home is the plain directory root created for this user, not a symlink, owned by it.
home_ok() {
  [ -d "$HOME_DIR" ] && [ ! -L "$HOME_DIR" ] && [ "$(stat -c %U "$HOME_DIR")" = "$RL_USER" ] &&
    [ "$(getent passwd "$RL_USER" | cut -d: -f6)" = "$HOME_DIR" ]
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
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 1 ] || die "kernel.unprivileged_userns_clone is 0"
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
  local f hits
  for f in "$SUBUID_FILE" "$SUBGID_FILE"; do
    hits="$(subid_overlaps "$f" "$SUB_START" "$SUB_COUNT" "$RL_USER" "$RL_UID" || true)"
    [ -z "$hits" ] || die "range $SUB_START-$SUB_END overlaps $f: $(printf '%s' "$hits" | tr '\n' ' ')"
  done
  [ "$SUB_START" -gt "$SUB_UID_MAX_AUTO" ] || say "  NOTE  $SUB_START is inside useradd's automatic range; a future account could be offered it"
  if [ "$ETC_ACCESS" = 1 ]; then
    for f in $ETC_DIRS; do [ -d "$f" ] || die "--etc-access: $f is not a directory"; done
    for f in $ETC_READ_OK; do [ -f "$f" ] || die "--etc-access: $f is not a regular file (a leftover directory from a missing bind source?)"; done
  fi
  if [ -n "$TREE" ]; then
    for f in $TREE_READ_OK; do [ -f "$TREE/$f" ] || die "--tree: $TREE/$f is missing"; done
  fi
  local freekb
  freekb="$(df -Pk /var/lib | awk 'NR == 2 { print $4 }')"
  [ "${freekb:-0}" -ge 5242880 ] || die "less than 5 GiB free under /var/lib"
  RESOLVERS="$(resolvers_of /etc/resolv.conf)"
  [ -n "$RESOLVERS" ] || die "no IPv4 nameserver in /etc/resolv.conf"
  say "  OK    host checks; resolvers: $RESOLVERS"
}

# --- 2..8 apply -----------------------------------------------------------------------------------------------

do_packages() {
  say "== 2 packages"
  local p missing=""
  for p in uidmap slirp4netns dbus-user-session acl; do
    case "$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || true)" in *'ok installed'*) ;; *) missing="$missing $p" ;; esac
  done
  if [ -z "$missing" ]; then say "  OK    uidmap slirp4netns dbus-user-session acl installed"; return 0; fi
  step "apt-get update" env DEBIAN_FRONTEND=noninteractive apt-get update -q
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
  # RL_OTLP_CREATED=1 records that THIS install made the (empty) proof switch file, so remove may delete exactly that
  # file and nothing the operator pointed it at. Sticky: a re-apply sees the file it made and must keep the 1.
  local created=0
  if [ "$ROLE" = proof ] && { [ ! -e "$OTLP_ENV" ] || [ "$(cfg_get "$CONF_FILE" RL_OTLP_CREATED)" = 1 ]; }; then created=1; fi
  render_template "$FILES/webdesk-rootless.conf.in" USER="$RL_USER" ROLE="$ROLE" UID="$RL_UID" PORT="$PORT" \
    RESOLVERS="$RESOLVERS" OTLP_ENV="$OTLP_ENV" OPERATOR="$OPERATOR" OTLP_CREATED="$created" >"$t/conf" || die "cannot render the guard config"
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
  say "== 6 the daemon user's docker.service + daemon.json (all written AS $RL_USER)"
  if [ "$MODE" = apply ]; then home_ok || die "$HOME_DIR is not the plain home directory of $RL_USER (symlink, wrong owner or wrong passwd home)"; fi
  local t
  t="$(mktemp -d)"
  render_template "$FILES/docker.service.in" USER="$RL_USER" OPERATOR="$OPERATOR" >"$t/unit" || die "render docker.service"
  render_template "$FILES/daemon.json.in" DATA_ROOT="$DATA_ROOT" >"$t/json" || die "render daemon.json"
  put_user_file "$t/unit" "$UNIT_FILE" 0644
  put_user_file "$t/json" "$DAEMON_JSON" 0644
  rm -rf "$t"
  local link="$HOME_DIR/.config/systemd/user/default.target.wants/docker.service"
  if [ "$(as_user readlink "$link" 2>/dev/null)" = ../docker.service ]; then say "  OK    docker.service enabled for default.target"; else
    # The enablement symlink `systemctl --user enable` would make, made by the user itself.
    step "enable docker.service for default.target" user_link "$link" ../docker.service
  fi
  step "data root $DATA_ROOT (0700, as $RL_USER)" user_dir "$DATA_ROOT" 0700
}

acl_has_x() { grep -qx "user:$2:--x" <<<"$(getfacl -cp "$1" 2>/dev/null)"; } # exact entry, not masked

do_bind_access() {
  say "== 7 bind sources"
  if [ "$ETC_ACCESS" != 1 ]; then say "  SKIP  no /etc/webdesk access for this profile (--etc-access gives it)"; return 0; fi
  local d
  for d in $ETC_DIRS; do
    if acl_has_x "$d" "$RL_USER"; then say "  OK    $d: $RL_USER may search (x), nothing else"; else
      step "search-only ACL for $RL_USER on $d" setfacl -m "u:$RL_USER:--x" "$d"
    fi
  done
}

do_linger_and_daemon() {
  say "== 8 linger + the daemon"
  if [ -e "/var/lib/systemd/linger/$RL_USER" ]; then say "  OK    linger on"; else
    step "loginctl enable-linger $RL_USER (user manager now and at every boot)" loginctl enable-linger "$RL_USER"
    STARTED_NOW=1 # the manager starts the daemon with the files written above
  fi
  [ "$MODE" = apply ] || return 0
  local i
  for i in $(seq 1 60); do [ -S "$RUNTIME/bus" ] && break; sleep 1; done
  [ -S "$RUNTIME/bus" ] || die "the user manager of $RL_USER did not come up ($RUNTIME/bus missing)"
  user_systemctl daemon-reload
  if ! user_systemctl is-active --quiet docker.service; then
    step "start the rootless daemon" user_systemctl start docker.service
  elif [ "$CHANGED_DAEMON" = 1 ] && [ "$STARTED_NOW" != 1 ]; then
    if [ "$ROLE" = live ] && [ "$ALLOW_RESTART" != 1 ]; then
      say "  WARN  the daemon's config changed but the LIVE daemon was NOT restarted (that restarts WebDesk):"
      say "        re-run with --allow-restart inside a window"
    else
      step "restart the rootless daemon (config changed)" user_systemctl restart docker.service
    fi
  else
    say "  OK    rootless daemon active with the current config"
  fi
  for i in $(seq 1 60); do [ -S "$SOCK" ] && break; sleep 1; done
  [ -S "$SOCK" ] || die "no $SOCK after 60 s: journalctl _UID=$RL_UID -n 50"
}

# --- 9 verify (= check) ---------------------------------------------------------------------------------------

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
  ctl=" $(cat "$CGROUP_ROOT/user.slice/user-$RL_UID.slice/user@$RL_UID.service/cgroup.controllers" 2>/dev/null) "
  for c in cpu memory pids; do case "$ctl" in *" $c "*) ;; *) return 1 ;; esac; done
}
envelope_ok() { # the slice's own cgroup files carry the envelope
  local d="$CGROUP_ROOT/user.slice/user-$RL_UID.slice" want_cpu want_mem
  want_cpu="$((${CPU_QUOTA%\%} * 1000)) 100000"
  want_mem="$(numfmt --from=iec "$MEMORY_MAX")"
  [ "$(cat "$d/cpu.max")" = "$want_cpu" ] && [ "$(cat "$d/memory.max")" = "$want_mem" ] && [ "$(cat "$d/pids.max")" = "$TASKS_MAX" ]
}
# A missing cgroup controller shows as a `docker info` WARNING naming it; other warnings are not this check's.
no_warnings() {
  local w
  w="$(rl_docker info 2>&1 >/dev/null)"
  ! grep -Eiq 'WARNING:.*(cgroup|cpu|memory|pids|io\.|cpuset|swap)' <<<"$w"
}
only_operator() { # nobody but the owner and the operator can reach the socket
  [ $((8#$(stat -c %a "$SOCK") & 7)) = 0 ] && [ $((8#$(stat -c %a "$RUNTIME") & 7)) = 0 ] &&
    [ "$(getfacl -cp "$SOCK" 2>/dev/null | grep -E '^user:[^:]+:' | cut -d: -f2 | tr '\n' ' ')" = "$OPERATOR " ]
}
bridge_not_docker0() { # the rootless default bridge must not shadow the host's docker0 (172.17.0.1: the OTLP address)
  local s
  s="$(rl_docker network inspect bridge --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' 2>/dev/null)"
  [ -n "$s" ] && case " $s" in *" 172.17."*) return 1 ;; *) return 0 ;; esac
}
etc_access_ok() {
  local f
  for f in $ETC_READ_OK; do as_user test -r "$f" || return 1; done
  for f in $ETC_READ_NO; do ! as_user test -r "$f" || return 1; done
  ! as_user ls /etc/webdesk
}
tree_ok() {
  local f
  for f in $TREE_READ_OK; do as_user test -r "$TREE/$f" || return 1; done
}

verify() {
  say "== 9 verify ($PROFILE: $RL_USER)"
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
  chk "the rootless default bridge is not on 172.17.0.0/16 (it would shadow the host's docker0 OTLP address)" bridge_not_docker0
  rk="$(proc_cmdline "$RL_UID" rootlesskit || true)"
  sl="$(proc_cmdline "$RL_UID" slirp4netns || true)"
  chk "rootlesskit: slirp4netns, builtin port driver, host loopback disabled, sandbox + seccomp forced" \
    has_all "$rk" --net=slirp4netns --port-driver=builtin --disable-host-loopback --slirp4netns-sandbox=true --slirp4netns-seccomp=true
  chk "rootlesskit runs WITHOUT --detach-netns (dockerd and --net=host stay in RootlessKit's netns)" lacks "$rk" --detach-netns
  chk "slirp4netns: --enable-sandbox --enable-seccomp --disable-host-loopback" has_all "$sl" --enable-sandbox --enable-seccomp --disable-host-loopback
  chk "operator $OPERATOR reaches the socket as itself" runuser -u "$OPERATOR" -- docker -H "unix://$SOCK" version --format '{{.Server.Version}}'
  chk "no account but the owner and $OPERATOR can reach the socket" only_operator
  if [ "$ETC_ACCESS" = 1 ]; then
    chk "$RL_USER reads the three public bind sources, cannot read .env/.env.control, cannot list /etc/webdesk" etc_access_ok
  fi
  if [ -n "$TREE" ]; then chk "$RL_USER reads the project tree's bind sources under $TREE" tree_ok; fi
  if [ "$FAILS" = 0 ]; then say "VERIFY OK ($PROFILE: $RL_USER)"; else say "VERIFY FAILED: $FAILS check(s)"; fi
  [ "$FAILS" = 0 ]
}

# --- remove (proof only) --------------------------------------------------------------------------------------

# resolve_remove: the facts `remove` acts on come from the passwd database and the config THIS install wrote for
# that user, never from defaults or from flags that could be mistyped. Dies (touching nothing) on any mismatch.
# Sets RL_UID, SUB_START, SUB_COUNT, SUB_END (all re-derived) and OTLP_REMOVE ("" = delete no switch file).
resolve_remove() {
  local pw r ro rs rec created
  pw="$(getent passwd "$RL_USER" | cut -d: -f3 || true)"
  is_uint "$pw" || die "REFUSED: no account $RL_USER"
  [ "$pw" -ge 100 ] && [ "$pw" -lt 60000 ] || die "REFUSED: $RL_USER has uid $pw, outside 100-59999"
  if [ -n "${OVR[--uid]:-}" ] && [ "${OVR[--uid]}" != "$pw" ]; then
    die "REFUSED: --uid ${OVR[--uid]} but $RL_USER is uid $pw in the passwd database"
  fi
  [ -f "$CONF_FILE" ] && [ ! -L "$CONF_FILE" ] || die "REFUSED: $CONF_FILE is absent: this install did not write it, so it is not ours to remove"
  [ "$(cfg_get "$CONF_FILE" RL_UID)" = "$pw" ] || die "REFUSED: $CONF_FILE records RL_UID=$(cfg_get "$CONF_FILE" RL_UID), passwd says $pw"
  [ "$(cfg_get "$CONF_FILE" RL_ROLE)" = proof ] || die "REFUSED: remove is for a PROOF install only ($CONF_FILE says role '$(cfg_get "$CONF_FILE" RL_ROLE)')"
  RL_UID=$pw
  # The subordinate range is whatever the files hold for this user: exactly one entry, the same in both.
  r="$(awk -F: -v u="$RL_USER" 'NF == 3 && $1 == u && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { print $2, $3 }' "$SUBUID_FILE" 2>/dev/null)"
  [ -n "$r" ] && [ "$(printf '%s\n' "$r" | wc -l)" -eq 1 ] || die "REFUSED: $RL_USER needs exactly one entry in $SUBUID_FILE"
  read -r rs ro <<<"$r"
  has_subid_entry "$SUBGID_FILE" "$RL_USER" "$pw" "$rs" "$ro" || die "REFUSED: $SUBGID_FILE does not hold the same range as $SUBUID_FILE"
  if [ -n "${OVR[--subid-start]:-}" ] && [ "${OVR[--subid-start]}" != "$rs" ]; then
    die "REFUSED: --subid-start ${OVR[--subid-start]} but $RL_USER owns $rs in $SUBUID_FILE"
  fi
  SUB_START=$rs
  SUB_COUNT=$ro
  local conf=$CONF_FILE
  derive_paths
  CONF_FILE=$conf # the file just validated, not a re-derived path
  # The OTLP switch: only the file the install recorded as created by itself, never a path from the command line.
  OTLP_REMOVE=""
  rec="$(cfg_get "$CONF_FILE" RL_OTLP_ENV_FILE)"
  created="$(cfg_get "$CONF_FILE" RL_OTLP_CREATED)"
  if [ -n "${OVR[--otlp-env]:-}" ] && [ "${OVR[--otlp-env]}" != "$rec" ]; then
    die "REFUSED: --otlp-env ${OVR[--otlp-env]} differs from the switch recorded in $CONF_FILE ($rec)"
  fi
  if [ "$created" = 1 ]; then
    is_abs_path "$rec" || die "REFUSED: the recorded switch path '$rec' is not an absolute path"
    case "$rec" in /etc/webdesk/*) die "REFUSED: the recorded switch $rec is under /etc/webdesk (the live guard's)" ;; esac
    OTLP_REMOVE=$rec
  fi
}

do_remove() {
  [ "$(id -u)" = 0 ] || die "root only"
  [ "$ROLE" = proof ] || die "REFUSED: remove is for a PROOF install only (this is the $PROFILE profile)"
  resolve_remove
  say "== remove the proof install of $RL_USER (uid $RL_UID, subids $SUB_START-$SUB_END, read back from passwd and $CONF_FILE)"
  step "disable linger" loginctl disable-linger "$RL_USER"
  step "stop user@$RL_UID.service (daemon and containers)" systemctl stop "user@$RL_UID.service"
  local i d
  for i in $(seq 1 30); do
    ps -e -o uid= | awk -v u="$RL_UID" -v s="$SUB_START" -v e="$SUB_END" '$1 == u || ($1 >= s && $1 <= e) { f = 1 } END { exit f ? 0 : 1 }' || break
    sleep 1
  done
  step "stop + disable the guard (remove refuses while any process of the range runs)" systemctl disable --now "$GUARD_UNIT_INSTANCE"
  for d in $ETC_DIRS; do
    if grep -q "^user:$RL_USER:" <<<"$(getfacl -cp "$d" 2>/dev/null)"; then step "drop $RL_USER's ACL entry on $d" setfacl -x "u:$RL_USER" "$d"; fi
  done
  # Files, not trees: rm -f on the two drop-in files and the config, rmdir (never a recursive rm) on their directories.
  step "drop-in files and config" rm -f "$USER_AT_DROPIN" "$SLICE_DROPIN" "$CONF_FILE"
  step "drop-in directories (only if empty)" rmdir --ignore-fail-on-non-empty "$(dirname "$USER_AT_DROPIN")" "$(dirname "$SLICE_DROPIN")"
  if [ -n "$OTLP_REMOVE" ]; then step "the proof's OTLP switch (created by its install)" rm -f "$OTLP_REMOVE"; fi
  step "systemd daemon-reload" systemctl daemon-reload
  step "subuid/subgid $SUB_START-$SUB_END" usermod --del-subuids "$SUB_START-$SUB_END" --del-subgids "$SUB_START-$SUB_END" "$RL_USER"
  local mounts
  mounts="$(findmnt -rno TARGET)" || die "findmnt failed: not deleting the user"
  if grep -q "^$HOME_DIR" <<<"$mounts"; then die "mounts remain under $HOME_DIR: not deleting the user"; fi
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
      do_bind_access
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
