# SMM-04 — Postiz containment spike + deploy plan

> ## ⚠ SUPERSEDED IN PART, 2026-08-13 — read §12 before acting on anything below.
> The owner resolved OQ-7 (addendum §A4k) and **the target host changed**: Postiz runs on the
> SumoPod VPS `150.109.15.108`, not on `gda-aicenter`. §9's blocked decision is **closed**
> (option C). §5's headroom read is moot as a gate. **One instruction in this report is
> actively dangerous on the new host** — the `docker image prune -a` in the runbook procedure —
> and §12 lists it with everything else the move invalidates. The retarget is SMM-04b; its
> reasoning lives in addendum **§A4l**.

> **Status:** **PROTOTYPED** — the trimmed stack was built, started and driven on local Docker.
> **Nothing has been deployed to either host.**
> **Ticket:** SMM-04 (⚡ contract-touching: licence + security boundary; QA gate mandatory).
> **Date:** 2026-08-13 · **Seat:** senior-integrator ·
> **Binding inputs:** [`smm-design-addendum-2026-08-12.md`](../../blueprints/smm-design-addendum-2026-08-12.md)
> §A4c/§A4d · [`smm-design.md`](../../blueprints/smm-design.md) §03/§06/§11 ·
> [`infra/CLAUDE.md`](../../../infra/CLAUDE.md) · [`deploy-vps.md`](../../../infra/runbooks/deploy-vps.md)

---

## §1 · The five answers, up front

| Question | Answer |
|---|---|
| **Can the stack be trimmed 9 → 5?** | **Yes — DEV-VERIFIED.** All five run, Postiz's REST API answers. Elasticsearch is genuinely droppable, but only with a bootstrap step that is easy to miss and **fails silently while reporting healthy**. |
| **What does it actually cost?** | **~3.4 GiB RSS · ~6.7 GB new disk.** Postiz alone is **2.27–2.83 GiB**. |
| **Does the live box have room?** | **No.** `gda-aicenter` has **~4.0 GB RAM available and is already 2.45 GB into swap**, with **13 GB of 49 GB disk free**. The stack wants ~85% of remaining RAM and ~52% of remaining disk. |
| **Does containment hold?** | **Four of five invariants hold. Invariant 5 (frontend never served) holds ONLY IF** we own the OAuth callback path — the obvious wiring serves a Postiz frontend page to a browser. |
| **Does the thin-fork budget hold?** | **For everything SMM-04 touched, yes — zero Postiz code changed.** But TikTok direct-post needs a **~15-line, 1-file provider patch** that is outside the four permitted categories and needs an explicit budget exception. **OQ-4 (DMs) is a hard tripwire** — do not attempt it in Postiz. |

**Tripwire fired: the footprint one (§A4c consequence 3).** Escalating rather than working
around it, per the ticket's own instruction. §9 has the options.

---

## §2 · What upstream actually ships, and what we cut

Verified against `gitroomhq/postiz-docker-compose` `main` (fetched 2026-08-13), not from the
addendum's summary of it. One correction to §A4c: **`spotlight` is already gated behind
`profiles: [debug]` upstream** — it never starts on a plain `up`, so "dropping" it is a no-op
rather than a saving.

| Upstream service | Image | Disposition |
|---|---|---|
| `postiz` | `ghcr.io/gitroomhq/postiz-app` | **KEEP** |
| `postiz-postgres` | `postgres:17-alpine` | **KEEP** |
| `postiz-redis` | `redis:7.2` | **KEEP**, retagged `7.2-alpine` (170 MB → 57 MB) |
| `temporal` | `temporalio/auto-setup:1.28.1` | **KEEP** — the queue engine the publisher runs on |
| `temporal-postgresql` | `postgres:16` | **KEEP**, retagged `16-alpine` (642 MB → 420 MB) |
| `temporal-elasticsearch` | `elasticsearch:7.17.27` | **DROPPED — proved, see §3** |
| `spotlight` | `getsentry/spotlight` | already `profiles: [debug]`; not started either way |
| `temporal-admin-tools` | `temporalio/admin-tools` | **DROPPED** — a CLI toolbox, not a runtime dep |
| `temporal-ui` | `temporalio/ui:2.34.0` | **DROPPED** — doctrine forbids exposing it |

