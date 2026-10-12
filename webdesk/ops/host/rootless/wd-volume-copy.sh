#!/usr/bin/env bash
# wd-volume-copy.sh - copy one named Docker volume between two daemons on this host, byte for byte, with every
# entry's numeric owner re-mapped by the DESTINATION daemon's user namespace, then prove it (M4 F6, WSK-D73).
# Plan: docs/plans/2026-10-12-webdesk-rootless-plan.md §5 (cut-over) and P2 (rehearsal).
#
#   sudo bash wd-volume-copy.sh copy   --from HOST --to HOST --volume NAME [--to-volume NAME] [--image REF] [--replace [--replace-rootful-rollback-copy]] [--keep DIR]
#   sudo bash wd-volume-copy.sh verify --from HOST --to HOST --volume NAME [--to-volume NAME] [--keep DIR]
#   HOST = rootful | unix:///run/user/<uid>/docker.sock
#
# HOW. GNU tar runs INSIDE a throwaway container on each side (--network none, --log-driver none, read-only
# rootfs, no capability beyond what tar needs), from the SAME image on both daemons:
#   source helper       tar -C /src --numeric-owner -cf - .             reads the volume as its containers see it
#   destination helper  tar -C /dst --numeric-owner --same-owner -xpf -  as container root: chowns to the same ids
# A rootless daemon's user namespace maps container uid 0 to the daemon user and uid N to <subuid start>+N-1 on
# the host, so the ownership remap is done by the kernel, in either direction, with no uid arithmetic in the copy.
# The arithmetic lives only in VERIFY: as root it reads both volumes' host paths and compares a manifest of every
# entry (path, type, mode, owner and group AS THE CONTAINERS SEE THEM, size, sha256) after mapping a rootless
# side's host ids back. Equal manifests = the same bytes, modes and in-container owners. The source is mounted
# read-only and never written: a rootful source stays intact as the rollback copy.
#
# REFUSES: a source volume that a RUNNING container uses (a copy of a live Postgres is not consistent); a missing
# destination volume (compose creates it, so its labels are right); a non-empty destination without --replace;
# a helper image that is not on both daemons;
# --replace of a destination that is the ROOTFUL daemon's volume (during a cut-over that volume is the ROLLBACK
# copy, and its containers are stopped, so a swapped --from/--to would empty it) or that ANY container, running or
# stopped, still references, unless --replace-rootful-rollback-copy says so explicitly;
# a source that holds extended attributes, POSIX ACLs or multiply-linked regular files: the copy does not carry
# them (tar runs without --xattrs/--acls; the manifest ignores them), so such a volume would not be a faithful copy.
# The scan runs in the helper image (GNU find -links, and GNU tar --xattrs --acls --format=pax whose extended headers
# carry SCHILY.xattr.* / SCHILY.acl.* records), so it needs the default Debian image or one with GNU tar and find.
# Today's data has none of these (plan section 2), so refusing is the safe, documented limit.
# --keep must be a NEW path (it is created 0700; an existing path is never chmod'ed or reused) in a directory
# that only root or the sudo caller owns and nobody else can write.
# --log-driver none matters: with the default json-file driver the source helper's stdout, the whole tar stream,
# would also be written to the daemon's container log.
# Root only: it reads both volumes' host paths for the manifest, and root may use the rootless daemon's socket.
set -euo pipefail

# Debian-based (GNU tar 1.34), already on both daemons by the cut-over: it is deploy-webdesk.sh's tools image.
# Pass a digest-pinned --image for the real run (the plan does).
DEFAULT_IMAGE="node:22-bookworm"

say() { printf '%s\n' "$*"; }
die() { printf 'wd-volume-copy: %s\n' "$*" >&2; exit 1; }

# --- pure helpers (test-rootless.sh drives these) -------------------------------------------------------------

valid_host() { [ "$1" = rootful ] || [[ "$1" =~ ^unix:///run/user/[1-9][0-9]{0,9}/docker\.sock$ ]]; }
valid_volume() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ ]]; }
valid_image() { [[ "$1" =~ ^[a-z0-9][a-z0-9._/:-]{0,200}(@sha256:[0-9a-f]{64})?$ ]]; }

