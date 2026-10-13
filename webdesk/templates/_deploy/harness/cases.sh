#!/usr/bin/env bash
# The M6-P6e cases. Runs INSIDE the client container (run.sh starts it); prints PASS or FAIL per case.
# PW_A / PW_B are the throwaway canary credentials of principals A and B (set by run.sh).
set -u

D=/deploy/deploy.sh
CA=/pki/ca.crt
ART=/tmp/art
OUT=/tmp/p6e-out
mkdir -p "$ART" "$OUT"
: "${PW_A:?}" "${PW_B:?}"

PASSN=0; FAILN=0
declare -a FAILED=()
result() { # result <PASS|FAIL> <name> [detail]
  if [ "$1" = PASS ]; then PASSN=$((PASSN + 1)); else FAILN=$((FAILN + 1)); FAILED+=("$2"); fi
  printf '%s  %s%s\n' "$1" "$2" "${3:+  -  $3}"
}
expect_rc() { # expect_rc <name> <want> <got> [detail]
  if [ "$2" = "$3" ]; then result PASS "$1" "exit $3${4:+; $4}"; else result FAIL "$1" "wanted exit $2, got $3${4:+; $4}"; fi
}
expect() { # expect <name> <cond-rc> [detail]
  if [ "$2" = 0 ]; then result PASS "$1" "${3:-}"; else result FAIL "$1" "${3:-}"; fi
}
log_has() { grep -qE -- "$2" "$OUT/$1.log"; }

# ---------------------------------------------------------------- identities (the PUBLIC halves only)
KH_REAL="sshd $(cut -d' ' -f1,2 /pki/ssh/ssh_host_ed25519_key.pub)"
KH_ROGUE="sshd $(cut -d' ' -f1,2 /pki/ssh-rogue/ssh_host_ed25519_key.pub)"
FP_REAL="$(openssl x509 -in /pki/ftps/cert.pem -noout -fingerprint -sha256 | sed 's/.*=//')"
FP_ROGUE="$(openssl x509 -in /pki/ftps-rogue/cert.pem -noout -fingerprint -sha256 | sed 's/.*=//')"

# ---------------------------------------------------------------- helpers
# dep <label> <transport> <principal a|b> <base-principal a|b> <build> [VAR=val | -VAR ...]
#   principal = whose credential; base-principal = whose root the deploy aims at; the site host follows the base.
dep() {
  local label="$1" tr="$2" who="$3" onroot="$4" build="$5"; shift 5
  local pw="$PW_A"; [ "$who" = b ] && pw="$PW_B"
  (
    export DEPLOY_TRANSPORT="$tr" DEPLOY_USER="$who" DEPLOY_PASSWORD="$pw" \
      DEPLOY_REMOTE_BASE="/$onroot/site" DEPLOY_DOCROOT=public_html \
      DEPLOY_ARTIFACT_DIR="$ART/$build" DEPLOY_MANIFEST="$ART/$build.manifest" DEPLOY_BUILD_ID="$build" \
      DEPLOY_STAMP_URL="https://site-$onroot/webdesk-build.json" DEPLOY_STAMP_CA_FILE="$CA" DEPLOY_STAMP_TIMEOUT=12 \
      DEPLOY_ALLOW_TEST_HOOKS=I-am-the-harness
    if [ "$tr" = sftp ]; then
      export DEPLOY_HOST=sshd DEPLOY_SFTP_KNOWN_HOSTS="$KH_REAL"
    else
      export DEPLOY_HOST=ftps DEPLOY_FTPS_CA_PEM="$(cat "$CA")" DEPLOY_FTPS_CERT_SHA256="$FP_REAL"
    fi
    local kv
    for kv in "$@"; do case "$kv" in -*) unset "${kv#-}" ;; *) export "$kv" ;; esac; done
    bash "$D"
  ) >"$OUT/$label.log" 2>&1
}

