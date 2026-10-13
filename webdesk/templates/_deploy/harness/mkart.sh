#!/usr/bin/env bash
# mkart.sh DIR BUILD_ID [BIG_BLOBS]  - builds a throwaway "site" artifact plus its manifest (DIR.manifest).
# BIG_BLOBS adds that many 1 MiB random files, so a rate-limited upload takes long enough to be interrupted.
set -euo pipefail
dir="${1:?}"; build="${2:?}"; blobs="${3:-0}"
rm -rf "$dir"; mkdir -p "$dir/about" "$dir/assets" "$dir/blog"
page() { printf '<!doctype html><html><head><title>%s</title></head><body><h1>%s</h1><p>build %s</p><p>%s</p></body></html>\n' "$1" "$1" "$build" "$(head -c 24 /dev/urandom | base64)"; }
page "Home"  >"$dir/index.html"
page "About" >"$dir/about/index.html"
page "404"   >"$dir/404.html"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do page "Post $i" >"$dir/blog/post-$i.html"; done
for i in 1 2 3 4 5 6; do head -c 4096 /dev/urandom | base64 >"$dir/assets/app-$i.js"; done
printf 'Options -Indexes\nErrorDocument 404 /404.html\n' >"$dir/.htaccess"
for i in $(seq 1 "$blobs"); do head -c 1048576 /dev/urandom >"$dir/assets/blob-$i.bin"; done
printf '{"source":"webdesk","buildId":"%s","pulledAt":"%s","itemCount":12}\n' "$build" "$(date -u +%FT%TZ)" >"$dir/webdesk-build.json"
/deploy/make-manifest.sh "$dir" >"$dir.manifest"
