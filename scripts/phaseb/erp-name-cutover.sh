#!/usr/bin/env bash
#
# ERP names, Phase B2 + B3 (docs/plans/2026-10-11-erp-names-on-gaiada-com.md §3; runbook
# infra/runbooks/erp-name-cutover.md): move the ERP from erp.gaiada.online to erp.gaiada.com on gda-aicenter.
#
# Runs ON gda-aicenter as the deploy user (sudo -n for nginx, /etc/webdesk and certbot files). One stage per
# call so the laptop-side runner (scripts/phaseb/run-erp-name-cutover.sh) can prove each one, including a real
# headless SSO login it alone has credentials for, and roll everything back the moment a check fails:
#
#   erp-name-cutover.sh preflight            read-only; exit 0 only if every precondition holds
#   erp-name-cutover.sh backup               copies every file the later stages touch; prints the backup dir
#   erp-name-cutover.sh nginx                the vhost answers BOTH names (legacy redirect OFF); reload
#   erp-name-cutover.sh identity             Keycloak hostname + platform/UI/WebDesk settings to the new name
#   erp-name-cutover.sh redirect             browser GETs on the legacy name -> 301 to the new name
#   erp-name-cutover.sh n8n                  n8n's public URLs to the new name
#   erp-name-cutover.sh github-hook          the gaiada-erp App's webhook URL to the new name (GitHub API)
#   erp-name-cutover.sh rollback <dir>       restore every file from <dir>, recreate the services, reload nginx
#
# Every stage is idempotent and ends with its own checks; a failed check exits non-zero and changes nothing
# further. The staged nginx files are expected next to this script: erp.gaiada.online.conf,
# erp-legacy-redirect.off.conf, erp-legacy-redirect.on.conf (shipped by the runner from infra/nginx/).
#
# WHAT STAYS ON THE LEGACY NAME, ON PURPOSE: /api/webhooks/, /api/mail/, /n8n…, /idp/ and ACME keep being
# served on erp.gaiada.online (see the vhost maps), so an outside caller that still has the old URL keeps
# working. Retiring them is Phase B4, after two quiet weeks.

set -euo pipefail

NEW=erp.gaiada.com
OLD=erp.gaiada.online
ISS_NEW="https://$NEW/idp/realms/gaiada"
ISS_OLD="https://$OLD/idp/realms/gaiada"

HERE="$(cd "$(dirname "$0")" && pwd)"
GAIADA=/home/Hansel/gaiada
GENV=$GAIADA/infra/compose/.env
AENV=$GAIADA/automation/.env
WENV=/etc/webdesk/.env
WCTL=/etc/webdesk/.env.control
WDIR=/home/Hansel/gaiada-webdesk/webdesk
VHOST=/etc/nginx/sites-available/erp.gaiada.online
SNIP=/etc/nginx/snippets/erp-legacy-redirect.conf
CERT=/etc/letsencrypt/live/$NEW/fullchain.pem
BACKUP_ROOT=/home/Hansel/backups
MIN_TAG="${MIN_TAG:-}"

say()  { printf '\n==> %s\n' "$*"; }
ok()   { printf '  ok   %s\n' "$*"; }
die()  { printf '  FAIL %s\n' "$*" >&2; exit 1; }

# ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
tagnum() { local t="${1##*alpha.}"; [[ "$t" =~ ^[0-9]+$ ]] && echo "$t" || echo 0; }
deployed_tag() { cat "$GAIADA/.deployed-tag"; }

# The SAME invocation deploy.yml uses (repo variables COMPOSE_FILES / COMPOSE_PROFILES), with the tag that is
# deployed right now. A bare `up -d` would read GAIADA_TAG from .env and could silently roll images back.
gaiada_compose() {
  local tag; tag="$(deployed_tag)"
  ( cd "$GAIADA/infra/compose" && GAIADA_TAG="$tag" GHCR_OWNER=hansel-gaiada APP_VERSION="${tag#v}" \
      COMPOSE_PROFILES=bot,auth,whisper,mail-dev,scan \
      docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml -f docker-compose.observability.yml "$@" )
}
webdesk_compose() {
  ( cd "$WDIR" && sudo -n docker compose --env-file "$WENV" -f docker-compose.yml -f docker-compose.aicenter.yml "$@" )
}
n8n_compose() {
  ( cd "$GAIADA/automation" && docker compose -f docker-compose.yml -f docker-compose.vpsnet.yml "$@" )
}

