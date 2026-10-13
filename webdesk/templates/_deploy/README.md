# `_deploy`: the WebDesk site deploy transport (M6-P6e)

**Status: IN PROGRESS.** Built and driven on `sumopod` against real daemons in containers (see "The harness"). Wired into the
three templates' `site.yml` by M6-P6f (see "The deploy job" below). Nothing here has run against Hostinger or `delphi`/`helios`,
and no workflow run has ever executed on GitHub.

The script a site repo's CI **deploy job** runs to put a build on a host over **SFTP or explicit-TLS FTPS**, as
`docs/plans/2026-10-11-webdesk-m6-plan.md` §6.3 describes. The ERP never runs it and never holds its credential
(WSK-D29); the credential is a per-site, docroot-locked principal (WSK-D33 option (c)) that reaches the job as an org secret.

| File | What |
|---|---|
| `deploy.sh` | the transport: modes `deploy` (default) and `rollback` |
| `make-manifest.sh` | the manifest generator the **build** job runs: `make-manifest.sh dist > manifest.tsv` |
| `secret-name.sh` | the per-site secret's name, `WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>` (M6-P6f) |
| `deploy-from-secret.sh` | the deploy job's one call: the per-site secret's JSON in, `deploy.sh` out; refuses what it should (M6-P6f) |
| `plan.sh` | the build job's decision: which trigger deploys what, and where (M6-P6f) |
| `write-stamp.sh` | writes the build stamp `webdesk-build.json`, with the `buildId` `deploy.sh` reads (M6-P6f) |
| `secret-name.fixture.json`, `test-secret-name.sh` | ONE fixture for the name, tested here and in `platform-nest` (`deploy-grant.unit.test.ts`) |
| `test-scripts.sh` | offline tests of `plan.sh`, `write-stamp.sh`, `deploy-from-secret.sh` (a stub `deploy.sh`; no host) |
| `harness/` | the compose harness and the cases that prove it (run on `sumopod` only) |

A site repo has no `_deploy/`: `node webdesk/templates/sync-deploy-scripts.mjs` copies the run-time scripts into each template's
`.webdesk/deploy/` (and `--check`, part of `npm test` in `webdesk/`, fails on drift). The workflows call them from there.

## Why bash + lftp

`lftp` speaks both SFTP and FTPS (explicit TLS) with one command language, so one script serves whichever transport
M6-P6b picks per account. It runs `rename`, `mkdir`, `get`, `put` and a recursive `mirror` on both, and it is one
`apt-get install lftp` on a GitHub ubuntu runner (the harness uses the same 4.9.2 line from Debian). A Node script
would need an SFTP library and a separate FTPS library, each with its own certificate and host-key handling, and a
`npm install` in the one job that is meant to run **no package manager** (§6.3). The cost of lftp: its
error text is the only error channel, and two of its commands misbehave (`cat` on a missing file never returns, so
the script uses `get`; `mkdir -p` on an existing directory fails over SFTP, so it checks first).

Runner needs: `bash`, `lftp`, `openssh-client` (SFTP), `openssl` (FTPS pin), `curl`, `jq`, `coreutils`. All are on
`ubuntu-latest` except `lftp`.

## Inputs (environment variables; the credential never goes on a command line)