# adm <principal> <lftp commands>: admin-side sessions (reset, polling) always go over SFTP, whichever transport is under test.
adm() {
  local who="$1"; shift
  local pw="$PW_A"; [ "$who" = b ] && pw="$PW_B"
  local kh; kh="$(mktemp)"; echo "$KH_REAL" >"$kh"
  LFTP_PASSWORD="$pw" lftp -c "set cmd:fail-exit yes; set net:max-retries 2; set net:timeout 20; set sftp:connect-program 'ssh -a -x -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$kh -o GlobalKnownHostsFile=/dev/null -o PubkeyAuthentication=no'; open -u $who --env-password sftp://sshd; $*" 2>&1
  local rc=$?; rm -f "$kh"; return $rc
}
reset_site() { # reset_site <a|b>  -> an empty base with a "legacy" docroot (hand-made, no marker) serving build "legacy"
  local who="$1" n
  for n in $(adm "$who" "cls -1 -a /$who/site/" | awk -F/ '{print ($NF==""?$(NF-1):$NF)}'); do adm "$who" "rm -r -f /$who/site/$n" >/dev/null; done
  /harness/mkart.sh "$ART/legacy" legacy 0
  adm "$who" "mirror -R --no-perms $ART/legacy /$who/site/public_html" >/dev/null
}
site_names() { adm "$1" "cls -1 -a /$1/site/${2:-}" | awk -F/ '{print ($NF==""?$(NF-1)"/":$NF)}'; }
releases_of() { adm "$1" "cls -1 -a /$1/site/releases/" | awk -F/ '{print ($NF==""?$(NF-1):$NF)}' | grep -v '^\.' | sort; }
stamp_of() { curl -sS --cacert "$CA" "https://site-$1/webdesk-build.json" | jq -r .buildId; }
# serves_build <site a|b> <build>: every file of that build's manifest is served, byte for byte
serves_build() {
  local site="$1" build="$2" h s p got bad=0
  while IFS=$'\t' read -r h s p; do
    got="$(curl -sS --cacert "$CA" "https://site-$site/$p" | sha256sum | cut -c1-64)"
    [ "$got" = "$h" ] || { bad=$((bad + 1)); echo "    differs: $p" >&2; }
  done <"$ART/$build.manifest"
  [ "$bad" = 0 ]
}
served_digest() { # one hash over everything the site serves for a build's file list
  local site="$1" build="$2" h s p
  while IFS=$'\t' read -r h s p; do printf '%s %s\n' "$(curl -sS --cacert "$CA" "https://site-$site/$p" | sha256sum | cut -c1-64)" "$p"; done <"$ART/$build.manifest" | sha256sum | cut -c1-16
}
mkbuild() { /harness/mkart.sh "$ART/$1" "$1" "${2:-0}"; }
probe_start() { rm -f /probe/log; : >/probe/log; touch /probe/run; sleep 0.5; }
probe_stop() { rm -f /probe/run; sleep 0.6; }
probe_report() { # probe_report <label> <deploy log>: what the probe container saw while the deploy ran
  local total bad first last avg
  total="$(wc -l </probe/log)"; bad="$(awk '$2 != 200' /probe/log | wc -l)"
  avg="$(awk 'NR==1{a=$1} {b=$1} END{if (NR>1) printf "%.0f", (b-a)/(NR-1)/1000000; else print "?"}' /probe/log)"
  first="$(awk '$2 != 200 {print $1; exit}' /probe/log)"; last="$(awk '$2 != 200 {l=$1} END{print l}' /probe/log)"
  if [ "$bad" -gt 0 ]; then
    echo "INFO  [$1] activation window: script upper bound $(grep -oE 'window <= [-0-9]+ ms' "$2" | head -1); probe saw $bad non-200 of $total requests (one every ~${avg} ms), first to last $(( (last - first) / 1000000 )) ms apart, codes: $(awk '$2 != 200 {print $2}' /probe/log | sort | uniq -c | tr -s ' ' | tr '\n' ',')"
  else
    echo "INFO  [$1] activation window: script upper bound $(grep -oE 'window <= [-0-9]+ ms' "$2" | head -1); probe saw 0 non-200 of $total requests (one every ~${avg} ms), so the real gap was shorter than that"
  fi
}
poll_count() { # files so far under the half-uploaded release dir
  adm a "find /a/site/releases/.tmp-$1" 2>/dev/null | grep -vc '/$'
}

