# Runbook — Deploy the Trial Stack to the Personal VPS

One box, one compose file. Services: Postgres, Redis, WAHA, ai-gateway (Go), Keycloak, Cerbos,
platform-nest (API) + platform-ui, whisper, knowledge, mcp-hub, the bot + media-worker, and the
idle `sync-central` (waits on a real second site). Only WAHA's dashboard, Keycloak's admin
console (both localhost-bound), and the UI (`:3005`) are reachable; everything else is
box-internal.

> **The VPS no longer builds anything.** Every first-party service is pinned to a signed
> GHCR image (`GAIADA_TAG`), and routine deploys are one command — `git push --tags` — run
> by `.github/workflows/deploy.yml`. See `../../docs/blueprints/deployment-strategy.md`.
> What follows is the **one-time bootstrap** and the **manual/break-glass** path.

## Prerequisites

- Ubuntu/Debian VPS with Docker + the compose plugin (`curl -fsSL https://get.docker.com | sh`).
- The `gaiada-system` folder on the box — but only `infra/` is needed now; CI rsyncs compose
  files and scripts on every deploy. No application source, no Go/Node toolchain.
- Nothing needs to be publicly reachable. Telegram uses outbound long-polling; WAHA's
  dashboard binds to localhost (reach it with `ssh -L 3000:localhost:3000 user@vps`).
- `docker login ghcr.io` works on the box (CI re-authenticates per deploy with a
  short-lived job token; images are private because the repo is private).

## First deploy

```bash
cd gaiada-system/infra/compose
cp .env.example .env            # fill in: openssl rand -hex 16 for every token/password
                                # (UI_SESSION_SECRET is REQUIRED — compose aborts if it's blank)
cp groups.example.yaml groups.yaml   # edit once you know the real group ids

export GAIADA_TAG=v0.6.0        # the release you want; must exist in GHCR
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
docker compose -f docker-compose.vps.yml ps    # everything Up + healthy?
docker compose -f docker-compose.vps.yml logs -f bot   # watch it come up
```

To build from your working tree instead (local dev, or a box with no registry access),
layer the build override — this is the ONLY supported way to compile from source:

```bash
docker compose -f docker-compose.vps.yml -f docker-compose.local.yml \
               -f docker-compose.build.yml up -d --build
```

Keycloak imports the `gaiada` realm from `keycloak/gaiada-realm.json` on first boot, but the
platform stays in `AUTH_MODE=dev` until you set client secrets + MFA and flip
`PLATFORM_AUTH_MODE=oidc` (see `../../docs/runbooks/idp-keycloak.md`).

Then per surface:

- **Telegram (works immediately):** set `TELEGRAM_BOT_TOKEN` in `.env`, `up -d` again.
  DM the bot; group ids appear in the logs → add to `groups.yaml` (hot-reloads, no restart).
- **WhatsApp:** tunnel to the WAHA dashboard, start the `default` session, scan the QR with
  the spare number (once — the session persists in a volume).

## Update to a new version

**Normal path — one point, from your laptop:**

```bash
git tag v0.6.1 && git push --tags
```

That builds + signs every image, then `deploy.yml` backs up the databases, pulls, migrates,
starts, and health-checks the box. Watch it in the Actions tab. Nothing to do on the VPS.

**Rollback:** re-run the `deploy` workflow with the previous tag (Actions → deploy → Run
workflow). Images are already on the box, so this is a container restart, not a rebuild.
Schema is *not* reverted — migrations are forward-only; the pre-deploy backup is the
escape hatch.

**Break-glass (CI unavailable), on the box:**

```bash
cd gaiada-system/infra/compose
export GAIADA_TAG=v0.6.1
../scripts/backup.sh
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml run --rm --no-deps platform node dist/db/migrate.js
docker compose -f docker-compose.vps.yml up -d --no-build
```

## Changing a variable in `.env` on a running box

```bash
./infra/scripts/wire-env.sh platform          # recreates + echoes the vars back
VERIFY='RENDERER_TOKEN|REPORT_RENDERER_URL' ./infra/scripts/wire-env.sh platform
```

`docker compose restart` does **not** pick up an edited `.env` — compose bakes the environment
at container *create* time, so a restart re-runs the old environment while looking like it
worked. Only a recreate (`up -d --no-deps <svc>`) re-reads the file. The script also carries the
non-obvious invocation the VPS needs (`-f docker-compose.hostdata.yml --profile bot --profile
auth`); without those, postgres/redis are profile-disabled and compose rejects the project.

## Backups (nightly)

```bash
chmod +x ../scripts/backup.sh
crontab -e   # add:
# 0 3 * * * /home/<user>/gaiada-system/infra/scripts/backup.sh >> /var/log/gaiada-backup.log 2>&1
```

Backs up all three application DBs (`gaiada`, `gaiada_platform`, `gaiada_knowledge`) — one
`*.sql.gz` each. **Never back up any data volume** — the bot's holds `keys.json` (LocalKms);
key material in the backup set voids crypto-shred (see `../../docs/runbooks/erasure-divestiture.md`).
Copy the newest `~/gaiada-backups/*.sql.gz` off-box weekly (e.g. `scp` to your laptop).

