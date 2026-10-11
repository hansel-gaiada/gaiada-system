# Runbook: update the LIVE WebDesk api on gda-aicenter to a release

WebDesk is **not** deployed by `deploy.yml`: the release workflow builds and signs `gaiada-webdesk-api`, and a person
(today the WebDesk orchestrator session, under WSK-D43: "act directly inside the `webdesk` compose project only, backup
first") swaps it into the `webdesk` compose project by hand. As executed for 344 (first swap) and 348 (M3 wave 2 +
WSK-48b, migrations 0010/0011), 2026-10-11.

**Never build the api on gda-aicenter** (it is the live ERP box; one build drove load to 16 on 4 cores).

## Automated (M4 T4)

`.github/workflows/deploy-webdesk.yml` + `webdesk/ops/deploy/deploy-webdesk.sh` automate the manual procedure below.
It is `workflow_dispatch` only for now; `release.yml` does not call it yet. It shares `concurrency: deploy-vps` with
`deploy.yml` (one box, never alongside an ERP deploy) and runs in `environment: production` with the same `VPS_*`
secrets. It never touches the `gaiada` project.

**Dispatch it** (Actions, deploy-webdesk, Run workflow; or `gh workflow run deploy-webdesk.yml -f tag=<tag> -f mode=plan`):

1. **`mode=plan`, always first.** Changes nothing live. The runner cosign-verifies
   `ghcr.io/<owner>/gaiada-webdesk-api:<tag>` (as `deploy.yml` does) and reads the signed digest; archives the tag's
   `webdesk/{migrations,scripts,ops,proxy,postgres,compose files,package*.json,api/package*.json}` with
   `core.autocrlf=false`; ships tar + script to a temp dir on the box. On the box the script untars into a staging dir
   next to the project dir, refuses any file containing CR, checks the env file defines the keys the tools need (names
   only), runs `compose config -q` with the three files and `WEBDESK_API_IMAGE=ghcr.io/<owner>/gaiada-webdesk-api@<digest>`
   against `/etc/webdesk/.env`, compares the running api image id with the digest ("no swap needed" when equal), lists
   the pending migrations (ledger read read-only), notes live-tree entries the release drops, and prints the plan.
   Read the summary: it must end `RESULT: plan OK`.
