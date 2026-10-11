# Runbook — Umami on sumopod (M5-A3, WSK-D66)

**Status: PLANNED.** Every artifact here is written and statically checked (see "What was checked") but
nothing has run on a server. The orchestrator performs every step below; nothing is automated from CI.

Artifacts live in `infra/sumopod/umami/`. On the server the directory is copied to `/home/ubuntu/umami/`
(the systemd units assume that path).

## Open decisions (need an owner or orchestrator answer before the step that depends on them)

| # | Decision | Needed before |
|---|---|---|
| 1 | **Edge mechanism: RESOLVED by WSK-D71.** Umami's route lives in the ERP's own `erp-edge` Traefik (`infra/sumopod/erp-edge/`, runbook `erp-edge-sumopod.md`), reached from mimi's Traefik by one TLS-passthrough rule. Nothing about Umami is installed in mimi's directory. | Step 6 |
| 2 | **ERP read path.** WSK-D66 says the ERP pulls from Umami, but only the collector is public. This design reaches the API over WireGuard: `read-gate` publishes a GET-only API subset on `10.88.0.2:18743`, reachable from gda-aicenter only. Confirm, or A4 must use another route. | Step 9 / M5-A4 |
| 3 | **Staging origins for CORS** in `infra/sumopod/erp-edge/dynamic/erp-insights.yml` (placeholder `TODO`). | Step 6 |
| 4 | **DB-IP attribution (CC BY 4.0)** needs a visible credit on the site's privacy page; counsel to confirm wording. Vendor register rows for Umami and DB-IP (M5-G4). | before go-live |
| 5 | **Retention vs backups:** the 14-month delete does not reach rows already in backups (90 days; 1st-of-month copies 12 months). Counsel to confirm that is acceptable, else shorten backup retention. | before go-live |

## Design, in one screen

```
visitor -> mimi-tls-le :443 --(TCP passthrough, PROXY v2)--> 172.17.0.1:18443 -> erp-edge Traefik (TLS ends here)
        -> 172.17.0.1:18742 -> edge (nginx) -> app (Umami) -> db (Postgres)
           docker0 only        [internal net: no gateway, no route out]
```

* **Egress denial: an `internal: true` network plus a minimal publishing sidecar. Chosen over DOCKER-USER
  rules for the app.** An internal network has no gateway, so the app and the database cannot reach anything
  outside the project by construction. A firewall rule is state that can be flushed, lost to an ordering race at
  boot, or forgotten when the subnet changes; a network with no route cannot. The cost is one tiny nginx
  container (`edge`, 64 MiB) that must be on a non-internal network to publish a port. That sidecar is the one
  thing with a route out, so it is capped by one DOCKER-USER rule (`egress-guard.sh`, run at boot by
  `umami-egress-guard.service`) that drops NEW connections from the `edge` subnet. The sidecar also enforces
  the path allow-list a second time: only the tracker script and the collect path are proxied, everything else
  404s, so the admin UI cannot be exposed by a routing typo in erp-edge.
* Umami needs no outbound traffic at runtime: telemetry and update checks are off, the geo database is a
  host-side file mounted read-only (refreshed by a host timer, not by the app), and there is no email.
* Publishing is on **172.17.0.1 only** (docker0 exists at boot; mimi's bridge gateway does not). Docker's DNAT
  runs before ufw, so nothing here is ever published on `0.0.0.0`. Check it: Verify step 3.
* Umami stays **stock and unforked**: `ghcr.io/umami-software/umami:3.4.0` by tag and digest. v3.x ships Postgres
  only (no `postgresql-*` tag). Postgres is `postgres:16.15-alpine` by tag and digest, in its own container with
  its own named volume; it is never another project's database.
* `CLIENT_IP_HEADER=x-real-ip`: mimi's passthrough hands the visitor's address to erp-edge in a PROXY protocol
  header (trusted only from the one source address mimi arrives from). erp-edge's Traefik discards any
  `X-Forwarded-For` the visitor sent and writes its own from that address. The nginx edge trusts that header ONLY
  when the connection comes from erp-edge's source address as nginx sees it (`ERP_EDGE_SOURCE` in `.env`, a single
  address measured at deploy, never a docker range: see step 6), then OVERWRITES `X-Real-IP` with the result, so
  Umami never reads a spoofable value. A request from any other peer keeps its own address.
  Cloudflare/Vercel/CloudFront location headers are stripped at the edge and ignored by Umami
  (`SKIP_LOCATION_HEADERS=1`); erp-edge must not add any.
