# Runbook — enable estate blackbox probing (helios/delphi + client properties) and the
# account-manager alert routing split

**Status: PLANNED. Not yet executed against any host.** Implements
`docs/plans/2026-08-31-helios-delphi-plane-a-rollout.md`. Read that document first for the design
and the two corrections it makes to the original task framing (§0).

**Scope guard, restated:** this runbook touches **`sumopod`** (the observability host) and
**`gda-aicenter`** (the client-property target generator + the outside dead-man's-switch cron).
**It never touches `helios` or `delphi` in any step** — every probe of them is an outbound HTTP GET
from `sumopod`, which changes nothing on either box, per the observe-only ruling
(`docs/plans/2026-08-21-multi-server-observability.md` §12).

---

## 0. Pre-flight — read before running anything

1. **Fresh `docker ps -a` baseline on `sumopod`, this session, never a written-down number**
   (same rule `infra/runbooks/onboard-server.md` §2.1 gives for any host on this box):
   ```sh
   ssh sumopod "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'" \
     > rollout-sumopod-ps-before.txt
   ```
2. **Confirm the checkout on SumoPod is the hand-maintained one, not tag-deployed.** SumoPod's
   `~/gaiada-obs/infra/` is rsynced by a human, not by `deploy.yml` (`deploy.yml`'s
   `COMPOSE_FILES`/rsync only ever touches `gda-aicenter` — `infra/CLAUDE.md`). Every file changed
   in this rollout must be **manually rsynced** to `sumopod:~/gaiada-obs/infra/...` — pushing a
   tag does **not** ship any of it there.
3. **Never bare `--remove-orphans` on `sumopod`; every command scoped `-p gaiada-obs`.** That box
   runs the owner's private production alongside this stack.
4. **Do not populate `targets/blackbox-estate.json` with a guessed endpoint.** It ships empty in
   this rollout on purpose (OQ-6 is still open — no owner-named endpoints exist yet). Steps 1–5
   below work correctly with it empty: the job scrapes nothing, fires nothing, and the rest of the
   rollout (client-property probing, the alerting split, the dead-man's-switch leg) is independent
   of it.

---

## 1. Dry-run the compose change before touching the live project

```sh
# From a machine with the updated repo checked out (or after step 2's rsync, ON sumopod):
cd infra/compose
OBS_BIND_ADDR=10.88.0.2 GRAFANA_ADMIN_PASSWORD=x TELEGRAM_BOT_TOKEN=x ALERT_CHAT_ID=0 \
  docker compose -p gaiada-obs -f docker-compose.obs-remote.yml config -q
echo "exit=$?"   # 0 = the compose file parses; non-zero = STOP, fix before rsyncing to the box
```
`config -q` is a true dry run — it does not start anything. Fill only the vars needed to satisfy
required-value checks (`GRAFANA_ADMIN_PASSWORD`, etc.); real values are already on the box's own
`.env` and are not needed for this parse check.

## 2. Ship the changed files to `sumopod` (rsync, never a hand-typed edit on the box)

```sh
rsync -az --checksum \
  infra/observability/prometheus/prometheus.remote.yml \
  infra/observability/prometheus/rules/alerts.yml \
  infra/observability/prometheus/rules/alerts-estate.yml \
  infra/observability/prometheus/targets/ \
  sumopod:~/gaiada-obs/infra/observability/prometheus/

rsync -az --checksum infra/observability/alertmanager/alertmanager.yml \
  sumopod:~/gaiada-obs/infra/observability/alertmanager/alertmanager.yml

rsync -az --checksum infra/compose/docker-compose.obs-remote.yml \
  sumopod:~/gaiada-obs/infra/compose/docker-compose.obs-remote.yml
```
A hand-applied infra change has a documented maximum lifetime of one deploy elsewhere in this
estate — irrelevant here specifically because `sumopod`'s checkout is never touched by
`deploy.yml` in the first place, but it means the reverse risk applies: nothing will re-sync this
for you either. Keep this checkout intentionally in step with git, and note the sync in the plan
doc's changelog if this runbook is re-run after further edits.

## 3. Wire the two new env vars into SumoPod's own `.env` (NOT `.env.example` — that file only
   documents; the live values live on the box)

```sh
ssh sumopod "test -f ~/gaiada-obs/infra/compose/.env && echo exists || echo MISSING-STOP"
```
If it exists, append (do not overwrite):
```sh
ssh sumopod 'cat >> ~/gaiada-obs/infra/compose/.env <<EOF

# 2026-08-31 rollout — account-manager alert transport, separate from the engineering ALERT_* vars.
AM_ALERT_WEBHOOK_URL=
AM_ALERT_EMAIL_TO=
EOF'
```
**Leave both blank until the account-manager team's real webhook/email is known** — per
`infra/runbooks/alerting-wire-a-real-receiver.md`, a receiver with a placeholder transport fails
loudly in the Alertmanager log, which is correct and strictly better than the pre-2026-08-23 state
(silent swallow). Do not invent a value to make the parse check pass.

## 4. Validate the rules and Alertmanager config ON THE BOX, without touching the live mounted files

Same scratch-copy technique the MSO-02 verification already used (design doc §8) — never edit the
live mounted `/etc/prometheus/rules/*.yml` or `/etc/alertmanager/alertmanager.yml` in place:

```sh
ssh sumopod bash -s <<'EOF'
set -e
docker cp gaiada-obs-prometheus-1:/etc/prometheus/rules /tmp/rules-check
docker run --rm -v /tmp/rules-check:/rules prom/prometheus:v3.1.0 \
  promtool check rules /rules/alerts.yml /rules/alerts-estate.yml /rules/slo.yml
rm -rf /tmp/rules-check

docker cp gaiada-obs-alertmanager-1:/etc/alertmanager /tmp/am-check
docker run --rm -v /tmp/am-check:/am prom/alertmanager:v0.28.0 \
  amtool check-config /am/alertmanager.yml
docker run --rm -v /tmp/am-check:/am prom/alertmanager:v0.28.0 \
  amtool config routes test --config.file=/am/alertmanager.yml \
  severity=client_page > /tmp/route-test-page.txt
docker run --rm -v /tmp/am-check:/am prom/alertmanager:v0.28.0 \
  amtool config routes test --config.file=/am/alertmanager.yml \
  severity=client_ticket > /tmp/route-test-ticket.txt
grep -q account-managers /tmp/route-test-page.txt && echo "PASS: client_page -> account-managers" || echo "FAIL"
grep -q account-managers /tmp/route-test-ticket.txt && echo "PASS: client_ticket -> account-managers" || echo "FAIL"
rm -rf /tmp/am-check /tmp/route-test-*.txt
EOF
```
**Abort here if either check fails.** Nothing below assumes the config is correct without this
passing.

## 5. Bring up `blackbox-exporter`, scoped, and reload Prometheus/Alertmanager

```sh
ssh sumopod "cd ~/gaiada-obs/infra/compose && \
  docker compose -p gaiada-obs -f docker-compose.obs-remote.yml up -d --no-recreate blackbox-exporter"
```
`--no-recreate` is deliberate on every OTHER service in this command — this step must add exactly
one container, never touch prometheus/alertmanager/loki/tempo/grafana/ntfy/node-exporter, which
are all already running and healthy.

Bind-mounted config does not hot-reload on content change alone (the relocation doc's own
finding) — Prometheus's `rule_files`/`scrape_configs` and Alertmanager's config both need an
explicit reload:
```sh
ssh sumopod "curl -s -X POST http://10.88.0.2:19090/-/reload"   # picks up the new rule file + jobs
ssh sumopod "docker restart gaiada-obs-alertmanager-1"           # picks up the new receiver/route
```
`--web.enable-lifecycle` is already on (see `docker-compose.obs-remote.yml`'s prometheus command),
so the Prometheus reload is a live HTTP call — no restart, no dropped scrape cycle.

## 6. Verify

```sh
# Exactly one new container, nothing else touched:
ssh sumopod "docker ps -a --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}'" \
  > rollout-sumopod-ps-after.txt
diff rollout-sumopod-ps-before.txt rollout-sumopod-ps-after.txt

# The two new jobs are registered (targets may show 0 scraped instances — expected while
# blackbox-estate.json is still empty and before client-properties.json's first sync):
curl -s http://10.88.0.2:19090/api/v1/targets | grep -o '"job":"[^"]*"' | sort -u

# The new rule groups loaded:
curl -s http://10.88.0.2:19090/api/v1/rules | grep -o '"name":"[^"]*"' | sort -u | grep -E 'blackbox|client_prop'
```

## 7. Wire the client-property targets (M6-P3d: the ERP renders, sumopod pulls)

Why this shape: gda-aicenter has no Node and no DB login that can read `search_properties` across
tenants, so the old `sync-client-property-targets.sh` (push from aicenter) never ran and the target
file stayed `[]`. Now the platform container renders the file itself (same selection and labels as
`gen-client-property-targets.mjs`, pinned by a parity test), and sumopod pulls ONLY that file over
an SSH key whose `command=` prints that one file and nothing else. No DB role, no new port, no
inventory on sumopod.

Placeholders: `<erp-host>` / `<erp-user>` = gda-aicenter address and a login user that can read the
host dir; `<sumopod-ip>` = sumopod's address as aicenter sees it (the WireGuard address). Substitute on the box.

**7a. gda-aicenter: host dir, env, deploy**
```sh
# Host directory the platform container writes into (bind-mounted by docker-compose.vps.yml).
sudo install -d -m 0755 -o root -g root /var/lib/gaiada/client-targets
# Env (box .env, the file the compose invocation reads), then recreate ONLY platform:
#   CLIENT_PROPERTY_TARGETS_PATH=/var/lib/gaiada/client-targets/client-properties.json
# (CLIENT_PROPERTY_TARGETS_INTERVAL_MS stays blank = 5 minutes.)
# Tag parity first (infra/CLAUDE.md "stale .env"), then, per the file-set rule:
cd ~/gaiada/infra/compose
docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml up -d --no-build platform
```
The first render happens about 15 s after boot. Verify:
```sh
docker compose ... logs platform | grep 'MON-01 probe-target file on'
ls -l /var/lib/gaiada/client-targets/client-properties.json      # 0644, root, non-zero size
head -c 600 /var/lib/gaiada/client-targets/client-properties.json
```
Expect real entries once any property is verified (`[]` only if the DB truly has none; the renderer
never writes `[]` over a non-empty file until three consecutive runs agree). A `render failed` log line
means the previous file was left in place.

**7b. sumopod: a dedicated key (no passphrase, used only for this)**
```sh
ssh-keygen -t ed25519 -N '' -C 'sumopod client-targets pull' -f ~/.ssh/gaiada_client_targets
cat ~/.ssh/gaiada_client_targets.pub        # paste into 7c
```

**7c. gda-aicenter: the authorized_keys entry** (in `~<erp-user>/.ssh/authorized_keys`, ONE line; the
checkout path is wherever the repo is deployed, and the script must be executable by that user):
```
command="/home/<erp-user>/gaiada/infra/scripts/client-targets-forced-command.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,from="<sumopod-ip>" ssh-ed25519 AAAA... sumopod client-targets pull
```
Check it on the box itself before touching sumopod:
```sh
sh ~/gaiada/infra/scripts/client-targets-forced-command.sh --selftest
SSH_ORIGINAL_COMMAND="" sh ~/gaiada/infra/scripts/client-targets-forced-command.sh | head -c 300
```

**7d. sumopod: first pull by hand, then cron**
```sh
command -v python3    # needed by the validator
sh ~/gaiada-obs/infra/scripts/pull-client-property-targets.sh --selftest
~/gaiada-obs/infra/scripts/pull-client-property-targets.sh <erp-user>@<erp-host> ~/.ssh/gaiada_client_targets
head -c 600 ~/gaiada-obs/infra/observability/prometheus/targets/client-properties.json
```
Negative checks (each must FAIL, never print the file): `ssh -i ~/.ssh/gaiada_client_targets <erp-user>@<erp-host> id`
(refused), and with the key but a different source address (the `from=` pin).
```sh
# Every 5 minutes. sumopod's cron ignores CRON_TZ; "*/5" has no hour in it, so that does not matter.
( crontab -l 2>/dev/null; echo '*/5 * * * * $HOME/gaiada-obs/infra/scripts/pull-client-property-targets.sh <erp-user>@<erp-host> $HOME/.ssh/gaiada_client_targets >> $HOME/gaiada-client-targets-pull.log 2>&1' ) | crontab -
```
Prometheus re-reads file_sd on its own (`refresh_interval` in the job); no reload is needed.

**7e. Verify end to end**
```sh
curl -s http://10.88.0.2:19090/api/v1/targets?scrapePool=client-properties | head -c 800   # activeTargets > 0
tail -3 ~/gaiada-client-targets-pull.log     # silent when unchanged; one "updated" line per change
```
A failed pull logs one line (`ssh ... failed` or `payload rejected (<reason>)`), exits non-zero and
leaves the previous file untouched.

## 8. Wire the outside-SumoPod dead-man's-switch leg (gda-aicenter cron)

Requires two real values first: a healthchecks.io (or equivalent) check for
`SUMOPOD_DEADMANSSWITCH_URL`, distinct from the existing `DEADMANSSWITCH_URL`. Minting one is a
two-minute human action outside this runbook's scope (§4 of the plan doc).

```sh
crontab -l 2>/dev/null | grep healthcheck.sh
# Edit the existing healthcheck.sh cron line to add:
#   SUMOPOD_OBS_URL=http://10.88.0.2:9093/-/healthy SUMOPOD_DEADMANSSWITCH_URL=<new check url>
```

Verify the new leg fires correctly, in both directions, before trusting it:
```sh
# Positive: confirm it currently succeeds (SumoPod is up)
curl -fsS -m 10 http://10.88.0.2:9093/-/healthy && echo OK
# Negative: temporarily stop alertmanager on sumopod, run healthcheck.sh once by hand, confirm it
# alerts over Telegram/email — then restart alertmanager immediately (do not leave it down):
ssh sumopod "docker stop gaiada-obs-alertmanager-1"
SUMOPOD_OBS_URL=http://10.88.0.2:9093/-/healthy TELEGRAM_BOT_TOKEN=... ALERT_CHAT_ID=... \
  infra/scripts/healthcheck.sh || true   # expected: exit 1, alert sent
ssh sumopod "docker start gaiada-obs-alertmanager-1"
curl -fsS -m 10 http://10.88.0.2:9093/-/healthy && echo "restored OK"
```

---

## 9. Rollback — per step, in reverse order

1. **Dead-man's-switch cron leg:** revert the crontab line to drop `SUMOPOD_OBS_URL`/
   `SUMOPOD_DEADMANSSWITCH_URL` — the script no-ops that check when the var is unset (`if [ -n
   "${SUMOPOD_OBS_URL:-}" ]`), so removing it from the env is sufficient; no code change needed.
2. **Client-property targets (§7):** on sumopod `crontab -e` and remove the
   `pull-client-property-targets.sh` line; on gda-aicenter delete the `command=` line from
   authorized_keys and blank `CLIENT_PROPERTY_TARGETS_PATH` (recreate `platform`) to turn the renderer
   off. The last pulled `client-properties.json` on SumoPod is harmless left in place (it is just a
   target list) but can be emptied: `ssh sumopod "echo '[]' > ~/gaiada-obs/infra/observability/prometheus/targets/client-properties.json"`.
3. **Alertmanager routing/receiver:**
   ```sh
   ssh sumopod "cp ~/gaiada-obs/infra/observability/alertmanager/alertmanager.yml{,.rollback-bak}"
   # restore the pre-rollout version (from git, or the .bak-20260823 already on the box):
   rsync -az --checksum infra/observability/alertmanager/alertmanager.yml.PRE-ROLLOUT \
     sumopod:~/gaiada-obs/infra/observability/alertmanager/alertmanager.yml
   ssh sumopod "docker restart gaiada-obs-alertmanager-1"
   ```
   (Keep a `.PRE-ROLLOUT` copy locally before step 2 of the apply sequence if you want a
   one-command revert rather than a git checkout.)
4. **`blackbox-exporter` container:**
   ```sh
   ssh sumopod "cd ~/gaiada-obs/infra/compose && \
     docker compose -p gaiada-obs -f docker-compose.obs-remote.yml rm -sf blackbox-exporter"
   ```
   Scoped to the one service — never a bare `down`, which would also stop
   prometheus/loki/tempo/grafana/alertmanager/ntfy/node-exporter.
5. **New scrape jobs / rule file:** revert `prometheus.remote.yml` and remove
   `alerts-estate.yml` from `sumopod:~/gaiada-obs/infra/observability/prometheus/`, then
   `curl -X POST http://10.88.0.2:19090/-/reload`. Also revert the `ServiceDown` scoping change in
   `alerts.yml` if reverting fully (optional — the scoped version is strictly safer and has no
   downside even standalone).
6. **Final check:** `docker ps -a` on SumoPod diffed against the original §0 baseline — confirm it
   matches exactly.

At every rollback step, `helios` and `delphi` are never touched — there is nothing to roll back on
either host, because nothing was ever installed there.
