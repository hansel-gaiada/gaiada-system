# Runbook: the helios Hermes agents behind the gateway (AIP-00a-2 and AIP-00a-3)

Status: PLANNED. Owner ruling AIP-D13 (2026-10-27). The design is in `docs/plans/2026-10-27-ai-plan.md` §6.1.

**Who runs it.**
- The orchestrator session writes and checks every command. The owner runs every step that changes a live host:
  `gda-aicenter` (the ERP), `sumopod` (the mesh hub) and `helios` (a production delivery host whose two agents belong to
  `azlan`).
- Each step has a verify and a rollback. Do not start a step until the previous one has verified.

**Before step 1:** AIP-00a-1, the gateway's agent listener, must be released and deployed. Then
`docker exec gaiada-ai-gateway-1 printenv GATEWAY_AGENT_LISTEN` must print nothing, which is the default: the listener is off.

## The path

```
helios (10.88.0.3)                 sumopod (10.88.0.2, hub)                   gda-aicenter (10.88.0.1)
hermes-seo, hermes-bsc  --wg0-->   relay 10.88.0.2:3012       --wg0-->        proxy 10.88.0.1:3012 --> 127.0.0.1:3012
                                   (accepts 10.88.0.3 only)                   (accepts 10.88.0.2 only)    = ai-gateway's
                                                                                                           agent listener
```

**Why this shape:**
- **The WireGuard mesh is hub-and-spoke.** On 2026-10-27, `helios`'s only peer was `sumopod` (allowed IPs `10.88.0.2/32`), and so was `gda-aicenter`'s. This path keeps the spokes isolated: no WireGuard allowed-IPs change, and no FORWARD rule on `sumopod`, whose FORWARD policy is DROP (Docker).
- **Neither relay binds a container port to a mesh address.** Each is a host `socat` unit started after `wg-quick@wg0`, so a late `wg0` after a reboot can only stop the relay, never the gateway.
- **Each hop admits exactly one source address** (`socat range=`), and the gateway still demands a per-agent token.

**What really keeps a stranger out: the per-agent token.** The address checks narrow who can connect, but they are not the control:
- Any process or container on `sumopod` can connect to `10.88.0.1:3012`, because `sumopod`'s own address is `10.88.0.2`.
- Any service on `gda-aicenter`'s compose network can reach `ai-gateway:3012`.
- Any local process on `gda-aicenter` can reach `127.0.0.1:3012`.

So keep the tokens 256-bit random, keep them only in each agent's own `.env` (mode 600, `azlan`), and rotate one when a host is suspected.
- **Rotating** means a new hash in `GATEWAY_AGENT_TOKENS` and a recreated `ai-gateway`; the gateway reads the set at boot.
- **Docker:** `gda-aicenter` runs Docker 29.7, and Docker 28 and later stop other machines on its local network from reaching a port published on `127.0.0.1`. Measured 2026-10-27, port 3012 was free.

**What the endpoint caps.** Per agent: calls per day, in-flight calls, and output tokens per call. Agents also may never use the last 25 percent of the global daily cap. An upstream 429 caused by an agent is relayed to that agent and does not open the shared breaker for the ERP.

## Step 1: tokens (on helios; the plain tokens never leave it)

Run as root on `helios`. It writes one token per agent into that agent's `.env` and prints only `name:sha256` lines:

```bash
set -e
for a in seo bsc; do
  case $a in seo) envf=/opt/hermes-seo/.env ;; bsc) envf=/opt/hermes-bsc/profiles/bsc-main/.env ;; esac
  cp -a "$envf" "$envf.bak-aip00a" 2>/dev/null || install -o azlan -g azlan -m 600 /dev/null "$envf"
  t=$(openssl rand -hex 32)
  grep -q '^GAIADA_GATEWAY_TOKEN=' "$envf" && sed -i '/^GAIADA_GATEWAY_TOKEN=/d' "$envf"
  printf 'GAIADA_GATEWAY_TOKEN=%s\n' "$t" >> "$envf"; chown azlan:azlan "$envf"; chmod 600 "$envf"
  printf 'hermes-%s:%s\n' "$a" "$(printf %s "$t" | sha256sum | cut -d' ' -f1)"
done
```

- **Verify:** two lines, `hermes-seo:<64 hex>` and `hermes-bsc:<64 hex>`. A hash of a 256-bit random token is safe to copy.
- **Before running:** check where `hermes-bsc` reads its `.env`. If it uses the profile directory, keep the path above; otherwise use `/opt/hermes-bsc/.env`.
- **Rollback:** restore each `.env.bak-aip00a`.

## Step 2: gda-aicenter, the gateway listener and the mesh proxy

1. In `infra/compose/.env` on the box, set:
   - `GATEWAY_AGENT_LISTEN=0.0.0.0:3012`. This is inside the container; compose publishes it on `127.0.0.1:3012` only.
   - `GATEWAY_AGENT_TOKENS=hermes-seo:<hash>,hermes-bsc:<hash>`, from step 1.
   - `GATEWAY_AGENT_RESERVE_PCT=25`.

   Recreate only `ai-gateway` with the full compose file set the server uses (`infra/CLAUDE.md`; `docker-compose.vps.yml` alone is not valid). Export `GAIADA_TAG` and `APP_VERSION` first, so a stale env does not roll it back.
