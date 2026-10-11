# Runbook: update the LIVE WebDesk api on gda-aicenter to a release

WebDesk is **not** deployed by `deploy.yml`: the release workflow builds and signs `gaiada-webdesk-api`, and a person
(today the WebDesk orchestrator session, under WSK-D43: "act directly inside the `webdesk` compose project only, backup
first") swaps it into the `webdesk` compose project by hand. As executed for 344 (first swap) and 348 (M3 wave 2 +
WSK-48b, migrations 0010/0011), 2026-10-11.

**Never build the api on gda-aicenter** (it is the live ERP box; one build drove load to 16 on 4 cores).

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