## Uptime alerting (optional)

`scripts/healthcheck.sh` pings each service's `/health` and, on any failure, sends a Telegram
message (set `TELEGRAM_BOT_TOKEN` + `ALERT_CHAT_ID`). Add to cron alongside the backup:

```bash
# */5 * * * * TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... /home/<user>/gaiada-system/infra/scripts/healthcheck.sh >> /var/log/gaiada-health.log 2>&1
```

## Health checks (manual)

```bash
C=docker compose -f docker-compose.vps.yml exec -T bot wget -qO-
$C http://bot:3001/health
$C http://ai-gateway:3002/health
$C http://mcp-hub:3003/health
$C http://platform:3004/health
$C http://knowledge:3005/health
$C http://platform-ui:3005/         # UI is also published on the host at :3005
$C http://report-renderer:3007/health   # TR-19 sidecar; internal-network only, no published port
```

Auth-gate smoke check (TR-19 acceptance criterion — a token-less request must 401; run from a
container on the same compose network, since `report-renderer` has no published port):

```bash
docker compose -f docker-compose.vps.yml exec -T platform \
  wget -qO- --header="Content-Type: application/json" \
  --post-data='{"url":"http://platform-ui:3005/"}' http://report-renderer:3007/render
# expect: HTTP 401 (busybox wget prints the body on error with -qO- but exits non-zero;
# check the response body / use curl -i from a debug shell if you need the status line)
```

## Known caveats — builds unverified in this dev environment

No Docker is available in the day-to-day dev environment these components were authored in.
**Validate the following on a real Docker host before any deploy that includes them** — do not
assume a passing local `npm test`/`go test` means the container builds or runs:

- `ai-gateway-go` — `docker build` and `docker compose config` never run against Docker locally.
- `render-gateway-go` — planned; same caveat will apply once it's built.
- ~~**`report-renderer` (TR-19)**~~ — **CLEARED 2026-08-03 on the production VPS itself**
  (`gda-aicenter`, Docker 29.7.0, linux/amd64). `docker build` of the pinned
  `mcr.microsoft.com/playwright:v1.61.1-noble` image succeeded, and a container on the live
  `gaiada_default` network returned: `/health` → `{"status":"ok"}`; an authorised render of
  `http://platform-ui:3005/` → **200 `application/pdf`, 16 624 bytes starting `%PDF-`** (a real
  `chromium.launch()` → `page.pdf()`, not a stub); a foreign origin → **403** (SSRF guard); no
  token → **401**. Nothing about this image remains unverified on the target host. The earlier
  Docker-Desktop-only verification is in `docs/modules/CHANGELOG.md`'s report-renderer entry.

## Cerbos: adding a NEW policy file (ASST-02 lesson, 2026-08-05)

Confirmed again while building `resource_assistant_thread.yaml` / `resource_assistant_memory.yaml`
(ASST-02): a **newly-added** Cerbos policy file is not picked up by `watchForChanges: true` over a
bind mount the way an *edit to an existing file* is — and an unlisted resource `kind` is a **SILENT
DENY** (every check against it returns deny, with no error anywhere), which reads exactly like an
authorization-logic bug in the new code, not a stale-policy problem.

- **Prod is already covered.** `deploy.yml`'s "Reload Cerbos policies" step (added for CP-18, the
  client-portal `resource_contract.yaml` rollout, and re-verified live 2026-08-04 — see
  `../../docs/plans/2026-08-04-client-portal-deployment.md`) runs `docker compose restart cerbos`
  unconditionally on every deploy, after `up -d` and before the health gate. It does not
  distinguish "new file" from "edited file" — it restarts every time — so a deploy that ships
  `resource_assistant_thread.yaml`/`resource_assistant_memory.yaml` (or any future new
  `resource_*.yaml`) needs **no extra step**. Do not assume prod is broken just because a fresh
  policy file was added; the existing step already handles it.
- **Local/dev is NOT covered automatically.** After adding a new policy file to
  `platform-nest/cerbos/policies/` on a dev box, restart the Cerbos container that the thing you're
  testing actually talks to, and confirm `healthy` before trusting any result:
  ```bash
  docker restart gaiada-test-cerbos   # the container the platform-nest TEST SUITE reaches (:3592)
  # NOT gaiada-cerbos-1 — that's the app's own dev Cerbos; restarting it changes nothing the tests see.
  docker inspect --format '{{.State.Health.Status}}' gaiada-test-cerbos   # wait for "healthy"
  ```