echo "### p6e-harness: lftp $(lftp --version | head -1 | awk '{print $3, $4}'), $(ssh -V 2>&1 | cut -d, -f1), host $(hostname)"

# ================================================================ the transports
for T in ${P6E_TRANSPORTS:-sftp ftps}; do
  echo
  echo "================ transport: $T ================"
  mkbuild b1; mkbuild b2 6; mkbuild b3 6; mkbuild b4; mkbuild b5; mkbuild b6
  reset_site a; reset_site b
  [ "$(stamp_of a)" = legacy ] && result PASS "[$T] setup: the legacy site serves before the first deploy" || result FAIL "[$T] setup: legacy site not serving"

  # ---- case 1: deploy -> verify -> activate -> stamp read back over HTTPS
  dep "$T-1" "$T" a a b1 DEPLOY_RELEASE_ID=r1-b1
  rc=$?
  expect_rc "[$T] 1 deploy uploads, verifies, activates" 0 "$rc" "$(grep -E 'read-back verified|activated:|stamp read-back ok' "$OUT/$T-1.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|')"
  [ "$(stamp_of a)" = b1 ] && serves_build a b1; expect "[$T] 1 the stamp over HTTPS shows build b1 and every served file is b1's" $?
  names="$(releases_of a | tr '\n' ' ')"
  case "$names" in 0000-legacy-*) result PASS "[$T] 1 the displaced legacy docroot was kept as a release" "releases: $names" ;; *) result FAIL "[$T] 1 legacy docroot kept" "releases: $names" ;; esac

  # ---- case 2: a kill after N files leaves the previous release serving, byte-identical
  before="$(served_digest a b1)"
  # run the slow deploy in its own process group so the whole tree can be killed at once
  setsid bash -c "$(declare -f dep); $(declare -p ART OUT D CA KH_REAL FP_REAL | tr '\n' ';') dep $T-2 $T a a b2 DEPLOY_RELEASE_ID=r2-b2 DEPLOY_RATE_LIMIT=500000 DEPLOY_PARALLEL=1" &
  gpid=$!
  n=0; tries=0
  while [ "$n" -lt 10 ] && [ "$tries" -lt 80 ]; do sleep 0.4; n="$(poll_count r2-b2)"; tries=$((tries + 1)); done
  pat="${PW_A:0:14}[${PW_A:14:1}]${PW_A:15}"; psleak="$(ps -eww -o args= | grep -c -e "$pat" || true)"
  kill -9 -- "-$gpid" 2>/dev/null; wait "$gpid" 2>/dev/null
  after="$(served_digest a b1)"
  [ "$n" -ge 10 ] && [ "$before" = "$after" ] && serves_build a b1 && [ "$(stamp_of a)" = b1 ]
  expect "[$T] 2 SIGKILL after $n uploaded files leaves b1 serving, byte-identical" $? "digest before=$before after=$after, stamp=$(stamp_of a)"
