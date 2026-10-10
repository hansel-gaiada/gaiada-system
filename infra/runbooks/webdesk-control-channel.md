# Runbook - make the ERP -> WebDesk control channel real (WSK-63a)

**Status: PROTOTYPED.** The repo side (vhost, Caddy gate, overlay, env) is proved on Linux in a containerised
mini-topology (see "Proof" at the end). **Nothing in this runbook has been run on `gda-aicenter`.** Every live step
is executed by the orchestrator, in order. Design: `docs/plans/2026-10-10-webdesk-write-plane-design.md` section 11.

## As executed on `gda-aicenter`, 2026-10-10 (read this before re-running)

Steps 0, 2, 3, 4, 5, 6, 7, 9, 10 and 11 were run live by the orchestrator. Step 8 was deliberately left for the release that
ships WSK-63b's compose change (`extra_hosts`). Reachability from the ERP network was proven instead with a throwaway
container: `docker run --rm --network gaiada_default --add-host control.webdesk.internal:host-gateway alpine:3 nc -z control.webdesk.internal 9443` prints `tcp ok`.
Five corrections to the steps below, each found live:

1. **The WebDesk env file is `/etc/webdesk/.env`.** There is no project-directory `.env` on this box. Every compose call needs `--env-file /etc/webdesk/.env`, and the gate secret is appended there (owner `webdesk-svc`, mode 600).
2. **Generate the gate secret BEFORE step 4's `up api`.** The overlay makes it a required variable, and compose validates the whole project, so `up -d --no-deps api` fails to interpolate until the secret exists. Order used: step 5 (secret + proxy), then step 4 (api).
3. **Do not build the api on this box.** It is the live ERP kernel; a build once drove load to 16 on 4 cores. Build on sumopod from a `git -c core.autocrlf=false archive`, then `docker save | gzip -1 | ssh gda-aicenter 'gunzip | docker load'` (351 MB in 30 s). Tag it `webdesk-api:latest` and use `up -d --no-deps --no-build api`.
4. **The Keycloak container has no `awk`.** Step 9's scope-binding loop dies under `set -e` after the client and scopes are created. Parse `kcadm` JSON on the host with python3 instead.
5. **Matrix rows 3 and 4 must target a real route.** `GET /control/v1/tenants` does not exist (tenants is POST-only), and Nest's routing 404s before any guard runs, so those rows prove nothing. Use `GET /control/v1/tenants/<slug>/contract`: with cert and no token → `401 Layer 2 … no Bearer token presented`; the same with a forged URL-encoded cert header and a wrong gate header → the identical Layer 2 answer, never a Layer 1 refusal.

Also: `/etc/gaiada` is root-only (0700), so curl running as the operator must read the cert/key/CA through `sudo cat` into a private temp dir.
The CA pin in `/etc/webdesk/certs/ca-cert.pem` already equalled the internal CA (sha256 `54067520…`), so no swap was needed.