Also dropped: upstream's published ports for `temporal` (`127.0.0.1:7233`) and `temporal-ui`
(`8080`). Our Temporal has **no published port at all** — the adapter talks to Postiz's REST
API and never to Temporal, so the bootstrap step uses `compose exec` instead.

**Every one of these is packaging/config — category (a)/(b) of the §06 budget. No Postiz code
was patched to achieve the trim.**

Shipped as `infra/compose/docker-compose.social.yml`.

---

## §3 · Dropping Elasticsearch — proved, with a trap attached

`ENABLE_ES` defaults to **false** in the image's own `auto-setup.sh:46`, and the false branch
(`auto-setup.sh:251`) provisions a **Postgres** visibility schema instead of an ES index. So the
drop is achieved by *removing* env vars, not adding any.

**Verified with no Elasticsearch host in existence:**

```
$ temporal operator cluster health --address temporal:7233
SERVING

$ temporal workflow list --namespace temporal-system      # a pure visibility-store read
  Status            WorkflowId                           Type                     StartTime
  Running  temporal-sys-tq-scanner       temporal-sys-tq-scanner-workflow       23 seconds ago
  Running  temporal-sys-history-scanner  temporal-sys-history-scanner-workflow  23 seconds ago

$ psql -d temporal_visibility -c '\dt'
 public | executions_visibility | table    ← 2 live rows
$ getent hosts temporal-elasticsearch
NO_ELASTICSEARCH_HOST — confirmed absent
```

### The trap — and it is a bad one

Temporal starting is **not** the same as Postiz working. On first boot with ES dropped, Postiz's
backend crashed:

```
Unable to create search attributes: cannot have more than 3 search attribute of type Text.
  at TemporalRegister.onModuleInit (.../temporal/temporal.register.js:23)
```

The arithmetic, exactly: the SQL visibility store pre-allocates **three** Text columns
(`text01..text03`). Temporal pre-registers **two** of its own (`CustomStringField`,
`CustomTextField`); Postiz registers **two** more (`organizationId`, `postId`). 2 + 2 = 4 > 3.
**We are short by exactly one slot.** ES has no such cap, which is why upstream never hit it.

What made this dangerous rather than merely annoying:

- the backend **never bound its port**, so every `/api/*` call returned **502**;
- `docker compose ps` reported the container **`healthy` throughout** — the healthcheck probes
  only the Next frontend on `:5000`, which was fine.

That is the same shape as the Cerbos incident already in the runbook: a green health signal over
a dead service. **Fix (config only, no fork):** remove the unused Temporal default before Postiz
ever starts —

```
temporal operator search-attribute remove --name CustomStringField --namespace default --yes
```

**Verified after the fix:** `organizationId` and `postId` both registered as Text (3/3, exactly
at the cap), and `GET /api/public/v1/posts` returned **`401 {"msg":"No API Key found"}`** —
a real backend answer, not a proxy error. Written into the runbook as a required, ordered step.

---

## §4 · Measured footprint (not estimated)

Local Docker, 16 GB / overlayfs, `gaiada-*` containers left untouched. Sampled with
`docker stats` through boot, at settled idle, and under load.

### RAM

| Service | Idle (settled) | Peak observed |
|---|---|---|
| `postiz` | **2.27 – 2.75 GiB** | **2.83 GiB** (boot) · 2.765 GiB (load) |
| `social-temporal` | 339 → **449 MiB** (climbs after boot) | 449 MiB |
| `social-temporal-postgres` | 135 MiB | 135 MiB |
| `social-postgres` | 49 MiB | 82 MiB (migrations) |
| `social-redis` | 27 MiB | 27 MiB |
| **TOTAL** | **≈ 3.4 GiB** | **≈ 3.5 GiB** |

**Where Postiz's 2.5 GB goes** — one process dominates:

```
1638844 KB  node .../apps/orchestrator/src/main.js     ← 1.64 GB, the orchestrator
 519392 KB  node .../apps/backend/src/main.js
 106596 KB  next-server (v16.2.6)
 ~460000 KB  pnpm + PM2 supervision scaffolding (7 processes)
```

