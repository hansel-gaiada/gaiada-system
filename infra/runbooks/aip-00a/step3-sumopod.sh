#!/usr/bin/env bash
# AIP-00a step 3 (runbook infra/runbooks/aip-00a-hermes-behind-gateway.md), run as ubuntu on sumopod.
# The relay 10.88.0.2:3012 (helios 10.88.0.3 only) -> gda-aicenter 10.88.0.1:3012. Rollback:
# `sudo systemctl disable --now gaiada-agent-relay` and
# `sudo ufw delete allow in on wg0 from 10.88.0.3 to 10.88.0.2 port 3012 proto tcp`.
set -euo pipefail
command -v socat >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y socat >/dev/null
sudo tee /etc/systemd/system/gaiada-agent-relay.service >/dev/null <<'UNIT'
[Unit]
Description=AIP-00a: relay helios (10.88.0.3) to the gateway's mesh entry on gda-aicenter
After=wg-quick@wg0.service
Requires=wg-quick@wg0.service
[Service]
ExecStart=/usr/bin/socat TCP4-LISTEN:3012,bind=10.88.0.2,fork,reuseaddr,range=10.88.0.3:255.255.255.255 TCP4:10.88.0.1:3012
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now gaiada-agent-relay
sudo ufw allow in on wg0 from 10.88.0.3 to 10.88.0.2 port 3012 proto tcp comment 'AIP-00a relay'
sleep 3
echo "== listeners on 3012:"; ss -ltn | grep ':3012 ' || true
curl -s -o /dev/null -w 'sumopod -> gda-aicenter /v1/models without a token: %{http_code} (want 401)\n' http://10.88.0.1:3012/v1/models
