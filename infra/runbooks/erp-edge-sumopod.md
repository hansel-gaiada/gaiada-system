# Runbook — erp-edge on sumopod (M5-A3b, WSK-D71)

**Status: PLANNED.** Artifacts are written and statically checked (see "What was checked") but nothing has run on a
server. The orchestrator performs every step; nothing is automated from CI.

Artifacts: `infra/sumopod/erp-edge/` (copied to `/home/ubuntu/erp-edge/` on the server) and the one template for
mimi, `infra/sumopod/erp-edge/mimi/erp-passthrough.yml`. Umami's side is `infra/runbooks/umami-sumopod.md`.

## Design, in one screen

```
visitor -> mimi-tls-le :443 --(TCP passthrough: SNI = <one label>.erp.gaiada.com, PROXY v2)--> 172.17.0.1:18443
        -> erp-edge Traefik (:8443 in the container; TLS ends here; certificates by TLS-ALPN-01)
             status.erp.gaiada.com   -> 172.17.0.1:18480  (status page, another session's compose project)
             insights.erp.gaiada.com -> 172.17.0.1:18742  (Umami edge; exactly two paths, the rest 404)
```

* mimi gets **one** file and nothing else changes in it. Later ERP names add a file to `erp-edge/dynamic/` only.
* erp-edge never joins mimi's network, has no docker.sock and no Docker provider, no dashboard and no API. It is
  published only on `172.17.0.1:18443` (Docker's DNAT runs before ufw: never `0.0.0.0`).
* PROXY protocol is trusted ONLY from the single address mimi's connections arrive from (measured in step 3, never
  a range). The client address then lands in `X-Forwarded-For`/`X-Real-Ip` for the services; anything the visitor
  sent in those headers is discarded.
* The access log drops client address, host and port and all headers, and Traefik logs the path without the
  query string. Do not turn those fields back on: a visitor log is personal data.
* Hardening: `cap_drop: ALL`, `no-new-privileges`, read-only root fs + tmpfs `/tmp`, 0.5 cpu / 256 MiB / 128 pids.
  Verified locally that Traefik 3.3.7 starts under exactly these flags with the config as shipped.
* Subnets: erp-edge `10.211.92.0/28` (pinned), Umami `10.211.91.0/28`.

## 0. Preflight (measure first; sumopod runs every session's test gates)