## What gets built

    platform (ERP)  --mTLS+Bearer-->  host nginx 172.17.0.1:9443  (vhost control.webdesk.internal)
                                        verifies client cert against the internal CA, then adds:
                                          X-Webdesk-Mtls-Cert-Pem = $ssl_client_escaped_cert (URL-encoded PEM)   (overwrites any inbound value)
                                          X-Webdesk-Control-Gate  = <secret>
                                      --> Caddy 127.0.0.1:8380 : /control/* routed to api ONLY if the gate matches
                                      --> api: Layer 1 re-verifies the cert, Layer 2 verifies the Keycloak token offline

No new host port is published (compose still publishes only `proxy` on `127.0.0.1:8380`); Caddy stays loopback.

## Facts verified on `gda-aicenter` 2026-10-10 (read-only)

| Fact | Value | Consequence |
|---|---|---|
| Host nginx | `1.22.1-9+deb12u10`, Debian 12, no extra modules; used stock (no njs/perl): the verified cert is forwarded as `$ssl_client_escaped_cert` | nothing to install into the live nginx; the api (Layer 1) decodes the URL-encoded form instead (step 4) |
| nginx boot order | unit is `After=network-online.target` only, NOT docker | a bind to `172.17.0.1` fails if docker0 is not up yet, taking down **every** vhost; step 2 sets `ip_nonlocal_bind=1` |
| `host-gateway` | `172.17.0.1` (docker0); `host.docker.internal` already resolves to it in `gaiada-platform-1`; Postgres/Redis/:4310 already listen there | the vhost listens on `172.17.0.1:9443` |
| Listeners today | `0.0.0.0:443`, `0.0.0.0:80`, `127.0.0.1:8380` ... nothing on `:9443` | pick `:9443`, not `:443` (a shared wildcard `:443` would expose the mTLS vhost publicly) |
| Internal CA | **exists**: `gaiada_gateway-data` volume, `ca-cert.pem` + `ca-key.pem` (0600 root), `CN=gaiada-internal-ca`, 2026-08-30 to 2036-08-27, sha256 `52:87:84:2B:D1:1A:D4:D2:1B:6C:70:39:4A:B7:98:CB:C7:4C:29:2F:F0:E1:E1:A3:4C:8C:94:65:EC:BB:F6:88` | **`infra/runbooks/internal-ca.md` is stale**: its status header still says the CA "DOES NOT EXIST YET" (flagged here, not edited by WSK-63a) |
| Client cert | **already issued**: `platform-nest-webdesk.crt/.key` in the same volume, `CN=platform-nest-webdesk`, EKU clientAuth only, no SAN, valid to 2028-12-02 | step 3b reuses it; no re-issue needed |
| Server cert | does not exist | step 3a issues it (`SAN DNS:control.webdesk.internal`, EKU serverAuth) |
| api pinned CA | `webdesk-api-1` has `WEBDESK_CONTROL_MTLS_CA_FILE=/etc/webdesk/certs/ca-cert.pem` (host dir is 0700, unreadable without sudo). **Unknown whether it is still the placeholder CA** (hardening runbook says the placeholder's key was destroyed). | step 4 compares and swaps if it differs. Without it Layer 1 refuses every real cert |
| api env | `WEBDESK_CONTROL_OIDC_ISSUER=https://erp.gaiada.online/idp/realms/gaiada`, `..._AUDIENCE=webdesk-control-plane`, `..._ALLOWED_CN=platform-nest-webdesk` already live (from `.env.control`) | no `.env.control` edit needed |
| Control routes | `ControlModule` is wired; `/control/v1/...` routes are mapped in the running api | positive tests can reach a real controller |
| NTP | `timedatectl`: `NTP=yes`, `NTPSynchronized=yes`, UTC (no `chronyc`; systemd-timesyncd) | still re-check in step 10 |
| Compose projects | webdesk: `/home/Hansel/gaiada-webdesk/webdesk` with `-f docker-compose.yml -f docker-compose.aicenter.yml`. ERP: `/home/Hansel/gaiada/infra/compose` with `docker-compose.vps.yml` + `hostdata` + `observability`; service `platform`, container `gaiada-platform-1` (runs as uid 0) | use exactly these file sets (see "Footguns") |
| Passwordless sudo | works for `Hansel` | |

## Footguns that bite this exact rollout (read before step 1)

- **`up -d` silently rolls back a service whose `.env` tag is stale** (memory: server-env-stale-tag-footgun). Every compose
  command below is `up -d --no-deps <one service>` and is preceded by a `config` check of the image it will use.
- **Never `--remove-orphans`** (deletes off-profile containers).
- **Single-file bind mounts pin an inode.** Replace `/etc/webdesk/certs/ca-cert.pem` by overwriting in place (`cat new > file`), never `mv`/`install` over it.
- **env_file mangles multi-line PEMs**; the CA travels as a file mount only (already so).
- Compose here is `5.3.1` on the box, `5.1.3` on sumopod (where the port audit ran).
- Do not paste the gate secret or the Keycloak client secret into chat, logs, commits. Commands below read them from files.

## Step 0 - shell + baseline

    ssh gda-aicenter
    TS=$(date -u +%Y%m%dT%H%M%SZ); echo "$TS" > ~/wsk63a.ts     # reuse the SAME stamp for every backup name
    # baseline - keep this output, step 11 compares against it
    curl -s -o /dev/null -w 'erp %{http_code}\n' https://erp.gaiada.online/
    docker compose -f /home/Hansel/gaiada-webdesk/webdesk/docker-compose.yml -f /home/Hansel/gaiada-webdesk/webdesk/docker-compose.aicenter.yml --project-directory /home/Hansel/gaiada-webdesk/webdesk ps
    sudo nginx -t
    ss -ltn | grep -E ':9443\b' || echo "9443 free"
    sudo cp -a /etc/nginx /etc/nginx.bak-wsk63a-$TS
    sudo nginx -T > ~/nginx-T.before-wsk63a.txt 2>&1

**Check:** `nginx -t` successful, `9443 free`, webdesk containers healthy. **Rollback of step 0:** none needed (backup only).

## Step 1 - get the repo files onto the box

The WSK-63a commit (Caddyfile, overlay, `.env.example`, nginx vhost, runbook, and the api Layer 1 change) must be on `/home/Hansel/gaiada-webdesk` (route: the hand-built deploy runbook / normal pull; no
push is done by the WSK-63a author). Verify the working tree has them and back up what they replace:

    cd /home/Hansel/gaiada-webdesk/webdesk
    for f in proxy/Caddyfile docker-compose.aicenter.yml .env.example api/src/control/auth/mtls-verifier.ts; do cp -a $f $f.bak-wsk63a-$TS; done   # BEFORE pulling
    # ... pull/checkout the WSK-63a commit ...
    git log -1 --oneline
    ls ops/nginx/control.webdesk.internal.conf
    grep -c 'X-Webdesk-Control-Gate' proxy/Caddyfile        # expect 4+ lines

**Rollback:** restore the four `.bak-wsk63a-$TS` files (or `git checkout <previous-commit> -- <files>`).

## Step 2 - make nginx boot-safe on `172.17.0.1` (do this BEFORE any vhost mentions that address)

    echo 'net.ipv4.ip_nonlocal_bind = 1' | sudo tee /etc/sysctl.d/60-wsk63a-nonlocal-bind.conf
    sudo sysctl -p /etc/sysctl.d/60-wsk63a-nonlocal-bind.conf

**Check:** `cat /proc/sys/net/ipv4/ip_nonlocal_bind` prints `1`. (It was `0`.) Effect: a socket may bind an address that is not
configured yet; nothing else on the box depends on it being off.
**Rollback:** `sudo rm /etc/sysctl.d/60-wsk63a-nonlocal-bind.conf; sudo sysctl -w net.ipv4.ip_nonlocal_bind=0` (only after the vhost is removed).

## Step 3 - certificates (the CA key never leaves the host; it is only mounted read-only into a throwaway container on this host)

Image: `alpine/openssl` (already on the box, id `61cec9c1f221`; use the id so the tag cannot move). Work dir `~/wsk63a-certs` (0700).

### 3a - server cert for `control.webdesk.internal`

    install -d -m 0700 ~/wsk63a-certs
    docker run --rm --entrypoint sh -v gaiada_gateway-data:/ca:ro -v "$HOME/wsk63a-certs:/out" 61cec9c1f221 -c '
    set -e
    openssl x509 -in /ca/ca-cert.pem -noout -subject | grep -q "CN=gaiada-internal-ca"
    openssl ecparam -name prime256v1 -genkey -noout -out /out/server.key
    openssl req -new -key /out/server.key -subj /CN=control.webdesk.internal -out /out/server.csr
    printf "keyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:control.webdesk.internal\n" > /out/server.ext
    openssl x509 -req -in /out/server.csr -CA /ca/ca-cert.pem -CAkey /ca/ca-key.pem -set_serial 0x$(openssl rand -hex 16) \
      -days 825 -sha256 -extfile /out/server.ext -out /out/server.crt
    cp /ca/ca-cert.pem /out/ca-cert.pem
    openssl verify -CAfile /out/ca-cert.pem /out/server.crt
    openssl x509 -in /out/server.crt -noout -subject -issuer -dates -ext subjectAltName,extendedKeyUsage'
    sudo chown root:root ~/wsk63a-certs/server.key; sudo chmod 600 ~/wsk63a-certs/server.key

(`-set_serial` instead of `-CAcreateserial` keeps the CA volume read-only; nothing is written into it.)
**Check:** `server.crt: OK`, subject `CN=control.webdesk.internal`, SAN and `serverAuth` present, issuer `CN=gaiada-internal-ca`.
**Rollback:** `rm -rf ~/wsk63a-certs` (nothing was changed on any live system).

### 3b - the platform client cert (already issued; verify, do not re-issue)

    docker run --rm --entrypoint sh -v gaiada_gateway-data:/ca:ro 61cec9c1f221 -c '
    openssl verify -CAfile /ca/ca-cert.pem /ca/platform-nest-webdesk.crt
    openssl x509 -in /ca/platform-nest-webdesk.crt -noout -subject -enddate -ext extendedKeyUsage
    openssl x509 -in /ca/platform-nest-webdesk.crt -noout -pubkey | sha256sum; openssl pkey -in /ca/platform-nest-webdesk.key -pubout | sha256sum'

**Check:** `OK`, `CN=platform-nest-webdesk`, `TLS Web Client Authentication`, the two pubkey hashes are identical (cert matches key), `notAfter` Dec 2028.
If any check fails, re-issue with `internal-ca.md` section 2 (same `-set_serial` pattern as 3a, `extendedKeyUsage=clientAuth`, CN exactly `platform-nest-webdesk`).

Stage the material where platform's mount (WSK-63b) will read it (container user is uid 0, so 0600 root works):

    sudo install -d -m 0755 /etc/gaiada/webdesk-control
    docker run --rm --entrypoint cat -v gaiada_gateway-data:/ca:ro 61cec9c1f221 /ca/platform-nest-webdesk.crt | sudo tee /etc/gaiada/webdesk-control/client.crt >/dev/null
    docker run --rm --entrypoint cat -v gaiada_gateway-data:/ca:ro 61cec9c1f221 /ca/platform-nest-webdesk.key | sudo tee /etc/gaiada/webdesk-control/client.key >/dev/null
    sudo cp ~/wsk63a-certs/ca-cert.pem /etc/gaiada/webdesk-control/ca-cert.pem
    sudo chmod 600 /etc/gaiada/webdesk-control/client.key; sudo chmod 644 /etc/gaiada/webdesk-control/client.crt /etc/gaiada/webdesk-control/ca-cert.pem

The client private key is the one sensitive copy that leaves the CA volume (the CA key does not). Do not copy it anywhere else; it must not enter git, logs or chat.
**Rollback:** `sudo rm -rf /etc/gaiada/webdesk-control`.

## Step 4 - api: pin the REAL CA and deploy the Layer 1 change (URL-encoded cert header)

    docker run --rm --entrypoint sha256sum -v gaiada_gateway-data:/ca:ro 61cec9c1f221 /ca/ca-cert.pem
    sudo sha256sum /etc/webdesk/certs/ca-cert.pem
    docker exec webdesk-api-1 sha256sum /etc/webdesk/certs/ca-cert.pem

First the CA pin (the swap `internal-ca.md` section 3 describes). All three equal: skip the swap lines. Otherwise swap IN PLACE, keeping owner/mode:

      sudo cp -a /etc/webdesk/certs/ca-cert.pem /etc/webdesk/certs/ca-cert.pem.bak-wsk63a-$TS
      sudo sh -c 'cat /home/Hansel/wsk63a-certs/ca-cert.pem > /etc/webdesk/certs/ca-cert.pem'
      docker exec webdesk-api-1 sha256sum /etc/webdesk/certs/ca-cert.pem    # must equal the CA volume's hash


Then deploy the api with the WSK-63a Layer 1 change (`mtls-verifier.ts` now accepts ONLY the URL-encoded PEM that nginx `$ssl_client_escaped_cert` produces; the old
base64 form is refused). This must be live before the vhost is enabled in step 7. The api image is built from `./api` by the aicenter overlay (no registry tag involved):

    cd /home/Hansel/gaiada-webdesk/webdesk
    docker compose -f docker-compose.yml -f docker-compose.aicenter.yml build api
    docker compose -f docker-compose.yml -f docker-compose.aicenter.yml up -d --no-deps api      # this also picks up the swapped CA file
    sleep 8; docker logs webdesk-api-1 --tail 3                                                   # expect: [webdesk:api] listening on :3000
    docker exec webdesk-api-1 sha256sum /etc/webdesk/certs/ca-cert.pem                            # must equal the CA volume's hash
    docker exec webdesk-api-1 grep -c 'decodeURIComponent' /app/dist/control/auth/mtls-verifier.js    # >=1 (path may differ; locate with find /app -name mtls-verifier.js)

**Check:** hashes equal; `curl -s http://127.0.0.1:8380/healthz` still `webdesk proxy ok`; a public `/v1` smoke still answers.
**Rollback:** CA: `sudo sh -c 'cat /etc/webdesk/certs/ca-cert.pem.bak-wsk63a-'$TS' > /etc/webdesk/certs/ca-cert.pem'`; code: check out the previous commit's `api/` and repeat the build + `up -d --no-deps api`.
(If the api crash-loops after a CA swap, the file is not a valid PEM - roll back at once; the boot check refuses a truncated CA.)

## Step 5 - the gate secret, Caddy and the overlay (WebDesk side)

    cd /home/Hansel/gaiada-webdesk/webdesk
    cp -a .env .env.bak-wsk63a-$TS
    grep -q '^WEBDESK_CONTROL_GATE_SECRET=' .env && echo "ALREADY SET - do not regenerate" || \
      printf 'WEBDESK_CONTROL_GATE_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env
    chmod 600 .env
    # config check BEFORE touching the running proxy; prints no secret
    docker compose -f docker-compose.yml -f docker-compose.aicenter.yml config > /tmp/wd-resolved.yml
    grep -n -B1 -A6 '^    ports:' /tmp/wd-resolved.yml          # ONLY proxy: host_ip 127.0.0.1, published "8380", target 80
    awk '/^  [a-z-]+:$/{s=$1} /^    ports:/{print s}' /tmp/wd-resolved.yml    # must print exactly: proxy:
    grep -E 'WEBDESK_CONTROL_GATE_SECRET' /tmp/wd-resolved.yml | sed -E 's/(SECRET: ).*/\1<set>/'; rm -f /tmp/wd-resolved.yml
    docker compose -f docker-compose.yml -f docker-compose.aicenter.yml up -d --no-deps proxy

