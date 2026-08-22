# Onboarding a host into Plane A observability

**Status:** PLANNED — this runbook documents the ratified procedure (MSO-03,
`docs/plans/2026-08-21-multi-server-observability.md` §2). It has not yet been executed against
any host. Its own first execution must be the `gda-aicenter` dry run in §6 — nowhere else, and not
before an owner review of this document.

**Scope ruling 2026-08-22 (owner):** `helios` and `delphi` are **OBSERVE-ONLY** — this runbook
no longer applies to them at all (§0). Design of the agentless tier that watches them instead:
`docs/plans/2026-08-21-multi-server-observability.md` §12.

**Scope:** Plane A only (our own infrastructure — staff-only `isElevated`, never tenant-scoped,
never merged with Plane B). This adds exactly one host's metrics to the SumoPod hub
(`10.88.0.2`). It does not touch platform code, Cerbos policy, or any tenant data.

**Design it implements:** per-host agent bundle (node-exporter + OTel collector), remote_write
**outbound only** over a WireGuard hub-and-spoke centred on SumoPod. No inbound port is ever
opened on the monitored host. No exporter or collector is ever published on `0.0.0.0`. The spoke's
`AllowedIPs` is `10.88.0.2/32` **only** — an onboarded host can reach the hub and nothing else on
the mesh, so a compromised spoke cannot pivot to another spoke.

---

## 0. Never-touch list — read this before reading anything else

| Host | Status | Rule |
|---|---|---|
| `gda-ce01` (34.158.47.112) | **OUT OF SCOPE by owner decision** | Never install, never probe, never scrape. Do not add a row for it. Do not SSH to it as part of this procedure even to "just look." |
| `delphi` (72.61.142.88), `helios` (187.77.116.133) | **OBSERVE-ONLY — agent installation PROHIBITED (owner ruling 2026-08-22)** | **REVERSAL, recorded the way the earlier delphi/helios correction was:** until 2026-08-22 this row read "Authorized targets — gated behind a dry run". That is superseded by the owner's 2026-08-22 ruling: *"for now we shouldnt do anything to helios or delphi. we just want to have informations from it not actively control or modify it. full control is for production."* Never install, configure, restart, or modify ANYTHING on either host — no agent bundle, no WireGuard peer or keypair, no compose project, no `authorized_keys` change. They are watched agentlessly from the hub instead (design doc §12, MSO-11): collecting information FROM them — probes of owner-named endpoints — is in scope; changing them is not. If a future owner ruling grants full control, that is a new dated decision; until then this runbook must never be run against them. Never enumerate `~/.ssh/config` or scan `10.88.0.0/24` to "discover" more hosts — the inventory is explicit opt-in only (§2 of the design doc). |
| Hostinger WP host | **Cannot run an agent at all — shared hosting** | This is a Plane B (external probing / blackbox) target, not Plane A. Do not attempt to install anything here; there is no shell access model that makes this procedure applicable. If someone asks "did we onboard the WP host," the answer is "it goes through Plane B synthetic probing, never this runbook." |
| Any host not named in `infra_hosts` intent (OQ-1) | **Not yet authorized** | If you're tempted to onboard any host other than the `gda-aicenter` dry run (§6), stop and get an explicit owner go-ahead first. (`delphi`/`helios` are no longer in the authorized set — see their row above, 2026-08-22.) This runbook does not grant standing authority to onboard whatever host you find. |

---

## 1. Parameters — the only three values that vary per host

| Parameter | Meaning | Example |
|---|---|---|
| `HOST_KEY` | Immutable identifier; becomes the `host` remote_write label and `infra_hosts.key` (must match `^[a-z0-9][a-z0-9-]*$`) | `gda-aicenter` (dry run); future owner-approved agent-tier hosts only — NEVER `delphi`/`helios` (observe-only, §0, 2026-08-22) |
| `HOST_ENV` | Becomes the `env` remote_write label; must be one of `infra_hosts.env`'s CHECK values | `production`, `staging`, `ops`, `dev` |
| `OBS_HUB` | WireGuard address of the SumoPod hub | `10.88.0.2` (default — do not change without an architect decision) |

