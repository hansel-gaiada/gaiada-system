#!/usr/bin/env bash
# test-scripts.sh - offline tests of the deploy job's own scripts (M6-P6f): plan.sh (which trigger deploys what),
# write-stamp.sh (the build stamp), deploy-from-secret.sh (the secret's shape and its mapping onto deploy.sh, and the wp
# artifact refusals). No network, no host, no lftp: deploy-from-secret.sh is run against a STUB deploy.sh that records the
# DEPLOY_* it was handed. The real deploy.sh, against real daemons, is the harness (harness/cases-p6f.sh on sumopod).
# Needs bash and jq. (tr -d backslash-r on jq output: a jq built for Windows ends its lines with CRLF; a no-op on Linux.)
set -uo pipefail
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"   # Git Bash on Windows rewrites "/srv/wp"-looking arguments; a no-op on Linux
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASSN=0; FAILN=0
ok() { PASSN=$((PASSN + 1)); echo "PASS  $1"; }
bad() { FAILN=$((FAILN + 1)); echo "FAIL  $1${2:+  -  $2}"; }
check() { if [ "$2" = 0 ]; then ok "$1"; else bad "$1" "${3:-}"; fi; }
CANARY="Canary-Pw-$$-$RANDOM$RANDOM"

# ================================================================ plan.sh
plan() { # plan KEY=VAL...  -> sets P_RC, P_OUT
  P_OUT="$(env -i PATH="$PATH" "$@" bash "$HERE/plan.sh" 2>&1)"; P_RC=$?
}
planget() { printf '%s\n' "$P_OUT" | sed -n "s/^$1=//p" | head -1; }
expect_plan() { # expect_plan <name> <rc> <deploy> <environment> KEY=VAL...
  local name="$1" rc="$2" dep="$3" env_="$4"; shift 4
  plan "$@"
  if [ "$P_RC" != "$rc" ]; then bad "plan: $name" "wanted exit $rc, got $P_RC: $P_OUT"; return; fi
  if [ "$rc" = 0 ] && { [ "$(planget deploy)" != "$dep" ] || [ "$(planget environment)" != "$env_" ]; }; then bad "plan: $name" "got: $P_OUT"; return; fi
  ok "plan: $name"
}
B="PLAN_DEFAULT_BRANCH=main PLAN_IS_TEMPLATE=false"
expect_plan "push to the default branch deploys staging" 0 true staging $B PLAN_EVENT=push PLAN_REF=refs/heads/main
expect_plan "a push to another branch deploys nothing" 0 false staging $B PLAN_EVENT=push PLAN_REF=refs/heads/feature/x
expect_plan "a tag push deploys nothing" 0 false staging $B PLAN_EVENT=push PLAN_REF=refs/tags/v1
expect_plan "a pull request deploys nothing" 0 false staging $B PLAN_EVENT=pull_request PLAN_REF=refs/pull/3/merge
expect_plan "a template repo deploys nothing, even on the default branch" 0 false staging PLAN_DEFAULT_BRANCH=main PLAN_IS_TEMPLATE=true PLAN_EVENT=push PLAN_REF=refs/heads/main
D="$B PLAN_EVENT=workflow_dispatch PLAN_REF=refs/heads/main PLAN_IN_APPROVAL_ID=0192f0aa-1111-7000-8000-00000000000a"
expect_plan "dispatch publish (no environment input) rebuilds staging" 0 true staging $D PLAN_IN_KIND=publish PLAN_IN_PUBLISHED_AT=2026-10-13T10:00:00.000Z
expect_plan "dispatch rebuild, environment=staging, rebuilds staging" 0 true staging $D PLAN_IN_KIND=rebuild PLAN_IN_ENVIRONMENT=staging
expect_plan "dispatch promote with environment=production deploys production" 0 true production $D PLAN_IN_KIND=promote PLAN_IN_ENVIRONMENT=production
expect_plan "REFUSED: production asked by a publish" 1 - - $D PLAN_IN_KIND=publish PLAN_IN_ENVIRONMENT=production
expect_plan "REFUSED: production asked by a rebuild" 1 - - $D PLAN_IN_KIND=rebuild PLAN_IN_ENVIRONMENT=production
expect_plan "REFUSED: a promote that does not say production" 1 - - $D PLAN_IN_KIND=promote
expect_plan "REFUSED: a promote that says staging" 1 - - $D PLAN_IN_KIND=promote PLAN_IN_ENVIRONMENT=staging
expect_plan "REFUSED: a dispatch with no approval id" 1 - - $B PLAN_EVENT=workflow_dispatch PLAN_REF=refs/heads/main PLAN_IN_KIND=promote PLAN_IN_ENVIRONMENT=production
expect_plan "REFUSED: a production promote with no approval id" 1 - - $B PLAN_EVENT=workflow_dispatch PLAN_REF=refs/heads/main PLAN_IN_APPROVAL_ID= PLAN_IN_KIND=promote PLAN_IN_ENVIRONMENT=production
expect_plan "REFUSED: an approval id with shell characters" 1 - - $B PLAN_EVENT=workflow_dispatch PLAN_REF=refs/heads/main 'PLAN_IN_APPROVAL_ID=abc;rm -rf' PLAN_IN_KIND=rebuild
expect_plan "REFUSED: an unknown kind" 1 - - $D PLAN_IN_KIND=deploy
expect_plan "REFUSED: an unknown environment" 1 - - $D PLAN_IN_KIND=rebuild PLAN_IN_ENVIRONMENT=prod
expect_plan "REFUSED: a malformed published_at" 1 - - $D PLAN_IN_KIND=publish PLAN_IN_PUBLISHED_AT=yesterday
expect_plan "REFUSED: a dispatch from a non-default branch" 1 - - $B PLAN_EVENT=workflow_dispatch PLAN_REF=refs/heads/feature PLAN_IN_APPROVAL_ID=0192f0aa-1111-7000-8000-00000000000a PLAN_IN_KIND=rebuild
expect_plan "an event it does not know deploys nothing" 0 false staging $B PLAN_EVENT=schedule PLAN_REF=refs/heads/main
plan $B PLAN_EVENT=push 'PLAN_REF=refs/heads/x$(touch /tmp/pwn)'
if ! printf '%s' "$P_OUT" | grep -q '[$`;]'; then ok "plan: a hostile ref name is never echoed back with shell syntax"; else bad "plan: a hostile ref name was echoed" "$P_OUT"; fi

