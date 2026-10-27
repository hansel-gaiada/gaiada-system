#!/usr/bin/env bash
# AIP-00a step 2 (runbook infra/runbooks/aip-00a-hermes-behind-gateway.md), run as Hansel on gda-aicenter.
# Turns the gateway's agent listener on with the two token HASHES from step 1, and starts the mesh proxy
# (10.88.0.1:3012 -> 127.0.0.1:3012, sumopod 10.88.0.2 only). Rollback: restore .env.bak-aip00a, recreate
# ai-gateway the same way, `sudo systemctl disable --now gaiada-agent-proxy`.
set -euo pipefail
TOK="${1:?usage: step2-gda.sh 'hermes-seo:<hash>,hermes-bsc:<hash>'}"
[[ "$TOK" =~ ^hermes-seo:[0-9a-f]{64},hermes-bsc:[0-9a-f]{64}$ ]] || { echo "the argument is not two name:hash entries"; exit 2; }
cd /home/Hansel/gaiada/infra/compose
cp -a .env .env.bak-aip00a
for kv in "GATEWAY_AGENT_LISTEN=0.0.0.0:3012" "GATEWAY_AGENT_TOKENS=$TOK" "GATEWAY_AGENT_RESERVE_PCT=25"; do
  k=${kv%%=*}; sed -i "/^$k=/d" .env; printf '%s\n' "$kv" >> .env
done
echo "tags in .env:"; grep -E '^GAIADA_TAG=|^APP_VERSION=' .env
docker compose -p gaiada -f docker-compose.vps.yml -f docker-compose.hostdata.yml -f docker-compose.observability.yml up -d --no-deps ai-gateway
sudo tee /etc/systemd/system/gaiada-agent-proxy.service >/dev/null <<'UNIT'
[Unit]
Description=AIP-00a: mesh entry (10.88.0.1:3012, from the sumopod relay only) to the gateway's agent listener
After=wg-quick@wg0.service docker.service
Requires=wg-quick@wg0.service
[Service]
ExecStart=/usr/bin/socat TCP4-LISTEN:3012,bind=10.88.0.1,fork,reuseaddr,range=10.88.0.2:255.255.255.255 TCP4:127.0.0.1:3012
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now gaiada-agent-proxy
sleep 5
echo "== listeners on 3012:"; ss -ltn | grep ':3012 ' || true
curl -s -o /dev/null -w 'loopback /v1/models without a token: %{http_code} (want 401)\n' http://127.0.0.1:3012/v1/models
docker logs gaiada-ai-gateway-1 2>&1 | grep -i 'agent listener' | tail -2 || true
docker ps --filter name=gaiada-ai-gateway-1 --format '{{.Image}} {{.Status}}'