**Non-negotiable ordering:** the collector's `external_labels` (`host`, `env`) must be baked into
its config **before the collector ships its first sample**. MSO-01 exists because two hosts
without labels emit literally identical series (`up{job="node",instance="node-exporter:9100"}`)
and the remote store interleaves their samples — that is corruption, not merely ambiguity, and it
is not fixable after the fact by relabeling later data. Never start the collector container with a
templated-but-unfilled config "to test connectivity first."

---

## 2. Pre-flight — run ALL of these before touching anything, on the box you're about to onboard

Abort immediately (do not proceed to §3) if any check fails. "Fails" includes "I'm not sure" —
this estate has been burned by proceeding on an assumption more than once.

1. **Fresh baseline, this session, this host — never trust a written-down number.**
   ```sh
   ssh <target-host-alias> "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'" \
     > onboard-<HOST_KEY>-ps-before.txt
   ```
   Save this file. You diff against it in §7 and again in §8's rollback path. A stale baseline
   from a prior session or from someone else's notes is exactly the failure mode that produced a
   false "37 containers is an incident" reading on SumoPod earlier in this program — take it fresh,
   every time, per host.

2. **Confirm the host is in scope — against the inventory, not memory.** Cross-check `HOST_KEY`
   against §0's table, AND ask the database once the MSO-09 migration has landed the tier column:
   ```sh
   psql "$DATABASE_URL" -c "select key, monitoring_tier, status from infra_hosts where key = '<HOST_KEY>';"
   ```
   If `monitoring_tier = 'blackbox'`, **stop — full stop**: the row itself carries the owner's
   observe-only ruling (2026-08-22) and this runbook does not apply to that host. `gda-ce01`:
   stop regardless of who asked — it must not even have a row. `delphi`/`helios`: stop —
   observe-only per §0; the earlier "gated behind a dry run" authorization is REVOKED.

3. **Confirm the agent bundle exists in the tagged release.**
   ```sh
   git -C <repo> show <deploy-tag>:infra/compose/docker-compose.obs-agent.yml >/dev/null \
     && echo "bundle present" || echo "STOP: bundle not in this tag"
   ```
   As of this writing `docker-compose.obs-agent.yml` and its collector config template are MSO-03
   deliverables tracked alongside this runbook and may not yet be committed. **If the file is
   missing, STOP here** — do not improvise a compose file by hand on the target box. A hand-applied
   config on a box that receives tagged deploys has a documented maximum lifetime of one deploy
   (§2.5 of the monitoring-program doc; it has already reverted hand-applied observability config
   twice). Escalate to get MSO-03 landed in a tag first.

4. **Confirm outbound reachability to the hub, nothing more.**
   ```sh
   ssh <target-host-alias> "curl -sS -o /dev/null -w '%{http_code}\n' http://10.88.0.2:19090/-/healthy || echo UNREACHABLE"
   ```
   This will fail until the WireGuard peer in §4 exists — that's expected at this point. The
   purpose of running it now is to have a documented "before" state, not to expect success.

5. **Confirm no HOST_KEY collision.**
   ```sh
   psql "$DATABASE_URL" -c "select key, env, role, status from infra_hosts where key = '<HOST_KEY>';"
   ```
   Abort if a row already exists with `status = 'active'` — that means this host is already
   onboarded and you are about to duplicate/corrupt its series identity. A row with
   `status = 'onboarding'` from an earlier abandoned attempt is fine to resume against, but confirm
   with whoever left it there before reusing it.

