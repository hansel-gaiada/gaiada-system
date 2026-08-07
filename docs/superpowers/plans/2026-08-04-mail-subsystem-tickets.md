# Mail Subsystem — Ticket Plan **v4** (dev stage executed → billing wall → deferred live batch → staging reopen)

**Status:** EXECUTED through W4 + MAIL-16D; **BLOCKED at the billing wall** (design §14 Q-O4 —
GitHub Actions billing-blocked, and it is the ONLY deploy path; the box never compiles). Unblocked
work remaining NOW: MAIL-19 → MAIL-20 (v4 additions). ·
**Date:** 2026-08-04 (v3 re-cut) → **2026-08-05 v4** (execution-findings amendment) ·
**Architect:** system-architect (Fable·max)
**Design (binding):** `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md` **v4** — implementers
do NOT re-derive decisions M1–M15 / A1–A15; deviations require an architect design-review.
**Staging handover:** design **§15 Staging Reopen Register** (R3 re-scoped in v4 — Brevo has no
webhook signatures; the `DownloadToken`→bytes fetch is a named R3 step).
**Contract:** `docs/FRONTEND-BFF-CONTRACT.md` (update in every BE ticket that adds/changes an endpoint).

**v4 amendment summary (implementation findings, 2026-08-05):** the dev build executed and five
findings changed this plan's shape. (1) **The billing wall:** MAIL-09 cannot execute — MAIL-10/11
and MAIL-18's live legs are blocked behind it, and dev-stage exit criterion #3 (corpus in CI) is
committed-but-unprovable; the waves below are re-drawn honestly and a **deferred live-verification
batch** is defined to run the day billing returns. (2) Brevo signs nothing — MAIL-13's auth is the
token wall (provider-documented) + OUR optional HMAC (design §7.6 v4); §15 R3 re-scoped. (3) Brevo
delivers attachment `DownloadToken`s, not bytes — the token→bytes fetch is a named §15 R3 step.
(4) **Quoted-history gap** (bottom-posted replies could be truncated away at intake, and the
assumed render-side collapse was owned by nobody) — decided as design A15, new tickets
**MAIL-19/20**. (5) **Repo↔server drift** accumulated (MAIL-02/03 manual server fixes; the
`COMPOSE_PROFILES` repo var still unfixed) — new consolidation ticket **MAIL-21**, which MUST
precede the first post-billing deploy. Also ratified: the attachment cap semantics as implemented
(drop-but-thread per-attachment; total cap refuses); recorded: migration landed as
**`0077_mail_core.sql`** (0076 was taken mid-session), ex-Q-V6/ex-Q-V8 settled, the F1 third
insert site (fixed by MAIL-06), and APPR-01 (`/approvals/[id]`, owner-approved, cross-program).

## Execution state (v4, 2026-08-05) — what is actually true per ticket

Statuses per the repo vocabulary; "code-complete (PENDING-DEPLOY)" = suites green + `tsc` clean,
live-box leg impossible until the billing wall falls. Ledger of record: `docs/modules/MODULES.md`
+ `docs/modules/CHANGELOG.md` (`mail` `0.0.1`–`0.0.9`).

