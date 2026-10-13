# Runbook — Umami on sumopod (M5-A3, WSK-D66) + the insights collector (M5-V2-c, section 13)

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
docker network ls -q | xargs docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep . | python3 -c 'import ipaddress,sys; n=ipaddress.ip_network("10.211.91.0/28"); o=[s for s in sys.stdin.read().split() if ipaddress.ip_network(s).overlaps(n)]; print("OVERLAPS: "+" ".join(o) if o else "10.211.91.0/28 free")'   # a /16 that COVERS it counts too (2026-10-12: gaiada-obs_default owns 172.28.0.0/16)
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

The caller of 172.17.0.1:18742 is now erp-edge's bridge (`10.211.92.0/28`), not mimi's. Allow exactly that:

```bash
ERP_EDGE_SUBNET=10.211.92.0/28
sudo ufw allow from "$ERP_EDGE_SUBNET" to 172.17.0.1 port 18742 proto tcp comment 'umami edge from erp-edge'
docker exec erp-edge-traefik-1 wget -q -T 3 -O /dev/null http://172.17.0.1:18742/lib/kestrel.js && echo reachable
```

If that is refused although ufw allows it, Docker's inter-bridge isolation is dropping the DNAT'd packet
(erp-edge bridge -> umami `edge` bridge). Fix without opening anything wider:
`sudo iptables -I DOCKER-USER -s "$ERP_EDGE_SUBNET" -d 10.211.91.0/28 -p tcp --dport 8080 -j ACCEPT` placed ABOVE the
egress-guard drop (that drop only matches `-s 10.211.91.0/28`, so order does not matter), then add it to
`egress-guard.sh`. Record which was needed.

## 6. DNS, the erp-edge route and the trusted source (after erp-edge is running)

1. DNS (D61): `insights.erp.gaiada.com` CNAME `sumopod.erp.gaiada.com`. Confirm: `dig +short insights.erp.gaiada.com`.
2. The route is `infra/sumopod/erp-edge/dynamic/erp-insights.yml` (it replaces the old mimi-directory template).
   Its two `Path(...)` values must equal `TRACKER_SCRIPT_NAME` and `COLLECT_API_ENDPOINT` in `.env`; add the
   staging origins (decision 3). It is installed with the rest of `erp-edge/` (`erp-edge-sumopod.md` step 4);
   nothing is copied into mimi's directory for Umami.
3. **Which source does the edge see (sets `ERP_EDGE_SOURCE`).** erp-edge reaches `172.17.0.1:18742` through the
   host, so the packet is DNAT'd and normally masqueraded; nginx may see erp-edge's own address or the gateway of
   the umami `edge` bridge (`10.211.91.1`). Do not guess; measure with a held connection:
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
* **Geo refresh:** monthly (5th, 04:20 UTC); downloads DB-IP Lite **City and ASN**, each checked and swapped atomically, restarts
  `umami-app-1` and (when running) `umami-collector-1`. The ASN file is `geo/dbip-asn-lite.mmdb` (M5-V2-c, section 13).

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
#   10 5 * * * find $HOME/umami-backups -maxdepth 1 -type f \( -name 'umami-????????-*' -o -name 'vdb-????????-*' \) -mtime +90 ! -name '*-??????01-*' -delete; find $HOME/umami-backups -maxdepth 1 -type f \( -name 'umami-??????01-*' -o -name 'vdb-??????01-*' \) -mtime +365 -delete
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

**M5-V2-c:** the same run also dumps the collector's `vdb` (`vdb-<stamp>.sql.gz.age`) with the DATA of `consented_events`,
`replay_sessions` and `replay_chunks` excluded (design O2: deliberately not backed up, so the backup holds hashes and aggregates
only). The receiver on aicenter must be the NEW `umami-backup-receive.sh` (it accepts `vdb-` names too) and the cron line above
the new one BEFORE the first backup that includes vdb; otherwise the vdb push is refused and the run exits non-zero (section 13, C4).

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

## 13. The insights collector (M5-V2-c) — status: PLANNED, artifacts written, nothing deployed

Design of record: `docs/plans/2026-10-12-m5-phase5-design.md` section 3. The collector (`insights-collector/`, Go, distroless) sits
between the `edge` and Umami on the collect path; `vdb` is its own Postgres. Both are on `internal` only (no egress by
construction; `egress-guard.sh` is unchanged); nothing new is published.