# ================================================================ write-stamp.sh
SD="$T/stamp"; mkdir -p "$SD"
SH=0123456789abcdef0123456789abcdef01234567
STAMP_BUILD_ID="123456-1-0123456789ab" STAMP_COMMIT=$SH STAMP_KIND=static STAMP_ENVIRONMENT=staging STAMP_PULLED_AT=2026-10-13T10:00:00Z \
  STAMP_TRIGGER=workflow_dispatch STAMP_RUN_ID=123456 STAMP_RUN_ATTEMPT=1 STAMP_APPROVAL_ID=0192f0aa-1111-7000-8000-00000000000a STAMP_PUBLISHED_AT=2026-10-13T09:59:00Z \
  bash "$HERE/write-stamp.sh" "$SD" >/dev/null
s="$SD/webdesk-build.json"
check "stamp: valid JSON" "$(jq -e . <"$s" >/dev/null 2>&1; echo $?)"
check "stamp: carries buildId (what deploy.sh reads)" "$([ "$(jq -r .buildId <"$s" | tr -d '\r')" = 123456-1-0123456789ab ] && echo 0 || echo 1)"
check "stamp: keeps WSK-60's fields (source webdesk, pulledAt, maxUpdatedAt/itemCount/sourceSha256 present and null)" \
  "$(jq -e '.source == "webdesk" and .pulledAt == "2026-10-13T10:00:00Z" and (has("maxUpdatedAt") and .maxUpdatedAt == null) and (has("itemCount") and .itemCount == null) and (has("sourceSha256") and .sourceSha256 == null)' <"$s" >/dev/null 2>&1; echo $?)"
