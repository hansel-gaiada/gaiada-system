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
| `dispatch_unconfirmed` | the dispatch outlived 30 s, or the process died before recording GitHub's answer. **A run may have started.** | check the Actions tab; the ledger says so rather than guessing |
| `github_dispatch_failed`, `build_ledger_unavailable` | anything else; see the platform log and the `github.deploy` activities row | |

## Owner steps (nobody in the build sessions can do these)

### A. Install the `gaiada-erp` GitHub App on `gaiadabali/gaiada-web-revamp`

The App is `gaiada-erp` (App id `4777424`, installation `157879245` on the org `gaiadabali`), already holding `Actions: Read and write`,
`Contents: write`, `Metadata: read` (blueprint `github-integration-foundation.md` section 2.2). Whether it can see **this** repo
is the unknown: the repo is private and no account used in these sessions can see the org's repository list.

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
(32 assertions; it must end `RESULT: N passed, 0 failed`).

```bash
# 1. the user. It joins the SITE user's group; it is not root and has no sudo.
useradd --create-home --shell /bin/bash --groups u24pyevq gdeploy
passwd -l gdeploy
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

## Cost per run

See "Cost" below (measured on the gate host; the estimate and how it was made are written down there).
