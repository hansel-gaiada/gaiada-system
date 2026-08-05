# Mail Subsystem — Ticket Plan **v3** (dev stage with zero external keys → staging reopen)

**Status:** READY for /army — **nothing external blocks the dev stage** (M15) ·
**Date:** 2026-08-04 (v3 re-cut, same day as v1/v2) · **Architect:** system-architect (Fable·max)
**Design (binding):** `docs/superpowers/specs/2026-08-04-zone-a-mail-design.md` **v3** — implementers
do NOT re-derive decisions M1–M15 / A1–A14; deviations require an architect design-review.
**Staging handover:** design **§15 Staging Reopen Register** — the single authoritative list of
what dev simulated and what staging must re-verify. Q-V1–Q-V9 are folded into it (ONE list).
**Contract:** `docs/FRONTEND-BFF-CONTRACT.md` (update in every BE ticket that adds/changes an endpoint).

**v3 re-cut summary (owner directive):** do not block on anything requiring a real external key.
MAIL-01A/01B (relay/DNS/Brevo) are **retagged STAGING REOPEN** and replaced in dev by **MAIL-00**
— a Mailpit fake-SMTP sink as a compose service **on gda-aicenter** (catches everything, sends
nothing; SMTP egress becomes irrelevant for dev). Inbound (MAIL-13) is dev-driven by a committed
**adversarial fixture corpus** instead of Brevo (design A13 — kept permanently as the regression
suite). Magic links **move up W8 → W6** (dep-free against the sink; the M8 SLO stays a staging
gate, §15 R5). Gmail: dev builds only the seam (**new MAIL-16D**); MAIL-16/17 stay in the staging
window — the program's **highest re-verification risk** (design §8C/A14). New MAIL-00 added;
dropped numbers still not reused.

---

## External gates — ALL moved to the staging stage (none block dev)

