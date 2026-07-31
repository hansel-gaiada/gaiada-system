# Hermes integration — gda-aicenter

Three systemd units that expose the **existing** Hermes install to our stack over localhost ports.
Nothing in `/opt/hermes-zen` is moved, copied, or re-owned; azlan keeps ownership of Hermes and its
DeepSeek credentials, and we consume it across a port boundary.

| Unit | Port | What it gives us |
|---|---|---|
| `hermes-serve.service` | `127.0.0.1:9119` | Hermes' own JSON-RPC/WebSocket backend |
| `hermes-mcp.service` | stdio | Hermes exposed as an **MCP server** |
| `hermes-gateway.service` | `127.0.0.1:3009` | Gateway-contract shim — **this is the one the stack needs** |

## Why the shim is the load-bearing one

`ai-gateway-go` in `GATEWAY_TOPOLOGY_MODE=site` drops every cloud provider ("site mode never holds
cloud keys") and auto-appends its `central-forward` provider, which POSTs:

```
POST /complete  {"prompt": "…"}             -> {"text": "…"}
POST /media     {"base64": "…","mime": "…"} -> {"text": "…"}
Authorization: Bearer <GATEWAY_TOKEN>
```

That is byte-for-byte the contract `hermes-gateway/` already implements. So pointing
`GATEWAY_CENTRAL_URL` at `http://host.docker.internal:3009` makes Hermes the brain of the whole
stack with **zero code change**, while DLP, the daily cost cap, the egress audit and failover all
stay on our side of the boundary.

`hermes proxy` is NOT usable for this — it only supports `nous` and `xai` upstreams, not DeepSeek.

## Install (run as root; the units run AS azlan)

```sh
# 1. Place the shim somewhere azlan can execute. It is OUR code, so it does not belong in
#    /opt/hermes-zen. Root-owned, world-readable — azlan only needs to run it.
sudo install -d -o root -g root -m 0755 /opt/hermes-gateway
sudo cp -r hermes-gateway/* /opt/hermes-gateway/
sudo install -d -o azlan -g azlan -m 0700 /opt/hermes-gateway/work   # agent scratch dir

# 2. The shim authenticates callers with the SAME token ai-gateway uses.
#    Copy GATEWAY_TOKEN out of infra/compose/.env, do NOT invent a new one.
sudo install -m 0640 -o root -g azlan /dev/null /etc/gaiada/hermes-gateway.env
sudo sh -c 'echo "GATEWAY_TOKEN=<value of GATEWAY_TOKEN from infra/compose/.env>" > /etc/gaiada/hermes-gateway.env'

# 3. Install and start.
sudo cp infra/hermes/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-gateway.service hermes-serve.service
sudo systemctl status hermes-gateway.service
```

`hermes-mcp.service` is intentionally **not** enabled by default — see its unit file.

## Verify

```sh
curl -s localhost:3009/health                                   # {"ok":true,...}
curl -s -X POST localhost:3009/complete -H 'Content-Type: application/json' \
     -d '{"prompt":"reply with the single word: ready"}'        # 401 without the token
curl -s -X POST localhost:3009/complete -H "Authorization: Bearer $GATEWAY_TOKEN" \
     -H 'Content-Type: application/json' -d '{"prompt":"reply with the single word: ready"}'
```

Then from our side, end to end through the gateway:

```sh
docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml exec ai-gateway \
  wget -qO- --header="Authorization: Bearer $GATEWAY_TOKEN" \
  --post-data='{"prompt":"ping"}' --header='Content-Type: application/json' \
  http://127.0.0.1:3002/complete
```

## Closing the loop the other way

Once our MCP Hub is up, azlan can point Hermes at it so Zedano can call ERP tools:

```sh
sudo -u azlan hermes mcp add gaiada --url http://127.0.0.1:3003/mcp
```

That makes the integration bidirectional: our stack asks Hermes to think, Hermes asks our stack to
act — each over a port it controls.

## Expect it to be slow

Every `/complete` shells out to `hermes -z <prompt>`: a full agent run with tools and memory, not a
raw completion. Seconds to tens of seconds is normal. Tune `HERMES_TIMEOUT_MS` rather than routing
around it — exercising the real agent is the point of the trial.

## Approvals stay ON

The shim does not pass `--yolo`. A headless Hermes run cannot auto-execute tools, which means some
prompts will come back refusing to act. That is the safe default; turning it off grants autonomous
tool execution to anything that can reach port 3009.
