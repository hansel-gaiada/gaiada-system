# Runbook: the helios Hermes agents behind the gateway (AIP-00a-2 and AIP-00a-3)

Status: PLANNED; the scripts are in `infra/runbooks/aip-00a/` (2026-10-27). Owner ruling AIP-D13 (2026-10-27). The design is in `docs/plans/2026-10-27-ai-plan.md` §6.1.

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

## The scripts

Each step is one script in `infra/runbooks/aip-00a/`. Every script backs up what it changes and prints only what is safe to read. Copy a script to its host and run it there, for example:

```bash
scp infra/runbooks/aip-00a/step1-tokens.sh helios:/root/ && ssh helios "bash /root/step1-tokens.sh"
```

**Facts the scripts are built on, measured on 2026-10-27:**
- **Agent homes.** Both agents are Hermes Agent v0.20.5, run as `systemd --user` services of `azlan` (`hermes-seo-gateway`, `hermes-bsc-gateway`; seo also runs `hermes-seo-dashboard`). Each agent's home (`HERMES_HOME`) is its profile directory: `/opt/hermes-seo/profiles/seo-main` and `/opt/hermes-bsc/profiles/bsc-main`. Its live `config.yaml`, `.env` and `auth.json` are there, not in `/opt/hermes-*` itself.
- **Model keys.**
  - seo keeps `DEEPSEEK_API_KEY` and `GEMINI_API_KEY` in its profile `.env`; the same keys sit in an unused copy at `/opt/hermes-seo/.env`.
  - bsc keeps its OpenRouter key as the one entry of `credential_pool.openrouter` in its profile `auth.json`.
- **seo's direct fallback.** seo has `fallback_providers: [{provider: deepseek, model: deepseek-v4-flash}]`. While a direct key exists, that would send calls around the gateway whenever the gateway refuses one, so step 4 removes it.
- **How the config is edited.** Hermes's own CLI (`hermes config set`) supports a named OpenAI-compatible provider with `key_env`. Every auxiliary task (vision, web extraction, compression, titles and the rest) can be pinned to the agent's main provider with `provider: main`. `auto` would try OpenRouter first while an OpenRouter credential exists.
- **Gateway compose.** The gateway's compose project on `gda-aicenter` is `gaiada`, in `/home/Hansel/gaiada/infra/compose`, with `docker-compose.vps.yml`, `docker-compose.hostdata.yml` and `docker-compose.observability.yml`. The `.env` there carries the current `GAIADA_TAG`, so recreating only `ai-gateway` does not roll it back.

## Step 1: tokens, on helios (`step1-tokens.sh`)

The script writes one fresh 256-bit `GAIADA_GATEWAY_TOKEN` into each agent's profile `.env` (mode 600, owner `azlan`, backup `.bak-aip00a`) and prints only `hermes-seo:<sha256>` and `hermes-bsc:<sha256>`. The plain tokens never leave helios.

- **Effect:** nothing reads the variable until step 4.
- **Rollback:** restore each `.env.bak-aip00a`.

## Step 2: gda-aicenter, the listener and the mesh proxy (`step2-gda.sh 'hermes-seo:<hash>,hermes-bsc:<hash>'`)

The script:
- backs up the compose `.env`;
- sets `GATEWAY_AGENT_LISTEN=0.0.0.0:3012` (inside the container; compose publishes it on `127.0.0.1:3012` only), `GATEWAY_AGENT_TOKENS` and `GATEWAY_AGENT_RESERVE_PCT=25`;
- recreates only `ai-gateway`;
- installs and starts `gaiada-agent-proxy.service` (`socat` on `10.88.0.1:3012`, admitting `10.88.0.2` only, ordered after `wg-quick@wg0`).

- **Verify:**
  - `ss` shows `127.0.0.1:3012` and `10.88.0.1:3012`, and no `0.0.0.0:3012`.
  - The loopback `/v1/models` without a token is `401`.
  - The boot log names both agents.
  - The ERP's own `/complete` still answers.
- **Rollback:** restore `.env.bak-aip00a`, recreate `ai-gateway`, then `sudo systemctl disable --now gaiada-agent-proxy`.

## Step 3: sumopod, the relay (`step3-sumopod.sh`)

The script installs `socat`, starts `gaiada-agent-relay.service` (`10.88.0.2:3012`, admitting `10.88.0.3` only, forwarding to `10.88.0.1:3012`) and adds one `ufw` rule for `wg0` from `10.88.0.3` to port 3012.

- **Verify:**
  - From `sumopod`, `/v1/models` on `10.88.0.1:3012` without a token is `401`.
  - From `helios`, it is `401` without a token and `200` with an agent's token. Step 4 checks this itself.
- **Rollback:** `sudo systemctl disable --now gaiada-agent-relay`, then `sudo ufw delete allow in on wg0 from 10.88.0.3 to 10.88.0.2 port 3012 proto tcp`.

## Step 4: helios, repoint one agent (`step4-helios.sh seo`, then `bsc`)

The script first proves the agent's token reaches the gateway (`401` without it, `200` with it); it stops without changing anything otherwise. Then it:
1. backs up `config.yaml` and `auth.json`;
2. adds the provider `gaiada-gateway` (`base_url http://10.88.0.2:3012/v1`, `api_mode chat_completions`, `key_env GAIADA_GATEWAY_TOKEN`);
3. points `model` at it (`default z-ai/glm-5.3-flash`, the model the gateway actually serves, and `context_length 131072`);
4. removes `fallback_providers`;
5. sets every auxiliary task to `provider: main`;
6. sends one CLI prompt through the same config, then restarts the agent's service.

- **Verify, before step 5:** the prompt answers, and the gateway's audit file (`/app/data/egress-audit.jsonl` in `gaiada-ai-gateway-1`) has a `"capability":"chat"` row with that agent's name.
- **Known effect:** vision is refused by the gateway (it takes no image parts), so the agent's image analysis stops working.
- **Rollback:** restore `config.yaml.bak-aip00a` (and `auth.json.bak-aip00a`) and restart the unit.

## Step 5: helios, delete the agent's own model keys (`step5-helios.sh seo`, then `bsc`)

Run this only after step 4's verify passed for that agent.

- **seo:** removes the model-provider key lines from both `.env` files.
- **bsc:** empties `credential_pool.openrouter` in `auth.json`.
- **Both:** the script repeats the prompt and restarts. Tool credentials (`SEMRUSH_API_KEY`, `FIGMA_API_KEY`, `GSC_OAUTH_CLIENT_SECRET`) stay.
- **Rollback:** restore `<file>.bak-aip00a-step5` and restart.

## Step 6: close

- Tick AIP-00a-2 and AIP-00a-3 on the board with the dates and the audit evidence.
- Record the outcome in `legal/client-portal-addendum.md` open item 7 (Hermes outside the gateway): closed for both agents.
- Watch the per-agent cap for a week (AIP-00a-4).
- If an agent's quality drops on GLM 5.3 Flash, raise it under AIP-06 (the tier table), not by giving the agent a key back.
