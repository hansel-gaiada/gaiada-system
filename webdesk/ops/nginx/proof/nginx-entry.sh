#!/bin/sh
# WSK-63a proof: boots nginx inside Caddy's network namespace (--network container:...), laid out like
# gda-aicenter (/etc/nginx/webdesk-control, /etc/nginx/njs, sites-enabled).
# TEST-ONLY substitutions, all stated here so nothing is hidden:
#   1. 172.17.0.1 is added to the loopback device, so the production `listen 172.17.0.1:9443` is used UNMODIFIED.
#   2. proxy_pass port 8380 -> 80, because in this netns Caddy listens on :80 (production publishes it as 127.0.0.1:8380).
set -eu
ip addr add 172.17.0.1/32 dev lo
mkdir -p /etc/nginx/webdesk-control /etc/nginx/njs
cp /certs/ca-cert.pem /certs/server.crt /certs/server.key /etc/nginx/webdesk-control/
cp /repo/webdesk/ops/nginx/webdesk-control-cert.js /etc/nginx/njs/
envsubst '${WEBDESK_CONTROL_GATE_SECRET}' < /repo/webdesk/ops/nginx/control.webdesk.internal.conf > /tmp/control.rendered
chmod 600 /tmp/control.rendered
grep -q 'listen 172.17.0.1:9443 ssl;' /tmp/control.rendered
sed 's#http://127.0.0.1:8380#http://127.0.0.1:80#' /tmp/control.rendered > /etc/nginx/sites-enabled/control.webdesk.internal
cp /repo/webdesk/ops/nginx/proof/public-vhost.test.conf /etc/nginx/sites-enabled/api.public.test
nginx -t
exec nginx -g 'daemon off;'