| Variable | Meaning |
|---|---|
| `DEPLOY_TRANSPORT` | `sftp` or `ftps`. Anything else, including `ftp`, is refused |
| `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER` | the host (default port 22 / 21) and the per-site principal |
| `DEPLOY_PASSWORD` | the password. Handed to lftp through its environment only. Or, SFTP only: |
| `DEPLOY_SSH_KEY` | the private key (contents), written 0600 into a 0700 temp dir for the run |
| `DEPLOY_SFTP_KNOWN_HOSTS` | **required for SFTP**: the pinned `known_hosts` line(s), content not path. For a non-22 port use the `[host]:port` form |
| `DEPLOY_FTPS_CERT_SHA256` and/or `DEPLOY_FTPS_CA_PEM` | **one at least is required for FTPS**: the pinned leaf fingerprint, and/or the pinned CA (or the self-signed server certificate itself) as PEM content |
| `DEPLOY_FTPS_CHECK_HOSTNAME` | `yes` (default) or `no`. Only for a host whose certificate names another host |
| `DEPLOY_FTPS_TLS_PRIORITY` | GnuTLS priority string; default TLS 1.2 and 1.3 |
| `DEPLOY_REMOTE_BASE` | the **parent of the docroot** (it also holds `releases/` and the lock) |
| `DEPLOY_DOCROOT` | the docroot's name inside the base, e.g. `public_html` |
| `DEPLOY_ARTIFACT_DIR`, `DEPLOY_MANIFEST` | the build output and its manifest (deploy mode) |
| `DEPLOY_MANIFEST_SHA256` | optional: the manifest's own hash, passed from the build job's output |
| `DEPLOY_BUILD_ID` | the build id the stamp must show (deploy mode) |
| `DEPLOY_STAMP_URL`, `DEPLOY_STAMP_FILE`, `DEPLOY_STAMP_FIELD` | the `https://` URL to read back; the stamp's path inside the artifact (default `webdesk-build.json`); the JSON field that holds the id (default `buildId`) |
| `DEPLOY_STAMP_CA_FILE`, `DEPLOY_STAMP_TIMEOUT` | an extra CA for the stamp read (harness only); seconds to wait for the stamp (default 60) |
| `DEPLOY_MIN_FILES`, `DEPLOY_MIN_PAGES` | minimum files and `.html` pages in the manifest (default 1 each; the template sets real values per site) |
| `DEPLOY_KEEP` | releases kept including the live one (default 3, minimum 2) |
| `DEPLOY_LOCK_STALE_SECONDS`, `DEPLOY_LOCK_WAIT_SECONDS` | stale age (default 1800) and how long to wait for a held lock (default 0: fail at once) |
| `DEPLOY_PARALLEL`, `DEPLOY_RATE_LIMIT` | parallel transfers (default 2); upload bytes per second per connection (0 = off) |
| `DEPLOY_MODE=rollback`, `DEPLOY_ROLLBACK_TO` | roll back instead of deploying; optionally name the release (default: the newest older one) |

Note the stamp: the WSK-60 stamp carries `source`, `pulledAt`, `maxUpdatedAt`; this transport needs a **build id in it**
(`buildId`), which the build job writes (`write-stamp.sh`, M6-P6f). The script refuses an artifact whose own stamp does not already
carry the expected id.

**Two inputs added by M6-P6f, for a deploy into a subdirectory of an existing docroot (wp):** `DEPLOY_DOCROOT_PARENT` (the directory
that holds the docroot, when it is not `DEPLOY_REMOTE_BASE` itself; default: the base) and `DEPLOY_CREATE_BASE=yes` (create the base
directory, its last component only, when it does not exist). With them `DEPLOY_DOCROOT` is the theme's name,
`DEPLOY_DOCROOT_PARENT` is `<wp root>/wp-content/themes`, and `DEPLOY_REMOTE_BASE` (releases and the lock) is
`<wp root>/wp-content/.webdesk-deploy`, a hidden directory WordPress never scans: WordPress also looks one directory below `themes/`
for themes, so releases kept inside `themes/` would show up as installable themes. The swap is the same two renames, in two
directories of one host.

Exit codes: `0` ok, `2` refused before touching the host (configuration, pinning, a bad artifact), `3` lock held,
`4` verification refused, `5` activation failed and was undone, `6` stamp mismatch and was undone, `7` the host
refused an operation (a permission, a quota), `1` anything else.

## What a deploy does

```
verify the local artifact against the manifest (and the counts)         exit 2 on any difference
pin check: SFTP host key (StrictHostKeyChecking=yes against ONLY the provided known_hosts)
           / FTPS certificate (chain + hostname against the pinned CA, fingerprint if given)
take the remote lock                                                    mkdir <base>/.deploy-lock   (exit 3 if held)
upload to <base>/releases/.tmp-<id>/        a half upload never has a release name
read EVERYTHING back and compare sha256 to the manifest                 (exit 4 on any difference)
rename to <base>/releases/<id>/
swap into <base>/<docroot>                  two renames in one session; the second failing undoes the first
read <STAMP_URL> over HTTPS: the site must serve the expected build id  (else swap back, exit 6)
prune to the newest DEPLOY_KEEP releases, release the lock
```

