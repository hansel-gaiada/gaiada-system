#!/usr/bin/env bash
# M5-V2-c static gate for the Umami compose project. Run it ON sumopod (or any Linux box with docker), from the
# directory that holds docker-compose.yml. It changes nothing: no container is started except throwaway
# `nginx -t` runs, no .env is read (a dummy env file is generated), no secret is needed.
#
#   ./check-config.sh            # structure checks; the collector image pin may still be the PLACEHOLDER (warns)
#   ./check-config.sh --deploy   # also FAILS while the collector image is still the placeholder (use before `up`)
#
# Checks (each prints PASS/FAIL, exit 1 if any FAIL):
#   1. bash -n / sh -n on every shell script
#   2. docker compose config -q for the default project and every profile
#   3. every committed image is pinned (no :latest, every one has @sha256); the collector placeholder warns/fails
#   4. only edge, admin-gate and read-gate touch a non-internal network; collector and vdb are on `internal` only
#   5. the collector's environment: lists every variable insights-collector reads (the passthrough trap)
#   6. every ${VAR} the compose file uses is documented in .env.example
#   7. the three nginx templates render in the PINNED nginx image on a read-only root fs and pass `nginx -t`;
#      the rendered edge sends the collect path to the collector and still 404s everything else
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 2
DEPLOY=0
case "${1:-}" in --deploy) DEPLOY=1 ;; "") ;; *) echo "usage: $0 [--deploy]" >&2; exit 2 ;; esac

FAILS=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Dummy values only (never real secrets). Every `:?` variable in docker-compose.yml needs one.
cat > "$TMP/dummy.env" <<'EOF'
UMAMI_DB_PASSWORD=dummy
APP_SECRET=dummy
TWO_FACTOR_ENCRYPTION_KEY=dummy
TRACKER_SCRIPT_NAME=/lib/kestrel.js
COLLECT_API_ENDPOINT=/lib/kestrel/e
ERP_EDGE_SOURCE=10.211.91.1
VDB_PASSWORD=dummy
INSIGHTS_WEBSITES=00000000-0000-0000-0000-000000000000
OPS_READ_KEY_SHA256=0000000000000000000000000000000000000000000000000000000000000000
OPS_FORGET_KEY_SHA256=1111111111111111111111111111111111111111111111111111111111111111
EOF
DC=(docker compose --env-file "$TMP/dummy.env")

# 1. shell syntax ---------------------------------------------------------------------------------------------
SH_OK=1
for F in *.sh; do bash -n "$F" 2> "$TMP/err" || { fail "bash -n $F: $(head -c 200 "$TMP/err")"; SH_OK=0; }; done
for F in egress-guard.sh umami-backup-receive.sh; do sh -n "$F" 2> "$TMP/err" || { fail "sh -n $F: $(head -c 200 "$TMP/err")"; SH_OK=0; }; done
[ "$SH_OK" = 1 ] && pass "bash -n / sh -n on every script"

# 2. compose config for every profile -------------------------------------------------------------------------
"${DC[@]}" config -q 2> "$TMP/err" && pass "compose config -q (default)" || fail "compose config -q (default): $(head -c 300 "$TMP/err")"
"${DC[@]}" --profile admin --profile erp-read config -q 2> "$TMP/err" && pass "compose config -q (all profiles)" || fail "compose config -q (all profiles): $(head -c 300 "$TMP/err")"
"${DC[@]}" --profile admin --profile erp-read config --format json > "$TMP/cfg.json" 2> "$TMP/err" || fail "compose config --format json: $(head -c 300 "$TMP/err")"

# 3-5. structural checks on the resolved config (python3 is on the host; pure stdlib) --------------------------
python3 - "$TMP/cfg.json" "$DEPLOY" <<'PY' || FAILS=$((FAILS + 1))
import json, re, sys
cfg = json.load(open(sys.argv[1])); deploy = sys.argv[2] == "1"
svc = cfg["services"]; bad = 0
def say(ok, msg):
    global bad
    print(("PASS  " if ok else "FAIL  ") + msg)
    if not ok: bad += 1

# 3. pins
for name, s in svc.items():
    img = s["image"]
    if "PLACEHOLDER" in img or re.search(r"@sha256:0{64}$", img):
        if deploy: say(False, f"{name}: image is still the PLACEHOLDER pin ({img}); fill it from the first signed release (runbook C1)")
        else: print(f"WARN  {name}: image is the PLACEHOLDER pin; --deploy refuses it")
    else:
        say(re.search(r"@sha256:[0-9a-f]{64}$", img) is not None and ":latest" not in img, f"{name}: image pinned by digest, not latest ({img.split('@')[0]})")

# 4. networks: non-internal ones
nets = cfg.get("networks", {})
internal = {n for n, d in nets.items() if d.get("internal")}
allowed_external = {"edge", "admin-gate", "read-gate"}
for name, s in svc.items():
    on = set((s.get("networks") or {}).keys())
    ext = {n for n in on if n not in internal}
    if name in ("collector", "vdb", "app", "db"):
        say(on == {"internal"}, f"{name}: on the internal network only ({sorted(on)})")
    elif name not in allowed_external:
        say(not ext, f"{name}: touches no non-internal network ({sorted(on)})")
    if name != "edge" and name not in allowed_external and s.get("ports"):
        say(False, f"{name}: publishes a port")
for name in ("collector", "vdb"):
    say(not svc[name].get("ports"), f"{name}: publishes nothing")

