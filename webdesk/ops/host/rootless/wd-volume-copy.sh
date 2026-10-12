#!/usr/bin/env bash
# wd-volume-copy.sh - copy one named Docker volume between two daemons on this host, byte for byte, with every
# entry's numeric owner re-mapped by the DESTINATION daemon's user namespace, then prove it (M4 F6, WSK-D73).
# Plan: docs/plans/2026-10-12-webdesk-rootless-plan.md §2.5.
#
#   sudo bash wd-volume-copy.sh copy   --from HOST --to HOST --volume NAME [--to-volume NAME] [--image REF] [--replace] [--keep DIR]
#   sudo bash wd-volume-copy.sh verify --from HOST --to HOST --volume NAME [--to-volume NAME] [--keep DIR]
#   HOST = rootful | unix:///run/user/<uid>/docker.sock
#
# HOW. tar runs INSIDE a throwaway container on each side (--network none, --log-driver none, read-only rootfs,
# no capability beyond what tar needs):
#   source helper       tar -C /src --numeric-owner -cf - .      reads the volume as its containers see it
#   destination helper  tar -C /dst --numeric-owner -xpf -        as container root: chowns to those same ids
# A rootless daemon's user namespace maps container uid 0 to the daemon user and uid N to <subuid start>+N-1 on
# the host, so the ownership remap is done by the kernel, in either direction, with no uid arithmetic in the copy.
# The arithmetic lives only in VERIFY: as root it reads both volumes' host paths and compares a manifest of every
# entry (path, type, mode, owner and group AS THE CONTAINERS SEE THEM, size, sha256) after mapping a rootless
# side's host ids back. Equal manifests = the same bytes, modes and in-container owners.
#
# REFUSES: a source volume that a RUNNING container uses (a copy of a live Postgres is not consistent); a missing
# destination volume (compose creates it, so its labels are right); a non-empty destination without --replace.
# --log-driver none matters: with the default json-file driver the source helper's stdout, the whole tar stream,
# would also be written to the daemon's container log.
# Root only: it reads both volumes' host paths for the manifest, and root may use the rootless daemon's socket.
set -euo pipefail

DEFAULT_IMAGE="postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"

say() { printf '%s\n' "$*"; }
die() { printf 'wd-volume-copy: %s\n' "$*" >&2; exit 1; }

# --- pure helpers (test-rootless.sh drives these) -------------------------------------------------------------