# ns_id <host-id> <daemon-id> <first> <count>: the id a rootless daemon's containers see for a host id.
# "?<id>" marks an id the namespace cannot map (it would show as nobody inside, and never equals a real id).
ns_id() {
  if [ "$1" = "$2" ]; then printf '0\n'
  elif [ "$1" -ge "$3" ] && [ "$1" -lt $(($3 + $4)) ]; then printf '%s\n' $(($1 - $3 + 1))
  else printf '?%s\n' "$1"; fi
}

# map_manifest <uid> <gid> <ufirst> <ucount> <gfirst> <gcount>: stdin manifest (host ids) -> stdout (namespace ids)
map_manifest() {
  local du=$1 dg=$2 us=$3 uc=$4 gs=$5 gc=$6 path rest t m u g s sum mt
  while IFS=$'\t' read -r path rest; do
    read -r t m u g s sum mt <<<"$rest"
    printf '%s\t%s %s %s %s %s %s %s\n' "$path" "$t" "$m" "$(ns_id "$u" "$du" "$us" "$uc")" "$(ns_id "$g" "$dg" "$gs" "$gc")" "$s" "$sum" "$mt"
  done
}

# has_unmapped <mapped-manifest>...: true if any entry's owner column holds "?<id>". It reads the files itself:
# `cut | grep -q` on a manifest larger than a pipe buffer could SIGPIPE cut, and under pipefail a match would then
# read as "nothing unmapped".
has_unmapped() { awk -F'\t' '$2 ~ /\?/ { f = 1 } END { exit f ? 0 : 1 }' "$@"; }

