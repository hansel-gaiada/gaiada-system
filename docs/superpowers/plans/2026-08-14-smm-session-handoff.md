# SMM session handoff — 2026-08-12/14

**Read this first if you are picking up the social-media (SMM) department in a new session.**

The binding design is `docs/blueprints/smm-design-addendum-2026-08-12.md` (it overrides
`smm-design.md` v1.0 wherever they disagree). This file is the session log: what shipped, what is
live, what is decided, what is open, and the traps that cost real time.

**Owner constraint, stated 2026-08-14 and binding on everything below: FREE tools and repos only.**
Paid engines (Mixpost Pro) are out. §5 of this document is the revised recommendation under that
constraint — it replaces the "price Mixpost Pro" advice given earlier in the session.

---

## 1. State of the world

| | |
|---|---|
| App version live | `Alpha 01.040.0093c` on `erp.gaiada.online` |
| `social-media` module | **`0.5.0` · IN PROGRESS** |
| Migrations | `0105` (schema) + `0106` (IAM) — **applied in production** |
| Postiz engine | **DEPLOYED and DEV-VERIFIED** on the SumoPod VPS (see §3) |
| `main` | green as of the last IAM run |

---

## 2. What shipped this session (10 tickets)

| Ticket | What it is | State |
|---|---|---|
| **SMM-01** | Schema: 16 tables on **two** RLS walls (`0105`) | live |
| **SMM-30** | IAM registration: 36 permissions, 8 Cerbos policies, 9 groups, `social_staff`/`social_manager` (`0106`) | live |
| **SMM-03** | *Absorbed into SMM-30* — bundles are generated from policies, so they had to land together | n/a |
| **SMM-02** | Module shell: contract, controller, engagement CRUD, the tool-scope dial, 4 MCP tools | live |
| **SMM-08** | Composer backend: posts + per-network variants, validation engine, `args_sha256`, native import | live |
| **SMM-11** | Console: `social-media` toolkit, Calendar, Composer, `lib/social.ts`, rbac mirror | merged |
| **SMM-19** | Brand-voice RAG + AI drafting via the gateway, with a cross-client leak test | merged |
| **SMM-37** | Validator gaps: media format, Facebook's schedule window, YouTube's 3-bucket quota | merged |
| **SMM-04 / 04b** | Postiz containment spike; trimmed 9→5 services; retargeted at the VPS over WireGuard | merged + **deployed** |
| **SMM-05** | `SocialPublisher` port + Postiz driver + org provisioning + connector-registry sync | merged |
| **OQ-1** | 902-line platform-app review dossier for all four networks | merged |

Tests at handoff: **163 in `src/modules/social`**, 615 across `src/rbac` + decider suites, UI 706.

---

## 3. What is LIVE on the VPS (`150.109.15.108`)

Five services, compose project **`gaiada-social`**, all healthy: `postiz`, `social-postgres`,
`social-redis`, `social-temporal`, `social-temporal-postgres`.

- **Transport:** WireGuard `gda-aicenter 10.88.0.1` ↔ `VPS 10.88.0.2`, MTU 1380, `wg-quick@wg0`
  enabled on both hosts. ERP → Postiz API = **401 in 7.9 ms**. Public internet → **HTTP 000**.
- **Nothing is published on `0.0.0.0`** — `ss -ltn` shows `10.88.0.2:4007` only. This matters more
  than usual here: Docker's iptables rules are evaluated BEFORE `ufw`, and that host's `DOCKER-USER`
  chain is empty, so a `0.0.0.0` bind would be internet-reachable while `ufw status` looked fine.
- **The owner's production was untouched:** container baseline 20 → 25, the five added are ours, the
  removed list is empty.
- Secrets were generated **on the host** with `openssl rand`; `.env` is mode 600; registration
  disabled from first boot; **zero Postiz code patched**.
- **Disk:** 136 GB was reclaimed by pruning stale Docker BUILD CACHE (147 GB, 2467 entries, none
  active). Images were deliberately NOT pruned — on a box running someone's production, removing a
  tagged image risks a restart finding nothing to start from. **This will creep back; a periodic
  `docker builder prune -af` belongs in that box's maintenance.**

### NOT done on the VPS

- **No Postiz organisation exists yet.** Provisioning ADOPTS an operator-created org (Postiz has no
  org-creation API — §A4n). That is a deliberate one-shot ceremony: open signup → create the single
  org → close signup → record the API-key alias in `.env`. **Owner-authorised step; not taken.**
