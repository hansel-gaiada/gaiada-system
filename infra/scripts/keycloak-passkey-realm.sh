#!/usr/bin/env bash
# PID-2 (docs/plans/2026-10-30-phone-identity.md §5, steps 2a 2b 2c 2d 2e 2f 2i): set up realm `gaiada` for
# username/phone + password + a passkey on the person's phone, with a realm backup first and a revert.
# Keycloak 26.8.1 or later (PID-1). Idempotent: every step reads the current state and writes only what differs.
#
#   RP_ID=erp.gaiada.com BIND=client:<clientId> keycloak-passkey-realm.sh apply [--dry-run]
#   keycloak-passkey-realm.sh revert <backup-dir> [--dry-run]
#   keycloak-passkey-realm.sh status
#
# Runs on the Keycloak host. kcadm runs INSIDE the Keycloak container (docker exec); JSON is handled with jq on the host.
# Never prints a password, and never puts one on a command line. By default kcadm signs in with the container's OWN
# KC_BOOTSTRAP_ADMIN_USERNAME / KC_BOOTSTRAP_ADMIN_PASSWORD, expanded inside the container, so the password never
# leaves it (the live box is set up this way). With KC_ADMIN_PASSWORD exported on the host instead, it is passed to
# `docker exec -e` by NAME only. kcadm's token file lives in the container's /tmp and is deleted on exit.
#
# Environment (defaults in brackets):
#   KC_CONTAINER [gaiada-keycloak-1]   KC_SERVER [http://localhost:8080/idp] (as seen from inside the container)
#   KC_ADMIN_REALM [master]  KC_ADMIN_USER [the container's KC_BOOTSTRAP_ADMIN_USERNAME, else admin]
#   KC_ADMIN_PASSWORD [unset: the container's own KC_BOOTSTRAP_ADMIN_PASSWORD is used inside it; never echoed]
#   REALM [gaiada]  BACKUP_DIR [$HOME/gaiada-realm-backups]
#   RP_ID (required for apply: the WebAuthn RP ID. Live: erp.gaiada.com. A passkey only works for its RP ID, so this
#         must never change after anyone enrols)            RP_NAME [Gaiada]
#   BIND (required for apply): where the new browser flow is bound
#         realm            -> the realm's browser flow (everyone), and the passkey reset flow + "Forgot password?"
#         client:<clientId>-> a browser-flow override on that client only (risk 1: live starts on a test client);
#                             the reset flow is created but NOT bound, "Forgot password?" stays off
#         none             -> flows created, nothing bound
#   STEPS [profile webauthn browser reset rememberme amr bruteforce]  (a subset runs only those steps; e.g. the
#         early live brute-force step is STEPS=bruteforce)
#   AMR_CLIENTS [gaiada-ui gaiada-platform]  clients that get the oidc-amr-mapper (enable-mfa.md §3.1)
#   PHONE_PATTERN [^\+62[1-9][0-9]{6,12}$]   USERNAME_RULE [0] (1 adds the plan's username pattern; see the report:
#         with usernames that are emails today it breaks admin writes, so it stays off until PID-3c)
#   REMEMBER_ME_SECONDS [604800]  REMEMBER_ME_LABEL [This is my own device]
#   BF_FAILURE_FACTOR [5] BF_WAIT_INCREMENT [60] BF_MAX_WAIT [900] BF_MAX_DELTA [43200] BF_QUICK_LOGIN_MS [1000]
#   BF_MIN_QUICK_WAIT [60] BF_MAX_SECONDARY [0]  (0 = OFF: Keycloak 26.6+ turns a positive value into a PERMANENT
#         lockout even in temporary mode; see the PID-2i note in the report)
#   AMR_PWD_MAX_AGE [$REMEMBER_ME_SECONDS]  AMR_HWK_MAX_AGE [900]  default.reference.maxAge (seconds) of the "pwd" and
#         "hwk" amr references. ALWAYS set: 26.8.1 reads a missing maxAge as 0, so a step is in `amr` only if it finished
#         the instant the token was minted (proved on sumopod: without it, "pwd" never appears and "hwk" is gone from the
#         first refresh). 900 = the plan's 15-minute passkey freshness (§5.9), carried by the claim itself.
set -uo pipefail

MODE=${1:-}; shift || true
DRY=0; BACKUP_ARG=
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) BACKUP_ARG=$a ;; esac; done