The orchestrator starts **one Temporal worker per supported network** — the logs show task
queues for `twitch, mastodon, bluesky, lemmy, wrapcast, telegram, nostr, vk, medium, devto,
hashnode, wordpress, listmonk, moltbook, whop, skool, mewe, tumblr, …` (30+). **We need five.**
This is the single biggest lever on the footprint and there is **no env var for it** — trimming
it means patching Postiz, which is outside the fork budget. Worth noting for the owner decision:
the cost is structural, not configuration drift.

Upstream's "tested on 2 GB RAM / 2 vCPU" claim does not survive contact with measurement. Treat
it as retired.

### Disk

| Image | Size | New bytes on `gda-aicenter`? |
|---|---|---|
| `ghcr.io/gitroomhq/postiz-app` | **5.66 GB** (5.656 GB unique, 0 shared) | **all of it** |
| `temporalio/auto-setup:1.28.1` | **745 MB** | **all of it** |
| `postgres:16-alpine` | 420 MB | **0** — already resident |
| `postgres:17-alpine` | 424 MB | **0** — already resident |
| `redis:7.2-alpine` | 57 MB | 45 MB (box has `redis:7-alpine`, a different tag) |
| **New image bytes** | | **≈ 6.45 GB** |

Plus, at a **fresh, empty** install: volumes **145 MB** (`temporal-pg` 76 MB, `postiz-pg` 69 MB)
and Postiz's writable layer **144 MB** → **≈ 6.7 GB total on day one**, growing from there.
`social-postiz-uploads` is the media store and is **unbounded**.

### Pull

`postiz-app` is a single-arch download of ~1.9 GB compressed that expands to 5.66 GB. On a box
with 13 GB free, the pull and the expansion are both live risks — this programme has already had
a deploy fill the disk and roll back a healthy release.

---

## §5 · The live box — checked, not assumed

SSH access to `gda-aicenter` **is** available and was used. Measured 2026-08-13:

```
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        49G   35G   13G  74% /

               total        used        free      shared  buff/cache   available
Mem:            7950        3889         923          67        3683        4061
Swap:           4095        2455        1640          ← ALREADY 2.4 GB INTO SWAP
```

- **22 containers running**, not the 13 the ticket and §A4c assume. Correct that number.
- Sum of container RSS ≈ **2.45 GB**; the rest of `used` is host-side — `llama-server` (399 MB)
  and Keycloak's JVM (375 MB) are the two largest single processes.
- `docker system df`: 34 images / 22.09 GB, **6.206 GB reclaimable**. `/var/lib/docker` = 14 GB.
- `vm.swappiness = 60`.

**Read against §4:**

| | Needs | Box has | Verdict |
|---|---|---|---|
| RAM | ~3.4 GiB | ~4.0 GB available, **already swapping 2.4 GB** | **~85% of what is left.** Does not fit with any margin. |
| Disk | ~6.7 GB day-one, growing | 13 GB free (≈19 GB if pruned first) | **~52% of what is left.** Fits only after a prune, and leaves no room for the next few releases. |

Disk is survivable with discipline. **RAM is not.** A box that is already 2.4 GB into swap has no
3.4 GB to give; the realistic outcome is heavy swapping and OOM-kills landing on whichever
container the kernel picks — which may be `platform` or `cerbos`, not Postiz.

---

## §6 · Containment audit — design §06's five invariants

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 1 | **Isolated service/container, REST-only interaction** | **HOLDS** | Own compose project (`gaiada-social`), own Postgres, own Redis, two private networks. Published port is **loopback only**. Temporal has no published port. Nothing in `platform-nest` imports anything of Postiz's. |
| 2 | **Tenancy/RBAC/approvals entirely on our side** | **HOLDS** | Nothing in this ticket puts our logic inside Postiz. Postiz's org model is used as an opaque key (`social_publisher_orgs.postiz_org_id`, already shipped in `0105`). Its DB was read **only** to extract a bootstrap API key for this spike; the adapter never will. |
| 3 | **Thin-to-zero fork within the touchpoint budget** | **HOLDS for SMM-04** — with two forward-looking exceptions | **Zero Postiz code changed.** Every trim is compose/env. See §8 for TikTok and DMs. |
| 4 | **Source offer to interacting users (AGPL §13)** | **NOT YET BUILT — carried forward** | Console footer link is SMM-24's line item. Since we run the **stock image at a pinned digest** with no fork, the offer points at upstream. Nothing here creates an obligation we cannot meet. |
| 5 | **Postiz frontend never served to anyone** | **⚠ AT RISK — holds only under the §7 design** | Postiz builds its OAuth `redirect_uri` as `${FRONTEND_URL}/integrations/social/<provider>` and replays that exact string in the token exchange (`tiktok.provider.ts:325-355`). That target **is a Postiz frontend page.** Honouring it publicly serves Postiz frontend JS to a browser — reopening exactly the AGPL conveyance vector §06 closed on purpose. |

