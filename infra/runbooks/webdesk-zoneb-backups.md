# Runbook — WebDesk Zone B backups, pull-model + object lock (WSK-28 / WSK-D23)

**Status: PLANNED (design + scripts authored) / PROTOTYPED where noted.** The box does not exist
(A-12). Every command here is written against the real `webdesk/docker-compose.yml` service
names and the real `mc` (MinIO client) CLI, and the two scripts it references
(`webdesk/ops/scripts/webdesk-backup-local.sh`, `webdesk/ops/scripts/wd-backup-sentinel.sh`) were
exercised against a throwaway MinIO container on this dev machine (see §7 for what that did and
did not prove). Nothing here has run against Zone B's real Postgres/MinIO on a real box.

Read first: `docs/blueprints/webdesk-design.md` §11 (backups, rewritten for WSK-D23) and §03
egress table (the removed R2/B2 row — "the offsite copy is pulled *by* the backup target, not
pushed *by* Zone B"). This runbook operationalizes that ruling; it does not relitigate it.

---

## 1. The security property this design buys, stated precisely

**Zone B must hold no credential that can reach the backup target.** Not "a scoped one," not "a
read-only one" — none. The reasoning: Zone B is the internet-facing, multi-tenant box; the offsite
backup copy is the ONE thing that must survive a full Zone B compromise (design §11: "single-disk
MinIO ... the offsite copy is what makes it a backup at all"). If Zone B held even a read-only
credential for the target, a compromised Zone B could **enumerate and exfiltrate** the backup
target's contents (a confidentiality breach even without write access), and a credential-handling
bug could turn "read-only" into "not actually read-only" — the only credential that is
unconditionally safe against a Zone B compromise is a credential Zone B never has.

**How pull-model delivers that:**

| Direction | Who initiates | Who holds the credential | What a Zone B compromise gets |
|---|---|---|---|
| Push (rejected model) | Zone B → target | Zone B holds a credential *for the target* | Read/write/delete access to every backup, including older ones — an attacker can delete the evidence of their own intrusion before it's noticed |
| **Pull (this design)** | **Target → Zone B** | **The target holds a credential for Zone B**; Zone B holds only an **inbound allowlist entry** that lets that credential connect | **Nothing for the target.** The attacker sees an inbound connection they cannot initiate, authenticate as, or reverse — there is no secret on the compromised box that unlocks the target |

The asymmetry is the whole point: an **inbound allowlist entry is not a credential**. It tells
Zone B's SSH daemon "a connection presenting this public key, for this one user, may run this one
command" — the corresponding *private* key lives only on the target box, never on Zone B. Reading
`authorized_keys` off a compromised Zone B box yields a public key, which is by construction not
sensitive (that's what makes public-key auth work at all).

### Concrete mechanism — restricted pull user

Zone B's `sshd` gets one additional user, `webdesk-backup-pull`, whose `authorized_keys` entry is
built to do exactly one thing:

```
command="rsync --server --sender -vlogDtprze.iLsfxC --numeric-ids . /var/lib/webdesk-backups/",
no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA...<target's public key>...
```

- `command="..."` — a **forced command**: no matter what command the connecting side requests,
  only this exact `rsync --sender` invocation runs. The target cannot get a shell, cannot run
  arbitrary commands, cannot write.
- `--sender` — rsync's own read-only mode; the daemon on Zone B's side only ever sends bytes, never
  accepts them.
- `no-pty`/`no-*-forwarding` — closes every side channel a forced-command setup is normally
  vulnerable to.
- The path is a **read-only bind mount** (`/var/lib/webdesk-backups:ro` into the container/host
  path rsync serves from) — even if the forced-command restriction were somehow bypassed, the
  filesystem permission is the second, independent wall.

Zone B's only actions in this whole flow: (a) run the local dump/mirror job that populates
`/var/lib/webdesk-backups` (§2), and (b) accept an inbound SSH connection it did not initiate,
authenticate the caller by public key, and stream bytes out. It never dials the target, never
holds the target's hostname as a *credential* (a hostname is not a secret), and never holds any
secret material belonging to the target.

---

## 2. Local layer — versioning + object lock (WORM)

Runs entirely on Zone B, no target involved. This is the "same-box compromise cannot silently
rewrite history" property (design §11).

```sh
# One-time bucket setup (idempotent — mc ignores an already-versioned/locked bucket).
mc alias set webdesk http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --with-lock webdesk/backups          # --with-lock is REQUIRED at creation time; cannot be
                                            # retrofitted onto an existing unlocked bucket
mc version enable webdesk/backups
mc retention set --default GOVERNANCE 30d webdesk/backups
```

`GOVERNANCE` (not `COMPLIANCE`) mode is deliberate: it blocks deletion/overwrite for ordinary
credentials (including a compromised `webdesk_app`-tier identity) while still letting an operator
holding the MinIO **root** credential override it in a genuine emergency (e.g., a legal hold
release or a provably-corrupt object). `COMPLIANCE` mode would block even that — appropriate for
regulated retention, not for an early-stage platform that needs an escape hatch. This mirrors the
mode WSK-07 already verified for the `uploads`/`media` buckets (PROGRESS row WSK-07: "GOVERNANCE
object-lock verified via `mc`") — same tool, same mode, applied to a new `backups` bucket.

Nightly job (`webdesk-backup-local.sh`, §4): `pg_dump` the Zone B database, `gzip`, write into
`webdesk/backups/pg/<date>.sql.gz` via `mc cp`. Because the bucket is versioned + locked, even a
`mc rm` issued by a compromised `webdesk_app`-scoped credential cannot make yesterday's dump
disappear — it can at most add a new (locked) version or fail outright, per the credential's
actual bucket policy (which must **not** include the root/admin credential — see WSK-07's own
already-flagged gap: `STORAGE_ACCESS_KEY_ID` unset falls back to MinIO root, "dev-only, must be a
scoped service account before A-12's box").

---

## 3. Offsite layer — pull target, by phase

| Phase | Target | Credential Zone B holds for it | Notes |
|---|---|---|---|
| **Now (this ticket's default)** | A second estate box, reachable over the estate's existing SSH topology | **None** — see §1's mechanism | Zero new recurring cost |
| **At staging** | Google Workspace (Drive/Shared Drive), dedicated service account | **None** — the service account credential lives on the puller, which runs a scheduled job (e.g. `rclone` with a Workspace service-account key) that reads Zone B over the same restricted-rsync mechanism, encrypts, then uploads to Drive under its own auth | Drive is version history + trash retention, **not** object-lock immutability — design §11's caveat. Encrypt (`age` or `gpg`, target's public key) **before** upload so Drive-side access is not equivalent to backup access. |
| **Target-state** | Local server + NAS (RAID) | **None** | RAID is redundancy, not backup — the offsite copy stays mandatory even here (design §11: "RAID is not a backup") |

The puller side (not this ticket's box, since the box doesn't exist — but documented so whoever
stands up the second estate box has the counterpart instructions):

```sh
# Runs ON THE TARGET, on its own cron, using ITS OWN key (private half of the authorized_keys
# entry in §1). Zone B is never told this job exists beyond accepting the inbound connection.
rsync -avz --numeric-ids -e "ssh -i /path/to/target-only-key" \
  webdesk-backup-pull@$ZONEB_HOST:/var/lib/webdesk-backups/ \
  /srv/webdesk-offsite/$(date +%F)/
```

---

## 4. `wd-backup-sentinel` — staleness detection

File: `webdesk/ops/scripts/wd-backup-sentinel.sh` (this ticket). Pattern deliberately mirrors
`infra/scripts/restore-drill.sh`'s existing dead-man's-switch discipline (two independent alert
transports, a positive ping on success so a *silently stopped* cron is itself detectable) rather
than inventing a new alerting shape.

What it checks, each run:
1. The newest object under `webdesk/backups/pg/` (via `mc ls`) is younger than
   `WD_BACKUP_MAX_AGE_HOURS` (default 26 — one nightly cycle plus slack).
2. The local dump job's last exit code (written to a sentinel file by
   `webdesk-backup-local.sh`) was 0.
3. *(Once the puller side exists)* optionally cross-checks a heartbeat object the puller writes
   back after a successful pull — this is the only piece that needs the target to cooperate, and
   it is a **write of a heartbeat timestamp**, not a credential, so it does not reopen §1's
   guarantee: even if that heartbeat write were forged, the worst case is a false "pull succeeded"
   read, not a target compromise.

On any failure: alert via the same two-transport pattern as `restore-drill.sh` (Telegram +
email), and exit non-zero so it can also be wired as a container healthcheck / cron failure. On
success: ping a dead-man's-switch URL, so **a stopped cron reads as a failure**, not as silence.

**Verified how:** the script's age/exit-code logic was unit-run against a throwaway `mc` alias
pointed at a local MinIO container started for this ticket (`docker run --rm -d minio/minio:...
server /data`), with a fabricated stale object proving the age check fires and a fresh object
proving it doesn't — see §7. The alert-transport calls (Telegram/email) were **not** driven (no
real bot token available in this ticket) — authored against the same call shape
`restore-drill.sh` already uses in production, unverified here.

---

## 5. Stated RTO/RPO and what they assume

| Tier | RPO (target) | RTO (target) | Assumes |
|---|---|---|---|
| Zone B Postgres (tenants/sites/api_keys/releases/audit/forms) | **≤ 24h** (one nightly dump cycle) | **≤ 2h** to a working restored database on a fresh instance | Restore follows the same throwaway-container pattern as `infra/scripts/restore-drill.sh` (start `postgres:16-alpine`, `psql` the newest dump, integrity-check ≥1 table) — not yet built for Zone B specifically, so the 2h figure is an estimate from that precedent, not a measured number |
| Zone B MinIO (media/video/uploads/artifacts) | **≤ 24h** for content that changed since the last mirror; **0** for anything still in local versioned storage (object-lock keeps prior versions live on-box even before the offsite copy is consulted) | **Depends on volume** — a full-bucket restore from the offsite pull target is bandwidth-bound, not measured | No number exists yet because no offsite target exists yet to restore from and time |
| Whole-box loss (box itself destroyed/unreachable) | Same as the Postgres/MinIO rows — the offsite copy is what survives | **Unknown — box provisioning time dominates.** A fresh box + hardening runbook (this ticket, §3-6 of the hardening runbook) + restore from offsite is realistically **measured in hours to low-single-digit days** once A-12 lands, not minutes; this platform does not yet have a hot-standby box, which would be the only way to get whole-box RTO into minutes | No hot standby exists or is funded (WSK-D23: "no new recurring cost is accepted at this stage") |

**These are targets, not measurements.** Per the estate's `restore-drill.md` precedent ("Copy the
observed RTO/RPO from the log into the table... After a few runs"), the honest move is to publish
the intended numbers now and replace every row with an *observed* number once a Zone B restore
drill has actually run — which needs the box (or, for the Postgres/MinIO restore mechanics
specifically, could be dev-verified earlier against the dev-topology compose stack; that
extension is scoped, not yet built, and is called out explicitly in §8 as a gap this ticket did
not close).

---

## 6. Restore drill (design, not yet a script)

`infra/scripts/restore-drill.sh` is the estate's existing pattern (isolated throwaway Postgres,
never touches the live DB, logs RTO/RPO, dead-man's-switch ping on success). A `webdesk`-specific
equivalent needs, additionally, a MinIO-side restore leg (restore a bucket snapshot into a
throwaway MinIO container and assert object count/checksums match the manifest) that
`restore-drill.sh` has no precedent for (Zone A has no self-hosted object store to restore).
**This script does not exist yet** — building it was judged out of this ticket's already-large
scope (see §8) and is the top item to hand to the next Zone-B-ops ticket or to the owner as a
follow-up.

---

## 7. What was actually driven in this ticket (dev-machine proof, not the box)

```
docker run --rm -d --name wsk28-minio-check -p 19000:9000 -p 19001:9001 \
  -e MINIO_ROOT_USER=devroot -e MINIO_ROOT_PASSWORD=devpassword12345 minio/minio:RELEASE.2024-01-01T16-36-33Z \
  server /data --console-address :9001
mc alias set wsk28check http://localhost:19000 devroot devpassword12345
mc mb --with-lock wsk28check/backups
mc version enable wsk28check/backups
mc retention set --default GOVERNANCE 30d wsk28check/backups
```
This proved: (a) the exact `mc` command sequence in §2 is syntactically correct and completes
with exit 0 against a real (if throwaway, if not the pinned production MinIO version) instance;
(b) `wd-backup-sentinel.sh`'s age-check logic correctly flags a fabricated stale object and
correctly passes a fresh one. It did **not** prove: real `pg_dump` volumes, real network
conditions, real restore timing, or anything about the pull-model SSH mechanism (§1), which needs
two real hosts to demonstrate — that is squarely a WSK-30 (P4 boundary gate) item, not something a
single dev machine can honestly claim.

---

## 8. What the owner must provide before this can be driven for real

1. **A-12** — the Zone B box itself.
2. **The second estate box** (or confirmation of which existing box plays "pull target" for the
   "now" phase) and SSH access to configure the restricted pull user's counterpart job on it.
3. **The Google Workspace service account** for the staging-phase target, scoped to a specific
   Shared Drive, per design §11.
4. A decision on whether the Zone-B-specific restore-drill script (§6) is built as a follow-up
   ticket now or deferred to WSK-30.

## 9. Status vocabulary reminder

Nothing above is DEV-VERIFIED. §2's `mc` commands and §4's sentinel age-check logic are
**PROTOTYPED** (driven against a throwaway MinIO container, §7). Everything else — the pull
mechanism end-to-end, the restore drill, the RTO/RPO numbers — is **PLANNED**.
