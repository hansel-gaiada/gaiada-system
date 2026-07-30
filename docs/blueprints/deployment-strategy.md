# Deployment Strategy — one repo, one deploy point

**Status: IN PROGRESS (2026-07-30).** Pipeline is written and YAML-validated, but **not yet
DEV-VERIFIED** — it has never run. Verification is gated on the four repo secrets below and one
real tag push. Do not describe this as working until a `deploy` run is green.

---

## 1. Repository shape — one repo, many services

**Decision: keep `gaiada-system` as a single git repository.** Components stay standalone
projects (own `package.json`/`go.mod`, own Dockerfile, own image, independently deployable) —
`CLAUDE.md`'s "not a monorepo" rule means *no shared-package workspace*, and that is preserved.

Rejected: one repo per service (9+ repos). Costs, concretely:

- `release.yml` builds `context: ./<component>` from one checkout as a 7-way matrix. Splitting
  means 9 pipelines to maintain and keep in lockstep.
- `docker-compose.vps.yml` referenced siblings by relative path. Splitting forces submodules
  or vendoring.
- The normal change here is *cross-cutting* — `migration + platform-nest endpoint +
  platform-ui page + FRONTEND-BFF-CONTRACT.md`. One repo makes that one atomic, revertable
  commit; nine repos make it a coordinated multi-PR dance with no atomic rollback.
- Single maintainer iterating across all services daily. Polyrepo buys isolation that isn't
  needed and taxes the operation performed constantly.

Independent deployability comes from **per-service images**, not per-service repos.

## 2. The problem this replaces

Before 2026-07-30, `docker-compose.vps.yml` used `build: ../../<component>` for all eleven
first-party services, and the runbook said `git pull && docker compose up -d --build`.

Consequences:

- **Production compiled from source.** Go, Next.js and Nest builds ran on the VPS on every
  deploy — slow, and a Next build can OOM a small box.
- **Toolchains + full source on the production box**, for no runtime reason.
- **The supply-chain pipeline was decorative.** `release.yml` published cosign-signed,
  SBOM-attested, SLSA-provenanced images to GHCR that *nothing consumed*. The artifact
  running in production was never the artifact that was signed.
- **`search-crawl-go` was never published at all** — it had a Dockerfile and a compose
  service but was missing from the release matrix.
- **Migrations were not part of any deploy.** Schema drift was manual and unenforced.

## 3. Target — a git tag is the only deploy input

```
git push --tags
  │
  ├─ release.yml   8 components → build → GHCR
  │                 cosign sign (keyless) + SPDX SBOM + SLSA provenance
  │
  └─ deploy.yml    (needs: build-sign)
       1. cosign verify every image  ← refuses unsigned/foreign artifacts
       2. rsync compose + scripts to the VPS   (no app source; .env stays on the box)
       3. record currently deployed tag        → rollback anchor
       4. backup.sh                            ← HARD GATE for step 5
       5. migrate  (platform image, platform_owner via MIGRATE_DATABASE_URL)
       6. compose up -d --no-build
       7. health wait loop (60 × 5s)
       8. write .deployed-tag
     on failure → re-pin previous tag automatically
```

Rollback is `GAIADA_TAG=<previous>` — a container restart, not a rebuild, because the images
are already on the box. Available as a manual `workflow_dispatch` on `deploy.yml`.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | One repo, per-service images | §1 |
| Deploy trigger | Tag → GH Actions SSH push | Deterministic, logged in Actions, one input |
| Image source | `image:` pinned to `${GAIADA_TAG}` | Deploy the signed artifact; never build on prod |
| Local dev | `docker-compose.build.yml` override | Keeps build-from-source for the working tree |
| Migrations | Automatic, gated on a successful backup | Removes drift; backup is the escape hatch |
| Signature check | `cosign verify` before deploy | Makes WS10 load-bearing, not decorative |
| Host key | Pinned via `VPS_SSH_KNOWN_HOSTS` | Never `StrictHostKeyChecking=no` on a deploy path |
| Registry auth | Per-deploy short-lived `GITHUB_TOKEN` | No long-lived registry PAT stored on the box |
| Rollback | Re-pin previous tag; schema forward-only | Fast and safe; DB reverts come from the backup |
| Concurrency | `cancel-in-progress: false` | A half-applied migration is worse than a queued deploy |

## 5. Files

| File | Role |
|---|---|
| `.github/workflows/release.yml` | Build + sign + attest 8 images; calls `deploy` |
| `.github/workflows/deploy.yml` | Verify → backup → migrate → up → health → rollback |
| `infra/compose/docker-compose.vps.yml` | Production: all services pinned to GHCR images |
| `infra/compose/docker-compose.build.yml` | Local override restoring `build:` |
| `infra/runbooks/deploy-vps.md` | Bootstrap + break-glass path |

## 6. Required configuration (blocks verification)

Repo **secrets** — Settings → Secrets and variables → Actions:

| Name | Value |
|---|---|
| `VPS_HOST` | VPS hostname/IP |
| `VPS_USER` | deploy user |
| `VPS_SSH_KEY` | private key of a deploy-only keypair (its public key in the user's `authorized_keys`) |
| `VPS_SSH_KNOWN_HOSTS` | output of `ssh-keyscan <host>` — pins the host key |

Repo **variable**: `DEPLOY_DIR` — absolute path of the checkout on the VPS
(e.g. `/home/deploy/gaiada-system`).

An `production` **environment** is referenced by `deploy.yml`; add required reviewers there if
you later want a manual approval gate before each deploy.

## 7. Known gaps / next steps

- **Never executed.** No Docker in the dev environment, so `pull`/`migrate`/health-wait are
  unverified against a real box. First tag push is the real test — watch it.
- **Health check is coarse.** It waits on compose container health, not functional journeys.
  `infra/scripts/healthcheck.sh` already does functional `/health` probes and the WS9 synthetic
  journeys go further; wiring one of those in as the gate is the obvious upgrade.
- **No blue/green or drain.** `up -d` restarts changed containers in place; expect a short
  blip. Acceptable for one box, revisit if uptime targets tighten.
- **Forward-only migrations.** No automated down-migration. Restore from the pre-deploy backup.
- **`automation/` (n8n) is a separate stack** and is not covered by this pipeline.
- **No `.gitattributes`.** Git reports CRLF/LF conversion on nearly every file on this Windows
  checkout. Harmless today but it inflates diffs; a normalization pass is worth doing.
