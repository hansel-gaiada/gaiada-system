#!/usr/bin/env bash
# Enable headless logins for the seeded staff roster, so the simulation can act as REAL employees
# rather than attributing every action to the owner.
#
# WHY THIS EXISTS AS A SEPARATE SCRIPT, RUN BY HAND
# -------------------------------------------------
# The 19 seeded staff accounts share the temporary password recorded in CREDENTIALS.local.md §12a,
# and Keycloak raises UPDATE_PASSWORD at first login. That required action is exactly right for real
# people — and it is what makes `scripts/sso-login.sh` fail for all 19 with the deliberately vague
# "no authorization code (bad credentials, or an interstitial such as OTP/consent)".
#
# Clearing it is a change to the LIVE box's auth posture, so it is a hand-run, owner-authorised step
# with its own script rather than something the harness does implicitly on startup.
#
# WHAT IT DOES NOT DO
# -------------------
# It never prints, logs, or transports the password. The value is generated once into
# /etc/gaiada/sim-staff.pw (root-only, 0600) ON THE BOX and stays there — this script reads it in
# place. The harness never receives it either: it mints short-lived access tokens through
# `sim-token.sh`, which runs the real PKCE flow on the box. So the only thing that ever crosses the
# wire to a developer machine is an access token that expires on its own.
#
# IDEMPOTENT. Safe to re-run: an existing password file is kept, and clearing an already-clear
# requiredActions list is a no-op.
#
# REVERSIBILITY. `--revert` puts UPDATE_PASSWORD back on all 19, which restores the pre-simulation
# posture exactly (the password itself becomes unusable the moment the action is pending again).
#
# Usage:  ./enable-staff-logins.sh            # enable
#         ./enable-staff-logins.sh --revert   # restore UPDATE_PASSWORD on all 19
#         SSH_HOST=gda-aicenter ./enable-staff-logins.sh
set -euo pipefail

SSH_HOST="${SSH_HOST:-gda-aicenter}"
KC="${KC_CONTAINER:-gaiada-keycloak-1}"
REALM="${KC_REALM:-gaiada}"
PW_FILE="${PW_FILE:-/etc/gaiada/sim-staff.pw}"
REVERT="no"
[ "${1:-}" = "--revert" ] && REVERT="yes"

# The roster, by Keycloak username localpart. hansel@ is deliberately ABSENT: the owner account has
# no pending required action and already logs in, so it is never touched by this script.
STAFF="andre azlan edward elmer fadhil fajri gusde ika kadek.arie maya monic radit rai reva rifat ruli sophi tini welly"

echo "==> host=$SSH_HOST container=$KC realm=$REALM revert=$REVERT"

# Everything below runs ON the box in one session. The remote script is fed on a heredoc, and the
# password reaches the container through a copied file rather than an env var or stdin:
#   - an env var would expose it in `docker inspect` and the container's /proc
#   - stdin is already taken by the script itself when using `sh -s`
ssh -o ConnectTimeout=30 "$SSH_HOST" "REVERT='$REVERT' KC='$KC' REALM='$REALM' PW_FILE='$PW_FILE' STAFF='$STAFF' bash -s" <<'REMOTE'
set -euo pipefail

# 1. Ensure the password exists (generate once, never regenerate — a rotation would silently
#    invalidate every token-minting call still using the old value).
sudo -n install -d -m 0700 "$(dirname "$PW_FILE")"
if sudo -n test -s "$PW_FILE"; then
  echo "    password file present, keeping it"
else
  # Keycloak's default policy wants mixed case + digit + special; this shape satisfies it without
  # any character that needs shell or JSON escaping downstream.
  openssl rand -base64 18 | tr -d '\n=+/' | sed 's/^/Sim!/' | sudo -n tee "$PW_FILE" >/dev/null
  sudo -n chmod 0600 "$PW_FILE"
  echo "    password generated (never printed)"
fi

# 2. Stage the worker script + password inside the Keycloak container.
WORK=/tmp/gaiada-sim-kc.$$
cat > "$WORK.sh" <<'INNER'
set -eu
PW=$(cat /tmp/gaiada-sim.pw)
cd /opt/keycloak/bin
# The bootstrap admin credentials live in the container's own env — they are read here and never
# echoed. `--server` uses the in-container origin plus KC_HTTP_RELATIVE_PATH (/idp); the public
# hostname would loop back out through nginx for no reason.
./kcadm.sh config credentials --server "http://127.0.0.1:8080${KC_HTTP_RELATIVE_PATH:-}" \
  --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null
echo "    kcadm authenticated"

for U in $STAFF_LIST; do
  EMAIL="${U}@gaiada.com"
  ID=$(./kcadm.sh get users -r "$REALM_NAME" -q "username=$EMAIL" --fields id --format csv --noquotes 2>/dev/null | tail -1)
  if [ -z "$ID" ]; then echo "    $EMAIL: NOT FOUND (skipped)"; continue; fi

  if [ "$DO_REVERT" = "yes" ]; then
    if ./kcadm.sh update "users/$ID" -r "$REALM_NAME" -s 'requiredActions=["UPDATE_PASSWORD"]' >/dev/null 2>&1; then
      echo "    $EMAIL: UPDATE_PASSWORD restored"
    else
      echo "    $EMAIL: revert FAILED"
    fi
    continue
  fi

  # Order matters: set the password FIRST, then clear the action. If the run dies between the two,
  # the account is left with a known password but still gated by UPDATE_PASSWORD — i.e. still
  # unusable, which is the safe direction to fail in. Clearing first would briefly leave an account
  # open on the OLD shared temporary password.
  if ! ./kcadm.sh set-password -r "$REALM_NAME" --userid "$ID" --new-password "$PW" >/dev/null 2>&1; then
    echo "    $EMAIL: set-password FAILED"; continue
  fi
  if ! ./kcadm.sh update "users/$ID" -r "$REALM_NAME" -s 'requiredActions=[]' >/dev/null 2>&1; then
    echo "    $EMAIL: clear-required-actions FAILED (password set, still gated)"; continue
  fi
  echo "    $EMAIL: ready"
done
INNER

sudo -n cp "$PW_FILE" "$WORK.pw"
sudo -n chmod 0644 "$WORK.pw"   # readable by `docker cp`, removed moments later
docker cp "$WORK.pw" "$KC:/tmp/gaiada-sim.pw" >/dev/null
docker cp "$WORK.sh" "$KC:/tmp/gaiada-sim.sh" >/dev/null

set +e
docker exec -e STAFF_LIST="$STAFF" -e REALM_NAME="$REALM" -e DO_REVERT="$REVERT" \
  "$KC" sh /tmp/gaiada-sim.sh
RC=$?
set -e

# Always clean up, success or not — a password file left inside a container is a standing exposure.
docker exec "$KC" rm -f /tmp/gaiada-sim.pw /tmp/gaiada-sim.sh >/dev/null 2>&1 || true
sudo -n rm -f "$WORK.pw"; rm -f "$WORK.sh"
exit $RC
REMOTE

echo "==> done. Verify with:  ./sim-token.sh reva@gaiada.com | wc -c"