check "stamp: commit, run, kind, environment, approval and publish time recorded" \
  "$(jq -e --arg c "$SH" '.commit == $c and .runId == 123456 and .kind == "static" and .environment == "staging" and .approvalId != null and .publishedAt == "2026-10-13T09:59:00Z"' <"$s" >/dev/null 2>&1; echo $?)"
STAMP_BUILD_ID="bad id!" STAMP_COMMIT=$SH STAMP_KIND=static STAMP_ENVIRONMENT=staging STAMP_PULLED_AT=x STAMP_TRIGGER=push STAMP_RUN_ID=1 STAMP_RUN_ATTEMPT=1 bash "$HERE/write-stamp.sh" "$SD" >/dev/null 2>&1
check "stamp: an unusable build id is refused" "$([ $? = 2 ] && echo 0 || echo 1)"

# ================================================================ deploy-from-secret.sh against a stub deploy.sh
mkdir -p "$T/bin"
cp "$HERE/deploy-from-secret.sh" "$HERE/make-manifest.sh" "$T/bin/"
cat >"$T/bin/deploy.sh" <<'STUB'
#!/usr/bin/env bash
# stub: records what deploy.sh would have been handed. The credential is recorded only as present/absent.
{
  env | grep '^DEPLOY_' | grep -v -e '^DEPLOY_PASSWORD=' -e '^DEPLOY_SSH_KEY=' | LC_ALL=C sort
  [ -z "${DEPLOY_PASSWORD:-}" ] || echo "DEPLOY_PASSWORD=<present, ${#DEPLOY_PASSWORD} chars>"
  [ -z "${DEPLOY_SSH_KEY:-}" ] || echo "DEPLOY_SSH_KEY=<present>"
  [ -z "${DEPLOY_SECRET_JSON:-}" ] || echo "LEAK: DEPLOY_SECRET_JSON is still in the environment"
  if [ -n "${DEPLOY_MANIFEST:-}" ] && [ -d "${DEPLOY_ARTIFACT_DIR:-}" ]; then
    # while the script's temp dir still exists: is the manifest exactly the artifact it is about to upload, and what are its paths?
    tab="$(printf '\t')"
    "$(dirname "$0")/make-manifest.sh" "$DEPLOY_ARTIFACT_DIR" | LC_ALL=C sort -t "$tab" -k3,3 >"$STUB_OUT.disk"
    LC_ALL=C sort -t "$tab" -k3,3 "$DEPLOY_MANIFEST" >"$STUB_OUT.mf"
    if cmp -s "$STUB_OUT.disk" "$STUB_OUT.mf"; then echo "MANIFEST_MATCHES_ARTIFACT=yes"; else echo "MANIFEST_MATCHES_ARTIFACT=no"; fi
    echo "MANIFEST_PATHS=$(cut -f3 "$STUB_OUT.mf" | tr '\n' ' ')"
  fi
} >"$STUB_OUT"
exit 0
STUB
chmod +x "$T/bin/"*.sh

sec_sftp() { jq -n --arg pw "$CANARY" '{version:1, environment:"staging", transport:"sftp", host:"sftp.example.test", port:2222, user:"acme_stg", password:$pw,
  knownHosts:"[sftp.example.test]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", remoteBase:"/home/acme/stg", docroot:"public_html", siteUrl:"https://staging.acme.example/"}' | tr -d '\r'; }
sec_ftps() { jq -n --arg pw "$CANARY" '{version:1, environment:"staging", transport:"ftps", host:"ftp.example.test", user:"acme_stg", password:$pw,
  certSha256:"AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99", checkHostname:false,
  remoteBase:"/stg", docroot:"public_html", siteUrl:"https://staging.acme.example"}' | tr -d '\r'; }

mkstatic() { rm -rf "$T/static"; mkdir -p "$T/static/art"; echo '<html></html>' >"$T/static/art/index.html"; echo '{"buildId":"b1"}' >"$T/static/art/webdesk-build.json"
  bash "$HERE/make-manifest.sh" "$T/static/art" >"$T/static/manifest.tsv"; }