# 5. the collector's environment lists every variable insights-collector reads (insights-collector/CLAUDE.md table)
needed = ["COLLECT_API_ENDPOINT","INSIGHTS_WEBSITES","DATABASE_URL","OPS_READ_KEY_SHA256","LISTEN_ADDR","OPS_ADDR","UMAMI_URL",
          "UMAMI_TIMEOUT_MS","MAX_BODY_BYTES","BOT_FLUSH_SECONDS","GEO_DIR","GEO_CITY_FILE","GEO_ASN_FILE","GEO_REQUIRED",
          "FORWARD_IP_MODE","COMPANY_RESOLVER","LOG_LEVEL",
          "OPS_FORGET_KEY_SHA256","CONSENT_EVENT_NAMES","CONSENT_RATE_PER_SECOND","BUFFER_RETENTION_HOURS","PURGE_INTERVAL_MINUTES"]
env = svc["collector"].get("environment", {})
missing = [k for k in needed if k not in env]
say(not missing, "collector environment: lists every variable the binary reads" + (f" (MISSING {missing})" if missing else ""))
say(env.get("FORWARD_IP_MODE", "") in ("", "pseudonym"), "collector FORWARD_IP_MODE is the default pseudonym mode (real is the recorded fallback only)")
say(svc["collector"].get("read_only") is True and "ALL" in [c.upper() for c in svc["collector"].get("cap_drop", [])], "collector: read_only and cap_drop ALL")
lim = {n: (svc[n].get("mem_limit"), svc[n].get("pids_limit")) for n in ("collector", "vdb")}
say(str(lim["collector"][0]) in ("192m", "201326592") and lim["collector"][1] == 64, f"collector limits mem/pids = {lim['collector']} (design 3.1: 192m / 64)")
sys.exit(1 if bad else 0)
PY

# 6. every ${VAR} in the compose file is documented in .env.example --------------------------------------------
MISSING_DOC=""
for V in $(sed 's/\$\$//g' docker-compose.yml | grep -o '\${[A-Z_][A-Z0-9_]*' | tr -d '${' | sort -u); do
  grep -qE "^#? ?${V}=" .env.example || MISSING_DOC="$MISSING_DOC $V"
done
[ -z "$MISSING_DOC" ] && pass "every \${VAR} in docker-compose.yml is documented in .env.example" || fail ".env.example does not mention:$MISSING_DOC"

# 7. nginx templates in the pinned image ----------------------------------------------------------------------
NGINX_IMG="$(grep -m1 -oE 'nginxinc/nginx-unprivileged:[^ ]+@sha256:[0-9a-f]{64}' docker-compose.yml)"
if [ -z "$NGINX_IMG" ]; then
  fail "no pinned nginx-unprivileged image found in docker-compose.yml"
else
  render() { # $1 = template file; the rest are extra -e args. Prints `nginx -T` of the rendered config on stdout.
    local T="$1"; shift
    docker run --rm --read-only --tmpfs /tmp:size=16m,mode=1777 \
      --add-host app:127.0.0.1 --add-host collector:127.0.0.1 \
      -e NGINX_ENVSUBST_OUTPUT_DIR=/tmp \
      -e TRACKER_SCRIPT_NAME=/lib/kestrel.js -e COLLECT_API_ENDPOINT=/lib/kestrel/e \
      -e ERP_EDGE_SOURCE=10.211.91.1 -e EDGE_COLLECT_UPSTREAM=collector:8080 "$@" \
      -v "$HERE/nginx/nginx.conf:/etc/nginx/nginx.conf:ro" \
      -v "$HERE/nginx/proxy-common.inc:/etc/nginx/proxy-common.inc:ro" \
      -v "$HERE/nginx/$T:/etc/nginx/templates/x.conf.template:ro" \
      "$NGINX_IMG" nginx -t -T 2>&1
  }
  for T in edge.conf.template admin.conf.template read.conf.template; do
    if render "$T" > "$TMP/render.$T" && grep -q 'test is successful' "$TMP/render.$T"; then pass "nginx -t: $T"
    else fail "nginx -t: $T -- $(tail -n 5 "$TMP/render.$T" | tr '\n' ' ' | head -c 300)"; fi
  done
  # edge, collector mode: the collect path goes to the collector; the collector must not appear for any other path
  if grep -qE '^\s*set \$collect_upstream "collector:8080";' "$TMP/render.edge.conf.template"; then pass "edge renders: collect path -> collector:8080"
  else fail "edge render: collect location does not point at collector:8080"; fi
  grep -qE 'location = /lib/kestrel/e ' "$TMP/render.edge.conf.template" && pass "edge renders: exact location for the collect path" || fail "edge render: no exact collect location"
  # /v /f /r stay OFF (404 through `location /`) until V3-b / V6-a
  if grep -qE '^\s*location = /lib/kestrel/[vfr]' "$TMP/render.edge.conf.template"; then fail "edge render: /v /f /r is enabled before its ticket"; else pass "edge renders: /lib/kestrel/v|f|r are templated but off (404)"; fi
  grep -q 'location / { return 404; }' "$TMP/render.edge.conf.template" && pass "edge renders: everything else 404s" || fail "edge render: the catch-all 404 is missing"
  # rollback mode renders too
  if render edge.conf.template -e EDGE_COLLECT_UPSTREAM=app:3000 2>&1 | grep -qE '^\s*set \$collect_upstream "app:3000";'; then pass "edge renders in rollback mode (EDGE_COLLECT_UPSTREAM=app:3000)"
  else fail "edge rollback render failed"; fi
fi

echo
if [ "$FAILS" -eq 0 ]; then echo "check-config: ALL PASS"; exit 0; fi
echo "check-config: $FAILS FAIL"; exit 1