The docroot is always a rename of a release directory. The release that was live is parked in `releases/<its id>` (its id is
in a one-line `.webdesk-release` file inside every release; a hand-made docroot with none is parked as
`0000-legacy-<time>`), so a **rollback is the same swap the other way** and rolls forward again just as well. `releases/` holds
the **non-live** releases, so "the last three" is the live one plus two.

## The controls and their limits

These replace what a root-owned forced command validated on `delphi` (§6.3: shared hosting enforces less, and that is said
plainly here).

- **Host identity.** SFTP: only the pinned `known_hosts`, never the user's or the system's, no trust on first use, no auto-confirm.
  FTPS: explicit TLS forced on the control channel, data and listings (`ftp:ssl-force`, `ssl-protect-data`, `ssl-protect-list`),
  certificate verified on every connection. A fingerprint pin is checked on a separate pre-flight connection, then every session
  verifies the chain and the hostname, so with a fingerprint alone a man in the middle would have to hold a valid certificate for the host
  **and** race the pre-flight. **To bind every session to one certificate, pin it as `DEPLOY_FTPS_CA_PEM`** (a self-signed server
  certificate is its own anchor; GnuTLS will not accept a CA-issued leaf as an anchor, so for a CA-issued certificate pin the CA).
- **No plain FTP.** `DEPLOY_TRANSPORT=ftp` is refused by name, and an FTPS session against a server that does not offer TLS is refused by lftp.
- **What verify proves.** Every file is read back from the host and hashed: a flipped byte, a truncated file, a missing or an extra
  file all refuse activation. It proves the bytes **on the host's disk**, read through the same transport. It does not prove what a CDN,
  an `.htaccess` or the web server will do with them. The manifest travels beside the artifact; if one party can change both, the
  check proves only consistency. Pass the manifest's hash as `DEPLOY_MANIFEST_SHA256` from the build job's output to pin it.
- **Counts.** `DEPLOY_MIN_FILES` and `DEPLOY_MIN_PAGES` refuse an artifact that is suspiciously small (an empty build, a build with no
  pages). A control, not a proof.
- **The stamp.** After activation the script reads `webdesk-build.json` over HTTPS (TLS 1.2+, no downgrade, a cache-busting query)
  until the site serves the expected build id; otherwise it swaps back. It proves the URL's site now serves this build.
- **The lock.** `mkdir <base>/.deploy-lock` (fails if it exists), then an `owner` file with the start epoch. Released on every exit
  path that bash can see (success, failure, `INT`/`TERM`/`HUP`). `SIGKILL`, a runner crash or a lost network leaves it. **Stale rule:** a
  lock older than `DEPLOY_LOCK_STALE_SECONDS` (default 1800, so a deploy that takes longer than 30 minutes is not supported) is broken by renaming it aside and
  retaking it; a lock with no owner file is aged by its directory's mtime. Limit: the break is a read, then a rename. Two deployers
  can both decide it is stale and the loser may rename the winner's fresh lock aside. Keep the repo's CI `concurrency` group on the deploy
  job (§6.6 of the plan) so only one run exists at all; the lock guards against a second path, a retry and a hand run.
  The orphaned `.tmp-*` upload of a killed run is removed by the next deploy under the lock.