KC_CONTAINER=${KC_CONTAINER:-gaiada-keycloak-1}
KC_SERVER=${KC_SERVER:-http://localhost:8080/idp}
KC_ADMIN_REALM=${KC_ADMIN_REALM:-master}
KC_ADMIN_USER=${KC_ADMIN_USER:-}
REALM=${REALM:-gaiada}
BACKUP_DIR=${BACKUP_DIR:-$HOME/gaiada-realm-backups}
RP_ID=${RP_ID:-}
RP_NAME=${RP_NAME:-Gaiada}
BIND=${BIND:-}
STEPS=${STEPS:-profile webauthn browser reset rememberme amr bruteforce}
AMR_CLIENTS=${AMR_CLIENTS:-gaiada-ui gaiada-platform}
PHONE_PATTERN=${PHONE_PATTERN:-'^\+62[1-9][0-9]{6,12}$'}
USERNAME_RULE=${USERNAME_RULE:-0}
USERNAME_PATTERN='^[a-z0-9][a-z0-9.-]{2,29}$'
REMEMBER_ME_SECONDS=${REMEMBER_ME_SECONDS:-604800}
REMEMBER_ME_LABEL=${REMEMBER_ME_LABEL:-This is my own device}
BF_FAILURE_FACTOR=${BF_FAILURE_FACTOR:-5}
BF_WAIT_INCREMENT=${BF_WAIT_INCREMENT:-60}
BF_MAX_WAIT=${BF_MAX_WAIT:-900}
BF_MAX_DELTA=${BF_MAX_DELTA:-43200}
BF_QUICK_LOGIN_MS=${BF_QUICK_LOGIN_MS:-1000}
BF_MIN_QUICK_WAIT=${BF_MIN_QUICK_WAIT:-60}
BF_MAX_SECONDARY=${BF_MAX_SECONDARY:-0}
AMR_PWD_MAX_AGE=${AMR_PWD_MAX_AGE:-$REMEMBER_ME_SECONDS}
AMR_HWK_MAX_AGE=${AMR_HWK_MAX_AGE:-900}

FLOW_BROWSER=gaiada-passkey-browser
FLOW_RESET=gaiada-passkey-reset
FLOW_RESET_PROOF=gaiada-passkey-reset-proof
DENY_MSG="This account cannot reset its password here. Ask IT to reset your sign-in."
KCFG=/tmp/pid2-kcadm.$$.cfg
# The realm fields this script owns. revert restores exactly these from the backup.
REALM_KEYS='["editUsernameAllowed","resetPasswordAllowed","browserFlow","resetCredentialsFlow","rememberMe",
 "ssoSessionIdleTimeoutRememberMe","ssoSessionMaxLifespanRememberMe","webAuthnPolicyRpId","webAuthnPolicyRpEntityName",
 "webAuthnPolicyUserVerificationRequirement","webAuthnPolicyRequireResidentKey","webAuthnPolicyResidentKey",
 "webAuthnPolicyAttestationConveyancePreference","webAuthnPolicyAuthenticatorAttachment","webAuthnPolicySignatureAlgorithms",
 "bruteForceProtected","permanentLockout","maxTemporaryLockouts","bruteForceStrategy","failureFactor","waitIncrementSeconds",
 "maxFailureWaitSeconds","maxDeltaTimeSeconds","quickLoginCheckMilliSeconds","minimumQuickLoginWaitSeconds",
 "maxSecondaryAuthFailures"]'

die() { echo "STOP: $*" >&2; exit 2; }
say() { echo "-- $*"; }
usage() { sed -n '2,9p' "$0"; exit 2; }
case "$MODE" in apply|revert|status) ;; *) usage ;; esac
command -v jq >/dev/null || die "jq is required on this host"
docker inspect -f '{{.State.Running}}' "$KC_CONTAINER" 2>/dev/null | grep -q true || die "container $KC_CONTAINER is not running"
K()  { docker exec    "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@" --config "$KCFG"; }
KI() { docker exec -i "$KC_CONTAINER" /opt/keycloak/bin/kcadm.sh "$@" --config "$KCFG"; }
cleanup() { docker exec "$KC_CONTAINER" rm -f "$KCFG" >/dev/null 2>&1; }
trap cleanup EXIT
# One sign-in, never retried. Every value is passed by NAME (`-e VAR` reads the host's exported VAR); the password is
# either the host's exported KC_ADMIN_PASSWORD or, when unset, the container's own bootstrap password, expanded in there.
export KC_ADMIN_USER KC_ADMIN_PASSWORD="${KC_ADMIN_PASSWORD:-}" KC_SERVER KC_ADMIN_REALM KCFG
docker exec -e KC_ADMIN_USER -e KC_ADMIN_PASSWORD -e KC_SERVER -e KC_ADMIN_REALM -e KCFG "$KC_CONTAINER" sh -c '
  U=${KC_ADMIN_USER:-${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}}; P=${KC_ADMIN_PASSWORD:-${KC_BOOTSTRAP_ADMIN_PASSWORD:-}}
  [ -n "$P" ] || { echo "no admin password: neither KC_ADMIN_PASSWORD nor the container KC_BOOTSTRAP_ADMIN_PASSWORD" >&2; exit 3; }
  /opt/keycloak/bin/kcadm.sh config credentials --config "$KCFG" --server "$KC_SERVER" --realm "$KC_ADMIN_REALM" --user "$U" --password "$P"' >/dev/null \
  || die "admin login to $KC_SERVER failed (stopping; never retried)"