valid_host() { [ "$1" = rootful ] || [[ "$1" =~ ^unix:///run/user/[0-9]+/docker\.sock$ ]]; }
valid_volume() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }

# ns_id <host-id> <daemon-id> <first> <count>: the id a rootless daemon's containers see for a host id.
# "?<id>" marks an id the namespace cannot map (it would show as nobody inside, and never equals a real id).
ns_id() {
  if [ "$1" = "$2" ]; then printf '0\n'
  elif [ "$1" -ge "$3" ] && [ "$1" -lt $(($3 + $4)) ]; then printf '%s\n' $(($1 - $3 + 1))
  else printf '?%s\n' "$1"; fi
}

# map_manifest <uid> <gid> <ufirst> <ucount> <gfirst> <gcount>: stdin manifest (host ids) -> stdout (namespace ids)
map_manifest() {
  local du=$1 dg=$2 us=$3 uc=$4 gs=$5 gc=$6 path rest t m u g s sum
  while IFS=$'\t' read -r path rest; do
    read -r t m u g s sum <<<"$rest"
    printf '%s\t%s %s %s %s %s %s\n' "$path" "$t" "$m" "$(ns_id "$u" "$du" "$us" "$uc")" "$(ns_id "$g" "$dg" "$gs" "$gc")" "$s" "$sum"
  done
}

# manifest <dir>: one line per entry, LC_ALL=C sorted: <%q path> TAB <type> <mode> <uid> <gid> <size|-> <sha256|->
# Directory sizes are filesystem history, not content: "-". A symlink's "sha" is the sha256 of its target.
manifest() {
  local dir=$1 rec t m u g s p sum
  (cd "$dir" && find . -xdev -printf '%y %m %U %G %s %p\0') | while IFS= read -r -d '' rec; do
    t=${rec%% *}; rec=${rec#* }
    m=${rec%% *}; rec=${rec#* }
    u=${rec%% *}; rec=${rec#* }
    g=${rec%% *}; rec=${rec#* }
    s=${rec%% *}; p=${rec#* }
    case "$t" in
      f) sum="$(sha256sum <"$dir/$p" | cut -d' ' -f1)" ;;
      l) sum="$(readlink -- "$dir/$p" | sha256sum | cut -d' ' -f1)" ;;
      d) s=-; sum=- ;;
      *) sum=- ;;
    esac
    printf '%q\t%s %s %s %s %s %s\n' "$p" "$t" "$m" "$u" "$g" "$s" "$sum"
  done | LC_ALL=C sort
}

# --- daemons --------------------------------------------------------------------------------------------------

dk() { # dk <HOST> docker-args...
  local h=$1
  shift
  if [ "$h" = rootful ]; then env -u DOCKER_HOST docker "$@"; else docker -H "$h" "$@"; fi
}

# rl_ids <HOST>: "<uid> <gid> <ufirst> <ucount> <gfirst> <gcount>" for a rootless daemon; nothing for rootful.
rl_ids() {
  [ "$1" = rootful ] && return 0
  local uid user gid us uc gs gc
  uid="${1#unix:///run/user/}"; uid="${uid%%/*}"
  user="$(getent passwd "$uid" | cut -d: -f1 || true)"
  gid="$(getent passwd "$uid" | cut -d: -f4 || true)"
  [ -n "$user" ] && [ -n "$gid" ] || die "no account owns uid $uid"
  read -r us uc < <(awk -F: -v u="$user" -v id="$uid" '($1 == u || $1 == id) && NF == 3 { print $2, $3 }' /etc/subuid)
  read -r gs gc < <(awk -F: -v u="$user" -v id="$uid" '($1 == u || $1 == id) && NF == 3 { print $2, $3 }' /etc/subgid)
  [ -n "${us:-}" ] && [ -n "${gs:-}" ] || die "$user has no /etc/subuid or /etc/subgid entry"
  printf '%s %s %s %s %s %s\n' "$uid" "$gid" "$us" "$uc" "$gs" "$gc"
}

helper() { # helper <HOST> <docker run args...> -- common hardening for both sides
  local h=$1
  shift
  dk "$h" run --rm --network none --log-driver none --read-only --user 0:0 --cpus 0.5 --memory 256m --pids-limit 64 \
    --security-opt no-new-privileges:true --cap-drop ALL "$@"
}

# --- commands -------------------------------------------------------------------------------------------------

FROM="" TO="" VOL="" TOVOL="" IMAGE="$DEFAULT_IMAGE" REPLACE=0 KEEP=""

parse() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --from) FROM="${2:-}"; shift 2 ;;
      --to) TO="${2:-}"; shift 2 ;;
      --volume) VOL="${2:-}"; shift 2 ;;
      --to-volume) TOVOL="${2:-}"; shift 2 ;;
      --image) IMAGE="${2:-}"; shift 2 ;;
      --replace) REPLACE=1; shift ;;
      --keep) KEEP="${2:-}"; shift 2 ;;
      *) die "unknown option $1" ;;
    esac
  done
  TOVOL="${TOVOL:-$VOL}"
  valid_host "$FROM" && valid_host "$TO" || die "--from/--to must be rootful or unix:///run/user/<uid>/docker.sock"
  [ "$FROM" != "$TO" ] || die "--from and --to are the same daemon"
  valid_volume "$VOL" && valid_volume "$TOVOL" || die "bad volume name"
  [ "$(id -u)" = 0 ] || die "root only"
}

not_in_use() { # not_in_use <HOST> <volume>
  local ids
  dk "$1" volume inspect "$2" >/dev/null 2>&1 || die "volume $2 does not exist on $1"
  ids="$(dk "$1" ps -q --filter "volume=$2")"
  [ -z "$ids" ] || die "volume $2 on $1 is used by a RUNNING container ($ids): stop it first"
}

