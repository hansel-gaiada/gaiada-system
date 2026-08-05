# Dev-server readiness audit — D14 resume path + ERP assistant (Phases 0–3) + mail/portal

**Target:** `gda-aicenter` / `erp.gaiada.online`
**Scope commit:** `985e6ff` (assistant Phase-3 gate) plus `8703179` (HEAD, a test fixup on top of it)
**Audit performed:** 2026-08-06, read-only against the repo and a live, read-only SSH session to
`gda-aicenter`. **No deploy, restart, or mutation was performed.** Every write-looking check below
(`docker compose config`, `lint:migration-rls`) ran against a local scratch env file, never against
the server.

Three sessions are live in this checkout; VERSION/CHANGELOG/MODULES.md were seen changing under this
audit (see item 5) — that is a concurrent session doing its own work, not this audit.

---

## Go/No-Go table

| # | Item | Verdict | Verified against |
|---|------|---------|-------------------|
| 1 | Migrations 0078/0079 apply cleanly | **GO** (already proven) | Live server |
| 2 | Cerbos new-policy-file trap | **GO**, with one caveat | Live server (structural) |
| 3 | Env passthrough | **NO-GO** (1 var pair missing) / GO (rest) | Local `docker compose config` + live server |
| 4 | nginx SSE block | **MANUAL / NOT YET APPLIED** | Live server |
| 5 | Version/tag parity | **NO-GO — cut required, and one may already be in flight** | Repo + `gh` |
| 6 | hermes-gateway new endpoint | **NO-GO** (stale binary) | Live server |
| 7 | `--remove-orphans` profiles | **GO** | `gh variable list` + compose file |
| 8 | Assistant module enablement | **NO-GO — seed not re-run on dev tenant** | Live server DB (read-only) |

---

## 1. Migrations — GO (already applied and proven, not merely predicted)

This is better than "will apply cleanly" — it has **already been applied**, on this exact server,
successfully:

```
$ ssh gda-aicenter 'sudo -u postgres psql -d gaiada_platform -c "select * from schema_migrations order by 1 desc limit 3;"'
0079_module_assistant.sql | 2026-08-05 13:31:48.398862+00
0078_automation_approval_execution.sql | 2026-08-05 13:31:48.369395+00
0077_mail_core.sql | 2026-08-05 13:31:48.222416+00
```

That resolves the PG-version concern the ticket raised directly, with evidence rather than
inference:

```
$ ssh gda-aicenter psql ... 'select version();'
PostgreSQL 15.18 (Debian 15.18-1.pgdg12+1) ...
```

The server runs **PostgreSQL 15.18**, not 17.10 like local dev. `0079`'s header claims the
column-list form of `ON DELETE SET NULL (column_list)` needs PG15+ — the feature landed in PG15,
so 15.18 qualifies, and the live `schema_migrations` row proves it compiled and ran without error.
No blocker here, but flag the version drift for future migrations: **do not assume PG17 semantics
locally transfer to this box.**

`npm run lint:migration-rls` (run locally, not on the server):

```
[lint-migration-rls] OK -- scanned 81 migrations (53 baselined, 28 enforced); no unguarded
FORCE-RLS backfills found.
```
Clean. 0078/0079 both correctly have zero backfill DML (confirmed by reading both files — 0078 is
ADD COLUMN with DEFAULT only, 0079 is CREATE TABLE only).

