#!/usr/bin/env bash
# PID-2h: our login-update-password.ftl is keycloak.v2's, with ONE change (PID-D15). This undoes that change and compares
# the result with upstream's file at the image's Keycloak version, so an upgrade that moves the upstream template fails
# CI instead of silently shipping an old copy. Run by the `keycloak` job in .github/workflows/ci.yml.
#
#   keycloak/theme/check-upstream.sh            # version from keycloak/Dockerfile's ARG KEYCLOAK_VERSION
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
ver=$(sed -n 's/^ARG KEYCLOAK_VERSION=//p' "$here/../Dockerfile")
[ -n "$ver" ] || { echo "no ARG KEYCLOAK_VERSION in keycloak/Dockerfile" >&2; exit 2; }
ours="$here/gaiada/login/login-update-password.ftl"
upstream=$(curl -fsSL "https://raw.githubusercontent.com/keycloak/keycloak/$ver/themes/src/main/resources/theme/keycloak.v2/login/login-update-password.ftl")

# ours, with the change undone: drop the header comment, put back the import and the checkbox macro
undone=$(awk '
  /^<#--/ && !seen { incomment = 1 }
  incomment { if (/-->/) { incomment = 0; seen = 1 } ; next }
  /^<#import "template.ftl" as layout>$/ { print; print "<#import \"password-commons.ftl\" as passwordCommons>"; next }
  /id="logout-sessions" name="logout-sessions" value="on"/ { sub(/<input.*/, "<@passwordCommons.logoutOtherSessions/>"); print; next }
  /id="kc-logout-sessions-notice"/ { next }
  { print }
' "$ours")

if diff <(printf '%s\n' "$upstream") <(printf '%s\n' "$undone"); then
  echo "login-update-password.ftl = Keycloak $ver keycloak.v2 + the PID-D15 change only"
else
  echo "keycloak.v2 login-update-password.ftl differs from Keycloak $ver beyond the PID-D15 change (diff above:" \
       "< upstream, > ours undone). Re-copy upstream and re-apply the change (keycloak/CLAUDE.md)." >&2
  exit 1
fi
