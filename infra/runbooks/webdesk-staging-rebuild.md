# Runbook - WebDesk publish -> rebuild -> staging (WSK-60)

**Status: PROTOTYPED.** The ERP side (ledger, dispatch through the GitHub chokepoint, stamp poll, the two editor routes) and the
site-repo side (workflow, CI deploy script, the delphi forced command) are written and proved on the sumopod gate against stub
GitHub, stub staging and a containerised sshd (see "As executed" at the end). **No workflow run has ever been started, no deploy
user exists on delphi, and the `gaiada-erp` App has not been seen to dispatch into `gaiadabali/gaiada-web-revamp`.** The three
steps in "Owner steps" are the ones no session here can do. Until they are done, the ERP says so on every rebuild:
`failed: github_app_not_installed` (or `rebuild_not_configured`). It never claims a build it did not start.

Design: `docs/plans/2026-10-10-webdesk-write-plane-design.md` section 9 (Decision G) and section 12 (WSK-60). Rulings:
`docs/blueprints/webdesk-design-v2.md` section 14, WSK-D46 (one human decision covers the publish and the rebuild).

## The flow

```
WebDesk publish approval (WSK-66)            ERP (platform-nest)                         GitHub                  delphi
  approver: POST …/decide  ───────────────►  1. Zone B publish (WS4 + editorial)
                                             2. webdev_site_builds row (UNIQUE per approval)
                                             3. github_repo · deploy (D14, approvalId)   workflow_dispatch ───►  run: pull /v1 (prod READ key)
                                                POST …/actions/workflows/                                        astro build, gates
                                                  webdesk-rebuild.yml/dispatches                                 ssh gdeploy "deploy-tarball sha256=…" ──► forced command:
                                             4. every 30 s, up to 20 min:                                                                              validate, swap docroot
                                                GET https://24-pyevq.gaiada.com/webdesk-build.json ◄───────────────────────────────────────────────── dist/webdesk-build.json
                                                live  <=> maxUpdatedAt >= publishedAt
                                                else after 20 min: unverified (never live)
```

* **What authorises the dispatch** is the approval's id. The decider is checked against `github_repo` `deploy` (the D14 rule in
  `cerbos/policies/resource_github_repo.yaml`: no approval id, no deploy), resolved against the GitHub **org tenant**
  (`GITHUB_REPO_SYNC_TENANT_ID`, GHT-1), not the editor's company. The ledger (`activities`, verb `github.deploy`, two rows
  per attempt) carries `metadata.approvalId`.
* **Coalescing is GitHub's.** The workflow has `concurrency: {group: webdesk-rebuild-staging, cancel-in-progress: true}`. The ERP
  records every dispatch and has no debounce: two publishes 20 s apart make two ledger rows and two dispatches, the first run
  is cancelled, and the second run's stamp (newer `maxUpdatedAt`) proves both.
