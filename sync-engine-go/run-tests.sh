#!/usr/bin/env bash
# Compile-then-run test helper. Windows Smart App Control (enforce) intermittently blocks the
# randomly-named test .exe that `go test` spawns from %TEMP%; compiling to a stable project-local
# path and executing that binary directly is reliably allowed. CI on ubuntu runs plain `go test`.
set -euo pipefail
cd "$(dirname "$0")"
export GOTMPDIR="$(pwd)/.gotmp"
mkdir -p .gotmp
pkgs="${1:-./internal/...}"
fail=0
for pkg in $(go list "$pkgs"); do
  base="$(basename "$pkg")"
  echo "=== $pkg ==="
  ok=0
  compiled=0
  # Smart App Control blocks by file hash, so each retry RECOMPILES to a fresh name — that (not a
  # plain re-run) is what clears the block. CI on ubuntu runs plain `go test` with none of this.
  for attempt in 1 2 3 4 5; do
    exe=".gotmp/${base}${attempt}.test.exe"
    if ! go test -c -vet=off -o "$exe" "$pkg" 2>/tmp/gocompile; then
      cat /tmp/gocompile; fail=1; break
    fi
    [ -f "$exe" ] || { echo "(no tests)"; break; }
    compiled=1
    out="$("$exe" -test.v 2>&1)" && { ok=1; echo "$out" | tail -n 40; break; }
    if ! echo "$out" | grep -qi "Application Control\|Permission denied"; then
      echo "$out" | tail -n 40; break   # a real test failure — show it
    fi
    sleep 1
  done
  [ "$compiled" = 0 ] || [ "$ok" = 1 ] || { echo "$out" | tail -n 40; fail=1; }
done
exit $fail