```
edge nginx --/lib/kestrel/e (X-Real-IP)--> collector :8080 --fd.. pseudonym + cf-* geo headers--> app (Umami)      collector --> vdb
edge nginx --/lib/kestrel.js-------------------------------------------------------------------> app (Umami)
```

What changed in `infra/sumopod/umami/`: `docker-compose.yml` (`vdb`, `collector`, `vdb-data` volume; the edge waits for the collector
only softly, `required: false`), `nginx/edge.conf.template` (collect location -> `${EDGE_COLLECT_UPSTREAM}`, resolved per request;
`/lib/kestrel/v`, `/f`, `/r` templated and commented out; V3-c (C7) enables `/v` and `/f`, `/r` stays off until V6-a), `geo-refresh.sh` (ASN Lite + collector restart),
`backup.sh` and `umami-backup-receive.sh` (vdb), `.env.example`, and `check-config.sh` (the static gate).
`read-gate` is NOT changed here: its `/ops/v1/` routes (and the forget `POST`) are V3-c (C7).

### C0. Preflight (before anything is copied)

The step-0 checks above still apply, plus:

```bash
free -m          # the collector and vdb add ~450 MiB of limits: need >= 2 GiB "available" in total
df -h / /var/lib/docker   # V6 replay needs >= 25 GB free later; today only measure and record it (81% used when last measured)
docker network inspect umami_internal >/dev/null 2>&1 && echo "project exists (upgrade)" || echo "first install"
```

Confirm the release CI produced a signed image for this component (V2-b) and note its tag and digest.

### C1. Verify the signed image, then pin it (never build on a host)

```bash
OWNER=hansel-gaiada; TAG=<release tag, e.g. 1.0.0-alpha.NNN>        # from the V2-b release run
IMG=ghcr.io/$OWNER/gaiada-insights-collector:$TAG
cosign verify "$IMG" \
  --certificate-identity-regexp "https://github.com/$OWNER/.+/.github/workflows/release.yml@.+" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com      # exactly the verify in the header of .github/workflows/release.yml
docker buildx imagetools inspect "$IMG" | grep -m1 '^Digest:'               # sha256:... = the pin
```

Edit `docker-compose.yml`: replace the collector's `image:` line (the `0.0.0-PLACEHOLDER` tag AND the all-zero digest) with
`ghcr.io/<owner>/gaiada-insights-collector:<tag>@sha256:<digest>` and commit that change on a branch (it is how the pin reaches the repo).
A failing `cosign verify` is a stop, not a warning. (Private package: `docker login ghcr.io` first.)

### C2. Keys and `.env`

```bash
cd ~/umami
# The ERP READ key: shown ONCE; the orchestrator puts it in platform-nest (INSIGHTS_READ_KEY). The collector keeps only the hash.
K=$(openssl rand -hex 32); printf '%s' "$K" | sha256sum | cut -d' ' -f1      # hash -> OPS_READ_KEY_SHA256 in .env
# The FORGET key (M5-V3-b; REQUIRED, the collector refuses to start without it or with the read key's hash): same recipe,
# a DIFFERENT key; the orchestrator puts it in platform-nest (the forget key variable V3-c names); hash -> OPS_FORGET_KEY_SHA256
F=$(openssl rand -hex 32); printf '%s' "$F" | sha256sum | cut -d' ' -f1      # hash -> OPS_FORGET_KEY_SHA256 in .env
openssl rand -hex 32                                                          # -> VDB_PASSWORD (hex, URL-safe)
```

Fill `.env`: `VDB_PASSWORD`, `OPS_READ_KEY_SHA256`, `OPS_FORGET_KEY_SHA256`, `INSIGHTS_WEBSITES` (a well-formed placeholder UUID until the website exists, section 7),
and `COLLECTOR_GEO_REQUIRED=1`. Leave `UMAMI_SKIP_LOCATION_HEADERS` and `COLLECTOR_FORWARD_IP_MODE` unset (defaults: Umami ignores
location headers; the collector pseudonymises). Set `COLLECTOR_CONSENT_EVENT_NAMES` to the site's event list (V3-j) before the
consented channel is routed (V3-c). Keys never go in git, a ticket, a log or chat; hand `$K` and `$F` to the orchestrator only.
Rotate a key: new key, new hash in `.env`, `docker compose up -d collector`, then the new key in platform-nest.