# manifest <dir>: one line per entry, LC_ALL=C sorted:
#   <%q path> TAB <type> <mode> <uid> <gid> <size|-> <sha256|-> <mtime|->
# Directory sizes are filesystem history, not content: "-". A symlink's "sha" is the sha256 of its target.
# mtime is whole seconds (GNU tar's default format stores no more) for files and directories; a symlink's is "-".
# Hard links, xattrs and ACLs are NOT in the manifest: the copy refuses a source that has any (scan_source).
manifest() {
  local dir=$1 rec t m u g s p sum mt
  (cd "$dir" && find . -xdev -printf '%y %m %U %G %s %T@ %p\0') | while IFS= read -r -d '' rec; do
    t=${rec%% *}; rec=${rec#* }
    m=${rec%% *}; rec=${rec#* }
    u=${rec%% *}; rec=${rec#* }
    g=${rec%% *}; rec=${rec#* }
    s=${rec%% *}; rec=${rec#* }
    mt=${rec%% *}; p=${rec#* }
    mt=${mt%%.*}
    case "$t" in
      f) sum="$(sha256sum <"$dir/$p" | cut -d' ' -f1)" ;;
      l) sum="$(readlink -- "$dir/$p" | sha256sum | cut -d' ' -f1)"; mt=- ;;
      d) s=-; sum=- ;;
      *) sum=-; mt=- ;;
    esac
    printf '%q\t%s %s %s %s %s %s %s\n' "$p" "$t" "$m" "$u" "$g" "$s" "$sum" "$mt"
  done | LC_ALL=C sort
}

# count_xattr_records: stdin = a pax tar stream; prints how many SCHILY.xattr.* / SCHILY.acl.* extended-header
# records it holds. awk reads to the end on purpose (no early exit that could SIGPIPE tar under pipefail), and
# always exits 0, so a tar failure is the pipeline's, not this function's.
count_xattr_records() { LC_ALL=C awk '/[0-9]+ SCHILY\.(xattr|acl)\./ { n++ } END { print n + 0 }'; }

# scan_verdict <xattr-records> <multiply-linked-files> <first-linked-paths>: the refusal message, or nothing.
scan_verdict() {
  local x=$1 l=$2 paths=${3:-}
  [[ "$x" =~ ^[0-9]+$ ]] && [[ "$l" =~ ^[0-9]+$ ]] || { echo "the source scan gave no usable answer (xattr records '$x', linked files '$l')"; return 0; }
  if [ "$x" != 0 ]; then
    echo "the source holds extended attributes or POSIX ACLs ($x records): this copy does not carry them. Refusing rather than make an unfaithful copy"
    return 0
  fi
  if [ "$l" != 0 ]; then
    echo "the source holds $l multiply-linked regular file(s) (first: $paths): the copy would split the links. Refusing rather than make an unfaithful copy"
  fi
}

# subid_of <file> <user> <uid> -> "start count": exactly one entry, or fail.
subid_of() {
  local lines
  lines="$(awk -F: -v u="$2" -v id="$3" '($1 == u || $1 == id) && NF == 3 && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ { print $2, $3 }' "$1" 2>/dev/null)"
  [ -n "$lines" ] && [ "$(printf '%s\n' "$lines" | wc -l)" -eq 1 ] || return 1
  printf '%s\n' "$lines"
}

FROM="" TO="" VOL="" TOVOL="" IMAGE="$DEFAULT_IMAGE" REPLACE=0 REPLACE_RB=0 KEEP=""

parse_args() { # pure: sets FROM TO VOL TOVOL IMAGE REPLACE REPLACE_RB KEEP, dies on anything malformed
  while [ $# -gt 0 ]; do
    case "$1" in
      --from | --to | --volume | --to-volume | --image | --keep)
        [ $# -ge 2 ] || die "$1 needs a value"
        case "$1" in
          --from) FROM="$2" ;; --to) TO="$2" ;; --volume) VOL="$2" ;; --to-volume) TOVOL="$2" ;;
          --image) IMAGE="$2" ;; --keep) KEEP="$2" ;;
        esac
        shift 2 ;;
      --replace) REPLACE=1; shift ;;
      --replace-rootful-rollback-copy) REPLACE_RB=1; shift ;;
      *) die "unknown option $1" ;;
    esac
  done
  TOVOL="${TOVOL:-$VOL}"
  valid_host "$FROM" && valid_host "$TO" || die "--from/--to must be rootful or unix:///run/user/<uid>/docker.sock"
  [ "$FROM" != "$TO" ] || die "--from and --to are the same daemon"
  [ "$REPLACE_RB" = 0 ] || [ "$REPLACE" = 1 ] || die "--replace-rootful-rollback-copy only makes sense together with --replace"
  valid_volume "$VOL" && valid_volume "$TOVOL" || die "bad volume name"
  valid_image "$IMAGE" || die "bad --image reference"
  [ -z "$KEEP" ] || [[ "$KEEP" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--keep must be an absolute path"
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
  local uid user gid u g
  uid="${1#unix:///run/user/}"; uid="${uid%%/*}"
  user="$(getent passwd "$uid" | cut -d: -f1 || true)"
  gid="$(getent passwd "$uid" | cut -d: -f4 || true)"
  [ -n "$user" ] && [ -n "$gid" ] || die "no account owns uid $uid"
  u="$(subid_of /etc/subuid "$user" "$uid")" || die "$user needs exactly one /etc/subuid entry"
  g="$(subid_of /etc/subgid "$user" "$uid")" || die "$user needs exactly one /etc/subgid entry"
  printf '%s %s %s %s\n' "$uid" "$gid" "$u" "$g"
}

helper() { # helper <HOST> <docker run args...> -- common hardening for both sides
  local h=$1
  shift
  dk "$h" run --rm --network none --log-driver none --read-only --user 0:0 --cpus 0.5 --memory 256m --pids-limit 64 \
    --security-opt no-new-privileges:true --cap-drop ALL "$@"
}

not_in_use() { # not_in_use <HOST> <volume>
  local ids
  dk "$1" volume inspect "$2" >/dev/null 2>&1 || die "volume $2 does not exist on $1"
  ids="$(dk "$1" ps -q --filter "volume=$2")"
  [ -z "$ids" ] || die "volume $2 on $1 is used by a RUNNING container ($ids): stop it first"
}

# refs_count <HOST> <volume>: how many containers, RUNNING OR STOPPED, reference the volume.
refs_count() { local ids; ids="$(dk "$1" ps -aq --filter "volume=$2")" || return 1; [ -z "$ids" ] && echo 0 || grep -c . <<<"$ids"; }

# replace_refusal <to-host> <referencing-containers> <explicit-flag 0|1>: why --replace must be refused, or nothing.
# not_in_use only sees RUNNING containers; during a cut-over the rootful stack is stopped, so "nobody is using it"
# is not evidence that a volume may be emptied.
replace_refusal() {
  local to=$1 refs=$2 flag=$3
  [ "$flag" != 1 ] || return 0
  if [ "$to" = rootful ]; then
    echo "the destination is the ROOTFUL daemon's volume: during a cut-over that is the ROLLBACK copy (are --from and --to swapped?). If you really mean to overwrite it, add --replace-rootful-rollback-copy"
    return 0
  fi
  if [ "$refs" != 0 ]; then
    echo "$refs container(s) (running or stopped) still reference the destination volume: it is in use by a stack, not an empty shell. If you really mean to overwrite it, add --replace-rootful-rollback-copy"
  fi
}

# scan_source: refuse a source the copy cannot reproduce faithfully (xattrs, POSIX ACLs, hard links).
scan_source() {
  local x l paths why
  x="$(helper "$FROM" --cap-add DAC_READ_SEARCH -v "$VOL:/src:ro" --entrypoint tar "$IMAGE" -C /src --xattrs --acls --format=pax -cf - . | count_xattr_records)" ||
    die "the xattr/ACL scan of $VOL on $FROM failed (is GNU tar in $IMAGE?)"
  paths="$(helper "$FROM" --cap-add DAC_READ_SEARCH -v "$VOL:/src:ro" --entrypoint find "$IMAGE" /src -xdev -type f -links +1 -printf '%p\n')" ||
    die "the hard-link scan of $VOL on $FROM failed (is GNU find in $IMAGE?)"
  l="$([ -z "$paths" ] && echo 0 || grep -c . <<<"$paths")"
  why="$(scan_verdict "$x" "$l" "$(head -n 3 <<<"$paths" | tr '\n' ' ')")"
  [ -z "$why" ] || die "$why"
  say "source scan: no extended attributes, no POSIX ACLs, no multiply-linked files (GNU tar --xattrs --acls --format=pax, GNU find -links, run in $IMAGE)"
}

# prepare_work_dir: prints the directory verify writes its manifests to. --keep must be NEW: an existing path is
# refused (install -d would chmod it), and its parent must be writable by nobody but the invoking user.
prepare_work_dir() {
  local parent m owner
  if [ -z "$KEEP" ]; then mktemp -d; return; fi
  if [ -e "$KEEP" ] || [ -L "$KEEP" ]; then die "--keep $KEEP already exists: it must be a new path (nothing existing is reused or chmod'ed)"; fi
  parent="$(dirname "$KEEP")"
  [ -d "$parent" ] && [ ! -L "$parent" ] || die "--keep: $parent is not a plain directory"
  owner="$(stat -c %u "$parent")"
  [ "$owner" = "$(id -u)" ] || [ "$owner" = "${SUDO_UID:-x}" ] || die "--keep: $parent is owned by uid $owner, neither root nor the sudo caller"
  m="$(stat -c %a "$parent")"
  [ $((8#$m & 022)) = 0 ] || die "--keep: $parent is group- or other-writable (mode $m)"
  mkdir -m 0700 -- "$KEEP"
  printf '%s\n' "$KEEP"
}

# --- commands -------------------------------------------------------------------------------------------------

cmd_copy() {
  local h root_attr ru rg rm entries
  for h in "$FROM" "$TO"; do
    dk "$h" image inspect "$IMAGE" >/dev/null 2>&1 || die "helper image $IMAGE is not on $h (stage it first)"
    say "helper image on $h: $(dk "$h" image inspect --format '{{.Id}}' "$IMAGE")"
  done
  not_in_use "$FROM" "$VOL"
  not_in_use "$TO" "$TOVOL"
  scan_source
  # Fail closed: an unreadable destination must never read as an empty one (find's own status decides).
  entries="$(helper "$TO" --cap-add DAC_READ_SEARCH -v "$TOVOL:/dst:ro" --entrypoint sh "$IMAGE" -c \
    'n="$(find /dst -mindepth 1 -maxdepth 1 -printf x)" || exit 1; printf "%s" "${#n}"')" || die "cannot list the destination $TOVOL on $TO"
  [[ "$entries" =~ ^[0-9]+$ ]] || die "cannot list the destination $TOVOL on $TO ($entries)"
  if [ "$entries" != 0 ]; then
    [ "$REPLACE" = 1 ] || die "destination $TOVOL on $TO is not empty ($entries entries): pass --replace to overwrite it"
    local refs why
    refs="$(refs_count "$TO" "$TOVOL")" || die "cannot count the containers that reference $TOVOL on $TO"
    why="$(replace_refusal "$TO" "$refs" "$REPLACE_RB")"
    [ -z "$why" ] || die "REFUSED --replace of $TOVOL on $TO: $why"
    say "emptying $TOVOL on $TO (--replace)"
    helper "$TO" --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$TOVOL:/dst" --entrypoint sh "$IMAGE" -c 'find /dst -mindepth 1 -delete'
  fi
  root_attr="$(helper "$FROM" --cap-add DAC_READ_SEARCH -v "$VOL:/src:ro" --entrypoint stat "$IMAGE" -c '%u %g %a' /src)"
  [[ "$root_attr" =~ ^[0-9]+\ [0-9]+\ [0-7]{3,4}$ ]] || die "cannot read the source root's owner/mode ($root_attr)"
  read -r ru rg rm <<<"$root_attr"
  say "copying $VOL ($FROM) -> $TOVOL ($TO); volume root as seen inside: owner $ru:$rg mode $rm"
  helper "$FROM" --cap-add DAC_READ_SEARCH -v "$VOL:/src:ro" --entrypoint tar "$IMAGE" -C /src --numeric-owner -cf - . |
    helper "$TO" -i --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$TOVOL:/dst" --entrypoint sh "$IMAGE" -c \
      "umask 000 && tar -C /dst --numeric-owner --same-owner -xpf - && chown $ru:$rg /dst && chmod $rm /dst"
  say "copied; verifying"
  cmd_verify
}

cmd_verify() {
  local w m1 m2 ids n bytes
  w="$(prepare_work_dir)" || exit 1
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
  if has_unmapped "$w/$VOL.from" "$w/$TOVOL.to"; then
    die "an entry's owner is outside a namespace's mapping (shown as ?<id>; manifests in $w)"
  fi
  n="$(wc -l <"$w/$VOL.from")"
  bytes="$(awk -F'\t' '{ split($2, a, " "); if (a[1] == "f") s += a[5] } END { print s + 0 }' "$w/$VOL.from")"
  if diff -u "$w/$VOL.from" "$w/$TOVOL.to" >"$w/$VOL.diff"; then
    say "VERIFIED $VOL -> $TOVOL: $n entries, $bytes bytes in files; content, modes and in-container owners identical (manifests in $w)"
  else
    head -n 40 "$w/$VOL.diff" >&2
    die "MISMATCH $VOL -> $TOVOL: $(grep -c '^[-+][^-+]' "$w/$VOL.diff" || true) differing lines (full diff: $w/$VOL.diff)"
  fi
}

usage() { die "usage: $0 copy|verify --from HOST --to HOST --volume NAME [--to-volume NAME] [--image REF] [--replace [--replace-rootful-rollback-copy]] [--keep DIR]"; }

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in copy | verify) ;; *) usage ;; esac
  parse_args "$@"
  [ "$(id -u)" = 0 ] || die "root only"
  case "$cmd" in
    copy) cmd_copy ;;
    verify) cmd_verify ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