2. **`mode=apply`.** The runner also logs the box into GHCR with the job token. The script then: plan again; pull
   `…@<digest>` and REFUSE unless the image id equals the digest; tag the running image `webdesk-api:pre-<tag>` (a local
   tag, outside `deploy.yml`'s `ghcr.io/<owner>/gaiada-*` prune); back up (`pg_dump -Fc` as `webdesk_backup`, else the
   container's superuser; compose files; `migrations/`; a `state.env`) into `~/webdesk-backups/pre-<tag>-<UTC>/`; swap the
   staging tree in by RENAME, keeping the old tree as `<project>.old-<tag>-<UTC>` (so a file the release deleted, such
   as the stale `payload/` dir, disappears; `.env*` symlinks are carried over); migrate as `webdesk_migrator` from a
   throwaway `node:22-bookworm` container on `webdesk_default` (no host ports, limits, `--rm`, secrets via a 0600
   `--env-file`) twice, the second run must apply 0; `check-rls-integrity.mjs` as the owner; `storage-bootstrap.mjs`;
   then `up -d --no-deps --no-build api` with the release overlay. Health (120 s; tick 150 s): `listening on :3000`,
   the editorial JWKS line, proxy `/healthz` 200, `/v1/t/<random>/collections` through nginx -> 401
   `application/problem+json`, the next `content tick` line `errors=0`, `PROBE_ONLY=1 containment-probe.sh`. On success it
   writes `WEBDESK_API_IMAGE=…@<digest>` into `/etc/webdesk/.env` (value never printed) and
   `~/gaiada-webdesk/.deployed-tag`.
3. **Failure.** Before the swap nothing live has changed. A tools-step (migration) failure restores the old tree and
   leaves the api untouched. A health failure restores the old tree and re-pins `webdesk-api:pre-<tag>` (previous
   arrangement: the two compose files plus `webdesk-api:latest`, or the release overlay if it ran that way). **Migrations
   are never rolled back**; restore the dump only for data loss.

**Roll back later** (after a green apply you want to undo): on the box,
`bash <a copy of deploy-webdesk.sh> rollback` re-pins the most recent `pre-*` image and tree and restores the previous
`WEBDESK_API_IMAGE` line / `.deployed-tag`. Or dispatch `apply` with the previous tag (a new pull-and-migrate cycle).

**Not automated**: a changed `proxy/` or `postgres/` (apply recreates only `api`; the plan prints a NOTE), new env
variables (add them to `/etc/webdesk/.env` first; `compose config -q` in the plan fails loudly on a missing required
one), release-note-specific steps.

**After the first automated apply, every compose call must use all three files.** The api then runs from the release
overlay, with `WEBDESK_API_IMAGE` read from `/etc/webdesk/.env`. The two-file form (`docker-compose.yml` +
`docker-compose.aicenter.yml`) would silently swap the api back to whatever `webdesk-api:latest` is.

The manual procedure below stays as the fallback (with the three files once automation has run).

## Facts

| What | Where |
|---|---|
| Compose project | `/home/Hansel/gaiada-webdesk/webdesk` (`docker-compose.yml` + `docker-compose.aicenter.yml`) |
| Env file | `/etc/webdesk/.env` (owner `webdesk-svc`, 600). Every compose call needs `--env-file /etc/webdesk/.env` and `sudo -n`. |
| Migrations | run as `webdesk_migrator` from a throwaway `node:22-bookworm` container on the project network |
| Image | `ghcr.io/hansel-gaiada/gaiada-webdesk-api:v1.0.0-alpha.<N>`, run locally as `webdesk-api:latest` |
| Box GHCR login | the deploy job's token, which EXPIRES after the job: a later `docker pull` on the box is `denied` |

## Steps

1. **Verify the signature and get the digest** (on the box; cosign from `gcr.io/projectsigstore/cosign:v2.4.1`, because
   the ghcr cosign image is refused with the box's stale login):
   `cosign verify ghcr.io/hansel-gaiada/gaiada-webdesk-api:<tag> --certificate-identity-regexp "https://github.com/hansel-gaiada/.+/.github/workflows/release.yml@.+" --certificate-oidc-issuer https://token.actions.githubusercontent.com`
   and read `critical.image.docker-manifest-digest`.
2. **Bring the image to the box by that digest**: pull `…@<digest>` on a machine that can read GHCR, then
   `docker save | gzip -1 | ssh gda-aicenter 'gunzip | docker load'`. On the box the loaded image id must EQUAL the signed
   digest; refuse otherwise.
3. **Back up**: `pg_dump -Fc` of the webdesk DB (from `webdesk-postgres-1`) to `/home/Hansel/backups/webdesk-pre-<N>-<ts>/`,
   the two compose files, the `migrations/` dir, and tag the running image `webdesk-api:pre-<N>`.
4. **Install the release's webdesk tree pieces** into the project dir from `git -c core.autocrlf=false archive
   v1.0.0-alpha.<N>:webdesk migrations scripts package.json package-lock.json docker-compose.yml docker-compose.aicenter.yml`
   (refuse if any file has CR). Leave `proxy/Caddyfile` alone unless the release changed it (the proxy bind-mounts it and
   needs `--force-recreate` to see a replaced file). `compose config -q` must pass.
5. **Migrate** as `webdesk_migrator`, twice (the second run must apply 0), then `scripts/check-rls-integrity.mjs` as the
   owner. Migrations run BEFORE the new api starts.
6. **Release-specific steps**, from the release notes / the M3 session:
   - storage policy changes: re-run `scripts/storage-bootstrap.mjs` (idempotent; e.g. 43a's media-purge needs
     DeleteObjectVersion + ListBucketVersions on media/video);
   - new env: add to `/etc/webdesk/.env` (e.g. `WEBDESK_UPLOAD_CORS_ORIGINS=https://erp.gaiada.online` for 43a uploads).
7. **Swap**: `docker tag webdesk-api:<N>-verified webdesk-api:latest`, then
   `compose up -d --no-deps --no-build api`.
8. **Verify**: `listening on :3000`; `editorial JWKS loaded … kid(s) wde-…`; proxy `GET /healthz` 200; editorial probes
   P1 `401 editorial-assertion-missing` and P2 `403 editorial-assertion-command-mismatch` (`webdesk-editorial-keys.md`);
   an importer dry run (`node dist/seed/webdesk-import.js … ` without `--apply`) reads the site back unchanged; with the
   scheduler on, the boot log lists its job schedulers and a first catch-up pass with 0 unexpected transitions.

**Rollback**: `docker tag webdesk-api:pre-<N> webdesk-api:latest`, restore the compose files from the backup dir,
`up -d --no-deps --no-build api`. A migration is never rolled back in place; restore the dump only for data loss.

## History

| Release | Migrations applied live | Notes |
|---|---|---|
| (WSK-56, 2026-10-10) | 0001–0009 (DB rebuilt) | first real deploy; RustFS; Payload gateway removed |
| 344 | — | first signed image; editorial JWKS mount |
| 348 | 0010, 0011 | M3 wave 2 + WSK-48b; payload service removed |
| 351 | 0012, 0013, 0014 | M3 waves 3 + 4: scheduler ON (4 job schedulers; first tick 0 transitions), preview tokens, media library; storage-bootstrap re-run (changes=1, then 0); `WEBDESK_UPLOAD_CORS_ORIGINS=https://erp.gaiada.online` added |