### C3. Static gate (changes nothing)

```bash
cd ~/umami && ./check-config.sh               # all PASS; the collector pin WARNs until C1 is done
./check-config.sh --deploy                    # all PASS with NO placeholder: required before `up`
```

It runs `docker compose config -q` for every profile, checks pins, networks and the collector's `environment:` list, and renders all three
nginx templates in the pinned image under `nginx -t` (and the rollback rendering). Dummy values only; it reads no `.env`.

### C4. First deploy of the collector

Order matters: geo files first (the collector is `GEO_REQUIRED`), the backup receiver and cron before the first vdb backup.

```bash
cd ~/umami
./geo-refresh.sh && ls -l geo/                # dbip-city-lite.mmdb, dbip-asn-lite.mmdb, VERSION, VERSION-asn (record the ASN size: the floor is a guess)
docker compose config -q && docker compose pull collector vdb
docker compose up -d vdb collector            # does not touch app/db/edge; the collector waits for vdb + app healthy
docker compose ps                             # vdb, collector: healthy
docker compose logs --tail 20 collector       # migrations applied, geo ok (not degraded); no address, key or password anywhere
docker exec umami-edge-1 wget -q -T 3 -O- http://127.0.0.1:8080/__ping_collector     # the collector's /healthz via the edge, loopback only
docker compose up -d edge                     # re-renders the template: the collect path now goes to the collector
docker exec umami-edge-1 nginx -T 2>/dev/null | grep -E 'collect_upstream|resolver'
```

Then the backup path: on aicenter copy the new `umami-backup-receive.sh` to `~/bin/` and replace the cron line (section 10); on sumopod
`sudo systemctl start umami-backup.service` and expect `dump ok ...umami-...`, `dump ok ...vdb-...`, `ok pushed=2`. The geo timer unit is
unchanged (the script now refreshes both editions and restarts both containers).

### C5. The proof steps V2-d runs (in a throwaway project, never the live `umami` one; V2-e repeats 1 to 4 live)

