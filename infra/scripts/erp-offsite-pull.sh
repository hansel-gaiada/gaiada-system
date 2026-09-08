#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════════════════
# ERP offsite backup — PULL side (runs on sumopod, 10.88.0.2)
#
# Closes Fault Register finding 02: aicenter's only backups lived in $HOME on aicenter, so
# any event that took the box took the backups with it.
#
# ── THREE PROPERTIES THIS SCRIPT EXISTS TO HOLD. Do not "simplify" any of them away. ───────
#
# 1. PULL, NEVER PUSH. sumopod holds a key to aicenter (forced-command, read-only, three
#    verbs, source-pinned to the WireGuard address). aicenter holds NO key to sumopod. That
#    asymmetry is the whole design: a fully-compromised aicenter cannot reach, alter or
#    delete its own offsite copy. A push from aicenter would hand an attacker exactly the
#    credential needed to destroy the backups after encrypting the primary — which is how
#    ransomware actually ends.
#
# 2. NO DELETE PROPAGATION. There is deliberately no rsync --delete and no "mirror the
#    source" step. Retention here is age-based and decided LOCALLY. If someone wipes
#    aicenter's backup directory, this script notices files are missing and keeps its copies
#    anyway. A mirror would faithfully replicate the wipe, which is the single most common
#    way an offsite backup turns out to be worthless.
#
# 3. PLAINTEXT NEVER LANDS ON THIS DISK. sumopod runs ~49 containers across 12 unrelated
#    projects including a sandbox that executes employee-written code. The ERP's ledger, HR
#    records and client data must not sit readable there. Each file is encrypted IN THE PIPE
#    with age; the recipient is an ed25519 public key whose private half exists only on the
#    owner's machine. This host can write backups it can never read.
#
# ── INTEGRITY ──────────────────────────────────────────────────────────────────────────────
# The source's own sha256 is fetched separately and compared against a hash computed from the
# bytes actually received, BEFORE encryption. A mismatch discards the file rather than keeping
# a corrupt copy — a backup you cannot restore is worse than a missing one, because it reads
# as success on every dashboard.
# ═══════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REMOTE="Hansel@10.88.0.1"          # aicenter, over WireGuard only — never the public IP
KEY="$HOME/.ssh/erp_pull_ed25519"
BASE="$HOME/erp-offsite"
DATA="$BASE/data"
STATE="$BASE/state"
RECIPIENT="$BASE/recipient.pub"
LOG="$STATE/pull.log"
# Metrics live OUTSIDE the 0700 backup dir on purpose: node-exporter runs as `nobody` and
# cannot read that directory, so a .prom written there is collected by nothing. These values
# are counts, sizes and timestamps — no secrets — so a 0755 dir under /var/lib is correct.
METRICS="/var/lib/node_exporter/textfile/gaiada_backup.prom"
LOCK="$STATE/pull.lock"

KEEP_DAYS="${KEEP_DAYS:-90}"       # rolling window; monthly keeps are exempt (see prune())
MIN_FREE_GB="${MIN_FREE_GB:-15}"   # sumopod's disk has gone 49%->75% in an hour before now

mkdir -p "$DATA" "$STATE"
exec 9>"$LOCK"
flock -n 9 || { echo "$(date -uIs) another run holds the lock; exiting" >>"$LOG"; exit 0; }

log() { echo "$(date -uIs) $*" >>"$LOG"; }
# -n is LOAD-BEARING, not tidiness. Without it ssh inherits and drains the read loop's
# stdin (the file listing), so the FIRST remote call swallows the whole list and the run
# completes after exactly one file — reporting pulled=1, failed=0, i.e. SUCCESS. Found on
# the first live run; the failure mode is a green backup holding 1% of the set.
remote() { ssh -n -i "$KEY" -o BatchMode=yes -o ConnectTimeout=15 \
                -o StrictHostKeyChecking=accept-new "$REMOTE" "$@"; }

started=$(date +%s)
pulled=0; skipped=0; failed=0; corrupt=0