**Caveat, not a blocker:** the DB schema is now *ahead* of the running containers. Every container
on the box is still image tag `alpha-01.017.0040b`, which predates 0078/0079's application code.
This is fine at rest (old code simply doesn't touch the new tables/columns) but it means the
migrations were run by hand outside the normal `deploy.yml` migrate step (consistent with the
"Hand-built deploy runbook" — CI/deploy has had billing/test issues this week). **A real image
build + deploy still has to happen** before any of this is actually reachable through the app.

---

## 2. Cerbos — GO, with one verification gap

`deploy.yml`'s mechanism is correct and already covers new files:

- The sync step (`Sync compose files, scripts and mounted config`) does `rsync -az -e ssh
  platform-nest/cerbos/ vps:"${DEPLOY_DIR}/platform-nest/cerbos/"` — a full-directory rsync, so a
  brand-new file is copied like any other, not just diffed against what's already there.
- The **Reload Cerbos policies** step runs `docker compose ... restart cerbos`, placed
  **after `up -d`** (so a container that was just recreated isn't restarted twice) and **before
  `Wait for health`** (so a policy repo that fails to parse fails the deploy instead of silently
  denying in prod). The step's own comment (`CP-18`) documents exactly the hot-reload trap the
  ticket describes.

Live evidence that this already happened once, by hand, ahead of the real deploy:

```
$ ssh gda-aicenter find /home/Hansel/gaiada/platform-nest/cerbos -iname '*assistant*'
.../policies/resource_assistant_thread.yaml
.../policies/resource_assistant_memory.yaml

$ ssh gda-aicenter docker inspect gaiada-cerbos-1 --format '{{.State.StartedAt}}'
2026-08-05T13:32:29Z

$ ssh gda-aicenter ls -la --time-style=full-iso .../resource_assistant_{thread,memory}.yaml
... 2026-08-05 13:29:20 ...
```

The two policy files landed on disk **3 minutes before** the Cerbos container's last start —
i.e., the container that is running right now started fresh with the new files already in place,
not before them. `docker logs gaiada-cerbos-1` shows no compile/parse errors around that startup
window (only unrelated, older "Request too large" batch-limit errors from 08-03/08-04, nothing
about `assistant_thread`/`assistant_memory`).

**What I could NOT verify:** a live ALLOW/DENY probe against the `assistant_thread` kind. Cerbos
publishes no port on this box (`docker port gaiada-cerbos-1` → empty) and the container is
distroless (no `wget`/`curl`/shell inside to probe from), so I could not fire a real
`CheckResources` call the way the policy file's own header recommends ("run a smoke check that the
owner-ALLOW path actually returns ALLOW — a matrix where every case denies is the signature of
this trap"). **Mark the ALLOW-path smoke check UNVERIFIED** — treat it as an open item for whoever
does the real cutover, not a proven GO. Structural evidence (file present before restart, no
parse error) is strong but is not the same as a returned ALLOW decision.

---

## 3. Env passthrough — mixed: real gap found

Verified with `docker compose config` (the real tool, per the ticket's instruction), run locally
against a scratch copy of `infra/compose/.env.example` with empty required (`:?`) values filled
with a dummy placeholder so interpolation doesn't abort, and with `docker-compose.hostdata.yml`
layered on top to match the box's real `COMPOSE_FILES` repo variable:

```
COMPOSE_PROFILES=bot,auth,whisper,mail-dev,scan \
  docker compose -f docker-compose.vps.yml -f docker-compose.hostdata.yml \
  --env-file <scratch>.env config
```

**Reach confirmed (GO):**
- `APPROVAL_GRANT_SECRET` → resolves into **both** `platform` and `mcp-hub`'s `environment:`
  blocks (lines 373 and 293 of the resolved config respectively). D14's shared-HMAC requirement
  is satisfied structurally — same var, same compose-level default (`:-`), no place either side
  could silently diverge from `.env`.
- `ASSISTANT_STREAM_IDLE_TIMEOUT_MS` / `ASSISTANT_CONTEXT_CHAR_BUDGET` → both resolve into
  `platform`'s block (defaults `60000` / `12000` baked into the compose file itself, so even an
  `.env` with no entry gets a sane value — this is the fix comment CP-18-style noted in the file
  for the earlier `INTEGRATION_TOKEN_KEY` class of bug; it was done correctly here).
- `GATEWAY_URL` / `GATEWAY_TOKEN` → resolve everywhere they're needed (platform, mcp-hub,
  mcp-hub-central, ai-agents, bot, bot-media-worker) — pre-existing wiring, unaffected by this
  release.
- Both `APPROVAL_GRANT_SECRET` and the `ASSISTANT_*` pair **are documented** in
  `infra/compose/.env.example` (lines 374/394/399/404-405) and `platform-nest/.env.example`.

**Reach NOT confirmed — real gap (NO-GO):**
- `HERMES_URL` / `HERMES_MODEL` (ASST-15's new `hermes` gateway provider,
  `ai-gateway-go/internal/providers/hermes.go` + `internal/config/config.go` lines 126-127) do
  **not appear anywhere** in the resolved compose config — zero matches for either name across the
  whole `docker compose config` output for the `ai-gateway` service or any other. They are also
  **absent from every `.env.example` in the repo** (`infra/compose/.env.example`,
  `platform-nest/.env.example`; `ai-gateway-go/` has no `.env.example` of its own at all).
- On the live server: `grep HERMES_URL /home/Hansel/gaiada/infra/compose/.env` → **no match**.
  `LLM_CHAIN=gemini,claude` on the server — it doesn't include `hermes` either, so even if the URL
  were set, no chain currently routes to the new provider by name.
- This is fail-soft, not fail-hard: `config.go`'s `envOr("HERMES_URL", "")` means an unset var just
  makes `HermesProvider.Available()` return `false`, so nothing crashes. But it means **the ASST-15
  named `hermes` provider is completely dark on this box today** — any code path that expects
  `brain_provider='hermes'` to reach `ai-gateway-go`'s new provider (as opposed to the existing
  `GATEWAY_TOPOLOGY_MODE=site` + `GATEWAY_CENTRAL_URL` central-forward mechanism, which the box
  already uses and which is a **different, older** code path) will silently do nothing.

  Confirmed the box currently reaches Hermes only through the pre-existing mechanism:
  `GATEWAY_TOPOLOGY_MODE=site`, `GATEWAY_CENTRAL_URL=http://host.docker.internal:3009` — that's
  the hermes-gateway shim, reached via the "central-forward" provider, not the new named `hermes`
  provider. If ASST-16's per-thread brain picker lets a user select "hermes" as `brain_provider`
  expecting the *new* provider, that selection has no live route today.