Send the agreed public test IP (V2-d names it) through the edge exactly as section 8 step 6 does (from inside erp-edge's container, the trusted source).

1. **Country stored.** `docker exec umami-db-1 psql -U umami -d umami -c "select country, region, city from session order by created_at desc limit 1;"`
   shows the test IP's country (region and city if DB-IP has them). Empty means Umami ignored the headers (`UMAMI_SKIP_LOCATION_HEADERS` still 1) or the
   MMDB fields do not match; record which. To let Umami read the collector's headers set `UMAMI_SKIP_LOCATION_HEADERS=` (EMPTY, not 0) in `.env`,
   `docker compose up -d app`, resend. Also record whether a non-ASCII city (percent-encoded by the collector) is stored decoded
   (`insights-collector/CLAUDE.md`, open items).
2. **The test IP appears 0 times** in a dump of both databases and in every log. All of these must print 0; anything else is a stop:
   ```bash
   docker exec umami-db-1 pg_dump -U umami -d umami | grep -c '<test-ip>'
   docker exec umami-vdb-1 pg_dump -U vdb -d vdb | grep -c '<test-ip>'
   docker compose logs --no-color | grep -c '<test-ip>'
   docker logs umami-edge-1 2>&1 | grep -c '<test-ip>'
   ```
3. **The pseudonym is accepted, or the fallback is recorded.** The event must be stored (a `website_event` row for the test URL) and the session stable
   for the day. If Umami 3.4.0 rejects or mishandles the `fd..` address: `COLLECTOR_FORWARD_IP_MODE=real` (the D2 fallback; the real address crosses
   `internal` to Umami, never logged or stored by the collector; it logs a warning at start), `docker compose up -d collector`, and RECORD the decision.
4. **A public `cf-ipcountry` does not land:** send one with `cf-ipcountry: XX` to the public path; the stored country must not be `XX`.
5. **Bots are dropped and counted:** one hit with a bot user-agent answers `{"beep":"boop"}`, adds no `website_event`, and
   `docker exec umami-vdb-1 psql -U vdb -d vdb -c "select * from bot_counts"` shows a row. `identify` and an unknown website id: 400 and 403.
6. **Every other path still 404s** publicly (section 8 step 2 list, plus `/lib/kestrel/r`, `/ops/v1/bots`, `/healthz`, `/__ping_collector`; `/lib/kestrel/v` and `/f` 404 only until V3-c, C7, routes them).
7. **The vdb backup holds no personal data:** after `backup.sh`, decrypt on the laptop (restore test, section 10) and
   `zcat | grep -E '^COPY public\.(consented_events|replay_)'` prints nothing.

**V2-d results (sumopod, 2026-10-13, throwaway project `umami-proof`: own name, subnet 10.211.93.0/28, port 18762).**

- **The proof copy needs three edits.** The pinned `name:` and the fixed edge subnet would collide with the live project.
  - Set `name: umami-proof`, a free /28 and `UMAMI_PUBLISH_PORT`.
  - **Never run `geo-refresh.sh` from a proof copy:** it restarts the LIVE `umami-app-1` and `umami-collector-1` by name. Copy the City file and fetch ASN Lite by hand.
  - `ERP_EDGE_SOURCE` = the proof edge network's gateway (`10.211.93.1`) when sending from the host to `172.17.0.1:<port>`.
- **Image:**
  - `ghcr.io/hansel-gaiada/gaiada-insights-collector:v1.0.0-alpha.367@sha256:180352ee6fa575eb2566329b97111e4cfcbb803d07a0151dde1251aee9143663`.
  - Provenance verified with `gh attestation verify oci://…@sha256:… --owner hansel-gaiada`: SLSA v1, `release.yml` at the 367 tag. sumopod has no `cosign`; this check runs from a workstation.
  - It reports `version: dev`, because the release build does not set the version.
- **`check-config.sh` on an unmodified copy:** ALL PASS. The only WARN is the placeholder pin.
- **DB-IP ASN Lite 2026-10 is 9,566,363 bytes,** so the 2 MB floor holds.
- **Step 2:** the test IPs (81.2.69.142 and 8.8.4.4) appear 0 times in both dumps and in every log.
- **Step 5:** a bot user agent was dropped and counted (`bot_counts: ua 1`). A datacenter address (52.95.110.1, Amazon) was dropped as `bot_asn`, which also proves the forwarded address reaches the collector.
- **Steps 1 and 3 FAILED with the fd00::/8 pseudonym:**
  - The events were stored, but with NO country, region or city.
  - The cause: Umami 3.4.0's `getLocation` runs `is-localhost-ip` on the client address before reading any header, and that package treats fc00::/7 as local.
  - A direct test into the app showed it plainly: `fd12:…` with `cf-ipcountry: GB` stored nothing, while `2001:db8:…` with the same headers stored GB / GB-ENG / London.
  - **Fix:** the pseudonym moved to 2001:db8::/32 (insights-collector 0.3.1). This is NOT the `FORWARD_IP_MODE=real` fallback: Umami still never sees an IP.
- **Step 4** (spoofed `cf-ipcountry: XX`) was inconclusive, because no location was stored at all.
- **Re-proof with 368's image, PASSED (2026-10-13).** The image is `…:v1.0.0-alpha.368@sha256:66219e94b1674a607742952bd33efc1cb1f0abdc8de2748383be77701c80c81e`, insights-collector 0.3.1, provenance verified.
  - Step 1: through the edge and the collector, 81.2.69.142 stored GB / GB-England / London.
  - Step 3: the 2001:db8 pseudonym is accepted, and the event is stored with its location.
  - Step 4: 8.8.4.4 sent with `cf-ipcountry: XX` / `cf-ipcity: Spoofville` stored US / California / Mountain View, and "XX" / "Spoofville" appear 0 times in the Umami dump.
  - Step 2 again: both IPs appear 0 times in both dumps and every log.
  - Step 6: every public path is 404 (`/lib/kestrel/r` while replay is off, `/ops/v1/*`, `/healthz`, `/api/*`, `/login`, `/`), and the loopback pings are 403.
  - Step 7: a vdb dump with `backup.sh`'s exclusions has the five schemas and data only for `bot_counts` and `tombstones`, with 0 COPY blocks for the personal tables. The off-box push was not exercised in the proof.
  - The proof project, its volumes and the 367 image were removed, and the live `umami` project was untouched.
  - V2-e (live) waits for G2 and O-11.

### C6. Rollback (collector out of the path; Umami collects directly)

```bash
cd ~/umami
# .env: EDGE_COLLECT_UPSTREAM=app:3000   and   UMAMI_SKIP_LOCATION_HEADERS=1 (or delete the line)
docker compose up -d edge app
docker exec umami-edge-1 nginx -T 2>/dev/null | grep collect_upstream          # "app:3000"
curl -si -X OPTIONS http://172.17.0.1:18742/lib/kestrel/e | head -3            # the collect path answers again (Umami direct)
docker compose stop collector                                                  # optional: frees its 192 MiB; vdb can stay
```

The edge does not need the collector to start (`required: false`, resolved per request), so this works with the collector crashed.
Rehearse it once before the first live cutover (V2-e). A bad collector image: re-pin the previous `image:` (tag and digest) and
`docker compose up -d collector`. Remove entirely: `docker compose rm -sf collector vdb`; delete `vdb-data` only after a verified off-box vdb dump.
Backups outlive deletions: the vdb dump holds hashes and aggregates only; after any restore, tombstones must be re-applied before ingest resumes (V3-e).

### C7. The consented channel's routes and keys (M5-V3-c) — status: PLANNED, artifacts written, nothing deployed

What it adds (design `docs/plans/2026-10-12-m5-phase5-design.md` 4.4):

```
public:  site --https--> erp-edge Traefik (erp-insights-consented: Path /lib/kestrel/v | /lib/kestrel/f) --> edge nginx --> collector :8080
ops:     platform-nest (gda-aicenter) --wg--> read-gate 10.88.0.2:18743 --/ops/v1/events|bots (GET), /ops/v1/forget (POST)--> collector :8081
```

- `infra/sumopod/erp-edge/dynamic/erp-insights.yml`: a second router `erp-insights-consented`, exactly two paths, the same middlewares as the
  collect router (CORS to the site origins, 20 req/s per address, 32 KB body cap in Traefik; nginx caps `/v` at 16 KB and `/f` at 2 KB).
- `nginx/edge.conf.template`: `/lib/kestrel/v` and `/f` enabled (exact path, POST and OPTIONS only, collector `8080`). `/r` stays off (V6-a).
- `nginx/read.conf.template` (profile `erp-read`): `GET /ops/v1/events`, `GET /ops/v1/bots`, `POST /ops/v1/forget` to `collector:8081`, resolved
  per request. The `Authorization` header passes through; the collector decides 401 (no or unknown key) and 403 (the wrong key for the route: the
  read key on forget, the forget key on events). Any other method (a `DELETE`) is 403 at the gate; any other path 404. The ops API is not on the
  public edge, so publicly `/ops/v1/*` is 404.
- platform-nest env (`infra/compose/`): `INSIGHTS_BASE_URL` (`http://10.88.0.2:18743`), `INSIGHTS_READ_KEY`, `INSIGHTS_FORGET_KEY`,
  `SEARCH_VISITORS_ENABLED` (exactly `1` turns the feature on). The two keys are the ones whose hashes C2 put in the collector's `.env`.

**Deploy order** (each step starts only when the previous one is verified):

1. Collector first. It already runs with `OPS_FORGET_KEY_SHA256` set (V3-b, C2); check `docker compose ps` (collector healthy) and that
   `COLLECTOR_CONSENT_EVENT_NAMES` is set in `.env` (V3-j's list).
2. sumopod: edge and read-gate (template changes); static gate first:
   ```bash
   # ~/umami is a COPY, not a checkout: ship the new files from a workstation first (the section 1 recipe), e.g.
   #   git -c core.autocrlf=false archive origin/main infra/sumopod/umami | ssh sumopod 'tar -x --strip-components=3 -C ~/umami'
   # (keeps .env, geo/ and data untracked by git), then on sumopod:
   cd ~/umami && chmod +x *.sh && ./check-config.sh --deploy             # ALL PASS (renders and nginx -t the /v, /f and /ops/v1 locations)
   docker compose up -d edge
   docker compose --profile erp-read up -d read-gate                      # recreates it with the new template (it only serves the ERP)
   docker exec umami-edge-1 nginx -T 2>/dev/null | grep -E 'location = /lib/kestrel/(v|f)'
   docker exec umami-read-gate-1 nginx -T 2>/dev/null | grep -E 'location = /ops/v1'
   ```
3. sumopod: the erp-edge router (Traefik watches `dynamic/`, no restart):
   ```bash
   # ~/erp-edge is a COPY too: ship infra/sumopod/erp-edge/dynamic/erp-insights.yml the same way (git archive, never a CRLF copy), then:
   cd ~/erp-edge && ls dynamic/ && docker logs --since 1m erp-edge-traefik-1 2>&1 | grep -i -E 'erp-insights|error' | tail
   ```
4. aicenter: put the two keys in files the checks read (once; type or paste at the prompt, never on a command line, never into a ticket):
   ```bash
   umask 077; mkdir -p ~/.insights-keys
   read -rs -p 'read key: ' RK; echo; printf 'Authorization: Bearer %s\n' "$RK" > ~/.insights-keys/read.hdr; unset RK
   read -rs -p 'forget key: ' FK; echo; printf 'Authorization: Bearer %s\n' "$FK" > ~/.insights-keys/forget.hdr; unset FK
   ```
   The same two values go into platform-nest's `.env` (`INSIGHTS_READ_KEY`, `INSIGHTS_FORGET_KEY`) for the ERP deploy; never into git.

**Post-deploy checks** (from `gda-aicenter`; `-H @file` makes curl read the header from the file, so no key is on a command line or in `ps`):

```bash
RG=http://10.88.0.2:18743; PUB=https://insights.erp.gaiada.com; H=~/.insights-keys
WEB=<the Umami website id from INSIGHTS_WEBSITES>
Z=00000000-0000-0000-0000-000000000000
# 1. the read key lists events and bots: 200
curl -s -o /dev/null -w 'read key, events:    %{http_code} (200)\n' -H @$H/read.hdr "$RG/ops/v1/events?website=$WEB&limit=1"
curl -s -o /dev/null -w 'read key, bots:      %{http_code} (200)\n' -H @$H/read.hdr "$RG/ops/v1/bots"
# 2. the read key on forget is refused: 403 (the body is valid, so this tests the key, not validation)
curl -s -o /dev/null -w 'read key, forget:    %{http_code} (403)\n' -X POST -H @$H/read.hdr -H 'Content-Type: application/json' \
  -d "{\"website\":\"$WEB\",\"visitorIds\":[\"$Z\"],\"consentIds\":[],\"mode\":\"withdraw\"}" "$RG/ops/v1/forget"
# 3. the forget key on events is refused: 403
curl -s -o /dev/null -w 'forget key, events:  %{http_code} (403)\n' -H @$H/forget.hdr "$RG/ops/v1/events?website=$WEB&limit=1"
# 4. no key: 401
curl -s -o /dev/null -w 'no key, events:      %{http_code} (401)\n' "$RG/ops/v1/events?website=$WEB&limit=1"
curl -s -o /dev/null -w 'no key, forget:      %{http_code} (401)\n' -X POST -H 'Content-Type: application/json' -d '{}' "$RG/ops/v1/forget"
# 5. other methods and paths are refused at the gate, never 2xx
curl -s -o /dev/null -w 'DELETE events:       %{http_code} (403)\n' -X DELETE -H @$H/read.hdr "$RG/ops/v1/events?website=$WEB"
curl -s -o /dev/null -w 'DELETE forget:       %{http_code} (403)\n' -X DELETE -H @$H/forget.hdr "$RG/ops/v1/forget"
curl -s -o /dev/null -w 'GET forget:          %{http_code} (403)\n' -H @$H/forget.hdr "$RG/ops/v1/forget"
curl -s -o /dev/null -w 'POST events:         %{http_code} (403)\n' -X POST -H @$H/read.hdr "$RG/ops/v1/events"
curl -s -o /dev/null -w 'other ops path:      %{http_code} (404)\n' -H @$H/read.hdr "$RG/ops/v1/other"
curl -s -o /dev/null -w 'healthz via gate:    %{http_code} (404)\n' "$RG/healthz"
# 6. the ops API is not public: 404, with and without a key
curl -s -o /dev/null -w 'public events:       %{http_code} (404)\n' -H @$H/read.hdr "$PUB/ops/v1/events?website=$WEB"
curl -s -o /dev/null -w 'public forget:       %{http_code} (404)\n' -X POST -H @$H/forget.hdr "$PUB/ops/v1/forget"
# 7. the public consented channel is routed and validates: a /v body without a consentId is 400 (not 404, not 5xx)
curl -s -o /dev/null -w 'public /v no consent: %{http_code} (400)\n' -X POST -H 'Content-Type: text/plain' \
  -d "{\"website\":\"$WEB\",\"visitorId\":\"$Z\",\"events\":[]}" "$PUB/lib/kestrel/v"
# 8. /f is routed and answers 204 for a well-formed body; GET on /v is not served; /r is off; the 16 KB cap holds
curl -s -o /dev/null -w 'public /f:           %{http_code} (204)\n' -X POST -H 'Content-Type: text/plain' \
  -d "{\"website\":\"$WEB\",\"visitorId\":\"$Z\",\"consentId\":\"00000000-0000-0000-0000-000000000001\"}" "$PUB/lib/kestrel/f"
curl -s -o /dev/null -w 'GET /v:              %{http_code} (403 or 404, never 2xx)\n' "$PUB/lib/kestrel/v"
curl -s -o /dev/null -w 'public /r:           %{http_code} (404)\n' -X POST -d '{}' "$PUB/lib/kestrel/r"
head -c 20000 /dev/zero | tr '\0' a | curl -s -o /dev/null -w '/v over 16 KB:       %{http_code} (413)\n' -X POST -H 'Content-Type: text/plain' --data-binary @- "$PUB/lib/kestrel/v"
```

Then on sumopod: `docker compose logs --since 10m collector edge read-gate | grep -c -i -E 'bearer|authorization'` must print 0.
Record the output in the ticket; the expected code is in each parenthesis. A `502` on an `/ops/v1` check means the collector is down or
`read-gate` was not recreated; a `404` on `/lib/kestrel/v` means the edge was not recreated or the Traefik router did not load (step 3 logs).
Note: the `/v` and `/f` bodies in checks 7 and 8 use the all-zero visitor id, which is a real (if unused) visitor to the collector: run
`/f` once more with the forget key through `/ops/v1/forget` if a row appears (`events` with `visitorId=$Z`).

**Rollback** (the consented channel only; the collect path and the Umami read path are untouched):

1. erp-edge: delete the `erp-insights-consented` router from `dynamic/erp-insights.yml` (or `git revert` the V3-c commit and pull);
   Traefik reloads on its own. Check: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://insights.erp.gaiada.com/lib/kestrel/v` prints 404.
2. umami: comment the two `location = /lib/kestrel/(v|f)` blocks in `nginx/edge.conf.template` and the three `location = /ops/v1/...` blocks
   in `nginx/read.conf.template` (or `git revert`), then `cd ~/umami && docker compose up -d edge && docker compose --profile erp-read up -d read-gate`.
   Run `./check-config.sh` after commenting: it will FAIL the V3-c render checks, which is the expected signal that the channel is off.

The ERP side degrades on its own: with `SEARCH_VISITORS_ENABLED` empty the visitor feature is off, and an empty `INSIGHTS_BASE_URL`
reads as "not configured". Withdrawals and erasures that failed while the forget route was down stay queued in the ERP (V3-e) and are retried.

### C8. The ERP half of V3-k against a real collector (rerunnable proof)

`platform-nest/src/modules/search/visitor-collector.e2e.db.test.ts` drives the ERP's real visitor jobs against a real collector. It covers ingest, the withdrawal sweep, and the V3-h erase by email. It skips unless `INSIGHTS_E2E=1` and its env are set, so normal CI never runs it.

**To rerun on sumopod (no host ports, nothing live touched):**
1. **Bring up a throwaway copy of this project** (the V2-d recipe in C5): its own `name:`, a free /28, its own port, a signed collector image, and an `.env` with fresh keys. Write `.read-key`, `.forget-key` and `.website` (the `INSIGHTS_WEBSITES` uuid) as 0600 files, then `docker compose up -d`.
2. **Run the gate:** `bash infra/sumopod/umami/qa/gate-v3k.sh <id> <patch> <base-sha> src/modules/search/visitor-collector.e2e.db.test.ts`, from a copy on the box, with the copy's directory in `QA=`.
   - It clones the public repo at `<base-sha>` and applies `<patch>`.
   - It starts throwaway postgres, redis and cerbos.
   - It attaches the node test container to the collector's `internal` network.
3. **Tear down** the copy with `docker compose down -v` and remove its directory.

**First run, 2026-10-13: 4/4 PASSED** against the 368 collector, in 68 s:
- a consented visitor becomes a profile;
- a forged consent leaves no profile, and the collector forgets it;
- a withdrawal clears the profile through the sweep;
- an erase by email reports the collector forget as `delivered`.