- **Before trusting a DENY, prove the kind resolves at all.** A matrix where every principal is
  denied on every action looks exactly like a passing "owner-only" test and is the signature of an
  unlisted kind. Smoke-check with `includeMeta: true` and read `matchedPolicy` off the response —
  `docker cp`/`docker exec` cannot help here (Cerbos is distroless, and `docker cp` reads the HOST
  bind-mount path anyway, never what the running process has loaded):
  ```bash
  curl -s -X POST http://localhost:3592/api/check/resources -H "Content-Type: application/json" -d '{
    "requestId":"smoke","includeMeta":true,
    "principal":{"id":"u1","roles":["user"],"attr":{"assurance":"high","companies":["t1"],"grants":[]}},
    "resources":[{"actions":["read"],"resource":{"kind":"assistant_thread","id":"x",
      "attr":{"id":"x","tenantId":"t1","ownerId":"u1","projectId":"","teamId":"","module":"","subjectUserId":""}}}]
  }'
  # expect "matchedPolicy":"resource.assistant_thread.vdefault" — its absence means the kind never loaded.
  ```

## nginx SSE: assistant stream (ASST-09, 2026-08-05)

The assistant's reply stream is Server-Sent Events, and nginx buffers proxied responses by
default — a client behind it receives nothing until the response completes, so a streaming
assistant renders as a frozen page. The client portal's own SSE stream
(`core/portal-stream.controller.ts`) hit exactly this and needed a hand-applied
`proxy_buffering off` vhost block before it worked in production (see
`../../docs/plans/2026-08-04-client-portal-deployment.md`). The assistant needs the identical
treatment.

**Only one hop crosses the public vhost.** Two SSE-shaped paths exist, but only one is reachable
through nginx:

1. `GET /api/assistant/threads/:id/stream` — **platform-ui's own proxy** (browser-facing; this is
   the one the browser fetches, because a bearer token can never reach client JS —
   `platform-ui/src/app/api/assistant/threads/[id]/stream/route.ts`). This is the path nginx must
   treat specially.
2. `GET /api/:tenantId/assistant/threads/:id/stream` — **platform-nest's** route
   (`assistant.controller.ts`). Route (1)'s handler calls this one itself, server-side, over
   `PLATFORM_URL` (in-cluster `http://platform:3004`), **never through the public vhost.** Node's
   own `fetch`/`ReadableStream` plumbing has no buffering proxy in front of it there, so this
   second hop needs no nginx change at all — don't add a block for it, there is nothing for it to
   attach to.

**The block (already in the repo, `infra/nginx/erp.gaiada.online.conf`, inserted right before
`location /`):**

```nginx
location ~ ^/api/assistant/threads/[^/]+/stream$ {
    proxy_pass http://127.0.0.1:3005;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;
    proxy_set_header Connection        "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    gzip off;
}
```

Same shape as CP-5's `location = /api/portal/stream` block just above it in that file, on
purpose — `docs/FRONTEND-BFF-CONTRACT.md`'s SSE-BEHIND-A-PROXY note says to reuse it rather than
invent a variant. One deliberate difference: it is a **regex** location (`~`), not an exact-path
one, because the assistant route carries a thread id in the URL — an exact match can't express
that.

1. **Apply on the box** (this repo change does not deploy itself — nginx config is never synced
   by CI, same as the portal block before it):
   ```bash
   ssh gda-aicenter
   sudo cp /etc/nginx/conf.d/erp.gaiada.online.conf \
           /etc/nginx/conf.d/erp.gaiada.online.conf.bak-$(date -u +%Y%m%dT%H%M%SZ)
   sudo $EDITOR /etc/nginx/conf.d/erp.gaiada.online.conf   # paste the block above, before `location /`
   sudo nginx -t && sudo systemctl reload nginx
   ```
2. **Verify streaming is genuinely incremental, not one buffered flush** — open a real thread in
   the UI first so a `messageId` exists, or drive the route directly with a valid session/bearer
   and `messageId`:
   ```bash
   curl -N -s --max-time 15 \
     -H "authorization: Bearer $SESSION_OR_SERVICE_TOKEN" \
     "https://erp.gaiada.online/api/assistant/threads/$THREAD_ID/stream?messageId=$MESSAGE_ID"
   ```
   Expect `data:` frames to print one at a time, paced by the model's own token cadence — the
   first should arrive within a second or two, not after the full 15s timeout. If the terminal
   sits silent and then dumps every token at once right before `curl` exits, nginx is still
   buffering: re-check the block landed before `location /` (location order matters — nginx
   evaluates this regex location after all plain-prefix locations, so a `location /` defined
   *before* it would still lose to it, but a stray copy-paste error putting the new block
   *outside* the `server {}` block would not) and that the reload actually picked it up (`nginx
   -T | grep -A3 'assistant/threads'`).
3. **Cerbos.** This release also ships two NEW policy files,
   `resource_assistant_thread.yaml` and `resource_assistant_memory.yaml` (ASST-02). See "Cerbos:
   adding a NEW policy file" above — **prod needs no extra step** (the existing `deploy.yml`
   "Reload Cerbos policies" step restarts Cerbos unconditionally on every deploy, which is
   sufficient for a brand-new file). This is called out here only so nobody mistakes a Cerbos
   403 on the assistant surface for an nginx problem while debugging this ticket, or vice versa —
   they are independent failure modes that happen to ship in the same release. For **local dev**,
   the new policy files need the local-only step in that section
   (`docker restart gaiada-test-cerbos`, not `gaiada-cerbos-1`) before the assistant's Cerbos
   checks will resolve at all.

