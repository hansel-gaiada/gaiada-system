#!/bin/sh
# Forced-command wrapper for the sumopod offsite-backup PULL key.
#
# WHY A FORCED COMMAND AND NOT A PLAIN authorized_keys ENTRY:
# The offsite copy exists to survive a compromise of THIS box. That only holds if the
# relationship is pull-only and one-directional:
#   * sumopod holds a key to aicenter  -> restricted to the three verbs below, read-only.
#   * aicenter holds NO key to sumopod -> a compromised aicenter cannot reach, alter or
#     delete its own offsite backups. This is the entire point; do not "simplify" it into
#     a push from this side.
# So the worst a fully-compromised sumopod can do with this key is read backup files it
# already has copies of. It cannot write, delete, list outside DIR, or open a shell.
set -eu
set -f                      # no globbing when we word-split SSH_ORIGINAL_COMMAND below

DIR="$HOME/gaiada-backups"

# Word-split deliberately: SSH_ORIGINAL_COMMAND arrives as one string ("cat foo.sql.gz").
# set -f above makes this safe against a filename crafted to glob.
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}

# Every path we accept is validated against this: a bare filename, no directory
# separators, no leading dot. Rejecting rather than sanitising, so a traversal attempt is
# an audit line instead of a silently-rewritten read.
safe_name() {
  case "$1" in
    "" | .* | */* | *[!A-Za-z0-9_.-]*) return 1 ;;
  esac
  return 0
}

case "${1:-}" in
  list)
    # Names + sizes + mtime, so the puller can decide what is new without reading anything.
    find "$DIR" -maxdepth 1 -type f \( -name '*.sql.gz' -o -name '*.tar.gz' \) \
      -printf '%f\t%s\t%T@\n' 2>/dev/null | sort
    ;;
  sha256)
    f="${2:-}"
    safe_name "$f" || { echo "refused: bad name" >&2; exit 2; }
    [ -f "$DIR/$f" ] || { echo "refused: no such file" >&2; exit 3; }
    sha256sum "$DIR/$f" | cut -d' ' -f1
    ;;
  cat)
    f="${2:-}"
    safe_name "$f" || { echo "refused: bad name" >&2; exit 2; }
    [ -f "$DIR/$f" ] || { echo "refused: no such file" >&2; exit 3; }
    exec cat "$DIR/$f"
    ;;
  *)
    echo "refused: this key permits only 'list', 'sha256 <file>', 'cat <file>'" >&2
    exit 1
    ;;
esac