- **The activation window.** FTP has `RNFR`/`RNTO` and no symlinks, and a shared host fixes the docroot to a real directory, so the
  docroot is **swapped with two renames**: live goes aside, the new release takes its name. Between them the docroot **does not exist**
  (requests get 404/403). The two renames are issued back to back in one already-open session, so the gap is about two round trips plus
  the host's rename time. The script prints an **upper bound** (`window <= N ms`, measured between two timestamps taken around the
  renames inside the same lftp session); the harness measures the real effect with a probe. If the second rename fails the first
  is undone in the same session, and the script then asks the host who is live. If the process itself is killed between the two renames
  the docroot stays missing until the next run, which takes the lock and restores the newest release before doing anything else
  (a `WARNING` line says so). **Measured in the harness (final run):** the script's upper bound was 3 to 8 ms on the LAN, and 162 ms
  (SFTP) to 404 ms (FTPS) with 80 ms of latency added each way (about a WAN CI runner). A probe container requesting the site every 15 to
  25 ms saw no failed request on the LAN (the gap is shorter than its resolution) and, at 80 ms each way, 6 (SFTP) and 12 (FTPS) `404`s spread
  over 66 and 148 ms. So expect **one round trip of 404s per deploy, per rollback, and again if the stamp check rolls back**: about
  0.2 to 0.5 s on a WAN. **A symlink swap (`ln -s` then `rename` over the link) would have no window, but lftp's SFTP
  `mv` refuses to rename over an existing name** ("Failure"), so it would also be two steps; it was measured and not built.
- **What it cannot do.** Make the swap atomic on hosts without it; stop a principal that holds the account's other docroots (that is the
  P6b/P6d credential model, not this script); verify DNS, CDN or TLS of the served site beyond the stamp read.
- **Secrets.** The password is a shell variable that is never exported and is passed to lftp as `LFTP_PASSWORD` for that one command
  (never argv); the key is a 0600 file in a 0700 temp dir that is removed on exit; every line lftp prints passes through a redactor; `set -x`
  is refused; lftp debug is never on. The harness greps every captured output for a canary password and for the key.

## The harness

`harness/` proves the transport on real daemons: an `sshd` (SFTP, two users chrooted to `/data`, each owning one base), a rogue `sshd`
with other host keys, `vsftpd` with explicit TLS, a rogue `vsftpd` (self-signed certificate, same name), a plain-FTP `vsftpd`,
`nginx` serving each user's docroot over HTTPS from the same volume (so the stamp read is real), and a client container
that runs `deploy.sh`. One private docker network, **no published ports**, project name `p6e-harness`.

**Run it on `sumopod`, never on a laptop** (owner rule: no local Docker). The host is shared (about 48 other containers), so the
harness only ever touches `p6e-harness` containers, its volumes, its network and its one image, and removes them on every exit path:

```bash
tar -C webdesk/templates -c _deploy | ssh sumopod 'mkdir -p ~/p6e && tar -x -C ~/p6e'
ssh sumopod 'cd ~/p6e/_deploy/harness && nohup bash run.sh > ~/p6e.log 2>&1 &'   # then poll ~/p6e.log
```

It takes about ten minutes, prints `PASS` or `FAIL` per case, and exits non-zero if any fails. Cases (each for SFTP and FTPS where it applies):
1 deploy, verify, activate, stamp read back; 2 `SIGKILL` and `SIGTERM` mid-upload leave the previous release serving byte for byte, the orphaned
lock and the stale rule; 3 a flipped byte refuses activation, 3b a failing second rename is undone, 3c a wrong stamp rolls back; 4 principal A on
B's root is refused by the daemon; 5 an unpinned or wrong host key, a hijacking server, a wrong fingerprint, no pin, plain FTP, a
plain-only server and a tampered artifact are each refused; 6 the canary credential is in no output and no daemon log; 7 two simultaneous deploys; 8 the
last three releases kept and one rollback; 9 a docroot left missing by a kill between the two renames is restored by the next run. Test hooks (`DEPLOY_TEST_HOOK_AFTER_UPLOAD`, `DEPLOY_TEST_FAIL_ACTIVATION`) exist only for this harness: they
need `DEPLOY_ALLOW_TEST_HOOKS=I-am-the-harness` and are refused on a GitHub runner.

