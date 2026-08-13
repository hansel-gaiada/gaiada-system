# Repo map — GENERATED, do not edit by hand

> Regenerate with `node scripts/gen-map.mjs`. CI (`docs-map` job) fails if this file does not
> match the repo, so it cannot go stale — if it disagrees with what you see, regenerate, don't
> patch. Deliberately structural only: no versions, no status, no counts that move on their own.
> Status lives in `docs/modules/MODULES.md`; rules live in the per-component `CLAUDE.md` files.

## Components

| Dir | Kind | Module / package | Entrypoints | Dockerfile | CLAUDE.md |
|---|---|---|---|---|---|
| `ai-agents/` | node | `gaiada-ai-agents` | `run-agent` | yes | yes |
| `ai-gateway-go/` | go | `gaiada/ai-gateway-go` | `cmd/gateway` | yes | yes |
| `capture-helper/` | node | `gaiada-capture-helper` | `start` | — | **missing** |
| `hermes-gateway/` | node | `hermes-gateway` | `start` | — | **missing** |
| `mcp-hub/` | node | `gaiada-mcp-hub` | `dev · start` | yes | yes |
| `platform-nest/` | node | `gaiada-platform-nest` | `start` | yes | yes |
| `platform-ui/` | node | `gaiada-platform-ui` | `dev · start` | yes | yes |
| `report-renderer/` | node | `gaiada-report-renderer` | `dev · start` | yes | **missing** |
| `search-crawl-go/` | go | `gaiada/search-crawl-go` | `cmd/crawl` | yes | **missing** |
| `sync-engine-go/` | go | `gaiada/sync-engine-go` | `cmd/sync · cmd/synccert` | yes | yes |
| `wa-chat-bot/` | node | `gaiada-wa-bot` | `dev · start` | yes | yes |

Node scripts per component:

- `ai-agents` — `run-agent`, `test`, `typecheck`
- `capture-helper` — `check`, `devices`, `drive-token`, `start`
- `hermes-gateway` — `start`, `test`
- `mcp-hub` — `dev`, `start`, `test`, `typecheck`
- `platform-nest` — `build`, `gen:role-bundles`, `gen:scope-constrained-roles`, `lint:migration-rls`, `lint:postiz-deps`, `lint:withtenants`, `mail:replay-inbound`, `migrate`, `seed:agency`, `seed:automation`, `seed:claude-seats`, `seed:departments`, `seed:personas`, `seed:portal-clients`, `seed:search`, `start`, `test`, `test:iam-chain-alignment`, `test:mail-corpus`, `typecheck`
- `platform-ui` — `build`, `dev`, `e2e`, `e2e:a11y`, `start`, `test`, `test:watch`, `typecheck`
- `report-renderer` — `dev`, `start`, `test`, `typecheck`
- `wa-chat-bot` — `dev`, `gateway`, `media-worker`, `start`, `test`, `typecheck`

## Compose

All compose files in `infra/compose/`: `docker-compose.alertmanager-mail.yml`, `docker-compose.build.yml`, `docker-compose.devui.yml`, `docker-compose.hostdata.yml`, `docker-compose.local.yml`, `docker-compose.loki.yml`, `docker-compose.obs-local.yml`, `docker-compose.observability.yml`, `docker-compose.otel-metrics.yml`, `docker-compose.social.yml`, `docker-compose.vps.yml`.
Never run one alone — see `infra/CLAUDE.md` for the required pairs.