`proxy` is caddy with no state (the public `/v1` blips for a second or two while it recreates).
**Check:**

    docker compose -f docker-compose.yml -f docker-compose.aicenter.yml ps proxy          # healthy/Up
    curl -s -o /dev/null -w 'healthz %{http_code}\n' http://127.0.0.1:8380/healthz         # 200
    curl -s -o /dev/null -w 'control no gate %{http_code}\n' http://127.0.0.1:8380/control/v1/tenants   # 404
    curl -s -o /dev/null -w 'control WRONG gate %{http_code}\n' -H 'X-Webdesk-Control-Gate: wrong' http://127.0.0.1:8380/control/v1/tenants   # 404
    docker exec webdesk-proxy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | tail -1    # Valid configuration

**Rollback:** `cp -a Caddyfile/overlay/.env .bak-wsk63a-$TS` back over the three files (`proxy/Caddyfile`, `docker-compose.aicenter.yml`, `.env`) and
re-run the same `up -d --no-deps proxy`.

## Step 6 - the PUBLIC vhost strips both headers (staged file, not yet enabled, so this edit is safe)

Purpose: `api.gaiada.online` must never be able to deliver `X-Webdesk-Control-Gate` or `X-Webdesk-Mtls-Cert-Pem` to Caddy. This step makes that vhost strip BOTH (Caddy also strips both on its public routes and 404s `/control/*` without the gate).