**M6-P6f cases** (`P6E_CASES=p6f bash run.sh`, a minute or two; `P6E_CASES=all` runs both sets): through `deploy-from-secret.sh`
and the real `deploy.sh`, over SFTP and FTPS. F1 a static deploy driven only by the per-site secret JSON, the stamp read back, a
manifest that is not the pinned one refused. F2 a **wp deploy on a fake WordPress tree** (core, `wp-config.php`, uploads, two plugins,
two themes, one of them an old hand-installed `gaiada-webdesk`): a digest over every file outside the theme is unchanged after the
deploy, a second deploy and a rollback (with a negative control proving the digest can fail), `themes/` holds only the two themes,
and the old theme is parked as a release in `wp-content/.webdesk-deploy/releases`. F3 an artifact that also holds `wp-config.php`, a
plugin, an upload or an `mu-plugin`, a manifest that is not the pinned one, or a file the manifest does not list, is refused before
the host is touched. F4 a staging secret on a production run, plain ftp and a secret with no pinned identity are refused. F5 the
canary credentials are in none of the captured outputs.

## The per-site deploy secret (M6-P6f)

One org Actions secret per site and environment, created BY HAND by an org owner from the vault record (WSK-D29: the ERP never
writes it), visible to exactly one repository (M6-P4g grants it). Its **name** is derived, never chosen:

    WEBDESK_DEPLOY_<SLUG>_<ENV>_<REPOID>      e.g. WEBDESK_DEPLOY_ACME_SITE_STAGING_123456789

`<SLUG>` is the repo's name, `<ENV>` the environment (`staging`, `production`, `development`), each uppercased with every character
outside `A-Z0-9` replaced by `_`; `<REPOID>` is the GitHub repository's numeric id (`github.repository_id`). The ERP shows the owner
the exact name (`deployGrant.siteSecretName`, and the pending list); until the first grant has read the repo it shows no name and says
why (`siteSecretNote`). The workflow derives the same name with `secret-name.sh`; both are tested against `secret-name.fixture.json`.

Its **content** is one JSON object. Paste it MINIFIED on one line (GitHub warns that structured secrets can fail to be masked
line by line; the deploy job also masks the whole compact JSON, the password and every line of the key):