[ "$psleak" = 0 ]; expect "[$T] 6 while the deploy ran (bash, lftp and ssh alive) the password was on no process command line" $? "ps -eww matches: $psleak"
  # the killed run could not release the lock; the next deploy must refuse cleanly, then recover by the stale rule
  dep "$T-2b" "$T" a a b2 DEPLOY_RELEASE_ID=r2-b2
  rc=$?
  expect_rc "[$T] 2 a deploy right after the kill fails cleanly on the orphaned lock" 3 "$rc" "$(grep -m1 'holds the lock' "$OUT/$T-2b.log" | sed 's/^[0-9:]* deploy: //')"
  sleep 2
  dep "$T-2c" "$T" a a b2 DEPLOY_RELEASE_ID=r2-b2 DEPLOY_LOCK_STALE_SECONDS=1
  rc=$?
  expect_rc "[$T] 2 once the lock is stale, the next deploy breaks it, drops the partial upload and succeeds" 0 "$rc" "$(grep -E 'stale|orphaned' "$OUT/$T-2c.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-90 | tr '\n' '|')"
  [ "$(stamp_of a)" = b2 ]; expect "[$T] 2 after recovery the site serves b2" $?
  # SIGTERM variant: the trap releases the lock and removes the partial upload
  setsid bash -c "$(declare -f dep); $(declare -p ART OUT D CA KH_REAL FP_REAL | tr '\n' ';') dep $T-2t $T a a b3 DEPLOY_RELEASE_ID=r3-b3 DEPLOY_RATE_LIMIT=500000 DEPLOY_PARALLEL=1" &
  gpid=$!
  n=0; tries=0
  while [ "$n" -lt 8 ] && [ "$tries" -lt 80 ]; do sleep 0.4; n="$(poll_count r3-b3)"; tries=$((tries + 1)); done
  kill -TERM -- "-$gpid" 2>/dev/null; wait "$gpid" 2>/dev/null
  sleep 4
  locks="$(site_names a | grep -c "^.deploy-lock/$")"; tmps="$(adm a "cls -1 -a /a/site/releases/" | grep -c ".tmp-")"
  [ "$(stamp_of a)" = b2 ] && [ "$locks" = 0 ] && [ "$tmps" = 0 ]
  expect "[$T] 2 SIGTERM after $n files: b2 still serves, the lock is released ($locks left), the partial upload is removed ($tmps left)" $? "log: $(grep -E 'lock released|signal' "$OUT/$T-2t.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|')"

  # ---- case 3: a flipped byte in the uploaded tree refuses activation
  before="$(served_digest a b2)"
  hook="$(cat <<'HOOK'