dfs() { # dfs <name-of-secret-fn-or-literal-json-var> KEY=VAL...  (runs the copied scripts with the stub; sets D_RC, D_OUT, and $T/rec)
  local secret="$1"; shift
  rm -f "$T/rec"
  D_OUT="$(env -i PATH="$PATH" HOME="$T" DEPLOY_SECRET_JSON="$secret" STUB_OUT="$T/rec" "$@" bash "$T/bin/deploy-from-secret.sh" 2>&1)"; D_RC=$?
}
rec() { sed -n "s/^$1=//p" "$T/rec" | head -1; }

mkstatic
STATIC="DEPLOY_SITE_KIND=static DEPLOY_ENVIRONMENT=staging DEPLOY_ARTIFACT_DIR=$T/static/art DEPLOY_MANIFEST=$T/static/manifest.tsv DEPLOY_BUILD_ID=b1"
dfs "$(sec_sftp)" $STATIC
check "secret: a valid sftp secret is mapped and deploy.sh is run" "$([ "$D_RC" = 0 ] && [ -f "$T/rec" ] && echo 0 || echo 1)" "rc=$D_RC $D_OUT"
check "secret: sftp host, port, user, base, docroot" "$([ "$(rec DEPLOY_TRANSPORT)" = sftp ] && [ "$(rec DEPLOY_HOST)" = sftp.example.test ] && [ "$(rec DEPLOY_PORT)" = 2222 ] && [ "$(rec DEPLOY_USER)" = acme_stg ] && [ "$(rec DEPLOY_REMOTE_BASE)" = /home/acme/stg ] && [ "$(rec DEPLOY_DOCROOT)" = public_html ] && echo 0 || echo 1)" "$(cat "$T/rec" 2>/dev/null | tr '\n' ' ')"
check "secret: the pinned known_hosts line and the stamp URL (trailing slash trimmed)" "$(grep -q '^DEPLOY_SFTP_KNOWN_HOSTS=\[sftp.example.test\]:2222 ssh-ed25519' "$T/rec" && [ "$(rec DEPLOY_STAMP_URL)" = https://staging.acme.example/webdesk-build.json ] && echo 0 || echo 1)"
check "secret: the artifact, manifest and build id pass straight through; static needs 1 page by default" "$([ "$(rec DEPLOY_ARTIFACT_DIR)" = "$T/static/art" ] && [ "$(rec DEPLOY_BUILD_ID)" = b1 ] && [ "$(rec DEPLOY_MIN_PAGES)" = 1 ] && echo 0 || echo 1)"
check "secret: the password reaches deploy.sh (as DEPLOY_PASSWORD) and the JSON itself does not" "$(grep -q '^DEPLOY_PASSWORD=<present' "$T/rec" && ! grep -q LEAK "$T/rec" && echo 0 || echo 1)"
check "secret: the canary password is in no output of the script" "$(printf '%s' "$D_OUT" | grep -qF "$CANARY" && echo 1 || echo 0)"

dfs "$(sec_ftps)" $STATIC
check "secret: an ftps secret maps the fingerprint (colons kept for deploy.sh to normalise), default port, hostname check off" \
  "$([ "$D_RC" = 0 ] && [ "$(rec DEPLOY_TRANSPORT)" = ftps ] && grep -q '^DEPLOY_FTPS_CERT_SHA256=AA:BB' "$T/rec" && [ "$(rec DEPLOY_FTPS_CHECK_HOSTNAME)" = no ] && [ -z "$(rec DEPLOY_PORT)" ] && echo 0 || echo 1)" "rc=$D_RC"

