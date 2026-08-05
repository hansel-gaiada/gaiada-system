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
| 3 | Env passthrough | **GO (repo-side fixed 2026-08-06)** — `HERMES_URL`/`HERMES_MODEL` now wired into `ai-gateway`'s environment block and both new `.env.example` rows; operator still must set them + decide `LLM_CHAIN` on the box (see §3-addendum below) | Local `docker compose config` (real tool, both with and without `docker-compose.hostdata.yml`) |
| 4 | nginx SSE block | **MANUAL / NOT YET APPLIED** | Live server |
| 5 | Version/tag parity | **NO-GO — cut required, and one may already be in flight** | Repo + `gh` |
| 6 | hermes-gateway new endpoint | **NO-GO** (stale binary) | Live server |
| 7 | `--remove-orphans` profiles | **GO** | `gh variable list` + compose file |
| 8 | Assistant module enablement | **GO-with-caveat (repo-side verified 2026-08-06)** — seed already lists `"assistant"` (survived the `agency.ts`/`departments.ts`/`roster.ts` refactor); re-running the FULL seed is safe against duplicate rows but **UNSAFE against `enabled_modules`** — see §8-addendum. Use the scoped fix, not a blind seed re-run. | Repo read (`agency.ts`, `admin-identity.controller.ts`) — not executed |

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

### §3-addendum (2026-08-06, DevOps, repo-side only — no deploy/restart performed)

**Fixed:** `HERMES_URL`/`HERMES_MODEL` now sit in `ai-gateway`'s `environment:` block in
`infra/compose/docker-compose.vps.yml`, right next to `GATEWAY_TOPOLOGY_MODE`/`GATEWAY_CENTRAL_URL`
(with a comment explaining the two are separate code paths that may point at the same shim), and
are documented with a full rationale block in `infra/compose/.env.example`. Verified with the real
tool, against a scratch `.env` (all `:?}`-required vars filled with a placeholder, `HERMES_URL`/
`HERMES_MODEL` filled with test values so a real render could be inspected):

```
$ COMPOSE_PROFILES=data,auth,multisite,whisper \
  docker compose --env-file <scratch>.env -f docker-compose.vps.yml config
...
  ai-gateway:
    environment:
      ...
      GATEWAY_CENTRAL_URL: ""
      GATEWAY_TOKEN: dummy-placeholder-value
      GATEWAY_TOPOLOGY_MODE: central
      GEMINI_API_KEY: ""
      HERMES_MODEL: hermes-test-model
      HERMES_URL: http://host.docker.internal:3009
      LLM_CHAIN: openai,ollama,gemini,claude
      MEDIA_CHAIN: openai,whisper,gemini
      ...
```

Both vars resolve into the `ai-gateway` service and nowhere else — confirmed the correct service
(the one running `ai-gateway-go`, not `platform`, not `mcp-hub`).

**`host.docker.internal` — verified, not assumed.** Re-ran the same command WITH
`docker-compose.hostdata.yml` layered on top (the file that matches the box's real
`COMPOSE_FILES` repo variable, `-f docker-compose.vps.yml -f docker-compose.hostdata.yml`):

```
$ COMPOSE_PROFILES=bot,auth,whisper,mail-dev,scan \
  docker compose --env-file <scratch>.env \
  -f docker-compose.vps.yml -f docker-compose.hostdata.yml config
...
  ai-gateway:
    environment:
      ...
      HERMES_MODEL: hermes-test-model
      HERMES_URL: http://host.docker.internal:3009
      ...
    extra_hosts:
      - host.docker.internal=host-gateway
```

Conclusion: on THIS box's real compose invocation, `host.docker.internal` DOES resolve for
`ai-gateway`, because `docker-compose.hostdata.yml`'s `x-hostgw` anchor (`extra_hosts:
host.docker.internal:host-gateway`) is already applied to the `ai-gateway` service (it was added
for `GATEWAY_CENTRAL_URL`/Ollama-embedding reasons — see the file's own comment, "Needs the host
for BOTH the Ollama embedding endpoint and the Hermes shim"). No new `extra_hosts` entry was
needed or added — the existing one already covers the new var. **This is compose-topology-specific,
not universal**: rendering `docker-compose.vps.yml` ALONE (no hostdata overlay — e.g. a from-scratch
deploy with a containerized Postgres/Redis/Ollama) produces no `extra_hosts` line at all, so on
plain Linux Docker Engine (not Docker Desktop, which auto-adds the name) `host.docker.internal`
would silently fail to resolve in that topology. Flagging this so nobody copies
`HERMES_URL=http://host.docker.internal:3009` onto a differently-shaped deployment and gets a
connection-refused with no clue why.