```bash
ssh sumopod
uptime                                   # record load1; if > 14 on 4 cores, wait or pick another hour
free -m; df -h / /var/lib/docker         # >= 400 MiB available, >= 5 GB free
ss -ltnH | awk '{print $4}' | grep -E ':(18443|18480|18742)$'      # 18480 and 18742 must be the ONLY hits (status page; Umami edge once up). 18443 must be free.
docker network ls -q | xargs docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep . | python3 -c 'import ipaddress,sys; n=ipaddress.ip_network("10.211.92.0/28"); o=[s for s in sys.stdin.read().split() if ipaddress.ip_network(s).overlaps(n)]; print("OVERLAPS: "+" ".join(o) if o else "10.211.92.0/28 free")'   # a /16 that COVERS it counts too (2026-10-12: gaiada-obs_default owns 172.28.0.0/16)
ip -4 addr show docker0 | grep 172.17.0.1
docker inspect mimi-tls-le --format '{{.Config.Image}}  {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{$v.IPAddress}} gw={{$v.Gateway}}{{end}}'
docker exec mimi-tls-le traefik version | head -3                    # expect 3.3.x (passthrough + proxyProtocol syntax below is v3)
docker inspect mimi-tls-le --format '{{range .Args}}{{println .}}{{end}}' | grep -E 'entrypoints|providers.file|certificatesresolvers'
MIMI_DYN=/home/ubuntu/mimi/infrastructure/tls/dynamic
ls -la "$MIMI_DYN"; test -w "$MIMI_DYN" && echo "dir writable by $(id -un)"
# 1) Back up the live status route. 2) Find mimi's OWN site name(s) (the sslip.io host) for the check in step 7.
mkdir -p ~/erp-edge/backup && cp -p "$MIMI_DYN/erp-status.yml" ~/erp-edge/backup/erp-status.yml.preflight && cat "$MIMI_DYN/erp-status.yml"
grep -rhoE 'Host(SNI)?\(`[^`]+`\)' "$MIMI_DYN" | sort -u               # note the sslip.io host: MIMI_HOST=<it>
# Any existing mimi router on a *.erp.gaiada.com name other than erp-status? List them: they would stop being served by mimi at cut-over.
grep -rn 'erp\.gaiada\.com' "$MIMI_DYN" | grep -v '^.*erp-status.yml'
# Certificate serial the status page presents TODAY (mimi's), to prove it changes after the cut-over:
echo | openssl s_client -connect status.erp.gaiada.com:443 -servername status.erp.gaiada.com 2>/dev/null | openssl x509 -noout -serial -issuer -enddate | tee ~/erp-edge/backup/status-cert-before.txt
curl -s -o /dev/null -w 'status before: %{http_code}\n' https://status.erp.gaiada.com/
MIMI_HOST=<sslip.io host from above>; curl -s -o /dev/null -w 'mimi site before: %{http_code}\n' "https://$MIMI_HOST/"
# DNS: status and insights must already resolve to sumopod (insights CNAME per umami-sumopod.md step 6.1).
dig +short status.erp.gaiada.com insights.erp.gaiada.com
```

Stop and report if: 18443 is taken, the subnet is used, mimi's Traefik is not v3, an unexpected
`*.erp.gaiada.com` router exists in mimi's dir, or the directory is not writable.

## 1. Install files

```bash
mkdir -p ~/erp-edge && cd ~/erp-edge
# copy infra/sumopod/erp-edge/ here (git -c core.autocrlf=false archive, scp or rsync); keep ./backup
chmod +x render-config.sh
cp .env.example .env && chmod 600 .env        # set ACME_EMAIL (a role mailbox)
ls dynamic/                                    # erp-insights.yml, erp-status.yml, README.md
```

Set the staging origins in `dynamic/erp-insights.yml` first if the site's staging host must call the collector.

## 2. Reachability prerequisites (root; after the first start in step 3 if you prefer to see a failure first)

The status page and Umami edge are reached from erp-edge's bridge (`10.211.92.0/28`) and erp-edge from mimi's. Allow
exactly those, nothing wider (these mirror `umami-sumopod.md` step 5):

```bash
ERP_EDGE_SUBNET=10.211.92.0/28
MIMI_SUBNET=<mimi network subnet from preflight>
sudo ufw allow from "$MIMI_SUBNET" to 172.17.0.1 port 18443 proto tcp comment 'erp-edge from mimi passthrough'
sudo ufw allow from "$ERP_EDGE_SUBNET" to 172.17.0.1 port 18480 proto tcp comment 'status page from erp-edge'
sudo ufw allow from "$ERP_EDGE_SUBNET" to 172.17.0.1 port 18742 proto tcp comment 'umami edge from erp-edge'
```

If a hop is refused although ufw allows it, Docker's inter-bridge isolation is dropping it: add the matching
`DOCKER-USER` ACCEPT (`-s <caller subnet> -d <target bridge subnet> -p tcp --dport <container port> -j ACCEPT`),
and record which hops needed it. These ufw allows are a belt-and-braces default: a published port on `172.17.0.1`
is reached through Docker's DNAT/FORWARD path ahead of ufw, which is why mimi reaches the status page today with NO
ufw rule for 18480 (checked 2026-10-11 by the status page's owner). If a hop works without its allow, you may skip
it; record which you added.

## 3. First start, and measuring mimi's source address

The trusted PROXY source is unknown until mimi connects, so start with the most likely value, measure, then pin it.

```bash
cd ~/erp-edge
./render-config.sh 10.211.92.1/32 "$(. ./.env; echo $ACME_EMAIL)"      # provisional: erp-edge's own bridge gateway
docker compose config -q && docker compose pull && docker compose up -d
docker compose ps                                                      # traefik Up
docker logs --tail 30 erp-edge-traefik-1                               # expect "Enabling ProxyProtocol for trusted IPs [10.211.92.1/32]"; no other ERR than ACME validation failures (expected until the cut-over)