`/etc/nginx/sites-available/api.gaiada.online.conf` forwards everything. Add, inside its `location /` block, next to the other `proxy_set_header` lines:

    proxy_set_header   X-Webdesk-Control-Gate  "";
    proxy_set_header   X-Webdesk-Mtls-Cert-Pem "";

(An empty value makes nginx drop the header.) Exactly as exercised in the proof (`webdesk/ops/nginx/proof/public-vhost.test.conf`).

    sudo cp -a /etc/nginx/sites-available/api.gaiada.online.conf /etc/nginx/sites-available/api.gaiada.online.conf.bak-wsk63a-$TS
    # edit, then:
    grep -n 'X-Webdesk-' /etc/nginx/sites-available/api.gaiada.online.conf       # both lines present

The file is not in `sites-enabled`, so `nginx -t` does not read it yet; its syntax is checked by the `nginx -t` in the step that enables it
(if it is already enabled by then, run `sudo nginx -t && sudo systemctl reload nginx` now).
**Rollback:** copy the `.bak-wsk63a-$TS` back. Caddy strips both headers on its public routes regardless (defence in depth), and Caddy
404s `/control/*` without the gate, so this edit is the third layer, not the only one.

## Step 7 - install and enable the control vhost

    sudo install -d -m 0755 /etc/nginx/webdesk-control
    sudo install -m 0644 ~/wsk63a-certs/ca-cert.pem /etc/nginx/webdesk-control/ca-cert.pem
    sudo install -m 0644 ~/wsk63a-certs/server.crt  /etc/nginx/webdesk-control/server.crt
    sudo install -m 0600 -o root -g root ~/wsk63a-certs/server.key /etc/nginx/webdesk-control/server.key
    # render the vhost with the SAME secret Caddy has; the secret is read from .env, never printed
    set -a; . <(grep '^WEBDESK_CONTROL_GATE_SECRET=' /home/Hansel/gaiada-webdesk/webdesk/.env); set +a
    ( umask 077; sudo -E sh -c "envsubst '\${WEBDESK_CONTROL_GATE_SECRET}' < /home/Hansel/gaiada-webdesk/webdesk/ops/nginx/control.webdesk.internal.conf > /etc/nginx/sites-available/control.webdesk.internal" )
    unset WEBDESK_CONTROL_GATE_SECRET
    sudo chmod 600 /etc/nginx/sites-available/control.webdesk.internal
    sudo grep -c 'WEBDESK_CONTROL_GATE_SECRET' /etc/nginx/sites-available/control.webdesk.internal     # must be 0 (nothing left unrendered)
    sudo ln -s /etc/nginx/sites-available/control.webdesk.internal /etc/nginx/sites-enabled/control.webdesk.internal
    sudo nginx -t && sudo systemctl reload nginx

