#!/usr/bin/env bash
# deploy-from-secret.sh - the deploy job's one call (M6-P6f): takes the per-site deploy secret's JSON, checks its shape,
# maps it onto deploy.sh's DEPLOY_* inputs, prepares the artifact for the site's kind, and runs deploy.sh.
# The secret's shape is defined, field by field, in README.md ("The per-site deploy secret").
#
# Inputs, all environment (the secret never goes on a command line):
#   DEPLOY_SECRET_JSON      the per-site secret's content (read, then unset, before anything else runs)
#   DEPLOY_SITE_KIND        static | wp         (a fullstack site's static apps/web export is "static")
#   DEPLOY_ENVIRONMENT      staging | production | development; must equal the secret's own `environment`
#   DEPLOY_ARTIFACT_DIR     the downloaded artifact; DEPLOY_MANIFEST its manifest; DEPLOY_MANIFEST_SHA256 the hash the BUILD job
#                           printed for that manifest (the pin that makes the manifest tamper-evident)
#   DEPLOY_BUILD_ID         the build id the stamp must show
#   DEPLOY_WP_THEME         wp only: the one theme directory this deploy may write
#   DEPLOY_MODE=rollback    optional: roll back instead (needs no artifact)
#   any other DEPLOY_* that deploy.sh reads (DEPLOY_MIN_FILES, DEPLOY_MIN_PAGES, DEPLOY_KEEP, ...) passes straight through.
#
# What it refuses (exit 2, before any connection): a secret that is not valid JSON or has an unknown, missing or malformed field
# (the message names the FIELD, never a value); a secret made for another environment; plain FTP; and, for wp, an artifact that
# holds ANYTHING outside wp-content/themes/<theme>/, that does not match its manifest, or whose manifest does not match the pin.
#
# What wp deploys: ONLY wp-content/themes/<theme>/. The releases and the lock live in wp-content/.webdesk-deploy/ (a hidden
# directory WordPress never scans, so an old release can never show up as an installable theme), and the theme directory is
# swapped by two renames exactly as a static docroot is (deploy.sh, DEPLOY_DOCROOT_PARENT). wp-config.php, uploads/ and the
# other plugins and themes are never read or written by anything here.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$-" in *x*) echo "deploy-from-secret: refusing to run with xtrace on (the secret is in scope)" >&2; exit 2 ;; esac
die() { printf 'deploy-from-secret: FAILED: %s\n' "$*" >&2; exit 2; }
note() { printf 'deploy-from-secret: %s\n' "$*"; }

SECRET_JSON="${DEPLOY_SECRET_JSON:-}"
unset DEPLOY_SECRET_JSON
KIND="${DEPLOY_SITE_KIND:-}"
ENVIRONMENT="${DEPLOY_ENVIRONMENT:-}"
MODE="${DEPLOY_MODE:-deploy}"
THEME="${DEPLOY_WP_THEME:-}"
ART="${DEPLOY_ARTIFACT_DIR:-}"
MANIFEST="${DEPLOY_MANIFEST:-}"
MANIFEST_SHA="${DEPLOY_MANIFEST_SHA256:-}"

command -v jq >/dev/null 2>&1 || die "jq is required"
[ -n "$SECRET_JSON" ] || die "the per-site deploy secret is empty"
case "$KIND" in static | wp) ;; *) die "DEPLOY_SITE_KIND must be static or wp" ;; esac
[[ "$ENVIRONMENT" =~ ^(staging|production|development)$ ]] || die "DEPLOY_ENVIRONMENT must be staging, production or development"
case "$MODE" in deploy | rollback) ;; *) die "DEPLOY_MODE must be deploy or rollback" ;; esac

# ---------------------------------------------------------------- the secret's shape (names fields, never values)
problems="$(printf '%s' "$SECRET_JSON" | jq -r '
  def s: type == "string" and length > 0;
  def allowed: ["version","environment","transport","host","port","user","password","privateKey","knownHosts","certSha256","caPem","checkHostname","remoteBase","docroot","siteUrl"];
  if type != "object" then "the secret is not a JSON object"
  else
    . as $o
    | (
        ((keys - allowed) | map("unknown field: " + .) | .[]),
        (["environment","transport","host","user","password","privateKey","knownHosts","certSha256","caPem","remoteBase","docroot","siteUrl"][]
          | select($o[.] != null and ($o[.] | type) != "string") | . + " must be a string"),
        (if $o.version != 1 then "version must be 1" else empty end),
        (if ($o.environment | IN("staging","production","development")) then empty else "environment must be staging, production or development" end),
        (if ($o.transport | IN("sftp","ftps")) then empty else "transport must be sftp or ftps (plain ftp is never accepted)" end),
        (if ($o.host | s) then empty else "host is required" end),
        (if $o.port == null or ($o.port | type == "number" and . == floor and . >= 1 and . <= 65535) then empty else "port must be an integer from 1 to 65535" end),
        (if ($o.user | s) then empty else "user is required" end),
        (if ($o.password | s) or ($o.privateKey | s) then empty else "password or privateKey is required" end),
        (if ($o.password | s) and ($o.privateKey | s) then "give password or privateKey, not both" else empty end),
        (if ($o.privateKey | s) and $o.transport != "sftp" then "privateKey is for sftp only" else empty end),
        (if $o.transport == "sftp" and (($o.knownHosts | s) | not) then "knownHosts is required for sftp (the pinned host key line)" else empty end),
        (if $o.transport == "ftps" and (($o.certSha256 | s) | not) and (($o.caPem | s) | not) then "certSha256 or caPem is required for ftps (the pinned certificate)" else empty end),
        (if $o.checkHostname != null and ($o.checkHostname | type) != "boolean" then "checkHostname must be true or false" else empty end),
        (if ($o.remoteBase | s) then empty else "remoteBase is required" end),
        (if ($o.siteUrl | s) and ($o.siteUrl | test("^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$")) then empty else "siteUrl must be an https:// URL with no query or fragment" end)
      )
  end' 2>/dev/null | tr -d '\r')" || die "the per-site deploy secret is not valid JSON"
