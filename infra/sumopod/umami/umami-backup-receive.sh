#!/bin/sh
# Forced-command receiver for the Umami backup PUSH key. Install on gda-aicenter as ~/bin/umami-backup-receive.sh
# and bind the key in ~/.ssh/authorized_keys (one line):
#   restrict,from="10.88.0.2",command="/home/Hansel/bin/umami-backup-receive.sh" ssh-ed25519 AAAA... umami-push@sumopod
#
# Shape (same philosophy as erp-backup-read.sh, mirrored): sumopod holds a key to aicenter that can ONLY
# append new, hash-verified, size-capped files into one directory. It cannot read, list, overwrite or delete.
# aicenter holds no key to sumopod. Retention/pruning runs on aicenter (cron, see the runbook).
set -eu
set -f
DIR="$HOME/umami-backups"
MAX_BYTES=$((300 * 1024 * 1024))
MIN_FREE_KB=$((10 * 1024 * 1024))

# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
if [ "${1:-}" != put ] || [ "$#" -ne 3 ]; then echo "refused: only 'put <name> <sha256>'" >&2; exit 1; fi
NAME="$2"; SUM="$3"
case "$NAME" in
  umami-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].sql.gz.age | vdb-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].sql.gz.age) ;;
  *) echo "refused: bad name" >&2; exit 2 ;;
esac
case "$SUM" in *[!0-9a-f]* | "") echo "refused: bad sha256" >&2; exit 2 ;; esac
if [ "${#SUM}" -ne 64 ]; then echo "refused: bad sha256" >&2; exit 2; fi

mkdir -p "$DIR"; chmod 700 "$DIR"
if [ -e "$DIR/$NAME" ]; then echo "refused: exists (no overwrite)" >&2; exit 3; fi
FREE_KB="$(df -Pk "$DIR" | awk 'NR==2 {print $4}')"
if [ "$FREE_KB" -le "$MIN_FREE_KB" ]; then echo "refused: low disk" >&2; exit 4; fi

TMP="$(mktemp "$DIR/.incoming.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
head -c "$((MAX_BYTES + 1))" > "$TMP"
SIZE="$(wc -c < "$TMP" | tr -d ' ')"
if [ "$SIZE" -le 0 ] || [ "$SIZE" -gt "$MAX_BYTES" ]; then echo "refused: size $SIZE" >&2; exit 5; fi
if [ "$(sha256sum "$TMP" | cut -d' ' -f1)" != "$SUM" ]; then echo "refused: sha256 mismatch" >&2; exit 6; fi
ln "$TMP" "$DIR/$NAME"   # hard link = no-clobber publish
echo "stored $NAME $SIZE"
