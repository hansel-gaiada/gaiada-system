#!/bin/bash
# WSK-63a proof driver. Run ON a Linux box with docker, from the extracted tree root:
#   cd ~/gate-wsk63a && bash webdesk/ops/nginx/proof/run.sh        (tree = `git archive HEAD webdesk infra`)
# Containers only; network gate-wsk63a; NO host ports; full teardown on exit (trap).
# Pinned inputs: debian:bookworm-slim (+ apt nginx 1.22.1 / njs 0.7.9, the aicenter versions), caddy:2-alpine
# (the tag the compose file uses; the aicenter host runs that image id), node:22-alpine.
set -u
R="$(cd "$(dirname "$0")/../../../.." && pwd)"       # tree root (contains webdesk/ and infra/)
P=$R/webdesk/ops/nginx/proof
NET=gate-wsk63a
SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')      # 64 hex chars, throwaway
mkdir -p "$R/certs"
cleanup() {
  docker rm -f gw-echo gw-proxy gw-proxy-empty gw-nginx >/dev/null 2>&1
  docker network rm $NET >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
rc=0

echo "=== [1] build nginx proof image (aicenter-equivalent nginx + njs)"
docker build -q -t gate-wsk63a-nginx -f "$P/Dockerfile.nginx" "$P" || exit 1
docker run --rm gate-wsk63a-nginx sh -c 'nginx -v 2>&1; dpkg -s libnginx-mod-http-js | grep ^Version'

echo "=== [2] throwaway CA + certs"
docker run --rm -v "$R/certs:/certs" -v "$R:/repo:ro" gate-wsk63a-nginx sh /repo/webdesk/ops/nginx/proof/gen-certs.sh || exit 1

echo "=== [3] caddy validate (the real, unmodified Caddyfile)"
docker run --rm -e WEBDESK_CONTROL_GATE_SECRET=$SECRET -e WEBDESK_EDGE_VERIFY_SECRET= \
  -v "$R/webdesk/proxy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -3
docker run --rm -v "$R/webdesk/proxy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy fmt --diff /etc/caddy/Caddyfile >/dev/null 2>&1; echo "caddy fmt --diff exit=$? (informational: file pre-dates this ticket)"

echo "=== [4] nginx -t on the RENDERED production vhost (unmodified listen/proxy_pass), njs module loaded"
docker run --rm --sysctl net.ipv4.ip_nonlocal_bind=1 -e WEBDESK_CONTROL_GATE_SECRET=$SECRET \
  -v "$R:/repo:ro" -v "$R/certs:/certs:ro" gate-wsk63a-nginx sh -c '
  mkdir -p /etc/nginx/webdesk-control /etc/nginx/njs
  cp /certs/ca-cert.pem /certs/server.crt /certs/server.key /etc/nginx/webdesk-control/
  cp /repo/webdesk/ops/nginx/webdesk-control-cert.js /etc/nginx/njs/
  envsubst "\${WEBDESK_CONTROL_GATE_SECRET}" < /repo/webdesk/ops/nginx/control.webdesk.internal.conf > /etc/nginx/sites-enabled/control.webdesk.internal
  grep -c "WEBDESK_CONTROL_GATE_SECRET" /etc/nginx/sites-enabled/control.webdesk.internal | sed "s/^/unrendered placeholders left: /"
  nginx -t' || rc=1

echo "=== [5] mini-topology: nginx(mTLS) -> caddy(real Caddyfile) -> echo(api stand-in)"
docker network create $NET >/dev/null
docker run -d --name gw-echo --network $NET --network-alias api -e CA_FILE=/certs/ca-cert.pem \
  -v "$R:/repo:ro" -v "$R/certs:/certs:ro" node:22-alpine \
  node --experimental-strip-types /repo/webdesk/ops/nginx/proof/echo.mjs >/dev/null
docker run -d --name gw-proxy --network $NET --cap-add NET_ADMIN -e WEBDESK_CONTROL_GATE_SECRET=$SECRET -e WEBDESK_EDGE_VERIFY_SECRET= \
  -v "$R/webdesk/proxy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
sleep 3
docker run -d --name gw-nginx --network container:gw-proxy --cap-add NET_ADMIN -e WEBDESK_CONTROL_GATE_SECRET=$SECRET \
  -v "$R:/repo:ro" -v "$R/certs:/certs:ro" gate-wsk63a-nginx sh /repo/webdesk/ops/nginx/proof/nginx-entry.sh >/dev/null
sleep 4
docker logs gw-echo 2>&1 | tail -3
docker logs gw-nginx 2>&1 | tail -4
docker exec -e WEBDESK_CONTROL_GATE_SECRET=$SECRET gw-nginx sh /repo/webdesk/ops/nginx/proof/client-tests.sh || rc=1

echo "=== [6] fail-closed: Caddy with an EMPTY gate secret must still 404 /control/* (even an empty gate header)"
docker run -d --name gw-proxy-empty --network $NET -e WEBDESK_CONTROL_GATE_SECRET= -e WEBDESK_EDGE_VERIFY_SECRET= \
  -v "$R/webdesk/proxy/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null
sleep 3
docker run --rm --network $NET gate-wsk63a-nginx sh -c '
  a=$(curl -s -o /dev/null -w "%{http_code}" http://gw-proxy-empty/control/v1/tenants)
  b=$(curl -s -o /dev/null -w "%{http_code}" -H "X-Webdesk-Control-Gate;" http://gw-proxy-empty/control/v1/tenants)
  echo "empty secret, no header: http=$a ; empty secret, empty header: http=$b"
  [ "$a" = 404 ] && [ "$b" = 404 ] && echo "  => PASS  fail-closed" || echo "  => FAIL  fail-closed"'

echo "=== [7] published-port audit of the RESOLVED aicenter config"
cd "$R/webdesk"
touch .env.control
cp .env.example .env.audit
{ echo STORAGE_ACCESS_KEY_ID=x; echo STORAGE_SECRET_ACCESS_KEY=x; echo API_KEY_PEPPER=x; echo WEBDESK_CONTROL_GATE_SECRET=$SECRET; } >> .env.audit
docker compose --env-file .env.audit -f docker-compose.yml -f docker-compose.aicenter.yml config > /tmp/gate-wsk63a-resolved.yml 2>/tmp/gate-wsk63a-config.err || { echo "compose config FAILED"; tail -5 /tmp/gate-wsk63a-config.err; rc=1; }
echo "-- every 'published:' / 'ports:' in the resolved config:"
grep -n -E '^\s+ports:|published:|host_ip:|target:' /tmp/gate-wsk63a-resolved.yml
echo "-- services with a ports: key:"
awk '/^  [a-z-]+:$/{svc=$1} /^    ports:/{print svc}' /tmp/gate-wsk63a-resolved.yml
echo "-- proxy environment (secret value masked):"
awk '/^  proxy:$/{f=1} f&&/WEBDESK_(CONTROL_GATE|EDGE_VERIFY)_SECRET/{print}' /tmp/gate-wsk63a-resolved.yml | sed -E 's/(GATE_SECRET: ).*/\1<set, masked>/'
echo "-- networks used (must be only the project default):"
grep -n -A3 '^networks:' /tmp/gate-wsk63a-resolved.yml
rm -f .env.audit .env.control
echo "compose version: $(docker compose version --short)"
echo "=== DONE rc=$rc"
exit $rc