* `SALT_ROTATION=day`: visitor hashes rotate daily (default is monthly).

## 0. Preflight (measure first; sumopod runs every session's test gates)

```bash
ssh sumopod
uptime                                   # record load1; if > 14 on 4 cores, wait or pick another hour
free -m                                  # need >= 1.5 GiB "available" for ~1.1 GiB of limits
df -h / /var/lib/docker                  # need >= 20 GB free (81% used / 40 GB free measured 2026-10-11)
ss -ltnH | awk '{print $4}' | grep -E ':(18742|18743|13000)$' || echo "ports free"
docker network ls -q | xargs docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -E '^172\.28\.91\.' || echo "172.28.91.0/28 free"
ip -4 addr show docker0 | grep 172.17.0.1       # docker0 is the publish address
ip -4 addr show wg0 | grep 10.88.0.2            # only if the erp-read profile will be used
# erp-edge's own preflight (mimi's subnet, ports, versions) is in infra/runbooks/erp-edge-sumopod.md
```

**Advisory re-check (required):** GHSA-3xx8-742v-m4mq (High, 2026-06-30: the collector's cache token is
replayable as a share token, so anyone with the public website id can read analytics). No patched version was
listed when checked on 2026-10-11.

```bash
curl -s https://api.github.com/repos/umami-software/umami/security-advisories/GHSA-3xx8-742v-m4mq | grep -E '"(state|patched_versions|vulnerable_version_range)"'
curl -s "https://ghcr.io/v2/umami-software/umami/tags/list?n=1000" -H "Authorization: Bearer $(curl -s 'https://ghcr.io/token?scope=repository:umami-software/umami:pull' | sed 's/.*"token":"\([^"]*\)".*/\1/')" | tr ',' '\n' | grep -E '"[0-9]+\.[0-9]+\.[0-9]+"' | sort -V | tail -3
```

If a patched version exists, re-pin `docker-compose.yml` to that tag AND its digest
(`docker buildx imagetools inspect ghcr.io/umami-software/umami:<tag>`) before deploying. If none exists, the
mitigation is structural and already in the design: the public side serves exactly two paths, `x-umami-share-*`
headers are stripped at the edge, and the read API exists only on the WireGuard gate. Verify step 2 proves it.

## 1. Install files

```bash
mkdir -p ~/umami && cd ~/umami
# copy infra/sumopod/umami/ here (git archive, scp or rsync; use: git -c core.autocrlf=false archive)
chmod +x *.sh
cp .env.example .env && chmod 600 .env
# fill UMAMI_DB_PASSWORD, APP_SECRET, TWO_FACTOR_ENCRYPTION_KEY with: openssl rand -hex 32
# set ERP_EDGE_SOURCE=127.0.0.1 for now (trusts nothing real); step 6 replaces it with the measured address
```

Never commit `.env`; the repo is public.

## 2. Geo database (before the first `up`)