6. **Never publish on `0.0.0.0` — restate before you write a single line of compose override.**
   Docker's DNAT rules are evaluated before ufw's; a `0.0.0.0` bind is internet-reachable on a box
   whose firewall reports "deny incoming." The agent bundle publishes **nothing** — the collector
   reaches local exporters over the compose network and egresses only outbound over wg. If any
   step below seems to require a published port, stop and re-read the design doc §2 — it doesn't.

---

## 3. WireGuard: hub-side (run on SumoPod)

Every command on SumoPod is scoped — it runs the owner's private production alongside our
observability stack. No `docker system prune`/`image prune -a`/`volume prune`/`network prune`, no
bare `--remove-orphans`. This section only touches `wg` config, not Docker.

1. Generate a keypair **on the new host**, not on SumoPod (§3.1) — the private key never leaves
   the host it belongs to.
2. On SumoPod, add exactly one peer entry:
   ```sh
   ssh sumopod
   sudo wg set wg0 peer <NEW_HOST_PUBLIC_KEY> allowed-ips 10.88.0.<N>/32
   sudo wg-quick save wg0        # persist across reboot — confirm the flag your install uses
   ```
   `<N>` is the next free WireGuard host octet — check the existing peer list
   (`sudo wg show wg0 allowed-ips`) before picking one; do not guess or reuse.
3. **Standing policy, not a one-off exception:** each onboarding adds one peer to the hub. This
   was ratified (OQ-3) specifically because the mitigation — see §3.1 — holds regardless of peer
   count. Revisit only if the fleet grows past "a handful" of hosts, at which point the hub itself
   should move off SumoPod rather than the peer list growing further on a box that also carries the
   owner's private production.

### 3.1 WireGuard: spoke-side (run on the new host)

```sh
# On the new host — AllowedIPs is the hub address ONLY. This is the whole safety property:
# an onboarded host can reach the hub and reach nothing else on the mesh, so a compromised
# spoke cannot pivot to another spoke, by construction, no matter how many peers the hub has.
wg genkey | sudo tee /etc/wireguard/privatekey | wg pubkey | sudo tee /etc/wireguard/publickey
sudo tee /etc/wireguard/wg0.conf >/dev/null <<EOF
[Interface]
PrivateKey = $(sudo cat /etc/wireguard/privatekey)
Address = 10.88.0.<N>/32

[Peer]
PublicKey = <SUMOPOD_WG_PUBLIC_KEY>
Endpoint = 150.109.15.108:51820
AllowedIPs = 10.88.0.2/32
PersistentKeepalive = 25
EOF
sudo systemctl enable --now wg-quick@wg0
```

**Abort condition:** if `AllowedIPs` under `[Peer]` is anything other than exactly
`10.88.0.2/32`, stop and fix it before bringing the interface up. A wider `AllowedIPs` here is the
one change that would silently undo the whole hub-and-spoke isolation property.

**Verify before moving on:**
```sh
sudo wg show wg0 latest-handshakes
```
A handshake age under ~3 minutes (keepalive is 25s) means the tunnel is live. No handshake ever ⇒
check the hub-side peer entry and the endpoint/port; do not proceed to §4 on a dark tunnel.

---

## 4. Register the host in `infra_hosts` — BEFORE the agent ever ships a sample

This makes the console show the host as expected-but-dark rather than simply absent, and it
survives the agent bundle failing to start. The table is `infra_hosts` from migration
`202608211610_mso04_infra_hosts.sql` (global, non-tenant — read via `withGlobal()`, no RLS, same
posture as the permission catalog).

```sql
INSERT INTO infra_hosts (key, display_name, env, role, provider, wg_ip, ssh_alias, status, notes)
VALUES (
  '<HOST_KEY>', '<Human-readable name>', '<HOST_ENV>', '<role>',
  '<provider, if known>', '10.88.0.<N>', '<ssh alias, operator convenience only>',
  'onboarding', 'MSO-03 onboarding started <date> by <you>.'
)
ON CONFLICT (key) DO UPDATE SET
  env = EXCLUDED.env, role = EXCLUDED.role, wg_ip = EXCLUDED.wg_ip,
  ssh_alias = EXCLUDED.ssh_alias, notes = EXCLUDED.notes, updated_at = now();
```