**`LLM_CHAIN` recommendation.** The repo's compose default is
`LLM_CHAIN=openai,ollama,gemini,claude` (`docker-compose.vps.yml`); the live server's `.env` has
`LLM_CHAIN=gemini,claude` (per §3 above) — neither includes `hermes`. Read
`ai-gateway-go/internal/chain/chain.go` (`RunWithHint`) and its test
`TestCompleteStreamAbsentProviderHintBehavesLikeBeforeThisTicket` /
`chain_test.go`'s unmatched-hint case: **a provider hint only reorders a provider that is ALREADY a
member of the configured chain.** If `hermes` is not in `LLM_CHAIN`, ASST-16's per-thread
brain-picker sending `provider: "hermes"` will **silently fall through to the normal first-in-order
provider** — no error, no visible failure, just the wrong brain answering. This is a second,
independent way the named `hermes` provider stays dark even after `HERMES_URL`/`HERMES_MODEL` are
set correctly.

**Recommendation:** append `hermes` to the END of `LLM_CHAIN`, e.g.
`LLM_CHAIN=openai,ollama,gemini,claude,hermes` (or `gemini,claude,hermes` to match what's live).
Appending LAST is the low-risk position: an *unhinted* call only reaches `hermes` if every earlier
provider in the chain is unavailable, so on today's box (where `HERMES_URL` is currently unset)
this is a no-op, and even once `HERMES_URL` is set it only changes behaviour for the case where the
whole rest of the chain is down — a new failover path, not a reordering of the common case.
Putting it first or mid-chain would not be: it would change which provider answers the ORDINARY
unhinted request for every existing caller of this gateway (**wa-chat-bot, knowledge, search all
share this one `ai-gateway` service and its one `LLM_CHAIN`**) — that is a behaviour change for
production traffic that has nothing to do with the assistant feature, and I have deliberately NOT
made it myself. **This is an operator decision, made via the server's `.env`, not a change to the
compose file's shared default** — I left `docker-compose.vps.yml`'s `LLM_CHAIN:
${LLM_CHAIN:-openai,ollama,gemini,claude}` untouched and only added a comment there documenting the
hint-reorder trap, precisely so nobody re-reads this file in six months and assumes "hermes" already
works because the vars are present.

`platform-nest/.env.example` was **deliberately NOT** given a `HERMES_URL`/`HERMES_MODEL` entry:
that file documents platform-nest's own env surface (e.g. `GATEWAY_URL`/`GATEWAY_TOKEN`, which is
platform-nest's OUTBOUND client config for calling `ai-gateway`), not `ai-gateway-go`'s internal
provider config. `HERMES_URL`/`HERMES_MODEL` are consumed only inside the `ai-gateway` container,
so `infra/compose/.env.example` is the one correct place for them.

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

### §8-addendum (2026-08-06, DevOps, repo read-only — no seed executed, no server touched)

**The seed line survived the refactor.** `platform-nest/src/seed/agency.ts:82`:

```ts
const tenantId = await ensureCompany(AGENCY_NAME, ["agency", "hr", "reports", "assistant"], "agency", holdingId);
```

`"assistant"` is present. (`"mail"` is not — out of scope for this ticket; that module belongs to
the concurrent mail session's own work, not touched here.)

**Idempotency — answered definitively, and it is a two-part answer, not a plain yes:**

1. **No duplicate rows.** `ensureCompany` (`agency.ts:36-49`) looks up the company by `name` first
   and does an `UPDATE` on a hit, `INSERT` only on a miss. Re-running the seed will never create a
   second `"Gaia Digital Agency"` row. In that narrow sense, yes, it is safe to re-run.
2. **`enabled_modules` is NOT merged — it is unconditionally overwritten:**
   ```ts
   await withGlobal((c) => c.query(
     `UPDATE companies SET type=$2, parent_company_id=$3, enabled_modules=$4 WHERE id=$1`,
     [id, type, parentId, modules]));
   ```
   `$4` is the seed's hardcoded 4-element array (`["agency","hr","reports","assistant"]`) — this
   `UPDATE` **replaces the whole array**, it does not append.

**Why this matters, concretely, on THIS tenant:** the live `enabled_modules` for "Gaia Digital
Agency" (per §8's own read) is `{agency,hr,reports,pm,it,billing,knowledge,clients,
automation-console,search}` — **ten** modules, only three of which (`agency`,`hr`,`reports`) match
the seed's list. The other seven (`pm`,`it`,`billing`,`knowledge`,`clients`,`automation-console`,
`search`) were almost certainly added one-at-a-time via the admin module-toggle endpoint
(`PATCH /api/admin/:tenantId/company/modules` → `admin-identity.controller.ts:391-414`, which
correctly does `array_append(array_remove(enabled_modules,$2),$2)` — an append/dedupe, not an
overwrite) rather than by re-running the seed. **Blindly running `npm run seed:agency` against this
tenant today would silently DROP all seven of those modules**, replacing the live 10-item array with
the seed's 4-item one — a real regression, not a duplication, and not something `npm run
seed:agency`'s own output would flag as unusual (the script has no diff/warn step; the row is
simply UPDATEd and the run reports success).

**Verdict: `npm run seed:agency` is idempotent (no dupes) but is NOT safe to re-run as-is against
a tenant whose module set has since been widened by any other path (admin console, manual SQL).**
This falls under this ticket's own state-destroying-operation rule (a company row's live
`enabled_modules` is stateful, and this would be a silent narrowing of it) — I am not recommending
the blind re-run as the runbook step, and I did not execute it myself.

**Recommended operational step instead — a scoped, additive fix that mirrors the admin toggle's own
SQL shape** (safe: touches only the `assistant` key, cannot regress anything else):

```sql
UPDATE companies
SET enabled_modules = array_append(array_remove(enabled_modules, 'assistant'), 'assistant'),
    updated_at = now()
WHERE name = 'Gaia Digital Agency' AND deleted_at IS NULL;
```

or, equivalently and without touching the DB directly, the already-built and already-authorized
admin API:

```
PATCH /api/admin/<tenantId>/company/modules
Body: { "module": "assistant", "enabled": true }
```

Either is additive-only and cannot drop `pm`/`it`/`billing`/`knowledge`/`clients`/
`automation-console`/`search`. I did **not** modify `ensureCompany` itself to merge instead of
overwrite — that function is shared by every `ensureCompany(...)` call in this seed (including
fresh-install holding/resort rows) and changing its semantics is a broader design decision than
this ticket's scope; flagging it here as a real latent bug for whoever owns `seed/agency.ts` next,
not fixing it silently.

---

## Stop-and-fix-first (in the order they'd actually bite)

**Repo-side items 3 and 8 below are now closed as of 2026-08-06 (DevOps pass) — see the §3-addendum
and §8-addendum sections above for evidence.** What remains is entirely manual/operator work on the
box; the ordered list below is the actual bite order for whoever runs it, folding in both addenda.

1. **Do not tag/deploy while `platform-nest` CI on HEAD is unresolved.** At audit time it was
   still running after the previous commit failed on a test-count mismatch that HEAD's own commit
   message says it fixes. Confirm green before cutting anything.
2. **Do not race the concurrent session that is mid-way through a VERSION/CHANGELOG/MODULES.md
   bump** (`VERSION` changed under this audit from `Alpha 01.017.0040b` to `Alpha 01.018.0045a`,
   uncommitted). Let it land, then tag from the resulting commit.
3. Before touching the box at all: `grep GAIADA_TAG /home/Hansel/gaiada/infra/compose/.env`,
   compare to `.deployed-tag` and `docker ps --format '{{.Image}}'` — confirm they agree before any
   `up -d`, to avoid the recorded silent-rollback footgun.
4. **Set `HERMES_URL=http://host.docker.internal:3009` and (optionally) `HERMES_MODEL=`** in the
   box's `infra/compose/.env` — the repo-side wiring (compose passthrough + `.env.example`
   documentation) is done; only the operator's `.env` value is left. Confirm
   `docker-compose.hostdata.yml` is in the box's `COMPOSE_FILES` (it is, per §7) so the existing
   `extra_hosts` entry on `ai-gateway` covers the name.