set -e
r="$DEPLOY_REMOTE_RELEASE/assets/app-1.js"
lftp -c "source $DEPLOY_LFTP_RC; get $r -o /tmp/flip.bin"
b=$(head -c 101 /tmp/flip.bin | tail -c 1 | od -An -tu1 | tr -d ' ')
nb=$(( (b + 1) % 256 ))
printf "$(printf '\\%03o' "$nb")" | dd of=/tmp/flip.bin bs=1 seek=100 conv=notrunc 2>/dev/null
lftp -c "source $DEPLOY_LFTP_RC; put /tmp/flip.bin -o $r"
echo "hook: flipped one byte (offset 100) of assets/app-1.js on the host; size unchanged at $(stat -c %s /tmp/flip.bin)"
HOOK
)"
  dep "$T-3" "$T" a a b3 DEPLOY_RELEASE_ID=r3-b3 "DEPLOY_TEST_HOOK_AFTER_UPLOAD=$hook"
  rc=$?
  expect_rc "[$T] 3 a flipped byte (same size) after upload refuses activation" 4 "$rc" "$(grep -E 'MISMATCH|hook:|byte for byte' "$OUT/$T-3.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|' | cut -c1-230)"
  [ "$(stamp_of a)" = b2 ] && [ "$before" = "$(served_digest a b2)" ]
  expect "[$T] 3 the previous release (b2) is still the one serving, byte-identical" $?
  r="$(releases_of a | grep -c 'b3' || true)"; [ "$r" = 0 ]; expect "[$T] 3 the refused upload leaves no release directory behind" $?

  # ---- case 3b: the second rename fails -> the first is rolled back
  dep "$T-3b" "$T" a a b3 DEPLOY_RELEASE_ID=r3-b3 DEPLOY_TEST_FAIL_ACTIVATION=1
  rc=$?
  expect_rc "[$T] 3b a failing second rename is rolled back (docroot never left missing)" 5 "$rc" "$(grep -E 'FAILED' "$OUT/$T-3b.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-120)"
  [ "$(stamp_of a)" = b2 ] && serves_build a b2 && site_names a | grep -qx 'public_html/'
  expect "[$T] 3b the docroot exists and still serves b2" $?

  # ---- case 3c: the stamp does not show the build -> roll back to the previous release
  dep "$T-3c" "$T" a a b3 DEPLOY_RELEASE_ID=r3-b3 DEPLOY_STAMP_URL=https://site-b/webdesk-build.json DEPLOY_STAMP_TIMEOUT=6
  rc=$?
  expect_rc "[$T] 3c a stamp that does not show the new build rolls back" 6 "$rc" "$(grep -E "rolling back|rolled back" "$OUT/$T-3c.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-110 | tr '\n' '|')"
  [ "$(stamp_of a)" = b2 ] && serves_build a b2; expect "[$T] 3c after the rollback b2 serves again, byte-identical" $?

  # ---- case 4: principal A on root B is refused by the DAEMON
  dep "$T-4" "$T" a b b4
  rc=$?
  expect_rc "[$T] 4 A's credential on B's root is refused by the host" 7 "$rc" "daemon said: $(grep -m1 'host:' "$OUT/$T-4.log" | sed 's/^ *host: //')"
  [ -z "$(site_names b | grep -E '^(releases|\.deploy-lock)/$')" ]; expect "[$T] 4 B's root is untouched (no releases dir, no lock)" $?

  # ---- case 7: two simultaneous deploys
  setsid bash -c "$(declare -f dep); $(declare -p ART OUT D CA KH_REAL FP_REAL | tr '\n' ';') dep $T-7x $T a a b3 DEPLOY_RELEASE_ID=r7-b3 DEPLOY_RATE_LIMIT=500000" &
  p1=$!
  setsid bash -c "$(declare -f dep); $(declare -p ART OUT D CA KH_REAL FP_REAL | tr '\n' ';') dep $T-7y $T a a b4 DEPLOY_RELEASE_ID=r7-b4" &
  p2=$!
  wait "$p1"; r1=$?; wait "$p2"; r2=$?
  ok1=0; [ "$r1" = 0 ] && ok1=1; ok2=0; [ "$r2" = 0 ] && ok2=1
  lk1=0; [ "$r1" = 3 ] && lk1=1; lk2=0; [ "$r2" = 3 ] && lk2=1
  winner=""; [ "$ok1" = 1 ] && winner=b3; [ "$ok2" = 1 ] && winner=b4
  [ $((ok1 + ok2)) = 1 ] && [ $((lk1 + lk2)) = 1 ] && [ "$(stamp_of a)" = "$winner" ] && serves_build a "$winner"
  expect "[$T] 7 two simultaneous deploys: exactly one completes ($winner), the other fails on the lock" $? "x ok=$ok1 locked=$lk1; y ok=$ok2 locked=$lk2"
  tmps="$(releases_of a | grep -c '^\.' || true)"; locks="$(site_names a | grep -c '^\.deploy-lock/$')"
  [ "$locks" = 0 ] && ! adm a "cls -1 -a /a/site/releases/" | grep -q '.tmp-'
  expect "[$T] 7 no partial release and no lock left behind" $? "releases: $(releases_of a | tr '\n' ' ')"

  # ---- case 8: last three kept after four+ deploys; a rollback shows the previous build.
  # b5 deploys on the LAN while a probe container requests the site every few ms; b6 deploys under 80 ms of added latency each way.
  probe_start
  dep "$T-8a" "$T" a a b5 DEPLOY_RELEASE_ID=r8-b5
  rc=$?
  probe_stop
  expect_rc "[$T] 8 deploy b5 (LAN)" 0 "$rc" "$(grep -E 'window' "$OUT/$T-8a.log" | sed 's/^[0-9:]* deploy: //' | head -1)"
  probe_report "$T LAN" "$OUT/$T-8a.log"
  if tc qdisc add dev eth0 root netem delay 80ms 2>/dev/null; then
    probe_start
    dep "$T-8b" "$T" a a b6 DEPLOY_RELEASE_ID=r8-b6
    rc=$?
    probe_stop
    tc qdisc del dev eth0 root 2>/dev/null
    expect_rc "[$T] 8 deploy b6 (80 ms added each way, about a WAN CI runner)" 0 "$rc" "$(grep -E 'window' "$OUT/$T-8b.log" | sed 's/^[0-9:]* deploy: //' | head -1)"
    probe_report "$T WAN(80ms each way)" "$OUT/$T-8b.log"
  else
    echo "INFO  [$T] tc netem is not available here; the WAN window is not measured"
    dep "$T-8b" "$T" a a b6 DEPLOY_RELEASE_ID=r8-b6
    expect_rc "[$T] 8 deploy b6" 0 $?
  fi
  rels="$(releases_of a | tr '\n' ' ')"
  nrel="$(releases_of a | wc -l | tr -d ' ')"
  [ "$nrel" = 2 ] && [ "$(stamp_of a)" = b6 ]
  expect "[$T] 8 after 5 deploys in all (b1, b2, one of b3/b4, b5, b6) only the last three releases remain (live + 2)" $? "live=b6; releases/: $rels"
  prev_build="$(adm a "get /a/site/releases/$(releases_of a | tail -1)/webdesk-build.json -o /tmp/pb.json" >/dev/null; jq -r .buildId /tmp/pb.json)"
  dep "$T-8r" "$T" a a b6 DEPLOY_MODE=rollback -DEPLOY_ARTIFACT_DIR -DEPLOY_MANIFEST -DEPLOY_BUILD_ID
  rc=$?
  expect_rc "[$T] 8 one rollback runs" 0 "$rc" "$(grep -E 'ROLLBACK OK|rollback:' "$OUT/$T-8r.log" | sed 's/^[0-9:]* deploy: //' | head -2 | tr '\n' '|')"
  [ "$(stamp_of a)" = "$prev_build" ] && [ "$prev_build" != b6 ]
  expect "[$T] 8 after the rollback the stamp shows the previous build ($prev_build, not b6)" $?

  # ---- case 9: a run killed between the two renames left no docroot; the next run puts a release back, then deploys
  mkbuild b7
  adm a "mv /a/site/public_html /a/site/releases/r99-sim" >/dev/null
  site_names a | grep -qx 'public_html/' && result FAIL "[$T] 9 setup: the simulated kill should have left no docroot" || result PASS "[$T] 9 setup: docroot missing (simulates a kill between the two renames)"
  dep "$T-9" "$T" a a b7 DEPLOY_RELEASE_ID=r9-b7
  rc=$?
  expect_rc "[$T] 9 the next deploy restores the missing docroot first, then deploys" 0 "$rc" "$(grep -E 'restoring release|DEPLOY OK' "$OUT/$T-9.log" | sed 's/^[0-9:]* deploy: //' | tr '\n' '|' | cut -c1-200)"
  [ "$(stamp_of a)" = b7 ] && serves_build a b7; expect "[$T] 9 the site serves b7" $?