`ssh_alias` is operator convenience only — nothing in the platform ever dials it. `status` stays
`onboarding` until §7's verification passes; only then flip it to `active` (§8's rollback path
needs `onboarding` to mean "not yet trusted, safe to unwind").

---

## 5. Deploy the agent bundle (on the new host)

```sh
cd ~/gaiada/infra/compose      # or wherever this host's checkout/deploy path is
HOST_KEY=<HOST_KEY> HOST_ENV=<HOST_ENV> OBS_HUB=10.88.0.2 \
  docker compose -p gaiada-obs-agent -f docker-compose.obs-agent.yml up -d
```

- **Never `--remove-orphans` without `-p gaiada-obs-agent`** on a host that runs anything else.
- The collector config template must resolve `HOST_KEY`/`HOST_ENV` into `external_labels` before
  the container's first scrape — confirm this by reading the rendered config, not by assuming the
  template did its job:
  ```sh
  docker exec <collector-container> cat /etc/otelcol/config.yaml | grep -A3 external_labels
  ```
  If `host`/`env` are empty, blank, or the literal string `<HOST_KEY>`, **stop the container**
  before it ships anything (`docker stop <collector-container>`) and fix the template invocation.
  Do not let an unlabeled collector run "just for a minute to check."
- The collector's scrape config contains **only this host's local jobs** (node-exporter, and any
  role exporters this host ships). Never copy `gda-aicenter`'s scrape list onto a new host — it
  manufactures permanently-down targets for services that don't exist there.

---

## 6. FIRST EXECUTION MUST BE `gda-aicenter` — dry run, nothing else

Do not run this runbook against `delphi` or `helios` on ANY pass — they are observe-only (§0,
2026-08-22). `gda-aicenter` is already
instrumented (it carries the collector/exporter pattern this design generalizes) and is the box
this program can afford to be wrong about. Treat this as a rehearsal:

1. Run §1–§5 with `HOST_KEY=gda-aicenter`, `HOST_ENV=production` — note `gda-aicenter` already has
   a row in `infra_hosts` (seeded `active` by MSO-04/05) and already has collector `external_labels`
   from MSO-01, so this dry run's job is to prove the **procedure**, not to re-onboard a host that's
   already reporting. If a step in §1–§5 doesn't make sense against an already-onboarded host,
   that's a signal the runbook needs adjusting before it meets `delphi`/`helios` — write down what
   didn't fit.
2. Run §7 (verification) in full.
3. **Stop.** Bring the dry-run findings to the owner along with this runbook for review.
   **SUPERSEDED 2026-08-22:** this step used to end "…only after the owner names which of
   `delphi`/`helios` goes first, resume at §1 for that host." That path no longer exists — both
   are OBSERVE-ONLY (§0) and never targets of this runbook. The next agent-tier host, if any, is
   whatever OQ-1 approves (`aire-vps`, `gda-ai01`, or an owner-named staging box), each needing
   its own explicit go-ahead.

---

## 7. Verification — prove the host actually reports, against the REMOTE, not a local Prometheus

