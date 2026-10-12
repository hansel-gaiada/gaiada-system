#!/bin/sh
# M6-P3d — runs ON sumopod from cron: pull the MON-01 probe-target file from gda-aicenter, validate
# it strictly, and atomically replace the file Prometheus' `client-properties` job reads.
#
# The file is rendered by platform-nest (platform-nest/src/modules/monitoring/client-targets.ts) and
# served by infra/scripts/client-targets-forced-command.sh behind a one-file forced-command key. See
# the long header of sync-client-property-targets.sh for why the inventory stays on gda-aicenter and
# only this minimal file crosses to sumopod. Runbook: infra/runbooks/enable-estate-blackbox-and-alert-routing.md §7.
#
# On ANY failure the previous file is kept and the script exits non-zero with ONE line on stderr.
# It never writes an empty or partial file because the network or the validator failed.
#
# Usage:  pull-client-property-targets.sh <user@host> <ssh-key-file> [dest-file]
#         pull-client-property-targets.sh --selftest
# Host, user and key are arguments (or PULL_SSH_TARGET / PULL_SSH_KEY / PULL_DEST), never hardcoded.
# Default dest: $HOME/gaiada-obs/infra/observability/prometheus/targets/client-properties.json
#
# Cron (sumopod's cron IGNORES CRON_TZ, but an every-5-minutes schedule has no hour in it, so it is
# timezone-independent):
#   */5 * * * * /home/<user>/gaiada-obs/infra/scripts/pull-client-property-targets.sh <user@host> ~/.ssh/<key> >> /var/log/gaiada-client-targets-pull.log 2>&1
#
# Needs python3 on the box (used only as a strict JSON parser; no packages). Absent python3 = fail.
set -eu

TOKEN="gaiada-client-targets"
MAX_TARGETS=2000

# Strict validator. Reads the candidate file path as argv[1]; prints one reason and exits 1 on any
# violation. Accepts: a JSON array of {"targets": [url], "labels": {allow-listed string: string}}.
# Each target must be an http(s) URL with a plain host (no userinfo) that is not private/loopback —
# defence in depth: the platform already refuses those, a compromised producer must not get past here.
VALIDATOR='
import json, re, sys
MAX = int(sys.argv[2])
ALLOWED = {"property_domain", "tenant_id", "client_id", "internal", "hosting_provider", "control_panel", "stack"}
REQUIRED = {"property_domain", "tenant_id", "client_id", "internal"}
URL = re.compile(r"^https?://([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?(/[^\s]*)?$")
PRIVATE = [re.compile(p, re.I) for p in (
    r"^localhost$", r"^127\.", r"^10\.", r"^192\.168\.", r"^172\.(1[6-9]|2[0-9]|3[01])\.",
    r"^169\.254\.", r"^\[?::1\]?$", r"^\[?f[cd][0-9a-f]{2}:", r"\.internal$", r"\.local$")]
def fail(msg):
    print(msg); sys.exit(1)
try:
    with open(sys.argv[1], "rb") as f:
        raw = f.read()
    data = json.loads(raw.decode("utf-8"))
except Exception as e:
    fail("not valid JSON: %s" % type(e).__name__)
if not isinstance(data, list):
    fail("top level is not an array")
if len(data) > MAX:
    fail("%d entries exceeds the maximum of %d" % (len(data), MAX))
for i, e in enumerate(data):
    if not isinstance(e, dict) or set(e.keys()) != {"targets", "labels"}:
        fail("entry %d is not exactly {targets, labels}" % i)
    t, l = e["targets"], e["labels"]
    if not isinstance(t, list) or len(t) != 1 or not isinstance(t[0], str):
        fail("entry %d targets is not a single string" % i)
    m = URL.match(t[0])
    if not m or len(t[0]) > 2048:
        fail("entry %d target is not an http(s) host URL" % i)
    host = m.group(1)
    if any(p.search(host) for p in PRIVATE):
        fail("entry %d target host is private/loopback" % i)
    if not isinstance(l, dict):
        fail("entry %d labels is not an object" % i)
    bad = set(l.keys()) - ALLOWED
    if bad:
        fail("entry %d has a label key outside the allow-list" % i)
    if not REQUIRED <= set(l.keys()):
        fail("entry %d is missing a required label" % i)
    for k, v in l.items():
        if not isinstance(v, str) or len(v) > 253 or re.search(r"[\x00-\x1f\x7f]", v):
            fail("entry %d label value is not a short printable string" % i)
    if l["internal"] not in ("true", "false"):
        fail("entry %d internal label is not true/false" % i)
