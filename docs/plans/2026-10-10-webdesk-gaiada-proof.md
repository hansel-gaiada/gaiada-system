# WebDesk × gaiada.com — the P2 proof (working tracker)

**Started:** 2026-10-10 · **Rulings:** `webdesk-design-v2.md` v2.3 §14, WSK-D37…D43 ·
**Handoff it answers:** [`2026-10-10-gaiada-com-website-cms-analytics.md`](./2026-10-10-gaiada-com-website-cms-analytics.md) ·
**Older tracker (history, stale since 2026-08-27):** [`2026-08-26-webdesk-PROGRESS.md`](./2026-08-26-webdesk-PROGRESS.md)

**Status lives in [`TASKS.md`](../../TASKS.md) at the repo root** — progress bars computed from checkboxes, ticked in the same change that moves the work. This file holds the ticket descriptions, ground truth, open questions and the log. Status words are the estate's:
PLANNED · IN PROGRESS · PROTOTYPED · DEV-VERIFIED. DEV-VERIFIED means driven on a **Linux server**
and the result observed (owner rule 2026-08-26); a green suite on the Windows laptop is not evidence.

## The proof, in one sentence

**A staff member edits gaiada.com content in the ERP, publishes, and `24-pyevq.gaiada.com` —
rebuilt from WebDesk's `/v1` — shows the change; and the CMS-built site equals the git-built site
page for page** (WSK-D41).

## Ground truth at start (probed 2026-10-10, not read from a tracker)

| Fact | Evidence |
|---|---|
| WebDesk runs on `gda-aicenter` as its own `webdesk` compose project | `api` = signed `gaiada-webdesk-api:v1.0.0-alpha.325`; proxy on `127.0.0.1:8380` |
| **Live `/v1` is down, and has been since 2026-09-09** | `webdesk-payload-gateway-1` exited 137 (SIGKILL, not OOM) and was never restarted; Caddy still routes `/v1/*` to it |
| The live WebDesk DB holds **verification residue only** | 8/8 migrations; 9 `wsk05-*` tenants; MinIO has 4 buckets with **0 objects** |
| `/v1` has **no public hostname** | vhost `api.gaiada.online.conf` staged in `sites-available`, not enabled; **no DNS record** |
| A stale second copy runs on `sumopod` (6 weeks old) | `webdesk-*` containers incl. a live `payload-gateway`; pre-dates WSK-D32's move to aicenter |
| **No authoring path exists** | the only content write is WSK-05's demo `POST /v1/t/:slug/content` (API key, drafts only); **no publish command anywhere** |
| Flat collection `fields` have **no value column** | `content_items` = `blocks` + `seo`; the `redirect` collection parks its values in `seo` |
| The E0–E3 track (independence §2) is **unstarted** | no WebDesk commit on main since 2026-09-15 |
| gaiada-web-revamp builds locally and ships `dist/` to `delphi` | `scripts/deploy-staging.sh`; content = `src/config/**` (~4,500 lines TS) + `content/{en,id}/**.md` + `data/*.json` |

## M1 — WebDesk serves gaiada.com (the delivery half)