# ── Disk guard ─────────────────────────────────────────────────────────────────────────────
# Refuse rather than fill the disk. sumopod also carries the estate's whole observability
# stack; filling this disk blinds monitoring for every other host at the same time.
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
if [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
  log "REFUSING: only ${free_gb}G free on / (floor ${MIN_FREE_GB}G). Run 'docker builder prune -a'."
  printf 'gaiada_backup_pull_ok 0\ngaiada_backup_disk_free_gb %s\n' "$free_gb" >"$METRICS"
  exit 1
fi

# ── Pull ───────────────────────────────────────────────────────────────────────────────────
log "run start (free ${free_gb}G, keep ${KEEP_DAYS}d)"
listing=$(remote list) || { log "FATAL: cannot list remote"; printf 'gaiada_backup_pull_ok 0\n' >"$METRICS"; exit 1; }

while IFS=$'\t' read -r name size mtime; do
  [ -n "${name:-}" ] || continue
  dest="$DATA/${name}.age"
  if [ -f "$dest" ]; then skipped=$((skipped+1)); continue; fi

  want=$(remote "sha256 $name" 2>/dev/null) || { log "WARN sha256 failed: $name"; failed=$((failed+1)); continue; }

  tmp="$dest.partial"
  hashfile="$STATE/.h.$$"
  # tee splits the stream: one copy to sha256sum, one into age. Plaintext exists only in the
  # pipe — it is never written to this filesystem, not even transiently.
  if remote "cat $name" | tee >(sha256sum | cut -d' ' -f1 >"$hashfile") \
       | age -R "$RECIPIENT" >"$tmp" 2>/dev/null; then
    got=$(cat "$hashfile" 2>/dev/null || echo none)
    rm -f "$hashfile"
    if [ "$got" = "$want" ]; then
      # Record the PLAINTEXT hash beside the ciphertext so a future restore can prove the
      # decrypted bytes are the bytes aicenter dumped, not merely that age decrypted cleanly.
      printf '%s  %s\n' "$want" "$name" >"$dest.sha256"
      mv -f "$tmp" "$dest"
      pulled=$((pulled+1))
      log "ok   $name ($size bytes -> $(stat -c%s "$dest") enc)"
    else
      rm -f "$tmp"
      corrupt=$((corrupt+1))
      log "CORRUPT $name: source=$want received=$got — discarded, will retry next run"
    fi
  else
    rm -f "$tmp" "$hashfile"
    failed=$((failed+1))
    log "FAIL $name: transfer or encrypt error"
  fi
done <<<"$listing"

# ── Retention — decided here, never mirrored from the source ───────────────────────────────
# Rolling KEEP_DAYS window, but anything stamped on the 1st of a month is exempt and kept for
# a year. That gives a restore point per month without holding 365 daily sets of a 53 MB dump.
prune() {
  local removed=0
  while IFS= read -r f; do
    local b; b=$(basename "$f")
    # Filenames carry -YYYYMMDD-HHMMSS; day "01" is a monthly keep.
    if [[ "$b" =~ -[0-9]{6}01-[0-9]{6}\. ]]; then
      # monthly: only drop past a year
      if [ "$(find "$f" -mtime +365 -print -quit)" ]; then rm -f "$f" "${f%.age}.age.sha256" 2>/dev/null; removed=$((removed+1)); fi
    else
      if [ "$(find "$f" -mtime +"$KEEP_DAYS" -print -quit)" ]; then rm -f "$f" "${f%.age}.age.sha256" 2>/dev/null; removed=$((removed+1)); fi
    fi
  done < <(find "$DATA" -maxdepth 1 -type f -name '*.age')
  log "retention: removed $removed"
}
prune

# ── Metrics for the Prometheus already running on this box ─────────────────────────────────
# node-exporter textfile collector. The alert that matters is staleness: this file's
# last_success timestamp going quiet is what tells you the offsite copy stopped, which is
# precisely the failure that was previously invisible.
# awk, NOT `sort | head -1`. head exits after one line, sort takes SIGPIPE, the pipeline
# returns 141, and under `set -o pipefail` + `set -e` that KILLS THE SCRIPT — silently, right
# here, after every file has already copied successfully. Observed on the first full run:
# 850 files / 5.6 GB landed perfectly and the metrics below were never written, so the
# freshness alerts would have reported a stale backup that was in fact complete. awk reads to
# EOF, so there is no SIGPIPE to propagate.
newest=$(find "$DATA" -maxdepth 1 -name '*.age' -printf '%T@\n' 2>/dev/null | sort -rn | awk 'NR==1{printf "%d", $1}')
total_bytes=$(du -sb "$DATA" 2>/dev/null | cut -f1)
count=$(find "$DATA" -maxdepth 1 -name '*.age' | wc -l)
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
# Written as an if, not `[ ] && ok=0` chains: under set -e a false test as the final
# component of an AND-list is a live foot-gun in exactly the run where something failed.
ok=1
if [ "$failed" -gt 0 ] || [ "$corrupt" -gt 0 ]; then ok=0; fi

cat >"$METRICS.tmp" <<EOF
# HELP gaiada_backup_pull_ok Last offsite pull completed with no failed or corrupt files.
# TYPE gaiada_backup_pull_ok gauge
gaiada_backup_pull_ok $ok
# HELP gaiada_backup_last_success_timestamp_seconds Unix time of the last successful pull run.
# TYPE gaiada_backup_last_success_timestamp_seconds gauge
gaiada_backup_last_success_timestamp_seconds $(date +%s)
# HELP gaiada_backup_newest_file_timestamp_seconds Mtime of the newest offsite artifact.
# TYPE gaiada_backup_newest_file_timestamp_seconds gauge
gaiada_backup_newest_file_timestamp_seconds ${newest:-0}
# HELP gaiada_backup_files_total Encrypted artifacts held offsite.
# TYPE gaiada_backup_files_total gauge
gaiada_backup_files_total $count
# HELP gaiada_backup_bytes_total Bytes held offsite.
# TYPE gaiada_backup_bytes_total gauge
gaiada_backup_bytes_total ${total_bytes:-0}
# HELP gaiada_backup_pulled_total Files fetched this run.
# TYPE gaiada_backup_pulled_total gauge
gaiada_backup_pulled_total $pulled
# HELP gaiada_backup_corrupt_total Files discarded this run on a hash mismatch.
# TYPE gaiada_backup_corrupt_total gauge
gaiada_backup_corrupt_total $corrupt
# HELP gaiada_backup_failed_total Files that errored in transfer this run.
# TYPE gaiada_backup_failed_total gauge
gaiada_backup_failed_total $failed
# HELP gaiada_backup_disk_free_gb Free space on the offsite host's root filesystem.
# TYPE gaiada_backup_disk_free_gb gauge
gaiada_backup_disk_free_gb $free_gb
EOF
mv -f "$METRICS.tmp" "$METRICS"
chmod 644 "$METRICS"

log "run end: pulled=$pulled skipped=$skipped failed=$failed corrupt=$corrupt elapsed=$(( $(date +%s) - started ))s total=$count files"