[ -z "$problems" ] || { printf '%s\n' "$problems" | sed 's/^/deploy-from-secret:   - /' >&2; die "the per-site deploy secret does not have the documented shape (see webdesk/templates/_deploy/README.md)"; }

get() { printf '%s' "$SECRET_JSON" | jq -r --arg k "$1" '.[$k] // empty' | tr -d '\r'; }

S_ENV="$(get environment)"
[ "$S_ENV" = "$ENVIRONMENT" ] || die "this secret is for environment '$S_ENV' but this run deploys '$ENVIRONMENT'; refusing (a staging secret never deploys production, and the reverse)"
TRANSPORT="$(get transport)"
HOST="$(get host)"
PORT="$(get port)"
USER_="$(get user)"
REMOTE_BASE="$(get remoteBase)"
DOCROOT="$(get docroot)"
SITE_URL="$(get siteUrl)"; SITE_URL="${SITE_URL%/}"
PASSWORD="$(get password)"
SSH_KEY="$(get privateKey)"
KNOWN_HOSTS="$(get knownHosts)"
CERT_SHA="$(get certSha256)"
CA_PEM="$(get caPem)"
CHECK_HOST="$(printf '%s' "$SECRET_JSON" | jq -r 'if .checkHostname == false then "no" else "yes" end' | tr -d '\r')"
unset SECRET_JSON

# Whatever the job's log would print, these never appear in it: one mask per line (a mask matches a single line).
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  while IFS= read -r line; do [ -n "$line" ] && printf '::add-mask::%s\n' "$line"; done < <(printf '%s\n%s\n' "$PASSWORD" "$SSH_KEY")
fi

# ---------------------------------------------------------------- what is deployed, per kind
if [ "$KIND" = static ]; then
  [ -n "$DOCROOT" ] || die "docroot is required in the secret for a static site (the document root's name inside remoteBase)"
  DEPLOY_BASE="$REMOTE_BASE"
  DEPLOY_DOCROOT_NAME="$DOCROOT"
  DEPLOY_DOCROOT_PARENT_DIR=""
  STAMP_URL="$SITE_URL/webdesk-build.json"
  MIN_PAGES_DEFAULT=1