| Ticket | State | What is still owed (and by which batch step) |
|---|---|---|
| MAIL-00 | **DEV-VERIFIED** (box-direct) | `COMPOSE_PROFILES` was permission-denied *for the implementing agent*, but the **orchestrator set it in-session on 2026-08-04**: read-back shows `bot,auth,whisper,mail-dev,scan`. The orphan trap is CLOSED; MAIL-21 step (1) is a re-verify, not a fix. |
| MAIL-14 | **DEV-VERIFIED** (box-direct; EICAR flagged) | Same repo-var caveat (`scan` profile) → B0. Live clamd driven through MAIL-13's path → B2. |
| MAIL-02 | **DEV-VERIFIED** (dev leg) | Created server-only artifacts (scp'd files + ungitted `.env.alertmanager-mail`) — reconciliation → B0 (MAIL-21). Real-relay leg stays §15 R8. |
| MAIL-03 | **DEV-VERIFIED** (dev leg; ex-Q-V6 settled) | Live realm was fixed via `kcadm` ONLY — the repo's compose/realm/`configure-smtp.sh` edits are NOT on the server's ungitted `~/gaiada` copy → B0 (MAIL-21). Real-relay leg stays §15 R6. |
| MAIL-04 | code-complete (PENDING-DEPLOY) — landed **`0077_mail_core.sql`** | Live sink smoke (enqueue → Mailpit API) → B2. `docker inspect` env sweep → B1. |
| MAIL-05 | code-complete (PENDING-DEPLOY) | Live gate probe (gate on the box ⇒ mail in Mailpit w/ deep link) → B2. |
| MAIL-06 | code-complete (PENDING-DEPLOY) — fixed FOUR create sites incl. the F1-missed `search.controller.ts` path; ex-Q-V8 settled | Live decider smoke → B1 (MAIL-09 smoke 1). `payload.href` flip to `/approvals/:id` rides APPR-01 (cross-program). |
| MAIL-13 | code-complete (PENDING-DEPLOY) — Brevo-no-signature + `DownloadToken` findings folded into design v4; 3 corpus-caught defects fixed | Replay script vs the deployed box → B2. Corpus-in-CI proof → B2 (exit #3). Real Brevo fidelity stays §15 R3. |
| MAIL-15 | code-complete (PENDING-DEPLOY) | Live-BFF list/filter/thread walk → B2. Approval-detail thread panel mounts on APPR-01's `/approvals/[id]` when it lands. |
| MAIL-16D | **DEV-VERIFIED** (seam only, by design A14) | Nothing until §15 R7. |
| MAIL-09 | ⛔ **BLOCKED — cannot execute** (no deploy path) | Entire ticket = batch step B1. ex-Q-V7 (OIDC deep-link preservation) stays unsettled until then. |
| MAIL-10 | ⛔ BLOCKED (deps MAIL-09) | Batch step B3. Deliberately NOT built ahead of the wall: it is the program's auth-critical opus ticket, and building it months from verification splits build and verify into two far-apart contexts — the exact waste the opus flag prices in. |
| MAIL-11 | ⛔ BLOCKED (deps MAIL-10) | Batch step B3. SLO leg stays §15 R5 regardless. |
| MAIL-18 | ⛔ BLOCKED as a GATE | Its corpus-side attacks run in-suite today, but the GATE verdict is defined against the deployed box — no partial pass may be claimed. Batch step B4; passing it still closes the dev stage. |
| MAIL-19/20 | **READY (v4 additions)** — the only unblocked lane | Executable now (suites); live replay legs join B2. |
| MAIL-21 | **NEW (v4)** — server-sync consolidation | Batch step B0; see its row below. |

**v3 re-cut summary (owner directive; kept for history — superseded where the v4 summary above
says otherwise):** do not block on anything requiring a real external key.
MAIL-01A/01B (relay/DNS/Brevo) are **retagged STAGING REOPEN** and replaced in dev by **MAIL-00**
— a Mailpit fake-SMTP sink as a compose service **on gda-aicenter** (catches everything, sends
nothing; SMTP egress becomes irrelevant for dev). Inbound (MAIL-13) is dev-driven by a committed
**adversarial fixture corpus** instead of Brevo (design A13 — kept permanently as the regression
suite). Magic links **move up W8 → W6** (dep-free against the sink; the M8 SLO stays a staging
gate, §15 R5). Gmail: dev builds only the seam (**new MAIL-16D**); MAIL-16/17 stay in the staging
window — the program's **highest re-verification risk** (design §8C/A14). New MAIL-00 added;
dropped numbers still not reused.

---

## External gates

**v4 — ONE gate now blocks the dev stage itself:**

- **Q-O4 (design §14) — GitHub Actions billing.** `deploy.yml` consumes cosign-signed images from
  `release.yml`; there is no other deploy path and the box never compiles. Blocks MAIL-09 → 10 →
  11, MAIL-18's gate verdict, exit criterion #3, and ex-Q-V7. Owner action; on restore, run the
  **deferred live-verification batch** (build order below) starting at B0. The architect
  recommends AGAINST an interim unsigned/manual deploy path — it would bypass image signing and
  recreate the drift MAIL-21 exists to clean up.

Provider gates — unchanged, all staging-stage (none block dev):

- ~~Q-O1~~ → **§15 R1** — `gaiada.com` DNS custodian + Workspace relay (opens W-S0 / MAIL-01A).
- ~~Q-O3~~ → **§15 R3/R9** — Brevo signup: failover + inbound + Zone B forms (MAIL-01B). **R3
  re-scoped v4:** no webhook signatures exist at Brevo; token-wall verification + the
  `DownloadToken`→bytes fetch are the real staging steps.
- ~~Q-O2~~ → **§15 R7** — internal-type Google OAuth client (with WD-23A-1 landed, opens W-S2).
- Dev-provable verifies: ex-Q-V6 → MAIL-03 **SETTLED** (realm import does NOT substitute
  `${env.*}`; `configure-smtp.sh` is the fresh-boot path); ex-Q-V8 → MAIL-06 **SETTLED** (no
  `decide` action — `approve` → `company_admin` + `module_approver` ⇒ `agency_approver`);
  ex-Q-V7 → MAIL-09 **still OPEN** (blocked behind Q-O4).

## Standing rules for every ticket

- **Dev evidence comes from gda-aicenter** (owner decision 2026-07-31: local stack OFF, the
  server is truth). Mailpit's HTTP API over the SSH tunnel is the assertion surface — curl'd
  captures, not screenshots.
- **Status language:** PLANNED / IN PROGRESS / PROTOTYPED / DEV-VERIFIED only. Anything verified
  only against Mailpit or fixtures caps at **DEV-VERIFIED**; deliverability, inbox placement, and
  latency-SLO claims stay **UNVERIFIED** until the §15 reopen closes — no AC below claims them.
  Bump `mail` module version + CHANGELOG entry on every ticket that lands.
- **No domain literals (design A12):** every domain/host/link-base is env config; compiled
  defaults use reserved TLDs (`*.gaiada.invalid`); grep gate `rg -n "gaiada\.(com|online)"` over
  `src/mail/`, mail templates, and mail UI (tests/fixtures included) must return **zero** — pinned
  in MAIL-04/05/15 and re-asserted by MAIL-18. Staging swap is `.env` only.
- **Migration numbers — v4 outcome, proving the rule:** the v3 line here ("mail core takes
  `0076`") was written on a ledger stale by SEVEN numbers, and `0076` was then taken mid-session
  by a concurrent session (`0076_core_google_oauth_states.sql`, WD-23A-1). Mail core landed as
  **`0077_mail_core.sql`**; `platform-nest/migrations/README.md` carries the drift record; head
  at v4 writing time is `0078` (the D14 program). Later mail migrations (magic links; the
  staging-stage Gmail CHECK widening) take the then-current next-unused number at their own build
  time. Re-run `ls platform-nest/migrations | sort | tail` at DDL-writing time; **a number in any
  plan doc is a hint, never a fact.**
- **Compose traps (both have bitten this repo):** (1) any new env var must be added to the
  consuming service's `environment:` block in the same ticket, or it ships silently disabled;
  (2) any new profiled service must have its profile added to the GitHub repo variable
  `COMPOSE_PROFILES` in the same change — `deploy.yml` runs `up -d --remove-orphans` and deletes
  project services whose profile isn't in that variable.
- **Wording gate (M12):** any template for origin `automation|agent` must pass the "never implies
  execution" wording test (design §7.4) — pinned in MAIL-05's suite, re-asserted by MAIL-18.
- ⚡ = touches auth/contract/deploy or an internet-facing/client-visible path → QA gate required;
  architect design-review on the diff if a contract or schema changed.

## Tickets — DEV STAGE (zero external dependencies)

Tiers per the agent-army standard; **model = seat default unless flagged** (seniors Sonnet·high,
medior Sonnet·medium, junior Haiku, qa Sonnet·medium, devops Sonnet). **Two Opus flags in the
whole program** (MAIL-10, MAIL-13) — unchanged from v2; everything else is bounded work on
shipped patterns.

| # | Ticket | Tier | Model | Deps | Done when (AC) |
|---|---|---|---|---|---|
| MAIL-00 | **Mailpit dev mail sink on gda-aicenter (replaces MAIL-01A/01B for the dev stage; design §4.3).** `mailpit` service in `infra/compose/docker-compose.vps.yml`: pinned current `axllent/mailpit` release tag; `profiles: [mail-dev]`; SMTP `:1025` internal-only; UI+API published **loopback-only** (`127.0.0.1:8025:8025` — it will hold live password-reset links, never internet-expose it); named volume + `MP_DATABASE=/data/mailpit.db`; healthcheck. **Add `mail-dev` to the GitHub repo var `COMPOSE_PROFILES`** and update deploy.yml's lane comment in the same change (the `--remove-orphans` trap). `.env.example` note. No DNS anywhere. | devops | default | none | Service healthy on gda-aicenter (`docker inspect`); a keyless SMTP probe from inside the stack network (e.g. `curl smtp://mailpit:1025 --mail-from t@dev.gaiada.invalid --mail-rcpt o@dev.gaiada.invalid -T body.txt`) appears in `GET /api/v1/messages` over the SSH tunnel; **survives the next real deploy** (container still present after `deploy.yml` runs — the orphan probe); `ss -tlnp` on the box shows :8025 bound to 127.0.0.1 only; repo var + lane comment updated |
| MAIL-02 | **Alertmanager email live against the sink (D15 second transport, dev shape).** Add `smtp_require_tls: ${SMTP_REQUIRE_TLS}` to `infra/observability/alertmanager/alertmanager.yml` + `SMTP_REQUIRE_TLS` (default `"true"`) to the `&am_env` block — Alertmanager's global default `true` refuses the TLS-less sink, so this one line supersedes v2's "don't edit compose". Server `.env`: `SMTP_SMARTHOST=mailpit:1025`, `SMTP_FROM=alerts@notify.gaiada.invalid`, empty auth, `SMTP_REQUIRE_TLS=false`. The WS9 stack is NOT up on the box: bring up ONLY alertmanager-render + alertmanager as a **separate compose project attached to the stack network** (n8n precedent — separate projects survive `--remove-orphans`); full observability stack stays opt-in. Fire a synthetic alert via the v2 alerts API. | devops | default | MAIL-00 | Rendered config passes `amtool check-config` with ALL receivers present (Telegram/ntfy legs config-valid, not removed); synthetic alert's mail asserted via the Mailpit API (to/subject); the pair survives a platform deploy; `alertmanager.local.yml` untouched. **Cap: DEV-VERIFIED — real relay leg is §15 R8** |
| MAIL-03 | **Keycloak realm SMTP against the sink — REAL auth flows end-to-end.** Live realm `smtpServer` via kcadm/REST (`/idp` prefix): host `mailpit`, port `1025`, from `no-reply@auth.gaiada.invalid`, no auth/TLS; repo realm JSON gains `smtpServer` with `KC_SMTP_*` env placeholders + compose passthrough; settle ex-Q-V6 (does realm import substitute env placeholders? — now dev-provable, fresh-boot path documented either way). Run BOTH flows for a dev user: forgot-password AND verify-email — capture the mail in Mailpit, **click the link through to completion** on the live `erp.gaiada.online/idp` realm. Retirement evidence: create one dev user WITHOUT `emailVerified:true` and verify via the sink. | devops | default | MAIL-00 | Both flows complete end-to-end (Mailpit capture + link click + flow finishes); ex-Q-V6 verdict + fresh-boot path documented; a dev user created without the `emailVerified:true` workaround verifies successfully (the workaround CAN be retired in dev); provisioner itself left unchanged — real-user retirement is §15 R6; no literal secret in git |
| MAIL-04 ⚡ | **Mail core module (`src/mail/`).** Migration `0076_mail_core.sql` *(v4: LANDED as `0077_mail_core.sql` — `0076` was taken mid-session; see the standing rule above)* (design §5 verbatim: `mail_log` w/ entity refs + `reply_token`, `mail_suppressions`, `mail_messages` — GLOBAL per §6.1, no RLS, zero backfill DML, header states why the 0052+ lint is satisfied); `MailProviderAdapter` + `smtp` (per-stream transports, `MAIL_STREAM_*_TRANSPORT=relay\|brevo` operator failover per A8; **TLS rule: `requireTLS` iff creds set, authless plaintext allowed = the sink hop**, design §4.1) + `dev-log`; internal enqueue API; sender worker (chained setTimeout, SKIP LOCKED, backoff, 5-attempt cap, auth-first ordering); suppression enforcement at enqueue + send; delivery-event webhook `POST /api/mail/webhooks/brevo` (token header, idempotent, 204-on-unknown — receives nothing in dev, honest per §7.7); admin log reads `GET /api/admin/mail/log[/:id]` (elevated-only); OTel counters (fail-soft); **A12: every domain/FROM/link-base from config with `*.gaiada.invalid` defaults + new `MAIL_LINK_BASE_URL`**; all `MAIL_*` env in `config.ts` + compose `environment:` + `.env.example`; templates: `approval.warning`, `approval.actionable`, `auth` shell (code, A6); header-injection sanitization | senior-be | default | MAIL-00 (live sink to smoke against; buildable dark before it) | Suite green incl.: 2-concurrent-worker claim sends exactly once; backoff asserted; suppressed ⇒ `suppressed` row, zero adapter calls; webhook idempotent; CRLF stripped; `MAIL_ENABLED=0` ⇒ zero side effects; non-elevated 403 on admin log; migration applies on fresh DB + `lint:migration-rls` clean; **grep gate: zero `gaiada.com`/`gaiada.online` under `src/mail/` incl. tests**; **live smoke on the box: enqueue → message asserted via Mailpit API, authless plaintext hop working**; `docker inspect` shows every `MAIL_*` var; contract file updated |
| MAIL-05 ⚡ | **The approval/risk tap (design §7.2 + §7.4).** `notify()` post-insert `mailIntake()` (fail-soft, test-pinned); allowlist EXACTLY `{approval.requested, pipeline.gate.opened}`; recipient email via `users.email` (one path for staff AND client contacts, M10); wording class by origin: `automation\|agent` → `approval.warning` (**M12 wording test: no approve/reject language, never implies execution**), `pipeline\|hr\|agency` → `approval.actionable`; every mail carries the entity deep link **built from `MAIL_LINK_BASE_URL`** (staff href / portal href per §7.5) and a fresh `reply_token`; no preference surface of any kind | senior-be | default | MAIL-04 | `pipeline.gate.opened` notify() ⇒ exactly one mail_log row w/ that notification id + tenant + entity ref + token; `mention`/`comment`/`approval_decided` ⇒ zero rows (probe); warning-wording test pins the automation/agent template; injected mail failure ⇒ the gate/approval write still 2xx; links are plain entity URLs from config (no token, no action params, no literal domain — asserted); **live probe: trigger a gate on the box ⇒ mail in Mailpit with the correct deep link** |
| MAIL-06 | **Decider notifications on approval creation (F1 fix — in-app substrate + email trigger).** On `automation_approvals` create: `notify()` each member of the resolved decider set — `company_admin`+`group_executive` on the tenant (mirror of `resource_automation_approval.yaml` decide), plus for origin `hr` the providing unit's `hr_manager` (module_manager scoped module='hr'); on `agency_approvals` create (BOTH paths — subject + asset): the mirrored `agency_approval` DECIDE set (**ex-Q-V8 SETTLED at build: the policy has no `decide` action — its decide-equivalent `approve` → `company_admin` + `module_approver` ⇒ concretely `agency_approver`; NOT `group_executive`**); `type='approval.requested'`, payload carries origin + impact + entity href; pipeline gates need nothing (client-notify.ts already emits). **Group-not-individual caveat stands:** this mails the resolved decide SET; single-person routing is §14 Q-V4, deliberately out of scope | senior-be | default | MAIL-05 | Suspended automation write ⇒ one bell notification per decider (self-skip preserved) + one mail_log each; hr-origin includes the hr_manager, other-module managers NOT (probe); agency create ⇒ its decider set notified; non-deciders get nothing (probe); existing approvals + client-notification suites unbroken |
| MAIL-09 ⚡ | **Deploy + live dev smoke (sink evidence).** Ship image w/ migrations to head; all `MAIL_*` on gda-aicenter (verify against the RUNNING container with `docker inspect`, not `/health`); `MAIL_ENABLED=1`; smokes: (1) suspend a test automation write ⇒ decider's **warning** mail in Mailpit, wording matches §7.4; (2) open a client gate on a seeded run ⇒ signer contact's mail in Mailpit w/ portal deep link; (3) **ex-Q-V7 live**: expired-session click of the deep link ⇒ SSO reauth on the real `erp.gaiada.online` ⇒ lands on the entity (evidence walk); (4) `mail_*` OTel counters incremented (test-exporter assertion — the WS9 collector isn't up, so no Prometheus claim); add WS9 alert rules (queue depth, auth-stream failure, failure-rate/transport-flip pager), `promtool check rules` green | devops | default | MAIL-04..06; MAIL-00 | Mailpit API captures (message ids + bodies) attached for smokes 1–2; SSO deep-link walk evidenced; `docker inspect` shows every `MAIL_*` non-empty; `promtool check rules` green (rules FIRING is not claimable until the WS9 stack runs — say so). **Cap: DEV-VERIFIED — real-mail variants are §15 R1/R2** |
| MAIL-10 ⚡ | **Magic links (MOVED UP from v2's W8 — design §9 + v1 §8 mechanics binding).** Migration (next-unused AT BUILD TIME) `auth_magic_links`; `POST /auth/magic-link` (always-202, flattened timing, 3/addr/hr + 10/IP/hr) + `POST /auth/magic-link/consume` (atomic single-use UPDATE…RETURNING); auth-stream templates; platform-ui `/auth/magic` route minting the standard `sealSession` cookie; suppressed-address surfaced; activities audit row; **`MAIL_MAGIC_LINKS_ENABLED` default `0` — dev box may enable for dev users; real-user enablement is §15 R5, NOT this ticket**. Explicit non-goal in code comments + templates: never an approval mechanism (M11) | senior-be | **opus·medium** — auth-critical single-use token semantics + enumeration/timing resistance; a subtle miss is an account-takeover class, and a cheap-first re-run would cost more than starting right | MAIL-09 (deployed stack + working auth stream against the sink) | Live round-trip on the box: request → link captured from Mailpit API → consume → session cookie identical in shape to dev-login's; replayed/expired/unknown tokens return the SAME generic error (test-pinned); 202 body+timing identical for existing vs unknown address; rate limits enforced; DB stores only hashes; grep proves no magic-link URL in any approval/warning template; **no SLO claim anywhere** |
| MAIL-11 | **Magic-link adversarial QA (dev leg).** Attack pass: enumeration (timing + response diffing), replay, parallel double-consume race, token entropy/log-leak sweep, rate-limit bypass, suppressed-address path. **The M8 SLO leg is explicitly OUT of this ticket** — it needs ≥7 days of real relay traffic (§15 R5) and is deferred whole, not approximated against the sink | qa | default | MAIL-10 | Written evidence per attack; double-consume race loses deterministically; zero critical findings open (failures become tickets); the report's status section states the SLO leg is deferred to §15 R5 verbatim |
| MAIL-13 ⚡ | **Inbound system-mail threads (C1; design §7.6) — fixture-corpus-driven, no provider needed.** `POST /api/mail/inbound/brevo`: webhook auth per design §7.6 **v4** — Brevo offers NO webhook signatures (token header / URL basic-auth / custom headers only), so the `MAIL_INBOUND_TOKEN` header wall (constant-time, fail-closed when unset) IS the provider-documented scheme; PLUS the optional HMAC layer that is **OURS, defence-in-depth** (`MAIL_INBOUND_SIGNING_KEY`, raw bytes, timestamp-bound; required once configured; dev-verified against self-generated signatures — **§15 R3 as re-scoped v4**); VERP `reply+<token>@` → `mail_log.reply_token` match (token is the ONLY match; `from_email` display-only); `mail_messages` insert w/ `(provider, provider_message_id)` idempotency; size caps; server-side HTML allowlist sanitization at intake (raw MIME never stored); attachments → quarantine + scan-status gate (consumes MAIL-14); unmatched token ⇒ count+log+204 (A9); NDR classification (fixture NDR; real format is §15 R4); thread reads `GET /api/admin/mail/log/:id/thread` + entity-scoped `GET /api/:t/mail/threads` authorized via the PARENT entity (A10); per-source rate limit. **Committed adversarial corpus** (`src/mail/__fixtures__/inbound/` — full case list in design §7.6: forged sender, wrong/absent/unknown token, replayed id, oversized body, oversized/many attachments, script/CSS/tracker HTML, encoding attacks, quoted-reply bloat, NDR) + replay script `npm run mail:replay-inbound -- --base <url>`; **corpus wired into CI permanently (A13)** | senior-be | **opus·medium** — an internet-facing untrusted-input pipeline whose failure mode is forged/hostile content rendered on decision surfaces; sanitization + auth + idempotency must be right the first time | MAIL-04; MAIL-14 (scan hook; stub allowed until W0 lands it) | Every corpus case has a pinned test: forged-signature and missing-token posts rejected (401/403), valid post threads onto the right entity; replayed id ⇒ single row; XSS corpus inert **as stored content**, not just at render; oversize rejected at cap; thread read 403s exactly like the parent entity; EICAR ⇒ `infected`, download blocked; unmatched ⇒ 204 + counter; **replay script run against the deployed box with `mail_messages` rows + thread render as evidence**; corpus in CI; contract file updated |
| MAIL-14 | **ClamAV scan service (FIRST actual instantiation in the estate — until now it existed only as the webdesk-blueprint pattern).** `clamav/clamd` container in the vps compose under its **own `scan` profile** (NOT `mail-dev` — real inbound at staging still needs scanning after the sink retires, §4.3) + `scan` added to the `COMPOSE_PROFILES` repo var (same orphan trap as MAIL-00); freshclam persistence; scan client in platform (env-gated `MAIL_INBOUND_SCAN=clamav`, fail-closed for attachment exposure: unscannable ⇒ stays quarantined); runbook note: webdesk C-02 upload scanning later reuses this service | devops | default | none (parallel-safe) | Profile up on the box ⇒ EICAR flagged via the scan client; scanning off ⇒ attachments admin-only; service absent ⇒ platform boots fine (fail-soft boot, fail-closed exposure); healthcheck wired; survives a deploy (repo var updated) |
| MAIL-15 | **Mail surface UI (`/admin/mail` + entity thread panels).** Admin log list (filters: stream/status/tenant/entity/date; status chips render "accepted ≠ delivered" honestly — in dev everything caps at `sent`, which the chips make legible) + detail (event timeline, thread); triggering entity as deep link; thread panel component consumed by approval detail + run workspace + portal run view (portal via the portal BFF, same entity-authorized read); inbound messages carry the "Email reply — sender unverified" banner; DEMO_MODE fixtures (reserved-TLD addresses per A12); degrade cleanly when endpoints absent | medior | default | MAIL-04 (log reads); MAIL-13 (thread reads — panel may land behind its absence-degrade) | Log renders/filters/paginates against the live BFF on the box (corpus-fed threads visible); entity deep links navigate; banner present; DEMO_MODE backend-free; `tsc` + unit + `next build` green; grep gate holds for UI code; a11y basics per existing admin-page patterns |
| MAIL-16D | **`GmailClient` seam + fixture implementation (the ONLY Gmail work in dev — design §8C/A14).** Interface: `listThreads(pageToken?)`, `getThread(id)`, `getMessage(id)` (decoded parts + attachment metadata), `listLabels()`; error taxonomy (unauthorized/revoked, rate-limited w/ retry-after, not-found). Fixture-backed impl + committed thread fixtures; **provider-agnostic contract-test suite that the staging live adapter must pass unmodified**. NO link flow, NO UI, NO migration (the provider-CHECK widening ships with MAIL-16 at staging). README states plainly that thread/label/pagination semantics are UNVERIFIED against the real API (§15 R7) | medior | default | none (design §8C binding) | Interface + fixture impl + contract suite green in CI; suite written so the live adapter can run it unmodified; zero persistence of message content anywhere (M14 pre-enforced in the fixture impl); README honesty note present |
| MAIL-18 ⚡ | **Inbound + approval-link adversarial QA gate — THE dev-stage exit gate.** Attack pass against MAIL-05/13/15 using the corpus + live box: forged inbound webhook (bad/absent signature+token), replayed provider ids, oversized bodies/attachments, XSS corpus end-to-end (intake → store → render on approval detail + portal), spoofed `From:` vs token mismatch, reply-token brute-force (entropy + rate limit), EICAR; **link-security audit:** approval/warning mails contain zero action affordances + zero tokens, deep links land behind SSO (expired-session walk re-run), warning wording never implies execution (M12 re-assert on rendered output); suppression + fixture-NDR paths; **grep gate re-assert (A12)** | qa | default | MAIL-13 + MAIL-15 landed | Written evidence per attack (what was tried, what happened); zero critical findings open — failures become tickets, not ad-hoc fixes; wording + no-action-affordance audit signed off explicitly; **this gate passing (with MAIL-11's dev leg) = the dev stage is closed** |

## Tickets — v4 additions (2026-08-05; no Opus flags — the program total stays two)

| # | Ticket | Tier | Model | Deps | Done when (AC) |
|---|---|---|---|---|---|
| MAIL-19 | **Quoted-history intake cap shape (design A15.1 / §7.6 v4).** `sanitizeInboundText` keeps **head + tail** of an over-cap plain-text body (~¾ head / ¼ tail of the budget) with an explicit `[truncated at intake: N characters omitted here]` marker at the elision point — heuristic-free; intake still "caps and records, never interprets"; NO quote-boundary detection at intake, NO schema change. `body_html_sanitized` stays head-capped (never splice HTML mid-document — the rebuilt-balanced-tags guarantee). `truncatedChars` accounting preserved. **New corpus cases:** bottom-posted reply under an over-cap quote (THE regression case — the reply text must survive in stored `body_text`), top-posted over-cap equivalent, elision-marker spoof (sender embeds our marker text — must store inertly, never confuse accounting). Replay script picks the new cases up automatically | senior-be | default | none (executable NOW — code + suites; live replay leg joins batch B2) | New corpus cases pinned green; bottom-posted reply text asserted PRESENT in stored `body_text` on an over-cap body; full `src/mail` suite (135+) green; no schema change; A12 grep gate holds; fixture `12-quoted-reply-bloat` expectation text updated to A15 wording |
| MAIL-20 | **Quote-collapse at render (design A15.2).** Shared boundary detector (text: `On … wrote:` / `>`-prefixed runs / `-----Original Message-----` / Outlook `From:…Sent:…` blocks; sanitized HTML: `blockquote` / `gmail_quote`) collapsing everything below the FIRST boundary behind "Show quoted history" in `MailThreadPanel` + the admin mail detail; **computed at render, never stored** (heuristics improve retroactively; a misfire costs a click, never data); fail-safe: no boundary ⇒ full body shown; the MAIL-19 elision marker renders as plain visible text | medior | default | MAIL-19 (marker semantics settled); MAIL-15 (panel exists) | Detector unit-tested against fixtures incl. no-boundary, interleaved-reply, and marker-spoof cases; panel renders reply-first with a keyboard-operable expander; collapsed state never hides the intake-truncation marker; `tsc` + unit suite + `next build` green; DEMO_MODE fixtures gain one collapsed-thread example |
| MAIL-21 | **Server-sync consolidation — the drift ledger, one shot (batch B0; MUST run before the first post-billing deploy).** (1) **FIRST**: **re-verify** the GitHub repo var `COMPOSE_PROFILES` still reads `bot,auth,whisper,mail-dev,scan`. It was permission-denied when MAIL-00's agent tried, but the **orchestrator set it in-session on 2026-08-04** and read it back — so the `--remove-orphans` trap is already closed. Re-verify rather than re-apply, because concurrent sessions edit this var and a regression here silently DELETES mailpit + clamav on the first `deploy.yml` run. (2) Reconcile the server's ungitted `~/gaiada` copy with the repo: MAIL-03's realm-JSON/`configure-smtp.sh`/compose `KC_SMTP_*` edits (the live realm was fixed via `kcadm` only — DB-persisted, so behavior is fine, but a fresh boot from the server copy would regress); MAIL-02's scp'd alertmanager files + the server-only ungitted `.env.alertmanager-mail` (keep — correct pattern — but diff contents against the repo template and record it in `CREDENTIALS.local.md`). (3) Verify nothing else on the box depends on an artifact a fresh deploy would not reproduce (compare running containers' mounts/env against the repo compose files) | devops | default | ⛔ Q-O4 (billing restored); blocks MAIL-09 | `gh api` read-back shows `mail-dev,scan` in `COMPOSE_PROFILES`; a deploy-shaped `up -d --remove-orphans` leaves mailpit/clamav/the alertmanager pair running; server↔repo diff for the touched files is clean or every divergence is recorded; runbook note updated |

**Cross-program dependency recorded (not a mail ticket):** **APPR-01** — owner-approved
`/approvals/[id]` per-item route, in flight outside this program. Mail-side stakes (design §7.5
v4): the fix must land on BOTH halves — the UI route AND the backend-emitted `payload.href` on
`approval.requested` (MAIL-06's four call sites emit `href:"/approvals"` today; MAIL-05's tap
only absolutises what it is handed) — and it provides the mount point for MAIL-15's deferred
approval-detail thread panel. The B1 deploy smoke asserts the emailed deep link lands on the
per-item page once APPR-01 is live.

## Tickets — STAGING REOPEN (execute design §15 top to bottom; regains v2 content verbatim)

| # | Ticket | Tier | Model | Deps | Done when (AC) |
|---|---|---|---|---|---|
| MAIL-01A ⛔ | **STAGING REOPEN — Workspace relay + DNS identity (§15 R1/R2).** Content verbatim v2: custodian (ex-Q-O1) → relay enable/auth mode → subdomain SPF (both includes) + per-subdomain `_dmarc` → root `_dmarc` `sp=` check → subdomain-envelope verdict (M2 fallback) → per-stream test sends → DKIM alignment on a real header → 20-send latency sample. **MUST NOT touch root MX or root SPF.** | devops | default | owner: DNS custodian; staging window | v2 AC verbatim (headers pass SPF/DKIM/DMARC; root records byte-identical; auth mode + caps + envelope verdict in runbook; latency recorded) + real-inbox deliverability evidence (R2) |
| MAIL-01B ⛔ | **STAGING REOPEN — Brevo failover + inbound + forms identity (§15 R3/R9).** Content verbatim v2: signup (ex-Q-O3), per-role keys, inbound parsing + signature scheme verification (ex-Q-V2; IMAP-poll fallback decision if unavailable), MX on the notify subdomain, forms identity on `gaiada.online`; custody per design §12. PLUS the R3 corpus work: capture ≥10 real payloads, diff + APPEND to the fixture corpus (A13), verify signatures for real, flip the failover transport once | devops | default | owner: Brevo signup; MAIL-01A | v2 AC verbatim + corpus appended + real-signature verification evidenced + failover flip evidenced |
| MAIL-16 ⚡ | **STAGING — staff Gmail live integration (design §8C, M14 binding; §15 R7 — highest re-verification risk in the program).** Content verbatim v2 (internal-type client, WD-23A-1's `google_oauth_states` LANDED — hard gate, never build a second state machine; provider-CHECK widening migration at build-time next-unused; link/revoke per the Drive precedent; render-on-demand proxy, staff-only, zero persistence) **plus: the live adapter must pass MAIL-16D's contract suite unmodified** | senior-be | default | §15 R7 prerequisites (Q-O2 client, WD-23A-1, staging keys); MAIL-16D | v2 AC verbatim + MAIL-16D suite green against the live adapter + ex-Q-V5 findings recorded in the design doc |
| MAIL-17 | **STAGING — Gmail reading pane UI.** Content verbatim v2, built against the LIVE adapter (A14: UI waits for real thread/label semantics — that is the point of deferring it) | medior | default | MAIL-16 | v2 AC verbatim on staging with real keys |
| MAIL-12 | **Webdesk C-02/C-03 adapter handoff (PARKED — webdesk is `0.0.0 PLANNED`).** Verbatim v2 | medior | default | webdesk P2 exists; MAIL-04; §15 R9 | v2 AC verbatim |

## Build order

```
DEV STAGE — v4 actual state (v3's W0–W7 shown with what happened to them)
W0  MAIL-00 ∥ MAIL-14       DONE — DEV-VERIFIED box-direct (⚠ COMPOSE_PROFILES repo var unfixed → B0)
W1  MAIL-02 ∥ MAIL-03       DONE — DEV-VERIFIED dev legs (server-only fixes → drift ledger → B0)
W2  MAIL-04                 DONE — code-complete, landed as 0077 (live sink smoke → B2)
W3  MAIL-05 ∥ MAIL-13       DONE — code-complete (live probe / replay-vs-box → B2)
W4  MAIL-06 ∥ MAIL-15       DONE — code-complete (live smoke → B1/B2; approval panel ← APPR-01)
W4b MAIL-19 → MAIL-20       NEW (v4, quoted-history A15) — the ONLY unblocked lane; run it now
W5  MAIL-16D                DONE — DEV-VERIFIED (seam only). Its W5 partner MAIL-09 hit the wall ↓

════ THE BILLING WALL (Q-O4) — GitHub Actions billing; the only deploy path; nothing below
     can run until it falls. v3's W5(deploy)–W7 do NOT proceed; do not re-order around it. ════

DEFERRED LIVE-VERIFICATION BATCH (run in THIS order the day billing returns; 1–2 agent cap holds)
B0  MAIL-21                 COMPOSE_PROFILES fix FIRST (else the deploy deletes mailpit+clamav),
                            then the repo↔server reconciliation — B0 strictly precedes B1
B1  MAIL-09                 deploy 0077→head + every MAIL_* var (docker inspect, not /health) +
                            smokes 1–4 (incl. ex-Q-V7 OIDC deep-link walk; APPR-01 landing if live)
B2  live legs, batched      MAIL-04 sink smoke · MAIL-05 gate probe · MAIL-13 replay-vs-box ·
                            MAIL-15 live-BFF walk · MAIL-19 replay cases · corpus-in-CI proof (exit #3)
B3  MAIL-10 → MAIL-11       magic links (built AFTER the wall falls — deliberate, see Execution state)
B4  MAIL-18                 the adversarial exit gate — passing it CLOSES the dev stage

STAGING REOPEN (unchanged; begins where dev ends; execute design §15 in order, R3 as re-scoped v4)
W-S0  MAIL-01A → MAIL-01B   (⛔ DNS custodian / Brevo signup — the real provider wave)
W-S1  §15 R1–R4, R6, R8 re-runs (creds swaps + re-verification; devops + qa)
W-S2  MAIL-16 → MAIL-17     (⛔ internal OAuth client + WD-23A-1 landed)
W-S3  §15 R5: ≥7-day SLO window → owner quality gate → MAIL_MAGIC_LINKS_ENABLED=1
W-S∞  MAIL-12               (parked until webdesk P2 exists; R9)
```

**Human gates:** the owner reviews rendered mail quality (wording, links, layout) in Mailpit after
**B1** — the sink makes this a 10-minute browse instead of an inbox hunt (v4: was "after W5";
moved with the deploy it depends on). The M12 flip (automation/agent wording → actionable)
remains **not a ticket in this program** — gated on the **D14 resume-path program COMPLETING**
(now real and executing: `docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md`, first
migration `0078` landed); still a one-constant change + architect design-review when its
prerequisite lands (design §7.4 v4).

## Dev-stage exit criteria ("the dev stage is finished" means ALL of these)

> **v5 UPDATE — 2026-08-05: THE BILLING WALL IS GONE.** The repo was made public, so Actions
> minutes are free and the pipeline works. What changed, verified rather than assumed:
>
> - **Criterion 3 is CLOSED.** CI is green on `main` (run `30989473747`, all 8 jobs) with the step
>   `Mail inbound adversarial corpus (A13 — permanent regression gate) → success`. The corpus now
>   demonstrably runs in CI. `ci.yml`'s `push`/`pull_request` triggers were re-enabled (MAIL-21)
>   after confirming that workflow reads no secrets — necessary because a public repo would
>   otherwise expose them to fork PRs.
> - **The whole module is committed** (`d2ba24c`, 112 files, ~10.9k insertions). It had been
>   **untracked**, so a deploy would have shipped nothing and CI could not see it. An agent
>   reporting "committed" does not make it so — the lesson is to check `git status`, which is how
>   MAIL-21 caught it.
> - **MAIL-18's in-suite gate PASSED** with zero open critical findings: 144/144 `src/mail`,
>   17/17 mail UI, XSS proven inert *as stored bytes* read back from Postgres, the unmatched-vs-matched
>   inbound response proven byte-identical (not a token oracle), EICAR refused at every privilege
>   including global admin, and M12 wording re-asserted on rendered output. Its **box-deployed**
>   legs remain PENDING-DEPLOY. One informational, non-exploitable finding recorded: inbound timing
>   differs between the unmatched fast-fail and a matched attachment path; response bodies are
>   identical as required, and 128-bit token entropy makes the side-channel impractical.
> - **MAIL-22 (new): the mail tables now carry FORCE RLS.** "Global, no RLS" made mail the first
>   FORCE-RLS violation in the estate and broke `src/db/rls.test.ts`. Fixed with `0015`'s GUC-gate
>   pattern; `rls.test.ts` passes **unmodified**. See the superseding note in design §6.1.
> - **MAIL-23 (new): a decider drift-guard** reads both Cerbos policies at test time and fails when
>   a decider role changes, without tripping on D14's `retry` addition. The mirror was verified
>   still accurate — D14 added an action, not new deciders.
> - **Migration reality:** mail core is `0077`, not `0076`. The ledger moved **three times** in one
>   session (`0077` mail → `0078` D14 → `0079` assistant). Re-verify immediately before writing DDL.
> - **Released:** `Alpha 01.017.0040a` is tagged and building through `release.yml` — the first
>   properly signed release since the hand-built `0037`, which had no cosign signature or SBOM and
>   existed only on the box rather than GHCR.
>
> **What still blocks closure** is no longer billing but simply that the deploy had not yet landed
> when this was written: MAIL-09's live smokes, MAIL-18's box verdict, and MAIL-10/11.

**v4 headline (superseded — retained for the record): the dev stage CANNOT close while the billing
wall stands.** Criteria 1–3 are structurally blocked (marked ⛔ below); 4–6 hold today. No amount of
suite-green work substitutes for the blocked evidence, and nothing may be promoted to DEV-VERIFIED
on local suites alone (design §13 v4).

1. Every dev-wave ticket — MAIL-00, 02, 03, 04, 05, 06, 09, 10, 11(dev leg), 13, 14, 15, 16D,
   **+ v4: 19, 20, 21** — is **DEV-VERIFIED** with evidence from gda-aicenter runs (Mailpit API
   captures, suite output, the deploy pipeline having applied `0077`).
   **v4 state: ⛔ partially blocked.** DEV-VERIFIED today: 00, 02, 03, 14, 16D (box-direct or
   seam-only — their evidence never needed the pipeline). Code-complete-but-unverifiable
   (PENDING-DEPLOY, batch B1/B2): 04, 05, 06, 13, 15 (+ 19/20 once built). Cannot execute at
   all: 09 (B1), 10/11 (B3), 21 (B0).

   **v6 state — 2026-08-07. B0 and B1 are CLOSED; B2 is IN PROGRESS.**
   - **B1/MAIL-09 CLOSED with live evidence.** The `MAIL_*` sweep was taken from the *running
     container* (`docker exec … ${#VAR}`), not `/health` and not `.env`: every declared var
     arrives, and every empty one is empty by design (Brevo unconfigured, authless sink) rather
     than dropped by compose. Smokes 1–4 pass. **ex-Q-V7 is SETTLED** — an unauthenticated deep
     link walked `307 → /login?return=…` → Keycloak+PKCE → credential POST → callback →
     `307` to the *exact* entity → `200`, so reauth provably preserves the target.
     `mail_*` OTel counters were observed incrementing on a real send
     (`mail_enqueued_total{stream="auth"}`, `mail_sent_total`, `mail_send_duration_ms`).
   - **The version premise elsewhere in this plan is stale.** The box now runs
     `alpha-01.027.0070a` = repo head, migrations applied through `0086`. There is no deploy gap.
   - **Prerequisite that made B2 possible at all:** NET-01's nginx `/api/mail/` route was applied
     2026-08-07 (`307 → 401`); before that, no inbound replay could reach platform-nest.
   - **Two caveats, deliberately not rounded up:** smokes 1–2 were re-verified against live
     Mailpit content rather than re-triggered (re-firing would have created duplicate
     approval rows on a shared box), and the `mail_*` metrics were read from the collector's raw
     scrape, not proven through a dashboard or a firing alert — the full WS9 stack is still down.
2. **MAIL-18 and MAIL-11 (dev leg) both passed** with zero open critical findings.
   **v4 state: ⛔ blocked** — B3/B4; MAIL-18's corpus attacks run in-suite today but the gate
   verdict is defined against the deployed box; no partial pass may be claimed.
3. The inbound fixture corpus is committed and running in CI (permanent, A13).
   **v4 state: ⛔ committed and wired (`npm run test:mail-corpus`, a named fail-fast step) but
   UNPROVABLE while GitHub Actions is billing-blocked — stays OPEN until a real CI run shows it
   (batch B2).** The corpus itself already earned its keep pre-CI: three type-check-invisible
   defects caught and fixed (design §7.6 v4).
4. The A12 grep gate holds: zero `gaiada.com`/`gaiada.online` literals in mail code/templates/UI.
   **v4 state: HOLDS** (asserted in-suite by `src/mail/grep-gate.test.ts` + per-ticket re-runs).
5. Design **§15** is fully populated — every row's dev substitute is DEV-VERIFIED, every staging
   column untouched; MODULES.md/CHANGELOG carry the §13 status caveat verbatim (no
   deliverability/SLO/Gmail claims anywhere). **v4 state: HOLDS as populated (R3 re-scoped);
   substitute-verification tracking follows criterion 1.**
6. Magic links and the `emailVerified:true` retirement remain OFF **for real users**.
   **v6 AMENDMENT — 2026-08-07, owner decision.** This criterion previously read
   "`MAIL_MAGIC_LINKS_ENABLED=0`" flatly, which is now wrong in two ways: MAIL-10 **is** built
   (`platform-nest/src/mail/magic-link/{controller,service,tokens,rate-limit}.ts` + MAIL-11's
   `qa-mail11-adversarial.test.ts`, landed via MAIL-26/35/37), and the flag is **`=1` on
   gda-aicenter** so that B3 can exercise it at all — verification is impossible with the feature
   off, and shipping MAIL-10/11 to staging never having been run live is the worse trade.
   The criterion is therefore scoped to where it was always aimed: **staging and production**,
   where the W-S3 gate is unchanged (≥7-day SLO window → owner quality gate → flip to 1).
   Dev posture, measured rather than assumed on 2026-08-07: the endpoint is **not internet-routed**
   (nginx proxies only `/api/mail/`, so `POST /api/auth/magic-link` 307s into platform-ui and never
   reaches platform-nest), it sits behind `ServiceGuard` + an internal token, and
   `auth_magic_links` held exactly **1** row — a deliberate test send. No real user has been issued
   a magic link. The provisioner remains unchanged, so the `emailVerified:true` half still HOLDS
   as originally written.

The staging stage then **begins at W-S0 with design §15 as the handover document** — nothing else
needs to be re-derived.

## What this plan deliberately does NOT do

- **No real DNS/relay/Brevo/Google work in dev** — all of it is §15 reopen content (M15); and no
  fake "delivered" statuses against the sink (rows cap at `sent`, rendered honestly).
- **No email digest, no per-user channel prefs, no general notification mirroring** (v2 cut; the
  WA/Telegram 12:00/18:00 group rollup is the bot's job).
- No approve-by-reply, no action buttons in mail, no magic links in approval mail (M11).
- No D14 resume path (prerequisite tracked elsewhere; this program only pre-stages the wording flip).
- No new risk classifier (attaches to the WS4 impact gate as-is).
- No mailbox hosting / IMAP server of ours; no send-as-employee; no DWD; no mail-content caching (M13/M14).
- No DB-stored templates for Zone A; no BullMQ/Redis dependency; no migration-number reservations.
- No dev-built Gmail link flow or reading-pane UI (A14 — the seam only; the wave is staging's).
- **v4: no interim manual/unsigned deploy path around the billing wall** — it would bypass image
  signing and recreate the repo↔server drift MAIL-21 exists to clean up. The wall falls when
  billing is restored (Q-O4, owner action), not by working around it.
- **v4: no intake-side quote stripping, ever** (A15.3) — the head+tail cap + render collapse is
  the whole quoted-history mechanism; "store only the extracted reply" is rejected, not deferred.