# getenv FILE KEY  /  setenv FILE KEY VALUE  — line-oriented; values here never contain '|' or spaces.
getenv() { sudo -n grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
setenv() {
  local f="$1" k="$2" v="$3"
  if sudo -n grep -qE "^$k=" "$f"; then sudo -n sed -i -E "s|^$k=.*$|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" | sudo -n tee -a "$f" >/dev/null; fi
  [ "$(getenv "$f" "$k")" = "$v" ] || die "could not set $k in $f"
}

code()  { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" || echo 000; }
where() { curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$@" || true; }
issuer_of() { curl -fsS --max-time 20 "$1/.well-known/openid-configuration" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["issuer"])' 2>/dev/null || echo "?"; }

wait_for() {  # wait_for <seconds> <description> <command...>
  local n="$1" what="$2"; shift 2
  for _ in $(seq 1 "$n"); do if "$@" >/dev/null 2>&1; then ok "$what"; return 0; fi; sleep 1; done
  die "$what (gave up after ${n}s)"
}
kc_issuer_is() { [ "$(issuer_of http://127.0.0.1:8080/idp/realms/gaiada)" = "$1" ]; }
http_ok()      { [ "$(code "$1")" = "200" ]; }
redirects_to() { [ "$(where "$1")" = "$2" ]; }
# After `systemctl reload nginx` the old workers keep accepting for a moment, so a request fired at once can get
# the OLD config (the first cut-over attempt, 2026-10-11, failed exactly so and rolled back). Retry, then explain.
expect_200() {  # expect_200 <url>
  local u="$1"
  for _ in $(seq 1 20); do http_ok "$u" && { ok "$u 200"; return 0; }; sleep 1; done
  die "$u is not 200 after 20 s: $(curl -s -o /dev/null -w 'code=%{http_code} ssl_verify=%{ssl_verify_result} location=%{redirect_url}' --max-time 20 "$u")"
}
expect_redirect() {  # expect_redirect <url> <location>
  for _ in $(seq 1 20); do redirects_to "$1" "$2" && { ok "GET $1 -> $2"; return 0; }; sleep 1; done
  die "GET $1 redirects to '$(where "$1")', expected '$2'"
}
webdesk_up()   { docker logs --since "$1" webdesk-api-1 2>&1 | grep -q 'listening on :3000'; }

nginx_install_and_reload() {  # nginx_install_and_reload <on|off>
  sudo -n install -m 0644 "$HERE/erp-legacy-redirect.$1.conf" "$SNIP"
  sudo -n install -m 0644 "$HERE/erp.gaiada.online.conf" "$VHOST"
  sudo -n sed -i 's/\r$//' "$VHOST" "$SNIP"
  sudo -n nginx -t 2>&1 | tail -1
  sudo -n nginx -t >/dev/null 2>&1 || die "nginx -t refused the staged vhost (redirect $1)"
  sudo -n systemctl reload nginx
  ok "nginx reloaded (legacy redirect $1)"
}

# ── stages ───────────────────────────────────────────────────────────────────────────────────────────────
preflight() {
  say "preflight (read-only)"
  [ -n "$MIN_TAG" ] || die "MIN_TAG is required (the first release carrying Phase B0)"
  local tag; tag="$(deployed_tag)"
  [ "$(tagnum "$tag")" -ge "$(tagnum "$MIN_TAG")" ] || die "deployed $tag is older than $MIN_TAG (B0 not live)"; ok "deployed $tag >= $MIN_TAG"
  docker inspect gaiada-platform-ui-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q '^ALLOWED_ORIGINS=' \
    || die "platform-ui has no ALLOWED_ORIGINS in its environment (compose passthrough not deployed)"; ok "platform-ui takes ALLOWED_ORIGINS"
  docker exec gaiada-platform-1 sh -c 'test -f /app/dist/auth/oidc-issuers.js' || die "platform image cannot take an issuer list"; ok "platform takes an issuer list"
  docker exec webdesk-api-1 sh -c 'grep -rlq parseIssuerList /app/dist' || die "webdesk-api image cannot take an issuer list"; ok "webdesk-api takes an issuer list"
  local san; san="$(sudo -n openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tr -d ' \n')"
  [[ "$san" == *"DNS:$NEW"* && "$san" == *"DNS:$OLD"* ]] || die "certificate $CERT does not cover both names ($san)"; ok "certificate covers $NEW and $OLD"
  getent ahostsv4 "$NEW" | grep -q '35.240.135.48' || die "$NEW does not resolve to 35.240.135.48"; ok "$NEW resolves to this box"
  docker exec gaiada-keycloak-1 sh -c 'K=/opt/keycloak/bin/kcadm.sh; $K config credentials --config /tmp/kcpf.cfg --server http://localhost:8080/idp --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null 2>&1 || exit 3
    for c in gaiada-platform gaiada-ui; do $K get clients -r gaiada --config /tmp/kcpf.cfg -q clientId=$c --fields redirectUris | grep -q "https://erp.gaiada.com/\*" || exit 4; done; rm -f /tmp/kcpf.cfg' \
    || die "a Keycloak client lacks https://$NEW/* (B1 incomplete)"; ok "Keycloak clients list https://$NEW/*"
  for f in erp.gaiada.online.conf erp-legacy-redirect.off.conf erp-legacy-redirect.on.conf; do [ -s "$HERE/$f" ] || die "staged $f missing next to the script"; done
  local T; for mode in off on; do
    T="$(sudo -n mktemp -d)"; sudo -n cp -a /etc/nginx/. "$T/"; sudo -n rm -f "$T/sites-enabled/erp.gaiada.online"
    sudo -n cp "$HERE/erp.gaiada.online.conf" "$T/sites-enabled/erp.gaiada.online"; sudo -n cp "$HERE/erp-legacy-redirect.$mode.conf" "$T/snippets/erp-legacy-redirect.conf"
    sudo -n sed -i 's/\r$//' "$T/sites-enabled/erp.gaiada.online" "$T/snippets/erp-legacy-redirect.conf"
    sudo -n sed -i "s#/etc/nginx/#$T/#g" "$T/nginx.conf"
    for l in "$T"/sites-enabled/*; do [ -L "$l" ] && { local t; t="$(readlink "$l")"; sudo -n rm "$l"; sudo -n cp "$t" "$l"; }; done
    sudo -n nginx -t -c "$T/nginx.conf" -p "$T" >/dev/null 2>&1 || { sudo -n rm -rf "$T"; die "staged vhost fails nginx -t (redirect $mode)"; }
    sudo -n rm -rf "$T"
  done; ok "staged vhost passes nginx -t (redirect off and on)"
  [ "$(code "https://$OLD/login")" = "200" ] || die "the ERP is not healthy on $OLD before the cut-over"; ok "$OLD/login 200 now"
  say "preflight passed"
}

backup() {
  local d; d="$BACKUP_ROOT/erp-name-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$d"
  cp -p "$GENV" "$d/gaiada.env"; cp -p "$AENV" "$d/automation.env"
  sudo -n cp -p "$WENV" "$d/webdesk.env"; sudo -n cp -p "$WCTL" "$d/webdesk.env.control"
  sudo -n cp -p "$VHOST" "$d/erp.gaiada.online.vhost"
  sudo -n test -f "$SNIP" && sudo -n cp -p "$SNIP" "$d/erp-legacy-redirect.conf" || true
  sudo -n chown -R "$(id -u):$(id -g)" "$d"; chmod 700 "$d"; chmod 600 "$d"/*
  deployed_tag > "$d/deployed-tag"
  for c in gaiada-keycloak-1 gaiada-platform-1 gaiada-platform-ui-1 gaiada-automation-n8n-1 webdesk-api-1; do
    printf '%s %s\n' "$c" "$(docker inspect "$c" --format '{{.Config.Image}} {{.Image}}')"; done > "$d/images"
  echo "$d"
}

stage_nginx() {
  say "nginx: one server, both names, legacy redirect OFF"
  nginx_install_and_reload off
  expect_200 "https://$NEW/login"
  expect_200 "https://$OLD/login"
  local c; c="$(code -X POST "https://$OLD/api/webhooks/github")"
  [[ "$c" =~ ^(400|401|403|415|422)$ ]] || die "the GitHub webhook path on $OLD answered $c (expected a refusal, not a redirect or 404)"; ok "webhook path on $OLD still served ($c without a signature)"
}

stage_identity() {
  say "identity: Keycloak, platform, platform-ui and WebDesk move to $NEW"
  setenv "$GENV" KC_HOSTNAME "https://$NEW/idp"
  setenv "$GENV" OIDC_ISSUER "$ISS_NEW,$ISS_OLD"
  setenv "$GENV" OIDC_AUTH_URL "$ISS_NEW/protocol/openid-connect/auth"
  setenv "$GENV" OIDC_REDIRECT_URI "https://$NEW/auth/callback"
  setenv "$GENV" PUBLIC_ORIGIN "https://$NEW"
  setenv "$GENV" ALLOWED_ORIGINS "https://$NEW,https://$OLD"
  setenv "$GENV" AUTOMATION_PUBLIC_URL "https://$NEW/n8n/"
  setenv "$GENV" MAIL_LINK_BASE_URL "https://$NEW"
  bash -n "$GENV" || die "$GENV no longer parses as bash (deploy's backup gate needs that)"
  setenv "$WCTL" WEBDESK_CONTROL_OIDC_ISSUER "$ISS_NEW,$ISS_OLD"
  setenv "$WENV" WEBDESK_UPLOAD_CORS_ORIGINS "https://$NEW,https://$OLD"
  ok "settings written"

  gaiada_compose up -d --no-deps --no-build keycloak platform platform-ui
  wait_for 180 "Keycloak issues for $ISS_NEW" kc_issuer_is "$ISS_NEW"
  wait_for 120 "platform /health 200" http_ok http://127.0.0.1:3004/health
  wait_for 120 "platform-ui /login 200" http_ok http://127.0.0.1:3005/login
  local since; since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  webdesk_compose up -d --no-deps --no-build --force-recreate api
  wait_for 120 "webdesk-api listening again" webdesk_up "$since"
  docker exec webdesk-api-1 sh -c 'echo "$WEBDESK_CONTROL_OIDC_ISSUER"' | grep -qx "$ISS_NEW,$ISS_OLD" || die "webdesk-api did not pick up the issuer list"; ok "webdesk-api takes $ISS_NEW,$ISS_OLD"

  [ "$(issuer_of "$ISS_NEW")" = "$ISS_NEW" ] || die "public discovery on $NEW does not say $ISS_NEW"; ok "public discovery issuer = $ISS_NEW"
  local loc; loc="$(where "https://$NEW/auth/login")"
  [[ "$loc" == "$ISS_NEW/protocol/openid-connect/auth"* ]] || die "/auth/login on $NEW sends the browser to '$loc'"; ok "/auth/login on $NEW -> Keycloak on $NEW"
}

stage_redirect() {
  say "legacy redirect ON: browser GETs on $OLD -> https://$NEW"
  nginx_install_and_reload on
  expect_redirect "https://$OLD/login?x=1" "https://$NEW/login?x=1"
  expect_200 "https://$NEW/login"
  local c; c="$(code -X POST "https://$OLD/api/webhooks/github")"
  [[ "$c" =~ ^(400|401|403|415|422)$ ]] || die "the webhook path on $OLD answered $c"; ok "POST webhook on $OLD still served ($c)"
  [ "$(issuer_of "$ISS_OLD")" = "$ISS_NEW" ] || die "/idp on $OLD is not served"; ok "/idp still served on $OLD (issuer $ISS_NEW)"
  [ "$(code "https://$OLD/n8n/rest/oauth2-credential/callback")" != "301" ] || die "/n8n on $OLD was redirected"; ok "/n8n not redirected on $OLD"
}

stage_n8n() {
  say "n8n: public URLs to $NEW"
  setenv "$AENV" N8N_HOST "$NEW"
  setenv "$AENV" N8N_WEBHOOK_URL "https://$NEW/n8n/"
  setenv "$AENV" N8N_EDITOR_BASE_URL "https://$NEW/n8n/"
  n8n_compose up -d --no-deps --no-build n8n
  wait_for 120 "n8n healthz" http_ok http://127.0.0.1:5678/healthz
  docker exec gaiada-automation-n8n-1 sh -c 'echo "$N8N_EDITOR_BASE_URL"' | grep -qx "https://$NEW/n8n/" || die "n8n did not pick up the new editor URL"; ok "n8n editor URL https://$NEW/n8n/"
  local c; c="$(code "https://$NEW/n8n/signin")"; [ "$c" = "200" ] || [ "$c" = "401" ] || die "https://$NEW/n8n/signin answered $c"; ok "https://$NEW/n8n/signin $c"
}

stage_github_hook() {
  say "the gaiada-erp GitHub App's webhook URL -> https://$NEW/api/webhooks/github"
  docker exec -i -e HOOK_URL="https://$NEW/api/webhooks/github" gaiada-platform-1 node - < "$HERE/github-app-hook.cjs"
}

rollback() {
  local d="${1:?usage: rollback <backup dir>}"
  [ -s "$d/gaiada.env" ] || die "$d is not a cut-over backup"
  say "ROLLBACK from $d"
  cp -p "$d/gaiada.env" "$GENV"; cp -p "$d/automation.env" "$AENV"
  sudo -n cp "$d/webdesk.env" "$WENV"; sudo -n cp "$d/webdesk.env.control" "$WCTL"
  sudo -n chown webdesk-svc:webdesk-svc "$WENV" "$WCTL"; sudo -n chmod 600 "$WENV" "$WCTL"
  sudo -n cp "$d/erp.gaiada.online.vhost" "$VHOST"
  if [ -f "$d/erp-legacy-redirect.conf" ]; then sudo -n cp "$d/erp-legacy-redirect.conf" "$SNIP"; else sudo -n install -m 0644 "$HERE/erp-legacy-redirect.off.conf" "$SNIP"; fi
  sudo -n nginx -t >/dev/null 2>&1 && sudo -n systemctl reload nginx && ok "nginx restored" || echo "  WARN nginx -t failed after restore; nginx left on its last good config"
  gaiada_compose up -d --no-deps --no-build keycloak platform platform-ui
  local since; since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  webdesk_compose up -d --no-deps --no-build --force-recreate api
  n8n_compose up -d --no-deps --no-build n8n
  wait_for 180 "Keycloak issues for $ISS_OLD again" kc_issuer_is "$ISS_OLD"
  wait_for 120 "platform-ui /login 200" http_ok http://127.0.0.1:3005/login
  wait_for 120 "webdesk-api listening again" webdesk_up "$since"
  expect_200 "https://$OLD/login"
  say "rollback complete"
}

case "${1:-}" in
  preflight)   preflight ;;
  backup)      backup ;;
  nginx)       stage_nginx ;;
  identity)    stage_identity ;;
  redirect)    stage_redirect ;;
  n8n)         stage_n8n ;;
  github-hook) stage_github_hook ;;
  rollback)    rollback "${2:-}" ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac
