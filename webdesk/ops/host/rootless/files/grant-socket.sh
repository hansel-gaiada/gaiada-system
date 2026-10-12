#!/bin/sh
# grant-socket.sh <operator> <runtime-dir> (M4 F6, WSK-D73). Installed as
# /usr/local/lib/webdesk-rootless/grant-socket.sh and run by the rootless daemon's user unit (ExecStartPost),
# AS the daemon user, which owns both paths. It lets the deploy user reach the daemon socket the way the
# rootful daemon's docker group did: x on the runtime dir, rw on docker.sock, nothing else. That user is
# already root-equivalent on this box (sudo, docker group), so this widens nothing.
set -eu
op="${1:-}"
rt="${2:-}"
case "$op" in '' | *[!A-Za-z0-9_.-]*) echo "grant-socket: bad operator name" >&2; exit 1 ;; esac
case "$rt" in /run/user/*) ;; *) echo "grant-socket: bad runtime dir" >&2; exit 1 ;; esac
case "${rt#/run/user/}" in '' | *[!0-9]*) echo "grant-socket: bad runtime dir" >&2; exit 1 ;; esac
i=0
while [ ! -S "$rt/docker.sock" ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || { echo "grant-socket: $rt/docker.sock never appeared" >&2; exit 1; }
  sleep 0.1
done
setfacl -m "u:$op:--x" "$rt"
setfacl -m "u:$op:rw-" "$rt/docker.sock"