If `nginx -t` fails: `sudo rm /etc/nginx/sites-enabled/control.webdesk.internal`, re-run `sudo nginx -t`, and stop - do NOT reload a failing config.
**Check:**

    ss -ltn | grep -E '172.17.0.1:9443'          # listening
    ss -ltn | grep -E ':9443'                    # ONLY the 172.17.0.1 line - no 0.0.0.0:9443
    curl -s -o /dev/null -w 'erp %{http_code}\n' https://erp.gaiada.online/       # same as the baseline
    sudo tail -n 3 /var/log/nginx/control.webdesk.internal.error.log

**Rollback:** `sudo rm /etc/nginx/sites-enabled/control.webdesk.internal && sudo nginx -t && sudo systemctl reload nginx` (the vhost is additive; removing it restores the
previous behaviour exactly). Optionally also delete `/etc/nginx/sites-available/control.webdesk.internal` (it holds the secret).

## Step 8 - let platform reach the vhost (`extra_hosts`)

The committed change belongs to WSK-63b (`infra/` platform compose). To prove the channel now, apply it by hand:

    # inspect first: which image would compose use for platform, and which is running?
    cd /home/Hansel/gaiada/infra/compose
    F='-f docker-compose.vps.yml -f docker-compose.hostdata.yml -f docker-compose.observability.yml'
    docker compose $F config | grep -A3 '^  platform:' | head; docker compose $F config | grep -E '^\s+image:.*platform' ; docker inspect gaiada-platform-1 --format '{{.Config.Image}}'