### `infra/compose/docker-compose.vps.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `agent-runner` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-ai-agents:${GAIADA_TAG:-latest} | — | — | postgres, ai-gateway, mcp-hub |
| `ai-gateway` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-ai-gateway-go:${GAIADA_TAG:-latest} | — | — | — |
| `bot` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-wa-chat-bot:${GAIADA_TAG:-latest} | `bot` | — | pg-bot, ai-gateway |
| `bot-media-worker` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-wa-chat-bot:${GAIADA_TAG:-latest} | `bot` | — | pg-bot, redis-bot |
| `cerbos` | ghcr.io/cerbos/cerbos:0.54.0 | — | — | — |
| `clamav` | clamav/clamav:1.5.3 | `scan` | — | — |
| `keycloak` | quay.io/keycloak/keycloak:26.0 | `auth` | `127.0.0.1:8080:8080` | postgres |
| `knowledge` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-ai-agents:${GAIADA_TAG:-latest} | — | — | postgres, platform, ai-gateway |
| `mailpit` | axllent/mailpit:v1.30.6 | `mail-dev` | `127.0.0.1:8025:8025` | — |
| `mcp-hub` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-mcp-hub:${GAIADA_TAG:-latest} | — | `127.0.0.1:3003:3003` | ai-gateway, platform, cerbos |
| `mcp-hub-central` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-mcp-hub:${GAIADA_TAG:-latest} | `multisite` | — | ai-gateway, platform, cerbos |
| `pg-bot` | postgres:17-alpine | `bot` | — | — |
| `platform` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-platform-nest:${GAIADA_TAG:-latest} | — | `127.0.0.1:3004:3004` | postgres, cerbos, redis, whisper |
| `platform-ui` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-platform-ui:${GAIADA_TAG:-latest} | — | `3005:3005` | platform |
| `postgres` | postgres:17-alpine | `data` | `127.0.0.1:55433:5432` | — |
| `redis` | redis:7-alpine | `data` | — | — |
| `redis-bot` | redis:7-alpine | `bot` | — | — |
| `report-renderer` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-report-renderer:${GAIADA_TAG:-latest} | — | — | platform-ui |
| `search-crawl` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-search-crawl-go:${GAIADA_TAG:-latest} | `jobs` | — | postgres |
| `sync-central` | ghcr.io/${GHCR_OWNER:-hansel-gaiada}/gaiada-sync-engine-go:${GAIADA_TAG:-latest} | `multisite` | — | postgres |
| `waha` | devlikeapro/waha:noweb-2026.7.2 | `bot` | `127.0.0.1:3000:3000` | — |
| `whisper` | fedirz/faster-whisper-server:latest-cpu | `whisper` | — | — |

### `infra/compose/docker-compose.local.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `cerbos` | — | — | `127.0.0.1:3592:3592` `127.0.0.1:3593:3593` | — |
| `mcp-hub` | — | — | `127.0.0.1:3003:3003` | — |
| `pg-bot` | — | — | `127.0.0.1:55434:5432` | — |
| `platform` | — | — | `127.0.0.1:3004:3004` | — |
| `redis-test` | redis:7-alpine | — | `127.0.0.1:56380:6379` | — |
| `report-renderer` | — | — | `127.0.0.1:3007:3007` | — |
| `waha` | — | — | — | — |

### `infra/compose/docker-compose.hostdata.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `agent-runner` | — | — | — | — |
| `ai-gateway` | — | — | — | — |
| `keycloak` | — | — | — | — |
| `knowledge` | — | — | — | — |
| `mcp-hub` | — | — | — | — |
| `platform` | — | — | — | — |
| `platform-ui` | — | — | — | — |
| `search-crawl` | — | — | — | — |

### `infra/compose/docker-compose.observability.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `ai-gateway` | — | — | — | — |
| `alertmanager` | prom/alertmanager:v0.28.0 | — | — | alertmanager-render |
| `alertmanager-render` | alpine:3.21 | — | — | — |
| `blackbox-exporter` | prom/blackbox-exporter:v0.25.0 | — | — | — |
| `bot` | — | — | — | — |
| `bot-media-worker` | — | — | — | — |
| `cadvisor` | gcr.io/cadvisor/cadvisor:v0.49.1 | — | — | — |
| `grafana` | grafana/grafana:11.4.0 | — | `127.0.0.1:3001:3000` | prometheus, tempo, loki |
| `knowledge` | — | — | — | — |
| `loki` | grafana/loki:3.3.2 | — | — | — |
| `mcp-hub` | — | — | — | — |
| `node-exporter` | prom/node-exporter:v1.8.2 | — | — | — |
| `ntfy` | binwiederhier/ntfy:v2.11.0 | — | — | — |
| `otel-collector` | otel/opentelemetry-collector-contrib:0.116.1 | — | — | tempo, loki |
| `platform` | — | — | — | — |
| `postgres-exporter` | quay.io/prometheuscommunity/postgres-exporter:v0.16.0 | — | — | prometheus |
| `postgres-exporter-bot` | quay.io/prometheuscommunity/postgres-exporter:v0.16.0 | — | — | — |
| `prometheus` | prom/prometheus:v3.1.0 | — | `127.0.0.1:9090:9090` | — |
| `redis-exporter` | oliver006/redis_exporter:v1.67.0 | — | — | — |
| `redis-exporter-bot` | oliver006/redis_exporter:v1.67.0 | — | — | — |
| `sync-central` | — | — | — | — |
| `synthetic-prober` | ../../infra/observability/synthetic-prober | — | — | otel-collector |
| `tempo` | grafana/tempo:2.7.0 | — | — | — |

