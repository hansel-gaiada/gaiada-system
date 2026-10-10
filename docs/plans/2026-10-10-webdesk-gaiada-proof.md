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