2. Install the proxy unit:

```ini
# /etc/systemd/system/gaiada-agent-proxy.service
[Unit]
Description=AIP-00a: mesh entry (10.88.0.1:3012, from the sumopod relay only) to the gateway's agent listener
After=wg-quick@wg0.service docker.service
Requires=wg-quick@wg0.service
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:3012,bind=10.88.0.1,fork,reuseaddr,range=10.88.0.2/32 TCP:127.0.0.1:3012
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
```

Then run `systemctl daemon-reload && systemctl enable --now gaiada-agent-proxy`.

- **Verify:**
  - `ss -ltnp | grep 3012` shows `127.0.0.1:3012` (docker) and `10.88.0.1:3012` (socat), and no `0.0.0.0:3012`.
  - From `sumopod`: `curl -s -o /dev/null -w '%{http_code}\n' http://10.88.0.1:3012/v1/models` gives `401`.
  - The ERP's own `/complete` still answers.
- **Rollback:** `systemctl disable --now gaiada-agent-proxy`, then clear the three variables and recreate `ai-gateway`.

## Step 3: sumopod, the relay

1. Run `apt-get install -y socat`, then add the relay unit:

```ini
# /etc/systemd/system/gaiada-agent-relay.service
[Unit]
Description=AIP-00a: relay helios (10.88.0.3) to the gateway's mesh entry on gda-aicenter
After=wg-quick@wg0.service
Requires=wg-quick@wg0.service
[Service]
ExecStart=/usr/bin/socat TCP-LISTEN:3012,bind=10.88.0.2,fork,reuseaddr,range=10.88.0.3/32 TCP:10.88.0.1:3012
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
[Install]
WantedBy=multi-user.target
```

2. Run `systemctl daemon-reload && systemctl enable --now gaiada-agent-relay` and
   `ufw allow in on wg0 from 10.88.0.3 to 10.88.0.2 port 3012 proto tcp comment 'AIP-00a relay'`.

- **Verify, from `helios`:**
  - `curl -s -o /dev/null -w '%{http_code}\n' http://10.88.0.2:3012/v1/models` gives `401`.
  - With `-H "Authorization: Bearer $GAIADA_GATEWAY_TOKEN"` (sourced from the seo `.env`) it gives `200`.
- **Verify, from anywhere else** (the laptop, or `sumopod`'s public address): port 3012 is not reachable.
- **Rollback:** `systemctl disable --now gaiada-agent-relay`, then `ufw delete allow in on wg0 from 10.88.0.3 to 10.88.0.2 port 3012 proto tcp`.

## Step 4: helios, repoint one agent at a time (seo first)

1. Back up `config.yaml` (both `/opt/hermes-seo/config.yaml` and `profiles/seo-main/config.yaml`), `.env` and `auth.json`, with the suffix `.bak-aip00a`.
2. In the agent's live `config.yaml`, add a provider and point the model and the auxiliary tasks at it:

```yaml
providers:
  gaiada-gateway:
    base_url: "http://10.88.0.2:3012/v1"
    api_mode: chat_completions
    key_env: "GAIADA_GATEWAY_TOKEN"
model:
  provider: gaiada-gateway
  default: gaiada-auto        # the gateway ignores it for routing (AIP-D1) and answers with the model that served
  context_length: 131072      # do not rely on /v1/models for detection
```

   - Every `auxiliary.*.provider` must be `gaiada-gateway` (or `main`, if this version supports it).
   - Any vision or image task the gateway refuses (images are refused, because DLP cannot read them) is turned off.
   - The gateway drops request fields outside its allow-list and logs only their names: `response_format`, `parallel_tool_calls` and OpenRouter routing fields. An agent setting that depends on one of them will not take effect.
   - Every call's output is capped by `GATEWAY_AGENT_MAX_TOKENS`.
3. Run `sudo -u azlan XDG_RUNTIME_DIR=/run/user/1001 systemctl --user restart hermes-seo-gateway`.

- **Verify, both halves, before going on:**
  - The agent answers a short prompt in its own channel.
  - On `gda-aicenter`, the gateway's egress audit shows a `chat` row naming `hermes-seo`.
  - Its journal (`journalctl --user -u hermes-seo-gateway`, run as `azlan`) shows no provider-key errors.
- **Rollback:** restore the three `.bak-aip00a` files and restart the unit.

**Only after the verify passes:**
- delete `DEEPSEEK_API_KEY` and `GEMINI_API_KEY` from the seo `.env`, restart once more, and verify again;
- leave `SEMRUSH_API_KEY`, `FIGMA_API_KEY` and `GSC_OAUTH_CLIENT_SECRET` alone: they are tool credentials, not model keys.

**Then `hermes-bsc`:** repeat the same steps. Its OpenRouter credential lives in `profiles/bsc-main/auth.json`; remove only that provider's entry, keeping any channel credentials.

## Step 5: close

- Tick AIP-00a-2 and AIP-00a-3 on the board with the dates and the audit evidence.
- Record the outcome in `legal/client-portal-addendum.md` open item 7 (Hermes outside the gateway): closed for both agents.
- Watch the per-agent cap for a week (AIP-00a-4).
- If an agent's quality drops on GLM 5.3 Flash, raise it under AIP-06 (the tier table), not by giving the agent a key back.
