# WebDesk on rootless Docker — design and phased plan (M4 F6)

**Ruling:** WSK-D73 (owner, 2026-10-12): "build rootless Docker for the WebDesk project now". This closes design
v2.3 §03 **AC 7** ("Rootless Docker for the public surface's project") and is follow-up **F6** of
`docs/plans/2026-10-11-webdesk-m4-plan.md`.

**Status: PLANNED.** Design, scripts and pure-part tests are in the repo. Nothing has run on any server. The
tests are `webdesk/ops/host/rootless/test-rootless.sh` (164 checks) and `webdesk/ops/deploy/test-deploy-webdesk.sh`
(60 checks). Both run with plain bash, with no root and no docker.

**This repo is public.** Host addresses other than the docker0 address, the account names on the box, and raw
probe output go in a gitignored `*.local.md` file, never here.

---

## 0. Decisions at a glance

| # | Decision | One-line reason |
|---|---|---|
| D1 | A new system user **`webdesk-rootless`**, uid/gid **940**, runs the daemon. Not `webdesk-svc`. | uid 999 (`webdesk-svc`) is the uid three rootful redis processes run as today, and it owns the secrets. |
| D2 | subuid/subgid **700000000:65536** (live), **700065536:65536** (proof) | Above useradd's `SUB_UID_MAX` (600100000), so no future account can ever be given them. They overlap none of the five existing ranges. |
| D3 | **Linger** + the user's systemd `docker.service`. Socket `unix:///run/user/940/docker.sock`. | This is the supported rootless lifecycle. Linger already works on this box: another account uses it. |
| D4 | **cgroup v2 delegation** pinned (`Delegate=cpu cpuset io memory pids` on `user@940.service` only), plus a **root-owned envelope** on `user-940.slice`: `CPUQuota=100% MemoryMax=5G TasksMax=4096` | Keeps WSK-D72's per-service cpus/mem/pids enforced. The envelope enforces WSK-D72's 1.0 vCPU for the whole stack, daemon included, as root's limit. |
| D5 | Network driver **slirp4netns** (sandbox + seccomp forced), port driver **builtin**, **`DETACH_NETNS=false`**, host loopback disabled | Debian-supported, no SUID helper. The ingress path never touches slirp. `--net=host` stays inside RootlessKit's netns. |
| D6 | **Source-IP propagation is not needed** | The only client of `127.0.0.1:8380` is host nginx. The api has no `trustProxy`. The client IP travels at L7 (`X-Real-IP` / `X-Forwarded-For`). |
| D7 | The egress guard moves to **OUTPUT** and matches the **socket owner** (uid 940 + its subuid range). Listeners are muted (REPLY-direction drop). IPv6 is dropped entirely. OTLP is matched by `--ctorigdst`. | Rootless container traffic leaves the host as slirp4netns sockets owned by uid 940. No bridge subnet is ever visible to the host. |
| D8 | **Search-only ACL** for uid 940 on `/etc/webdesk` and its three public subdirectories | Otherwise the api cannot even be created: the bind sources sit under 0700 directories. The secrets stay unreadable to uid 940. |
| D9 | Data moves by a **raw volume copy**, with ownership remapped **by the kernel** (`wd-volume-copy.sh`), for Postgres, RustFS and Redis | Same image digests, tiny data (87 MB), and full fidelity (roles, versions, locks, queues). S3-level copying would mint new version ids. |
| D10 | **One host switch**, `/etc/default/webdesk-docker`, read by WebDesk's scripts only. Unset = rootful. | The cut-over and its rollback are one file. No workflow or cron change is needed. ERP tooling never reads it. |
| D11 | Prove on **gda-aicenter**, with a throwaway user and a throwaway project, before the live move | Only that box has the real resolver, docker0/OTLP collector, host listeners, nginx, systemd and kernel. |

---

## 1. Facts this design rests on (measured read-only, 2026-10-12)

The host facts in the brief (Debian 12, kernel 6.1.0-52, cgroup v2, systemd 252, Docker 29.7.0 with
`docker-ce-rootless-extras` 29.7.0, 2 vCPU / 16 GB (15 GiB usable), 40 GB free) were confirmed. Additional
measurements:

| Fact | Value | Why it matters |
|---|---|---|
| RootlessKit | 3.0.2 | The installed `dockerd-rootless.sh` defaults `DETACH_NETNS=true` ("enables `docker run --net=host`"). We pin it to false. |
| Candidates (bookworm) | uidmap 1:4.13+dfsg1-1+deb12u2, slirp4netns 1.2.0-1, passt 0.0~git20230309 | The installed script's own table needs pasta ≥ 2023_12_04, so bookworm's pasta is too old. |
| Already installed | dbus-user-session, acl (setfacl/getfacl), jq, python3 | No other packages are needed. |
| `/etc/subuid`, `/etc/subgid` | **five** 65536-ranges between 100000 and 558751 (Hansel's and four others) | **The brief said "only Hansel's"; that is wrong.** The overlap check matters. |
| `kernel.unprivileged_userns_clone` | 1; `max_user_namespaces` 63699 | Rootless works. Unprivileged user namespaces are already open to every local user. |
| `ip_unprivileged_port_start` | 1024 | Rootless cannot publish below 1024. 8380 is fine. |
| `ping_group_range` | `1 0` | Containers cannot ping out. This is irrelevant to WebDesk. |
| `user@.service` | `Delegate=pids memory cpu` (the systemd 252 default) | That is enough for compose's limits. We pin it anyway (D4). |
| Linger | one other account already lingers with a user dbus | The user manager + dbus path is proven on this box. |
| `/etc/resolv.conf` | a symlink to systemd-resolved's uplink file: `nameserver 169.254.169.254` (twice) | slirp4netns forwards DNS to that address. It is not a loopback stub, so `--disable-host-loopback` does not break DNS. |
| Interfaces | `ens4` (VPC) and `wg0` (WireGuard), both in 10.0.0.0/8; docker0 172.17.0.0/16; no global IPv6 | Everything private is in the deny list. IPv6 can be dropped wholesale. |
| Listeners on 172.17.0.1 | 4310, 4319 (the OTLP collector via docker publish), 5432 (host Postgres), 6379 (host Redis), 9443 (the nginx mTLS control vhost) | Under rootless, every one of them is a LOCAL destination. The guard denies all of them except 4319. |
| nat OUTPUT | `! -d 127.0.0.0/8 -m addrtype --dst-type LOCAL -j DOCKER`; DOCKER has `-d 172.17.0.1 --dport 4319 -j DNAT --to <collector on gaiada_default>:4319` | A host socket's connect to 172.17.0.1:4319 is DNATed **before** filter OUTPUT. The guard must therefore match `--ctorigdst`. |
| Filter OUTPUT | policy ACCEPT, no rules (iptables-nft 1.8.9) | The guard's jump is first and alone. |
| Netfilter modules | xt_owner, xt_hashlimit, xt_conntrack, xt_addrtype available | Every match the guard uses exists. |
| Rootful image store | containerd snapshotter (image id = manifest digest) | The rootless daemon must use it too, for `deploy-webdesk.sh`'s digest check. |
| `/etc/webdesk` | 0700 webdesk-svc. `certs/` **0700**; `editorial/`, `ws4/` 0750 webdesk-svc. `ca-cert.pem` 0644 webdesk-svc; both JWKS files 0444 root. `.env`, `.env.control` 0600. `guard.env` 0644 root. | D8: uid 940 needs search access through four directories, and nothing more. |
| Project tree | `/home/Hansel` is 0755. The tree is 0755/0644. `~/.docker` is 0700. The ERP compose `.env` is 0600. | The daemon can already reach `./proxy/Caddyfile` and `./postgres/init-roles.sh`. No move is needed. |
| Volumes | `webdesk_webdesk_pgdata` 87 MB (1512 entries, uid 70); `webdesk_webdesk_rustfsdata` 416 KB (102 entries, uid 10001); `webdesk_webdesk_redisdata` 168 KB (`dump.rdb`, uid 999). Also unused: `webdesk_webdesk_miniodata`, `webdesk_webdesk_status`. | The names carry the project prefix twice. The data has no special files, no hardlinks and no xattrs (checked on all 1616 entries). |
| uid 999 on the host | three `redis-server` processes: WebDesk's redis and two ERP redis containers | uid 999 is `webdesk-svc`, the owner of `/etc/webdesk` (§11, F6-R1). |

---

## 2. What happened to the checkpoint (`e30565df`)

| Item | Verdict | What changed and why |
|---|---|---|
| Guard design (OUTPUT, owner match, REPLY-mute, `--ctorigdst` OTLP, v6 drop-all, marker, `check` drift detection) | **Kept** | It is right, and it is the core of the design (§5). |
| `webdesk-rootless-guard.sh` | **Kept; cleaned up** | Literal newlines had been pasted into `printf`/`tr` strings. v6 rendering now also refuses a uid inside its own range. |
| Profiles, uid 940/941, subid ranges, slice envelope, the `user@` drop-in, `grant-socket.sh` | **Kept** | Re-verified against the measured facts (§1). |
| `install-rootless.sh` | **Rewritten in part** | **Bug: it could never run.** The operator check used the lower-case user regex, so the default operator `Hansel` always died. Added: the bind-source step and its checks (D8), `apt-get update` before installing, `--etc-access` / `--tree`, a guard against a uid inside its own range, and a check that the bridge does not shadow docker0. A false "config changed, not restarted" warning on first install is gone. A cgroup-root override makes the checks testable. |
| `wd-volume-copy.sh` | **Rewritten in part** | **Bug:** the root-owner restore ran `chown <uid> <gid> /dst`, and worked only by falling through to a later command. **Bug:** an unreadable destination counted as empty. The emptiness check is now fail-closed with `DAC_READ_SEARCH`. The busybox tar of `postgres:16-alpine` was replaced by GNU tar (`node:22-bookworm`, the same image on both sides). Argument parsing is now pure. Subid lookups must find exactly one entry. |
| `docker.service.in` | **Changed** | The operator grant is non-fatal (`ExecStartPost=-…`): a failed ACL breaks deploys loudly, not WebDesk. The unverifiable "since Docker 29.5" claim was replaced by the installed script's own words. |
| `daemon.json.in` | **Changed** | `native.cgroupdriver=systemd` is pinned, so limits cannot silently fall back to cgroupfs. |
| `webdesk-rootless-guard@.service` | **Changed** | `After=docker.service` is dropped. The rootful daemon writes no filter OUTPUT rule, and WebDesk's boot must not wait on the ERP's daemon. |
| `webdesk-rootless.conf.in` | **Changed** | It referenced `rootless-probe.sh` and `cutover.sh`, which do not exist. The cut-over is a runbook (§10 P4), not a script. |
| Tests | **Added** | `test-rootless.sh`. The checkpoint's code referred to it, but it did not exist. |

---

## 3. The daemon (D1–D4)

**User.** `webdesk-rootless`, uid/gid 940, created with `useradd --system`. Shell `/usr/sbin/nologin`, password
locked, no supplementary group, home `/var/lib/webdesk-rootless` (0700). Data root
`/var/lib/webdesk-rootless/docker` (0700).

*Why not `webdesk-svc` (uid 999).* Under the rootful daemon a container's uid is the host uid. redis:alpine runs as
999, and three such processes run today: WebDesk's own redis and two ERP redis containers. If the rootless daemon
ran as 999, any of them, after a mount-namespace escape, would *be* the daemon's owner. It could use the socket,
read the Postgres files and rewrite the unit. Separately, `webdesk-svc` owns `/etc/webdesk/.env`. The daemon user
must never be the owner of the secrets.

*Why 940.* It is free (`getent`), no process runs as it (`ps`), and it is away from the uids images cluster on
(0, 70, 100, 101, 999, 1000, 10001). The installer refuses a uid that any process is using.

**Ranges.** `usermod --add-subuids/--add-subgids 700000000-700065535 webdesk-rootless`. Container uid 0 maps to host
uid 940, and container uid N maps to 700000000+N−1. So Postgres (container uid 70) runs as host uid 700000069, and
RustFS (10001) as 700010000. The proof uses 700065536-700131071, which is adjacent and does not overlap.

**Lifecycle.** `loginctl enable-linger webdesk-rootless` starts `user@940.service` now and at every boot. The user
unit `~/.config/systemd/user/docker.service`, enabled for `default.target`, runs `dockerd-rootless.sh` under
RootlessKit. `XDG_RUNTIME_DIR=/run/user/940`, a logind tmpfs (≈1.6 GiB here). The socket is
`/run/user/940/docker.sock`, and the clients use `DOCKER_HOST=unix:///run/user/940/docker.sock`.

**Who reaches the socket.** The owner, root (through DAC override: every `sudo -n env DOCKER_HOST=… docker compose`
call), and **Hansel**. Hansel gets a search ACL on `/run/user/940` and rw on the socket, re-applied at every daemon
start by `grant-socket.sh`. Hansel is already root-equivalent (NOPASSWD sudo and the rootful docker group), so this
widens nothing. It is what keeps the deploy script's and the nightly backup's plain `docker` calls working.

**Never create a docker context for it.** `docker context use` changes the default daemon for *every* process of
that user, including the ERP's deploy.

**cgroups.**
- The drop-in `/etc/systemd/system/user@940.service.d/50-webdesk-rootless.conf` sets
  `Delegate=cpu cpuset io memory pids`. That pins the measured default (`pids memory cpu`) against future change and
  adds cpuset and io, so `docker info` reports no missing controller.
- dockerd uses the systemd cgroup driver (pinned in `daemon.json`). Each container gets its own scope with `cpu.max`
  = NanoCpus/10000 over 100000, `memory.max` and `pids.max`.
- **The envelope.** `/etc/systemd/system/user-940.slice.d/50-webdesk-rootless.conf` holds
  `CPUQuota=100% MemoryMax=5G TasksMax=4096`. Under delegation the daemon user *owns* its subtree and could raise its
  own containers' limits. The slice belongs to root, so WSK-D72's "WebDesk never takes more than half the box"
  becomes a root-enforced number. It now covers the daemon, RootlessKit and slirp4netns too.
- The cost: during a deploy, the tools container (`--cpus 1`) shares that 1.0 vCPU with the running stack. Deploys
  get slower, and nothing times out (the tools step has no deadline).

---

## 4. Networking (D5, D6)

**Drivers.**
- `DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns` and `PORT_DRIVER=builtin`.
- `SLIRP4NETNS_SANDBOX=true` and `SLIRP4NETNS_SECCOMP=true`. Starting fails rather than running unhardened.
- `DISABLE_HOST_LOOPBACK=true`, `DETACH_NETNS=false`, `MTU=65520`.
- Pinning `NET` also stops the script from silently falling back to pasta, vpnkit or gvisor-tap-vsock.
- Rejected:
  - pasta: too old in bookworm.
  - lxc-user-nic: a SUID helper, and experimental.
  - The slirp4netns port driver: slow, and its only gain (source IP) is not needed.

**Performance on 2 vCPU.**
- Ingress never touches slirp4netns. RootlessKit's parent accepts on `127.0.0.1:8380` in the host netns and passes
  each connection to its child over a socketpair. The child dials the port inside the netns (the "Fast" row of the
  installed script's table).
- Only egress goes through slirp's userspace TCP stack: tenant webhooks, mail, OTLP, image pulls and `npm ci` during
  deploys. That traffic is small, and its CPU counts inside the envelope.

**Publishing.**
- The compose files are unchanged: `127.0.0.1:${WEBDESK_PROXY_HTTP_PORT:-8380}:80`. The builtin driver binds
  exactly the HostIP of each publish, so the parent listens on `127.0.0.1:8380` only.
- Host nginx's public vhost (`api.erp.gaiada.com`) and the mTLS control vhost (`172.17.0.1:9443`) both
  `proxy_pass http://127.0.0.1:8380`, so neither changes.
- Even a mistaken `0.0.0.0` publish would be **mute**: guard rule 1 drops every reply-direction packet of the uid set
  except those from `127.0.0.1:<published port>` on `lo`.

**Source IP (D6).**
- With `userland-proxy` on (the default, kept), the builtin driver does not propagate the client address.
- It does not matter. The only L4 client of the published port is host nginx, so even propagation would show
  127.0.0.1.
- The api's Fastify adapter has no `trustProxy`, so `request.ip` is the Caddy hop's address: today 172.19.0.x,
  after the move the same subnet inside the netns.
- The real client address is carried at L7 by nginx (`X-Real-IP`, `X-Forwarded-For`) and is unaffected.
- *Found on the way:* the per-IP form and consent limits are therefore one global bucket. This is pre-existing and
  not F6 (§12, F6-R4).

**Inside the netns.**
- `daemon.json` moves the default bridge to `172.29.255.1/24` and the address pools to `172.30.0.0/16`. Docker's
  default (172.17.0.0/16) would create a `docker0` *inside* the netns. That would shadow the host's 172.17.0.1, so
  the OTLP export would hit the netns's own bridge.
- Compose's pinned `172.19.0.0/16` stays valid: inside the netns it collides with nothing.

**How the api reaches 172.17.0.1:4319** (the T6a OTLP door):
1. api → its gateway on `webdesk_default`.
2. The rootless dockerd's MASQUERADE inside the netns.
3. `tap0`, then slirp4netns.
4. slirp4netns opens a **host** TCP socket to `172.17.0.1:4319`, owned by uid 940.
5. nat OUTPUT DNATs it to the collector's address on `gaiada_default`.
6. Filter OUTPUT: the guard selects uid 940. The OTLP rules match the **original** destination
   (`--ctorigdst 172.17.0.1/32 --ctorigdstport 4319`): first the hashlimit cap, then RETURN.
7. The collector checks the bearer as today.

The rule sits before the LOCAL and private-range denies. So 4319 is the only port on any host address that answers
the uid set. 5432, 6379, 4310 and 9443 on 172.17.0.1, and every port on the NIC, `wg0` and loopback, are dropped.

**DNS.**
1. The container's resolver is Docker's embedded `127.0.0.11`.
2. dockerd forwards to the netns's `/etc/resolv.conf`, which RootlessKit writes as `nameserver 10.0.2.3`
   (`--copy-up=/etc`).
3. slirp4netns answers 10.0.2.3 by forwarding from a host socket (uid 940) to the host's resolver,
   `169.254.169.254:53`.
4. The guard allows exactly udp/tcp 53 to that address. Every other 169.254/16 destination (the metadata HTTP
   service) is dropped.

**Container → host loopback stays impossible, twice over:**
- slirp4netns `--disable-host-loopback`: `10.0.2.2` is not the host's `127.0.0.1`.
- The guard denies `--dst-type LOCAL` and `127.0.0.0/8` for every socket of the uid set.

`DETACH_NETNS=false` keeps dockerd itself, and any `--net=host` container, inside RootlessKit's netns, never in the
host's.

---

## 5. The egress guard, rebased (D7)

**Files.**
- `webdesk/ops/host/rootless/webdesk-rootless-guard.sh`, installed as `/usr/local/sbin/`.
- The unit `webdesk-rootless-guard@<user>.service`.
- The config `/etc/default/webdesk-rootless-<user>`, parsed and never sourced.
- The OTLP switch: the **same** `/etc/webdesk/guard.env` (`WEBDESK_OTLP_PORT=4319`) the rootful guard reads. One
  switch serves both guards.

**Exact v4 rules** for the live install with OTLP on. `test-rootless.sh` pins this text line for line.

```
-I OUTPUT 1 -j WDRL940-SEL                                   (v4 and v6; nothing may precede it)
-A WDRL940-SEL -m owner --uid-owner 940 -j WDRL940-OUT
-A WDRL940-SEL -m owner --uid-owner 700000000-700065535 -j WDRL940-OUT
-A WDRL940-OUT -s 127.0.0.1/32 -d 127.0.0.1/32 -o lo -p tcp -m tcp --sport 8380 -m conntrack --ctdir REPLY -j RETURN
-A WDRL940-OUT -m conntrack --ctdir REPLY -j WDRL940-DENY    (any other listener of the set is mute)
-A WDRL940-OUT -d 169.254.169.254/32 -p udp -m udp --dport 53 -j RETURN
-A WDRL940-OUT -d 169.254.169.254/32 -p tcp -m tcp --dport 53 -j RETURN
-A WDRL940-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -m hashlimit --hashlimit-above 300/sec --hashlimit-burst 600 --hashlimit-mode srcip --hashlimit-name otlp940 -j DROP
-A WDRL940-OUT -p tcp -m conntrack --ctorigdst 172.17.0.1/32 --ctorigdstport 4319 -j RETURN
-A WDRL940-OUT -m addrtype --dst-type LOCAL -j WDRL940-DENY  (every host address: lo, docker0, wg0, the NIC)
-A WDRL940-OUT -d {0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24
                   192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4} -j WDRL940-DENY
-A WDRL940-OUT -j RETURN                                     (the public internet)
-A WDRL940-DENY -m limit --limit 6/min --limit-burst 12 -j LOG --log-prefix "WDRL940-DENY " --log-uid
-A WDRL940-DENY -j DROP
v6: -A WDRL940-SEL (both selectors) -j WDRL940-DENY ; WDRL940-DENY = LOG (rate-limited) + DROP
```

**Lifecycle (fail closed).**
- `apply` loads both payloads with `iptables-restore --noflush`. Declaring a chain flushes it, so a reload is atomic
  per table.
- It then hooks OUTPUT, and only then writes `/run/webdesk-rootless-guard/<user>.active`.
- `docker.service` refuses to start without that marker (`ExecStartPre=test -e`).
- `user@940.service` `Wants=` the guard and is ordered `After=` it, so at boot the guard is in place first. A guard
  that fails leaves WebDesk **down**, never unguarded.
- A config that fails to render changes nothing: the old rules and marker stay, and `check` fails.
- `remove` refuses while any process of the uid set runs, so `systemctl stop` of the guard never strips a running
  daemon. Use `reload` (= apply) to change it, never `restart`.
- `check` passes only if:
  - the marker exists;
  - the live chains equal what `apply` loaded;
  - that payload was rendered from the **current** config (so an OTLP switch flipped without a reload is caught);
  - exactly one OUTPUT jump, with nothing before it, in both v4 and v6.

**Replacing the containment probe's source-subnet checks** (`containment-probe.sh`, rebased behind the switch):
- **Probe 3**, "host Postgres unreachable":
  - The TCP sweep is unchanged. Its throwaway container now starts on WebDesk's daemon, so its packets take the real
    rootless path (slirp4netns → guard).
  - Control A runs on the **rootful** default bridge, which no WebDesk guard covers.
  - Persistence is now: `webdesk-rootless-guard@<user>` is enabled **and** `webdesk-rootless-guard.sh check <user>`
    passes. That replaces "the INPUT rule names the subnet".
- **Probe 6**, the route sweep: unchanged in shape. It enumerates ERP containers from the rootful daemon and
  WebDesk's from the rootless one, and reads the OTLP exception from `WDRL<uid>-OUT` instead of `WEBDESK-EGRESS`.
- **Added under rootless:**
  - Probe 4 reads every container's **enforced** limits from its cgroup by PID, plus the slice envelope. The control
    is an unlimited container that reads `max`.
  - Probe 5 proves that the rootful daemon runs no container of the WebDesk project.

**Does the rootful `DOCKER-USER` chain still matter?** Not for WebDesk.
- slirp4netns's flows are locally generated. They traverse OUTPUT and POSTROUTING, never FORWARD.
- `webdesk-host-deny.service` keeps guarding the **stopped** rootful copy during the soak.
- It is **disabled and removed at decommission** (P5). With `webdesk_default` gone from the rootful daemon its unit
  would fail at boot. Worse, a future rootful network that reuses 172.19.0.0/16 would inherit WebDesk's deny.

---

## 6. Bind sources (D8): a requirement the brief did not list

In rootless mode the bind source is resolved by the daemon user, not by root. The api's three file mounts sit under
`/etc/webdesk` (0700) and `/etc/webdesk/certs` (0700). uid 940 cannot even traverse them, so the api **cannot be
created**: compose fails with EACCES on the mount source.

The installer's live profile therefore runs `setfacl -m u:webdesk-rootless:--x` on `/etc/webdesk`,
`/etc/webdesk/certs`, `/etc/webdesk/editorial` and `/etc/webdesk/ws4`. That grants search only. Its `check` proves
three things as uid 940:
- `ca-cert.pem`, `editorial.jwks.json` and `ws4.jwks.json` are **readable**;
- `.env` and `.env.control` are **not** (0600, another owner);
- `/etc/webdesk` is **not listable**.

Inside the container, the api runs as container root (host uid 940) with `cap_drop: ALL`. Its host owners
(`webdesk-svc`, root) are unmapped and appear as `nobody`, so it reads the files through their "other" bits (0644,
0444). That is the same rule the M4 F3 note already states.

Things that change for operators:
- `ls -ld /etc/webdesk` now shows `drwx--x---+`.
- A later `chmod 0700` on any of those directories recomputes the ACL mask to `---` and silently revokes the grant.
  The next api recreate then fails loudly, and `install-rootless.sh check` names it. The ws4/editorial runbooks get a
  line saying so.
- A **missing** bind source no longer becomes an empty directory, as it did under the rootful daemon. uid 940 cannot
  `mkdir` there, so the api create **fails**. The runbooks' `rmdir` step stays harmless.

The `.env.control` symlink and `--env-file /etc/webdesk/.env` are read **client-side** by the compose CLI, which runs
as root through `sudo`. The daemon user never needs them.

The project tree's own bind sources (`proxy/Caddyfile`, `postgres/init-roles.sh`) are already reachable, because
`/home/Hansel` is 0755. If that home is ever tightened below o+x, move the tree to `/srv` first.

---

## 7. Data migration (D9)

**Method.** `webdesk/ops/host/rootless/wd-volume-copy.sh copy --from rootful --to unix:///run/user/940/docker.sock
--volume <name> --image node:22-bookworm@sha256:<d>`.
- GNU tar runs in a throwaway container on each daemon: `--network none`, `--log-driver none`, read-only rootfs,
  `cap_drop ALL` plus only the caps tar needs.
- The source is mounted **read-only**: the rootful copy stays intact as the rollback.
- The destination container extracts as container root, so the **kernel's** user namespace maps every owner. There is
  no uid arithmetic in the copy.
- `verify` then compares, as root, a manifest of both host paths (path, type, mode, in-container owner after mapping
  back, size, sha256).
- It refuses:
  - a source used by a running container;
  - a missing destination (compose must create it, so the labels are right);
  - a non-empty destination without `--replace`;
  - a helper image missing on either side.

| Volume | Choice | Why |
|---|---|---|
| `webdesk_webdesk_pgdata` | **Physical copy** of a cleanly stopped cluster (the image's STOPSIGNAL is SIGINT, a fast shutdown), same digest (16.x) | It carries everything the live cluster has: roles and their scram hashes, `webdesk_backup`'s attributes, grants, default ACLs, the migration ledger, FORCE RLS. A logical dump would lose the globals and owners unless they are recreated by hand. The safety net is a `pg_dump -Fc` taken just before, plus per-table row counts compared before and after. |
| `webdesk_webdesk_rustfsdata` | **Physical copy** with RustFS stopped, same digest | All of its state is files: bucket directories plus `.rustfs.sys` (bucket metadata incl. versioning and object-lock config, IAM users/policies, `format.json`, `pool.bin`). A byte-identical copy read by the same binary keeps every version id and every retention date. S3-level replication would mint **new** version ids and timestamps, and could not carry COMPLIANCE retention forward faithfully. **Proven in P2** before it is relied on (§9, A4). |
| `webdesk_webdesk_redisdata` | **Physical copy** of `dump.rdb`, after `stop` (SIGTERM → redis SAVEs, because save points are configured) | It costs nothing, so nothing is lost. If it *were* lost: pending mail and tenant-webhook retries in BullMQ would be lost. Nothing else would be: the four job schedulers re-register at every boot (`upsertJobScheduler`, idempotent); the schedules themselves (`publish_at`, `unpublish_at`, `content_schedules`) live in **Postgres**; the editorial JTI replay keys expire at exp+10 s, and the downtime is longer than that; the rate-limit counters just reset. |
| `…_miniodata`, `…_status` | Not copied; archived at decommission | The aicenter overlay mounts neither. |

**Roles and tools.**
- Because the copy is physical, `webdesk_backup` arrives intact, and `ensure-backup-role.sh` must print `unchanged`.
  That is a check, not a setup step.
- `deploy-webdesk.sh`'s tools container runs on the rootless daemon on `webdesk_default`, unchanged (the switch
  exports `DOCKER_HOST`). Its `--user $(id -u):$(id -g)` maps to a subuid. It writes only its own `/tmp` and reads
  `/src` (0644/0755), so it works as is.

**Downtime.** The data copy takes seconds, so the window is the stop + create + copy + start + healthy sequence.
Expect **3–5 minutes**; book a **15-minute** window. M4's down/up took 56 s for comparison.

**Rollback.**
- The rootful containers are **stopped, not removed**, and their volumes are never written (the copy reads them
  read-only).
- **R1**, no writes worth keeping: stop the rootless stack, delete the switch file, start the rootful stack, restart
  `webdesk-host-deny`. About 1 minute.
- **R2**, after writes on rootless:
  1. Archive the rootful volumes.
  2. Copy back with `wd-volume-copy.sh copy --from unix:///run/user/940/docker.sock --to rootful --volume … --replace`.
  3. Do R1.
- The rootful copy is kept for the **7-day soak** (P5).

---

## 8. Every consumer of `docker`, and how it switches (D10)

The switch is resolved by `wd_docker_host()`, a POSIX function **byte-identical** in five scripts
(`test-rootless.sh` compares them):
1. `WEBDESK_DOCKER_HOST`, when it is set at all, wins. An empty value means "explicitly rootful", which is useful
   during a rollback.
2. Otherwise, `/etc/default/webdesk-docker` (`WEBDESK_DOCKER_HOST=unix:///run/user/940/docker.sock`).
3. Otherwise, rootful.

Only `unix:///run/user/<uid>/docker.sock` is accepted. A malformed value fails loudly and never quietly falls back
to rootful. No ERP tool reads the file.

| Consumer | Change | State |
|---|---|---|
| `deploy-webdesk.sh` + `deploy-webdesk.yml` (and `release.yml`'s automatic path) | The script resolves the switch, exports `DOCKER_HOST` for its plain `docker` calls, passes it through `sudo env` to compose, and refuses a socket that is not rootless. New knobs for the proof: `WEBDESK_PROJECT` (all names derive from it), `WEBDESK_HEALTH_VIA=direct`. **The workflow needs no change**: it ships the script from `main` and the box's switch decides. | Done in this branch; harness 60/60 |
| `containment-probe.sh` | Two daemons (`dwd` for WebDesk, `derp` for the ERP) plus the rootless replacements in §5 | Done (behind the switch) |
| `compose-boot-proof.sh` | Uses the exported `DOCKER_HOST`. Under rootless: temp dir 0711 for the bind sources, plus enforced-limit checks | Done (behind the switch) |
| `webdesk-backup-nightly.sh` (cron as Hansel, 03:05 UTC) | Switch → `DOCKER_HOST`. **The cron line is unchanged.** | Done |
| `ensure-backup-role.sh` | Same, in POSIX sh | Done |
| `webdesk-restore-drill.sh` | Same: the throwaway Postgres runs on WebDesk's daemon | Done |
| **`infra/scripts/backup.sh` + `backup-cron.sh`** (ERP, 03:15) | These dump WebDesk's **globals and owner-preserving superuser dump** by container name on the rootful daemon. After the move, both become a *clean skip* and the per-stack warning is skipped too, so the dumps stop silently. **They must resolve WebDesk's daemon** through the same switch for the `webdesk-postgres-1` lines. | **Ticket T4**, a P3 prerequisite |
| ERP otel-collector `filelog` (`/var/lib/docker/containers/*/*-json.log`) | Today it ships WebDesk's container stdout to Loki by accident of the glob. After the move WebDesk's logs live under the rootless data root and **stop flowing**. Recommendation: do not mount WebDesk's data root into an ERP container (it holds every container's config, env secrets included). Instead ship the api's logs through the existing write-only door (`logs/webdesk`, already defined in the collector). | **Ticket T8**, follow-up; the gap is accepted at cut-over |
| cadvisor (rootful) | Rootless containers appear as unnamed cgroups under `user.slice` | Accepted |
| Alert `WebDeskApiDown` description; runbooks (`webdesk-live-swap`, `-ws4-keys` "Restart api", `-editorial-keys`, `-control-channel`, `-zoneb-backups`, `-zoneb-otel`, `-zoneb-box-hardening`), `webdesk/ops/README.md`, design §03 | Each `docker …` for WebDesk becomes `DOCKER_HOST=unix:///run/user/940/docker.sock docker …`. A compose call becomes `sudo -n env DOCKER_HOST=… docker compose …`. Plus the ACL notes from §6 and the guard's `reload` from §5. | **Ticket T5**, staged in P3, merged at P4 |
| GHCR login for pulls | Unchanged. The workflow's `docker login` stores the credential in Hansel's `~/.docker/config.json` (that call still talks to the rootful daemon). Any later `docker pull` by Hansel sends it to whichever daemon `DOCKER_HOST` names. cosign stays on the runner. | No change |
| `scripts/phaseb/erp-name-cutover.sh` | One-off, already run | No change |

**Minimum release after the cut-over.** The containment probe that `deploy-webdesk.sh` runs comes from the
*release tree*. After the move, dispatching a release **older than the first one that contains this branch** fails
its health probe; it fails safe, by re-pinning. `deploy-webdesk.sh rollback`, which re-pins images, is unaffected.

---

## 9. Proof before the live move (D11)

**Where.** **gda-aicenter**, with a throwaway user `wdproof-rootless` (uid 941, subuids 700065536:65536,
`127.0.0.1:18380`, envelope 0.5 vCPU / 4 GiB / 2048 tasks) and a throwaway project `wdproof` under `/srv/wdproof`.

*Why not sumopod.* sumopod would prove only the mechanism. The guard's claims are about *this* box: its resolver,
the docker0 collector at 4319, the host Postgres/Redis/9443 listeners, `wg0`, the metadata service, nginx, systemd
252 and this kernel. Those would stay unproven until the cut-over.

*Why it is safe here.*
- The proof shares nothing with the live project: its own daemon, netns, ports, uid set, guard instance and slice.
- Its guard rules match only uid 941 and its range.
- Its envelope caps it below the live budget.
- It is removed by `install-rootless.sh remove --profile proof`.

The only lasting change is the two packages (uidmap, slirp4netns), which the live install needs anyway.

**Steps and acceptance checks.** Each one passes with `FAIL=0`, and the evidence goes to a `*.local.md` file.

| # | Check | Expected |
|---|---|---|
| A1 | `install-rootless.sh plan --profile proof --etc-access --tree /srv/wdproof/webdesk`, then `apply`, then `check` | `plan` changes nothing. `apply` ends `VERIFY OK`, including: rootless, systemd + cgroup v2, containerd store, no `docker info` warning, bridge off 172.17/16, the RootlessKit/slirp4netns flags, the operator reaching the socket and nobody else, the three public bind sources readable, the secrets not readable, the tree readable |
| A2 | `test-rootless-guard.sh` (**T1**), against the proof daemon and its guard | See the list below this table |
| A3 | `DOCKER_HOST=unix:///run/user/941/docker.sock bash webdesk/ops/probes/compose-boot-proof.sh`, from a checkout under `/srv/wdproof` | Every check passes, including PID 1's effective caps and the five "limits enforced by its cgroup" |
| A4 | Copy rehearsal. **Postgres:** restore the newest ERP-side superuser dump and its `globals-webdesk-*` into a throwaway *rootful* volume (same digest), set the role passwords to the proof's, stop it, then `wd-volume-copy.sh copy` it into `wdproof_webdesk_pgdata`. **RustFS:** on a throwaway rootful RustFS (same digest) run `storage-bootstrap.mjs`, write one object twice with a retention date, stop it, copy it, start it on the proof daemon. **Redis:** copy a `dump.rdb` that holds a delayed BullMQ job. | `VERIFIED` ×3 (manifests equal). RustFS `ListObjectVersions` and `GetObjectRetention` are identical before and after (version ids, retain-until, bytes). The delayed job is still there. |
| A5 | The full proof stack (three compose files, the proof env, real images) `up -d`, then the rebased `containment-probe.sh` with `WEBDESK_PROJECT=wdproof WEBDESK_DOCKER_HOST=unix:///run/user/941/docker.sock` | Probes 1, 3, 4, 5 and 6 pass. Probe 2 is N/A: no vhost routes to 18380, so it runs at the cut-over. Row counts equal those of the dump. |
| A6 | `deploy-webdesk.sh plan`, then `apply`, then `rollback`, with `WEBDESK_PROJECT=wdproof WEBDESK_DOCKER_HOST=… WEBDESK_DIR=/srv/wdproof/webdesk WEBDESK_ENV_FILE=/srv/wdproof/env WEBDESK_PROXY_HTTP_PORT=18380 WEBDESK_HEALTH_VIA=direct WEBDESK_BACKUP_ROOT=/srv/wdproof/deploy-backups WEBDESK_DEPLOYED_TAG_FILE=/srv/wdproof/.deployed-tag`, using the live tag, digest and tree | `RESULT: plan OK`, then `apply OK`: the pull's id equals the digest, the second migrate applies 0, the RLS gate and storage-bootstrap pass, health and probe 1 pass. `rollback` comes back healthy. |
| A7 | `webdesk-backup-nightly.sh` and `ensure-backup-role.sh` (proof container, `WEBDESK_BACKUP_DIR=/srv/wdproof/backups`, **never `~/gaiada-backups`**, which sumopod pulls offsite), then the restore drill fed that dump | `webdesk-backup ok … tenants>0`, then `unchanged`, then `DRILL OK` (throwaway on the proof daemon) |
| A8 | Reboot stand-in: `systemctl stop user@941`; `loginctl disable-linger` then `enable-linger`; and a fail-closed run (guard stopped, config broken, then `systemctl start user@941`); `systemd-analyze verify` on the units | After the stop, no process of the set and the guard still ACTIVE. After linger is re-enabled, the stack returns by itself (`unless-stopped`) and probes 1/4 pass. With the guard broken, `docker.service` fails at `ExecStartPre`: no daemon, nothing on 18380. After repair and `reload`, it is back. The unit graph shows `user@941` after the guard. |
| A9 | `install-rootless.sh remove --profile proof`, then delete `/srv/wdproof` and the throwaway rootful volumes | No `WDRL941` chain, no user, home, range, drop-in or ACL entry remains |
| A10 | The live stack throughout | `containment-probe.sh` on live gives the same pass count before and after P2. `WebDeskApiDown` never fires. |

**A2 in detail (T1).** From throwaway containers on the proof daemon, with controls:
- Must work: the own-bridge peer, DNS, and `1.1.1.1:443`.
- Must be dropped (timeout): metadata `:80`; every host address `:22`; `172.17.0.1:{5432,6379,4310,9443}`; a
  WireGuard peer; `10.0.2.2:22`.
- Controls: the same host targets answer from the **rootful** default bridge.
- Published ports: the declared one (`127.0.0.1:18380`) answers from the host. An **undeclared** one
  (`127.0.0.1:18381`, and one on `0.0.0.0`) times out, which proves the REPLY mute.
- The OTLP exception:
  - With it off, `172.17.0.1:4319` is dropped.
  - With `WEBDESK_OTLP_PORT=4319` in `/etc/default/wdproof-rootless-otlp` and a `reload`, it opens. 4319 on other
    addresses and every other port stay dropped.
  - At 2 pps, a 40-connection burst is not fully admitted.
  - With it off again, there is no `ctorigdst` rule.
- `ip6tables` has the drop-all.
- Drift: an appended rule makes `check` FAIL, and `reload` repairs it.

**Needs from the owner** (§13): an OK to change the live box (Q1) and a short-lived GHCR read token for A6 (Q2).

---

## 10. Phases and exact commands

Shorthands on the box (as Hansel):

```bash
WD=/home/Hansel/gaiada-webdesk/webdesk; RL=unix:///run/user/940/docker.sock
F3="-f docker-compose.yml -f docker-compose.aicenter.yml -f docker-compose.aicenter-release.yml"
wdc_rootful() { (cd "$WD" && sudo -n docker compose --env-file /etc/webdesk/.env -p webdesk $F3 "$@"); }
wdc()         { (cd "$WD" && sudo -n env DOCKER_HOST="$RL" docker compose --env-file /etc/webdesk/.env -p webdesk $F3 "$@"); }
```

**P1. Land this branch** (≈0.5 session).
- QA runs both harnesses on the Linux gate, plus shellcheck.
- The orchestrator reviews the diff, merges and releases. With the switch absent, behaviour is unchanged: the deploy
  path stays rootful.

**P2. Proof on gda-aicenter** (≈1.5–2 sessions, including T1). The steps are §9 A1–A10, after owner Q1/Q2.

**P3. Prepare live, without downtime** (≈1 session).
1. T4 (ERP backup) and T5 (docs) are merged. The release that ships this branch's scripts is live.
2. Install:
   `sudo bash $WD/ops/host/rootless/install-rootless.sh plan --profile live`, review it, then `… apply --profile live`,
   then `… check --profile live`. The result is `VERIFY OK`, with an idle daemon and the guard ACTIVE with OTLP ON.
3. Stage the images on the rootless daemon. Then verify them:
   `DOCKER_HOST=$RL docker image inspect` shows the same ids as the rootful daemon.
   - The public, digest-pinned ones are pulled through the guard:
     `for i in $(wdc_rootful config --images | grep -v gaiada-webdesk-api); do DOCKER_HOST=$RL docker pull "$i"; done`.
     Then do the same for the tools image, the probe image (`node:22-alpine`) and the copy helper
     `node:22-bookworm@<digest of the rootful one>`.
   - The private api image is loaded and checked the way the live-swap runbook already does:
     `docker save "$API" | DOCKER_HOST=$RL docker load`, where `API` is the `WEBDESK_API_IMAGE` value from
     `/etc/webdesk/.env`. Refuse unless the loaded id equals the digest.
4. `wdc config -q` succeeds against the rootless daemon. It changes nothing.

**P4. Cut-over**, in an owner-approved 15-minute window, with no release tag pushed during it (≈0.5 session).

```bash
# 0. preflight
sudo bash $WD/ops/host/rootless/install-rootless.sh check --profile live        # VERIFY OK
[ ! -e /etc/default/webdesk-docker ] || { echo "switch already set"; false; }
# 1. safety net (still rootful)
bash $WD/ops/scripts/webdesk-backup-nightly.sh
TS=$(date -u +%Y%m%dT%H%M%SZ); B=~/webdesk-backups/f6-cutover-$TS; mkdir -p -m 700 "$B"
SU=$(docker exec webdesk-postgres-1 printenv POSTGRES_USER)
docker exec webdesk-postgres-1 pg_dump -Fc -U webdesk_backup -d webdesk > "$B/webdesk.dump"
COUNTS="SELECT format('%s %s', c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM public.%I', c.relname), false, true, '')))[1]) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1"
docker exec webdesk-postgres-1 psql -U "$SU" -d webdesk -XAtc "$COUNTS" > "$B/counts.before"
# 2. stop rootful: DOWNTIME STARTS (containers kept, volumes untouched)
wdc_rootful stop
# 3. create the rootless project without starting it (network, volumes, containers; bind sources are checked here)
wdc create
# 4. copy the three volumes, each verified
H=node:22-bookworm@sha256:<digest>
for v in pgdata rustfsdata redisdata; do
  sudo bash $WD/ops/host/rootless/wd-volume-copy.sh copy --from rootful --to "$RL" --volume webdesk_webdesk_$v --image "$H" --keep "$B/manifest-$v"
done
# 5. flip the switch, then start: DOWNTIME ENDS when proxy and api answer
printf 'WEBDESK_DOCKER_HOST=%s\n' "$RL" | sudo tee /etc/default/webdesk-docker >/dev/null && sudo chmod 0644 /etc/default/webdesk-docker
wdc up -d --no-build
```

Verify immediately. Each item must pass; if not, roll back with R1 (§7).
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8380/healthz` gives `200`.
- Through nginx, `/v1/t/<random>/collections` gives `401 application/problem+json`.
- `DOCKER_HOST=$RL docker logs --since 10m webdesk-api-1` shows `listening on :3000`, the editorial and WS4 JWKS
  kids, and the first `content tick … errors=0`.
- `DOCKER_HOST=$RL docker exec webdesk-postgres-1 psql -U "$SU" -d webdesk -XAtc "$COUNTS" | diff "$B/counts.before" -`
  shows no difference.
- `sh $WD/ops/scripts/ensure-backup-role.sh` prints `unchanged`.
- `sudo WS4_HMAC_RETIRED=1 WEBDESK_OTLP_PORT=4319 bash $WD/ops/probes/containment-probe.sh` passes all six probes
  (rebased). Probe 6 shows "OTLP exception: 172.17.0.1:4319 answers".
- `sudo bash $WD/ops/host/rootless/install-rootless.sh check --profile live` gives `VERIFY OK`.
- The control channel: the `webdesk-control-channel.md` check from `gaiada-platform-1` to
  `control.webdesk.internal:9443` (mTLS vhost → 127.0.0.1:8380 → rootless Caddy).
- WebDesk spans arrive at the collector (Tempo/Grafana, `service.namespace=webdesk`).
- Dispatch `deploy-webdesk.yml` with the live tag: `mode=plan`, then `mode=apply`. Both read the switch, and the
  result must be `RESULT: apply OK`.

**P5. Soak and decommission** (7 days; ≈0.5 session).
- Each day, the nightly dump through rootless is pulled offsite (`OffsiteBackupOneSourceStale` stays quiet). The
  automatic release path (`skip_if_current`) stays green. Run one restore drill, and the containment probe.
- Then decommission the rootful copy:
  1. `sudo systemctl disable --now webdesk-host-deny.service`, then remove its unit and
     `/usr/local/sbin/webdesk-egress-guard.sh`.
  2. `wdc_rootful down`.
  3. Archive each `webdesk_webdesk_*` volume as a 0600 tar under `~/webdesk-backups/f6-rootful-final-<ts>/`, then
     `docker volume rm` it.
  4. Remove the old WebDesk images from the rootful daemon.
- A real reboot test runs at the next owner-scheduled maintenance reboot (Q3): the guard is ACTIVE before
  `user@940`, WebDesk comes back by itself, and the probes pass.
- Update design §03 (AC 7 → DEV-VERIFIED), M4 F6, and the board.

**Total ≈ 4–4.5 sessions,** plus the 7-day soak.

---

## 11. Risks and the honest residue

What rootless **does** buy: a runc or container escape lands as **uid 940 or a subuid**, an unprivileged host user,
instead of root. The ERP's database, Keycloak and Cerbos files, the ERP's secrets (0600, other owners) and the
host's root-owned controls (the guard, the envelope, the subuid map) are no longer one escape away.

What it does **not** fix:
1. **The shared kernel.** A kernel exploit from a container still owns the box. Rootless needs unprivileged user
   namespaces, which are kernel attack surface. They are already open to every local user here, but an escapee now
   has them by definition.
2. **WebDesk itself.** uid 940 *is* WebDesk's daemon. An escapee controls every WebDesk container, volume and env
   secret (`docker inspect`). Rootless protects the host and the ERP from WebDesk, not WebDesk from itself.
3. **Ordinary local-user reach.** An escapee can read whatever any local user can. `/home/Hansel` is 0755. The
   sensitive files checked are 0600/0700, but the home holds more than was audited.
4. **AppArmor.** Rootless Docker does not apply the `docker-default` AppArmor profile. That layer is lost, and seccomp
   plus the user namespace remain. A good trade, but a real one: confirm `docker info` in P2.
5. **The OTLP door** remains a host port open to the uid set: rate-capped, bearer-checked, write-only. The **public
   internet** remains open for webhooks and mail, so exfiltration by a compromised api is not prevented (no change).
6. **uid 999 → `/etc/webdesk`.** It is pre-existing and only partly reduced: WebDesk's redis no longer runs as host
   uid 999, but two ERP redis containers still do, and 999 owns the WebDesk secrets (F6-R1).
7. **Operator confusion.** There are two daemons, and `docker ps` alone no longer shows WebDesk. Mitigated by the
   switch file, by every script printing its target, by the runbooks (T5), and by the "no docker context" rule.
8. **Deploys inside the envelope** are slower, because the tools container shares 1.0 vCPU. Disk: until P5, both
   daemons hold WebDesk images (≈1–2 GB). Logs: Loki loses WebDesk's container logs until T8.
9. **IPv6.** All IPv6 is dropped for the uid set. Revisit only if WebDesk ever needs IPv6 egress.
10. **Root and Hansel** still control both daemons. Unchanged.

| Phase | Effort | Main risk | Mitigation |
|---|---|---|---|
| P1 | 0.5 | A rootful regression in a shared script | The switch defaults to today's path; harnesses; diff review |
| P2 | 1.5–2 | Load on the live 2-vCPU box | 0.5 vCPU envelope; quiet hour; removable |
| P3 | 1 | The live ACL or install touches `/etc/webdesk` | Search-only ACL, `check` proves the secrets stay unreadable; `plan` first |
| P4 | 0.5 | Downtime overrun; data mismatch | Manifest-verified copy, row counts, R1 in about 1 minute, rootful copy kept |
| P5 | 0.5 | A rootful network reusing 172.19/16 later | `webdesk-host-deny` disabled at decommission |

---

## 12. Tickets

Model notes: every ticket runs on its seat's default model. The hard design is done here. Server work (P2, P3 and
P4 execution) stays with the orchestrator, per the estate rule.

| ID | Tier · model | What | Acceptance ("done when") | Depends |
|---|---|---|---|---|
| T0 | qa · seat default | Review and gate this branch | On the Linux gate, `bash webdesk/ops/host/rootless/test-rootless.sh` (164/0) and `bash webdesk/ops/deploy/test-deploy-webdesk.sh` (60/0) pass. shellcheck is clean or each warning is justified. Every blob is LF with mode 100755 on the scripts. With no switch, `deploy-webdesk.sh`, the probe and the backup scripts issue the same docker and compose calls as `main` (diff review, plus the harness's compose test). | — |
| T1 | devops · seat default | `webdesk/ops/host/rootless/test-rootless-guard.sh`: the live packet harness of §9 (A2) | It runs on the proof host and exits 0 only when every check **and its control** passes. It cleans up after itself, even on failure. It never touches uid 940 or the live guard. | T0 |
| T2 | orchestrator (server) | Execute P2 (A1–A10). Evidence goes to `docs/plans/…rootless-proof.local.md`. | Every A-row is met. Defects found become tickets. | T1, Q1, Q2 |
| T3 | devops · seat default | Fix whatever P2 finds in the scripts | The failing A-row passes on a re-run | T2 |
| T4 | devops · seat default | `infra/scripts/backup.sh` and `backup-cron.sh`: the `webdesk-postgres-1` dumps (globals and the superuser dump) and the per-stack warning go to WebDesk's daemon through the byte-identical `wd_docker_host` | With the switch absent, the output is identical to today's. With the switch present (proof daemon in P2), both `webdesk-*` dumps are written and the warning fires if one is missing. `test-rootless.sh`'s consumer check covers both files. | T0 |
| T5 | medior · seat default | Stage the doc changes from §8 (runbooks, ops README, the `WebDeskApiDown` text), merged at P4 | Every WebDesk `docker`/compose command in them names the rootless daemon. The WS4/editorial runbooks carry the §6 ACL notes. The OTel runbook's "close the door" uses `reload` on the rootless guard. | T2 |
| T6 | orchestrator (server) | P3: live install and image staging | `install-rootless.sh check --profile live` gives `VERIFY OK`. Every image the compose files name (plus the tools, probe and copy-helper images) has the same id on both daemons. | T2, T3, T4, Q4 |
| T7 | orchestrator (server) | P4 cut-over, then P5 soak and decommission | Every §10 P4 verification passes. A 7-day soak is clean. The P5 decommission is done. Design §03 AC 7 is DEV-VERIFIED. | T6, T5, Q4 |
| T8 | senior-be · seat default | The api ships its pino logs as OTLP logs through the existing door (`logs/webdesk`, bearer, rate cap) | Logs appear in Loki tagged `service.namespace=webdesk`. With an empty token nothing is sent and no error is raised. The guard needs no change. | after T7 |
| T9 | junior · seat default (owner OK) | Re-own `/etc/webdesk` from `webdesk-svc` (uid 999) to root:root, keeping the modes | `ls -ln` shows uid 0. Compose (as root) and the rootless ACLs still work. The containment probe passes. | owner (Q5) |

---

## 13. Open questions for the owner

1. **Q1: proof on the live box.** Approve P2 on gda-aicenter? It installs `uidmap` (setuid `newuidmap`/`newgidmap`)
   and `slirp4netns`, a throwaway system user, OUTPUT rules for uid 941 only, and systemd drop-ins. It runs a 0.5 vCPU
   / 4 GiB stack for about 2 hours. It seeds the proof cluster from the newest WebDesk dumps: same box, root-only,
   with mail, webhooks and Zone B events off, and wiped at the end.
2. **Q2: GHCR token.** P2's deploy rehearsal pulls from GHCR, and the box's login expires with every deploy job.
   Can you provide a read:packages token with a 1-day expiry? It would be used for the one rehearsal and then
   logged out.
3. **Q3: real reboot test.** Do you accept the A8 stand-in now, with the real reboot test at your next scheduled
   maintenance reboot? The estate trap "host Postgres binds before docker0" makes an unscheduled reboot an ERP risk.
4. **Q4: live window.** Approve the live install (P3) and a 15-minute cut-over window (3–5 minutes of WebDesk `/v1`
   downtime; the uptime alert will fire), with a 7-day soak before the rootful copy is deleted?
5. **Q5: `/etc/webdesk` ownership.** Re-own it to root (T9)? Two ERP redis containers run as host uid 999, which owns
   WebDesk's secrets.

## 14. Found on the way (not F6; each needs its own box)

- **F6-R1**: uid 999 = `webdesk-svc`, the owner of `/etc/webdesk`, is the uid that rootful redis:alpine containers run
  as (§11.6, T9).
- **F6-R2**: the ERP backup dumps WebDesk only through the rootful daemon and would stop silently after the move
  (T4).
- **F6-R3**: the ERP collector's `filelog` tails every rootful container's log, and today WebDesk's too (T8).
- **F6-R4**: the forms and consent per-IP limiters key on `request.ip`, which is always the Caddy hop. They are one
  global bucket. Fix it with `trustProxy` limited to the Caddy hop, reading nginx's header.
- **F6-R5**: the brief's "subuid has only Hansel's range" was wrong: there are five ranges.