5. **Decide on `LLM_CHAIN`.** If ASST-16's per-thread "hermes" brain-picker option is meant to work
   on this box, append `hermes` to the box's `LLM_CHAIN` (e.g. `gemini,claude,hermes`, matching
   what's currently live) — appending LAST, not first, per the §3-addendum's behaviour-change
   warning. If not, leave `LLM_CHAIN` alone and accept that "hermes" stays a picker option that
   silently no-ops (falls through to the default provider).
6. **Apply the nginx ASST-09 SSE block by hand** to
   `/etc/nginx/sites-available/erp.gaiada.online` on the box (not by re-copying the repo file,
   which would revert an already-live, unrelated n8n path fix) — `nginx -t`, then reload — before
   or alongside the deploy that ships assistant. Otherwise the assistant will visibly hang, not
   404, the first time anyone uses it. **NOT done by this DevOps pass — explicitly left to the
   runbook, per instruction.**
7. **Update `/opt/hermes-gateway/server.mjs`** on the box (hand copy, since it's non-dockerized) to
   the version with `/complete/stream`, then `systemctl restart hermes-gateway` — the box is
   currently running 5-day-stale code that predates ASST-14/15 entirely. **NOT done by this DevOps
   pass — explicitly left to the runbook, per instruction.**
8. **Do NOT blindly re-run `npm run seed:agency`** against the dev tenant — per the §8-addendum, its
   `ensureCompany` UPDATE overwrites `enabled_modules` wholesale and would drop the 7 modules
   (`pm`,`it`,`billing`,`knowledge`,`clients`,`automation-console`,`search`) already live on this
   tenant via the admin console. Instead run the scoped, additive fix (SQL or the admin API — see
   §8-addendum) to add `assistant` without touching the rest of the array.

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
whether the in-flight concurrent VERSION bump seen mid-audit resolves cleanly.

---

## DevOps follow-up pass (2026-08-06) — repo-only, no deploy/restart/ssh-mutation

Closed the two REPO-side blockers from items 3 and 8 (see §3-addendum and §8-addendum above for
full evidence). Confirmed `git status` clean on `platform-nest/src/seed/**` before touching it (no
concurrent-session conflict).

**Repo files changed:**
- `infra/compose/docker-compose.vps.yml` — `HERMES_URL`/`HERMES_MODEL` added to `ai-gateway`'s
  `environment:` block; explanatory comment added to the `LLM_CHAIN` line about the
  hint-only-reorders-existing-members trap. No other service touched. `LLM_CHAIN`'s default value
  itself left unchanged (operator decision, not a repo default change).
- `infra/compose/.env.example` — `HERMES_URL=`/`HERMES_MODEL=` rows added with rationale
  (host-routability, hint-chain-membership requirement). `platform-nest/.env.example` deliberately
  NOT changed — that file documents platform-nest's own outbound `GATEWAY_URL`/`GATEWAY_TOKEN`, not
  `ai-gateway-go`'s internal provider config.
- `platform-nest/src/seed/agency.ts` — **read only, not modified.** `"assistant"` already present
  at line 82; the `ensureCompany` overwrite behaviour is a pre-existing latent bug documented in
  §8-addendum, not fixed here (broader design decision, out of this ticket's scope).
- This doc (`docs/superpowers/plans/2026-08-06-dev-server-readiness.md`) — go/no-go table rows 3
  and 8 updated, §3-addendum + §8-addendum added, "Stop-and-fix-first" renumbered into bite order
  with the two closed items folded in, this section added.

**Verification performed (repo-only, real tool, no server contact):**
```
$ COMPOSE_PROFILES=data,auth,multisite,whisper docker compose --env-file <scratch>.env \
    -f infra/compose/docker-compose.vps.yml config
    → ai-gateway.environment.HERMES_URL / HERMES_MODEL present, correctly resolved.

$ COMPOSE_PROFILES=bot,auth,whisper,mail-dev,scan docker compose --env-file <scratch>.env \
    -f infra/compose/docker-compose.vps.yml -f infra/compose/docker-compose.hostdata.yml config
    → same, PLUS ai-gateway.extra_hosts: [host.docker.internal=host-gateway] confirming
      host.docker.internal resolves in the box's real compose topology.
```

**Not done (explicitly out of scope for this pass, left to the runbook):** nginx SSE block, the
hermes-gateway binary update, actually setting `HERMES_URL`/`LLM_CHAIN` in the box's `.env`, and
actually running the scoped `enabled_modules` fix. No deploy, no SSH, no restart.