The runtime reads **`GEOLITE_DB_PATH`** (Umami `src/lib/detect.ts`); `GEO_DATABASE_URL` is read only by the
image *build* (`scripts/build-geo.js`), so it does nothing for a stock image. Do not rely on the GeoLite2 copy
the stock image bakes in (MaxMind's licence demands a 30-day refresh); the compose file points Umami at
`/geo/dbip-city-lite.mmdb` instead.

```bash
cd ~/umami && ./geo-refresh.sh            # downloads DB-IP Lite City (CC BY 4.0) into ./geo/
ls -l geo/                                 # dbip-city-lite.mmdb (> 20 MB) + VERSION
```

If the file is missing the collector fails on its first lookup, so do this before `up`.
**MMDB field compatibility is unverified:** Umami reads `country.iso_code`, `subdivisions[0].iso_code` and
`city.names.en`. DB-IP Lite should provide them, but check at first deploy (step 8).

## 3. First deploy

```bash
cd ~/umami
docker compose config -q && echo compose-ok
docker compose pull
docker compose up -d
docker compose ps                          # db, app, edge: healthy (app takes ~60 s: migrations run)
docker compose logs --tail 30 app          # "Updated tracker endpoint: /lib/kestrel/e."
curl -si http://172.17.0.1:18742/lib/kestrel.js | head -5     # 200 + javascript, straight from the edge
```

## 4. Egress guard (needs root)

```bash
sudo cp ~/umami/systemd/umami-egress-guard.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now umami-egress-guard
sudo ~/umami/egress-guard.sh status        # shows umami-edge-no-egress (and umami-read-gate-peer-only)
```

## 5. ufw: let erp-edge reach docker0 (needs root; after erp-edge exists, see erp-edge-sumopod.md)

The caller of 172.17.0.1:18742 is now erp-edge's bridge (`172.28.92.0/28`), not mimi's. Allow exactly that:

```bash
ERP_EDGE_SUBNET=172.28.92.0/28
sudo ufw allow from "$ERP_EDGE_SUBNET" to 172.17.0.1 port 18742 proto tcp comment 'umami edge from erp-edge'
docker exec erp-edge-traefik-1 wget -q -T 3 -O /dev/null http://172.17.0.1:18742/lib/kestrel.js && echo reachable
```

If that is refused although ufw allows it, Docker's inter-bridge isolation is dropping the DNAT'd packet
(erp-edge bridge -> umami `edge` bridge). Fix without opening anything wider:
`sudo iptables -I DOCKER-USER -s "$ERP_EDGE_SUBNET" -d 172.28.91.0/28 -p tcp --dport 8080 -j ACCEPT` placed ABOVE the
egress-guard drop (that drop only matches `-s 172.28.91.0/28`, so order does not matter), then add it to
`egress-guard.sh`. Record which was needed.

## 6. DNS, the erp-edge route and the trusted source (after erp-edge is running)

1. DNS (D61): `insights.erp.gaiada.com` CNAME `sumopod.erp.gaiada.com`. Confirm: `dig +short insights.erp.gaiada.com`.
2. The route is `infra/sumopod/erp-edge/dynamic/erp-insights.yml` (it replaces the old mimi-directory template).
   Its two `Path(...)` values must equal `TRACKER_SCRIPT_NAME` and `COLLECT_API_ENDPOINT` in `.env`; add the
   staging origins (decision 3). It is installed with the rest of `erp-edge/` (`erp-edge-sumopod.md` step 4);
   nothing is copied into mimi's directory for Umami.
3. **Which source does the edge see (sets `ERP_EDGE_SOURCE`).** erp-edge reaches `172.17.0.1:18742` through the
   host, so the packet is DNAT'd and normally masqueraded; nginx may see erp-edge's own address or the gateway of
   the umami `edge` bridge (`172.28.91.1`). Do not guess; measure with a held connection:
   ```bash
   docker exec -d erp-edge-traefik-1 sh -c '(printf "GET /__x HTTP/1.0\r\nHost: x\r\n\r\n"; sleep 12) | nc 172.17.0.1 18742'
   sleep 2; docker exec umami-edge-1 netstat -tn | grep ':8080'      # Foreign Address column = the source to trust
   ```
   Put that single address in `.env` as `ERP_EDGE_SOURCE=<addr>` (a single IP, never `172.16.0.0/12` or a whole
   bridge), then `docker compose up -d edge` (nginx re-renders its template on start) and
   `docker exec umami-edge-1 nginx -T 2>/dev/null | grep set_real_ip_from` must show exactly that one line.
   Compose refuses to start the edge while it is unset, so the first `up` in step 3 needs a provisional value:
   use `127.0.0.1` (trusts nothing real) until this measurement.
   If the measured address is the `edge` bridge's gateway, every container that reaches the published port from
   another bridge looks the same, so any such container could state a client address. The effect is limited to
   analytics attribution, and `ufw`/`DOCKER-USER` already restrict who may reach the port (step 5); do not widen it.
   Check again after anything that recreates either bridge.

## 7. Admin, users, website

Admin is never public. Open it over an SSH tunnel:

```bash
cd ~/umami && docker compose --profile admin up -d admin-gate
# on your laptop:  ssh -N -L 3000:127.0.0.1:13000 sumopod   -> http://localhost:3000
```

1. Log in as `admin` / `umami` (Umami's default) and **change the password immediately** (Settings -> Profile);
   enable two-factor if desired.
2. Add the website: name `gaiada.com`, domain `gaiada.com`. Copy its **website id** (UUID): the site's tracker tag
   and `search_properties.umami_site_id` need it.
3. Create a team (for example `gaiada`) and move the website into it.
4. **Read-only access for the ERP.** Umami's source has the role (`ROLES.teamViewOnly = 'team-view-only'`, and a
   system `view-only` role; both carry no permissions), so no read-only Postgres role is needed. Create a user
   `erp-reader` with the system role **View only**, add it to the team as **View only**.
5. Log in as `erp-reader` (private window), create an **API key** (Settings -> API keys; it is the same as
   `POST /api/me/api-keys`; the UI path is unverified). The key is `umami_...`, shown once. Self-hosted API keys
   are enabled (`isApiKeyEnabled()` is true unless `CLOUD_MODE`), are hashed in the database, and are refused for
   `/api/auth`, `/api/users`, `/api/admin` and `/api/2fa`.
6. Stop the gate: `docker compose --profile admin stop admin-gate`.

Where the key goes: the **orchestrator** sets two env vars for platform-nest through compose `environment:`
(never `.env` alone, never git): `UMAMI_BASE_URL=http://10.88.0.2:18743` and `UMAMI_API_KEY=<key>`. The ERP sends
`Authorization: Bearer <key>`. Start the read path only after decision 2:

```bash
cd ~/umami && docker compose --profile erp-read up -d read-gate
# from gda-aicenter:
curl -s -H "Authorization: Bearer $KEY" http://10.88.0.2:18743/api/websites | head -c 300     # lists gaiada.com only
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE -H "Authorization: Bearer $KEY" http://10.88.0.2:18743/api/websites/<id>   # 403/404, never 200
```

If wg0 is not up when Docker starts, the gate fails to bind; `docker compose --profile erp-read up -d read-gate`
again after wg0 is up.

## 8. Verify (all of these, with output, before calling it DEV-VERIFIED)

```bash
# 1. TLS + collector. Tracker script: 200, javascript. Exactly ONE Access-Control-Allow-Origin header.
curl -sSI https://insights.erp.gaiada.com/lib/kestrel.js | grep -i -E 'HTTP/|content-type|access-control|strict-transport'
curl -sSI -H 'Origin: https://gaiada.com' https://insights.erp.gaiada.com/lib/kestrel.js | grep -ic '^access-control-allow-origin'   # must print 1
curl -sSI -H 'Origin: https://evil.example' https://insights.erp.gaiada.com/lib/kestrel.js | grep -ic '^access-control-allow-origin'  # must print 0
# CORS preflight for the collector:
curl -si -X OPTIONS -H 'Origin: https://gaiada.com' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type,x-umami-cache' https://insights.erp.gaiada.com/lib/kestrel/e | head -12
# 2. Everything else is 404 publicly, including the admin UI, the default names and the read API (the advisory).
for p in / /login /dashboard /script.js /api/send /api/heartbeat /api/auth/login /api/websites /api/me /lib/kestrel.js/ /lib/kestrel; do
  printf '%-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://insights.erp.gaiada.com$p)"; done        # all 404
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-umami-share-token: x' -H 'x-umami-share-context: 1' https://insights.erp.gaiada.com/api/websites/<website-id>/stats    # 404
# 3. Listening sockets: only docker0 (and loopback / wg0 only while those profiles run). Never 0.0.0.0 / [::].
ss -ltnp | grep -E ':(18742|18743|13000)\b'
docker port umami-edge-1                                   # 8080/tcp -> 172.17.0.1:18742
# 4. No egress from the project. All of these must FAIL (timeout / unreachable / bad address):
docker exec umami-app-1 sh -c 'curl -sS -m 4 -o /dev/null https://1.1.1.1 || echo BLOCKED'
docker exec umami-db-1 sh -c 'wget -q -T 4 -O /dev/null http://1.1.1.1 || echo BLOCKED'
docker exec umami-edge-1 sh -c 'wget -q -T 4 -O /dev/null http://1.1.1.1 || echo BLOCKED'
docker exec umami-app-1 sh -c 'getent hosts example.com || echo NO-DNS'
sudo ~/umami/egress-guard.sh status
# 5. Hardening held.
docker inspect umami-app-1 umami-db-1 umami-edge-1 --format '{{.Name}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}} sec={{.HostConfig.SecurityOpt}} ro={{.HostConfig.ReadonlyRootfs}}'
docker stats --no-stream umami-app-1 umami-db-1 umami-edge-1
# 6. Geo + IP handling (MMDB compatibility check): send ONE test event for a public IP, read it back, delete it.
curl -s -X POST https://insights.erp.gaiada.com/lib/kestrel/e -H 'Content-Type: application/json' -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36' -H 'X-Forwarded-For: 8.8.8.8' -d '{"type":"event","payload":{"website":"<website-id>","url":"/umami-selftest","hostname":"gaiada.com","language":"en","screen":"1920x1080"}}'
docker exec umami-db-1 psql -U umami -d umami -c "select country, region, city from session order by created_at desc limit 1;"     # country should be US, not empty
docker exec umami-db-1 psql -U umami -d umami -c "delete from website_event where url_path='/umami-selftest';"
```

Step 6 needs care: erp-edge DISCARDS the `X-Forwarded-For` a client sends and uses the PROXY-protocol address, so the
stored country is the sender's own, not US. To exercise the MMDB with a known IP, send the same POST from inside
erp-edge's container (it is the trusted source), e.g.
`docker exec erp-edge-traefik-1 wget -q -O- --header='Content-Type: application/json' --header='X-Forwarded-For: 8.8.8.8' --post-data='<same JSON>' http://172.17.0.1:18742/lib/kestrel/e`.
The real-IP path from the internet is proven in `erp-edge-sumopod.md` step 7. A blank country means the
MMDB fields do not match what Umami reads: record it and stop, do not paper over it.
No raw IP is stored by Umami; also confirm none appears in logs: `docker compose logs --since 10m | grep -c '8\.8\.8\.8'` must be 0.

## 9. Timers

```bash
cd ~/umami
sudo cp systemd/umami-backup.* systemd/umami-retention.* systemd/umami-geo-refresh.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now umami-backup.timer umami-retention.timer umami-geo-refresh.timer
systemctl list-timers 'umami-*'
sudo systemctl start umami-retention.service && journalctl -u umami-retention -n 5 --no-pager   # one 'retention ok ...' line
```

* **Retention (WSK-D67):** `retention.sh` runs `retention.sql` weekly: deletes `event_data`, `session_data`,
  `heatmap_event`, `session_replay`, `revenue`, `website_event`, `session_link` older than 14 months, then
  sessions that are old and have no events. Table and column names are the `@@map`/`@map` names in Umami v3.4.0's
  `prisma/schema.prisma`, every one with a `created_at timestamptz`. Re-read the schema on every version bump.
* **Geo refresh:** monthly (5th, 04:20 UTC); downloads DB-IP Lite, swaps atomically, restarts `umami-app-1`.

## 10. Backup and the off-box copy

D66 rule: nothing on sumopod is the only copy. `backup.sh` (02:40 UTC) does
`pg_dump` -> verify (real tables, admin row present; a non-zero exit on an empty or table-less dump) ->
gzip -> `age` encrypt to the **same recipient as the ERP offsite set** (`~/erp-offsite/recipient.pub`; the private
key stays on the owner's laptop, see `erp-offsite-backup.md`) -> **push to gda-aicenter** `~/umami-backups/`.
Plaintext only ever exists in `/dev/shm`. Local copies are kept 7 days (and only once pushed); aicenter keeps
90 days plus 1st-of-month copies for 12 months.

Why a push and not the ERP's pull pattern: sumopod is the box that must not be the only holder, and aicenter
already has the encrypted-set discipline. The "no key from aicenter to sumopod" property of `erp-offsite-backup.md`
is untouched; sumopod gets a key to aicenter that can only **append** (forced command: new, hash-checked,
<= 300 MB files with a strict name; no read, list, overwrite or delete), so a compromised sumopod cannot damage
existing copies.

One-time setup:

```bash
# sumopod
ssh-keygen -t ed25519 -N '' -f ~/.ssh/umami_push_ed25519 -C umami-push@sumopod
cat ~/.ssh/umami_push_ed25519.pub
test -r ~/erp-offsite/recipient.pub && echo recipient-ok; command -v age
# gda-aicenter (as Hansel)
mkdir -p ~/bin ~/umami-backups && chmod 700 ~/umami-backups
# copy umami-backup-receive.sh to ~/bin/ and chmod +x, then ONE line in ~/.ssh/authorized_keys:
#   restrict,from="10.88.0.2",command="/home/Hansel/bin/umami-backup-receive.sh" ssh-ed25519 AAAA... umami-push@sumopod
# aicenter retention (cron, daily 05:10): 90 days, keep 1st-of-month copies 12 months
#   10 5 * * * find $HOME/umami-backups -maxdepth 1 -type f -name 'umami-*.sql.gz.age' \( -name 'umami-????????-*' \) -mtime +90 ! -name 'umami-??????01-*' -delete; find $HOME/umami-backups -maxdepth 1 -type f -name 'umami-??????01-*' -mtime +365 -delete
```

Prove the key is restricted (run after any `authorized_keys` change):

```bash
# from sumopod
ssh -i ~/.ssh/umami_push_ed25519 Hansel@10.88.0.1 'ls'                 # refused: only 'put <name> <sha256>'
ssh -i ~/.ssh/umami_push_ed25519 Hansel@10.88.0.1 'put ../x 00'        # refused: bad name
```

First run and check:

```bash
sudo systemctl start umami-backup.service && journalctl -u umami-backup -n 8 --no-pager   # 'dump ok', 'ok pushed=1'
ls -l ~/umami-backup/data/                        # .age, .sha256, .pushed
ssh Hansel@10.88.0.1 'ls -l ~/umami-backups/'     # the same file, same size (from an operator login)
cat /var/lib/node_exporter/textfile/umami_backup.prom
```

Alerting hook: `umami_backup_last_run_ok` and `umami_backup_last_success_timestamp_seconds` land in the node_exporter
textfile directory; add a stale rule beside `infra/observability/prometheus/rules/backup-offsite.yml` (not done here).

### Restore test (from the off-box copy; on the laptop, quarterly and once before go-live)

```bash
F=$(ssh gda-aicenter 'ls -1 ~/umami-backups/umami-*.age | tail -1')
scp gda-aicenter:"$F" . && B=$(basename "$F")
age -d -i ~/.ssh/gaiada-backup-age "$B" > umami.sql.gz            # 1. decrypts with the owner's key
gzip -t umami.sql.gz                                              # 2. valid gzip
docker run -d --name umami-restore -e POSTGRES_PASSWORD=t -e POSTGRES_DB=umami -e POSTGRES_USER=umami postgres:16.15-alpine
sleep 8
zcat umami.sql.gz | docker exec -i umami-restore psql -U umami -d umami -v ON_ERROR_STOP=1 -q
docker exec umami-restore psql -U umami -d umami -c "select (select count(*) from \"user\") users, (select count(*) from website) websites, (select count(*) from website_event) events;"   # matches the live counts (+ a day's drift)
docker rm -f umami-restore; shred -u umami.sql.gz 2>/dev/null || rm -f umami.sql.gz     # no plaintext left behind
```

Live restore (disaster): `docker compose stop app`, drop and recreate the `umami` database in the db container,
pipe the dump into `psql`, `docker compose start app`.

## 11. Rollback

* **Bad version:** put the previous `image:` line (tag + digest) back, `docker compose up -d app`. Umami migrates
  forward only; roll back across a migration by restoring the last backup into the old version.
* **Take it off the air at once:** remove the route from erp-edge (`rm ~/erp-edge/dynamic/erp-insights.yml`; the file
  watcher drops it within seconds; the status page is unaffected), Umami keeps running privately. Tracker calls fail silently in the browser.
* **Remove entirely:** `docker compose --profile admin --profile erp-read down` (add `-v` to delete the database
  volume: only after a verified off-box backup), `sudo systemctl disable --now umami-egress-guard umami-*.timer`,
  `sudo ufw delete allow from "$ERP_EDGE_SUBNET" to 172.17.0.1 port 18742 proto tcp`.
* A compose, nginx or env change that breaks the collector never affects any page: the tracker sends in the background.

## 12. Status page probe note

Another session runs `status.erp.gaiada.com` on sumopod. Hand it exactly one probe:
`GET https://insights.erp.gaiada.com/lib/kestrel.js` expecting HTTP 200 and a javascript content type. It exercises
DNS, mimi's passthrough, erp-edge's TLS, the edge and Umami in one request, and is inside the 20 req/s rate limit by a wide margin.
Do NOT probe the collector with a POST (it would create events), and do not look for a `/api/heartbeat` or a login
page: they are 404 publicly by design. Expect slow answers at times (sumopod load); alert on sustained failure,
not on a single slow probe.

## What was checked while writing (not a deployment)

* Pinned digests and tags were looked up live on 2026-10-11 (Umami 3.4.0, postgres 16.15-alpine, nginx-unprivileged 1.31.6-alpine).
* Env names were checked against Umami's environment-variable docs and the v3.4.0 source (`next.config.ts`,
  `scripts/update-tracker.js`, `src/lib/detect.ts`, `src/lib/constants.ts`, `src/lib/api-key.ts`, `prisma/schema.prisma`).
* `docker compose config` accepts the file (all profiles). The three nginx templates were rendered by the pinned
  image on a read-only root fs and passed `nginx -t`. Shell scripts pass `bash -n` / `sh -n`.
* `ERP_EDGE_SOURCE` renders into `set_real_ip_from` and passes `nginx -t` on the pinned image; compose refuses to start without it.
* NOT run: the compose project, erp-edge on a server (Traefik 3.3.7 did load the route file locally), CORS single-header behaviour through Traefik's
  `headers` middleware (the strip + cors middleware order is reasoned, Verify step 1 proves it), the DOCKER-USER
  rules, the mimi-bridge to docker0 path, `retention.sql` against a real Umami database (it was run against stub tables with the same names and columns, postgres 16.15: deleted old rows and orphan sessions, kept recent ones), the MMDB field fit.