The two image references must be the same tag. If not, STOP (stale-tag footgun: `up -d` would roll the ERP back).

    cat > /home/Hansel/gaiada/infra/compose/docker-compose.webdesk-control.yml <<'YML'
    services:
      platform:
        extra_hosts:
          - "control.webdesk.internal:host-gateway"
    YML
    docker compose $F -f docker-compose.webdesk-control.yml up -d --no-deps platform

This recreates the ERP backend container (stateless, DB is external) - a short ERP blip; schedule it. Never `--remove-orphans`.
**Check:** `docker exec gaiada-platform-1 getent hosts control.webdesk.internal` prints `172.17.0.1`; then
`docker exec gaiada-platform-1 node -e "require('net').connect(9443,'control.webdesk.internal').on('connect',function(){console.log('tcp ok');this.end()}).on('error',e=>console.log('FAIL',e.code))"` prints `tcp ok`.
**Rollback:** `rm docker-compose.webdesk-control.yml` and re-run the `up -d --no-deps platform` without that `-f`.
If `tcp ok` fails while the host curl in step 11 works, the host firewall blocks docker bridges to `172.17.0.1:9443`; check `sudo ufw status` /
`iptables -S INPUT` (Postgres on `172.17.0.1:5432` already works from containers, so a rule for that port can be extended).

## Step 9 - the Keycloak client `webdesk-control`

What Layer 2 expects (read from `webdesk/api/src/control/auth/{keycloak-token-verifier,real-control-channel-authenticator}.ts`): issuer exactly
`https://erp.gaiada.online/idp/realms/gaiada`; `aud` contains `webdesk-control-plane`; signature from the realm JWKS (kid-pinned, offline);
`azp` (else `sub`) becomes the principal subject; `scope` is a space-separated string and only `webdesk:read|operate|promote|keys` are honoured; `exp` with 5 s tolerance.

Run inside the keycloak container (admin password from its own environment; it is never echoed). Admin user/credential: same as `infra/compose/keycloak/configure-smtp.sh`.

    docker exec -i gaiada-keycloak-1 sh -s <<'KC'
    set -eu
    K=/opt/keycloak/bin/kcadm.sh; R=gaiada
    $K config credentials --server http://localhost:8080/idp --realm master --user "${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null
    $K get clients -r $R -q clientId=webdesk-control --fields id | grep -q '"id"' && { echo "webdesk-control ALREADY EXISTS - stop, inspect"; exit 1; }
    for s in webdesk:read webdesk:operate webdesk:promote webdesk:keys; do
      $K create client-scopes -r $R -s name=$s -s protocol=openid-connect -s 'attributes."include.in.token.scope"=true' -s 'attributes."display.on.consent.screen"=false'
    done
    $K create clients -r $R -s clientId=webdesk-control -s protocol=openid-connect -s enabled=true \
      -s publicClient=false -s serviceAccountsEnabled=true -s standardFlowEnabled=false \
      -s directAccessGrantsEnabled=false -s implicitFlowEnabled=false -s clientAuthenticatorType=client-secret \
      -s 'attributes."access.token.lifespan"=300'
    CID=$($K get clients -r $R -q clientId=webdesk-control --fields id --format csv --noquotes)
    for s in webdesk:read webdesk:operate webdesk:promote webdesk:keys; do
      SID=$($K get client-scopes -r $R --fields id,name --format csv --noquotes | awk -F, -v n=$s '$2==n{print $1}')
      $K update clients/$CID/default-client-scopes/$SID -r $R
    done
    $K create clients/$CID/protocol-mappers/models -r $R -s name=webdesk-control-plane-audience -s protocol=openid-connect \
      -s protocolMapper=oidc-audience-mapper -s 'config."included.custom.audience"=webdesk-control-plane' \
      -s 'config."access.token.claim"=true' -s 'config."id.token.claim"=false'
    echo "created client id $CID"
    KC