**Rollback:** restore the timestamped `.bak` copy, `nginx -t && systemctl reload nginx`. The SSE
block is additive-only (a new `location` block) and touches nothing else in the vhost, so
rollback cannot regress `/n8n/`, `/idp/`, the portal stream, or the UI root — verify with a plain
`curl -I https://erp.gaiada.online/` (expect 200) after any nginx change here regardless of
direction.

## Postiz / SMM publishing engine (SMM-04 / SMM-04b) — NOT DEPLOYED, runs on a DIFFERENT HOST

> ### ⚠ Read this box before anything else in this section.
> **This section is not about `gda-aicenter`.** Everything else in this runbook is. The SMM
> publishing engine runs on the **SumoPod VPS, `150.109.15.108`** (Ubuntu 24.04.4, user
> `ubuntu`) — owner decision 2026-08-13, addendum §A4k, retargeted by §A4l. It was never
> started on `gda-aicenter` and it never will be: the footprint tripwire fired there
> (~3.4 GiB needed against ~4.0 GB available on a box already 2.45 GB into swap).
>
> **That VPS runs 19 containers of the owner's private production projects** (project-hug among
> them), in compose projects that are none of ours. The hard rules are two paragraphs down and
> they are not advisory.
>
> **Status: PROTOTYPED. Nothing has been deployed to that host.** The stack was built, started
> and driven on local Docker only. Full evidence:
> `../../docs/superpowers/plans/2026-08-13-smm-04-containment-spike.md`.

The engine is Postiz (AGPL-3.0, run contained). Its compose file is
`infra/compose/docker-compose.social.yml` — a separate compose project (`gaiada-social`) behind
profile `social`, digest-pinned, five services trimmed from upstream's nine.

### Host safety — the rules for operating on someone else's production box

The blast radius of a careless Docker command on `150.109.15.108` is the owner's live private
projects, not our department. Three rules, in descending order of how badly they end:

1. **NEVER run a Docker command there that is not scoped to this project.** Every command in
   this section carries `-p gaiada-social` or `-f docker-compose.social.yml`. Specifically
   banned, with no exception:
   - `docker system prune` (any flags) — reaps other projects' networks, build cache and, with
     `-a`, images that other people's stopped containers need to restart from.
   - `docker image prune -a` — **note that this used to be step 0 of this very procedure.** It
     was correct when the target was `gda-aicenter` with 13 GB free and our own images on it.
     On this host it would delete images belonging to production that is not ours. **It has
     been removed from the bootstrap below. Do not put it back.**
   - `docker volume prune`, `docker network prune` — same reasoning, worse outcome.
   - any `--remove-orphans` without `-p gaiada-social`.
2. **NEVER publish a port on `0.0.0.0` there.** Docker writes its own DNAT/FORWARD rules, and
   they are evaluated **before** ufw's. A `0.0.0.0` bind is internet-reachable on a box whose
   firewall says "deny incoming", and `ufw status` will report everything is fine. This is
   controlled by `SOCIAL_BIND_ADDR` in that host's `.env`; its default is `127.0.0.1` so a
   missing value fails safe. The deploy value is the WireGuard address, `10.88.0.2`.
3. **Take a `docker ps -a` before and after every session there, and diff it.** Take that count
   **FRESH every time; do not compare against a number written here.** When this rule was authored
   the box ran 19 containers. Measured 2026-08-18: **37 total, 36 running.** Following the old
   number literally would either raise a false incident over 18 containers that legitimately belong
   to production, or teach the operator to ignore the check -- and the second is how a good rule
   quietly stops working. The invariant is *baseline + exactly our containers*, never a specific
   integer. Anything else is an incident, and finding out at the next `docker ps` beats finding out
   from the owner.
   Also measured that day, for the item below: build cache back to **57.16 GB, 54.71 GB
   reclaimable, zero active** -- the creep is real, and it is the disk's main consumer here.

**One maintenance item that IS safe and IS wanted** (from §A4k): `docker builder prune -af`.
Build cache had accumulated 2467 entries and 147 GB, zero of it active, and filled the disk to
85%; removing build cache cannot stop a container or delete an image. That belongs in this box's
periodic maintenance — the condition will creep back.

### The cross-host hop — WireGuard, and why not the alternatives

`platform-nest` runs on `gda-aicenter` (`35.240.135.48`, GCP, Debian 12). Postiz runs on the
VPS. The REST hop therefore leaves the machine, and design §03's "private network" premise no
longer holds on its own terms. **The transport is a two-peer WireGuard point-to-point link.**

| | | |
|---|---|---|
| `gda-aicenter` | `10.88.0.1` | initiator, `PersistentKeepalive` |
| VPS | `10.88.0.2` | listener, UDP/51820, allowed **only** from `35.240.135.48` |