else
  [ -z "$DOCROOT" ] || note "docroot is ignored for a wp site (only wp-content/themes/<theme>/ is deployed)"
  [[ "$THEME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ && "$THEME" != *..* ]] || die "DEPLOY_WP_THEME is missing or unsafe"
  WPROOT="${REMOTE_BASE%/}"
  DEPLOY_BASE="$WPROOT/wp-content/.webdesk-deploy"
  DEPLOY_DOCROOT_PARENT_DIR="$WPROOT/wp-content/themes"
  DEPLOY_DOCROOT_NAME="$THEME"
  STAMP_URL="$SITE_URL/wp-content/themes/$THEME/webdesk-build.json"
  MIN_PAGES_DEFAULT=0
fi

ARTIFACT_FOR_DEPLOY=""
MANIFEST_FOR_DEPLOY=""
if [ "$MODE" = deploy ]; then
  [ -d "$ART" ] || die "DEPLOY_ARTIFACT_DIR is not a directory"
  [ -f "$MANIFEST" ] || die "DEPLOY_MANIFEST is not a file"
  if [ "$KIND" = static ]; then
    ARTIFACT_FOR_DEPLOY="$ART"
    MANIFEST_FOR_DEPLOY="$MANIFEST"
  else
    # The artifact is the repo-relative tree wp-content/themes/<theme>/...; it must hold NOTHING else. Three independent checks,
    # all before any connection: the manifest is the one the build job pinned; the tree on disk is exactly what the manifest says
    # (an extra file is refused, not ignored); every path is inside the theme.
    PREFIX="wp-content/themes/$THEME/"
    WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
    if [ -n "$MANIFEST_SHA" ] && [ "$(sha256sum "$MANIFEST" | cut -c1-64)" != "$MANIFEST_SHA" ]; then
      die "the manifest does not match the hash the build job pinned (DEPLOY_MANIFEST_SHA256); nothing deployed"
    fi
    "$HERE/make-manifest.sh" "$ART" >"$WORK/disk.manifest" 2>"$WORK/mm.err" || { cat "$WORK/mm.err" >&2; die "the artifact tree is not a plain file tree"; }
    LC_ALL=C sort -t $'\t' -k3,3 "$MANIFEST" >"$WORK/pinned.manifest"
    LC_ALL=C sort -t $'\t' -k3,3 "$WORK/disk.manifest" -o "$WORK/disk.manifest"
    cmp -s "$WORK/pinned.manifest" "$WORK/disk.manifest" || die "the artifact on disk does not match its manifest (a file differs, is missing or is extra); nothing deployed"
    outside="$(cut -f3 "$WORK/pinned.manifest" | awk -v p="$PREFIX" 'index($0, p) != 1' | head -5)"
    if [ -n "$outside" ]; then
      printf '%s\n' "$outside" | sed 's/^/deploy-from-secret:   outside the theme: /' >&2
      die "the artifact holds paths outside $PREFIX (wp deploys the theme and nothing else); nothing deployed"
    fi
    # No stray entry (an empty directory the manifest cannot see) outside the theme path either.
    stray="$(find "$ART" -mindepth 1 ! -path "$ART/wp-content" ! -path "$ART/wp-content/themes" ! -path "$ART/wp-content/themes/$THEME" ! -path "$ART/wp-content/themes/$THEME/*" -print -quit)"
    [ -z "$stray" ] || die "the artifact holds an entry outside $PREFIX; nothing deployed"
    awk -F'\t' -v OFS='\t' -v p="$PREFIX" '{ $3 = substr($3, length(p) + 1); print }' "$WORK/pinned.manifest" >"$WORK/theme.manifest"
    ARTIFACT_FOR_DEPLOY="$ART/wp-content/themes/$THEME"
    MANIFEST_FOR_DEPLOY="$WORK/theme.manifest"
    MANIFEST_SHA=""   # verified above; the theme manifest is derived from the pinned one here
  fi
fi

# ---------------------------------------------------------------- map onto deploy.sh's inputs, then run it
export DEPLOY_TRANSPORT="$TRANSPORT" DEPLOY_HOST="$HOST" DEPLOY_USER="$USER_"
[ -z "$PORT" ] || export DEPLOY_PORT="$PORT"
[ -z "$PASSWORD" ] || export DEPLOY_PASSWORD="$PASSWORD"
[ -z "$SSH_KEY" ] || export DEPLOY_SSH_KEY="$SSH_KEY"
[ -z "$KNOWN_HOSTS" ] || export DEPLOY_SFTP_KNOWN_HOSTS="$KNOWN_HOSTS"
[ -z "$CERT_SHA" ] || export DEPLOY_FTPS_CERT_SHA256="$CERT_SHA"
[ -z "$CA_PEM" ] || export DEPLOY_FTPS_CA_PEM="$CA_PEM"
export DEPLOY_FTPS_CHECK_HOSTNAME="$CHECK_HOST"
export DEPLOY_REMOTE_BASE="$DEPLOY_BASE" DEPLOY_DOCROOT="$DEPLOY_DOCROOT_NAME" DEPLOY_STAMP_URL="$STAMP_URL" DEPLOY_MODE="$MODE"
if [ -n "$DEPLOY_DOCROOT_PARENT_DIR" ]; then export DEPLOY_DOCROOT_PARENT="$DEPLOY_DOCROOT_PARENT_DIR" DEPLOY_CREATE_BASE=yes; fi
export DEPLOY_MIN_PAGES="${DEPLOY_MIN_PAGES:-$MIN_PAGES_DEFAULT}"
if [ "$MODE" = deploy ]; then
  export DEPLOY_ARTIFACT_DIR="$ARTIFACT_FOR_DEPLOY" DEPLOY_MANIFEST="$MANIFEST_FOR_DEPLOY"
  if [ -n "$MANIFEST_SHA" ]; then export DEPLOY_MANIFEST_SHA256="$MANIFEST_SHA"; else unset DEPLOY_MANIFEST_SHA256; fi
fi
unset PASSWORD SSH_KEY
note "kind=$KIND environment=$ENVIRONMENT mode=$MODE transport=$TRANSPORT host=$HOST target=$DEPLOY_REMOTE_BASE/${DEPLOY_DOCROOT_PARENT:+(docroot in $DEPLOY_DOCROOT_PARENT) }$DEPLOY_DOCROOT"
bash "$HERE/deploy.sh"
exit $?
