#!/usr/bin/env bash
# The M6-P6f cases. Runs INSIDE the client container of the same harness as cases.sh (run.sh starts it when P6E_CASES=p6f, or
# after the P6e cases when P6E_CASES=all); prints PASS or FAIL per case. PW_A / PW_B are the throwaway canary credentials.
#
# What it proves, on real daemons (sshd for SFTP, vsftpd with explicit TLS for FTPS, nginx over HTTPS on the same volume):
#   F1  a PER-SITE SECRET (the JSON the org owner creates) drives a static deploy end to end through deploy-from-secret.sh and
#       the real deploy.sh, over SFTP and FTPS: verify, activate, the stamp read back over HTTPS, the buildId the build wrote.
#   F2  a WP deploy writes ONLY wp-content/themes/<theme>/ on a fake WordPress tree: a checksum of everything else (wp-config.php,
#       uploads, other plugins and themes, wp-includes, .htaccess) is unchanged; releases and the lock are in
#       wp-content/.webdesk-deploy (never inside themes/); a second deploy and a rollback work in this subdirectory mode too.
#   F3  an artifact with ANYTHING outside the theme (wp-config.php, a plugin, uploads) is refused before the host is touched.
#   F4  the refusals around the secret (a staging secret on a production run, plain ftp, no pin) touch nothing.
#   F5  the canary credentials are in none of the captured outputs.
set -u

CA=/pki/ca.crt
ART=/tmp/art6f
OUT=/tmp/p6f-out
SCRIPTS=/deploy
mkdir -p "$ART" "$OUT"
: "${PW_A:?}" "${PW_B:?}"

PASSN=0; FAILN=0
declare -a FAILED=()
result() { if [ "$1" = PASS ]; then PASSN=$((PASSN + 1)); else FAILN=$((FAILN + 1)); FAILED+=("$2"); fi; printf '%s  %s%s\n' "$1" "$2" "${3:+  -  $3}"; }
expect_rc() { if [ "$2" = "$3" ]; then result PASS "$1" "exit $3${4:+; $4}"; else result FAIL "$1" "wanted exit $2, got $3${4:+; $4}"; fi; }
expect() { if [ "$2" = 0 ]; then result PASS "$1" "${3:-}"; else result FAIL "$1" "${3:-}"; fi; }

KH_REAL="sshd $(cut -d' ' -f1,2 /pki/ssh/ssh_host_ed25519_key.pub)"
FP_REAL="$(openssl x509 -in /pki/ftps/cert.pem -noout -fingerprint -sha256 | sed 's/.*=//')"

adm() { # adm <a|b> <lftp commands>  (SFTP admin session as that principal)
  local who="$1"; shift
  local pw="$PW_A"; [ "$who" = b ] && pw="$PW_B"
  local kh; kh="$(mktemp)"; echo "$KH_REAL" >"$kh"
  LFTP_PASSWORD="$pw" lftp -c "set cmd:fail-exit yes; set net:max-retries 2; set net:timeout 20; set sftp:connect-program 'ssh -a -x -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$kh -o GlobalKnownHostsFile=/dev/null -o PubkeyAuthentication=no'; open -u $who --env-password sftp://sshd; $*" 2>&1
  local rc=$?; rm -f "$kh"; return $rc
}
wipe() { # wipe <a|b>: an empty site base
  local who="$1" n
  for n in $(adm "$who" "cls -1 -a /$who/site/" | awk -F/ '{print ($NF==""?$(NF-1):$NF)}' | grep -vE '^\.{1,2}$'); do adm "$who" "rm -r -f /$who/site/$n" >/dev/null; done
}

# secret <transport> <a|b> <remoteBase> [docroot]  -> the per-site secret JSON on stdout
secret() {
  local tr="$1" who="$2" base="$3" docroot="${4:-}" pw="$PW_A" url="https://site-a"
  [ "$who" = b ] && { pw="$PW_B"; url="https://site-b"; }
  if [ "$tr" = sftp ]; then
    jq -n --arg u "$who" --arg pw "$pw" --arg kh "$KH_REAL" --arg base "$base" --arg doc "$docroot" --arg url "$url" \
      '{version:1, environment:"staging", transport:"sftp", host:"sshd", user:$u, password:$pw, knownHosts:$kh, remoteBase:$base, siteUrl:$url} + (if $doc != "" then {docroot:$doc} else {} end)'
  else
    jq -n --arg u "$who" --arg pw "$pw" --arg ca "$(cat "$CA")" --arg fp "$FP_REAL" --arg base "$base" --arg doc "$docroot" --arg url "$url" \
      '{version:1, environment:"staging", transport:"ftps", host:"ftps", user:$u, password:$pw, caPem:$ca, certSha256:$fp, remoteBase:$base, siteUrl:$url} + (if $doc != "" then {docroot:$doc} else {} end)'
  fi
}

