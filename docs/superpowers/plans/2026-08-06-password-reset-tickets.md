# Password Reset (SEC-03) — ticket plan

> # ⛔ CANCELLED 2026-08-06 — the premise was wrong. Do not build this.
>
> **PR-00b proved a one-line realm change fixes both reset paths, so this eight-ticket program is
> unnecessary in full — cancelled, not reduced.**
>
> `UPDATE_PASSWORD` was **never registered as a required action on the `gaiada` realm** (only
> `CONFIGURE_TOTP`, `VERIFY_EMAIL`, `delete_account` were). Keycloak logged it plainly:
> `WARN Could not find configuration for Required Action UPDATE_PASSWORD, did you forget to register it?`
> After `kcadm create authentication/register-required-action -s providerId=UPDATE_PASSWORD`
> (enabled, `defaultAction: false`, priority 61), **both** paths satisfy all four conditions — form
> renders, the original password stops working, no session is minted, link is single-use — verified in
> a real browser under `account-console` and `gaiada-ui`, including the **native** reset-credentials
> flow this document was written to replace.
>
> **SEC-02's keycloak/keycloak#16527 attribution was wrong as an explanation of the live symptom.**
> The source reading was accurate on its own terms, but `nextRequiredAction()` never reached the
> session-vs-user ordering logic that issue describes — with no registered provider for the alias it
> fell through first. The registration gap accounts for 100% of both SEC-01's and PR-00's symptoms.
>
> **Why this document is kept rather than deleted:** its `execute-actions-email` mechanism analysis
> (no flow re-entry, no session minted, credential replaced) is accurate and was independently
> confirmed by PR-00b, and the reasoning about *why* a platform-minted token would be worse — it
> breaks the "platform never sees passwords" invariant, and a token-verify bug there means arbitrary
> account takeover rather than an email to the victim's own mailbox — remains the right answer if this
> ever needs revisiting.
>
> **The lesson, recorded because it cost an eight-ticket design:** three investigations, three
> methods. Driving the flow found the symptom. Reading source produced a confident, thorough, wrong
> cause. Reading the **server log** gave the answer in one line. Ask what the running system is
> *configured* with before inferring from what the code *does*.
>
> Durable fix: the registration is now in `infra/compose/keycloak/gaiada-realm.json` so a fresh
> `--import-realm` boot cannot reproduce the gap.


**Date:** 2026-08-06 · **Design:** `docs/superpowers/specs/2026-08-06-password-reset-design.md`
**Status:** PLANNED. Mobilize via `/army`; concurrency cap 1–2 per the agent-army standard.
**Model·effort:** seat defaults everywhere (seniors/medior/qa/devops = Sonnet·high, junior =
Haiku) except where an explicit `opus·…` tag says otherwise — exactly one ticket carries one.

**Sequencing:**
`PR-00 → { PR-01 (owner-gated timing) ∥ PR-02 } → PR-03 → { PR-04 ∥ PR-07 } → PR-05 → PR-06`

**Execution walls, known up front:**
- PR-00, PR-01, PR-05 are **box-direct** on gda-aicenter (kcadm + Playwright + Mailpit — the
  SEC-01/SEC-02 harness) and are unblocked today.
- PR-03, PR-04 ship through the deploy pipeline; while GitHub Actions billing (Q-O4) is blocked
  they are code-complete-but-unverifiable on the live box → report IN PROGRESS with the live leg
  PENDING-DEPLOY (mail design §13 v4 rule). PR-06 needs them deployed (or the owner's explicit
  local-stack exception — design §13 Q2).
- Migrations: **none expected.** If one becomes necessary anyway: number = next unused at build
  time, re-verified with `ls platform-nest/migrations | sort | tail` immediately before writing
  DDL (ledger moved 0077→0084 in one session; 0085 reads next as of 2026-08-06 — re-check, don't
  trust); never fill 0058/0059/0070.
- Shared-file discipline: nobody edits `docs/modules/MODULES.md` / `docs/modules/CHANGELOG.md`
  (orchestrator applies §5 below); `infra/observability/prometheus/rules/alerts.yml` and
  `docs/FRONTEND-BFF-CONTRACT.md` are touched by exactly one ticket each (PR-03, PR-07) and
  re-read immediately before editing (concurrent sessions are active).

---

## PR-00 — SPIKE: prove `execute-actions-email` behavior on the live realm
**Tier:** senior-integrator · **model·effort:** seat default · **Deps:** none · **Box-direct.**
Everything downstream gates on this ticket's evidence. No platform code.