A local `curl localhost:9090` on the new host (if it even has a local Prometheus, which it
shouldn't under this design) proves nothing about whether the hub received anything. Verify
against the hub:

```sh
ssh sumopod "curl -s 'http://10.88.0.2:19090/api/v1/query?query=count%20by%20(host)(up)'"
```

- **Pass:** the result set includes a group with `host="<HOST_KEY>"` and a non-zero count matching
  the number of local jobs this host's collector scrapes.
- **Fail:** `<HOST_KEY>` is absent, or present with `count=0`. Do not flip `infra_hosts.status` to
  `active` on a fail. Go back to §5's config check before repeating this query — do not repeat the
  query in a loop hoping it resolves itself; a dark host looks identical to a slow one for the
  first 90 seconds, but past ~5 minutes treat it as a real failure.

Also confirm:
```sh
ssh sumopod "curl -s 'http://10.88.0.2:19090/api/v1/query?query=up%7Bhost%3D%22<HOST_KEY>%22%7D'"
```
every expected job for this host is present and `1`, not just that the host label exists.

Only once both checks pass:
```sql
UPDATE infra_hosts SET status = 'active', updated_at = now() WHERE key = '<HOST_KEY>';
```

Finally, diff the target host's `docker ps -a` against the §2 baseline:
```sh
ssh <target-host-alias> "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'" \
  > onboard-<HOST_KEY>-ps-after.txt
diff onboard-<HOST_KEY>-ps-before.txt onboard-<HOST_KEY>-ps-after.txt
```
Expected diff: exactly the `gaiada-obs-agent` project's containers added, nothing else changed,
nothing else removed. Anything else is an incident — investigate before declaring the onboarding
done.

---

## 8. Rollback — remove the agent and the peer, leave the host as found

Run this if §7 fails and cannot be fixed quickly, or if the owner asks to un-onboard a host later.

1. **Stop and remove the agent bundle, scoped:**
   ```sh
   ssh <target-host-alias> \
     "cd ~/gaiada/infra/compose && docker compose -p gaiada-obs-agent -f docker-compose.obs-agent.yml down"
   ```
   `down` without `-v` preserves nothing to preserve here (the bundle is stateless — no volumes of
   consequence); confirm with `docker volume ls | grep gaiada-obs-agent` that nothing unexpected
   was created before assuming there's nothing to clean up.
2. **Remove the WireGuard peer on the hub:**
   ```sh
   ssh sumopod "sudo wg set wg0 peer <NEW_HOST_PUBLIC_KEY> remove && sudo wg-quick save wg0"
   ```
3. **Tear down the spoke interface on the target host:**
   ```sh
   ssh <target-host-alias> "sudo systemctl disable --now wg-quick@wg0"
   ```
   Leave `/etc/wireguard/wg0.conf` in place only if you intend to re-onboard soon; otherwise remove
   it along with the generated keypair.
4. **Update `infra_hosts`:**
   ```sql
   UPDATE infra_hosts SET status = 'decommissioned', notes = notes || ' | rolled back <date>: <reason>', updated_at = now()
   WHERE key = '<HOST_KEY>';
   ```
   Do not `DELETE` the row — a decommissioned row is a record that this host was tried and pulled
   back; deleting it loses that history and lets the same mistake happen twice unnoticed.
5. **Diff `docker ps -a`** on the target host one final time against the original §2 baseline —
   confirm it matches exactly, proving the host is back to its pre-onboarding state.

---

## 9. What this runbook does NOT do

- It does not open any inbound port anywhere. If a step you're about to run would, stop — you've
  deviated from the design.
- It does not touch Plane B, `/monitoring`, or any tenant-scoped table or Cerbos policy.
- It does not grant standing authority to onboard any host beyond the `gda-aicenter` dry run.
  (Until 2026-08-22 this line also named `delphi`/`helios` as next in line; the owner's
  observe-only ruling removed them — see §0.) Every host needs its own explicit go-ahead.
- It does not modify `docker-compose.observability.yml` or anything on `gda-aicenter`'s storage
  layer — that file's drift (MSO-00) is a separate, already-tracked problem; do not fold a fix for
  it into an onboarding session.

---

## 10. Status vocabulary reminder

Never write "done" or "complete" when closing out an onboarding. Use: `onboarding` (row created,
agent not yet verified), `active` (§7 passed), `decommissioned` (rolled back, §8). Narratively,
describe the host as DEV-VERIFIED only once §7's live query has actually been run and observed —
not once the compose command exits `0`.