# run <label> <secret-json> KEY=VAL...  -> OUT/<label>.log, returns deploy-from-secret.sh's exit status
run() {
  local label="$1" sec="$2"; shift 2
  (
    export DEPLOY_SECRET_JSON="$sec" DEPLOY_ENVIRONMENT=staging DEPLOY_STAMP_CA_FILE="$CA" DEPLOY_STAMP_TIMEOUT=12
    local kv
    for kv in "$@"; do case "$kv" in -*) unset "${kv#-}" ;; *) export "$kv" ;; esac; done
    bash "$SCRIPTS/deploy-from-secret.sh"
  ) >"$OUT/$label.log" 2>&1
}

mkstaticart() { # mkstaticart <id>: a build artifact + manifest, as the build job leaves it
  /harness/mkart.sh "$ART/$1" "$1" 0
}
stamp_of() { curl -sS --cacert "$CA" "https://site-$1/webdesk-build.json" | jq -r .buildId; }
theme_stamp() { curl -sS --cacert "$CA" "https://site-b/wp-content/themes/gaiada-webdesk/webdesk-build.json" | jq -r .buildId; }

# ---------------------------------------------------------------- the fake WordPress tree, on principal b's root
WP_ROOT=/b/site/public_html
mkwptree() { # a plausible WordPress install: core files, wp-config, uploads, two plugins, two themes (one is the OLD gaiada-webdesk)
  local d="$ART/wptree"; rm -rf "$d"
  mkdir -p "$d/wp-content/uploads/2026/10" "$d/wp-content/plugins/akismet" "$d/wp-content/plugins/other" "$d/wp-content/themes/twentytwentyfive" \
           "$d/wp-content/themes/gaiada-webdesk" "$d/wp-includes" "$d/wp-admin"
  printf '<?php\ndefine("DB_NAME", "fake");\ndefine("DB_PASSWORD", "not-a-real-password");\n' >"$d/wp-config.php"
  printf '<?php require __DIR__ . "/wp-blog-header.php";\n' >"$d/index.php"
  printf 'Options -Indexes\n' >"$d/.htaccess"
  head -c 20000 /dev/urandom >"$d/wp-content/uploads/2026/10/photo.jpg"
  head -c 5000 /dev/urandom >"$d/wp-content/uploads/2026/10/doc.pdf"
  printf '<?php // akismet\n' >"$d/wp-content/plugins/akismet/akismet.php"
  printf '<?php // other plugin\n' >"$d/wp-content/plugins/other/other.php"
  printf '/* Theme Name: Twenty Twenty-Five */\n' >"$d/wp-content/themes/twentytwentyfive/style.css"
  printf '<?php // silence\n' >"$d/wp-content/index.php"
  head -c 3000 /dev/urandom | base64 >"$d/wp-includes/version.php"
  head -c 3000 /dev/urandom | base64 >"$d/wp-admin/index.php"
  # the OLD hand-installed theme (no stamp, no marker): the first deploy must park it as a release, not lose it
  printf '/* Theme Name: gaiada-webdesk (old) */\n' >"$d/wp-content/themes/gaiada-webdesk/style.css"
  printf '<?php // old theme\n' >"$d/wp-content/themes/gaiada-webdesk/index.php"
}
reset_wp() {
  wipe b
  mkwptree
  adm b "mirror -R --no-perms $ART/wptree $WP_ROOT" >/dev/null
}
# a digest over everything on the host that is NOT the theme and NOT our own deploy directory
outside_digest() {
  local snap="$ART/snap"; rm -rf "$snap"; mkdir -p "$snap"
  adm b "mirror --no-perms $WP_ROOT $snap" >/dev/null 2>&1
  ( cd "$snap" && find . -type f ! -path './wp-content/themes/gaiada-webdesk/*' ! -path './wp-content/.webdesk-deploy/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 )
}
outside_files() { ( cd "$ART/snap" && find . -type f ! -path './wp-content/themes/gaiada-webdesk/*' ! -path './wp-content/.webdesk-deploy/*' | wc -l | tr -d ' '; ); }

mkwpart() { # mkwpart <id> [extra relative path]: the artifact the wp build job uploads (stage root = repo-relative tree) + its manifest
  local id="$1" extra="${2:-}" d="$ART/wp-$1" th="wp-content/themes/gaiada-webdesk"
  rm -rf "$d" "$d.manifest"; mkdir -p "$d/$th/inc"
  printf '/* Theme Name: gaiada-webdesk */\n/* build %s */\n' "$id" >"$d/$th/style.css"
  printf '<?php // index %s\n' "$id" >"$d/$th/index.php"
  printf '<?php // functions %s\n' "$id" >"$d/$th/functions.php"
  printf '<?php // inc %s\n' "$id" >"$d/$th/inc/router.php"
  for n in 1 2 3; do printf '<?php // inc extra %s %s\n' "$id" "$n" >"$d/$th/inc/e$n.php"; done
  STAMP_BUILD_ID="$id" STAMP_COMMIT=0123456789abcdef0123456789abcdef01234567 STAMP_KIND=wp STAMP_ENVIRONMENT=staging STAMP_PULLED_AT="$(date -u +%FT%TZ)" \
    STAMP_TRIGGER=push STAMP_RUN_ID=1 STAMP_RUN_ATTEMPT=1 bash "$SCRIPTS/write-stamp.sh" "$d/$th" >/dev/null
  if [ -n "$extra" ]; then mkdir -p "$(dirname "$d/$extra")"; echo '<?php // not the theme' >"$d/$extra"; fi
  "$SCRIPTS/make-manifest.sh" "$d" >"$d.manifest"
}
wpenv() { # wpenv <id>  (the env the workflow's deploy step sets)
  echo "DEPLOY_SITE_KIND=wp DEPLOY_WP_THEME=gaiada-webdesk DEPLOY_ARTIFACT_DIR=$ART/wp-$1 DEPLOY_MANIFEST=$ART/wp-$1.manifest DEPLOY_MANIFEST_SHA256=$(sha256sum "$ART/wp-$1.manifest" | cut -c1-64) DEPLOY_BUILD_ID=$1 DEPLOY_MIN_FILES=5"
}

echo "### p6f-harness: lftp $(lftp --version | head -1 | awk '{print $3, $4}'), host $(hostname)"

for T in ${P6E_TRANSPORTS:-sftp ftps}; do
  echo
  echo "================ transport: $T (per-site secret) ================"

  # ---------------------------------------------------------------- F1: static, from the secret JSON
  wipe a
  /harness/mkart.sh "$ART/legacy" legacy 0
  adm a "mirror -R --no-perms $ART/legacy /a/site/public_html" >/dev/null
  mkstaticart f1
  run "$T-f1" "$(secret "$T" a /a/site public_html)" DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f1" DEPLOY_MANIFEST="$ART/f1.manifest" \
    DEPLOY_MANIFEST_SHA256="$(sha256sum "$ART/f1.manifest" | cut -c1-64)" DEPLOY_BUILD_ID=f1
  rc=$?
  expect_rc "[$T] F1 a static deploy driven only by the per-site secret JSON" 0 "$rc" "$(grep -E 'DEPLOY OK|stamp read-back' "$OUT/$T-f1.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|')"
  [ "$(stamp_of a)" = f1 ]; expect "[$T] F1 the stamp read over HTTPS carries the build id the build wrote (f1)" $?
  mkstaticart f2
  run "$T-f1b" "$(secret "$T" a /a/site public_html)" DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f2" DEPLOY_MANIFEST="$ART/f2.manifest" \
    DEPLOY_MANIFEST_SHA256="$(sha256sum "$ART/f2.manifest" | cut -c1-64)" DEPLOY_BUILD_ID=f2
  expect_rc "[$T] F1 a second deploy from the same secret" 0 $?
  # a manifest that is not the one the build job pinned is refused before the host is touched
  run "$T-f1c" "$(secret "$T" a /a/site public_html)" DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f2" DEPLOY_MANIFEST="$ART/f2.manifest" \
    DEPLOY_MANIFEST_SHA256=0000000000000000000000000000000000000000000000000000000000000000 DEPLOY_BUILD_ID=f2 DEPLOY_RELEASE_ID=never
  rc=$?
  # (static: deploy.sh itself enforces the pin)
  expect_rc "[$T] F1 a manifest that does not match the pinned hash is refused" 2 "$rc" "$(grep -m1 FAILED "$OUT/$T-f1c.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-120)"
  [ "$(stamp_of a)" = f2 ]; expect "[$T] F1 the refused run left f2 serving" $?

  # ---------------------------------------------------------------- F4: the secret's own refusals touch nothing
  run "$T-f4a" "$(secret "$T" a /a/site public_html)" DEPLOY_ENVIRONMENT=production DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f2" \
    DEPLOY_MANIFEST="$ART/f2.manifest" DEPLOY_BUILD_ID=f2
  expect_rc "[$T] F4 a STAGING secret on a PRODUCTION run is refused" 2 $? "$(grep -m1 'this secret is for' "$OUT/$T-f4a.log" | cut -c1-110)"
  run "$T-f4b" "$(secret "$T" a /a/site public_html | jq '.transport="ftp"')" DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f2" \
    DEPLOY_MANIFEST="$ART/f2.manifest" DEPLOY_BUILD_ID=f2
  expect_rc "[$T] F4 plain ftp in the secret is refused" 2 $?
  run "$T-f4c" "$(secret "$T" a /a/site public_html | jq 'del(.knownHosts, .caPem, .certSha256)')" DEPLOY_SITE_KIND=static DEPLOY_ARTIFACT_DIR="$ART/f2" \
    DEPLOY_MANIFEST="$ART/f2.manifest" DEPLOY_BUILD_ID=f2
  expect_rc "[$T] F4 a secret with no pinned host identity is refused" 2 $?
  [ "$(stamp_of a)" = f2 ]; expect "[$T] F4 none of them touched the site (f2 still serves)" $?

  # ---------------------------------------------------------------- F2: wp deploys the theme and nothing else
  reset_wp
  before="$(outside_digest)"; nfiles="$(outside_files)"
  [ "$nfiles" -ge 10 ]; expect "[$T] F2 setup: the fake WordPress tree is on the host ($nfiles files outside the theme; digest $before)" $?
  mkwpart w1
  run "$T-f2a" "$(secret "$T" b /b/site/public_html)" $(wpenv w1)
  rc=$?
  expect_rc "[$T] F2 wp deploy of build w1 into wp-content/themes/gaiada-webdesk" 0 "$rc" "$(grep -E 'DEPLOY OK|creating it|window' "$OUT/$T-f2a.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|' | cut -c1-200)"
  [ "$(theme_stamp)" = w1 ]; expect "[$T] F2 the theme's stamp over HTTPS shows w1" $?
  [ "$(curl -sS --cacert "$CA" https://site-b/wp-content/themes/gaiada-webdesk/functions.php)" = "<?php // functions w1" ]; expect "[$T] F2 the new theme's files are served" $?
  after="$(outside_digest)"
  [ "$before" = "$after" ] && [ "$nfiles" = "$(outside_files)" ]
  expect "[$T] F2 CHECKSUM OF EVERYTHING OUTSIDE THE THEME IS UNCHANGED (wp-config.php, uploads, plugins, other theme, core): $before -> $after" $?
  [ "$(adm b "cat /b/site/public_html/wp-config.php" | grep -c 'not-a-real-password')" = 1 ]; expect "[$T] F2 wp-config.php still reads back as it was" $?
  # NEGATIVE CONTROL: the digest can fail. Change one byte of wp-config.php on the host and it must move; then put it back.
  printf '<?php // tampered by the control\n' >"$ART/tamper.php"
  adm b "put $ART/tamper.php -o $WP_ROOT/wp-config.php" >/dev/null
  [ "$(outside_digest)" != "$before" ]; expect "[$T] F2 negative control: a changed wp-config.php DOES move the outside digest (the check can fail)" $?
  adm b "put $ART/wptree/wp-config.php -o $WP_ROOT/wp-config.php" >/dev/null
  [ "$(outside_digest)" = "$before" ]; expect "[$T] F2 negative control undone: the digest is back to $before" $?
  themes="$(adm b "cls -1 -a $WP_ROOT/wp-content/themes/" | awk -F/ '{print ($NF==""?$(NF-1):$NF)}' | grep -vE '^\.{1,2}$' | sort | tr '\n' ' ')"
  [ "$themes" = "gaiada-webdesk twentytwentyfive " ]; expect "[$T] F2 themes/ holds only the two themes (no releases/ or lock inside it): $themes" $?
  rel="$(adm b "cls -1 -a $WP_ROOT/wp-content/.webdesk-deploy/releases/" | awk -F/ '{print ($NF==""?$(NF-1):$NF)}' | grep -vE '^\.{1,2}$' | tr '\n' ' ')"
  case "$rel" in *0000-legacy-*) result PASS "[$T] F2 the old hand-installed theme was parked as a release in wp-content/.webdesk-deploy/releases" "$rel" ;; *) result FAIL "[$T] F2 legacy theme parked" "$rel" ;; esac
  mkwpart w2
  run "$T-f2b" "$(secret "$T" b /b/site/public_html)" $(wpenv w2)
  expect_rc "[$T] F2 a second wp deploy (w2) in subdirectory mode" 0 $?
  [ "$(theme_stamp)" = w2 ] && [ "$before" = "$(outside_digest)" ]; expect "[$T] F2 w2 serves and the outside digest is still unchanged" $?
  run "$T-f2r" "$(secret "$T" b /b/site/public_html)" DEPLOY_SITE_KIND=wp DEPLOY_WP_THEME=gaiada-webdesk DEPLOY_MODE=rollback
  expect_rc "[$T] F2 a rollback of the theme" 0 $? "$(grep -E 'ROLLBACK OK' "$OUT/$T-f2r.log" | sed 's/^[0-9:]* deploy: //')"
  [ "$(theme_stamp)" = w1 ] && [ "$before" = "$(outside_digest)" ]; expect "[$T] F2 after the rollback the theme serves w1 again and the outside digest is unchanged" $?

  # ---------------------------------------------------------------- F3: anything outside the theme is refused
  for extra in "wp-config.php" "wp-content/plugins/other/evil.php" "wp-content/uploads/2026/10/x.jpg" "wp-content/mu-plugins/x.php"; do
    id="o$(echo "$extra" | tr -cd 'a-z' | head -c 8)"
    mkwpart "$id" "$extra"
    run "$T-f3-$id" "$(secret "$T" b /b/site/public_html)" $(wpenv "$id")
    rc=$?
    expect_rc "[$T] F3 an artifact that also holds $extra is refused" 2 "$rc" "$(grep -m1 'outside' "$OUT/$T-f3-$id.log" | cut -c1-120)"
    [ "$before" = "$(outside_digest)" ] && [ "$(theme_stamp)" = w1 ]; expect "[$T] F3 refused before the host was touched: outside digest unchanged, theme still w1" $?
  done
  # the build job's pinned manifest hash does not match what arrived
  mkwpart w3
  run "$T-f3-pin" "$(secret "$T" b /b/site/public_html)" $(wpenv w3 | sed 's/DEPLOY_MANIFEST_SHA256=[0-9a-f]*/DEPLOY_MANIFEST_SHA256=0000000000000000000000000000000000000000000000000000000000000000/')
  expect_rc "[$T] F3 a manifest that does not match the pinned hash is refused" 2 $?
  # a file slipped into the artifact on disk AFTER the manifest was made
  mkwpart w4; echo '<?php // sneaked' >"$ART/wp-w4/wp-config.php"
  run "$T-f3-disk" "$(secret "$T" b /b/site/public_html)" $(wpenv w4)
  expect_rc "[$T] F3 a file on disk that the manifest does not list is refused" 2 $?
  [ "$before" = "$(outside_digest)" ] && [ "$(theme_stamp)" = w1 ]; expect "[$T] F3 after all refusals the host is still exactly as the rollback left it" $?
done

# ---------------------------------------------------------------- F5: the canary
echo
echo "================ canary ================"
hits="$(grep -rlF -e "$PW_A" -e "$PW_B" "$OUT" 2>/dev/null | tr '\n' ' ')"
if [ -z "$hits" ]; then result PASS "F5 the canary credentials are in none of the $(ls "$OUT"/*.log | wc -l | tr -d ' ') captured outputs"; else result FAIL "F5 canary found in: $hits"; fi

echo
echo "### p6f cases passed: $PASSN, failed: $FAILN"
if [ "$FAILN" -gt 0 ]; then printf 'FAILED: %s\n' "${FAILED[@]}"; fi
[ "$FAILN" = 0 ]
