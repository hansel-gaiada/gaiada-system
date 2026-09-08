# ERP offsite backup — sumopod tier 1

**Status: DEV-VERIFIED 2026-09-08.** Driven end to end, including a restore of a real
`gaiada_platform` dump. Closes the top operational risk in the 2026-09-08 fault register: before
this, every backup lived in `$HOME` on the same box it was backing up.

**Tier 2 (object storage) is deliberately NOT built** — owner decision 2026-09-08. sumopod and
gda-aicenter are two machines but one operator and one credential blast radius. Revisit before
running real books on the ledger.

---

## What it is

`gda-aicenter` dumps nightly at 03:15 UTC (unchanged — `infra/scripts/backup-cron.sh`).
`sumopod` **pulls** those dumps at 04:15 UTC over the WireGuard tunnel, encrypts each one in the
pipe, and keeps them under its own retention policy.

| | |
|---|---|
| Source | `gda-aicenter` `~/gaiada-backups/` (10.88.0.1 over `wg0`) |
| Destination | `sumopod` `~/erp-offsite/data/` (10.88.0.2), `*.sql.gz.age` + `.sha256` |
| Transport | WireGuard only — the key is pinned `from="10.88.0.2"` and will not work off-tunnel |
| Encryption | `age`, recipient = `~/.ssh/gaiada-backup-age.pub` (owner's laptop) |
| Retention | 90 days rolling; anything stamped on the 1st of a month kept 12 months |
| Scripts | `infra/scripts/erp-offsite-pull.sh` (sumopod) · `infra/scripts/erp-backup-read.sh` (aicenter) |
| Alerts | `infra/observability/prometheus/rules/backup-offsite.yml` — 6 rules |

---

## ⚠ The one irreplaceable thing

Backups are encrypted to a keypair generated on the owner's laptop:

```
.secrets/backup-keys/gaiada-backup-age       <- PRIVATE. Never committed (see below).
.secrets/backup-keys/gaiada-backup-age.pub   <- public, deployed to sumopod
~/.ssh/gaiada-backup-age{,.pub}              <- the original, same machine
```

The in-repo copy under `.secrets/backup-keys/` is for convenience — it lets the drill run from the
project. **It is not a second copy in any useful sense**: same laptop, same disk, so one failure
takes both. See `.secrets/backup-keys/README.md`.

`.secrets/` is ignored three independent ways *and* guarded by a `.git/hooks/pre-commit` that
refuses a commit staging key material by path or by content. The repo is PUBLIC; that redundancy
is deliberate. Verified 2026-09-08 by force-adding the key — the commit was refused, and
`git rev-list --all --objects | grep gaiada-backup-age` returns nothing.

Fingerprint: `SHA256:i2o1wsLgO60X47hB+GdAI6vWUNio9mJgjN9iuAv2HJg`

**sumopod cannot decrypt these files. aicenter cannot decrypt these files.** That is the property
that makes it acceptable to store the group's ledger and HR data on a shared personal VPS carrying
49 containers and a code-execution sandbox — and it means losing the private key is
indistinguishable from having no backups at all.

Store it in the password manager **and** somewhere physical. Verify yearly that the physical copy
still decrypts something (below).

---

## Three properties. Do not "simplify" any of them away.

**1 · Pull, never push.** sumopod holds a key to aicenter; aicenter holds no key to sumopod. A
fully-compromised ERP host therefore cannot reach, alter or delete its own offsite copy. Turning
this into a push from aicenter hands an attacker exactly the credential needed to destroy the
backups after encrypting the primary — which is how ransomware actually ends.

The key on aicenter is a forced command (`~/bin/erp-backup-read.sh`) with `restrict` and
`from="10.88.0.2"`. It permits exactly three verbs: `list`, `sha256 <file>`, `cat <file>`.
Verified 2026-09-08 — shell, arbitrary command, `../` traversal and absolute paths are all refused.

**2 · No delete propagation.** There is no `rsync --delete` and no mirror step. Retention is decided
on sumopod. If someone wipes aicenter's backup directory, sumopod keeps its copies. A mirror would
faithfully replicate the wipe, which is the most common way an offsite backup turns out to be
worthless.

**3 · Plaintext never lands on sumopod's disk.** Each file streams
`ssh cat` → `tee` → `age` → disk. The `tee` branch computes a sha256 of the received bytes, compared
against the source's own sha256 *before* the file is kept. A mismatch discards it rather than storing
a corrupt backup that reads as success on every dashboard.

---

## Verifying it works

```bash
# Is it current?  (should be today)
ssh sumopod 'tail -3 ~/erp-offsite/state/pull.log'
ssh sumopod 'ls -1 ~/erp-offsite/data/*.age | wc -l; du -sh ~/erp-offsite/data'

# Are the metrics reaching Prometheus?
ssh sumopod 'cat /var/lib/node_exporter/textfile/gaiada_backup.prom'
ssh sumopod 'docker exec gaiada-obs-prometheus-1 wget -qO- \
  "http://localhost:9090/api/v1/query?query=gaiada_backup_last_success_timestamp_seconds"'

# Prove the restricted key is still restricted (run after ANY authorized_keys change)
ssh sumopod 'ssh -n -i ~/.ssh/erp_pull_ed25519 Hansel@10.88.0.1 "cat ../.ssh/id_rsa"'   # -> refused: bad name
ssh sumopod 'ssh -n -i ~/.ssh/erp_pull_ed25519 Hansel@10.88.0.1 "rm -rf /tmp/x"'        # -> refused
```

## The restore drill — run quarterly, on the laptop

An untested backup is not a backup. This is the drill that was run on 2026-09-08.

```bash
F=$(ssh sumopod 'ls -1 ~/erp-offsite/data/gaiada_platform-*.age | tail -1')
scp sumopod:"$F" sumopod:"$F.sha256" .
B=$(basename "$F" .age)

age -d -i ~/.ssh/gaiada-backup-age "$B.age" > "$B"      # 1. decrypts?
sha256sum -c <(sed "s|\$| $B|" "$B.age.sha256")          # 2. byte-identical to what aicenter dumped?
gzip -t "$B"                                             # 3. valid gzip?
zcat "$B" | grep -c 'CREATE TABLE'                       # 4. real dump? (expect ~282)

shred -u "$B" 2>/dev/null || rm -f "$B"                  # 5. DO NOT leave plaintext on the laptop
```

A drill that only proves `age -d` succeeded has proven nothing about the contents. Steps 2–4 are
the drill; step 1 is a precondition.

---

## Alerts, and what each one means

Six rules in `backup-offsite.yml`. The two staleness rules are deliberately **separate** because
they send you to different hosts:

| Alert | Means | Go look at |
|---|---|---|
| `OffsiteBackupPullStale` | sumopod stopped **copying** | sumopod: `pull.log`, `wg0`, the pull key |
| `OffsiteBackupSourceStale` | aicenter stopped **producing** | aicenter: `~/gaiada-backups/backup.log`, disk |
| `OffsiteBackupCorrupt` | Hash mismatch; file was **discarded**, so it is NOT held offsite | tunnel, disk on either end |
| `OffsiteBackupPullFailing` | Transfer errors, next run retries | the forced-command wrapper, the key |
| `OffsiteBackupShrinkingFast` | Set shrank >20% in 1h — **not** retention | treat as deletion/tamper; look before re-running |
| `OffsiteBackupDiskLow` | sumopod under 25G; the pull refuses below 15G | `docker builder prune -a` (has returned 80G) |

---

## Traps found while building this — all cost real time

- **`ssh` inside a `while read` loop eats the loop's stdin.** The first live run reported
  `pulled=1 failed=0` — success — having copied 1% of the set. `remote()` uses `ssh -n` for this
  reason; removing it reintroduces a green backup that silently copies one file.
- **`sort | head -1` under `set -o pipefail` kills the script.** `head` exits after one line,
  `sort` takes SIGPIPE, the pipeline returns 141, and `set -e` terminates — *silently*, with no
  message in the log or in `nohup.out`. Observed on the first full run: all 850 files copied
  perfectly and then the metrics block never ran, so the freshness alerts would have reported a
  stale backup that was in fact complete. The `newest=` line uses `awk 'NR==1'` (reads to EOF, no
  SIGPIPE) for this reason. Any new pipeline added to this script must be checked the same way.
- **`pgrep -f <script>` matches your own ssh command.** Checking "is it still running" with
  `ssh host 'pgrep -f erp-offsite-pull.sh'` matches the ssh invocation itself and reports RUNNING
  forever. Poll for the `run end` line in `pull.log` instead — that is why the script writes one.
- **`docker-compose.obs-remote.yml` on sumopod is CRLF.** A `sed` anchored on `$` matches nothing
  and `sed -i` still exits 0, so the edit reports success and does not happen. Verify by grepping
  for the inserted text, never by trusting the exit code.
- **node-exporter runs as `nobody`** and cannot read the 0700 backup dir. Metrics go to
  `/var/lib/node_exporter/textfile/` (0755) instead — they carry counts, sizes and timestamps, no
  secrets.
- **sumopod's disk moves fast** (49% → 75% in one hour, from a build cache). The pull refuses to
  run below 15G rather than filling the disk that also carries the estate's entire observability
  stack — filling it would blind monitoring for every host at the same moment.

## If you ever need to re-key

1. Generate a new pair on the laptop: `ssh-keygen -t ed25519 -f ~/.ssh/gaiada-backup-age-NEW`
2. Copy the `.pub` to `sumopod:~/erp-offsite/recipient.pub`
3. **Keep the old private key forever** — existing `.age` files are still encrypted to the old
   recipient and re-encrypting 5 GB is not worth it. Note the cutover date here.
4. Re-run the drill against a file from *before* and *after* the cutover.