* **A rebuild that cannot start never fails the publish.** The publish stands; the build row is `failed` with a typed reason.
* **Unpublish and delete have no approval of their own**, so they trigger no rebuild. The editor shows *"the staging site drops
  it at the next rebuild"* with **Request rebuild**, which files a `content.rebuild` approval. Approving it dispatches the same
  workflow (`kind=rebuild`). Authorisation is `github_repo` `deploy` alone: the takedown it propagates was already authorised at
  unpublish, so a rebuild changes no WebDesk content and has no maker-checker arm. The generic `decide` gate (company_admin)
  still applies. **If the owner wants a second person on rebuilds, that is a Cerbos policy change (WSK-47's files), not a code change.**

## Scheduled publishes and takedowns (WSK-61)

A `content.schedule` approval executes at decide() and makes nothing public yet, so it does not rebuild then. Zone B makes it
public **by time**: production serves a scheduled item once `publishAt` passes, and stops serving any item at `unpublishAt`, whether
or not WebDesk's content tick has run. The ERP catches up in `src/modules/webdev/scheduled-rebuilds.service.ts`:

* **When.** Every poll tick (the same loop as the stamp poll, so only when a target is configured), and right after WebDesk's
  `schedule.fired` event is recorded (`POST /api/:tenantId/modules/webdev/zoneb-events`). The event is a **hint only**: it
  names which site to look at, and the ERP decides from its own executed approvals and a fresh `item.get` of every item. A lost
  or duplicated event costs at most one tick.
* **Publish.** Every item live at its approved version: ONE dispatch under **the schedule's own approval id**, as the person who
  approved it (`github_repo` `deploy` checked again now, at "linked" assurance). The build row is `kind=publish` with no
  `published_at`, so the stamp proves it by `pulledAt >= dispatchedAt`. Exactly one build per approval, as for a publish.
* **Takedown.** At least one item went down: `stagingStale` is set **once** (a later verified rebuild clears it and nothing sets
  it again for that schedule). A takedown dispatches nothing by itself; the editor uses **Request rebuild** as for an unpublish.
* **When it does not visibly happen.** Within `WEBDESK_SCHEDULE_SUPERSEDE_GRACE_MS` (default 15 min) of the effective time the
  ERP waits for every item. After it: some items live → dispatch; none → `superseded` (deleted, unpublished, or replaced by a
  later publish that rebuilt on its own). A later `schedule.fired` naming the approval re-checks a superseded publish, so a late
  version swap still rebuilds. Older than 7 days → `expired`. Stored args that no longer match their command hash → `refused`.
* **A failed build is terminal**, here as everywhere: `deploy_denied`, `decider_inactive` and the dispatch's own reasons are
  shown as a failed build, and the remedy is **Request rebuild**, never a silent retry.

Every settled schedule leaves one row per transition in `webdev_schedule_firings` (`build_recorded`, `superseded`,
`stale_marked`, `expired`, `refused`, with a `detail` such as `items_live=2/3`):

```sql
SELECT approval_id, transition, outcome, detail, build_id, effective_at, settled_at
  FROM webdev_schedule_firings WHERE site_id = '<site id>' ORDER BY settled_at DESC LIMIT 20;
```

## What each state means (and what the editor shows)

`GET /api/:tenantId/modules/webdev/content/sites/:tenantSlug/:siteId/build-status` returns exactly
`{build: {approvalId, kind, requestedAt, publishedAt, state, stagingUrl, verifiedAt} | null, stagingStale}`; the editor parses
no other key. The *reason* a build failed is deliberately not on that wire (it is on the row and in the approval's
`execution_error` / `execution_result`, both visible in the Approvals inbox).

| `state` | Meaning | Reached by |
|---|---|---|
| `rebuilding` | GitHub accepted the dispatch; no stamp has proved the content yet | the dispatch returning 204 |
| `live` | `https://24-pyevq.gaiada.com/webdesk-build.json` proved it | publish: `source = webdesk` and `maxUpdatedAt >= publishedAt`. A rebuild, or a publish whose publishedAt is unknown: `pulledAt >= dispatchedAt` (an unpublish moves no `maxUpdatedAt`) |
| `unverified` | 20 minutes passed without proof. **Not live.** Check the run and the site by hand. | the poll window closing |
| `failed` | the dispatch did not happen | a typed `failure_reason` (below) |

`stagingStale` is true from the moment content is taken down until a rebuild **dispatched after that moment** is verified `live`.
(Whoever writes the unpublish/delete, WSK-59, must call `noteStagingStale(tenantId, siteId)` in `site-builds.service.ts`.)

### Failure reasons (`webdev_site_builds.failure_reason`, and `webdesk_rebuild_failed: <reason>` on a rebuild approval)

| Reason | What it means | Fix |
|---|---|---|
| `github_app_not_installed` | the App cannot see the repo (dispatch 404 **and** `GET /repos/{repo}` 404), or the installation is gone or suspended | Owner step A |
| `github_app_permission_missing` | installed, but the token lacks `Actions: write` (403 "Resource not accessible by integration") | App settings, Permissions, Repository, Actions: Read and write; accept the new permission on the installation |
| `workflow_not_found` | the repo is visible but the workflow file or ref is missing | merge `webdesk-rebuild.yml` into the ref named in `WEBDESK_REBUILD_TARGETS` (Owner step C) |
| `workflow_not_dispatchable` | 422: no `workflow_dispatch` trigger, or an input GitHub does not know | the file on that ref is not the one in this change |
| `github_not_configured` | no App credential sealed, or GitHub refused it (401) | `npm run seed:github-apps`; check `GITHUB_ERP_APP_ID` / `GITHUB_ERP_INSTALLATION_ID` |
| `github_org_unavailable` | `GITHUB_REPO_SYNC_TENANT_ID` unset, or the company is in a different root from the org tenant | set it (GHT-1) |
| `deploy_denied` | Cerbos refused `github_repo` `deploy` for the decider | the decider needs company_admin / manager / webdev module staff **in the org tenant** |
| `github_rate_limited` | the shared installation bucket is exhausted | wait; `GET /api/admin/github/detail` shows the bucket |
| `rebuild_not_configured` | no `WEBDESK_REBUILD_TARGETS` entry for this site | Owner step E |
| `decider_inactive` | WSK-61 only: a scheduled publish went live, but the person who approved the schedule is no longer an active user, so nobody can authorise the dispatch. Nothing was sent. | the editor files **Request rebuild** (a `content.rebuild` approval) |
| `dispatch_unconfirmed` | the dispatch outlived 30 s, or the process died before recording GitHub's answer. **A run may have started.** | check the Actions tab; the ledger says so rather than guessing |
| `github_dispatch_failed`, `build_ledger_unavailable` | anything else; see the platform log and the `github.deploy` activities row | |

## Owner steps (nobody in the build sessions can do these)

### A. Install the `gaiada-erp` GitHub App on `gaiadabali/gaiada-web-revamp`

The App is `gaiada-erp` (App id `4777424`, installation `157879245` on the org `gaiadabali`), already holding `Actions: Read and write`,
`Contents: write`, `Metadata: read` (blueprint `github-integration-foundation.md` section 2.2). Whether it can see **this** repo
was the unknown. **Verified 2026-10-11: it can.** `gaiadabali/gaiada-web-revamp` is a live, private row in the ERP's `github_repos`
sweep cache (last synced 2026-10-10 11:03 UTC), and the sweep lists only what the installation sees. Steps 1 and 2 are therefore already
satisfied. `Actions: write` is still proven only by the first dispatch (step F). Of the local `gh` accounts only `web-gaiada` can see
the private repo (admin), so step B runs as that account; on 2026-10-11 the repo had no Actions secrets or variables yet.

1. As an org owner: `https://github.com/organizations/gaiadabali/settings/installations/157879245`.
2. **Repository access**: if "All repositories", nothing to do. If "Only select repositories", add `gaiada-web-revamp`. Save.
3. Check the permissions page lists **Actions: Read and write** and **Metadata: Read-only**. Nothing else is needed for this ticket.
4. Verify without a publish: in the ERP database,
   `SELECT full_name FROM github_repos WHERE full_name = 'gaiadabali/gaiada-web-revamp';` returns a row after the next GH-06 sweep
   (the sweep lists only what the installation can see). Or just request a rebuild (Owner step F): a refusal says
   `github_app_not_installed` in plain words.

### B. Repository secrets and variables on `gaiadabali/gaiada-web-revamp`

Settings, Secrets and variables, Actions. **Names are exact.**

| Kind | Name | Value |
|---|---|---|
| secret | `WEBDESK_READ_KEY` | a **production-environment READ** key for the `gaiada` tenant. A staging-environment key also returns drafts, which would make "publish" meaningless, and the pull refuses any item with `meta.draft` not false. Mint it through the ERP (a `key.mint` approval, `envId` = the production env, `scope` = `read`, WSK-66): the plaintext appears **once**, in the decide response. Paste it straight into the secret. |
| secret | `DELPHI_DEPLOY_KEY` | the **private** key generated in step D.3 (the whole file, including the BEGIN/END lines) |
| variable | `WEBDESK_API_URL` | the WebDesk api origin that serves `/v1`, no trailing `/v1` (the pull script's `WEBDESK_API_URL`). Not a secret. |
| variable | `DELPHI_KNOWN_HOSTS` | delphi's pinned host key line(s), from step D.5. CI never trusts a host on first use. |
| variable | `PUBLIC_WEB3FORMS_KEY`, `PUBLIC_WEB3FORMS_CAPTCHA`, `PUBLIC_ERP_URL` | the same public build values the local `scripts/deploy-staging.sh` build uses (from the working `.env`; see `.env.example`). Without them the staging contact form and the ERP link come out empty. |

The workflow refuses to start the build (`Check that the secrets and variables are present`) and names what is missing.

### C. Put the workflow on the ref the ERP dispatches

Merge branch `webdesk-rebuild` into `astro-site` (the `ref` in the ERP's target). The dispatch API runs the file as it is on that ref.
If a dispatch answers `workflow_not_found` although the file is on `astro-site`, GitHub has not indexed the workflow yet; also put it on the repo's
default branch (a `workflow_dispatch` workflow is listed from there).

### D. Create the restricted deploy user on delphi (root, server-d, 72.61.142.88)

The unit of risk is one staging site: the key can run `deploy-tarball` and nothing else, as a user with no sudo and no shell access.
Test the exact script first on any Linux host with Docker: `bash scripts/delphi/test/run.sh` in the site repo
(53 assertions; it must end `RESULT: N passed, 0 failed`).

```bash
# 1. the user. It joins the SITE user's group; it is not root and has no sudo.
useradd --create-home --shell /bin/bash --groups u24pyevq gdeploy
usermod -p '*' gdeploy          # no password login, but NOT a locked ('!') account: sshd refuses even a valid key for a locked one when UsePAM is off
install -d -o gdeploy -g gdeploy -m 0750 /home/gdeploy/releases/24-pyevq

# 2. the deploy user owns the docroot's CONTENTS (the script swaps them); the site group and nginx can read them.
DOCROOT=/home/u24pyevq/htdocs/24-pyevq.gaiada.com
chown -R gdeploy:u24pyevq "$DOCROOT"
find "$DOCROOT" -type d -exec chmod 2775 {} +
find "$DOCROOT" -type f -exec chmod 644 {} +
# keep one rollback copy of what is serving now (the script keeps the last 3 releases after this):
cp -a "$DOCROOT" /root/24-pyevq-before-wsk60-$(date -u +%Y%m%d)

# 3. install the forced command (root-owned, NOT writable by gdeploy) and its config (the script refuses a config that is not root's).
install -o root -g root -m 0755 scripts/delphi/deploy-forced-command.sh /usr/local/bin/gaiada-deploy-forced
install -d -o root -g root -m 0755 /etc/gaiada-deploy
cat > /etc/gaiada-deploy/24-pyevq.conf <<'EOF'
DOCROOT=/home/u24pyevq/htdocs/24-pyevq.gaiada.com
RELEASES=/home/gdeploy/releases/24-pyevq
LOCK=/home/gdeploy/.deploy-24-pyevq.lock
KEEP=3
MIN_HTML_PAGES=60
EOF
chown root:root /etc/gaiada-deploy/24-pyevq.conf; chmod 0644 /etc/gaiada-deploy/24-pyevq.conf
```

Then, **on a trusted machine** (not delphi, not CI), generate the key and bind it:

```bash
ssh-keygen -t ed25519 -N '' -C gaiada-ci-24-pyevq -f ./gaiada-ci-24-pyevq     # gaiada-ci-24-pyevq (private), .pub (public)
# on delphi, as root:
install -d -o gdeploy -g gdeploy -m 0700 /home/gdeploy/.ssh
printf 'command="/usr/local/bin/gaiada-deploy-forced",restrict,no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding %s\n' \
  "$(cat gaiada-ci-24-pyevq.pub)" > /home/gdeploy/.ssh/authorized_keys
chown gdeploy:gdeploy /home/gdeploy/.ssh/authorized_keys; chmod 0600 /home/gdeploy/.ssh/authorized_keys
```

4. Check sshd will let that user in: `sshd -T | grep -iE 'allowusers|allowgroups|passwordauthentication'`. If `AllowUsers`/`AllowGroups`
   is set, add `gdeploy`. Do not change anything else in sshd.
5. The host key to pin: `ssh-keyscan -t ed25519 72.61.142.88`. **Compare its fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on delphi**, then put the
   `72.61.142.88 ssh-ed25519 AAAA…` line in the repo variable `DELPHI_KNOWN_HOSTS`.
6. The private half goes into the repo secret `DELPHI_DEPLOY_KEY` (Owner step B), then `shred -u gaiada-ci-24-pyevq`.
7. **Prove the lock, with the real key, before the first deploy:**

```bash
ssh -i gaiada-ci-24-pyevq gdeploy@72.61.142.88 "ls /"          # -> "refused: only 'deploy-tarball sha256=<hex>' is accepted", exit 126, no listing
ssh -i gaiada-ci-24-pyevq gdeploy@72.61.142.88                  # -> refused, no shell
```

**Rollback** (as root): the last three releases are in `/home/gdeploy/releases/24-pyevq/<UTC>-<sha8>/`. Re-point the site with
`rsync -a --delete --exclude=/webdesk-build.json <release>/ <docroot>/ && cp <release>/webdesk-build.json <docroot>/` then
`chown -R gdeploy:u24pyevq <docroot>`. `deploys.log` in that directory has one line per successful deploy.

**Known unknown:** if CloudPanel (or anything else on delphi) periodically resets ownership of site files to `u24pyevq:u24pyevq`, the
group-write on directories is lost and the swap fails with a permission error in the CI log. The fix is to exclude this docroot from that job, not
to loosen the script. Watch the first two real deploys.

### E. Tell the ERP which site this is (production `.env` on gda-aicenter)

```
WEBDESK_REBUILD_TARGETS=[{"tenantSlug":"gaiada","siteId":"<the WebDesk site id for gaiada.com>","repo":"gaiadabali/gaiada-web-revamp","workflow":"webdesk-rebuild.yml","ref":"astro-site","stagingUrl":"https://24-pyevq.gaiada.com"}]
```

One line of JSON. `docker-compose.vps.yml` forwards it (and the two optional tunables). A malformed entry is **dropped and logged**, never
guessed (`failed: rebuild_not_configured`). Restart the platform container; the log line
`webdesk staging-rebuild poller on: every 30000ms, 1 target(s)` confirms it. The GitHub identity is the existing
`GITHUB_ERP_APP_ID` / `GITHUB_ERP_INSTALLATION_ID` / `GITHUB_REPO_SYNC_TENANT_ID`; the credential is the sealed PEM (`npm run seed:github-apps`).

### F. Drive it once (the proof script, design section 13 steps 1 to 3)

1. Website, Content, gaiada.com, edit an item, **Save draft**: staging unchanged.
2. **Request publish**; a second person (company_admin) approves it in Approvals. The response carries `webdesk.build.state`.
3. Actions tab: a `webdesk-rebuild` run named `webdesk rebuild (publish, approval <id>)` starts. Within about 10 minutes
   `curl -s https://24-pyevq.gaiada.com/webdesk-build.json` shows `maxUpdatedAt` at or past the publish, and the editor says live on staging.
4. Two quick publishes: the first run shows **Cancelled**, the second deploys, both builds read `live`.
5. Negative control: break `DELPHI_DEPLOY_KEY` (or the workflow `ref`): the editor shows `failed` / `unverified`, never live.

## Verifying a stamp by hand

```bash
curl -s https://24-pyevq.gaiada.com/webdesk-build.json | jq .
# {"source":"webdesk","pulledAt":"…","maxUpdatedAt":"…","itemCount":N,"sourceSha256":"…"}      the WebDesk build
# {"source":"git"}                                                                                 the old git build: proves nothing
```

```sql
-- as the app role with the webdev scope (or as the owner)
SELECT approval_id, kind, state, failure_reason, requested_at, dispatched_at, published_at, verified_at, poll_count, last_stamp_max_updated_at
  FROM webdev_site_builds WHERE site_id = '<site id>' ORDER BY requested_at DESC LIMIT 10;
SELECT occurred_at, metadata->>'outcome' AS outcome, metadata->>'approvalId' AS approval
  FROM activities WHERE verb = 'github.deploy' ORDER BY occurred_at DESC LIMIT 10;
```

## Cost

**How it was estimated.** WSK-55 recorded no build time (the laptop build is not written down anywhere), so this was measured: on sumopod, in a
`node:22-bookworm` container limited to **2 CPUs and 7 GB** (the shape of a GitHub-hosted `ubuntu-latest` runner), cold, with the host's load average
at about 7 (other tenants running, so this errs slow):

| Step | Measured |
|---|---|
| `npm ci` (cold, no npm cache) | 20 s |
| `npm run build` (`astro build`, 82 pages; the git-content build, which is the same work as the build after the pull) | 52 s |
| `tar -czf dist` (22 MB to a 9.8 MB tarball) | 1 s |
| **Sum of what was measured** | **73 s** |

Not measured, so budgeted: checkout and `setup-node` with the npm cache restore about 15 s, the `/v1` pull (about 330 items in 2 locales through the paginated list, assumed 20 s), the checks 3 s, the
SSH upload of 9.8 MB about 5 s, the post-deploy stamp check about 5 s. That is **about 2 min 10 s of wall time, which GitHub bills as 3 minutes** (per-job minute rounding), inside the design's
"2 to 4 min" assumption. Latency from approval to live is dominated by the same figure plus the first stamp poll (at most 30 s), so **about 3 to 4 minutes**.

At the design's $0.008 per Linux 2-core minute that is **about $0.024 per run if the repo is private, $0 if it is public**. At 20 to 60 publishes a month that is **$0.48 to $1.44 a month**,
and 60 runs is 180 of a private repo's included 2,000 minutes (Free plan) or 3,000 (Team), so the out-of-pocket cost is $0 in practice. Cancelled runs (coalesced bursts) bill only the
minutes they ran. **Re-measure on the first real run** (the Actions run page shows the billed time) and correct this section.

## As executed (sumopod gate, 2026-10-10; DEV-VERIFIED only where a real run is named in "Owner steps")

Everything below ran on the sumopod gate: Linux, `postgres:17`, `redis:7`, `cerbos 0.54.0` on a private network with no host ports (Cerbos health proven 200 before any result was trusted).
Stubs: GitHub's API (a local HTTP server that the chokepoint's fixed host is rewritten to; the App JWT, installation-token exchange, dispatch call and the
GH-04 ledger are the real code over real sockets), the staging site (a local HTTP server), Zone B (a fake control client; its WS4/mTLS half is WSK-66's own suite).

| Check | Result |
|---|---|
| `platform-nest/src/modules/webdev/site-builds-dispatch.test.ts` (done-when 1, 2, 3, 5, the failure modes, `content.rebuild`, stagingStale, the third wall, the ledger CHECKs) | 38 passed |
| `site-build-stamp.test.ts` (the stamp truth table, the stamp reader against a stub server, target parsing) | 21 passed |
| Mutation check: `live` made unconditional in `pollSiteBuild` | 4 of the done-when 3 tests fail (the negative controls bite) |
| `tsc --noEmit` | exit 0 |
| Full platform-nest suite | 527 files / 7544 tests passed, 3 failed: `monitoring.controller.test.ts` (known), `mail24-timing-remeasure.test.ts` (load-sensitive: 3205 ms pass alone, failed at load 17) and `capability-inventory.test.ts` (see below) |
| actionlint `rhysd/actionlint:1.7.7` on `webdesk-rebuild.yml` | 0 errors |
| `scripts/delphi/test/run.sh` (containerised sshd, the real forced command, the real ssh/scp/sftp clients) | 53 passed, 0 failed |
| `scripts/webdesk/test/rebuild-workflow.test.mjs` (concurrency group + cancel-in-progress, the only trigger, no secret in a run script, ...) | 11 passed |

**`capability-inventory.test.ts` needs one regenerated line.** `docs/modules/CAPABILITY-INVENTORY.md` counts each module's registered migrations, and `webdevModule.migrations` gained
`202610101730_webdev_site_builds.sql` (`| webdev | webdev | 9 |` becomes `10`). That file is outside this change's owned paths; at merge run
`UPDATE_INVENTORY=1 npx vitest run src/modules/capability-inventory.test.ts` (it is the generator) and commit the one-line result. `docs/MAP.md` is also out of date against this change
(new controller routes and a migration; it was already reported out of date on the base commit) and is regenerated by `node scripts/gen-map.mjs`.

**Not driven (and why):** no real GitHub call (the repo is private and no account here can see it), no real delphi, no real WebDesk `/v1` pull, no workflow run. The workflow, the CI deploy script and
the pull step have never executed together; the first real run is Owner step F.