Do: throwaway user via `kcadm.sh` (SEC-02 hygiene: create → test → delete, realm export first as
the checkpoint); dispatch `PUT /admin/realms/gaiada/users/{id}/execute-actions-email?lifespan=900&client_id=gaiada-ui&redirect_uri=<base>/`
with body `["UPDATE_PASSWORD"]` using the `gaiada-provisioner` credential
(`~/.gaiada-provisioner-secret`); capture in Mailpit; drive the link with Playwright.

**Done when (all browser-driven, recorded with screenshots/notes for the runbook):**
1. Fresh cookie-less context: link → confirmation interstitial listing "Update Password" →
   confirm → a real `input[type=password]` form (new+confirm, sign-out-other-devices checkbox).
2. Submit new password → "Your account has been updated" info page; **no authenticated app
   session exists** in that context (ERP demands login).
3. Original password **fails** under BOTH `account-console` and `gaiada-ui`; new password
   succeeds under both; `kcadm get users/<id>/credentials` shows ONE password credential with an
   advanced `createdDate`.
4. Re-clicking the link after completion → invalid/expired error (single-use on completion);
   re-clicking BEFORE completion (abandon the form once) still works (TTL-bounded).
5. `redirect_uri` acceptance recorded for `<base>/` and `<base>/portal` against `gaiada-ui`'s
   registered URIs; if rejected, record which exact URIs must be added to the client (PR-01 then
   carries that one-line client change, realm JSON + live).
6. Persisted `requiredActions` read `[]` throughout (expected — actions ride the token; recorded
   so nobody ever "fixes" that as a bug).
7. Admin-console Credential Reset (same mechanism) demonstrated once — this is the helpdesk
   fallback PR-01's interim gap relies on.
8. Findings appended to `docs/runbooks/idp-keycloak.md` as a SEC-03 section (append-only; do not
   rewrite SEC-01/02).
**If any of 1–4 fails: STOP; report; the design's §3 fallback (Option B) re-opens.**

## PR-01 — Close the native forgot-password flow (realm flip)
**Tier:** devops · **model·effort:** seat default · **Deps:** PR-00 · **Box-direct.**
**Owner gate (design §13 Q1):** timing — immediately (recommended) vs bundled with PR-05.

Do: mint one native reset-credentials link BEFORE the flip (for AC-4); then
`kcadm.sh update realms/gaiada -s resetPasswordAllowed=false` on the live realm AND flip
`infra/compose/keycloak/gaiada-realm.json` `"resetPasswordAllowed"` to `false` (both halves — the
import-skips-existing-realm trap). Plus any `gaiada-ui` redirect-URI addition PR-00 §5 recorded.

**Done when (browser-driven):**
1. KC login page shows NO forgot-password link (both clients' auth requests).
2. Direct `GET`/`POST …/login-actions/reset-credentials` → `RESET_CREDENTIAL_NOT_ALLOWED` error
   page, not a form.
3. The pre-flip-minted native reset link is REJECTED at redemption.
4. Ordinary SSO login (existing dev user) unaffected; account-console authenticated password
   change unaffected; admin-console Credential Reset unaffected.
5. Realm-export checkpoint taken first; rollback documented (flip both halves back).

## PR-02 — `sendExecuteActionsEmail` in `keycloak-admin.ts`
**Tier:** senior-be · **model·effort:** seat default · **Deps:** PR-00.

One new exported function in `platform-nest/src/core/keycloak-admin.ts`:
`sendExecuteActionsEmail(userId, actions, { lifespanSeconds, clientId, redirectUri }, fetchImpl?)`
→ `PUT /users/{id}/execute-actions-email?lifespan&client_id&redirect_uri`, JSON body = actions
array. Rides the existing `adminFetch` (token cache, single-flight, 401-retry-once) and error
family (`KeycloakNotConfiguredError` 503 / `KeycloakAdminError` 502). No invite-path changes.

**Done when:** unit tests (FetchImpl fake, `keycloak-admin.test.ts` conventions) cover: success
204; query params exactly `lifespan`/`client_id`/`redirect_uri` and omitted when absent; body is
the raw actions array; 400/404/5xx → `KeycloakAdminError` with operation name; 401-once retry;
unconfigured → `KeycloakNotConfiguredError`. Existing suite untouched and green.

## PR-03 — `POST /auth/password-reset` (request surface + dispatch task)
**Tier:** senior-be · **model·effort:** **opus·medium** — the equalized-cost decoy must mirror
THIS flow's real branch (not magic-link's), and MAIL-24 history shows exactly this class shipping
a measurable 3.25x oracle on first build; a wrong decoy is a silent security regression whose
discovery costs a full QA re-run, so start strong rather than escalate. · **Deps:** PR-02.