refuse() { # refuse <name> <secret-json> KEY=VAL...  : exit 2, deploy.sh never ran, the canary never printed
  local name="$1" secret="$2"; shift 2
  dfs "$secret" "$@"
  local why=""
  [ "$D_RC" = 2 ] || why="exit $D_RC (wanted 2): $D_OUT"
  [ ! -f "$T/rec" ] || why="$why; deploy.sh WAS run"
  printf '%s' "$D_OUT" | grep -qF "$CANARY" && why="$why; the canary was printed"
  if [ -z "$why" ]; then ok "secret: REFUSED, $name  [$(printf '%s' "$D_OUT" | grep -v '^deploy-from-secret:   -' | tail -1 | cut -c1-120)]"; else bad "secret: $name" "$why"; fi
}
refuse "not JSON" "this is not json" $STATIC
refuse "a JSON array" '[1,2]' $STATIC
refuse "an unknown field (a typo is caught, not ignored)" "$(sec_sftp | jq '. + {pasword:"x"}' | tr -d '\r')" $STATIC
refuse "plain ftp" "$(sec_sftp | jq '.transport="ftp"' | tr -d '\r')" $STATIC
refuse "sftp without a pinned host key" "$(sec_sftp | jq 'del(.knownHosts)' | tr -d '\r')" $STATIC
refuse "ftps without any pinned certificate" "$(sec_ftps | jq 'del(.certSha256)' | tr -d '\r')" $STATIC
refuse "no credential" "$(sec_sftp | jq 'del(.password)' | tr -d '\r')" $STATIC
refuse "password and key both" "$(sec_sftp | jq '. + {privateKey:"k"}' | tr -d '\r')" $STATIC
refuse "a key over ftps" "$(sec_ftps | jq 'del(.password) | . + {privateKey:"k"}' | tr -d '\r')" $STATIC
refuse "version 2" "$(sec_sftp | jq '.version=2' | tr -d '\r')" $STATIC
refuse "a port that is a string" "$(sec_sftp | jq '.port="22"' | tr -d '\r')" $STATIC
refuse "an http (not https) site URL" "$(sec_sftp | jq '.siteUrl="http://staging.acme.example"' | tr -d '\r')" $STATIC
refuse "a site URL with a query" "$(sec_sftp | jq '.siteUrl="https://a.example/?x=1"' | tr -d '\r')" $STATIC
refuse "a static secret with no docroot" "$(sec_sftp | jq 'del(.docroot)' | tr -d '\r')" $STATIC
refuse "a STAGING secret on a PRODUCTION run" "$(sec_sftp)" DEPLOY_SITE_KIND=static DEPLOY_ENVIRONMENT=production DEPLOY_ARTIFACT_DIR="$T/static/art" DEPLOY_MANIFEST="$T/static/manifest.tsv" DEPLOY_BUILD_ID=b1
refuse "an empty secret" "" $STATIC

# ---- wp: the theme and nothing else
mkwp() { # mkwp <extra-relative-path-or-empty> ; builds $T/wp/art = wp-content/themes/gaiada-webdesk/... (+ extra), its manifest and hash
  rm -rf "$T/wp"; mkdir -p "$T/wp/art/wp-content/themes/gaiada-webdesk/inc"
  echo '<?php // theme' >"$T/wp/art/wp-content/themes/gaiada-webdesk/functions.php"
  echo '<?php // inc' >"$T/wp/art/wp-content/themes/gaiada-webdesk/inc/a.php"
  echo '{"buildId":"b1"}' >"$T/wp/art/wp-content/themes/gaiada-webdesk/webdesk-build.json"
  if [ -n "${1:-}" ]; then mkdir -p "$(dirname "$T/wp/art/$1")"; echo 'x' >"$T/wp/art/$1"; fi
  bash "$HERE/make-manifest.sh" "$T/wp/art" >"$T/wp/manifest.tsv"
  WPSHA="$(sha256sum "$T/wp/manifest.tsv" | cut -c1-64)"
}
sec_wp() { sec_sftp | jq '.remoteBase="/srv/wp" | del(.docroot)' | tr -d '\r'; }
wpenv() { echo "DEPLOY_SITE_KIND=wp DEPLOY_ENVIRONMENT=staging DEPLOY_WP_THEME=gaiada-webdesk DEPLOY_ARTIFACT_DIR=$T/wp/art DEPLOY_MANIFEST=$T/wp/manifest.tsv DEPLOY_BUILD_ID=b1 DEPLOY_MANIFEST_SHA256=$WPSHA"; }