`access.token.lifespan=300` keeps tokens short (the ERP client caches with single-flight, design section 11). Default scopes grant all four scopes to every token, which matches design
section 03 ("scoped to read/operate/promote/keys", ERP is the only holder); Layer 3 still gates each command on the scope it needs.

Store the client secret straight into a root-only file (63b will mount/inject it); do not print it:

    docker exec gaiada-keycloak-1 sh -c '/opt/keycloak/bin/kcadm.sh config credentials --server http://localhost:8080/idp --realm master --user "${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD" >/dev/null && CID=$(/opt/keycloak/bin/kcadm.sh get clients -r gaiada -q clientId=webdesk-control --fields id --format csv --noquotes) && /opt/keycloak/bin/kcadm.sh get clients/$CID/client-secret -r gaiada --fields value --format csv --noquotes' \
      | ( umask 077; sudo tee /etc/gaiada/webdesk-control/client-secret >/dev/null )
    sudo wc -c /etc/gaiada/webdesk-control/client-secret

**Check (claims, no secret or token printed):**

    SEC=$(sudo cat /etc/gaiada/webdesk-control/client-secret)
    curl -s https://erp.gaiada.online/idp/realms/gaiada/protocol/openid-connect/token -d grant_type=client_credentials -d client_id=webdesk-control --data-urlencode "client_secret=$SEC" \
      | python3 -c 'import sys,json,base64; t=json.load(sys.stdin)["access_token"].split(".")[1]; t+="="*(-len(t)%4); c=json.loads(base64.urlsafe_b64decode(t)); print({k:c.get(k) for k in ("iss","aud","azp","scope","exp")})'
    unset SEC

Expected: `iss` `https://erp.gaiada.online/idp/realms/gaiada`, `aud` contains `webdesk-control-plane`, `azp` `webdesk-control`, `scope` contains the four `webdesk:*` scopes.
**Rollback:** `kcadm delete clients/$CID -r gaiada` and the four `client-scopes` (names `webdesk:*`), then `sudo rm /etc/gaiada/webdesk-control/client-secret`. Nothing else depends on the client until 63b ships.

## Step 10 - clocks

Certs are issued `notBefore = now - 1h` by the estate procedure, tokens carry a 5 s tolerance and WS4 assertions an `exp`; a drifting host clock breaks these silently.

    timedatectl show -p NTP -p NTPSynchronized          # NTP=yes, NTPSynchronized=yes
    timedatectl timesync-status 2>/dev/null | head -8   # offset in the low milliseconds
    date -u; docker exec gaiada-platform-1 date -u; docker exec webdesk-api-1 date -u     # all within 1 s (containers share the host clock)
    curl -sI https://erp.gaiada.online/ | grep -i '^date:'                                 # within a couple of seconds of `date -u`

Observed 2026-10-10: `NTP=yes`, `NTPSynchronized=yes`, UTC. If not synchronized: `sudo timedatectl set-ntp true`, wait, re-check. **Rollback:** none.

## Step 11 - the curl matrix (run on the box; certs from `/etc/gaiada/webdesk-control` and `~/wsk63a-certs`)

    D=/etc/gaiada/webdesk-control
    T="--resolve control.webdesk.internal:9443:172.17.0.1 --cacert $D/ca-cert.pem"
    U=https://control.webdesk.internal:9443