K get "realms/$REALM" --fields realm >/dev/null 2>&1 || die "realm $REALM not found"

# write helpers: in --dry-run they print the call instead of making it
W()  { if [ "$DRY" = 1 ]; then echo "   DRY-RUN would run: kcadm $*"; return 0; fi; K "$@" >/dev/null || die "write failed: kcadm $*"; }
WJ() { local body=$1; shift
       if [ "$DRY" = 1 ]; then echo "   DRY-RUN would run: kcadm $* with $(jq -c . <<<"$body" | cut -c1-400)"; return 0; fi
       printf '%s' "$body" | KI "$@" -f - >/dev/null || die "write failed: kcadm $*"; }
uri() { jq -rn --arg s "$1" '$s|@uri'; }
has_step() { case " $STEPS " in *" $1 "*) return 0 ;; esac; return 1; }

realm_json() { K get "realms/$REALM"; }
# realm_set <json object>: writes only the keys whose value differs from now.
realm_set() {
  local want=$1 cur delta
  cur=$(realm_json)
  delta=$(jq -c --argjson w "$want" '. as $c | $w | with_entries(select($c[.key] != .value))' <<<"$cur")
  if [ "$delta" = "{}" ]; then say "realm fields already as wanted: $(jq -r 'keys|join(",")' <<<"$want")"; return 0; fi
  jq -r --argjson c "$cur" 'to_entries[] | "   change \(.key): \($c[.key]|tojson) -> \(.value|tojson)"' <<<"$delta"
  WJ "$delta" update "realms/$REALM"
}
flow_json() { K get authentication/flows -r "$REALM" | jq -c --arg a "$1" 'first(.[]|select(.alias==$a)) // empty'; }
execs() { K get "authentication/flows/$(uri "$1")/executions" -r "$REALM"; }
# add_exec <flowAlias> <providerId> <requirement> -> prints the new execution id
add_exec() {
  local f=$1 p=$2 req=$3 id
  K create "authentication/flows/$(uri "$f")/executions/execution" -r "$REALM" -s provider="$p" >/dev/null || return 1
  id=$(execs "$f" | jq -r --arg p "$p" '[.[]|select(.providerId==$p and .level==0)]|last|.id')
  K update "authentication/flows/$(uri "$f")/executions" -r "$REALM" --no-merge -b "{\"id\":\"$id\",\"requirement\":\"$req\"}" >/dev/null || return 1
  to_last "$f" "$id" || return 1
  echo "$id"
}
# to_last <flowAlias> <execId>: 26.8.1 can place a new execution FIRST (seen after deleting a sibling in a copied flow:
# WebAuthn landed before the password form). Lower it until it is the last top-level entry of its flow.
to_last() {
  local f=$1 id=$2 n
  for n in $(seq 20); do
    [ "$(execs "$f" | jq -r '[.[]|select(.level==0)]|last|.id')" = "$id" ] && return 0
    K create "authentication/executions/$id/lower-priority" -r "$REALM" -b '{}' >/dev/null 2>&1 || return 1
  done
  [ "$(execs "$f" | jq -r '[.[]|select(.level==0)]|last|.id')" = "$id" ]
}
# exec_config <execJson> <alias> <configObject>: create or update the execution's authenticator config
exec_config() {
  local ex=$1 alias=$2 want=$3 cid cur
  cid=$(jq -r '.authenticationConfig // empty' <<<"$ex")
  if [ -z "$cid" ]; then
    say "config $alias on $(jq -r .displayName <<<"$ex"): $want"
    WJ "{\"alias\":\"$alias\",\"config\":$want}" create "authentication/executions/$(jq -r .id <<<"$ex")/config" -r "$REALM"
  else
    cur=$(K get "authentication/config/$cid" -r "$REALM")
    if jq -e --argjson w "$want" '.config == $w' <<<"$cur" >/dev/null; then say "config $alias already as wanted"
    else say "config $alias: $(jq -c .config <<<"$cur") -> $want"; WJ "$(jq -c --argjson w "$want" '.config=$w' <<<"$cur")" update "authentication/config/$cid" -r "$REALM"; fi
  fi
}
ref_cfg() { # <value> <maxAge seconds>
  jq -nc --arg v "$1" --arg a "$2" '{"default.reference.value":$v,"default.reference.maxAge":$a}'
}
# ensure_ra <providerId> <name>: required action registered and enabled
ensure_ra() {
  local p=$1 n=$2 ra
  ra=$(K get authentication/required-actions -r "$REALM" | jq -c --arg p "$p" 'first(.[]|select(.alias==$p)) // empty')
  if [ -z "$ra" ]; then say "register required action $p"; W create authentication/register-required-action -r "$REALM" -s providerId="$p" -s name="$n"
     W update "authentication/required-actions/$p" -r "$REALM" -s enabled=true
  elif [ "$(jq -r .enabled <<<"$ra")" != true ]; then say "enable required action $p"; W update "authentication/required-actions/$p" -r "$REALM" -s enabled=true
  else say "required action $p registered and enabled"; fi
}
client_id() { K get clients -r "$REALM" -q clientId="$1" -q exact=true | jq -r 'first(.[]|select(.clientId=="'"$1"'"))|.id // empty'; }