### `infra/compose/docker-compose.build.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `agent-runner` | (block) | — | — | — |
| `ai-gateway` | ../../ai-gateway-go | — | — | — |
| `bot` | ../../wa-chat-bot | — | — | — |
| `bot-media-worker` | ../../wa-chat-bot | — | — | — |
| `knowledge` | (block) | — | — | — |
| `mcp-hub` | ../../mcp-hub | — | — | — |
| `mcp-hub-central` | ../../mcp-hub | — | — | — |
| `platform` | ../../platform-nest | — | — | — |
| `platform-ui` | ../../platform-ui | — | — | — |
| `report-renderer` | ../../report-renderer | — | — | — |
| `search-crawl` | ../../search-crawl-go | — | — | — |
| `sync-central` | ../../sync-engine-go | — | — | — |

### `infra/compose/docker-compose.social.yml`

| Service | Image / build | Profiles | Ports | depends_on |
|---|---|---|---|---|
| `postiz` | ghcr.io/gitroomhq/postiz-app@sha256:785f97312f66a347fb96cdccc4ded5a33ced69a672c89a9adc8054e7d6a21dc5 | `social` | `${SOCIAL_BIND_ADDR:-127.0.0.1}:${SOCIAL_POSTIZ_PORT:-4007}:5000` | — |
| `social-postgres` | postgres:17-alpine | `social` | — | — |
| `social-redis` | redis:7.2-alpine | `social` | — | — |
| `social-temporal` | temporalio/auto-setup:1.28.1 | `social` | — | — |
| `social-temporal-postgres` | postgres:16-alpine | `social` | — | — |

## platform-nest — modules

| Dir | Contract key | Registered in `main.ts` |
|---|---|---|
| `agency` | `agency` | yes |
| `assistant` | `assistant` | yes |
| `automation-console` | `automation-console` | yes |
| `billing` | `billing` | yes |
| `clients` | `clients` | yes |
| `hr` | `hr` | yes |
| `it` | `it` | yes |
| `knowledge` | `knowledge` | yes |
| `pm` | `pm` | yes |
| `reports` | `reports` | yes |
| `search` | `search` | yes |
| `social` | `social` | yes |
| `webdev` | `webdev` | yes |

## platform-nest — migrations

- Head: `0108_iam_gap_02_invoice_self_approval_deny_and_revisions.sql`
- Next free number: `0109` — **reserve it by creating the file**, concurrent sessions share this checkout.
- Applied files on disk: 107
- Unused numbers below head: `0058`, `0059`, `0070` (dead reservations — do not backfill)

## platform-nest — HTTP surface (`@Controller` prefixes)