'

validate() { # <file> -> prints reason and returns 1 when invalid
  command -v python3 >/dev/null 2>&1 || { echo "python3 not found (needed to validate)"; return 1; }
  python3 -I -c "$VALIDATOR" "$1" "$MAX_TARGETS"
}

selftest() {
  failed=0
  d=$(mktemp -d)
  trap 'rm -rf "$d"' EXIT
  expect() { # name, want (0|1), json
    printf '%s' "$3" > "$d/c.json"
    rc=0; validate "$d/c.json" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "$2" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (want $2, got $rc)"; failed=$((failed + 1)); fi
  }
  L='"labels":{"property_domain":"a.example.com","tenant_id":"t","client_id":"c","internal":"false"}'
  expect "an empty array is valid" 0 '[]'
  expect "a good entry is valid" 0 "[{\"targets\":[\"https://a.example.com\"],$L}]"
  expect "an http entry with a port and path is valid" 0 "[{\"targets\":[\"http://a.example.com:8080/x\"],$L}]"
  expect "optional labels are valid" 0 '[{"targets":["https://a.example.com"],"labels":{"property_domain":"a","tenant_id":"t","client_id":"c","internal":"true","stack":"wp","hosting_provider":"h","control_panel":"p"}}]'
  expect "not JSON is refused" 1 'oops'
  expect "an object at the top level is refused" 1 '{}'
  expect "a truncated file is refused" 1 "[{\"targets\":[\"https://a.example.com\"],$L"
  expect "a non-http scheme is refused" 1 "[{\"targets\":[\"file:///etc/passwd\"],$L}]"
  expect "userinfo in the host is refused" 1 "[{\"targets\":[\"https://u:p@a.example.com\"],$L}]"
  expect "the metadata endpoint is refused" 1 "[{\"targets\":[\"http://169.254.169.254/\"],$L}]"
  expect "a private host is refused" 1 "[{\"targets\":[\"https://10.0.0.5\"],$L}]"
  expect "localhost is refused" 1 "[{\"targets\":[\"http://localhost\"],$L}]"
  expect "two targets in one entry are refused" 1 "[{\"targets\":[\"https://a.example.com\",\"https://b.example.com\"],$L}]"
  expect "a label key outside the allow-list is refused" 1 '[{"targets":["https://a.example.com"],"labels":{"property_domain":"a","tenant_id":"t","client_id":"c","internal":"false","__scheme__":"http"}}]'
  expect "a missing required label is refused" 1 '[{"targets":["https://a.example.com"],"labels":{"property_domain":"a"}}]'
  expect "a non-string label value is refused" 1 '[{"targets":["https://a.example.com"],"labels":{"property_domain":"a","tenant_id":1,"client_id":"c","internal":"false"}}]'
  expect "internal must be true or false" 1 '[{"targets":["https://a.example.com"],"labels":{"property_domain":"a","tenant_id":"t","client_id":"c","internal":"yes"}}]'
  expect "an extra top-level entry key is refused" 1 "[{\"targets\":[\"https://a.example.com\"],$L,\"x\":1}]"
  # Over the maximum count.
  python3 -I -c "
import json
e={'targets':['https://a.example.com'],'labels':{'property_domain':'a','tenant_id':'t','client_id':'c','internal':'false'}}
print(json.dumps([e]*($MAX_TARGETS+1)))" > "$d/big.json"
  rc=0; validate "$d/big.json" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 1 ]; then echo "  PASS  more than the maximum count is refused"; else echo "  FAIL  max count (got $rc)"; failed=$((failed + 1)); fi

  # End to end with a stub ssh: failure keeps the old file, success replaces it, no-op is a no-op.
  mkdir "$d/bin" "$d/out"
  printf 'OLD\n' > "$d/out/dest.json"
  cat > "$d/bin/ssh" <<STUB