New module `platform-nest/src/mail/password-reset/{controller,service,rate-limit}.ts` per design
§5.1–§5.4: ServiceGuard root-level route; `MAIL_PASSWORD_RESET_ENABLED` 404-gate; own rate-limit
Map (3/addr/hr, 10/IP/hr, own env keys, `limit<=0` disables); shared trusted-proxy `clientIp`
semantics; local users lookup with human-kind exclusion; suppressed→503 parity; `mail_log`
dispatch-decision row + fire-and-forget KC dispatch (idp_subject ?? findUserByEmail →
sendExecuteActionsEmail lifespan=900, clientId `gaiada-ui`, kind-based redirectUri) with
sent/failed transitions + `recordSent`/`recordFailed("auth")`; decoy work mirroring the real
branch (suppression SELECT + mail_log INSERT+DELETE rolled back); counter
`mail_password_reset_rate_limited_total{dimension}`; `[password-reset:audit]` lines (token-free —
there is no token); alerts.yml gains `MailPasswordResetRateLimitSustained` (clone, >10/15m) and
`MailAuthStreamSendFailed`'s summary gains "/ password-reset" wording (re-read the file
immediately before editing; concurrent sessions).

**Done when:**
1. Controller/service unit + DB tests mirroring the magic-link suites: always-202 with
   byte-identical bodies for known/unknown/rate-limited; 404 when flag off; 503 suppressed-known;
   rate-limit per dimension w/ counter assertions; excluded-kind (service/bot principal email)
   never dispatches and returns the same 202.
2. Timing test in `mail24-timing-remeasure.test.ts`'s methodology (N=30/branch, median+IQR, real
   DB): known-vs-unknown median ratio **< 1.8**, printed like the MAIL-24 remeasure.
3. Dispatch task tests: KC 204 → row `sent` + `provider='keycloak'`; KC error → `failed` +
   `last_error` + `recordFailed`; unresolvable KC id → `failed`, no throw to the request path.
4. Pin test: the reset path never touches `auth_magic_links` and never renders
   `auth.magic_link`; the magic-link path never emits `auth.password_reset` (M11-style
   separation, both directions).
5. Env passthrough: the three new vars in `config.ts`, `.env.example`, AND the `platform`
   service `environment:` block — AC greps `infra/compose/docker-compose.vps.yml` for each name.
6. `promtool check rules` green on the edited alerts.yml.
7. No migration files added (design §12); no raw email/token in any log line (grep).

## PR-04 — `/auth/reset-password` UI page + BFF proxy
**Tier:** medior · **model·effort:** seat default · **Deps:** PR-03.

Public request page in platform-ui (the `/auth` prefix is already middleware-public —
`src/middleware.ts:21`; verify, do NOT widen the allowlist): email field → server-side route
handler → `POST {PLATFORM}/auth/password-reset` with Bearer `PLATFORM_SERVICE_TOKEN` and the
browser IP forwarded as `x-forwarded-for` (the controller's trusted-proxy note: meaningful
per-user limits REQUIRE this). Login-adjacent styling; a11y per house rules.

**Done when:** always the same generic confirmation for 202 regardless of input (unknown vs known
indistinguishable client-side, asserted in a component/e2e test); 503 → "delivery unavailable —
contact an admin"; 404 (flag off) → friendly disabled note; the raw email value never logged
(grep); `tsc` + `next build` green; the BFF handler never exposes `PLATFORM_SERVICE_TOKEN` to the
client bundle (grep the build output for the env name).

## PR-05 — Keycloak login theme: our "Forgot password?" link
**Tier:** devops · **model·effort:** seat default · **Deps:** PR-01, PR-04 (deployed link target;
owner may accept a short dead-link window — note in the ticket report either way) · **Box-direct.**