- ~~Q-O1~~ → **§15 R1** — `gaiada.com` DNS custodian + Workspace relay (opens W-S0 / MAIL-01A).
- ~~Q-O3~~ → **§15 R3/R9** — Brevo signup: failover + inbound + Zone B forms (MAIL-01B).
- ~~Q-O2~~ → **§15 R7** — internal-type Google OAuth client (with WD-23A-1 landed, opens W-S2).
- Dev-provable verifies are pinned in dev ACs, not gated: ex-Q-V6 → MAIL-03, ex-Q-V7 → MAIL-09,
  ex-Q-V8 → MAIL-06.

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
- **Migration numbers:** design §5 re-verified for v3 — head `0075`, `0071` landed since v2,
  `0058`/`0059`/`0070` claimed/dead (0070 = the staged WD-23A-1 file) ⇒ mail core takes **`0076`**.
  Later mail migrations (magic links; the staging-stage Gmail CHECK widening) take the
  then-current next-unused number at their own build time. Re-run
  `ls platform-nest/migrations | sort | tail` at DDL-writing time; a number here is a hint, not a fact.
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
| MAIL-04 ⚡ | **Mail core module (`src/mail/`).** Migration `0076_mail_core.sql` (design §5 verbatim: `mail_log` w/ entity refs + `reply_token`, `mail_suppressions`, `mail_messages` — GLOBAL per §6.1, no RLS, zero backfill DML, header states why the 0052+ lint is satisfied); `MailProviderAdapter` + `smtp` (per-stream transports, `MAIL_STREAM_*_TRANSPORT=relay\|brevo` operator failover per A8; **TLS rule: `requireTLS` iff creds set, authless plaintext allowed = the sink hop**, design §4.1) + `dev-log`; internal enqueue API; sender worker (chained setTimeout, SKIP LOCKED, backoff, 5-attempt cap, auth-first ordering); suppression enforcement at enqueue + send; delivery-event webhook `POST /api/mail/webhooks/brevo` (token header, idempotent, 204-on-unknown — receives nothing in dev, honest per §7.7); admin log reads `GET /api/admin/mail/log[/:id]` (elevated-only); OTel counters (fail-soft); **A12: every domain/FROM/link-base from config with `*.gaiada.invalid` defaults + new `MAIL_LINK_BASE_URL`**; all `MAIL_*` env in `config.ts` + compose `environment:` + `.env.example`; templates: `approval.warning`, `approval.actionable`, `auth` shell (code, A6); header-injection sanitization | senior-be | default | MAIL-00 (live sink to smoke against; buildable dark before it) | Suite green incl.: 2-concurrent-worker claim sends exactly once; backoff asserted; suppressed ⇒ `suppressed` row, zero adapter calls; webhook idempotent; CRLF stripped; `MAIL_ENABLED=0` ⇒ zero side effects; non-elevated 403 on admin log; migration applies on fresh DB + `lint:migration-rls` clean; **grep gate: zero `gaiada.com`/`gaiada.online` under `src/mail/` incl. tests**; **live smoke on the box: enqueue → message asserted via Mailpit API, authless plaintext hop working**; `docker inspect` shows every `MAIL_*` var; contract file updated |
| MAIL-05 ⚡ | **The approval/risk tap (design §7.2 + §7.4).** `notify()` post-insert `mailIntake()` (fail-soft, test-pinned); allowlist EXACTLY `{approval.requested, pipeline.gate.opened}`; recipient email via `users.email` (one path for staff AND client contacts, M10); wording class by origin: `automation\|agent` → `approval.warning` (**M12 wording test: no approve/reject language, never implies execution**), `pipeline\|hr\|agency` → `approval.actionable`; every mail carries the entity deep link **built from `MAIL_LINK_BASE_URL`** (staff href / portal href per §7.5) and a fresh `reply_token`; no preference surface of any kind | senior-be | default | MAIL-04 | `pipeline.gate.opened` notify() ⇒ exactly one mail_log row w/ that notification id + tenant + entity ref + token; `mention`/`comment`/`approval_decided` ⇒ zero rows (probe); warning-wording test pins the automation/agent template; injected mail failure ⇒ the gate/approval write still 2xx; links are plain entity URLs from config (no token, no action params, no literal domain — asserted); **live probe: trigger a gate on the box ⇒ mail in Mailpit with the correct deep link** |
| MAIL-06 | **Decider notifications on approval creation (F1 fix — in-app substrate + email trigger).** On `automation_approvals` create: `notify()` each member of the resolved decider set — `company_admin`+`group_executive` on the tenant (mirror of `resource_automation_approval.yaml` decide), plus for origin `hr` the providing unit's `hr_manager` (module_manager scoped module='hr'); on `agency_approvals` create (BOTH paths — subject + asset): the mirrored `agency_approval` DECIDE set (**ex-Q-V8: read the policy file first — it's in-repo, dev-provable**); `type='approval.requested'`, payload carries origin + impact + entity href; pipeline gates need nothing (client-notify.ts already emits). **Group-not-individual caveat stands:** this mails the resolved decide SET; single-person routing is §14 Q-V4, deliberately out of scope | senior-be | default | MAIL-05 | Suspended automation write ⇒ one bell notification per decider (self-skip preserved) + one mail_log each; hr-origin includes the hr_manager, other-module managers NOT (probe); agency create ⇒ its decider set notified; non-deciders get nothing (probe); existing approvals + client-notification suites unbroken |
| MAIL-09 ⚡ | **Deploy + live dev smoke (sink evidence).** Ship image w/ migrations to head; all `MAIL_*` on gda-aicenter (verify against the RUNNING container with `docker inspect`, not `/health`); `MAIL_ENABLED=1`; smokes: (1) suspend a test automation write ⇒ decider's **warning** mail in Mailpit, wording matches §7.4; (2) open a client gate on a seeded run ⇒ signer contact's mail in Mailpit w/ portal deep link; (3) **ex-Q-V7 live**: expired-session click of the deep link ⇒ SSO reauth on the real `erp.gaiada.online` ⇒ lands on the entity (evidence walk); (4) `mail_*` OTel counters incremented (test-exporter assertion — the WS9 collector isn't up, so no Prometheus claim); add WS9 alert rules (queue depth, auth-stream failure, failure-rate/transport-flip pager), `promtool check rules` green | devops | default | MAIL-04..06; MAIL-00 | Mailpit API captures (message ids + bodies) attached for smokes 1–2; SSO deep-link walk evidenced; `docker inspect` shows every `MAIL_*` non-empty; `promtool check rules` green (rules FIRING is not claimable until the WS9 stack runs — say so). **Cap: DEV-VERIFIED — real-mail variants are §15 R1/R2** |
| MAIL-10 ⚡ | **Magic links (MOVED UP from v2's W8 — design §9 + v1 §8 mechanics binding).** Migration (next-unused AT BUILD TIME) `auth_magic_links`; `POST /auth/magic-link` (always-202, flattened timing, 3/addr/hr + 10/IP/hr) + `POST /auth/magic-link/consume` (atomic single-use UPDATE…RETURNING); auth-stream templates; platform-ui `/auth/magic` route minting the standard `sealSession` cookie; suppressed-address surfaced; activities audit row; **`MAIL_MAGIC_LINKS_ENABLED` default `0` — dev box may enable for dev users; real-user enablement is §15 R5, NOT this ticket**. Explicit non-goal in code comments + templates: never an approval mechanism (M11) | senior-be | **opus·medium** — auth-critical single-use token semantics + enumeration/timing resistance; a subtle miss is an account-takeover class, and a cheap-first re-run would cost more than starting right | MAIL-09 (deployed stack + working auth stream against the sink) | Live round-trip on the box: request → link captured from Mailpit API → consume → session cookie identical in shape to dev-login's; replayed/expired/unknown tokens return the SAME generic error (test-pinned); 202 body+timing identical for existing vs unknown address; rate limits enforced; DB stores only hashes; grep proves no magic-link URL in any approval/warning template; **no SLO claim anywhere** |
| MAIL-11 | **Magic-link adversarial QA (dev leg).** Attack pass: enumeration (timing + response diffing), replay, parallel double-consume race, token entropy/log-leak sweep, rate-limit bypass, suppressed-address path. **The M8 SLO leg is explicitly OUT of this ticket** — it needs ≥7 days of real relay traffic (§15 R5) and is deferred whole, not approximated against the sink | qa | default | MAIL-10 | Written evidence per attack; double-consume race loses deterministically; zero critical findings open (failures become tickets); the report's status section states the SLO leg is deferred to §15 R5 verbatim |
| MAIL-13 ⚡ | **Inbound system-mail threads (C1; design §7.6) — fixture-corpus-driven, no provider needed.** `POST /api/mail/inbound/brevo`: signature verification implemented to Brevo's documented scheme (**dev-verified against self-generated fixture signatures; real-scheme verification is §15 R3**) + `MAIL_INBOUND_TOKEN`; VERP `reply+<token>@` → `mail_log.reply_token` match (token is the ONLY match; `from_email` display-only); `mail_messages` insert w/ `(provider, provider_message_id)` idempotency; size caps; server-side HTML allowlist sanitization at intake (raw MIME never stored); attachments → quarantine + scan-status gate (consumes MAIL-14); unmatched token ⇒ count+log+204 (A9); NDR classification (fixture NDR; real format is §15 R4); thread reads `GET /api/admin/mail/log/:id/thread` + entity-scoped `GET /api/:t/mail/threads` authorized via the PARENT entity (A10); per-source rate limit. **Committed adversarial corpus** (`src/mail/__fixtures__/inbound/` — full case list in design §7.6: forged sender, wrong/absent/unknown token, replayed id, oversized body, oversized/many attachments, script/CSS/tracker HTML, encoding attacks, quoted-reply bloat, NDR) + replay script `npm run mail:replay-inbound -- --base <url>`; **corpus wired into CI permanently (A13)** | senior-be | **opus·medium** — an internet-facing untrusted-input pipeline whose failure mode is forged/hostile content rendered on decision surfaces; sanitization + auth + idempotency must be right the first time | MAIL-04; MAIL-14 (scan hook; stub allowed until W0 lands it) | Every corpus case has a pinned test: forged-signature and missing-token posts rejected (401/403), valid post threads onto the right entity; replayed id ⇒ single row; XSS corpus inert **as stored content**, not just at render; oversize rejected at cap; thread read 403s exactly like the parent entity; EICAR ⇒ `infected`, download blocked; unmatched ⇒ 204 + counter; **replay script run against the deployed box with `mail_messages` rows + thread render as evidence**; corpus in CI; contract file updated |
| MAIL-14 | **ClamAV scan service (FIRST actual instantiation in the estate — until now it existed only as the webdesk-blueprint pattern).** `clamav/clamd` container in the vps compose under its **own `scan` profile** (NOT `mail-dev` — real inbound at staging still needs scanning after the sink retires, §4.3) + `scan` added to the `COMPOSE_PROFILES` repo var (same orphan trap as MAIL-00); freshclam persistence; scan client in platform (env-gated `MAIL_INBOUND_SCAN=clamav`, fail-closed for attachment exposure: unscannable ⇒ stays quarantined); runbook note: webdesk C-02 upload scanning later reuses this service | devops | default | none (parallel-safe) | Profile up on the box ⇒ EICAR flagged via the scan client; scanning off ⇒ attachments admin-only; service absent ⇒ platform boots fine (fail-soft boot, fail-closed exposure); healthcheck wired; survives a deploy (repo var updated) |
| MAIL-15 | **Mail surface UI (`/admin/mail` + entity thread panels).** Admin log list (filters: stream/status/tenant/entity/date; status chips render "accepted ≠ delivered" honestly — in dev everything caps at `sent`, which the chips make legible) + detail (event timeline, thread); triggering entity as deep link; thread panel component consumed by approval detail + run workspace + portal run view (portal via the portal BFF, same entity-authorized read); inbound messages carry the "Email reply — sender unverified" banner; DEMO_MODE fixtures (reserved-TLD addresses per A12); degrade cleanly when endpoints absent | medior | default | MAIL-04 (log reads); MAIL-13 (thread reads — panel may land behind its absence-degrade) | Log renders/filters/paginates against the live BFF on the box (corpus-fed threads visible); entity deep links navigate; banner present; DEMO_MODE backend-free; `tsc` + unit + `next build` green; grep gate holds for UI code; a11y basics per existing admin-page patterns |
| MAIL-16D | **`GmailClient` seam + fixture implementation (the ONLY Gmail work in dev — design §8C/A14).** Interface: `listThreads(pageToken?)`, `getThread(id)`, `getMessage(id)` (decoded parts + attachment metadata), `listLabels()`; error taxonomy (unauthorized/revoked, rate-limited w/ retry-after, not-found). Fixture-backed impl + committed thread fixtures; **provider-agnostic contract-test suite that the staging live adapter must pass unmodified**. NO link flow, NO UI, NO migration (the provider-CHECK widening ships with MAIL-16 at staging). README states plainly that thread/label/pagination semantics are UNVERIFIED against the real API (§15 R7) | medior | default | none (design §8C binding) | Interface + fixture impl + contract suite green in CI; suite written so the live adapter can run it unmodified; zero persistence of message content anywhere (M14 pre-enforced in the fixture impl); README honesty note present |
| MAIL-18 ⚡ | **Inbound + approval-link adversarial QA gate — THE dev-stage exit gate.** Attack pass against MAIL-05/13/15 using the corpus + live box: forged inbound webhook (bad/absent signature+token), replayed provider ids, oversized bodies/attachments, XSS corpus end-to-end (intake → store → render on approval detail + portal), spoofed `From:` vs token mismatch, reply-token brute-force (entropy + rate limit), EICAR; **link-security audit:** approval/warning mails contain zero action affordances + zero tokens, deep links land behind SSO (expired-session walk re-run), warning wording never implies execution (M12 re-assert on rendered output); suppression + fixture-NDR paths; **grep gate re-assert (A12)** | qa | default | MAIL-13 + MAIL-15 landed | Written evidence per attack (what was tried, what happened); zero critical findings open — failures become tickets, not ad-hoc fixes; wording + no-action-affordance audit signed off explicitly; **this gate passing (with MAIL-11's dev leg) = the dev stage is closed** |

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
DEV STAGE (zero external dependencies; 1–2 agent concurrency cap)
W0  MAIL-00 ∥ MAIL-14       (the sink + ClamAV — both keyless devops, independent)
W1  MAIL-02 ∥ MAIL-03       (config-only consumers of the sink; incl. real Keycloak flows)
W2  MAIL-04                 (the keystone — alone)
W3  MAIL-05 ∥ MAIL-13       (the tap ∥ inbound + adversarial corpus)
W4  MAIL-06 ∥ MAIL-15       (decider substrate ∥ mail surface UI)
W5  MAIL-09 ∥ MAIL-16D      (deploy + sink smoke ∥ Gmail seam fixture)
W6  MAIL-10 → MAIL-11       (magic links — moved up from v2's W8; SLO leg excluded)
W7  MAIL-18                 (adversarial gate — passing it CLOSES the dev stage)

STAGING REOPEN (begins where dev ends; execute design §15 in order)
W-S0  MAIL-01A → MAIL-01B   (⛔ DNS custodian / Brevo signup — the real provider wave)
W-S1  §15 R1–R4, R6, R8 re-runs (creds swaps + re-verification; devops + qa)
W-S2  MAIL-16 → MAIL-17     (⛔ internal OAuth client + WD-23A-1 landed)
W-S3  §15 R5: ≥7-day SLO window → owner quality gate → MAIL_MAGIC_LINKS_ENABLED=1
W-S∞  MAIL-12               (parked until webdesk P2 exists; R9)
```

**Human gates:** the owner reviews rendered mail quality (wording, links, layout) in Mailpit after
**W5** — the sink makes this a 10-minute browse instead of an inbox hunt. The M12 flip
(automation/agent wording → actionable) remains **not a ticket in this program** — gated on the
D14 resume path (Temporal decision, tracked in the full-fidelity register / agentic-native plan);
a one-constant change when its prerequisite lands.

## Dev-stage exit criteria ("the dev stage is finished" means ALL of these)

1. Every dev-wave ticket — MAIL-00, 02, 03, 04, 05, 06, 09, 10, 11(dev leg), 13, 14, 15, 16D —
   is **DEV-VERIFIED** with evidence from gda-aicenter runs (Mailpit API captures, suite output,
   the deploy pipeline having applied `0076`).
2. **MAIL-18 and MAIL-11 (dev leg) both passed** with zero open critical findings.
3. The inbound fixture corpus is committed and running in CI (permanent, A13).
4. The A12 grep gate holds: zero `gaiada.com`/`gaiada.online` literals in mail code/templates/UI.
5. Design **§15** is fully populated — every row's dev substitute is DEV-VERIFIED, every staging
   column untouched; MODULES.md/CHANGELOG carry the §13 status caveat verbatim (no
   deliverability/SLO/Gmail claims anywhere).
6. Magic links (`MAIL_MAGIC_LINKS_ENABLED=0`) and the `emailVerified:true` retirement remain OFF
   for real users.

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