**Action before shipping:** add `HERMES_URL`/`HERMES_MODEL` to both `.env.example` files, decide
whether the box should point them at `http://host.docker.internal:3009` (same target as
`GATEWAY_CENTRAL_URL` already uses) or keep the two mechanisms deliberately separate, and set
`LLM_CHAIN` to include `hermes` if the direct-provider path is meant to be live rather than the
central-forward path.

---

## 4. nginx — MANUAL, and it has NOT been applied yet

Confirmed nginx is bare-metal on this box (not containerized) and is **never synced by CI** —
`deploy.yml` has no step that touches `/etc/nginx` or even the repo's `infra/nginx/` directory.

The repo's `infra/nginx/erp.gaiada.online.conf` has the ASST-09 SSE block
(`location ~ ^/api/assistant/threads/[^/]+/stream$`, lines 200-212 locally) with `proxy_buffering
off` and the same reasoning as the client-portal's existing SSE block.

**Live check — the block is absent on the server, in both places that matter:**

```
$ ssh gda-aicenter grep -n assistant /home/Hansel/gaiada/infra/nginx/erp.gaiada.online.conf
(no output — 176 lines total, vs the repo's file which runs to line 212+)

$ ssh gda-aicenter grep -n assistant /etc/nginx/sites-available/erp.gaiada.online
(no output — this is the file nginx actually serves from, 194 lines)
```

Neither the repo-copy on the box nor the live, `nginx -s reload`-serving file has the assistant
block. **Without it, the first person to open the assistant will get a request that nginx buffers
until it closes — the exact "hung reply" failure the client portal already hit once**, per the
comment in the repo's own nginx conf file.

