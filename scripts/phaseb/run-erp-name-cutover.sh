#!/usr/bin/env bash
#
# ERP names Phase B2 + B3, operator side: drive scripts/phaseb/erp-name-cutover.sh on gda-aicenter stage by stage,
# prove each stage (including a REAL headless SSO login on the new name), and roll everything back on the first
# failure. Needs no owner step (owner 2026-10-11: "automated so it doesn't need me anymore").
#
#   MIN_TAG=v1.0.0-alpha.NNN ERP_USER=<email> ERP_PASS=<password> bash scripts/phaseb/run-erp-name-cutover.sh
#   ... --preflight-only     ships the files and runs the read-only preflight, nothing else
#
# MIN_TAG is the first release carrying Phase B0 (prefixed cookies, the Origin allow-list, the issuer lists).
# ERP_USER/ERP_PASS: a staff login that can read the Website workspace (the operator's own); the password is
# only ever passed to sso-login.sh, never printed. Run from the repo root of a checkout of the release.
#
# Users sign in once more afterwards (the session cookie is per host, and B0 renamed it anyway).

set -Eeuo pipefail   # -E: the ERR trap (rollback) also fires inside functions

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BOX="${BOX:-gda-aicenter}"
OBS="${OBS:-sumopod}"
NEW=erp.gaiada.com
OLD=erp.gaiada.online
TENANT_GDA=019fb652-c68b-728f-b779-04465fcec5ae
REMOTE_DIR=/home/Hansel/gaiada/phaseb
OBS_TARGETS=/home/ubuntu/gaiada-obs/infra/observability/prometheus/targets/blackbox-estate.json
: "${MIN_TAG:?MIN_TAG is required}"

say() { printf '\n######## %s\n' "$*"; }
R() { ssh -o BatchMode=yes -o ConnectTimeout=20 "$BOX" "cd '$REMOTE_DIR' && MIN_TAG='$MIN_TAG' bash erp-name-cutover.sh $*"; }

say "shipping the cut-over files to $BOX:$REMOTE_DIR"
( cd "$ROOT" && tar -cf - \
    --transform 's#^infra/nginx/snippets/##; s#^infra/nginx/##; s#^scripts/phaseb/##' \
    infra/nginx/erp.gaiada.online.conf infra/nginx/snippets/erp-legacy-redirect.off.conf \
    infra/nginx/snippets/erp-legacy-redirect.on.conf scripts/phaseb/erp-name-cutover.sh scripts/phaseb/github-app-hook.cjs ) \
  | ssh -o BatchMode=yes "$BOX" "mkdir -p '$REMOTE_DIR' && tar -xf - -C '$REMOTE_DIR' && sed -i 's/\r$//' '$REMOTE_DIR'/*"

R preflight
[ "${1:-}" = "--preflight-only" ] && { say "preflight only: nothing changed"; exit 0; }
: "${ERP_USER:?ERP_USER is required}"; : "${ERP_PASS:?ERP_PASS is required}"

BACKUP="$(R backup | tail -1)"
say "backup: $BOX:$BACKUP"
rollback() { say "a stage failed: ROLLING BACK"; R rollback "'$BACKUP'" || say "ROLLBACK FAILED: restore by hand from $BOX:$BACKUP (runbook infra/runbooks/erp-name-cutover.md)"; exit 1; }
trap rollback ERR

# A real authorization_code + PKCE login on the NEW name, then the API with that token, then one call that crosses
# the ERP -> WebDesk control channel (Keycloak client-credentials token, new issuer, WebDesk's issuer list).
login_check() {
  say "proof: headless SSO login on https://$NEW"
  local token me sites
  token="$(ERP_BASE="https://$NEW" bash "$ROOT/scripts/sso-login.sh" "$ERP_USER" "$ERP_PASS")"
  [ -n "$token" ] || { echo "  FAIL no token from the login on $NEW"; return 1; }
  me="$(printf '%s' "$token" | ssh -o BatchMode=yes "$BOX" 'read -r T; curl -s -H "authorization: Bearer $T" http://127.0.0.1:3004/api/me')"
  printf '%s' "$me" | python -c 'import json,sys,os; m=json.load(sys.stdin); e=m.get("email") or m.get("user",{}).get("email"); assert e==os.environ["ERP_USER"], e; print("  ok   /api/me as", e)' \
    || { echo "  FAIL /api/me did not return $ERP_USER"; return 1; }
  sites="$(printf '%s' "$token" | ssh -o BatchMode=yes "$BOX" "read -r T; curl -s -o /dev/null -w '%{http_code}' -H \"authorization: Bearer \$T\" http://127.0.0.1:3004/api/$TENANT_GDA/modules/webdev/content/sites")"
  [ "$sites" = "200" ] || { echo "  FAIL the control-channel read answered $sites"; return 1; }
  echo "  ok   ERP -> WebDesk control channel 200 with the new issuer"
}

R nginx
R identity
login_check
R redirect
R n8n
trap - ERR
say "core cut-over done; outside callers next (each is safe to retry: the legacy name still serves their paths)"

R github-hook || echo "  WARN the GitHub App webhook was not moved; it keeps working on $OLD. Re-run: $0 stage github-hook"
ssh -o BatchMode=yes "$OBS" "f='$OBS_TARGETS'; cp -p \"\$f\" \"\$f.bak-erp-name-\$(date -u +%Y%m%d)\"; sed -i 's|https://$OLD/login|https://$NEW/login|' \"\$f\"; grep -c 'https://$NEW/login' \"\$f\"" \
  | grep -qx 1 && echo "  ok   blackbox probes https://$NEW/login (file_sd reloads itself)" \
  || echo "  WARN the blackbox target was not rewritten on $OBS"

say "DONE. https://$NEW is the ERP; https://$OLD 301s browser GETs and keeps serving webhooks, /n8n, /idp. Backup: $BOX:$BACKUP"