| Field | Type | Meaning |
|---|---|---|
| `version` | `1` | required |
| `environment` | `"staging"`, `"production"` or `"development"` | required; must equal the environment of the run (a staging secret never deploys production) |
| `transport` | `"sftp"` or `"ftps"` | required; plain ftp is refused |
| `host` | string | required; maps to `DEPLOY_HOST` |
| `port` | integer | optional; default 22 (sftp) or 21 (ftps); `DEPLOY_PORT` |
| `user` | string | required; the per-site, docroot-locked principal; `DEPLOY_USER` |
| `password` | string | one of `password` / `privateKey`; `DEPLOY_PASSWORD` |
| `privateKey` | string | sftp only; the key's contents; `DEPLOY_SSH_KEY` |
| `knownHosts` | string | **required for sftp**: the pinned host key line(s), `[host]:port` form for a non-22 port; `DEPLOY_SFTP_KNOWN_HOSTS` |
| `certSha256` | string | ftps: the pinned leaf fingerprint (colons allowed); `DEPLOY_FTPS_CERT_SHA256` |
| `caPem` | string | ftps: the pinned CA (or the self-signed server certificate) as PEM; `DEPLOY_FTPS_CA_PEM`. **One of `certSha256` / `caPem` is required for ftps** |
| `checkHostname` | boolean | ftps, optional, default true; `DEPLOY_FTPS_CHECK_HOSTNAME` |
| `remoteBase` | string | required. **static:** the parent of the docroot (it also holds `releases/` and the lock), `DEPLOY_REMOTE_BASE`. **wp:** the WordPress root (the directory that holds `wp-content/`) |
| `docroot` | string | required for **static** (the docroot's name inside `remoteBase`, `DEPLOY_DOCROOT`); ignored for wp (the theme is the docroot) |
| `siteUrl` | string | required; `https://` origin (a path is allowed, no query) the site is served from. The stamp is read from `<siteUrl>/webdesk-build.json` (static) or `<siteUrl>/wp-content/themes/<theme>/webdesk-build.json` (wp): `DEPLOY_STAMP_URL` |

Any other field is refused (a typo is caught, not ignored), and so is a missing or mistyped one; the message names the FIELD, never
a value. Example (a placeholder, not a credential):

    {"version":1,"environment":"staging","transport":"sftp","host":"ssh.example.com","port":65002,"user":"u123_acme_stg","password":"...","knownHosts":"[ssh.example.com]:65002 ssh-ed25519 AAAA...","remoteBase":"/home/u123/domains/stg.acme.example","docroot":"public_html","siteUrl":"https://stg.acme.example"}

## The deploy job (M6-P6f)

`.github/workflows/site.yml` in each template. One workflow, two triggers, two jobs (fullstack has a third, `deploy-api`).

| Trigger | Result |
|---|---|
| `push` to the default branch | deploys **staging** |
| `push` to any other branch or tag, `pull_request` | builds and verifies, **deploys nothing** |
| `workflow_dispatch` `kind=publish` or `rebuild` (the ERP's WSK-60 chokepoint: inputs `approval_id`, `kind`, `published_at`) | rebuilds **staging** |
| `workflow_dispatch` `environment=production` + `kind=promote` + an `approval_id` | deploys **production** (P6h makes the ERP send it, behind a HIGH approval) |
| any other dispatch (no approval id, production from a publish, a promote that does not say production, a non-default ref) | **refused**, never quietly downgraded |

`build` holds no deploy credential (static and fullstack: only the content read key; wp: nothing). It builds, writes the stamp
(`write-stamp.sh`: `buildId` = `<run id>-<attempt>-<sha12>`, plus the WSK-60 fields), makes the manifest and uploads both
(`actions/upload-artifact`, hidden files included). `deploy` (`needs: build`, a `concurrency` group per repository and environment,
`cancel-in-progress: false`) checks `WEBDESK_DEPLOY_GRANT`, installs `lftp` (the only package manager call, before any secret is
read), downloads the artifact, derives the per-site secret's name, selects that secret out of `toJSON(secrets)` with `jq`, fails
with **"the per-site deploy secret <name> does not exist yet or is not granted to this repo; see the console's pending list"** if it
is absent, and runs `deploy-from-secret.sh`. Per kind:

- **static:** the build's `dist/` (with the stamp at its root) is the docroot content.
- **wp:** the artifact is the repo-relative tree `wp-content/themes/<theme>/…` and **nothing else**; `deploy-from-secret.sh` refuses
  (exit 2, before any connection) a manifest that is not the one the build job pinned, a tree that differs from its manifest, and any
  path outside the theme. Only the theme directory is swapped; `wp-config.php`, `uploads/`, other plugins and themes are never touched.
- **fullstack:** the static export of `apps/web` (`WEBDESK_STATIC_EXPORT=1`, `apps/web/out`) deploys like static. `deploy-api` fails
  with "the fullstack API deploy to a Node host is M6-P6l, not built yet" and uploads nothing. A scaffolded site's item and listing
  pages render at build time (M6-P6m, WSK-D83): they read content through the SDK during `next build` (`WEBDESK_HOST` /
  `WEBDESK_API_KEY` / `WEBDESK_TENANT_SLUG` are set in the build job), item pages use `generateStaticParams()` with
  `dynamicParams = false`, and a content change reaches the site by a rebuild. A build with no `WEBDESK_HOST` fails loudly ("WEBDESK_HOST
  is not set"). An empty collection builds: its item page gets one placeholder param that renders the 404. Hand-written pages that
  render per request (`force-dynamic`, cookies, headers) still cannot be exported.

Limits, said plainly: a push while a deploy runs waits, and GitHub keeps at most one waiting run per group (a newer waiting run
replaces an older waiting one, so two approved dispatches in quick succession can lose the first; the ERP sees that as `unverified`).
The template build reads content through the vendored SDK and does not enumerate it, so the stamp's `maxUpdatedAt`, `itemCount` and
`sourceSha256` are `null` and its `pulledAt` is when the build began (see `write-stamp.sh`). Anyone who can push a workflow or the
scripts to a repo that holds the secret can print it: the per-site principal, locked to one docroot, is what bounds that.