# Measure: hold ONE connection from mimi's Traefik to the published port and read the source address erp-edge sees.
docker exec -d mimi-tls-le sh -c 'sleep 12 | nc 172.17.0.1 18443'      # if mimi's image has no nc, see the fallback below
sleep 2; docker exec erp-edge-traefik-1 netstat -tn | grep ':8443'     # Foreign Address column
```

Fallback if `nc` is missing in `mimi-tls-le`: `docker run -d --rm --name erp-edge-probe --network mimi_mimi-network alpine sh -c 'sleep 12 | nc 172.17.0.1 18443'`
(a throwaway probe container that exits by itself; it is not part of erp-edge) and read the same `netstat` line.

The foreign address is usually erp-edge's bridge gateway (`10.211.92.1`), because the hop is masqueraded. Use
exactly what you measured, as a single address:

```bash
MIMI_SRC=<measured address>
./render-config.sh "$MIMI_SRC/32" "$(. ./.env; echo $ACME_EMAIL)"
docker compose up -d --force-recreate traefik
docker logs --tail 5 erp-edge-traefik-1 | grep ProxyProtocol          # shows [<measured>/32]
```

Never use `0.0.0.0/0`, `172.16.0.0/12` or a whole bridge range here. If the measured address is shared by other
callers on the box (for example the bridge gateway), say so in the report: a connection from such a caller could
state any client address, which only skews analytics, and the ufw/DOCKER-USER rules in step 2 limit who can reach
the port. Re-measure after anything that recreates either bridge.

## 4. Both routes present, BEFORE the cut-over

`dynamic/` already holds `erp-status.yml` and `erp-insights.yml` (step 1); Traefik loaded them at start.

```bash
docker logs erp-edge-traefik-1 2>&1 | grep -i -E 'erp-status|erp-insights|error' | tail -20
# Routing check straight at erp-edge's published port (default certificate, hence -k; SNI chosen with --resolve):
curl -sk --resolve status.erp.gaiada.com:18443:172.17.0.1 https://status.erp.gaiada.com:18443/ -o /dev/null -w 'status via erp-edge: %{http_code}\n'
curl -sk --resolve insights.erp.gaiada.com:18443:172.17.0.1 https://insights.erp.gaiada.com:18443/lib/kestrel.js -o /dev/null -w 'collector script via erp-edge: %{http_code}\n'
curl -sk --resolve insights.erp.gaiada.com:18443:172.17.0.1 https://insights.erp.gaiada.com:18443/login -o /dev/null -w 'other path: %{http_code} (404)\n'
```

If these connections are rejected because the host's source address equals the trusted PROXY source (a trusted
peer MUST send the header), add `--haproxy-protocol` to each curl.
Expect: 200, 200, 404. Umami must be running with `ERP_EDGE_SOURCE` set (umami-sumopod.md step 6.3). Certificates are NOT
issued yet and cannot be: the CA still reaches mimi, so the ACME validation errors in the log are expected and harmless
(one failed attempt per name; Let's Encrypt allows 5 per hour). They are retried by the restart that ends step 5.

## 5. THE ONE-STEP CUT-OVER

Preconditions: steps 2 to 4 pass; preflight backups exist; status page answered 200 through erp-edge; someone
is ready to run step 6 (rollback). Expect a short window (seconds to about a minute) in which the two names present
erp-edge's default certificate until TLS-ALPN-01 issues; browsers show a warning in that window. Pick a quiet time.

One command. The passthrough file is written under a temp name Traefik ignores (it loads `.yml`/`.yaml`/`.toml`
only), renamed into place, and the old route is moved out of the directory in the same breath; both renames land
inside the file provider's throttle window, so mimi reloads once. The last link restarts erp-edge so it asks for
its certificates now that the CA's connection reaches it.

```bash
D=/home/ubuntu/mimi/infrastructure/tls/dynamic; E=$HOME/erp-edge; test -s "$D/erp-status.yml" && test -s "$E/mimi/erp-passthrough.yml" && cp -p "$D/erp-status.yml" "$E/backup/erp-status.yml.cutover" && cp "$E/mimi/erp-passthrough.yml" "$D/.erp-passthrough.yml.tmp" && mv "$D/.erp-passthrough.yml.tmp" "$D/erp-passthrough.yml" && mv "$D/erp-status.yml" "$E/backup/erp-status.yml.removed" && echo "cut over at $(date -u +%FT%TZ)" && docker compose -f "$E/docker-compose.yml" restart traefik
```

Then watch (about 1 to 3 minutes):

```bash
docker logs --since 5m mimi-tls-le 2>&1 | grep -i -E 'erp-edge|erp-status|error' | tail
docker logs -f --since 2m erp-edge-traefik-1 2>&1 | grep -i -E 'acme|certificate|error'      # ctrl-c when both names are issued
docker exec erp-edge-traefik-1 sh -c 'grep -c "\"main\"" /acme/acme.json'                      # certificates stored (2 expected)
```

No certificate after 3 minutes, or any other failure: run step 6 at once.

## 6. Rollback

Restores mimi's own route for the status page and removes the passthrough, in one command (same atomic-rename idea),
and leaves erp-edge running and harmless (nothing reaches it):

```bash
D=/home/ubuntu/mimi/infrastructure/tls/dynamic; E=$HOME/erp-edge; cp -p "$E/backup/erp-status.yml.cutover" "$D/.erp-status.yml.tmp" && mv "$D/.erp-status.yml.tmp" "$D/erp-status.yml" && mv "$D/erp-passthrough.yml" "$E/backup/erp-passthrough.yml.removed" && echo "rolled back at $(date -u +%FT%TZ)"
curl -s -o /dev/null -w 'status after rollback: %{http_code}\n' https://status.erp.gaiada.com/
```

Mimi's Traefik then re-issues the status certificate by its HTTP challenge if it no longer holds one (it kept its
own certificate store, so normally it just serves it). The `insights.erp.gaiada.com` name has no mimi route (it
never had one in this design), so it goes dark again; the tracker fails silently in browsers.

## 7. Verification (all of these, with output, before calling it DEV-VERIFIED)

Run from a Linux client that is NOT sumopod (the orchestrator's CI box or another server), unless noted.

```bash
# a) Both names present erp-edge's TLS-ALPN-01 certificate and verify fully (no -k).
for h in status.erp.gaiada.com insights.erp.gaiada.com; do
  echo "== $h"; echo | openssl s_client -connect $h:443 -servername $h -verify_return_error 2>&1 | grep -E 'Verification|Verify return code'
  echo | openssl s_client -connect $h:443 -servername $h 2>/dev/null | openssl x509 -noout -issuer -subject -serial -dates
  curl -sS -o /dev/null -w "$h  http=%{http_code} ssl_verify=%{ssl_verify_result} (0 = verified)\n" https://$h/