**Signup disabled — verified, not assumed.** With `DISABLE_REGISTRATION=true`:

```
POST /api/auth/register  →  HTTP 400  "Registration is disabled"
```

**The REST boundary is real and fail-closed.** Driven with a live org API key:
`GET /public/v1/integrations` → `200 []`; a bad date → typed `400`; and a publish-shaped
`POST /public/v1/posts` naming an unknown channel →
`400 {"message":"Integration with id nonexistent-channel not found"}`. There is no path to a
publish without a channel that already belongs to the org.

---

## §7 · Edge ingress — and why the obvious wiring is wrong

Design §03 wants an exact-path allowlist for OAuth callbacks and platform webhooks only. Written
as `infra/nginx/snippets/gaiada-social-postiz.conf` (hand-applied, like the CP-5 and ASST-09
blocks — CI never syncs nginx).

**But the straightforward version breaks invariant 5.** The callback target is a Next.js *page*,
and a Next.js page needs its `/_next/static/*` chunks to render. Allowlisting those means
serving the Postiz frontend bundle.

**Preferred design — config only, no fork:** point `FRONTEND_URL` at a path **we** serve
(e.g. `https://erp.gaiada.online/social`), let `platform-ui` own
`/social/integrations/social/<provider>`, catch the `code`, and hand it to Postiz's backend over
loopback. The endpoints for this already exist:
`POST /integrations/social-connect/{integration}` and
`GET /integrations/social/{integration}` (which accepts a **`redirectUrl`** parameter).
Then **Postiz is never exposed at the edge at all** and the allowlist is empty.

**This is NOT verified** — it needs a real network app credential, and all four reviews are still
in flight (OQ-1). **SMM-07 owns proving it.** The fallback exact-path blocks are in the snippet
with their cost documented; the file explicitly forbids quietly widening them to `/_next/`.

One trap recorded in the snippet: when `FRONTEND_URL` is not `https`, Postiz routes the callback
through the third-party shim `redirectmeto.com`. Ours is https so the branch is dead — but a
non-https `FRONTEND_URL` in production would route account connects through someone else's host.

---

## §8 · Fork-budget findings that are NOT SMM-04's to spend

Both came out of a source-level audit of the running build (the image ships full TypeScript, so
these are read from real code, not docs).

### 8a · TikTok direct-post — a genuine gap, small patch, needs an explicit exception

