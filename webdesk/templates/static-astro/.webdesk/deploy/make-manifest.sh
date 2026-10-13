#!/usr/bin/env bash
# make-manifest.sh DIR  >  manifest.tsv
#
# Writes the deploy manifest for a build artifact directory: one line per regular file,
#   <sha256>\t<size in bytes>\t<path relative to DIR>
# sorted by path in the C locale. deploy.sh uses the same function to hash the artifact before upload
# and to hash what it reads back from the host, so the two sides can be compared byte for byte.
#
# Refuses (exit 2) a tree that holds a symlink, a special file, or a name containing a tab, a newline
# or a backslash: such a tree is not one a static site build produces, and it would make a line of
# the manifest ambiguous. Hidden files (.htaccess) are included.
set -euo pipefail
export LC_ALL=C

dir="${1:?usage: make-manifest.sh DIR}"
[ -d "$dir" ] || { echo "make-manifest: not a directory: $dir" >&2; exit 2; }
cd "$dir"

if [ -n "$(find . ! -type f ! -type d -print -quit)" ]; then
  echo "make-manifest: the tree holds a symlink or special file; refused" >&2
  find . ! -type f ! -type d -print | head -5 >&2
  exit 2
fi
if [ -n "$(find . -name $'*\n*' -o -name $'*\t*' -o -name '*\\*' | head -1)" ]; then
  echo "make-manifest: a file name holds a tab, newline or backslash; refused" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
find . -type f -print0 | sort -z >"$tmp/list"
if [ ! -s "$tmp/list" ]; then
  exit 0   # an empty tree: an empty manifest; deploy.sh refuses it on its minimum-file rule
fi
xargs -0 sha256sum <"$tmp/list" | cut -c1-64 >"$tmp/sha"
xargs -0 stat -c %s <"$tmp/list" >"$tmp/size"
tr '\0' '\n' <"$tmp/list" | sed 's|^\./||' >"$tmp/path"
paste "$tmp/sha" "$tmp/size" "$tmp/path"