done

# ================================================================ refusals (case 5)
echo
echo "================ refusals ================"
if [ -z "${P6E_SKIP_REFUSALS:-}" ]; then
mkbuild b9 0
reset_site a; reset_site b
dep r-fp-sftp-unpinned sftp a a b9 DEPLOY_SFTP_KNOWN_HOSTS=
expect_rc "[sftp] 5 an unpinned host key (no known_hosts) is refused before any connection" 2 $? "$(grep -m1 FAILED "$OUT/r-fp-sftp-unpinned.log" | sed 's/^[0-9:]* deploy: //')"
dep r-sftp-wrongkey sftp a a b9 "DEPLOY_SFTP_KNOWN_HOSTS=$KH_ROGUE"
expect_rc "[sftp] 5 a wrong pinned host key is refused" 2 $? "$(grep -E 'host:|FAILED' "$OUT/r-sftp-wrongkey.log" | sed 's/^[0-9:]* deploy: //' | head -2 | tr '\n' '|' | cut -c1-200)"
dep r-sftp-unknown-host sftp a a b9 "DEPLOY_SFTP_KNOWN_HOSTS=otherhost ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyDummyDummyDummyDummyDummyDummyDummy12"
expect_rc "[sftp] 5 a known_hosts with no line for this host is refused" 2 $? "$(grep -m1 FAILED "$OUT/r-sftp-unknown-host.log" | sed 's/^[0-9:]* deploy: //')"
dep r-ftps-badpin ftps a a b9 "DEPLOY_FTPS_CERT_SHA256=$FP_ROGUE"
expect_rc "[ftps] 5 a certificate that does not match the pinned fingerprint is refused" 2 $? "$(grep -m1 FAILED "$OUT/r-ftps-badpin.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-190)"
dep r-ftps-rogue ftps a a b9 DEPLOY_HOST=ftps-rogue
expect_rc "[ftps] 5 a hijacker (other certificate, real pin) is refused" 2 $?  "$(grep -m1 FAILED "$OUT/r-ftps-rogue.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-190)"
dep r-ftps-rogue-ca ftps a a b9 DEPLOY_HOST=ftps-rogue -DEPLOY_FTPS_CERT_SHA256
expect_rc "[ftps] 5 a hijacker against a pinned CA only (no fingerprint) fails chain verification" 2 $? "$(grep -E 'host:|FAILED' "$OUT/r-ftps-rogue-ca.log" | sed 's/^[0-9:]* deploy: //' | head -2 | tr '\n' '|' | cut -c1-230)"
dep r-ftps-nopin ftps a a b9 -DEPLOY_FTPS_CERT_SHA256 -DEPLOY_FTPS_CA_PEM
expect_rc "[ftps] 5 no pinned value at all is refused" 2 $? "$(grep -m1 FAILED "$OUT/r-ftps-nopin.log" | sed 's/^[0-9:]* deploy: //')"
dep r-ftp ftp a a b9
expect_rc "[ftp] 5 DEPLOY_TRANSPORT=ftp (plain FTP) is refused" 2 $? "$(grep -m1 FAILED "$OUT/r-ftp.log" | sed 's/^[0-9:]* deploy: //')"
dep r-ftps-plain ftps a a b9 DEPLOY_HOST=ftp-plain -DEPLOY_FTPS_CERT_SHA256
expect_rc "[ftps] 5 a server that offers only plain FTP is refused (ssl-force)" 2 $? "$(grep -E 'host:' "$OUT/r-ftps-plain.log" | head -1 | sed 's/^ *host: //')"
# the daemon's own view: a plain login at the TLS-only daemon is refused too (dummy password, not the canary)
plain="$(LFTP_PASSWORD=dummy-not-a-secret lftp -c "set cmd:fail-exit yes; set net:max-retries 1; set net:timeout 8; set ftp:ssl-allow no; open -u a --env-password ftp://ftps; cls -1 /" 2>&1 | tail -1)"
case "$plain" in *530*) result PASS "[ftps] 5 the FTPS daemon itself refuses a plain (non-TLS) login" "$plain" ;; *) result FAIL "[ftps] 5 daemon plain login" "$plain" ;; esac
dep r-sftp-roguesrv sftp a a b9 DEPLOY_HOST=sshd-rogue "DEPLOY_SFTP_KNOWN_HOSTS=sshd-rogue $(cut -d' ' -f1,2 /pki/ssh/ssh_host_ed25519_key.pub)"
expect_rc "[sftp] 5 a hijacking sshd (other host key than the pinned one) is refused" 2 $? "$(grep -E 'host:' "$OUT/r-sftp-roguesrv.log" | head -1 | sed 's/^ *host: //')"
for tr in sftp ftps; do
  dep "r-badpw-$tr" "$tr" a a b9 DEPLOY_PASSWORD=wrong-password-for-the-test
  expect_rc "[$tr] 5 a wrong credential is refused by the host and nothing is deployed" 7 $? "$(grep -E 'host:' "$OUT/r-badpw-$tr.log" | head -1 | sed 's/^ *host: //')"