done
# The status page serial must DIFFER from ~/erp-edge/backup/status-cert-before.txt (that was mimi's certificate).
# On sumopod: erp-edge holds both certificates:  docker exec erp-edge-traefik-1 sh -c 'grep -o "\"main\": *\"[^\"]*\"" /acme/acme.json'
# b) mimi's own site is untouched (its sslip.io host from preflight).
curl -s -o /dev/null -w 'mimi site: %{http_code} (200)\n' "https://$MIMI_HOST/"
# c) The status page answers.
curl -s -o /dev/null -w 'status: %{http_code} (200)\n' https://status.erp.gaiada.com/
# d) Umami collector: the two exact paths answer, everything else is 404.
curl -s -o /dev/null -w 'script: %{http_code} (200)\n' https://insights.erp.gaiada.com/lib/kestrel.js
curl -s -o /dev/null -w 'collect (OPTIONS): %{http_code} (200/204)\n' -X OPTIONS -H 'Origin: https://gaiada.com' -H 'Access-Control-Request-Method: POST' https://insights.erp.gaiada.com/lib/kestrel/e
for p in / /login /dashboard /script.js /api/send /api/heartbeat /api/auth/login /api/websites /api/me /lib/kestrel.js/ /lib/kestrel; do
  printf '%-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' https://insights.erp.gaiada.com$p)"; done          # all 404
