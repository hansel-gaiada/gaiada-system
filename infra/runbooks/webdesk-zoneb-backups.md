# Runbook — WebDesk Zone B backups, pull-model + object lock (WSK-28 / WSK-D23 / WSK-52)

> **WSK-52 (WSK-D42, 2026-10-10): object storage is RustFS, not MinIO.** RustFS ships no `mc`, so
> the bucket setup in §2 is now `webdesk/scripts/storage-bootstrap.mjs` (S3 API + RustFS admin API),
> the nightly mirror and the sentinel use `curl --aws-sigv4`, and both authenticate with a
> dedicated backup-writer key (never root). §2, §4 and §7 below are rewritten accordingly; the dated
> MinIO-era results are kept only where marked.

**Status: PLANNED (design + scripts authored) / PROTOTYPED where noted.** The box does not exist
(A-12). Every command here is written against the real `webdesk/docker-compose.yml` service
names and `webdesk/scripts/storage-bootstrap.mjs`, and the two scripts it references
(`webdesk/ops/scripts/webdesk-backup-local.sh`, `webdesk/ops/scripts/wd-backup-sentinel.sh`) were
exercised against a throwaway RustFS container on a Linux server (see §7 for what that did and
did not prove). Nothing here has run against Zone B's real Postgres/RustFS on a real box.

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
# One-time bucket + user setup (idempotent — a second run prints STORAGE_BOOTSTRAP changes=0).
# Root credential, used ONLY here. Needs `npm ci` in webdesk/api (it uses the AWS SDK from there).
STORAGE_ENDPOINT=http://rustfs:9000 RUSTFS_ROOT_USER=... RUSTFS_ROOT_PASSWORD=... \
STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
WEBDESK_BACKUP_ACCESS_KEY_ID=... WEBDESK_BACKUP_SECRET_ACCESS_KEY=... \
  node webdesk/scripts/storage-bootstrap.mjs