| Prefix | File |
|---|---|
| _(root)_ | `platform-nest/src/health/health.controller.ts` |
| _(root)_ | `platform-nest/src/identity/identity.controller.ts` |
| _(root)_ | `platform-nest/src/modules/reports/print-payload.controller.ts` |
| _(root)_ | `platform-nest/src/modules/search/search-google-oauth.controller.ts` |
| _(root)_ | `platform-nest/src/modules/search/search.controller.ts` |
| `/api` | `platform-nest/src/admin/admin-identity.controller.ts` |
| `/api` | `platform-nest/src/admin/company-admin.controller.ts` |
| `/api` | `platform-nest/src/admin/company-crud.controller.ts` |
| `/api` | `platform-nest/src/admin/intelligence.controller.ts` |
| `/api` | `platform-nest/src/admin/service-assignments.controller.ts` |
| `/api` | `platform-nest/src/core/approvals-decide.controller.ts` |
| `/api` | `platform-nest/src/core/approvals.controller.ts` |
| `/api` | `platform-nest/src/core/authz-check.controller.ts` |
| `/api` | `platform-nest/src/core/authz-permissions.controller.ts` |
| `/api` | `platform-nest/src/core/automation-approvals.controller.ts` |
| `/api` | `platform-nest/src/core/claude-seats.controller.ts` |
| `/api` | `platform-nest/src/core/client-contacts.controller.ts` |
| `/api` | `platform-nest/src/core/client-work.controller.ts` |
| `/api` | `platform-nest/src/core/collab.controller.ts` |
| `/api` | `platform-nest/src/core/contracts.controller.ts` |
| `/api` | `platform-nest/src/core/core.controller.ts` |
| `/api` | `platform-nest/src/core/creative.controller.ts` |
| `/api` | `platform-nest/src/core/custom-fields.controller.ts` |
| `/api` | `platform-nest/src/core/files.controller.ts` |
| `/api` | `platform-nest/src/core/integrations.controller.ts` |
| `/api` | `platform-nest/src/core/meetings.controller.ts` |
| `/api` | `platform-nest/src/core/pipeline.controller.ts` |
| `/api` | `platform-nest/src/core/portal-commerce.controller.ts` |
| `/api` | `platform-nest/src/core/portal-profile.controller.ts` |
| `/api` | `platform-nest/src/core/portal-stream.controller.ts` |
| `/api` | `platform-nest/src/core/portal-workspace.controller.ts` |
| `/api` | `platform-nest/src/core/portal.controller.ts` |
| `/api` | `platform-nest/src/core/tasks-mine.controller.ts` |
| `/api` | `platform-nest/src/core/webdev-change-requests-portal.controller.ts` |
| `/api` | `platform-nest/src/core/webdev-change-requests.controller.ts` |
| `/api` | `platform-nest/src/core/work-activity.controller.ts` |
| `/api` | `platform-nest/src/mail/thread.controller.ts` |
| `/api` | `platform-nest/src/modules/assistant/assistant.controller.ts` |
| `/api` | `platform-nest/src/modules/billing/billing.controller.ts` |
| `/api` | `platform-nest/src/modules/clients/clients.controller.ts` |
| `/api` | `platform-nest/src/modules/it/it.controller.ts` |
| `/api` | `platform-nest/src/modules/module-catalog.controller.ts` |
| `/api` | `platform-nest/src/modules/pm/pm.controller.ts` |
| `/api/:tenantId/appraisals` | `platform-nest/src/modules/reports/appraisals.controller.ts` |
| `/api/:tenantId/checkins` | `platform-nest/src/modules/reports/checkins.controller.ts` |
| `/api/:tenantId/modules/agency` | `platform-nest/src/modules/agency/agency.controller.ts` |
| `/api/:tenantId/modules/hr` | `platform-nest/src/modules/hr/hr.controller.ts` |
| `/api/:tenantId/modules/hr` | `platform-nest/src/modules/hr/loans.controller.ts` |
| `/api/:tenantId/modules/search` | `platform-nest/src/modules/search/search-google-ads.controller.ts` |
| `/api/:tenantId/modules/search` | `platform-nest/src/modules/search/search-reports.controller.ts` |
| `/api/:tenantId/modules/search` | `platform-nest/src/modules/search/search.controller.ts` |
| `/api/:tenantId/modules/social` | `platform-nest/src/modules/social/social.controller.ts` |
| `/api/:tenantId/modules/webdev` | `platform-nest/src/modules/webdev/webdev.controller.ts` |
| `/api/:tenantId/reports` | `platform-nest/src/modules/reports/reports.controller.ts` |
| `/api/admin` | `platform-nest/src/admin/admin-systems.controller.ts` |
| `/api/admin/bot` | `platform-nest/src/admin/bot-admin.controller.ts` |
| `/api/admin/mail` | `platform-nest/src/mail/admin-mail.controller.ts` |
| `/api/mail` | `platform-nest/src/mail/inbound.controller.ts` |
| `/api/mail` | `platform-nest/src/mail/webhook.controller.ts` |
| `/api/search/google/oauth` | `platform-nest/src/modules/search/search-google-oauth.controller.ts` |
| `/internal/reports/print-payload` | `platform-nest/src/modules/reports/print-payload.controller.ts` |
| `/mcp` | `platform-nest/src/modules/mcp-tools.controller.ts` |

## platform-ui — routes

Pages (`page.tsx`), route groups `(x)` stripped:

- `/`
- `/[...placeholder]`
- `/account`
- `/admin`
- `/admin/about`
- `/admin/audit`
- `/admin/compliance`
- `/admin/identity`
- `/admin/mail`
- `/admin/mail/[id]`
- `/admin/modules`
- `/admin/services`
- `/admin/users`
- `/agency`
- `/agency/[campaignId]`
- `/agency/new`
- `/agents`
- `/agents/goals/[goalId]`
- `/agents/runs/[runId]`
- `/appraisals`
- `/appraisals/[id]`
- `/appraisals/cycles`
- `/appraisals/cycles/[id]`
- `/appraisals/mine`
- `/approvals`
- `/approvals/[id]`
- `/assistant`
- `/assistant`
- `/billing`
- `/billing/[invoiceId]`
- `/billing/new`
- `/calendar`
- `/clients`
- `/clients/[clientId]`
- `/clients/new`
- `/companies`
- `/companies/[companyId]`
- `/companies/[companyId]/edit`
- `/companies/[companyId]/org`
- `/companies/new`
- `/deliverables`
- `/deliverables/new`
- `/departments`
- `/departments/[deptId]`
- `/departments/[deptId]/activity`
- `/departments/[deptId]/ads`
- `/departments/[deptId]/ai-visibility`
- `/departments/[deptId]/analytics`
- `/departments/[deptId]/assets`
- `/departments/[deptId]/audit`
- `/departments/[deptId]/ball`
- `/departments/[deptId]/board`
- `/departments/[deptId]/briefs`
- `/departments/[deptId]/calendar`
- `/departments/[deptId]/charts`
- `/departments/[deptId]/composer`
- `/departments/[deptId]/composer/[postId]`
- `/departments/[deptId]/connections`
- `/departments/[deptId]/deliverables`
- `/departments/[deptId]/engagements`
- `/departments/[deptId]/engagements/[engagementId]`
- `/departments/[deptId]/gsc-ga4`
- `/departments/[deptId]/inbox`
- `/departments/[deptId]/keywords`
- `/departments/[deptId]/ledger`
- `/departments/[deptId]/pacing`
- `/departments/[deptId]/planner`
- `/departments/[deptId]/planner/[campaignId]`
- `/departments/[deptId]/prd`
- `/departments/[deptId]/projects`
- `/departments/[deptId]/projects/[projectId]`
- `/departments/[deptId]/projects/[projectId]/tasks/[taskId]`
- `/departments/[deptId]/rankings`
- `/departments/[deptId]/reports`
- `/departments/[deptId]/repositories`
- `/departments/[deptId]/requests`
- `/departments/[deptId]/search-terms`
- `/departments/[deptId]/studio`
- `/departments/[deptId]/timeline`
- `/departments/[deptId]/tools`
- `/hr`
- `/hr/attendance`
- `/hr/cases`
- `/hr/cases/[caseId]`
- `/hr/leave`
- `/hr/onboarding`
- `/hr/people`
- `/invite/[token]`
- `/it`
- `/it/devices`
- `/it/devices/[deviceId]`
- `/it/topology`
- `/it/workflows`
- `/knowledge`
- `/login`
- `/me`
- `/me/inbox`
- `/me/leave`
- `/me/loans`
- `/me/loans/[loanId]`
- `/meetings`
- `/meetings/[id]`
- `/monitoring`
- `/monitoring/[id]`
- `/notifications`
- `/organization`
- `/people`
- `/people/[userId]`
- `/people/[userId]/edit`
- `/people/new`
- `/pipeline`
- `/pipeline/[runId]`
- `/pm`
- `/portal`
- `/portal/approvals`
- `/portal/approvals/[runId]`
- `/portal/contracts`
- `/portal/contracts/[contractId]`
- `/portal/deliverables`
- `/portal/invoices`
- `/portal/invoices/[invoiceId]`
- `/portal/profile`
- `/portal/projects`
- `/portal/projects/[projectId]`
- `/portal/requests`
- `/portal/timeline`
- `/print/reports/[jobToken]`
- `/project-management`
- `/projects`
- `/projects/[projectId]`
- `/projects/[projectId]/edit`
- `/projects/new`
- `/reports/company`
- `/reports/department`
- `/reports/person`
- `/reports/project`
- `/rollups`
- `/search`
- `/step-up`
- `/systems/automation`
- `/systems/bot`
- `/systems/gateway`
- `/systems/hub`
- `/tasks`
- `/tasks/[taskId]`
- `/tasks/[taskId]`
- `/tasks/[taskId]/edit`
- `/tasks/new`
- `/timesheets`