**Why this and not nginx + Let's Encrypt on the VPS.** The TLS option means putting a new
public `:443` (and `:80`, for ACME http-01) on a box that runs the owner's unrelated private
production — a new attack surface we introduced onto their machine — plus a DNS record, plus a
certificate that must renew forever, plus a source-address ACL. That ACL is the weak part: it
authenticates a *network position*, not a party. It holds exactly as long as nothing about
routing, NAT or the ERP's public address changes, and it is one typo away from publishing
`/api/public/v1/*` to the internet. WireGuard authenticates the **peer by key**, gives
ChaCha20-Poly1305 confidentiality and integrity a layer below HTTP, and leaves the VPS with
**no public listener at all** — an unauthenticated probe of UDP/51820 gets silence, not a
handshake. It satisfies the intent of "TLS on the hop" with a stronger authentication property
than TLS-plus-IP-allowlist would have given.

**Why not an SSH tunnel.** It is the fastest to stand up and it is the one to reject hardest.
It requires a shell-capable credential **on the production VPS**, held by the ERP box — a far
larger blast radius than a peer key that can reach one TCP port. `autossh`'s characteristic
failure is a half-open tunnel that accepts connections and never delivers, which is precisely
the "green health over a dead service" shape this estate has already been burned by twice
(Cerbos, and Postiz's own search-attribute trap below). Keep it named only as a 30-minute
emergency bridge if WireGuard cannot be installed for some reason, and take it down after.

**Cost to operate, honestly.** Setup is two `wg0.conf` files, one package, one systemd unit per
host. After that: no DNS, no certificates, no renewal, no cron. The standing cost is key
custody — WireGuard keys are long-lived and there is no expiry to force a rotation, so
**rotation is a manual ops item on host rebuild or staff change**, and that is the one thing
this design does worse than certificates. Health is a one-line probe (`wg show wg0
latest-handshakes`); a handshake older than ~3 minutes on a link with keepalive means the
tunnel is down.

#### Facts measured 2026-08-13 (read-only, from `gda-aicenter`)

```
$ ping -c 8 -q 150.109.15.108
8 packets transmitted, 8 received, 0% packet loss
rtt min/avg/max/mdev = 2.473/2.604/2.956/0.167 ms      ← 2.6 ms, not "internet RTT"

$ for i in 1 2 3 4 5; do curl -o /dev/null -w '%{time_connect}\n' telnet://150.109.15.108:22; done
0.001993 0.002732 0.002621 0.003015 0.002246           ← TCP handshake 2.0-3.0 ms, corroborates

$ traceroute -n 150.109.15.108
 1  72.14.232.209   1.674 ms                           ← still inside Google's network
 3  30.245.21.41    1.351 ms                           ← ~3 hops apart; effectively same metro

$ uname -r                                              6.1.0-51-cloud-amd64  (Debian 12)
$ ls /lib/modules/$(uname -r)/kernel/drivers/net/wireguard/
wireguard.ko                                            ← module present
$ command -v wg wg-quick                                ← ABSENT: apt install wireguard-tools
$ ip -o link show ens4
... mtu 1460 ...                                        ← GCP. See the MTU trap below.
$ ping -c 2 -M do -s 1432 150.109.15.108                0% loss  ← path MTU ≥ 1460 end to end
```

> **⚠ MTU TRAP — set it explicitly or large uploads black-hole silently.** `wg-quick`'s default
> tunnel MTU is 1420, derived from a 1500-byte underlay. **`gda-aicenter`'s `ens4` is MTU 1460**
> (GCP's default), so 1420 is 40 bytes too big. Small requests work perfectly and the link looks
> healthy; what breaks is exactly the traffic that fills packets — **media uploads**, the one
> thing on this hop that sends megabytes. Set `MTU = 1380` (1460 − 80) on **both** ends, and
> verify with a DF-bit ping across the tunnel before believing it.

#### Setup — both hosts. Nothing here is deployed yet; this is the reviewed procedure.

```bash
# ── On BOTH hosts ──────────────────────────────────────────────────────────────────────────
sudo apt-get update && sudo apt-get install -y wireguard-tools
umask 077 && wg genkey | sudo tee /etc/wireguard/privatekey | wg pubkey | sudo tee /etc/wireguard/publickey
# Exchange the two PUBLIC keys only. The private keys never leave their host, never enter a
# commit, a chat message, a log or this repo.

# ── VPS 150.109.15.108 — /etc/wireguard/wg0.conf (mode 0600) ───────────────────────────────
# [Interface]
# Address    = 10.88.0.2/24
# ListenPort = 51820
# MTU        = 1380
# PrivateKey = <VPS private key>
# [Peer]
# PublicKey  = <gda-aicenter public key>
# AllowedIPs = 10.88.0.1/32          # /32 — this peer may source exactly one address
sudo ufw allow from 35.240.135.48 to any port 51820 proto udp   # the ONLY inbound rule added
sudo systemctl enable --now wg-quick@wg0

# ── gda-aicenter — /etc/wireguard/wg0.conf (mode 0600) ─────────────────────────────────────
# [Interface]
# Address    = 10.88.0.1/24
# MTU        = 1380
# PrivateKey = <gda-aicenter private key>
# [Peer]
# PublicKey  = <VPS public key>
# Endpoint   = 150.109.15.108:51820
# AllowedIPs = 10.88.0.2/32
# PersistentKeepalive = 25           # keeps the path open; also means the VPS never initiates
sudo systemctl enable --now wg-quick@wg0
```

**No GCP VPC firewall change is needed.** `gda-aicenter` only ever initiates (that is what
`PersistentKeepalive` buys), so nothing new has to be allowed inbound to the ERP box. One
inbound rule exists in the whole design, on the VPS, scoped to one source address.

**Verify the tunnel before touching Postiz** — assert the negative as hard as the positive:

```bash
# on gda-aicenter
sudo wg show wg0 latest-handshakes        # a recent timestamp, not 0
ping -c 3 10.88.0.2                       # ~2.6 ms
ping -c 3 -M do -s 1352 10.88.0.2         # 1352 + 28 = 1380. MUST be 0% loss.
ping -c 3 -M do -s 1400 10.88.0.2         # MUST fail — proves MTU is enforced, not accidental
# from a THIRD machine, neither host — the whole design rests on this being unreachable:
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://150.109.15.108:4007/   # must time out
```

### It is a separate compose PROJECT, on purpose — and now a separate host too

`docker-compose.social.yml` declares `name: gaiada-social`. The deploy workflow's
`up -d --no-build --remove-orphans` targets the `gaiada` project and deletes any container in
**that** project whose profile is absent from the command. A separate project is invisible to
it, so the orphan trap is structurally unreachable rather than merely documented (verified:
without `COMPOSE_PROFILES=social`, `config --services` lists nothing). Since the retarget it is
also on a host the release pipeline cannot reach at all. Both properties are kept — the second
is not a reason to relax the first, because the stack may yet move again.

Consequently — and this is the part that is easy to get wrong in the opposite direction:

- **Do NOT** add `docker-compose.social.yml` to the `COMPOSE_FILES` repo variable.
- **Do NOT** add `social` to the `COMPOSE_PROFILES` repo variable.
- This stack is **not** carried by `git push --tags`. Its image is **pinned by digest**, and it
  is upgraded only by a human editing that digest. Leaving it on `:latest` inside the release
  path would let `docker compose pull` roll an unreviewed AGPL engine onto the box between
  releases — the licence boundary is a reviewed surface.
- **The `SOCIAL_*` env block lives on the VPS, not on `gda-aicenter`.** `.env.example` carries
  both halves with a banner on each; filling the VPS block into the ERP box's `.env` does
  nothing at all (no service there names those vars) while scattering the group's platform-app
  secrets onto a host with no use for them.

### Bootstrap, in order (every step is required)

```bash
# Run on 150.109.15.108, in the checkout's infra/compose. Every command is project-scoped.
cd ~/gaiada-social/infra/compose

# 0. CONFIRM YOU ARE NOT ABOUT TO DISTURB PRODUCTION. Record the baseline; diff it at the end.
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort | tee /tmp/containers-before.txt | wc -l
df -h /                                  # expect ~169 GB free; disk is not a constraint here
free -g                                  # expect ~12 GiB available
#    NOTE: there is deliberately NO `docker image prune` step. See the host-safety rules.

# 1. Fill the SOCIAL_* block in this host's .env (see .env.example — the block with the
#    "belongs on a different machine" banner IS this one). Keep
#    SOCIAL_POSTIZ_DISABLE_REGISTRATION=true, and set SOCIAL_BIND_ADDR=10.88.0.2.
chmod 600 .env
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml config -q   # true dry run
#    Prove the bind address is what you think BEFORE anything listens:
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml config \
  | grep -A2 'published'                 # must show 10.88.0.2, never 0.0.0.0

# 2. Start ONLY the datastores + Temporal. Postiz comes later, and the order matters.
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml up -d \
  social-postgres social-redis social-temporal-postgres social-temporal

# 3. ── THE STEP THAT IS EASY TO MISS AND FAILS SILENTLY ──
#    Free one Temporal Text search-attribute slot BEFORE Postiz ever starts.
#    Dropping Elasticsearch puts Temporal's visibility store on Postgres, which allows at most
#    THREE custom Text search attributes. Temporal pre-registers two of its own; Postiz's
#    backend registers two more (organizationId, postId). 2+2 > 3, so the BACKEND dies on boot
#    with "cannot have more than 3 search attribute of type Text", never binds its API port,
#    and every /api call 502s — while `docker compose ps` still says the container is HEALTHY,
#    because the healthcheck only probes the Next frontend. CustomStringField is an unused
#    Temporal default; removing it is config, not a fork.
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml exec -T social-temporal \
  temporal operator search-attribute remove --name CustomStringField \
  --address social-temporal:7233 --namespace default --yes

# 4. Now start Postiz. First boot also pulls ~1.9 GB compressed and expands it to 5.66 GB,
#    which the 240s start_period does not cover — let the pull finish before judging health.
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml up -d postiz

# 5. PROVE the backend is actually up. `healthy` is NOT evidence — see step 3.
#    Expect 401 {"msg":"No API Key found"}. A 502 means step 3 was skipped or failed.
curl -s -o /dev/null -w '%{http_code}\n' http://10.88.0.2:4007/api/public/v1/posts
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml exec -T social-temporal \
  temporal operator search-attribute list --address social-temporal:7233 --namespace default \
  | grep -E 'organizationId|postId'      # both must be present, typed Text

# 6. Create the ONE org, then close the door again.
#    Registration must be enabled for exactly this call and nothing else.
#    (recreate, not restart — compose bakes env at CREATE time)
SOCIAL_POSTIZ_DISABLE_REGISTRATION=false COMPOSE_PROFILES=social \
  docker compose -f docker-compose.social.yml up -d --force-recreate postiz
#    ...create the org over the API, then:
COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml up -d --force-recreate postiz
#    VERIFY the door is shut — expect 400 "Registration is disabled":
curl -s -X POST http://10.88.0.2:4007/api/auth/register -H 'Content-Type: application/json' \
     -d '{"email":"probe@invalid.test","password":"Xx12345678!","company":"probe","provider":"LOCAL"}'

# 7. PROVE THE HOP FROM THE OTHER SIDE, and prove the internet cannot.
#    From gda-aicenter (must be 401 — a real backend answer, not a proxy error):
#      curl -s -m 10 -o /dev/null -w '%{http_code}\n' http://10.88.0.2:4007/api/public/v1/posts
#    From a third machine (must time out):
#      curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://150.109.15.108:4007/

# 8. Diff the baseline. 19 production containers before, 19 + 5 after. Nothing else moved.
docker ps -a --format '{{.Names}}\t{{.Status}}' | sort > /tmp/containers-after.txt
diff /tmp/containers-before.txt /tmp/containers-after.txt
```

### Ongoing operational notes

- **Disk keeps growing after install.** `social-postiz-uploads` is the media store and is
  unbounded — every image and video ever attached to a post lands there. 169 GB free makes this
  a slow problem rather than an immediate one, which is exactly how it gets forgotten. Add it
  to whatever disk alerting exists before, not after, it matters.
- **Never back up the Postiz volumes.** They hold live network OAuth tokens. Same rule as the
  bot's `keys.json` (see the Backups section): key material in a backup set voids crypto-shred.
  Postiz's Postgres holds only Postiz's own data, which is reconstructible by re-connecting
  accounts; the tokens are not ours to archive. **This now applies to a host whose backup policy
  is the owner's, not ours** — confirm the VPS's own backup regime does not snapshot these
  volumes before the first real account is connected.
- **`restart` does not re-read `.env`** here either — recreate. Same trap as everything else.
- **The tunnel is a dependency of the department, so monitor it like one.** If `wg0` is down,
  every publish and every status read fails closed with a connection error. `wg show wg0
  latest-handshakes` older than ~3 minutes is the signal. This is a *good* failure mode — loud
  and unambiguous — but only if something is watching.
- **nginx is NOT configured by this, and it stays on `gda-aicenter`.** The edge allowlist lives
  in `infra/nginx/snippets/gaiada-social-postiz.conf` and is hand-applied like the CP-5 and
  ASST-09 blocks. Read its header first: the preferred design exposes **nothing** of Postiz at
  the edge, the fallback blocks carry a real containment cost, and since the retarget their
  `proxy_pass` targets the tunnel peer rather than loopback. **The VPS gets no vhost, no
  certificate and no public listener.**
- **Rollback** is `COMPOSE_PROFILES=social docker compose -f docker-compose.social.yml down`
  (add `-v` only if you intend to destroy connected accounts). Because it is its own project on
  its own host, this cannot affect the ERP stack or the owner's 19 containers. Do not add
  `--remove-orphans` to it — there is no orphan to remove and the flag's scope is the danger.

## Security notes

- All service tokens are distinct random values; the only exposed port is localhost-bound.
- Provider keys exist only in the `ai-gateway` service env (D8).
- OpenBao replaces the file-based LocalKms before real-data ingestion (checklist 0.4) — it
  belongs on a SEPARATE VPS from this stack, per the day-one spec.
- `report-renderer` (TR-19) holds only the shared `RENDERER_TOKEN`, never a tenant credential, and
  is origin-locked to `PLATFORM_UI_INTERNAL_URL` (`report-renderer/src/auth.ts`) so a leaked token
  cannot be used to make it fetch arbitrary internal or external hosts.

## Web Dev department — post-deploy checklist (learned on gda-aicenter, 2026-08-03)

The delivery chain (record → transcribe → ingest → pipeline run → gates) needs three things the
deploy does NOT do for you. All three shipped wrong to gda-aicenter and the department sat dead —
extraction never ran, then ran but opened zero gates.

1. **Start whisper — it is behind a compose profile, so a plain `up -d` skips it.**
   `WHISPER_URL` still points at `http://whisper:8000`, so every server-side transcription fails
   against a host that does not exist.
   ```
   docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml      --profile whisper up -d whisper
   ```
   Verify (whisper publishes NO host port — call it from inside the network):
   `docker exec gaiada-platform-1 node -e '...POST http://whisper:8000/v1/audio/transcriptions...'`
   Measured throughput on a 2-vCPU box: **0.35× realtime** (21s per 60s of audio), so the 20-minute
   `WHISPER_TIMEOUT_MS` covers roughly 57 minutes of audio. Do not extrapolate from a 3-second clip —
   fixed per-request overhead dominates there and makes it look ~4× *slower* than realtime.

2. **Set `N8N_BRIDGE_ENTITY_TYPES` or the event bridge never starts.** `n8nBridgeEnabled()` is
   fail-closed on all four of base URL + secret + events + entityTypes. Empty ⇒ no bridge ⇒ every
   EVENT-triggered flow is dark (WS11 fan-out and delivery track, `client.created` seeding,
   org-structure notify) while CRON flows keep working, so the stack looks healthy and runs simply
   never grow gates. Confirm from the log line, not from config:
   `docker logs gaiada-platform-1 | grep "n8n bridge on:"` — absence of that line is the symptom.
   Value: `pipeline_run,pipeline_gate,scope,client,org_structure` (note `scope.signed` is emitted
   under `scope`, not `pipeline_run`).

3. **Size `N8N_BRIDGE_TIMEOUT_MS` to the box, not to the default.** The dispatcher does four
   sequential AI calls; measured round-trip on gda-aicenter is **31–40s** against a 30000 default, so
   ingest threw `dispatcher_unreachable` *after the run had already been created* — leaving the
   recording orphaned from a perfectly good run (the DEF-1 shape). 120000 is the value in use.
   Measure it before trusting it: the local dev box does the same work in ~12s.

**Reading the DB on the VPS:** `DATABASE_URL` uses `platform_app`, which is `NOBYPASSRLS`. Every
FORCE-RLS table reads as **zero rows** unless you set the GUC first, and `reltuples` is `-1`, so it
will not save you either:
```sql
select set_config('app.current_tenant_ids','<companyId>',false); select count(*) from clients;
-- company_memberships keys on its own setting instead:
select set_config('app.principal_user_id','<userId>',false);  select count(*) from company_memberships;
```
Skipping this reports an empty department that is actually populated.

**Driving the API headlessly when `AUTH_MODE=oidc`:** the `x-user-id` dev path is closed and no
Keycloak client has direct access grants (do **not** enable one on `gaiada-ui`). Use the OBO
envelope — `Authorization: Bearer $PLATFORM_SERVICE_TOKEN` plus `x-obo-provider` /
`x-obo-external-id` matching a **verified** `identity_links` row. That yields assurance `linked`,
which satisfies `notLow`.

**Still owner-gated:** `clients.portal_user_id` is unset for every client, so the client-side
`scope_signoff` / review gates cannot be countersigned — a client portal identity is a business
decision, not a deploy step. The agency half signs fine (`complete:false`, waiting on the client).

## Incident 2026-08-12 — Cerbos crash-looped after a policy DELETION (authorization down)

**Symptom.** Deploy of `alpha-01.037.0087a` reported success. `/health` returned the new version and
the correct image tags were running — but `gaiada-cerbos-1` was restarting in a loop (41 restarts),
so every authorization check failed platform-wide.

```
cerbos: error: failed to create rule table from loader: policy compilation error:
  resource_team.yaml:24:22: Derived role "team_lead" is not defined in any imports
```

**Cause — two independent gaps, both now fixed in `.github/workflows/deploy.yml`:**

1. **The policy rsync had no `--delete`.** It only ever added and overwrote, so a policy file deleted
   in git lived on forever on the box. The release retired `team_lead` (removing it from
   `derived_roles.yaml` and deleting `resource_team.yaml`), and the server ended up with the NEW
   derived roles beside the STALE resource policy. Cerbos compiles its whole repo at startup and
   refuses to start on any error. **Nothing in CI could catch this**: locally the file was gone, so
   `cerbos compile` passed. The broken state existed only in the union of new-plus-stale files the
   server assembled.
2. **The health gate could not see the failure.** It ran `docker compose ps` without `-a`, which
   lists only RUNNING containers — a crash-looping service is `restarting` and was omitted from the
   listing entirely, so the check found nothing wrong and printed "all services healthy". The awk
   filter was correct all along (`$2!="running"`); it never saw the row.

**Recovery (what was actually done):** removed the orphan on the box (backup at
`/tmp/resource_team.yaml.bak`), then `docker restart gaiada-cerbos-1`. Healthy in ~25s, restart count
back to 0. Verified by DECISION PROBE, not by health: `org_unit_lead` at an ancestor unit → ALLOW on a
descendant document; a `team_lead` grant → DENY on `pm_task` read and create.

**If it happens again:**
```
docker logs gaiada-cerbos-1 --tail 20          # the compilation error names the offending file
ls /home/Hansel/gaiada/platform-nest/cerbos/policies/   # compare against git
rm <orphan>.yaml && docker restart gaiada-cerbos-1
```

**The lesson worth keeping:** a green deploy plus a correct `/health` version is not evidence that
authorization works. Cerbos fails CLOSED, so an unloadable policy repo looks like a healthy platform
that denies everything. Verify a policy change with a real decision probe against
`POST /api/check/resources` — assert an ALLOW *and* a DENY, so a PDP that is merely reachable cannot
be mistaken for one that is correct.