```

What it does for the `backups` bucket: creates it with object lock ENABLED AT CREATION (required;
it cannot be retrofitted onto an existing unlocked bucket), enables versioning, sets default
retention GOVERNANCE for 30 days (`WEBDESK_BACKUP_RETENTION_DAYS`), and — when the two
`WEBDESK_BACKUP_*` variables are set — creates the backup-writer user (policy `webdesk-backup`:
put/get/list on `backups` only; no delete, no policy/lock/versioning changes, no access to the
other buckets).

`GOVERNANCE` (not `COMPLIANCE`) mode is deliberate: it blocks deletion/overwrite for ordinary
credentials (including a compromised `webdesk_app`-tier identity) while still letting an operator
holding the RustFS **root** credential (with the governance-bypass header) override it in a genuine emergency (e.g., a legal hold
release or a provably-corrupt object). `COMPLIANCE` mode would block even that — appropriate for
regulated retention, not for an early-stage platform that needs an escape hatch. This mirrors the
mode WSK-07 configured for the `uploads`/`media` buckets (verified then via `mc`; re-proven for RustFS
through the S3 API by WSK-52 — see §7) — same mode, applied to a new `backups` bucket.

Nightly job (`webdesk-backup-local.sh`, §4): `pg_dump` the Zone B database, `gzip`, write into
`webdesk/backups/pg/<date>.sql.gz` with a signed `curl` PUT. Because the bucket is versioned +
locked, even a delete issued by a compromised credential cannot make yesterday's dump disappear —
it can at most add a new (locked) version or fail outright. The writer key (`webdesk-backup`
policy) has no delete permission at all and is NOT the root credential. WSK-07's carried gap
(`STORAGE_ACCESS_KEY_ID` unset fell back to storage root) is closed by WSK-52: the api now refuses
to boot without its own least-privilege key, and the backup scripts use a separate key.

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
1. The newest object under `webdesk/backups/pg/` (ListObjectsV2 over `curl --aws-sigv4`, every page) is younger than
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

**Verified how:** see §7 (WSK-52 re-run against a real RustFS container on Linux). The alert-transport calls (Telegram/email) were **not** driven (no
real bot token available in this ticket) — authored against the same call shape
`restore-drill.sh` already uses in production, unverified here.

---

## 5. Stated RTO/RPO and what they assume

| Tier | RPO (target) | RTO (target) | Assumes |
|---|---|---|---|
| Zone B Postgres (tenants/sites/api_keys/releases/audit/forms) | **≤ 24h** (one nightly dump cycle) | **≤ 2h** to a working restored database on a fresh instance | Restore follows the same throwaway-container pattern as `infra/scripts/restore-drill.sh` (start `postgres:16-alpine`, `psql` the newest dump, integrity-check ≥1 table) — not yet built for Zone B specifically, so the 2h figure is an estimate from that precedent, not a measured number |
| Zone B RustFS (media/video/uploads/artifacts) | **≤ 24h** for content that changed since the last mirror; **0** for anything still in local versioned storage (object-lock keeps prior versions live on-box even before the offsite copy is consulted) | **Depends on volume** — a full-bucket restore from the offsite pull target is bandwidth-bound, not measured | No number exists yet because no offsite target exists yet to restore from and time |
| Whole-box loss (box itself destroyed/unreachable) | Same as the Postgres/RustFS rows — the offsite copy is what survives | **Unknown — box provisioning time dominates.** A fresh box + hardening runbook (this ticket, §3-6 of the hardening runbook) + restore from offsite is realistically **measured in hours to low-single-digit days** once A-12 lands, not minutes; this platform does not yet have a hot-standby box, which would be the only way to get whole-box RTO into minutes | No hot standby exists or is funded (WSK-D23: "no new recurring cost is accepted at this stage") |

**These are targets, not measurements.** Per the estate's `restore-drill.md` precedent ("Copy the
observed RTO/RPO from the log into the table... After a few runs"), the honest move is to publish
the intended numbers now and replace every row with an *observed* number once a Zone B restore
drill has actually run — which needs the box (or, for the Postgres/RustFS restore mechanics
specifically, could be dev-verified earlier against the dev-topology compose stack; that
extension is scoped, not yet built, and is called out explicitly in §8 as a gap this ticket did
not close).

---

## 6. Restore drill (design, not yet a script)

`infra/scripts/restore-drill.sh` is the estate's existing pattern (isolated throwaway Postgres,
never touches the live DB, logs RTO/RPO, dead-man's-switch ping on success). A `webdesk`-specific
equivalent needs, additionally, an object-storage-side restore leg (restore a bucket snapshot into a
throwaway RustFS container and assert object count/checksums match the manifest) that
`restore-drill.sh` has no precedent for (Zone A has no self-hosted object store to restore).
**This script does not exist yet** — building it was judged out of this ticket's already-large
scope (see §8) and is the top item to hand to the next Zone-B-ops ticket or to the owner as a
follow-up.

---

## 7. What was actually driven (dev proof, not the box)

**WSK-52, 2026-10-10 — real `rustfs/rustfs:1.0.0` container on a Linux server (docker network, no host ports):**

- `storage-bootstrap.mjs` run twice: first run created the five buckets with object lock +
  versioning + default retention (GOVERNANCE 1d; `backups` 30d) and the users/policies; second run
  `STORAGE_BOOTSTRAP changes=0`. A governed object version was refused deletion even for root
  without the bypass header ("Object is under GOVERNANCE retention ..."); the same delete succeeded
  on an unlocked versioned control bucket.
- `webdesk-backup-local.sh` against a throwaway Postgres (superuser URL): dump gzipped, uploaded with
  `curl --aws-sigv4` + signed payload hash, size verified by HEAD (55495 bytes), sentinel written.
  A bad database URL now FAILS the script (see the pg_dump note below); using the api's key (not the
  backup key) is refused 403.
- `wd-backup-sentinel.sh`: fresh backup → OK (exit 0); wrong key → alert/exit 1; empty prefix →
  "no objects found" alert/exit 1; stale local sentinel → alert/exit 1. NOT driven: the
  bucket-side stale-object branch in isolation (the local sentinel-file check trips first with the
  same window) and the Telegram/email transports.
- **Defect found and fixed in `webdesk-backup-local.sh`:** `pg_dump "$URL" | gzip > out || fail` only
  tested gzip's exit status, so a failed `pg_dump` still produced a valid empty `.gz`, was
  "mirrored ok" and recorded `exit_code=0`. It now dumps to a temp file and checks `pg_dump` itself.
- **Open finding (not fixed here):** with the project's role bootstrap, `webdesk_owner`/`webdesk_migrator`
  are NOBYPASSRLS and the tables are FORCE RLS, so `pg_dump` as those roles fails ("query would be
  affected by row-level security policy for table api_keys"). Until `OWNER_DATABASE_URL` points at a
  role that may read every row (a superuser or a BYPASSRLS backup role), this nightly job fails — now
  loudly, where before it silently shipped an empty dump. Needs an owner decision on which role dumps.

**WSK-28 original (MinIO-era, kept as history):** the `mc` sequence (`mb --with-lock`, `version enable`,
`retention set --default GOVERNANCE 30d`) was syntax-checked against a throwaway
`minio/minio:RELEASE.2024-01-01T16-36-33Z` container and the sentinel's age logic against a fabricated
stale object. Superseded by the WSK-52 run above.

Neither run proved: real `pg_dump` volumes, real network conditions, real restore timing, or
anything about the pull-model SSH mechanism (§1), which needs two real hosts to demonstrate — that
is squarely a WSK-30 (P4 boundary gate) item, not something a single dev machine can honestly claim.

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

Nothing above is DEV-VERIFIED. §2's bootstrap and the §4 sentinel + local mirror are
**PROTOTYPED** (driven against a throwaway RustFS container, §7). Everything else — the pull
mechanism end-to-end, the restore drill, the RTO/RPO numbers — is **PLANNED**.