Browser-facing route handlers (`route.ts`) — these exist only where the browser itself must hit a URL:

- `/api/admin/agents/goals`
- `/api/admin/bot/actions/[state]`
- `/api/admin/bot/actions/audit`
- `/api/admin/bot/chats`
- `/api/admin/bot/chats/[chatId]/messages`
- `/api/admin/bot/digests`
- `/api/admin/bot/digests/groups`
- `/api/admin/bot/digests/preview`
- `/api/admin/bot/digests/run/[slot]`
- `/api/admin/bot/media/status`
- `/api/admin/bot/search`
- `/api/admin/bot/session`
- `/api/admin/bot/session/events`
- `/api/admin/bot/skills`
- `/api/assistant/threads/[id]/stream`
- `/api/meetings/[id]/status`
- `/api/portal/stream`
- `/api/search/change-proposals/[id]/export-file`
- `/api/search/google/callback`
- `/auth/callback`
- `/auth/login`
- `/auth/magic`

## automation — n8n workflows

Declared `id` is load-bearing (sub-workflow references). Import with the CLI, never the public API — see `automation/CLAUDE.md`.

| File | Declared id | Name |
|---|---|---|
| `compliance-gate-nag.json` | — | compliance-gate-nag (CRON) |
| `digest-fanout.json` | — | digest-fanout (CRON) |
| `mtg-dispatcher.json` | `ws11mtgdispatch0` | WS11 meeting dispatcher (transcript -> MOM -> 3 extractions -> pipeline run) |
| `on-client-created-seed.json` | — | on client.created -> seed project+task (EVENT, low-impact write) |
| `on-inbound-lead.json` | — | on inbound lead -> task (WEBHOOK ingest, GATED) |
| `on-org-updated-notify.json` | — | on org_structure.updated -> notify (EVENT) |
| `pipeline-delivery.json` | `ws11delivery0001` | WS11 delivery track (hard gate -> design -> 3-beat -> revise loop -> Claude Code -> staging -> prod) |
| `pipeline-fanout.json` | `ws11fanout000001` | WS11 fan-out (on pipeline.run.created -> scope sign-off + report route) |
| `reports-eod-reminder.json` | — | reports-eod-reminder (CRON) |
| `reports-monthly-seal.json` | — | reports-monthly-seal (CRON) |
| `reports-morning-escalation.json` | — | reports-morning-escalation (CRON) |
| `reports-nightly-facts.json` | — | reports-nightly-facts (CRON) |
| `reports-weekly-seal.json` | — | reports-weekly-seal (CRON) |
| `stale-approval-chaser.json` | — | stale-approval-chaser (CRON) |
| `summarize-via-mcp.json` | — | summarize-via-mcp (template) |
| `task-sla.json` | — | task-sla (CRON) |
| `wd-digests.json` | `wswddigests00001` | wd-digests (CRON) |
| `wd-provision.json` | `wswdprovision0001` | Subworkflow: webdev.provisionSite (PRV-03 provision<->ERP seam) |
| `wd-stale-nag.json` | `wswdstalenag0001` | wd-stale-nag (CRON) |

## Docs, runbooks, guides

Contracts + top-level docs (`docs/`): `BLUEPRINTS.md`, `FRONTEND-BFF-CONTRACT.md`, `PERMISSION-CONTRACT.md`, `a11y-manual-checklist.md`, `sidebar-nav-map.md`, `ui-work-split.md`

Runbooks (`infra/runbooks/`): `db-topology-cutover.md`, `deploy-vps.md`, `enable-mfa.md`, `local-model-serving.md`, `nginx-mail-inbound-route.md`, `observability-loki.md`, `observability-slo.md`, `observability.md`, `restore-drill.md`

Ops scripts (`infra/scripts/`): `backup-cron.sh`, `backup.sh`, `healthcheck.sh`, `lint-observability.sh`, `restore-drill.sh`, `test-all.sh`, `wire-env.sh`

Component guides: `CLAUDE.md`, `ai-agents/CLAUDE.md`, `ai-gateway-go/CLAUDE.md`, `automation/CLAUDE.md`, `infra/CLAUDE.md`, `mcp-hub/CLAUDE.md`, `platform-nest/CLAUDE.md`, `platform-ui/CLAUDE.md`, `sync-engine-go/CLAUDE.md`, `wa-chat-bot/CLAUDE.md`