# e) Only one-label names reach erp-edge; others stay with mimi (the certificate must NOT be erp-edge's).
echo | openssl s_client -connect sumopod.erp.gaiada.com:443 -servername a.b.erp.gaiada.com 2>/dev/null | openssl x509 -noout -issuer -subject -serial
```

Full Umami checks (CORS single header, no egress, hardening, geo) are in `umami-sumopod.md` step 8.

**The client IP reaches Umami's edge correctly.** The nginx edge keeps no access log (by rule) and erp-edge's drops
the client address, so prove it with a short packet capture on sumopod, shown on screen and not stored:

```bash
# on sumopod; APP_IP = Umami app's address on its internal network
APP_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' umami-app-1)
( sudo timeout 25 tcpdump -i any -nn -A -s0 "tcp dst port 3000 and dst host $APP_IP" 2>/dev/null | grep -a -i -E '^(x-real-ip|x-forwarded-for):' ) &
# from the OTHER Linux client, within 25 s: once honest, once with a forged header
CL=$(curl -s https://ifconfig.me)    # that client's public address
POST='{"type":"event","payload":{"website":"<website-id>","url":"/erp-edge-selftest","hostname":"gaiada.com","language":"en","screen":"1920x1080"}}'
curl -s -X POST https://insights.erp.gaiada.com/lib/kestrel/e -H 'Content-Type: application/json' -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36' -H 'X-Forwarded-For: 8.8.8.8' -d "$POST"
wait
```

Pass: the captured `X-Real-IP` / `X-Forwarded-For` lines show `$CL` and NOT `8.8.8.8`, and not an internal
(172.x) address. Then clean up the test row (`umami-sumopod.md` step 8, step 6 of its list) and confirm the Umami
session's country is the client's own. If the capture shows an internal address, the PROXY trust or
`ERP_EDGE_SOURCE` is wrong: fix before go-live. Do not paste the captured address into a ticket or log.

**Nothing listens on 0.0.0.0 for erp-edge:**

```bash
ss -ltnp | grep -E ':18443\b'                       # exactly one line, 172.17.0.1:18443
docker port erp-edge-traefik-1                       # 8443/tcp -> 172.17.0.1:18443
docker inspect erp-edge-traefik-1 --format 'cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} pids={{.HostConfig.PidsLimit}} sec={{.HostConfig.SecurityOpt}} ro={{.HostConfig.ReadonlyRootfs}} caps_drop={{.HostConfig.CapDrop}} mounts={{range .Mounts}}{{.Destination}} {{end}}'    # no docker.sock in mounts
# from the OTHER client: the public address must NOT accept 18443
nc -vz -w 4 <sumopod public IP> 18443 || echo "closed (expected)"
```

## 8. After a verified cut-over

* There is no old mimi -> `172.17.0.1:18480` ufw rule to remove (none exists; the path ran through Docker's DNAT). Only
  if `sudo ufw status numbered` shows one that you or someone else added, delete it and re-run check 7c.
* Tell the session that owns the status page that its route now lives in `erp-edge/dynamic/erp-status.yml` and that
  its probe of `https://status.erp.gaiada.com/` goes through the passthrough.
* Record the measured mimi source, which hops needed `DOCKER-USER` rules, and the verification output on the board.

## 9. Renewal, and what can silently break it

* Traefik renews each certificate when it is about 30 days from expiry (Let's Encrypt certificates last 90 days),
  by TLS-ALPN-01 **through mimi's passthrough**. Renewal therefore depends on mimi's `erp-passthrough.yml` staying
  in place, mimi keeping 443, and erp-edge running. If the owner removes the file, nothing fails loudly until a
  certificate expires.
* Probe it: alert on `status.erp.gaiada.com` and `insights.erp.gaiada.com` certificate expiry below 14 days. Today NOTHING probes
  either name (the existing probes hit `api.erp.gaiada.com` on aicenter): after the cut-over, the status page's owner
  adds `https://status.erp.gaiada.com/` and `https://insights.erp.gaiada.com/lib/kestrel.js` to sumopod's blackbox
  probes (`probe_ssl_earliest_cert_expiry`), once the hairpin to the box's own public address is proven from the obs
  network. A failed renewal shows as `ERR ... Unable to renew`
  in `docker logs erp-edge-traefik-1`.
* State: the named volume `erp-edge_acme` holds the account key and certificates. Losing it means re-issuing (rate
  limits: 5 duplicate certificates per week per name). Back it up with the nightly job:
  `docker run --rm -v erp-edge_acme:/a:ro alpine tar -C /a -cf - . > erp-edge-acme-$(date +%F).tar` and store it
  with the other off-box backups, mode 600 (it contains the private keys; the repo is PUBLIC, never commit it).
* Recreating the container keeps the volume. `docker compose down -v` deletes it: do not.
* Upgrading Traefik: change the `image:` tag AND digest together after reading the release notes; mimi's own Traefik
  is independent.

## What was checked while writing (not a deployment)

* Traefik v3.3.7 tag and index digest looked up 2026-10-11. The shipped `traefik.yml` (rendered with a sample
  address), `erp-status.yml` and `erp-insights.yml` were loaded by that exact image locally, with the compose
  hardening flags (read-only root, `cap_drop ALL`, `no-new-privileges`, tmpfs): it started, logged "Enabling
  ProxyProtocol for trusted IPs [<the /32>]", started the file and ACME TLS-ALPN providers and accepted both routers
  with resolver `erp-le`. `erp-passthrough.yml` was loaded by a second instance: the TCP router, the passthrough
  route and `proxyProtocol.version: 2` on the service were accepted and logged (`Adding Passthrough route for
  "HostSNIRegexp(...)"`). Syntax reference: Traefik v3.3 docs, "Routing / Services / TCP / PROXY Protocol"
  (`loadBalancer.proxyProtocol.version`) and "Routing / Routers / TCP / Passthrough".
* `docker compose config -q` passes for erp-edge and for the umami project (with `ERP_EDGE_SOURCE` set); the umami
  project refuses to render without it. YAML of every Traefik file parses. The umami edge template rendered with the
  pinned nginx image passes `nginx -t` and emits exactly one `set_real_ip_from`.
* NOT run: everything on a server: the passthrough against real mimi, PROXY protocol acceptance end to end, TLS-ALPN-01
  issuance, the masquerade and ufw/DOCKER-USER behaviour of every hop (the trusted-source values are measured, not
  assumed), the packet-capture proof, and the regex's behaviour against real SNI (reasoned: one label of
  `[a-z0-9-]`, not starting or ending with `-`, anchored; the apex and deeper names do not match).