- No client account is connected, and none can be until the platform-app reviews land.

---

## 4. Owner decisions already taken (do not relitigate)

| # | Decision |
|---|---|
| OQ-7 | Postiz runs on the SumoPod VPS, not `gda-aicenter` (the footprint tripwire fired there) |
| OQ-1 | Submit **all four** app reviews; the dossier recommends **Meta first** (its Business Verification is the only serial prerequisite and blocks App Review entirely) |
| OQ-3 | Own-brand accounts proceed; client connects wait for AGPL counsel sign-off |
| OQ-2 | X ships **disabled** — keeps the publish path $0 and D14-registry-eligible |
| OQ-5 | Media rides `files` + Drive mirror |
| D-16 | Client post-approval builds in P2, on a plain-tenant-wall table |
| D-17 | Image generation deferred — no generative backend exists in the estate |
| — | Work parallelises across 3–4 agents **in isolated git worktrees**, never the shared checkout |

---

## 5. ⚠ OPEN DECISIONS — these block real work

### 5a. The P2 inbox — REVISED for the free-only constraint

**The finding:** Postiz has **zero inbound surface** — no comments, no DMs, for any of the five
networks. Verified from its live OpenAPI (22 routes, no comments/messages controller) and its
provider code. `GET /public/posts/{id}/comments` is a decoy: it is Postiz's internal team notes on a
draft. **SMM-15/16/17/18 have nothing to call.**

**What the research says is even possible:** Instagram + Facebook are the ONLY networks with a DM
API. LinkedIn and YouTube expose comments but no DMs. TikTok exposes **neither** on its developer
platform — its comments live on a separate `business-api` platform needing its own app, Business
Center linkage and (since 2026-03-20) a separate application form.

**The hard constraint nobody had named:** we do not hold the tokens. By design (D-5) client tokens
live INSIDE Postiz and are never copied into our DB. Reading comments ourselves needs either a second
OAuth grant per client per network — doubling an onboarding ceremony that already requires the
client's owner to click personally — or copying tokens out, which breaks the custody split.

**Free-only options, in the order I would consider them:**

1. **Ship P1 (publishing) first, scope the v1 inbox to comments-only on IG/FB/LinkedIn/YouTube, and
   build it direct-to-API** — accepting a second, read-only OAuth grant per client. Free. The cost is
   onboarding friction, and it is honest friction: the client is granting a genuinely different power.
2. **Take the fork exception** (see 5b) and add a minimal token-read or comment-proxy surface to
   Postiz. Free, but it enlarges the AGPL fork beyond the ~15 lines already requested and moves
   token custody, which is a security decision, not a convenience one.
3. **Retire Postiz over time in favour of a `direct` driver** implementing the same
   `SocialPublisher` port. This is the only free path that removes the AGPL zone, both fork
   exceptions AND the inbox gap in one move. It is a real build (OAuth, token refresh, media upload
   and a queue, per network) — but SMM-05's port means it can be added ALONGSIDE the Postiz driver
   and switched per capability. **Mixpost Lite is free but its inbox is a Pro feature, so it does not
   solve this.**

**My recommendation:** (1) now, and treat (3) as the direction of travel — start it for the two
networks where we control the app registrations anyway. Do not fork.

### 5b. The TikTok fork exception (~15 lines) — recommended

TikTok requires the posting UI to show the creator their OWN live settings (allowed privacy levels;
whether comment/duet/stitch are permitted) fetched from `creator_info`, with **no defaults**. Postiz
fetches that data and discards it — the values never leave the function and no route exposes them.
Our composer therefore cannot be compliant no matter how well we build it. The fix is ~15 additive
lines in one Postiz file — but our §06 containment budget permits only packaging/config changes, so
even that needs an explicit exception.

**A second candidate has since appeared:** the Instagram live-quota probe needs a Postiz route gated
behind the same missing decorator. If the exception is granted, grant it once with both in scope.

### 5c. OQ-8 — TikTok's consent timing vs our approve-then-queue spine

TikTok requires the creator to consent **immediately before** upload. We approve at T and publish
unattended at T+hours. If read strictly, **scheduled TikTok posting is not approvable at all**.
Options: (a) TikTok becomes publish-now only; (b) treat the composer's explicit selections as the
consent and re-verify `creator_info` at dispatch; (c) stay in inbox mode. UNVERIFIED — it decides
whether "schedule a week of TikTok content" is sellable.

---

## 6. Open tickets, in dependency order