mkwp ""
dfs "$(sec_wp)" $(wpenv)
check "wp: a theme-only artifact is mapped: docroot = the theme, parent = themes/, releases and lock in wp-content/.webdesk-deploy" \
  "$([ "$D_RC" = 0 ] && [ "$(rec DEPLOY_DOCROOT)" = gaiada-webdesk ] && [ "$(rec DEPLOY_DOCROOT_PARENT)" = /srv/wp/wp-content/themes ] && [ "$(rec DEPLOY_REMOTE_BASE)" = /srv/wp/wp-content/.webdesk-deploy ] && [ "$(rec DEPLOY_CREATE_BASE)" = yes ] && echo 0 || echo 1)" "rc=$D_RC $(tr '\n' ' ' <"$T/rec" 2>/dev/null)"
check "wp: deploy.sh gets the THEME directory as its artifact, a manifest relative to it, and the theme's own stamp URL" \
  "$([ "$(rec DEPLOY_ARTIFACT_DIR)" = "$T/wp/art/wp-content/themes/gaiada-webdesk" ] && [ "$(rec DEPLOY_STAMP_URL)" = https://staging.acme.example/wp-content/themes/gaiada-webdesk/webdesk-build.json ] && [ "$(rec DEPLOY_MIN_PAGES)" = 0 ] && echo 0 || echo 1)"
check "wp: the manifest deploy.sh gets matches the theme directory exactly and lists theme-relative paths only" \
  "$([ "$(rec MANIFEST_MATCHES_ARTIFACT)" = yes ] && ! rec MANIFEST_PATHS | grep -q wp-content && rec MANIFEST_PATHS | grep -q functions.php && echo 0 || echo 1)" "$(rec MANIFEST_PATHS)"

mkwp "wp-config.php"
refuse "wp: an artifact that holds wp-config.php beside the theme" "$(sec_wp)" $(wpenv)
mkwp "wp-content/plugins/other/evil.php"
refuse "wp: an artifact that holds another plugin" "$(sec_wp)" $(wpenv)
mkwp "wp-content/uploads/2026/x.jpg"
refuse "wp: an artifact that holds uploads" "$(sec_wp)" $(wpenv)
mkwp "wp-content/themes/gaiada-webdesk-evil/x.php"
refuse "wp: a sibling theme whose name merely starts like the theme" "$(sec_wp)" $(wpenv)
mkwp ""
echo '<?php // sneaked in after the manifest' >"$T/wp/art/wp-config.php"
refuse "wp: a file on disk that the manifest does not list" "$(sec_wp)" $(wpenv)
mkwp ""
echo 'tampered' >>"$T/wp/art/wp-content/themes/gaiada-webdesk/functions.php"
refuse "wp: a theme file changed after its manifest was made" "$(sec_wp)" $(wpenv)
mkwp ""
refuse "wp: a manifest that does not match the hash the build job pinned" "$(sec_wp)" $(wpenv | sed 's/DEPLOY_MANIFEST_SHA256=[0-9a-f]*/DEPLOY_MANIFEST_SHA256=0000000000000000000000000000000000000000000000000000000000000000/')
mkwp ""
mkdir -p "$T/wp/art/wp-content/plugins"
refuse "wp: an (empty) directory outside the theme" "$(sec_wp)" $(wpenv)
mkwp ""
refuse "wp: no theme named" "$(sec_wp)" $(wpenv | sed 's/DEPLOY_WP_THEME=gaiada-webdesk/DEPLOY_WP_THEME=/')
refuse "wp: a theme name that climbs" "$(sec_wp)" $(wpenv | sed 's|DEPLOY_WP_THEME=gaiada-webdesk|DEPLOY_WP_THEME=../x|')

# ---- rollback needs no artifact
dfs "$(sec_sftp)" DEPLOY_SITE_KIND=static DEPLOY_ENVIRONMENT=staging DEPLOY_MODE=rollback
check "rollback: maps the secret and needs no artifact" "$([ "$D_RC" = 0 ] && [ "$(rec DEPLOY_MODE)" = rollback ] && [ -z "$(rec DEPLOY_ARTIFACT_DIR)" ] && echo 0 || echo 1)" "rc=$D_RC $D_OUT"

echo
echo "### scripts passed: $PASSN, failed: $FAILN"
[ "$FAILN" = 0 ] && { echo "### deploy-scripts PASS"; exit 0; }
echo "### deploy-scripts FAIL"; exit 1