Also worth flagging as a side-finding (not blocking, but relevant to "which nginx file is truth"):
the **live** `/etc/nginx/sites-available/erp.gaiada.online` has already drifted from the repo copy
in an unrelated way — it has a narrower n8n webhook-path fix and the CP-5 client-portal SSE block
that the repo-synced copy on the box doesn't show in the same form. This confirms nginx on this box
is being hand-edited directly, out of band from any file in git. **Whoever applies the ASST-09
block must edit `/etc/nginx/sites-available/erp.gaiada.online` directly** (not just re-scp the
repo file, which would also revert the n8n fix already live there) and run `nginx -t && systemctl
reload nginx` (or the box's equivalent) afterward — this audit did not do either.

**Runbook step to add for the operator:** append the `location ~
^/api/assistant/threads/[^/]+/stream$` block (copy from repo `infra/nginx/erp.gaiada.online.conf`
lines ~200-212) into the live `/etc/nginx/sites-available/erp.gaiada.online`, test, reload. Do this
**before** or **as part of** the same deploy that ships assistant-enabled containers — an assistant
UI with no working stream endpoint is worse than a 404, because it will look like a hang rather
than a missing feature.

---

## 5. Version/tag parity — NO-GO, cut required (and possibly already starting)

At audit start:
- `VERSION` = `Alpha 01.017.0040b`
- Newest tag = `alpha-01.017.0040b` → **identical to VERSION**, but that tag points at commit
  `816e2c5`, which is **10 commits behind HEAD** (`8703179`):

```
$ git log alpha-01.017.0040b..HEAD --oneline
8703179 test(hr): move the two count assertions wave E's three new tables shifted
985e6ff feat(assistant): ASST-17 — tool broker under the CHATTING USER's principal (Phase-3 gate)
b25bd90 fix(gateway): format server_test.go per gofmt
cad79d5 Add .gitattributes to pin *.go files to LF line endings
b17b7dc feat(employee-portal): /me personal hub, employee loans, personal inbox (waves A/E/F)
0bf1481 feat(mail): magic links, inbound truncation metadata, and deep-link reauth
55c6dfe feat(assistant): ASST-16 — per-thread brain picker + Hermes session mapping
b6d6c3e feat(gateway): ASST-13 — egress-audit rows on /complete/stream
f38c22f feat(assistant): ASST-19 — memory panel with propose/confirm quarantine
6aef58f feat(assistant): ASST-15 — provider hint, hermes as a gateway provider, one wire grammar
```

`deploy.yml` enforces `TAG == lowercase-hyphenated(VERSION)` (the "Resolve and verify app version"
step) — so as things stood, tagging `alpha-01.017.0040b` again would just redeploy the *old*
commit; there is no valid tag yet that covers this session's work. **A VERSION bump + new tag is
required before any of this ships.**

**Mid-audit development — do not race this:** partway through this audit, `VERSION` changed
under me to `Alpha 01.018.0045a`, alongside uncommitted changes to `docs/modules/CHANGELOG.md` and
`docs/modules/MODULES.md`:

```
$ git status --short
 M VERSION
 M docs/modules/CHANGELOG.md
 M docs/modules/MODULES.md
```

This is a **different, concurrent session** doing exactly the version-cut work this item flags as
needed — not something this audit did. Per the shared-repo rules for this checkout, **do not
commit, tag, or push over it.** The operator should let that session finish and land its own
commit, then verify the resulting tag actually matches the new `VERSION` and covers HEAD, before
running `deploy.yml`.

**Footgun to check before touching the server, regardless of who cuts the tag:** the server's
`.env` `GAIADA_TAG`/`APP_VERSION` go stale because deploys pass the tag inline rather than reading
it back from the file:

```
$ ssh gda-aicenter grep -E '^GAIADA_TAG|^APP_VERSION' infra/compose/.env
APP_VERSION="Alpha 01.017.0040b"
GAIADA_TAG=alpha-01.017.0040b
$ ssh gda-aicenter cat /home/Hansel/gaiada/.deployed-tag
alpha-01.017.0040b
```

All three currently agree with each other and with the running containers
(`ghcr.io/hansel-gaiada/gaiada-platform-nest:alpha-01.017.0040b` is what's actually running) — so
there is **no drift right now**, but any later `docker compose up -d` run with a bare `.env`
(no inline `GAIADA_TAG=` override) will silently re-pin every service to `0040b`, rolling back the
DB-ahead-of-code state described in item 1. **Before running anything by hand on this box, `grep
GAIADA_TAG .env` and compare against `.deployed-tag` and `docker ps --format '{{.Image}}'` first.**

**CI status at time of audit** (`gh run list`): the current HEAD's CI run
(`31025097387`, triggered by `8703179`) was **still in progress** — 8 of 9 jobs green
(`sync-engine-go`, `platform-ui`, `test (ai-agents)`, `gateway-go`, `test (wa-chat-bot)`,
`observability-lint`, `test (report-renderer)`, `test (mcp-hub)`), with `platform-nest` still
running. The **previous** commit's CI (`985e6ff`, run `31023169236`) had **failed** on exactly
the count-mismatch the current HEAD commit's message says it fixes
(`hr.test.ts` expected 3 tools, got 5; `module-hr-rls.test.ts` expected 6 rows, got 9) — consistent
with `8703179` being the fix, not yet confirmed green at audit time. **Do not cut a tag until that
`platform-nest` job on HEAD reports success.**

---

## 6. hermes-gateway — NO-GO, live binary is 5 days stale and missing the new endpoint

The systemd unit itself needs no changes — `infra/hermes/hermes-gateway.service` on disk matches
the deployed unit byte-for-byte (`/etc/systemd/system/hermes-gateway.service`), and the service is
`active (running)` since 2026-07-31.

The problem is the **application code it runs**, which is not managed by `deploy.yml` at all
(hermes-gateway is explicitly the one non-dockerized service, by design):

```
$ ssh gda-aicenter ls -la /opt/hermes-gateway/
server.mjs   9386 bytes, dated Jul 31 03:28

$ ssh gda-aicenter grep -n 'complete/stream' /opt/hermes-gateway/server.mjs
(no output)
```

The live `server.mjs` has **no `/complete/stream` route at all** — ASST-14/15's new streaming
endpoint and the `meta`-timing change do not exist on this box's copy. There is no `git pull` /
build step for this service anywhere in the deploy pipeline; it has to be updated by hand:
`scp`/`rsync` the new `hermes-gateway/` source to `/opt/hermes-gateway/` on the box, then
`systemctl restart hermes-gateway`. This audit did not do either.

**Compounding with item 3:** even after the binary is updated, the new `/complete/stream` endpoint
is only reachable through ai-gateway-go's *new* `hermes` provider if `HERMES_URL`/`HERMES_MODEL`
are set — which they currently are not (item 3). The box's *existing* Hermes route
(`GATEWAY_TOPOLOGY_MODE=site` + `GATEWAY_CENTRAL_URL=http://host.docker.internal:3009`, hitting
hermes-gateway's old, byte-for-byte-unchanged `/complete`) will keep working exactly as before —
ASST-14/15 only adds a second, currently-unwired path.

**`GATEWAY_URL` for the new `hermes` provider, from inside the compose network:** the same
value already in use for `GATEWAY_CENTRAL_URL` — `http://host.docker.internal:3009` — because
`docker-compose.hostdata.yml`'s `x-hostgw` anchor adds `extra_hosts:
host.docker.internal:host-gateway` to every relevant service, and hermes-gateway itself binds
`0.0.0.0:3009` on the host specifically so the docker0 bridge (172.17.0.1, which
`host.docker.internal` resolves to) can reach it. So `HERMES_URL=http://host.docker.internal:3009`
is the right value to set on this box, once the binary is updated.

---

## 7. `--remove-orphans` profiles — GO

Nothing in this release adds a new container. Assistant lives inside the existing `platform`
service; the new gateway provider lives inside the existing `ai-gateway` service. Mail (from the
concurrent session) already required `mail-dev` (Mailpit) and `scan` (ClamAV), and both are already
in the repo variable:

```
$ gh variable list
COMPOSE_PROFILES   bot,auth,whisper,mail-dev,scan
COMPOSE_FILES      -f docker-compose.vps.yml -f docker-compose.hostdata.yml
```

Confirmed live — both containers are up and healthy:
```
gaiada-mailpit-1   Up 32 hours (healthy)   axllent/mailpit:v1.30.6
gaiada-clamav-1    Up 32 hours (healthy)   clamav/clamav:1.5.3
```

The only profile this release touches that ISN'T in that list is `multisite`
(`sync-central`/`mcp-hub-central`) — but multisite is deliberately idle single-region
infrastructure unrelated to assistant/D14/mail, so its absence from `COMPOSE_PROFILES` is correct,
not a gap. **No change needed to the repo variable for this release.**

---

## 8. Assistant module enablement — NO-GO, seed has not been re-run

The seed correctly does the enablement:

```
platform-nest/src/seed/agency.ts:82
const tenantId = await ensureCompany(AGENCY_NAME, ["agency","hr","reports","assistant"], ...)
```

But the live DB, read directly as the Postgres superuser (bypassing RLS, so this is a true read —
not the "0 rows because GUC unset" trap from the memory notes):

```
$ ssh gda-aicenter sudo -u postgres psql -d gaiada_platform \
  -c "select name, enabled_modules from companies order by created_at;"

D & A Syrowatka    | {}
Gaia Digital Agency | {agency,hr,reports,pm,it,billing,knowledge,clients,automation-console,search}
Sanur Resort        | {}
```

**`Gaia Digital Agency` — the dev tenant — has no `assistant` (and no `mail`) in
`enabled_modules`.** The idempotent seed (`npm run seed:agency`) has not been re-run since the
assistant/mail migrations landed, so today, with 0078/0079 already applied, any assistant request
against this tenant would 404 at the module gate even before reaching Cerbos.

**Action:** re-run `npm run seed:agency` against the dev tenant after the next real deploy (the
migration is already applied, so the seed's `ensureCompany` upsert-by-name path should just widen
`enabled_modules` on the existing row rather than create a duplicate — verify that assumption by
reading `ensureCompany`'s implementation before running it for real, since this audit did not
execute it).

---

## Stop-and-fix-first (in the order they'd actually bite)

1. **Do not tag/deploy while `platform-nest` CI on HEAD is unresolved.** At audit time it was
   still running after the previous commit failed on a test-count mismatch that HEAD's own commit
   message says it fixes. Confirm green before cutting anything.
2. **Do not race the concurrent session that is mid-way through a VERSION/CHANGELOG/MODULES.md
   bump** (`VERSION` changed under this audit from `Alpha 01.017.0040b` to `Alpha 01.018.0045a`,
   uncommitted). Let it land, then tag from the resulting commit.
3. **Apply the nginx ASST-09 SSE block by hand** to
   `/etc/nginx/sites-available/erp.gaiada.online` on the box (not by re-copying the repo file,
   which would revert an already-live, unrelated n8n path fix) — `nginx -t`, then reload — before
   or alongside the deploy that ships assistant. Otherwise the assistant will visibly hang, not
   404, the first time anyone uses it.
4. **Wire `HERMES_URL`/`HERMES_MODEL`** into `docker-compose.vps.yml`'s `ai-gateway` service and
   both `.env.example` files, and decide whether `LLM_CHAIN` should include `hermes` — otherwise
   ASST-15's named provider is permanently dark on this box even after everything else ships.
5. **Update `/opt/hermes-gateway/server.mjs`** on the box (hand copy, since it's non-dockerized) to
   the version with `/complete/stream`, then `systemctl restart hermes-gateway` — the box is
   currently running 5-day-stale code that predates ASST-14/15 entirely.
6. **Re-run `npm run seed:agency`** against the dev tenant after deploy, or the assistant (and
   mail) will 404 for everyone at the module gate regardless of everything else being correct.
7. Before touching the box at all: `grep GAIADA_TAG /home/Hansel/gaiada/infra/compose/.env`,
   compare to `.deployed-tag` and `docker ps --format '{{.Image}}'` — confirm they agree before any
   `up -d`, to avoid the recorded silent-rollback footgun.

## Verified against the live server vs. repo-only

**Live-server-verified (via read-only SSH, 2026-08-06):** Postgres version (15.18); migrations
0078/0079 applied; `schema_migrations` head; Cerbos policy files present + container start-order;
Cerbos startup logs (no compile errors); `docker ps` full container list; `.env` values for
`GAIADA_TAG`/`APP_VERSION`/`LLM_CHAIN`/`GATEWAY_TOPOLOGY_MODE`/`GATEWAY_CENTRAL_URL`/`MAIL_ENABLED`/
`MAIL_LINK_BASE_URL`; `.deployed-tag`; live nginx repo-copy vs. `/etc/nginx/sites-available` (both
missing the ASST-09 block; live file already diverged from repo in an unrelated way);
hermes-gateway systemd unit (matches repo) and `server.mjs` contents (missing `/complete/stream`);
`companies.enabled_modules` for all three seeded tenants; `COMPOSE_PROFILES`/`COMPOSE_FILES` repo
variables via `gh`; CI run status via `gh run list`/`gh run view`.

**Repo-only (not server-executed):** `npm run lint:migration-rls` (ran locally); `docker compose
config` structural env-passthrough check (ran locally against a scratch `.env`, mirroring the
server's real `COMPOSE_FILES`/`COMPOSE_PROFILES`, but not against the server's actual secret
values); reading of migration/Cerbos/deploy.yml/nginx source files.

**Explicitly UNVERIFIED:** a live Cerbos `CheckResources` ALLOW probe against `assistant_thread`/
`assistant_memory` (no published port, no shell in the distroless container — could not execute);
whether `ensureCompany`'s upsert path in `seed/agency.ts` safely widens `enabled_modules` on an
existing row without side effects (read the seed's own code, did not execute it); whether the
in-flight concurrent VERSION bump seen mid-audit resolves cleanly.