**Unblocked now:** SMM-07 (account connect — needs the org ceremony first) · **SMM-09 the publish
gate** (opus-high, MUST RUN ALONE — it defines the spine SMM-10/17/22/31 consume) · SMM-36
(per-network retention + purge) · SMM-12 (Calendar/Composer UX).

**Then:** SMM-10 (dispatch + reconcile) · SMM-13 (events → notifications) · SMM-14 (P1 e2e).

**P2:** SMM-15/16/17/18 (inbox — blocked on 5a) · SMM-31/32 (client review).
**P3:** SMM-20/21/22/23/24/25 + SMM-33 (capability inventory).
**P4:** SMM-26/27/35.
**Gated:** SMM-28 (Mixpost — now effectively dead under free-only) · SMM-29 (ClipsAI) · SMM-34
(generative images, needs the Creative render gateway).

### SMM-36 deserves highlighting

LinkedIn caps retention: **24h** for another member's profile data, **48h** for comment text.
`social_inbox_threads`/`social_inbox_messages` were designed to retain indefinitely — that is what an
engagement inbox IS. A per-network retention policy + purge job **must exist before the first
LinkedIn client connects**; compliance is checked at Standard Tier review.

---

## 7. Traps this session paid for — do not re-learn these

1. **`healthy` is not `working`.** Postiz's container healthcheck probes only the frontend. With the
   Temporal search-attribute slot unfixed, the backend dies on boot, never binds, every call 502s —
   and the container reports healthy throughout. **Always prove with `curl` expecting 401, not 502.**
2. **Temporal on Postgres visibility allows exactly 3 custom Text search attributes.** Temporal
   pre-registers 2, Postiz wants 2 more. Remove `CustomStringField` BEFORE Postiz first starts.
3. **Docker's iptables rules run BEFORE `ufw`.** A `0.0.0.0` bind is internet-reachable while
   `ufw status` says otherwise. That host's `DOCKER-USER` chain is empty.
4. **`docker image prune -a` is safe on our box and dangerous on the owner's** — it deletes images
   that someone else's stopped production containers restart from. It was removed from the runbook.
5. **Build cache, not images, was 118 GB of the 147 GB.** Pruning build cache cannot stop a container.
6. **Parallel agents share one test Postgres.** Two agents reported "pre-existing" rbac failures that
   passed when re-run on `main`. Treat any such report as a HYPOTHESIS until re-run in isolation.
7. **Worktree agents read a stale world.** Branches cut before later commits will report sections as
   "missing". Re-check against `main` before acting.
8. **The refusal token goes in `message`, never `error`** — `http-error.filter.ts` renames `message`
   to `error` and would silently replace a token set as `error`.
9. **A guard anchored on a text literal breaks on unrelated edits.** The MAIL-23 drift guard broke
   twice in one day; it now anchors on rule IDENTITY (actions + roles pair).
10. **`deploy.yml` does not consult CI.** A tag ships whatever is tagged. Two failed deploys landed
    on the live box today from another session, one of them `min(uuid)`, which a one-minute
    fresh-database migration run would have caught.

---

## 8. Corrections I made to my own record (kept visible on purpose)

- `0105` never contained the `youtubeUnitsToday` example — I claimed it twice; it lives in
  `smm-design.md` §04. Caught by the SMM-37 agent.
- "internet RTT" on the cross-host hop: measured at **2.6 ms**, then **7.9 ms** for a full HTTP round
  trip over the tunnel. The concern was overstated.
- `ufw` was reported as "22 and 80 only" from a truncated `head -6`; it also opens 443, 9090, 3010,
  3001. **9090 is conventionally Prometheus, which ships with no auth — worth the owner's attention,
  unrelated to this programme.**
- §A4g (YouTube research) was reported as recorded when the write had never run; restored later.
- The role names are `social_staff`/`social_manager`, NOT `smm_*` — derived from the module key by
  Cerbos, not free-form.

---

## 9. First moves for the next session

1. **Answer 5a/5b/5c** — they gate P2 and TikTok entirely.
2. **Do the org ceremony** on the VPS (open signup → create one org → close signup → record the key
   alias). SMM-07 cannot proceed without it.
3. **Start SMM-09** (the publish gate) — highest-value unblocked ticket, and it must run alone.
4. **Start SMM-36** in parallel — it is independent and it gates the first LinkedIn client.
5. Keep using **isolated worktrees**; verify every agent's "pre-existing failure" claim before acting.