`infra/compose/keycloak/themes/gaiada/login/` (theme.properties parent = the running default
theme — confirm on the box; minimal `login.ftl` override rendering the link to
`${MAIL_LINK_BASE_URL}/auth/reset-password` unconditionally), bind-mounted; set `loginTheme`
"gaiada" live via kcadm AND in `gaiada-realm.json`. Document: theme cache (restart or
`--spi-theme-cache-themes=false` in dev) and the FTL-fork-per-KC-upgrade re-check note in the
runbook SEC-03 section.

**Done when (browser):** login page renders correctly under both clients with our link; link
navigates to the reset page; SSO login flow unaffected; native reset-credentials URL still
error-pages; a container recreate keeps the theme (mount, not exec-copied).

## PR-06 — QA gate: the pass condition, end to end
**Tier:** qa · **model·effort:** seat default · **Deps:** PR-01..PR-05 · **PENDING-DEPLOY while
Q-O4 blocks (design §13 Q2).**

Drive design §11 verbatim on gda-aicenter with Playwright + Mailpit + kcadm (throwaway users,
staff-kind AND client-kind): request → mail → fresh cookie-less context → interstitial → password
form → completion info page (no session minted) → **old password fails under BOTH
`account-console` and `gaiada-ui`, new succeeds** → single-credential + advanced `createdDate` →
replay rejected → portal-vs-staff Back-to-application split → native-flow-closed re-assertions
(PR-01's four, re-run) → enumeration probe N=30/branch median ratio < 1.8 + byte-identical bodies
→ rate-limit and suppressed behavior → counters visible (`mail_password_reset_rate_limited_total`
increments; a forced dispatch failure trips `MailAuthStreamSendFailed`'s counter path).

**Done when:** every assertion above passes and is recorded (the SEC-01/02 evidence style) in the
runbook SEC-03 section; any failure files findings and blocks the program (this is the merge
gate). Status language: at best DEV-VERIFIED; the staging-only items stay UNVERIFIED (§5 below).

## PR-07 — Docs + contract registration
**Tier:** junior · **model·effort:** seat default (Haiku) · **Deps:** PR-03 (content exists).

- `docs/runbooks/idp-keycloak.md`: SEC-03 section skeleton (resolution pointer to the design doc,
  helpdesk-fallback procedure from PR-00 §7, rollback = PR-01 §5, theme cache + upgrade notes) —
  append-only.
- `docs/FRONTEND-BFF-CONTRACT.md`: one additive row — `POST /auth/password-reset` (BFF-internal,
  ServiceGuard) + the `/auth/reset-password` page. Re-read the file immediately before editing.
- `platform-nest/.env.example`: the three new vars with comments.
- Do NOT touch `docs/modules/MODULES.md` / `docs/modules/CHANGELOG.md` (orchestrator applies §5).

**Done when:** files updated; no other files touched; links resolve; status language correct.

---

## §5 Registration text (orchestrator applies — this session must not edit these files)

**MODULES.md — `mail` section, append to its entry list:**
> `auth.password_reset` (SEC-03): platform-owned self-service password reset — request surface +
> anti-enumeration on platform-nest, execution via Keycloak `execute-actions-email`
> (`UPDATE_PASSWORD`, lifespan 900s); native realm forgot-password disabled
> (`resetPasswordAllowed=false`). PLANNED → per-ticket status via PR-00..PR-07
> (`docs/superpowers/plans/2026-08-06-password-reset-tickets.md`). Real-relay delivery and
> production enablement UNVERIFIED until staging (design §11; register row R10).

**CHANGELOG.md:**
> 2026-08-06 — mail/auth: SEC-03 password-reset design + ticket plan landed
> (`docs/superpowers/specs/2026-08-06-password-reset-design.md`). Replaces the broken Keycloak
> native reset (SEC-01/SEC-02, upstream keycloak#16527-class) with a platform-owned request flow
> executing via admin `execute-actions-email`. PLANNED.

**Zone-A mail design §15 — new row R10 (orchestrator appends to the register table):**
> | R10 | **Password-reset production enablement + KC→relay reset-mail leg** (SEC-03) | Full flow
> against Mailpit + local suites; `MAIL_PASSWORD_RESET_ENABLED=0` for real users | Real-relay
> delivery of Keycloak-sent reset mail (TLS/auth); real-user reset quality; enumeration timing on
> staging infra | Re-run PR-06's browser E2E to a real inbox after R6's relay swap; one-shot
> enumeration timing re-probe (alongside R5's); THEN owner flips `MAIL_PASSWORD_RESET_ENABLED=1`;
> confirm helpdesk fallback documented for delivery failures | PR-06 (real-inbox variant) |
