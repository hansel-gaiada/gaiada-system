#!/bin/sh
# M6-P3d — the ONE thing sumopod's pull key may do on gda-aicenter: print the MON-01 probe-target file.
#
# Installed as the `command=` of a single authorized_keys entry (runbook:
# infra/runbooks/enable-estate-blackbox-and-alert-routing.md §7). sshd runs this INSTEAD of whatever
# the client asked for, so a stolen key can read this one already-minimal file (domain / tenant_id /
# client_id / site_url / internal labels of VERIFIED properties) and nothing else: no shell, no DB,
# no other file. Fails CLOSED: any doubt means a non-zero exit and no output.
#
#   * SSH_ORIGINAL_COMMAND must be empty or exactly the token below; anything else is refused.
#   * No argument, environment value or client string is interpolated into a command or path. The
#     path is fixed here; CLIENT_TARGETS_FILE exists only so the --selftest can point at a fixture,
#     and sshd does not pass client environment to a forced command (PermitUserEnvironment is off).
#   * Missing file, symlink, non-regular file, empty file or an oversize file: refused, exit 3.
#
# Usage: client-targets-forced-command.sh            (as sshd runs it)
#        client-targets-forced-command.sh --selftest
set -eu

TOKEN="gaiada-client-targets"
FILE="${CLIENT_TARGETS_FILE:-/var/lib/gaiada/client-targets/client-properties.json}"
MAX_BYTES=5242880

run() {
  cmd="${SSH_ORIGINAL_COMMAND:-}"
  if [ -n "$cmd" ] && [ "$cmd" != "$TOKEN" ]; then
    echo "client-targets: refused" >&2
    return 2
  fi
  if [ -L "$FILE" ] || [ ! -f "$FILE" ] || [ ! -r "$FILE" ]; then
    echo "client-targets: target file unavailable" >&2
    return 3
  fi
  size=$(wc -c < "$FILE" | tr -d ' ')
  if [ "$size" -le 0 ] || [ "$size" -gt "$MAX_BYTES" ]; then
    echo "client-targets: target file size out of range" >&2
    return 3
  fi
  cat -- "$FILE"
}

selftest() {
  failed=0
  d=$(mktemp -d)
  trap 'rm -rf "$d"' EXIT
  self="$0"
  check() { # name, expected exit, actual exit
    if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (want $2, got $3)"; failed=$((failed + 1)); fi
  }
  printf '[]\n' > "$d/ok.json"
  : > "$d/empty.json"
  ln -s "$d/ok.json" "$d/link.json"

  rc=0; out=$(CLIENT_TARGETS_FILE="$d/ok.json" SSH_ORIGINAL_COMMAND="" sh "$self" 2>/dev/null) || rc=$?
  check "empty command prints the file" 0 "$rc"
  [ "$out" = "[]" ] && check "output is exactly the file" 0 0 || check "output is exactly the file" 0 1
  rc=0; CLIENT_TARGETS_FILE="$d/ok.json" SSH_ORIGINAL_COMMAND="$TOKEN" sh "$self" >/dev/null 2>&1 || rc=$?
  check "the fixed token is accepted" 0 "$rc"
  rc=0; out=$(CLIENT_TARGETS_FILE="$d/ok.json" SSH_ORIGINAL_COMMAND="cat /etc/passwd" sh "$self" 2>/dev/null) || rc=$?
  check "any other command is refused" 2 "$rc"
  [ -z "$out" ] && check "a refusal prints nothing on stdout" 0 0 || check "a refusal prints nothing on stdout" 0 1
  rc=0; CLIENT_TARGETS_FILE="$d/ok.json" SSH_ORIGINAL_COMMAND="$TOKEN; id" sh "$self" >/dev/null 2>&1 || rc=$?
  check "the token with a suffix is refused" 2 "$rc"
  rc=0; CLIENT_TARGETS_FILE="$d/missing.json" sh "$self" >/dev/null 2>&1 || rc=$?
  check "a missing file fails closed" 3 "$rc"
  rc=0; CLIENT_TARGETS_FILE="$d/empty.json" sh "$self" >/dev/null 2>&1 || rc=$?
  check "an empty file fails closed" 3 "$rc"
  if [ -L "$d/link.json" ]; then # some platforms (Git Bash without symlink support) copy instead
    rc=0; CLIENT_TARGETS_FILE="$d/link.json" sh "$self" >/dev/null 2>&1 || rc=$?
    check "a symlink is refused" 3 "$rc"
  else
    echo "  SKIP  a symlink is refused (platform cannot create symlinks)"
  fi
  rc=0; CLIENT_TARGETS_FILE="$d" sh "$self" >/dev/null 2>&1 || rc=$?
  check "a directory is refused" 3 "$rc"
  echo "  selftest: $failed failed"
  [ "$failed" -eq 0 ]
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
else
  run
fi