Postiz has **documented TikTok audit rejections** for UX non-compliance (upstream issues #1563,
#1362). We build our own composer, so the *UX* obligation is ours — the question was whether the
*transport* can carry it.

**Publish parameters — no gap.** All six required flags are caller-supplied over public REST and
forwarded, validated by `TikTokDto` through a discriminated union keyed on `__type`. Names differ
between layers and our composer must translate:

| Public API (`settings.*`) | Sent to `/video/init/` |
|---|---|
| `privacy_level` | `privacy_level` |
| `comment` / `duet` / `stitch` (positive) | `disable_comment` / `disable_duet` / `disable_stitch` — **polarity inverted** |
| `brand_content_toggle`, `brand_organic_toggle` | passthrough |
| `video_made_with_ai` | `is_aigc` — **renamed** |

The provider's `privacy_level: … || 'PUBLIC_TO_EVERYONE'` fallback — which would be a compliance
failure — is **unreachable over REST**: the DTO field has no `@IsOptional()` and validation runs
with `skipMissingProperties: false`, so omitting it yields a 400, never a silent public post.

**`creator_info` — the gap.** TikTok requires the creator to choose `privacy_level` from the
values `/v2/post/publish/creator_info/query/` returns, with no default, and to see which of
comment/duet/stitch are disabled. Postiz calls that endpoint in exactly one place
(`tiktok.provider.ts:397-416`) and **destructures only `max_video_post_duration_sec`**, discarding
`privacy_level_options`, `comment_disabled`, `duet_disabled`, `stitch_disabled`. That method
(`maxVideoLength`) has **zero callers** — it is dead code. It is not exposed over REST either:
the generic `POST /public/v1/integration-trigger/:id` escape hatch is gated on a `@Tool`
decorator, and the TikTok provider carries none.

**Fix:** one file, ~15 lines — import `Tool`, add a decorated method returning the whole
`creator_info` payload. It then rides the **already-existing** `integration-trigger` route. No
new controller, no route registration, **no DB schema change, no tenancy change**, no frontend
change.

**Budget call — stated plainly rather than waved through.** By blast radius this is the smallest
possible patch and nowhere near the §06 tripwires. But it is **not** one of the four permitted
categories — it is a provider-capability addition. **It needs an explicit budget exception from
the architect/owner, not a silent pass.** Recommendation: **grant it.** It is additive, uses
upstream's own documented extension mechanism, and rebases cleanly.

Note for the compliance review even after the patch: TikTok's branded-content interlocks (e.g.
`brand_content_toggle=true` forbids `SELF_ONLY`) are enforced **nowhere** in Postiz — it only
renders TikTok's rejection string. That enforcement must live in **our** composer, which makes
the `creator_info` response load-bearing rather than decorative.

### 8b · OQ-4, DM/comment coverage — **ZERO. This one is a tripwire.**