| # | Command | Expected | Proves |
|---|---|---|---|
| 1 | `curl -s -o /dev/null -w '%{http_code}\n' $T $U/control/v1/tenants` | `400` (nginx 496, handshake completes, request never proxied) | no client cert refused |
| 2 | Same with a cert from ANOTHER CA: `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj /CN=platform-nest-webdesk -keyout /tmp/bad.key -out /tmp/bad.crt -days 1; curl -s -o /dev/null -w '%{http_code}\n' $T --cert /tmp/bad.crt --key /tmp/bad.key $U/control/v1/tenants; rm /tmp/bad.*` | `400` | a foreign cert is refused |
| 3 | `curl -s -w ' %{http_code}\n' $T --cert $D/client.crt --key $D/client.key $U/control/v1/tenants` | `401` and a body mentioning `Layer 2 (service token) refused: no Bearer token presented` (**not** a Layer 1 message) | transport OK, Layer 1 accepted the forwarded cert, gate accepted by Caddy |
| 4 | Same as 3 plus a forged `-H "X-Webdesk-Mtls-Cert-Pem: $(python3 -c 'import urllib.parse;print(urllib.parse.quote(open("/tmp/bad.crt").read(),safe=""))')"` (needs /tmp/bad.crt kept from row 2) and `-H 'X-Webdesk-Control-Gate: wrong'` | identical to 3 (still `401` Layer 2, never Layer 1) | nginx overwrites both headers |
| 5 | `curl -s -o /dev/null -w '%{http_code}\n' $T --cert $D/client.crt --key $D/client.key $U/v1/t/x/content` | `404` | the control vhost serves only `/control/` |
| 6 | `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8380/control/v1/tenants` and again with `-H 'X-Webdesk-Control-Gate: wrong'` | `404` / `404` | Caddy refuses without the gate |
| 7 | Public host: `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: api.gaiada.online' http://127.0.0.1/control/v1/tenants` (only once the public vhost is enabled; before that this hits the default site) and, once DNS exists, `https://api.gaiada.online/control/v1/tenants` | `404`, also with `-H 'X-Webdesk-Control-Gate: <real secret>'` | public `/control/*` stays dead |
| 8 | Token + cert, read-only command: `TOK=$(curl -s https://erp.gaiada.online/idp/realms/gaiada/protocol/openid-connect/token -d grant_type=client_credentials -d client_id=webdesk-control --data-urlencode "client_secret=$(sudo cat $D/client-secret)" \| python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])'); curl -s -w ' %{http_code}\n' $T --cert $D/client.crt --key $D/client.key -H "Authorization: Bearer $TOK" $U/control/v1/tenants/<existing-slug>/contract; unset TOK` | `501` per `api/README.md` (`contract.read` authenticates, authorises, audits, then reports not-yet-available), or the documented read result once WSK-15 exists. Anything other than 401/403 means Layers 1-3 passed | the full chain end to end |
| 9 | Row 8 with `Authorization: Bearer garbage` | `401`, `Layer 2 ... token ... refused` | Layer 2 is real |
| 10 | Row 8 without `--cert/--key` but with the token | `400` | token alone is not enough |

Rows 1, 2, 5, 6 and 10 must not appear in the api log: `docker logs webdesk-api-1 --since 5m | grep -c '/control/v1'` should only count rows 3, 4, 8, 9.
(The api README reports an unknown I could not resolve from the repo: whether row 8 needs an existing tenant slug to reach `501`; use a real slug from the DB if it returns `404`.)

If row 3 returns a **Layer 1** refusal, the api is pinning a different CA than nginx verified against: redo step 4.
If row 3 returns `404` from Caddy, the gate does not match: the `.env` secret and the rendered vhost secret differ - re-render step 7 from `.env`.

## Rotation / removal

- **Gate secret rotation:** change `.env` (step 5, `cp` backup first), `up -d --no-deps proxy`, re-render step 7, `nginx -t`, reload. Both must change together; between the two moves the channel 404s (fail closed).
- **Server cert expiry (825 days from issue):** re-run 3a, reinstall the three files, `nginx -t`, reload.
- **Full removal:** step 7 rollback, step 8 rollback, step 5 rollback, then steps 4/3/2 rollbacks if wanted. Compose publishes nothing new, so nothing to unpublish.

## Proof (what was run, where, with what result)

Harness: `webdesk/ops/nginx/proof/run.sh` (Dockerfile.nginx, gen-certs.sh, echo.mjs, nginx-entry.sh, client-tests.sh, public-vhost.test.conf). It was run on sumopod, containers only, network
`gate-wsk63a`, no host ports, torn down afterwards. nginx 1.22.1 with no extra modules (the aicenter version), `caddy:2-alpine`, the real unmodified Caddyfile and the real `mtls-verifier.ts` inside the echo upstream.
Test-only substitutions: `172.17.0.1` was added to the loopback device so the production `listen` line is used unmodified; the `proxy_pass` port was 8380 -> 80.
The api's Layer 1 specs also ran there (`node:22-bookworm`, throwaway Postgres): 29 tests pass (19 in `control-auth-layers.spec.ts`, 10 in `mtls-verifier.spec.ts`).
Result: T1-T9 plus a fail-closed empty-secret case and the resolved-config port audit all passed; the real output is in the WSK-63a report (and re-runnable with `bash webdesk/ops/nginx/proof/run.sh`).

Not proved by the harness (needs the live box): the box's own `nginx -t`, docker0 reachability from `gaiada-platform-1`, the real Keycloak client and a real token, NTP on the host.