#!/bin/sh
[ -n "\${STUB_FAIL:-}" ] && exit 255
cat "\$STUB_PAYLOAD"
STUB
  chmod +x "$d/bin/ssh"
  printf '%s' "[{\"targets\":[\"https://a.example.com\"],$L}]" > "$d/good.json"
  printf 'garbage' > "$d/bad.json"
  rc=0; PATH="$d/bin:$PATH" STUB_FAIL=1 sh "$0" u@h.example.com /dev/null "$d/out/dest.json" >/dev/null 2>&1 || rc=$?
  [ "$rc" != 0 ] && [ "$(cat "$d/out/dest.json")" = OLD ] && echo "  PASS  an ssh failure keeps the old file" || { echo "  FAIL  ssh failure (rc $rc)"; failed=$((failed + 1)); }
  rc=0; PATH="$d/bin:$PATH" STUB_PAYLOAD="$d/bad.json" sh "$0" u@h.example.com /dev/null "$d/out/dest.json" >/dev/null 2>&1 || rc=$?
  [ "$rc" != 0 ] && [ "$(cat "$d/out/dest.json")" = OLD ] && echo "  PASS  an invalid payload keeps the old file" || { echo "  FAIL  invalid payload (rc $rc)"; failed=$((failed + 1)); }
  rc=0; PATH="$d/bin:$PATH" STUB_PAYLOAD="$d/good.json" sh "$0" u@h.example.com /dev/null "$d/out/dest.json" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] && cmp -s "$d/good.json" "$d/out/dest.json" && echo "  PASS  a valid payload replaces the file" || { echo "  FAIL  valid payload (rc $rc)"; failed=$((failed + 1)); }
  left=$(ls -A "$d/out" | grep -c -v '^dest.json$' || true)
  [ "$left" = 0 ] && echo "  PASS  no temp files are left behind" || { echo "  FAIL  temp files left"; failed=$((failed + 1)); }

  echo "  selftest: $failed failed"
  [ "$failed" -eq 0 ]
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit $?
fi

TARGET="${1:-${PULL_SSH_TARGET:-}}"
KEY="${2:-${PULL_SSH_KEY:-}}"
DEST="${3:-${PULL_DEST:-$HOME/gaiada-obs/infra/observability/prometheus/targets/client-properties.json}}"
if [ -z "$TARGET" ] || [ -z "$KEY" ]; then
  echo "pull-client-property-targets: usage: <user@host> <ssh-key-file> [dest-file]" >&2
  exit 2
fi

DESTDIR=$(dirname "$DEST")
[ -d "$DESTDIR" ] || { echo "pull-client-property-targets: destination directory missing: $DESTDIR" >&2; exit 2; }
TMP=$(mktemp "$DESTDIR/.client-properties.pull.XXXXXX") || { echo "pull-client-property-targets: cannot create a temp file in $DESTDIR" >&2; exit 2; }
trap 'rm -f "$TMP"' EXIT

# BatchMode: never prompt. IdentitiesOnly: offer only this key. The remote forced command ignores the
# command word except to check it equals the token; passing the token keeps the intent explicit.
if ! ssh -i "$KEY" -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3 \
    "$TARGET" "$TOKEN" > "$TMP" 2>/dev/null; then
  echo "pull-client-property-targets: ssh to the ERP host failed; kept the previous file" >&2
  exit 1
fi

reason=$(validate "$TMP") || {
  echo "pull-client-property-targets: payload rejected (${reason:-validator error}); kept the previous file" >&2
  exit 1
}

if [ -f "$DEST" ] && cmp -s "$TMP" "$DEST"; then
  exit 0   # unchanged: no rename, no file_sd churn
fi
chmod 0644 "$TMP"
mv -f "$TMP" "$DEST"
trap - EXIT
echo "pull-client-property-targets: updated $(date -u +%Y-%m-%dT%H:%M:%SZ)"