**Postiz has no inbound engagement capability at all, for any network.** Not "not exposed over
REST" — the capability does not exist in the product. The complete `/public/v1` surface is 22
routes (enumerated live from the container's own OpenAPI at `/api/docs-json`): posts, uploads,
integrations, analytics, notifications, groups. **No comments controller, no messages
controller, no inbound webhook receiver.** `public.api.module.ts` registers exactly one
controller.

| Network | Read comments | Read DMs | Reply |
|---|---|---|---|
| Instagram · Facebook · LinkedIn · TikTok · YouTube | **No** | **No** | **No** |

The only `comments` tokens in those providers are **aggregate metric names** in analytics calls
(counts, never content, never an id, never a reply verb).

**One trap to avoid:** `GET /public/posts/{id}/comments` exists — note `/public/`, **not**
`/public/v1/`. The Prisma `Comments` model keys on `postId → Post` and `userId → User`: these
are Postiz's internal **team-collaboration notes on a draft**, not social comments. Anyone
skimming the route list will mistake this for inbox coverage. It is not.

**Consequence — this is a design decision, not a ticket estimate.** Closing OQ-4 inside Postiz
means new provider methods, new controllers **and new DB tables** — squarely a schema-plus-
multi-file change, which is the §06 tripwire verbatim. **Do not fork Postiz for the inbox.**

**This directly hits SMM-15/16/17/18 (all of P2), which the addendum scopes as "Inbox sync
(`pullInbox`)" against the `SocialPublisher` port.** There is nothing behind that port to call.
P2's engagement half needs re-planning as either (a) a separate per-network integration we own,
or (b) the Mixpost fallback, whose built-in inbox is the reason §06 listed it as the capability
checklist in the first place. **Architect decision — flagged, not taken here.**

---

## §9 · The blocked decision, and the options

The ticket instructs me to stop and escalate rather than work around a fired tripwire. **The
footprint tripwire has fired on measured numbers**, so the deploy plan stops here.

| # | Option | Cost | Honest read |
|---|---|---|---|
| **A** | **Deploy as-is to `gda-aicenter`** | £0 | **Not advisable.** ~3.4 GiB against ~4.0 GB available on a box already 2.4 GB into swap. OOM-kills would land on whatever the kernel picks — possibly `platform` or `cerbos`. |
| **B** | **Add RAM to `gda-aicenter`** (8 → 16 GB) | one VPS resize | **Cleanest fit for the current architecture.** Also relieves the pre-existing 2.4 GB swap, which is a real problem *today*, independent of SMM. Disk still wants a prune and a bigger volume soon. |
| **C** | **Own host for the Postiz stack** | a second small VPS | Best containment (the licence zone gets its own blast radius, matching §03) and removes the ERP-OOM risk entirely. Costs a box and an edge route. This was §A4c's consequence-3 question; the measurements now argue for it more strongly than when OQ-7 was answered. |
| **D** | **Reconsider the engine** (Mixpost Pro) | ~$299–1,199 | §A4c added "unaffordable footprint" as a legitimate swap trigger, and **§8b independently weakens the Postiz case** — its missing inbox is precisely what Mixpost has. If P2 is in scope, this deserves a real look rather than a reflexive no. |

**My recommendation, for the owner to accept or reject:** **B or C**, and **re-open the engine
question (D) before P2 is planned** — not because containment failed (it holds), but because the
engine cannot do half of what P2 assumes, and we now know that for free rather than after
building against it.

**What does NOT need to wait:** SMM-05/06 can be built against the trimmed stack **locally** —
it is proven working and the adapter only ever needs the REST API. Nothing about this blocker
stops the publish loop being developed; it stops it being *hosted on that box*.

---

## §10 · Files touched

| Path | What |
|---|---|
| `infra/compose/docker-compose.social.yml` | **NEW.** The trimmed 5-service stack. Separate project `gaiada-social`, profile `social`, digest-pinned, loopback-only, `mem_limit` on every service. |
| `infra/compose/.env.example` | **NEW `SOCIAL_*` block.** Every var is also listed in the service's `environment:` — the passthrough trap. |
| `infra/nginx/snippets/gaiada-social-postiz.conf` | **NEW.** Exact-path allowlist + the §7 argument for why the preferred design needs none of it. |
| `infra/runbooks/deploy-vps.md` | **AMENDED.** New "Postiz / SMM" section: the blocker, the separate-project reasoning, the ordered bootstrap incl. the search-attribute step, and the ops notes. |
| `docs/superpowers/plans/2026-08-13-smm-04-containment-spike.md` | This report. |

**Deliberately NOT changed:** the `COMPOSE_FILES` / `COMPOSE_PROFILES` repo variables, and
`docker-compose.vps.yml`. Keeping this stack out of the release path is the point.

### Deploy-trap interactions, each addressed

| Trap | How this change handles it |
|---|---|
| `--remove-orphans` deletes off-profile containers | **Structurally unreachable** — separate compose project, invisible to the `gaiada` project's deploy command. Not merely "protected by a profile". Verified: without `COMPOSE_PROFILES=social`, `config --services` lists nothing. |
| A var in `.env` does nothing unless `environment:` lists it | Every `SOCIAL_*` var is named explicitly in the service block. Required ones use `:?` and **fail loudly** — verified: `required variable SOCIAL_POSTIZ_MAIN_URL is missing a value`. |
| `up -d` with a stale `.env` rolls the release back | Not in the release path, and pinned by **digest** rather than `GAIADA_TAG`. A stale `.env` cannot move it. |
| Deploy fills the disk, then rolls back | Runbook step 0 is a prune plus a `df -h`, before anything is pulled. |
| Green health over a dead service | Called out twice: the healthcheck probes only the frontend, so the runbook verifies the **backend** with a `curl` that must return 401, not 502. |

---

## §11 · What was NOT verified — stated plainly

1. **No real publish to a real network.** No app credential exists yet (OQ-1 in flight). The
   publish-shaped operation exercised nginx → backend → validation → DB and returned a typed
   refusal; the network leg is unproven. **A real publish remains SMM-07/SMM-10's evidence.**
2. **Nothing was run on `gda-aicenter`.** Headroom was *read* from it; the stack was never
   started there. All footprint numbers are from local Docker (16 GB, overlayfs) and would be
   **worse** on a smaller, swapping box, not better.
3. **The §7 preferred ingress design is reasoned from source, not driven.** It needs a real
   OAuth round-trip. SMM-07 owns it.
4. **Long-run behaviour is unmeasured.** Postiz's RSS was still drifting upward at the end of
   the run (2.27 → 2.75 GiB in ~45s), and Temporal climbed 339 → 449 MiB. A soak test would
   likely raise the idle figure, not lower it. Treat §4 as a **floor**.
5. **`temporal-elasticsearch` was never started**, so there is no A/B against the ES-backed
   configuration — the ES-less path was proved directly instead.
6. **`platform-nest`'s test suite was not run** (shared test containers; out of scope).

---

## §12 · SMM-04b retarget (2026-08-13) — what this report still means

The owner moved the host (§A4k). Full reasoning, the transport decision and the measurements are
in addendum **§A4l**; this section exists so nobody acts on a stale instruction from §1–§11.

**One thing here is dangerous, not merely stale.** §10's runbook procedure opened with
`docker image prune -a --filter "until=168h"`. That was correct against `gda-aicenter`'s 13 GB
of free disk and our own images. The new host runs **19 containers of the owner's private
production**, so on that box the same command deletes images that are not ours and that stopped
production containers need to restart from. **It has been removed from the runbook. Do not put
it back.** The safe equivalent is `docker builder prune -af` (build cache only, provably inert).

| § | Claim | After the retarget |
|---|---|---|
| §1 / §4 | ~3.4 GiB RSS, ~6.7 GB disk | **Footprint unchanged** — the tripwire was cleared by changing hosts, not by shrinking anything. Disk is now **~7.6 GB** day one: none of `postgres:16/17-alpine` or `redis:7.2-alpine` is resident on the VPS, so the "zero new bytes" credits do not apply there. |
| §5 | `gda-aicenter` headroom | **Moot as a gate; still correct as facts** about that box. |
| §9 | The blocked decision | **CLOSED — option C.** Own host for the Postiz stack. |
| §6 / §7 | Containment invariants 1–5 | **Unchanged; invariant 1 is stronger.** The licence zone is a separate machine now, which makes "arm's length, REST only, no shared process" easier to demonstrate. §7's preferred ingress design is unchanged, cheaper, and still SMM-07's to prove. |
| §7 | `proxy_pass http://127.0.0.1:4007` | Now `http://10.88.0.2:4007` — the WireGuard peer. The edge blocks **stay on `erp.gaiada.online`**; the VPS gets no vhost, no certificate and no public listener. `FRONTEND_URL` is unchanged, so no connected account can be invalidated by the move. |
| §8a / §8b | TikTok fork exception; **OQ-4 = zero inbound surface** | **Untouched.** Both remain the architect's. |
| §10 | separate project / `--remove-orphans` | Still true, now doubly so. **New trap in its place:** never run a non-project-scoped Docker command on the VPS. |
| §11 | "Nothing was run on `gda-aicenter`" | **Extend: nothing has been run on the VPS either.** All figures remain local-Docker floors. New unverified items: the tunnel, and the VPS-side prerequisites (§A4l §7). |

**Two things this report could not have known, both measured 2026-08-13:** the hop is **2.6 ms**
(8/8 ICMP, ~3 hops, TCP handshake 2.0–3.0 ms), so latency is not a design constraint; and
`gda-aicenter`'s `ens4` is **MTU 1460**, so the tunnel MTU must be 1380 or **media uploads
black-hole silently** while every small request succeeds.

**One deliberate change to a number this report set:** `postiz`'s `mem_limit` goes 3g → **4g**.
3g was a 6% margin over a peak that was still climbing when measurement stopped — defensible on
a 4 GB box, self-defeating on a 12 GiB one, where it turns a soak into a routine OOM-kill and
destroys the signal. The limit's purpose also changed: it no longer protects the ERP, it
protects the owner's 19 production containers.

---

*Cross-references:* [SMM addendum §A4c/§A4d](../../blueprints/smm-design-addendum-2026-08-12.md) ·
[§A4k/§A4l retarget](../../blueprints/smm-design-addendum-2026-08-12.md) ·
[base design §03/§06/§11](../../blueprints/smm-design.md) ·
[deploy runbook](../../../infra/runbooks/deploy-vps.md) ·
[compose](../../../infra/compose/docker-compose.social.yml) ·
[edge allowlist](../../../infra/nginx/snippets/gaiada-social-postiz.conf)