backup() {
  local d="$BACKUP_DIR/pid2-$REALM-$(date -u +%Y%m%dT%H%M%SZ)"
  if [ "$DRY" = 1 ]; then say "DRY-RUN: would back up to $d"; return 0; fi
  ( umask 077; mkdir -p "$d" ) || die "cannot create $d"
  K create "realms/$REALM/partial-export" -q exportClients=true -q exportGroupsAndRoles=true -o > "$d/partial-export.json" || die "partial export failed"
  realm_json > "$d/realm.json" && K get users/profile -r "$REALM" > "$d/user-profile.json" \
    && K get "localization/en" -r "$REALM" > "$d/localization-en.json" \
    && K get authentication/required-actions -r "$REALM" > "$d/required-actions.json" \
    && K get clients -r "$REALM" | jq '[.[]|{id,clientId,authenticationFlowBindingOverrides,protocolMappers:[.protocolMappers[]?|{id,name,protocolMapper}]}]' > "$d/clients.json" \
    || die "backup incomplete in $d"
  for f in "$d"/*.json; do jq -e . "$f" >/dev/null || die "backup file $f is not JSON"; done
  chmod 600 "$d"/*.json
  echo "BACKUP $d"
}

step_profile() {
  say "PID-2a user profile: phoneNumber (required for the person, E.164 +62), editUsernameAllowed, VERIFY_PROFILE"
  local cur want attr
  cur=$(K get users/profile -r "$REALM")
  attr=$(jq -nc --arg pat "$PHONE_PATTERN" '{name:"phoneNumber",displayName:"Phone number",
    validations:{pattern:{pattern:$pat,"error-message":"Use the international form, starting +62, e.g. +628123456789"},length:{min:9,max:16}},
    annotations:{inputType:"html5-tel",inputTypePlaceholder:"+628123456789",autocomplete:"tel"},
    required:{roles:["user"]},permissions:{view:["admin","user"],edit:["admin","user"]},multivalued:false}')
  want=$(jq -c --argjson a "$attr" 'if any(.attributes[]; .name=="phoneNumber") then .attributes |= map(if .name=="phoneNumber" then $a else . end) else .attributes += [$a] end' <<<"$cur")
  if [ "$USERNAME_RULE" = 1 ]; then
    want=$(jq -c --arg p "$USERNAME_PATTERN" '.attributes |= map(if .name=="username" then .validations.pattern={pattern:$p,"error-message":"3 to 30 characters: letters, digits, dot or dash"} else . end)' <<<"$want")
  fi
  if [ "$(jq -S -c . <<<"$cur")" = "$(jq -S -c . <<<"$want")" ]; then say "user profile already as wanted"
  else say "user profile: phoneNumber attribute set$([ "$USERNAME_RULE" = 1 ] && echo ', username pattern set')"; WJ "$want" update users/profile -r "$REALM"; fi
  realm_set '{"editUsernameAllowed":true}'
  ensure_ra VERIFY_PROFILE "Verify Profile"
}

step_webauthn() {
  say "PID-2b WebAuthn (second-factor) policy: RP ID $RP_ID, UV required, discoverable required, attestation none, any attachment"
  realm_set "$(jq -nc --arg rp "$RP_ID" --arg n "$RP_NAME" '{webAuthnPolicyRpId:$rp,webAuthnPolicyRpEntityName:$n,
    webAuthnPolicyUserVerificationRequirement:"required",webAuthnPolicyRequireResidentKey:"Yes",webAuthnPolicyResidentKey:"required",
    webAuthnPolicyAttestationConveyancePreference:"none",webAuthnPolicyAuthenticatorAttachment:"not specified",
    webAuthnPolicySignatureAlgorithms:["ES256","RS256"]}')"
  # the passwordless "Enable Passkeys" switch is deliberately left alone: the password stays, the passkey is the 2nd factor
}

forms_subflow() { # alias of the top-level subflow of $FLOW_BROWSER that holds the username-password form
  local s
  for s in $(execs "$FLOW_BROWSER" | jq -r '.[]|select(.level==0 and .authenticationFlow==true)|.displayName|@base64'); do
    s=$(base64 -d <<<"$s")
    execs "$s" | jq -e 'any(.[]; .level==0 and .providerId=="auth-username-password-form")' >/dev/null && { echo "$s"; return 0; }
  done
  return 1
}
step_browser() {
  say "PID-2c browser flow $FLOW_BROWSER: copy of 'browser'; forms = Username Password Form REQUIRED -> WebAuthn REQUIRED"
  local fm ex
  if [ -z "$(flow_json "$FLOW_BROWSER")" ]; then
    if [ "$DRY" = 1 ]; then echo "   DRY-RUN would copy 'browser' to $FLOW_BROWSER, delete the conditional 2FA/OTP subflow in its forms, add webauthn-authenticator REQUIRED, set amr refs pwd/hwk"
    else
      K create authentication/flows/browser/copy -r "$REALM" -s newName="$FLOW_BROWSER" >/dev/null || die "copy of browser failed"
      fm=$(forms_subflow) || die "no forms subflow in the copy"
      for id in $(execs "$fm" | jq -r '.[]|select(.level==0 and .authenticationFlow==true)|.id'); do K delete "authentication/executions/$id" -r "$REALM" || die "delete subflow $id"; done
      add_exec "$fm" webauthn-authenticator REQUIRED >/dev/null || die "add webauthn-authenticator"
      say "created $FLOW_BROWSER"
    fi
  fi
  if [ "$DRY" = 0 ] || [ -n "$(flow_json "$FLOW_BROWSER")" ]; then
    fm=$(forms_subflow) || die "$FLOW_BROWSER has no forms subflow"
    ex=$(execs "$fm")
    [ "$(jq -c '[.[]|select(.level==0)|[.providerId,.requirement]]' <<<"$ex")" = '[["auth-username-password-form","REQUIRED"],["webauthn-authenticator","REQUIRED"]]' ] \
      || die "$FLOW_BROWSER/$fm is not [password REQUIRED, webauthn REQUIRED]: $(jq -c '[.[]|[.level,.providerId // .displayName,.requirement]]' <<<"$ex")"
    exec_config "$(jq -c 'first(.[]|select(.providerId=="auth-username-password-form"))' <<<"$ex")" pid-amr-pwd "$(ref_cfg pwd "$AMR_PWD_MAX_AGE")"
    exec_config "$(jq -c 'first(.[]|select(.providerId=="webauthn-authenticator"))' <<<"$ex")" pid-amr-hwk "$(ref_cfg hwk "$AMR_HWK_MAX_AGE")"
  fi
  ensure_ra webauthn-register "Webauthn Register"
  case "$BIND" in
    realm) realm_set "{\"browserFlow\":\"$FLOW_BROWSER\"}" ;;
    client:*)
      local c=${BIND#client:} cid fid cur
      cid=$(client_id "$c"); [ -n "$cid" ] || die "client $c not found"
      fid=$(flow_json "$FLOW_BROWSER" | jq -r '.id // "<new>"')
      cur=$(K get "clients/$cid" | jq -r '.authenticationFlowBindingOverrides.browser // empty')
      if [ "$cur" = "$fid" ]; then say "client $c already bound to $FLOW_BROWSER"
      else say "bind $FLOW_BROWSER to client $c (browser override)"; WJ "{\"authenticationFlowBindingOverrides\":{\"browser\":\"$fid\"}}" update "clients/$cid" -r "$REALM"; fi ;;
    none) say "BIND=none: $FLOW_BROWSER not bound" ;;
  esac
}

step_reset() {
  say "PID-2d reset flow $FLOW_RESET: Choose User -> [WebAuthn | else Deny access] -> Reset Password"
  local ex want
  want='[[0,"reset-credentials-choose-user","REQUIRED"],[0,"gaiada-passkey-reset-proof","REQUIRED"],[1,"webauthn-authenticator","ALTERNATIVE"],[1,"deny-access-authenticator","ALTERNATIVE"],[0,"reset-password","REQUIRED"]]'
  if [ -z "$(flow_json "$FLOW_RESET")" ]; then
    if [ "$DRY" = 1 ]; then echo "   DRY-RUN would create $FLOW_RESET = $want"
    else
      WJ "{\"alias\":\"$FLOW_RESET\",\"description\":\"PID-2d: forgot password proved with the passkey; no passkey, no reset\",\"providerId\":\"basic-flow\",\"topLevel\":true,\"builtIn\":false}" create authentication/flows -r "$REALM"
      add_exec "$FLOW_RESET" reset-credentials-choose-user REQUIRED >/dev/null || die "choose user"
      K create "authentication/flows/$(uri "$FLOW_RESET")/executions/flow" -r "$REALM" -b "{\"alias\":\"$FLOW_RESET_PROOF\",\"type\":\"basic-flow\",\"description\":\"the passkey, else deny\"}" >/dev/null || die "proof subflow"
      local sid; sid=$(execs "$FLOW_RESET" | jq -r --arg a "$FLOW_RESET_PROOF" 'first(.[]|select(.displayName==$a))|.id')
      K update "authentication/flows/$(uri "$FLOW_RESET")/executions" -r "$REALM" --no-merge -b "{\"id\":\"$sid\",\"requirement\":\"REQUIRED\"}" >/dev/null || die "proof subflow requirement"
      to_last "$FLOW_RESET" "$sid" || die "proof subflow order"
      add_exec "$FLOW_RESET_PROOF" webauthn-authenticator ALTERNATIVE >/dev/null || die "webauthn in proof"
      add_exec "$FLOW_RESET_PROOF" deny-access-authenticator ALTERNATIVE >/dev/null || die "deny in proof"
      add_exec "$FLOW_RESET" reset-password REQUIRED >/dev/null || die "reset password"
      say "created $FLOW_RESET"
    fi
  fi
  if [ -n "$(flow_json "$FLOW_RESET")" ]; then
    ex=$(execs "$FLOW_RESET")
    [ "$(jq -c '[.[]|[.level,(.providerId // .displayName),.requirement]]' <<<"$ex")" = "$want" ] \
      || die "$FLOW_RESET is not the expected shape: $(jq -c '[.[]|[.level,(.providerId // .displayName),.requirement]]' <<<"$ex")"
    exec_config "$(jq -c 'first(.[]|select(.providerId=="webauthn-authenticator"))' <<<"$ex")" pid-amr-reset-hwk "$(ref_cfg hwk "$AMR_HWK_MAX_AGE")"
    exec_config "$(jq -c 'first(.[]|select(.providerId=="deny-access-authenticator"))' <<<"$ex")" pid-reset-deny "$(jq -nc --arg m "$DENY_MSG" '{denyErrorMessage:$m}')"
  fi
  if [ "$BIND" = realm ]; then
    realm_set "{\"resetCredentialsFlow\":\"$FLOW_RESET\"}"
    # "Forgot password?" comes back ONLY with the passkey flow bound (plan §5.6)
    [ "$DRY" = 1 ] || [ "$(realm_json | jq -r .resetCredentialsFlow)" = "$FLOW_RESET" ] || die "reset flow not bound; leaving resetPasswordAllowed alone"
    realm_set '{"resetPasswordAllowed":true}'
  else say "BIND=$BIND: $FLOW_RESET not bound, resetPasswordAllowed untouched"; fi
}

step_rememberme() {
  say "PID-2e remember-me ($REMEMBER_ME_SECONDS s) labelled '$REMEMBER_ME_LABEL'; ordinary sessions untouched"
  realm_set "{\"rememberMe\":true,\"ssoSessionIdleTimeoutRememberMe\":$REMEMBER_ME_SECONDS,\"ssoSessionMaxLifespanRememberMe\":$REMEMBER_ME_SECONDS}"
  local cur; cur=$(K get "localization/en" -r "$REALM" | jq -r '.rememberMe // empty')
  if [ "$cur" = "$REMEMBER_ME_LABEL" ]; then say "label already set"
  else say "localization en.rememberMe: '${cur}' -> '$REMEMBER_ME_LABEL'"; WJ "$(jq -nc --arg v "$REMEMBER_ME_LABEL" '{rememberMe:$v}')" create "localization/en" -r "$REALM"; fi
  realm_json | jq -r '"   sessions: ordinary idle \(.ssoSessionIdleTimeout) max \(.ssoSessionMaxLifespan); client session idle \(.clientSessionIdleTimeout) max \(.clientSessionMaxLifespan) (0 = follows the SSO session)"'
}

step_amr() {
  say "PID-2f oidc-amr-mapper on: $AMR_CLIENTS"
  local c cid
  for c in $AMR_CLIENTS; do
    cid=$(client_id "$c"); [ -n "$cid" ] || { say "client $c not found, skipped"; continue; }
    if K get "clients/$cid/protocol-mappers/models" -r "$REALM" | jq -e 'any(.[]; .protocolMapper=="oidc-amr-mapper")' >/dev/null; then say "$c already has an amr mapper"
    else say "add amr mapper to $c"
      WJ '{"name":"amr","protocol":"openid-connect","protocolMapper":"oidc-amr-mapper","consentRequired":false,"config":{"id.token.claim":"false","access.token.claim":"true","userinfo.token.claim":"false","introspection.token.claim":"true"}}' \
        create "clients/$cid/protocol-mappers/models" -r "$REALM"
    fi
  done
}

step_bruteforce() {
  say "PID-2i brute-force detection: temporary lockouts only; secondary-failure lockout $BF_MAX_SECONDARY"
  realm_set "$(jq -nc --argjson ff "$BF_FAILURE_FACTOR" --argjson wi "$BF_WAIT_INCREMENT" --argjson mw "$BF_MAX_WAIT" \
    --argjson md "$BF_MAX_DELTA" --argjson ql "$BF_QUICK_LOGIN_MS" --argjson mq "$BF_MIN_QUICK_WAIT" --argjson ms "$BF_MAX_SECONDARY" \
    '{bruteForceProtected:true,permanentLockout:false,maxTemporaryLockouts:0,bruteForceStrategy:"MULTIPLE",failureFactor:$ff,
      waitIncrementSeconds:$wi,maxFailureWaitSeconds:$mw,maxDeltaTimeSeconds:$md,quickLoginCheckMilliSeconds:$ql,
      minimumQuickLoginWaitSeconds:$mq,maxSecondaryAuthFailures:$ms}')"
}

status() {
  realm_json | jq --argjson k "$REALM_KEYS" '. as $r | reduce $k[] as $x ({}; .[$x]=$r[$x])'
  echo "flows: $(K get authentication/flows -r "$REALM" | jq -r '[.[].alias]|join(", ")')"
  for f in "$FLOW_BROWSER" "$FLOW_RESET"; do [ -n "$(flow_json "$f")" ] && { echo "$f:"; execs "$f" | jq -r '.[]|"  \("  "*.level)\(.displayName) \(.requirement)\(if .authenticationConfig then " [cfg]" else "" end)"'; }; done
  echo "required actions: $(K get authentication/required-actions -r "$REALM" | jq -r '[.[]|"\(.alias)=\(.enabled)"]|join(" ")')"
  echo "phoneNumber attribute: $(K get users/profile -r "$REALM" | jq -c 'first(.attributes[]|select(.name=="phoneNumber")) // "absent"')"
  echo "localization en.rememberMe: $(K get localization/en -r "$REALM" | jq -r '.rememberMe // "(default)"')"
  local c cid; for c in $AMR_CLIENTS; do cid=$(client_id "$c"); [ -n "$cid" ] && echo "amr mapper on $c: $(K get "clients/$cid/protocol-mappers/models" -r "$REALM" | jq -r 'any(.[]; .protocolMapper=="oidc-amr-mapper")')"; done
}

revert() {
  local d=$BACKUP_ARG
  [ -n "$d" ] && [ -f "$d/realm.json" ] || die "revert needs a backup dir made by apply (holding realm.json)"
  say "revert from $d"
  # 1. realm fields (flow bindings included) back to the backup's values
  realm_set "$(jq -c --argjson k "$REALM_KEYS" '. as $r | reduce $k[] as $x ({}; if $r|has($x) then .[$x]=$r[$x] else . end)' "$d/realm.json")"
  # 2. client overrides pointing at our flow, and amr mappers the backup did not have
  local fid c cid bo
  fid=$(flow_json "$FLOW_BROWSER" | jq -r '.id // empty')
  for cid in $(K get clients -r "$REALM" | jq -r '.[].id'); do
    if [ -n "$fid" ] && [ "$(K get "clients/$cid" -r "$REALM" | jq -r '.authenticationFlowBindingOverrides.browser // empty')" = "$fid" ]; then
      bo=$(jq -c --arg id "$cid" 'first(.[]|select(.id==$id))|.authenticationFlowBindingOverrides // {}' "$d/clients.json")
      say "client $cid: browser override back to $bo"; WJ "{\"authenticationFlowBindingOverrides\":$bo}" update "clients/$cid" -r "$REALM"
    fi
    for m in $(K get "clients/$cid/protocol-mappers/models" -r "$REALM" | jq -r '.[]|select(.protocolMapper=="oidc-amr-mapper")|.id'); do
      jq -e --arg m "$m" 'any(.[].protocolMappers[]; .id==$m)' "$d/clients.json" >/dev/null && continue
      say "client $cid: remove amr mapper $m"; W delete "clients/$cid/protocol-mappers/models/$m" -r "$REALM"
    done
  done
  # 3. user profile. A realm that never had its profile edited holds NO profile component (Keycloak serves its built-in
  #    default); writing the default back would leave a component behind, so in that case the component is deleted.
  local upt=org.keycloak.userprofile.UserProfileProvider comp
  if ! jq -e --arg t "$upt" '(.components[$t] // []) | length > 0' "$d/partial-export.json" >/dev/null; then
    for comp in $(K get components -r "$REALM" -q type="$upt" | jq -r '.[].id'); do say "remove the stored user profile (the backup had Keycloak's built-in default)"; W delete "components/$comp" -r "$REALM"; done
  fi
  if [ "$DRY" = 0 ] && [ "$(K get users/profile -r "$REALM" | jq -S -c .)" != "$(jq -S -c . "$d/user-profile.json")" ]; then say "user profile back to the backup"; WJ "$(cat "$d/user-profile.json")" update users/profile -r "$REALM"; else say "user profile as in the backup"; fi
  # 4. the remember-me label
  local old cur; old=$(jq -r '.rememberMe // empty' "$d/localization-en.json"); cur=$(K get localization/en -r "$REALM" | jq -r '.rememberMe // empty')
  if [ "$cur" != "$old" ]; then
    if [ -n "$old" ]; then say "label back to '$old'"; WJ "$(jq -nc --arg v "$old" '{rememberMe:$v}')" create localization/en -r "$REALM"
    else say "remove the rememberMe label override"; W delete localization/en/rememberMe -r "$REALM"; fi
  fi
  # the realm keeps an empty "en" locale once its last text is gone; drop it if the backup had no "en" texts at all
  if [ "$DRY" = 0 ] && [ "$(jq -c . "$d/localization-en.json")" = "{}" ] && [ "$(K get localization/en -r "$REALM" | jq -c .)" = "{}" ] \
     && K get localization -r "$REALM" | jq -e 'index("en")' >/dev/null; then
    say "remove the now-empty en locale (absent in the backup)"; W delete localization/en -r "$REALM"
  fi
  # 5. required actions this script registers or enables
  local p was now
  for p in VERIFY_PROFILE webauthn-register; do
    was=$(jq -c --arg p "$p" 'first(.[]|select(.alias==$p)) // empty' "$d/required-actions.json")
    now=$(K get authentication/required-actions -r "$REALM" | jq -c --arg p "$p" 'first(.[]|select(.alias==$p)) // empty')
    if [ -z "$was" ] && [ -n "$now" ]; then say "unregister required action $p (absent in the backup)"; W delete "authentication/required-actions/$p" -r "$REALM"
    elif [ -n "$was" ] && [ -n "$now" ] && [ "$(jq -c '{enabled,defaultAction}' <<<"$was")" != "$(jq -c '{enabled,defaultAction}' <<<"$now")" ]; then
      say "required action $p back to $(jq -c '{enabled,defaultAction}' <<<"$was")"; WJ "$(jq -c '{enabled,defaultAction}' <<<"$was")" update "authentication/required-actions/$p" -r "$REALM"
    fi
  done
  # 6. our flows, once nothing is bound to them
  local f; for f in "$FLOW_BROWSER" "$FLOW_RESET"; do
    jq -e --arg a "$f" 'any(.authenticationFlows[]?; .alias==$a)' "$d/partial-export.json" >/dev/null && { say "$f existed before apply; kept"; continue; }
    fid=$(flow_json "$f" | jq -r '.id // empty'); [ -n "$fid" ] || continue
    say "delete flow $f"; W delete "authentication/flows/$fid" -r "$REALM"
  done
  echo "NOTE: passkeys people enrolled while the flows were live stay on their accounts (credentials are not realm settings)."
}

case "$MODE" in
  status) status ;;
  revert) revert ;;
  apply)
    [ -n "$RP_ID" ] || die "RP_ID is required (live: erp.gaiada.com). It can never change once anyone enrols."
    case "$BIND" in realm|none|client:?*) ;; *) die "BIND must be realm, client:<clientId> or none (live starts with client:<test client>, plan §6 risk 1)" ;; esac
    [ "$DRY" = 1 ] && echo "== DRY RUN: nothing is written"
    echo "== apply to realm $REALM via $KC_CONTAINER ($KC_SERVER), RP_ID=$RP_ID, BIND=$BIND, steps: $STEPS"
    backup
    for s in profile webauthn browser reset rememberme amr bruteforce; do has_step "$s" && "step_$s"; done
    echo "== done$([ "$DRY" = 1 ] && echo ' (dry run)')" ;;
esac