| # | Ticket | Tier | Deps |
|---|---|---|---|
| **WSK-52** | **RustFS replaces MinIO** (WSK-D42) — compose (dev, aicenter, CI), presigners with `requestChecksumCalculation: "WHEN_REQUIRED"`, bucket bootstrap without `mc` (versioning + GOVERNANCE object lock re-proven through the S3 API), a least-privilege service key via the RustFS admin API (closes WSK-07's root-fallback gap), backup script off `mc mirror`, healthcheck on `/health` | medior (Sonnet) | — |
| **WSK-48a** | **Rehome `/v1` into `webdesk/api`** (WSK-D37, OQ-3.5) — port the read router, content-read, redirects, sitemap and key resolution into an api `delivery` module on the api's own tenant pool; retire WSK-05's demo `content` controller (it collides with the router on `/v1/t/:slug/content`); Caddy `/v1/*` → `api`. **Gate: `envelope-contract.test.mjs` passes byte-identically against the api.** Payload stays running until WSK-48b | senior-be (Sonnet) | — |
| **WSK-53** | **gaiada.com content inventory** — [`webdesk/sites/gaiada-com/INVENTORY.md`](../../webdesk/sites/gaiada-com/INVENTORY.md) + `inventory.json` (site commit `075ff5f`). 33 config modules / 4,490 lines · 315 long-form pages (235 EN + 80 ID; 79 built) · 9 globals · 16 vocabulary gaps (G1–G16) · stable ids for every page, home section, CTA and form · 12 owner questions. **Decisive finding:** the site chooses section components at build time from `## ` headings (`lib/sections/split.ts` + `rules.ts`), so the CMS must round-trip the site's source shapes rather than model ~101 section bindings | medior (Sonnet) | — |
| **WSK-62** | **Design pass for the write plane** (architect) — the `fields` contract decision under §05; WSK-41 authoring + WSK-51 read commands with impact classes; WSK-40's editorial assertion; WSK-47's Cerbos kinds; the M1 loader's machine principal; publish → rebuild options. Output: exact signatures, owned paths, tests | architect (Opus) | — |
| WSK-41 | Content authoring commands — create · update · publish · unpublish · schedule · delete; writes `content_versions` | senior-be | WSK-62 |
| WSK-51 | Control-plane read commands — collections, items, versions, media (ends `stale:true` by construction) | senior-be | WSK-62 |
| WSK-54 | **Importer** — site repo → a deterministic bundle (collections + items, EN + ID, stable ids) → loaded through WSK-41 | medior | WSK-53, 41 |
| WSK-55 | **Site reads `/v1`** (gaiada-web-revamp branch) — `CONTENT_SOURCE=webdesk\|git`, generated SDK, build-time loader; **parity gate**: both builds, `dist/` diffed page for page | senior-fe | WSK-48a, 54 |
| WSK-56 | **Deploy to `gda-aicenter`** (WSK-D43) — volume backup → wipe `wsk05-*` → RustFS → new api → Caddy `/v1` → api → stop `payload-gateway`; tenant `gaiada` + site + envs + keys (WSK-57); vhost + certbot once the A record resolves | orchestrator | WSK-52, 48a |
| WSK-57 | Provision tenant `gaiada` / site `gaiada-com` / staging + production / build + preview keys | orchestrator | WSK-56 |
| WSK-58 | **Linux gate** for every surviving WebDesk suite on `sumopod` (WSK-D34), minus what D37 deletes | qa | M1 code |

## M2 — editing from the ERP (the authoring half)

| # | Ticket | Tier | Deps |
|---|---|---|---|
| WSK-40 | Editorial identity seam — EdDSA assertion minted in platform-nest, verified by public key in WebDesk (WSK-D39) | senior-integrator (Opus) | WSK-62 |
| WSK-47 | Cerbos kinds `webdesk_content_item` · `webdesk_collection` · `webdesk_media_asset` — **six artifacts each**, then a Cerbos restart proven by a probe | senior-be (Opus) | WSK-62 |
| WSK-59 | platform-nest `webdev` content BFF + MCP tools (agentic-native bar: every editor action is an endpoint and a tool with an impact class) | senior-be | WSK-40, 41, 47 |
| WSK-44 | platform-ui **"Website" workspace** — gaiada.com sections first: list → edit → publish → version history; "editorial unavailable" state, never a confident empty editor | senior-fe + senior-uiux | WSK-59 |
| WSK-60 | **Publish → rebuild → staging deploy** — tenant webhook `content.published` drives the site build; where the build runs is open (below) | senior-integrator | WSK-55 |

## M3 — after the proof

WSK-48b delete Payload + rename `webdesk/payload/` → `webdesk/delivery/` (WSK-D38) · WSK-46 preview
tokens · WSK-61 scheduled-publish worker · WSK-45 rich-text editor (OQ-3.1) · WSK-43 media library ·
WSK-49 client editors · the §03 containment probe set on `gda-aicenter` · retire the stale `sumopod`
copy.

## Open, and whose

| # | Question | Owner | Default |
|---|---|---|---|
| P-1 | The GoDaddy A record `api.gaiada.online → 35.240.135.48` | **owner** (agreed 2026-10-10) | SSH tunnel until it resolves |
| P-2 | Where the publish-triggered site build runs (WSK-60): GitHub Actions on the site repo, or a build container on a box | owner, at WSK-60 | decided with numbers at WSK-60 (§10 build-cost lever) |
| P-3 | The 2026-09-21 doctrine edits to root `CLAUDE.md` + `docs/assessment/*` + `infra/runbooks/self-hosted-ci-runner.md` are still uncommitted in the shared checkout | whoever owns that session | flagged, not carried |

## Session log

**2026-10-10.** Rulings D37–D43 landed in v2.3 §14 (D37–D40 had sat 19 days in an untracked
file; D41–D43 are today's owner rulings). The replatform plan's colliding "D37" was renumbered to
"next free". Live probe found `/v1` down for a month and the authoring path absent rather than
merely unfinished — publish does not exist. Wave 1 dispatched: WSK-52, WSK-48a, WSK-53, WSK-62.

**2026-10-10, deploy (WSK-56).** WSK-52 + WSK-48a merged; the combined Linux gate was green
(418/0/1, differential 696/710, contract 60/60). They were deployed to gda-aicenter inside the
`webdesk` project. The deploy surfaced **two defects that had made the live api useless since
the 0.2.0 deploy**, plus a deploy-tooling trap:
1. **Wrong env name.** Compose passed the api's connection string as `DATABASE_URL`, but
   `src/config.ts` reads `APP_DATABASE_URL`. The api connected to an empty string, so `pg` dialled
   localhost. Every DB-backed route had failed on the box since 0.2.0. No suite could see it,
   because tests set the variable themselves. Fixed in `42a855c4`: compose passes the right name
   and refuses to resolve without it, and the api refuses an empty URL in production.
2. **Wrong owner.** The live database had every table owned by `postgres` (migrations applied
   as the superuser), so `webdesk_app` held **0 grants** and the role split existed only in the
   repo. The DB held nothing of value, so it was rebuilt the intended way: fresh volume,
   `init-roles.sh`, 8 migrations as `webdesk_migrator` (idempotent re-run 0). Result:
   `webdesk_migrator` owns the tables, `webdesk_app` has 74 grants, the deliberate REVOKEs hold,
   and RLS integrity is OK on 19 tables.
3. **CRLF trap.** `git archive` run from this Windows checkout applies `core.autocrlf` and
   shipped every file with CRLF. `init-roles.sh` died on `set: -: invalid option`, and the
   Postgres entrypoint carried on without the roles. Fixed by shipping with
   `git -c core.autocrlf=false archive`.

Also: the api image build on the live box pushed its load to **16.4 on 4 cores** for about a
minute; the ERP stayed up (0.1 s responses). Future WebDesk images are built on sumopod. Payload's
admin container was not restarted after the rebuild (WSK-D37 removes it; it holds nothing). Live
`/v1` answers again: 401 problem+json for an unknown tenant, lockdown 404s intact. Next: WSK-57
(tenant provisioning) waits on WSK-62's loader-principal answer.

**2026-10-10, WSK-54.** The bundle exporter lives in the site repo on branch `webdesk-importer`
(`10c2d21`, not pushed): 326 items (315 pages, 235 EN + 80 ID, 68 twin pairs; plus the company,
navigation, token-registry and redirect globals). The export is byte-identical across runs. All 315
pages round-trip exactly against Astro's own loader on Linux. **Visibility mapping accepted as the
default** (the owner ruled the states, not the mapping): SHOW/KEEP → shown (78); HOLD/LATER → held (78);
MERGE/CUT → hidden (158); `/glossary/` → seo-only (1). The plan rows travel with the items, so the
routing decisions are not lost. Validation against WSK-64's real 1.1.0 validator runs when WSK-64 merges.

**2026-10-10, WSK-69 (merged; not yet run on GitHub).** CI now plans per-component jobs from a diff
against the last *green* CI run on main, and merges tiny jobs to cut per-job minute rounding. The
release builds only changed components and re-tags the rest by digest. That keeps their existing
cosign signatures valid; digest preservation was proven against a real registry. The planner has
17/17 unit tests on Linux, and actionlint is clean. Estimates: a WebDesk-only cycle drops from about
58 to about 14 billed minutes. The deploy job's ~7 min is now the largest fixed cost. **The first push
re-runs everything, because ci.yml itself changed; the first tag rebuilds all 12, because release.yml
changed.** The real proof is the second tag: plan shows RE-TAG for the unchanged components, and
deploy's `cosign verify` passes for all 9.

**Found by WSK-69, not ours to fix:** `platform-nest` shard 1 has been red since about 2026-09-17.
`monitoring.controller.test.ts:897` hard-codes 2026-09-10 window dates, which have since aged out of
the list endpoint's 7-day filter. It is a test-only time bomb. The shared checkout shows that file
modified by another session, so it is left to that owner. The release is not gated on CI.

**2026-10-10, live.** Migration 0009 was applied to the live WebDesk DB as `webdesk_migrator`: 1 applied,
an idempotent re-run applied 0, RLS integrity OK on 20 tables, `/v1` unchanged (401 for an unknown
tenant). Backup `~/webdesk-backups/20261010T051357Z`. WSK-63b (ERP egress client) merged. Its live probe
needs the platform image that carries it, so it waits for the first release.

**2026-10-10, WSK-55: the delivery half is proven against a dev stack.** In default mode, gaiada.com built from
WebDesk's `/v1` matches the git build exactly: 302 files, 0 differ. Source parity is 315/315 under Astro's own
parser, and the globals are byte-identical. The site's gates pass. The negative control holds: one FAQ edit in
WebDesk changes exactly `services/seo/index.html`. The work is on the site repo's `webdesk-parity` branch
(`b49b40a`, not pushed). A live run changes only `WEBDESK_API_URL` and the read key.

**Two findings.** (1) The site's preview-held build has failed since `cef4b5b`, from git too:
`/about/[...slug]` refuses the held `/about/team/<role>/` standard pages. A 2-file route patch, used only
inside the gate, makes preview parity 0-diff as well. The fix belongs to the site owner (gaiada-web-revamp);
the candidate patch is in the scratchpad `gate55/pvpatch/`. (2) `pages.json`'s derived counts come from a
content-package generator that is not in the repo, and the bodies have changed since it ran. They therefore
travel as a read-only `manifest` group on each page and cannot be regenerated. `/v1` does not serve
compositions, so the pull reads the content model from git.

**2026-10-10, WSK-60 merged as PROTOTYPED.** Built and tested against stubs: the GitHub dispatch through
the real App code, the stamp poll, the forced-command deploy script (53 refusals in a real sshd), and the
`build-status` / `rebuild-requests` routes. It has never touched real GitHub, delphi or a live `/v1`.
It also fixed the shared GitHub client, which treated every 403 as a rate limit and so hid a missing
`actions:write` behind three 60 s backoffs. Cost is estimated at ~3 billed min per rebuild. Owner steps
(App install, repo secrets and variables, merging the workflow to `astro-site`) and the delphi deploy
user are in `infra/runbooks/webdesk-staging-rebuild.md`. A self-approved `content.rebuild` is allowed
(it reuses `github_repo:deploy`); a rebuild changes no content.