done
# controls on the artifact
echo tamper >>"$ART/b9/index.html"
dep r-tamper sftp a a b9
expect_rc "[sftp] 5 an artifact changed after its manifest was made is refused, nothing uploaded" 2 $? "$(grep -m1 FAILED "$OUT/r-tamper.log" | sed 's/^[0-9:]* deploy: //' | cut -c1-140)"
mkbuild b9 0
dep r-minpages sftp a a b9 DEPLOY_MIN_PAGES=99
expect_rc "[sftp] 5 the minimum page count refuses a thin artifact" 2 $? "$(grep -m1 FAILED "$OUT/r-minpages.log" | sed 's/^[0-9:]* deploy: //')"
names="$(site_names a | tr '\n' ' ')"
case "$names" in *releases*|*deploy-lock*) result FAIL "[sftp] 5 refusals touched nothing on the host" "$names" ;; *) result PASS "[sftp] 5 none of the refusals touched the host" "$names" ;; esac
dep r-echo sftp a a b9 DEPLOY_TEST_ECHO_SECRET=1 DEPLOY_RELEASE_ID=r9-echo
rc=$?
if log_has r-echo 'leak-test: \[REDACTED\]' && ! grep -qF "$PW_A" "$OUT/r-echo.log"; then result PASS "[sftp] 6 when lftp itself prints the password, the redactor replaces it" "$(grep -m1 'leak-test' "$OUT/r-echo.log")"; else result FAIL "[sftp] 6 redactor" "rc=$rc"; fi
# key auth works too (sftp)
cp /pki/client_key /tmp/ck; chmod 600 /tmp/ck
dep r-key sftp a a b9 -DEPLOY_PASSWORD "DEPLOY_SSH_KEY=$(cat /tmp/ck)" DEPLOY_RELEASE_ID=r9-b9
expect_rc "[sftp] 5 key authentication (no password) deploys too" 0 $? "$(grep -E 'DEPLOY OK' "$OUT/r-key.log" | sed 's/^[0-9:]* deploy: //')"
fi

# ================================================================ case 6: the canary
echo
echo "================ canary ================"
keyline="$(sed -n 2p /tmp/ck 2>/dev/null)"; [ -n "$keyline" ] || keyline="no-key-line-in-this-run-$$"
hits="$(grep -rlF -e "$PW_A" -e "$PW_B" -e "$keyline" "$OUT" 2>/dev/null | tr '\n' ' ')"
nlogs="$(ls "$OUT"/*.log | wc -l | tr -d ' ')"
if [ -z "$hits" ]; then result PASS "6 the canary credentials appear in none of the $nlogs captured deploy outputs"; else result FAIL "6 canary found in: $hits"; fi
# and not in argv of any process the client ran: the deploy scripts keep it in the environment
echo "CANARY_FILE_DIR $OUT"

echo
echo "### cases passed: $PASSN, failed: $FAILN"
if [ "$FAILN" -gt 0 ]; then printf 'FAILED: %s\n' "${FAILED[@]}"; fi
[ "$FAILN" = 0 ]