cmd_copy() {
  local h root_attr first
  for h in "$FROM" "$TO"; do dk "$h" image inspect "$IMAGE" >/dev/null 2>&1 || die "helper image $IMAGE is not on $h (stage it first)"; done
  not_in_use "$FROM" "$VOL"
  not_in_use "$TO" "$TOVOL"
  first="$(helper "$TO" -v "$TOVOL:/dst" --entrypoint sh "$IMAGE" -c 'find /dst -mindepth 1 -maxdepth 1 | head -n 1')"
  if [ -n "$first" ]; then
    [ "$REPLACE" = 1 ] || die "destination $TOVOL on $TO is not empty (found $first): pass --replace to overwrite it"
    say "emptying $TOVOL on $TO (--replace)"
    helper "$TO" --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$TOVOL:/dst" --entrypoint sh "$IMAGE" -c 'find /dst -mindepth 1 -delete'
  fi
  root_attr="$(helper "$FROM" --cap-add DAC_OVERRIDE -v "$VOL:/src:ro" --entrypoint sh "$IMAGE" -c 'stat -c "%u %g %a" /src')"
  [[ "$root_attr" =~ ^[0-9]+\ [0-9]+\ [0-7]{3,4}$ ]] || die "cannot read the source root's owner/mode ($root_attr)"
  say "copying $VOL ($FROM) -> $TOVOL ($TO); volume root as seen inside: owner ${root_attr% *} mode ${root_attr##* }"
  helper "$FROM" --cap-add DAC_OVERRIDE -v "$VOL:/src:ro" --entrypoint tar "$IMAGE" -C /src --numeric-owner -cf - . |
    helper "$TO" -i --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$TOVOL:/dst" --entrypoint sh "$IMAGE" -c \
      "umask 000 && tar -C /dst --numeric-owner -xpf - && chown ${root_attr% *} /dst && chown :${root_attr#* } /dst 2>/dev/null; chown $(printf '%s' "$root_attr" | awk '{print $1":"$2}') /dst && chmod ${root_attr##* } /dst"
  say "copied; verifying"
  cmd_verify
}

cmd_verify() {
  local w m1 m2 ids n bytes
  w="${KEEP:-$(mktemp -d)}"
  install -d -m 0700 "$w"
  m1="$(dk "$FROM" volume inspect -f '{{.Mountpoint}}' "$VOL")"
  m2="$(dk "$TO" volume inspect -f '{{.Mountpoint}}' "$TOVOL")"
  [ -d "$m1" ] && [ -d "$m2" ] || die "cannot see the host paths of $VOL ($m1) or $TOVOL ($m2)"
  manifest "$m1" >"$w/$VOL.from.host"
  manifest "$m2" >"$w/$TOVOL.to.host"
  ids="$(rl_ids "$FROM")"
  # shellcheck disable=SC2086
  if [ -n "$ids" ]; then map_manifest $ids <"$w/$VOL.from.host" >"$w/$VOL.from"; else cp "$w/$VOL.from.host" "$w/$VOL.from"; fi
  ids="$(rl_ids "$TO")"
  # shellcheck disable=SC2086
  if [ -n "$ids" ]; then map_manifest $ids <"$w/$TOVOL.to.host" >"$w/$TOVOL.to"; else cp "$w/$TOVOL.to.host" "$w/$TOVOL.to"; fi
  n="$(wc -l <"$w/$VOL.from")"
  bytes="$(awk -F'\t' '{ split($2, a, " "); if (a[1] == "f") s += a[5] } END { print s + 0 }' "$w/$VOL.from")"
  if diff -u "$w/$VOL.from" "$w/$TOVOL.to" >"$w/$VOL.diff"; then
    say "VERIFIED $VOL -> $TOVOL: $n entries, $bytes bytes in files; content, modes and in-container owners identical (manifests in $w)"
  else
    head -n 40 "$w/$VOL.diff" >&2
    die "MISMATCH $VOL -> $TOVOL: $(grep -c '^[-+][^-+]' "$w/$VOL.diff" || true) differing lines (full diff: $w/$VOL.diff)"
  fi
  if grep -q '?' <(cut -f2 "$w/$TOVOL.to") 2>/dev/null; then die "an entry's owner is outside the namespace's mapping (shown as ?<id>)"; fi
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    copy) parse "$@"; cmd_copy ;;
    verify) parse "$@"; cmd_verify ;;
    *) die "usage: $0 copy|verify --from HOST --to HOST --volume NAME [--to-volume NAME] [--image REF] [--replace] [--keep DIR]" ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
