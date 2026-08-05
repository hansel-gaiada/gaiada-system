# Zone A Mail — platform-nest email subsystem — Design **v4**

**Status: IN PROGRESS** — the dev stage has EXECUTED through W4 + MAIL-16D (module `mail` →
`0.0.9+` in `docs/modules/MODULES.md`; core migration landed as **`0077_mail_core.sql`**).
Author: system-architect. **v1 2026-08-04 → v2 (owner revision) → v3 (owner directive: finish the
dev stage with zero external keys), all same day → v4 2026-08-05 (design-authority amendment:
implementation findings folded back in — no design reversals, several corrections + one new
decision A15).** Ticket decomposition: `docs/superpowers/plans/2026-08-04-mail-subsystem-tickets.md`
(**v4** — waves re-shaped around the GitHub Actions billing block, §14 Q-O4). Companion amendment:
`docs/blueprints/webdesk-blueprint.html` §C-02/C-03/D14 (Zone B mail; v1.2).

**v4 amendment summary (implementation findings, 2026-08-05):**

| Change | v3 said | v4 says |
|---|---|---|
| Inbound webhook auth | Ticket phrasing implied a provider signature scheme existed to implement; §7.6 hedged with "provider signature *where offered*" | **Brevo does not sign inbound webhooks at all** (verified against its docs: URL basic-auth, a token header, or custom headers are the only mechanisms). The **`MAIL_INBOUND_TOKEN` check IS the provider-documented scheme**; the HMAC verifier that was built (`MAIL_INBOUND_SIGNING_KEY`, raw bytes, timestamp-bound) is **OURS** — defence-in-depth, never to be documented as a Brevo scheme. §7.6's "where offered" wording is what makes this **compliance, not a deviation**. §15 R3 re-scoped: there are no real signatures to verify against. |
| Inbound attachments | Payload carries bytes (implicit) | Brevo inbound delivers **`DownloadToken`s, not bytes**. Dev fixtures inline bytes so quarantine→scan→download-gate runs end-to-end; the token→bytes fetch is real staging work behind the `NormalizedAttachment` seam (**added to §15 R3**). Fail-closed stands: unfetchable ⇒ `pending` ⇒ quarantined ⇒ download refused. §7.6. |
| Quoted-history handling | Owned by nobody — intake "caps, never interprets"; collapse assumed to be MAIL-15 render work, but MAIL-15 landed without it | **A15 (new decision):** heuristic-free **head+tail** intake cap (the reply survives whether top- or bottom-posted) + **render-side quote collapse**; intake-side quote *stripping* stays forbidden. Tickets MAIL-19/MAIL-20. §7.6. |
| Attachment cap semantics | "per-attachment + count caps" (interpretation left open) | **Ratified as implemented:** an over-cap/over-count *individual* attachment is dropped-but-visible while the message still threads; only the *total* request cap (`MAIL_INBOUND_MAX_BYTES`, pre-parse) refuses a delivery. §7.6. |
| Approval deep links | Staff link = the `/approvals` inbox (no per-item route existed) | **Owner approved `/approvals/[id]`** — ticket **APPR-01** (cross-program, in flight). The fix must land on BOTH sides: the UI route AND the backend-emitted `payload.href` (MAIL-05's tap only absolutises what it is handed). Also unblocks MAIL-15's deferred approval-detail thread panel. §7.5, §8A. |
| F1 audit completeness | F1 named the automation-approvals create path + agency's two | **Corrected:** a THIRD live `automation_approvals` insert site existed — the Google-Ads change-proposal suspend path in `search.controller.ts` — equally notification-broken. MAIL-06 fixed all four sites with one shared resolver. The original F1 enumeration must not be cited as complete. Header findings + §7.3. |
| Settled verifies | ex-Q-V6 / ex-Q-V8 pinned in dev ACs | **Both settled.** ex-Q-V6: Keycloak realm import does **NOT** substitute `${env.*}` placeholders (proved empirically); the realm JSON ships a working dev default + `infra/compose/keycloak/configure-smtp.sh` is the fresh-boot path (§10). ex-Q-V8: `resource_agency_approval.yaml` has **no `decide` action** — its decide-equivalent is `approve` → `company_admin` + `module_approver`, concretely **`agency_approver`**; NOT `group_executive` (§7.2/§7.3). |
| A13 (fixture corpus) | Argued prospectively as "higher-fidelity than a live provider" | **Vindicated by execution:** the corpus caught **three defects invisible to type-checking** before any live traffic — incl. a void-element bug where a mail containing `<embed>` silently lost every byte after it. A13 stands permanently. §7.6. |
| D14 cross-reference | Resume path "a Temporal decision, tracked elsewhere" | The **D14 resume-path program is now real and executing** (`0078_automation_approval_execution.sql` landed; plan `docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md`). The M12 wording flip stays gated on that program **completing** and stays a one-constant change + architect review. §7.4. |
| Execution reality | W0–W7 proceed on the box; "nothing external blocks the dev stage" | v3's claim held for provider keys — but **GitHub Actions is billing-blocked and it is the ONLY deploy path** (`release.yml` signed images → `deploy.yml`; the box never compiles). MAIL-09/10/11 and MAIL-18's live legs are blocked; several tickets are **code-complete-but-unverifiable**; repo↔server drift is accumulating (MAIL-02/03 manual server fixes). New owner gate **Q-O4** (§14); ticket plan v4 carries the honest wave re-shape + the deferred live-verification batch. |

**v3 amendment summary (owner directive, 2026-08-04):**

| Change | v2 said | v3 says |
|---|---|---|
| External dependencies | Q-O1 (DNS/Workspace) ⛔ blocked W0; Q-O3 (Brevo) ⛔ blocked inbound; Q-O2 (Google client) ⛔ blocked the Gmail wave | **Nothing external blocks the dev stage.** Every real-key dependency is simulated in dev and becomes a row in the **Staging Reopen Register (§15)** — the single authoritative handover to the staging stage. |
| Dev provider | Workspace relay + Brevo from W0 | **Mailpit** fake-SMTP sink as a compose service **on gda-aicenter** (M15/A11, §4.3) — catches everything, sends nothing. SMTP egress from the box becomes irrelevant for dev (internal container traffic only), so the Hostinger/GCP port-25 question stops mattering until staging. MAIL-01A/01B move to the staging reopen. |
| Domains | Concrete `auth./notify.gaiada.com` in env examples | **Every domain/subdomain is a config value, never a literal** (A12). Compiled-in defaults use reserved-TLD fakes (`*.gaiada.invalid`); the staging swap is env-only; a grep gate in the ACs forbids `gaiada.com`/`gaiada.online` in mail code. |
| Inbound (C1) in dev | Gated on Brevo inbound (Q-O3) | **Fixture replay harness** (A13, §7.6): the webhook endpoint is built for real and fed a committed adversarial payload corpus — a *higher-fidelity* adversarial test than a live provider, kept permanently as the regression suite. |
| Gmail (MAIL-16/17) | Staging-ready, build when keys land | Honestly flagged **the program's highest re-verification risk**. Dev builds only the `GmailClient` seam + fixture implementation (MAIL-16D, A14); the link flow, live adapter, and reading-pane UI stay in the staging window (WD-23A-1 + Q-O2 unchanged as hard gates). §8C. |
| Magic links | Built last (W8), behind the live SLO | **Moved earlier (W6)** — fully dev-buildable and adversarially testable against the sink. The M8 latency SLO stays a **staging** gate and `MAIL_MAGIC_LINKS_ENABLED` stays `0` for real users until it passes (§9, §15 R5). |
| Status language | Standard repo convention | Hardened (§13): anything verified only against Mailpit/fixtures caps at **DEV-VERIFIED**; deliverability, inbox placement, and latency-SLO claims stay **UNVERIFIED** until staging. No ticket AC may overclaim. |

**v2 amendment summary (owner-locked, 2026-08-04 — kept for history):**

| Change | v1 said | v2 says |
|---|---|---|
| Staff notification email | Immediate allowlist + daily digest mirroring `notifications` | **DEAD.** Staff notifications stay realtime in-app only. Email is NOT a general notification channel. Digest engine + per-user prefs surface **cancelled** (old M7/A7, MAIL-07/08 dropped). |
| Email triggers | notify() tap w/ broad `IMMEDIATE_TYPES` | ONLY (a) automation/AI **medium-or-higher-risk** actions (the existing WS4 impact gate / D14 suspension, §7.1) and (b) anything **requiring human approval**, routed to the resolved decider set (§7.2–7.3). Clients ride the same path. |
| Direction | Sending only | **Bidirectional**: system-thread inbound via `reply+<token>@notify.gaiada.com` → `mail_messages` (§7.6). Still no mailbox hosting and no IMAP server of ours. |
| Domains (old Q1) | `gaiada.online` recommended | **Answered**: `auth.gaiada.com` + `notify.gaiada.com` (Workspace root), `forms.gaiada.online` (Zone B). §4.2. |
| Provider | Brevo free tier primary | **Google Workspace SMTP relay primary for Zone A**; Brevo = failover + inbound + Zone B forms. §4.2. Volume collapses to a handful/day ⇒ every provider free-tier question is moot. |
| ERP mail surface | admin log endpoint only | Full surface: sent-mail log UI, deep-link-to-act, inbound threads on entities, **staff Gmail read surface (staging-ready roadmap, §8B)**. |
| Approval links | (unstated) | Deep link to the ERP entity ONLY — no action buttons, no approve-by-reply, **never magic links** (§7.5). |
| Sequencing | — | Warning stream ships first; automation/agent approval-mail wording is gated on the **D14 resume path** (§7.4). |

Findings preserved from v1 (both re-verified against code today): **(F1)** creating an approval
notifies nobody — `automation_approvals` create has no `notify()` call, and `agency_approvals`
create paths (subject + asset review) have none either; only decide-side notifications exist
(§7.3). **(F2)** a NULL-tenant row in a FORCE-RLS table is readable by nobody at all (owner role
is NOBYPASSRLS) ⇒ mail tables must be GLOBAL (§6.1).

**v4 correction to the F1 record (architect audit was incomplete):** F1 enumerated the
automation-approvals create path and agency's two — but a THIRD live `automation_approvals`
insert site existed and was missed: the **Google-Ads change-proposal suspend path** in
`platform-nest/src/modules/search/search.controller.ts` (origin `automation`, SM-21/SM-26),
notification-broken in exactly the same way. MAIL-06's implementer found it and wired it to the
same shared resolver (`src/core/approval-deciders.ts`), so the fixed set is **four** create call
sites (§7.3). Do not cite the original F1 enumeration as a complete inventory of insert sites; any
future "who creates approvals" audit must grep for `INSERT INTO automation_approvals` rather than
trusting this doc's list.

---

## 1. Problem — what was actually measured (unchanged from v1)

The ERP sends **zero email**. Verified 2026-08-04:

| Surface | State |
|---|---|
| `platform-nest` | No mail module, no `nodemailer`, no SMTP client of any kind. `notify()` (`src/core/http.ts`) writes in-app `notifications` rows only. |
| Alertmanager | `infra/compose/docker-compose.observability.yml` `&am_env` passes `SMTP_SMARTHOST`/`SMTP_FROM`/`SMTP_USERNAME`/`SMTP_PASSWORD`/`ALERT_EMAIL_TO` through — all default **empty**, so the D15 "email = second independent alert transport" is silently dead. |
| Keycloak | Realm `gaiada` has no `smtpServer`. User provisioning sidesteps verification via `emailVerified: true` (the `gaiada-provisioner` client on gda-aicenter). No password-reset email possible. |
| Webdesk (Zone B) | C-02 Forms / C-03 Mail are specced (blueprint) but `webdesk` is `0.0.0 PLANNED` — no code. |

v2 consequence framing: staff live in the ERP all day — the bell is enough for them. **Clients and
decision-owners do not.** A client asked to sign a PRD gate, or an admin whose automation suspended
a high-impact write, finds out only if they happen to log in. That — not general notification
mirroring — is the problem email solves.

## 2. Scope (v2)

In scope, in build order:

1. Provider + DNS identity: Google Workspace SMTP relay (primary, Zone A) + Brevo (failover +
   inbound + later Zone B forms), subdomain identities per §4.2.
2. Keycloak + Alertmanager SMTP (zero code).
3. The `platform-nest` mail module: adapter, PG queue, `mail_log`, suppressions, provider
   delivery-event webhook.
4. **Risk/approval mail**: warning stream for suspended automation writes + decision-needed mail
   for approvals whose decide is real today, to the resolved decider set — staff AND clients, one
   mechanism (§7).
5. **Inbound system-mail threads** (`mail_messages`, VERP reply tokens, sanitized untrusted
   intake) + the ERP mail surface (sent-log UI, entity threads) (§7.6, §8A).
6. **Staff Gmail read surface** — staging-ready roadmap item, designed here, built when Google
   keys land in staging (§8B).
7. Magic links (low-risk convenience login ONLY — designed, built last, §9).
8. The adapter contract handed to webdesk C-02/C-03 when Zone B is built.

Out of scope: **email as a general notification channel** (staff notifications stay in-app);
digests of any kind by email; per-user channel-preference surfaces; marketing/bulk; per-tenant
template editors; mailbox hosting / an IMAP **server** of ours (a single-mailbox IMAP *poll* of a
provider mailbox is an allowed inbound fallback, §7.6); send-as-employee (system identity only);
the **WhatsApp/Telegram group-chat summary** — the owner's 12:00/18:00 WITA cadence belongs to
that channel (a group rollup, wa-chat-bot's existing digest feature), not to email, and it is the
bot's job, not this module's.

**v3 staging split:** the scope list above is unchanged, but it now executes in **two stages**: a
**dev stage with zero external dependencies** (everything runs for real against the Mailpit sink
and the fixture corpus, on gda-aicenter), then a **staging reopen** (§15) where every simulated
dependency is re-verified with real DNS/relay/Brevo/Google. Scope item 1 (provider + DNS identity)
is staging-stage in its entirety; item 6 (Gmail) is staging except the seam (A14); everything else
completes in dev.

## 3. Decisions

### 3.1 Owner-locked (v1 2026-08-04, revised v2 same day — do not re-open)

| # | Decision | v2 status |
|---|---|---|
| M1 | Self-host the service layer, rent the final SMTP hop. No direct-to-MX MTA, ever. | **Unchanged.** |
| M2 | Provider path | **REVISED**: Zone A primary = **Google Workspace SMTP relay** (`smtp-relay.gmail.com`, included with existing Workspace seats, ~10k msg/day — comfortably oversized for a handful/day). **Brevo adapter retained as Zone A failover**, and Brevo is the **inbound** intake (§7.6) and the **Zone B forms provider** on `gaiada.online`. ZeptoMail/SES exit path retired from the critical path (volume made it moot); the adapter seam still admits them. VERIFY at build: relay enabled in Admin console; auth mode; whether the relay accepts envelope senders on a **subdomain** — fallback is plain `no-reply@gaiada.com` / `notifications@gaiada.com` (simpler, loses subdomain separation). |
| M3 | Hostinger SMTP unpinned (wrong tool; possible port block on KVM8 — verify before Zone B). | **Unchanged.** |
| M4 | Three sending identities, three separate credentials | **REVISED to concrete domains**: `auth.gaiada.com` (magic links/resets — employees live in this Workspace: best trust + deliverability), `notify.gaiada.com` (approval + risk-warning mail, and the inbound reply address), `forms.gaiada.online` (Zone B client-site form mail — **must stay off `gaiada.com`**: it is the only internet-triggerable stream and gaiada.com carries real employee email). Reputation-isolation rationale unchanged. |
| M5 | `From:` our own domain, `Reply-To:` the actual human (Zone B default); per-tenant send-as-own-domain opt-in. | **Unchanged** (Zone B). Zone A addition: **system mail always sends from a system identity, never as an individual employee**, even though the Gmail API could send as a user. |
| M6 | Zone A mail does NOT route through Zone B C-03. | **Unchanged.** |
| M7 | Portal notification email digests by default | **WITHDRAWN — email digest cancelled.** Email is not a notification channel. The 12:00/18:00 WITA rollup is the WA/Telegram group digest (bot's job, out of scope here). |
| M8 | Magic links carry a latency SLO measured before auth depends on the provider; separate auth stream/key. | **Unchanged.** |
| M9 | *(new)* Email fires ONLY on: (a) automation/AI performing a **medium-or-higher-risk** action — attached to the **existing** WS4 impact classification, no new classifier (§7.1); (b) anything **requiring human approval**, routed to the responsible person (§7.2). Approval mail to a *required* decider is **not opt-out-able** — no preference surface. | New, locked. |
| M10 | *(new)* Clients ride the **same** mechanism — a client sign-off request IS "something needing human approval". No separate client notification stream. | New, locked. |
| M11 | *(new)* Approval emails carry a **deep link to the ERP entity only** — never an action button, never approve-by-reply (sender addresses are forgeable ⇒ approval forgery), **never a magic link** (a bearer credential in an inbox). Valid session → straight through; expired → normal SSO reauth first (§7.5). | New, locked. |
| M12 | *(new)* Sequencing: (1) warning stream first (informational, zero D14 dependency); (2) the **D14 resume path** is the hard prerequisite for (3) actionable approval mail on automation/agent suspensions — because today, approving a suspended automation write **executes nothing** (§7.4). Warning-stream wording must never imply an approval action completed anything. | New, locked. |
| M13 | *(new)* Inbound: system-mail threads via `reply+<token>@notify.gaiada.com` → provider inbound webhook (or single-mailbox IMAP poll) → `mail_messages`, threaded onto the originating entity. Inbound is UNTRUSTED input (§7.6). Still no mailbox hosting of ours. | New, locked. |
| M14 | *(new)* Staff Gmail in the ERP: **internal-type OAuth app** in the gaiada.com Workspace (exempt from restricted-scope verification + CASA ⇒ free; consequence: **employees only** — including clients would flip it External + paid assessment; client conversation stays on the M13 thread channel). **NO domain-wide delegation** — per-user OAuth only, individually consented + revocable, narrowest workable scope. **Render on demand, cache nothing** — no mail content in the ERP DB (Google keys land in staging; real employee mail must never be mirrored into a staging database). Gmail API cost: free with Workspace seats; quota/policy specifics are **VERIFY-AT-BUILD-TIME**. | New, locked. |
| M15 | *(new, v3)* **The dev stage must not block on any real external key.** DNS holder, Workspace admin, Brevo, and Google credentials are simulated in dev (Mailpit sink, fixture corpus, fixture `GmailClient`); every simulation gets a row in the Staging Reopen Register (§15) and its ticket ACs are **reopened and re-verified at the staging stage**. Dev evidence comes from real runs on gda-aicenter — local stack stays OFF per the standing 2026-07-31 decision. | New, locked. |

### 3.2 Architect decisions (revisable with cause)

| # | Decision | v2 status |
|---|---|---|
| A1 | `src/mail/` is core infrastructure, not a `ModuleContract` module (no per-tenant enable gate; same class as `src/events/`). | Unchanged. |
| A2 | PG-backed queue (`mail_log` doubles as spool), `FOR UPDATE SKIP LOCKED`, chained-`setTimeout` sweeper, env-gated. Not BullMQ, not the outbox (Redis is optional in platform-nest; auth mail can't ride an optional dependency). | Unchanged. |
| A3 | SMTP (nodemailer) is the v1 transport; adapter interface admits HTTP-API transports later. New dependency: `nodemailer` only. | Unchanged — and now even easier: relay + Brevo both speak SMTP. |
| A4 | Mail tables are GLOBAL; `tenant_id` is nullable provenance. Forced by F2 (§6.1). | **AMENDED by MAIL-22 (2026-08-05):** still global/not-tenant-isolated, but they now carry **FORCE RLS** with a GUC-gated `mail_context` policy (the `0015_site_subscriptions_rls.sql` pattern) instead of no RLS. "No RLS" broke `rls.test.ts`'s FORCE-RLS invariant — see the superseding note in §6.1. Covers all three tables. |
| A5 | Email rides exclusively on `notifications` rows — the single tap is inside `notify()`, post-insert, fail-soft. | **Kept as the mechanism, allowlist collapsed**: the tap fires for exactly two types (§7.2). The invariant survives: you are only ever emailed about something that is in a bell (yours or, for clients, their portal bell). Auth/ops mail excepted as before. |
| A6 | Templates are code (TS functions keyed by `template_key`), not DB rows. | Unchanged. |
| A7 | One cross-tenant daily digest per user. | **WITHDRAWN with M7.** |
| A8 | *(new)* **Failover is an operator action, not automatic**: per-stream transport selected by env (`relay` \| `brevo`); a WS9 alert on failure rate tells the operator to flip. At a handful of mails/day, automatic failover machinery (health probes, double-send risk on misclassified errors) costs more than it protects. | New. |
| A9 | *(new)* Inbound replies that match no live `reply_token` are logged (counter + log line) and dropped with 204. This is a **system-thread reply channel, not a mailbox** — there is no orphan inbox to triage in v1. | New. |
| A10 | *(new)* Thread reads are authorized against the **parent entity** (`authorize()` on the entity kind the thread hangs off), never against the global mail tables directly. That is the compensating control for `mail_messages` being global (§6.1). | New. |
| A11 | *(new, v3)* **Dev mail sink = Mailpit on gda-aicenter**, a service in `infra/compose/docker-compose.vps.yml` under a new `mail-dev` profile (§4.3). All dev SMTP (platform, Keycloak, Alertmanager) points at `mailpit:1025` over the compose network — zero SMTP egress. UI/API (:8025) published **loopback-only** on the box, reached over an SSH tunnel: the sink holds live password-reset links and must never be internet-reachable. The Mailpit HTTP API is the evidence surface for ACs — scriptable assertions, not screenshots. | New. |
| A12 | *(new, v3)* **No domain literals in mail code.** Every domain/subdomain/host and the deep-link base (`MAIL_LINK_BASE_URL` — new; no ERP public-base config existed) is env config. Compiled-in defaults use RFC-2606 reserved TLDs (`notify.gaiada.invalid`, `auth.gaiada.invalid`, `https://erp.gaiada.invalid`) so a missed env var is obviously fake and can never resolve or deliver. Enforced by a grep gate in the ACs: zero `gaiada.com`/`gaiada.online` occurrences under `src/mail/`, mail templates, and mail UI code — fixtures/tests included (they use reserved TLDs too). Staging swap = `.env` change only. | New. |
| A13 | *(new, v3)* **The inbound fixture corpus is the permanent regression suite, not dev scaffolding.** A live provider will never conveniently send forged senders, replayed message-ids, oversized bodies, or hostile HTML on demand — the committed corpus is a **higher-fidelity adversarial test than a live provider** and stays in CI forever; staging APPENDS real-captured samples rather than replacing anything (v4: "incl. real signatures" struck — Brevo has none, §7.6; and A13 is now VINDICATED by execution: the corpus caught three type-check-invisible defects, incl. the `<embed>` void-element byte-loss bug, before any live traffic existed). | New. |
| A14 | *(new, v3)* **Gmail dev scope = the seam only.** Dev builds the `GmailClient` interface + a fixture-backed implementation + a shared contract-test suite (MAIL-16D). The OAuth link flow, live adapter, and reading-pane UI are deliberately deferred to the staging window — full reasoning in §8C. | New. |
| A15 | *(new, v4)* **Quoted-history handling: heuristic-free head+tail cap at intake, quote-collapse heuristics at render, and intake-side quote STRIPPING stays forbidden.** The intake body cap keeps the head AND the tail of an over-cap plain-text body (explicit mid-elision marker), so a human's reply survives whether top- or bottom-posted — without intake ever interpreting content. Render detects quote boundaries and collapses history behind an expander, where a wrong guess costs a click instead of data. Storing only an extracted "reply portion" is REJECTED: the raw MIME is never stored, so a misfired heuristic would destroy the only copy of a human's words. Full reasoning §7.6; tickets MAIL-19 (intake) / MAIL-20 (render). | New. |

## 4. Architecture

```
                     ZONE A (platform-nest)                              PROVIDERS
┌────────────────────────────────────────────────────────────┐   ┌───────────────────────────┐
│ approval created (automation_approvals / agency_approvals) │   │ Google Workspace SMTP     │
│   └─ MAIL-06: notify() each resolved decider  ─────────┐   │   │ relay (PRIMARY, Zone A)   │
│ pipeline gate opened (client-notify.ts, EXISTS) ───────┤   │   │  auth.gaiada.com          │
│                                                        ▼   │   │  notify.gaiada.com        │
│ notify() ──inserts──▶ notifications (in-app, unchanged)    │   ├───────────────────────────┤
│    │ A5 tap (fail-soft): type ∈ {approval.requested,       │   │ Brevo                     │
│    ▼            pipeline.gate.opened} ONLY                 │   │  · Zone A failover (env)  │
│ mail_log (queued; entity ref + reply_token) ───────────────┼──▶│  · INBOUND webhook  ◀─MX──┼── reply+<token>@
│                                                            │   │  · Zone B forms.gaiada.   │   notify.gaiada.com
│ Sender worker (chained setTimeout, SKIP LOCKED, backoff,   │   │    online (later, C-03)   │
│   auth-stream-first) ──────────────────────────────────────┼──▶└───────────────────────────┘
│                                                            │
│ POST /api/mail/webhooks/brevo   ◀── delivery/bounce events │
│ POST /api/mail/inbound/brevo    ◀── inbound replies ───────┼── sanitize/cap/scan → mail_messages
│                                                            │      └─ threads onto the entity
│ Keycloak realm SMTP (auth stream) ── native flows ─────────┼──▶ relay
│ Alertmanager SMTP (notify stream) ── alert path ───────────┼──▶ relay
│                                                            │
│ ERP surface: /admin/mail (log+threads) · entity thread     │
│   panels · [staging] Gmail read pane (render-on-demand)    │
└────────────────────────────────────────────────────────────┘
```

Keycloak and Alertmanager speak SMTP to the relay **directly** with the appropriate stream's
credentials — config consumers, not module callers.

**Dev stage (v3):** the entire right-hand PROVIDERS column is replaced by the **Mailpit sink**
(`mailpit:1025`, same compose network — §4.3); the inbound webhook is fed by the fixture replay
harness (§7.6) instead of Brevo, and the Brevo delivery-event webhook receives nothing (rows cap
at `sent`, honestly rendered — §7.7). The swap back is env-only (A11/A12); no code knows which
stage it is in.

### 4.1 Provider adapter interface (unchanged contract; webdesk C-03 copies it later)

```ts
// src/mail/provider.ts — the seam. Swap = config; no caller sees a provider name.
export type MailStream = "notify" | "auth";          // Zone B adds "forms"
export interface MailAddress { email: string; name?: string }
export interface OutboundMail {
  stream: MailStream;                                 // picks identity + credentials
  to: MailAddress;                                    // one recipient per row
  replyTo?: MailAddress;                              // threading: reply+<token>@notify.gaiada.com
  subject: string;
  html: string;
  text: string;                                       // always both parts
  headers?: Record<string, string>;
}
export interface SendResult { ok: true; providerMessageId?: string } // throw on failure
export interface MailProviderAdapter {
  readonly name: string;                              // 'smtp' | 'dev-log' | later 'brevo-api'…
  send(mail: OutboundMail): Promise<SendResult>;
  verify?(): Promise<void>;                           // boot-time config sanity (fail-soft, logged)
}
```

v1 implementations: **`smtp`** (nodemailer; per-stream transports from env — relay or Brevo per
A8) and **`dev-log`** (default when unconfigured; the whole module is dark without config).
`From:` derived per stream, never caller-supplied. `subject` header-sanitized (strip CR/LF),
`to.email` validated; header-injection probes are a QA item.

Per-stream env (ALL must also be added to the `platform` service `environment:` block in
`infra/compose/docker-compose.vps.yml` — §10):

```
MAIL_ENABLED=0|1                       # master gate; 0 = dev-log adapter, nothing leaves the box
MAIL_STREAM_NOTIFY_TRANSPORT=relay|brevo     # A8 operator failover flip (dev: the relay SLOT points at the sink)
MAIL_STREAM_NOTIFY_RELAY_HOST/PORT/USER/PASSWORD   # dev: mailpit / 1025 / empty creds (authless)
MAIL_STREAM_NOTIFY_BREVO_HOST/PORT/USER/PASSWORD
MAIL_STREAM_NOTIFY_FROM                # A12: compiled default "Gaiada Dev <no-reply@notify.gaiada.invalid>";
                                       #      staging .env sets the real notify.<root> identity
MAIL_STREAM_AUTH_* (same shape)        # default FROM "Gaiada Sign-in <no-reply@auth.gaiada.invalid>"
MAIL_REPLY_DOMAIN                      # VERP reply domain; default notify.gaiada.invalid
MAIL_LINK_BASE_URL                     # deep-link base for templates (A12 — new; nothing existed);
                                       #   default https://erp.gaiada.invalid; gda-aicenter .env sets
                                       #   https://erp.gaiada.online (env, never code)
MAIL_WEBHOOK_TOKEN=<random>            # provider delivery-event intake
MAIL_INBOUND_TOKEN=<random>            # inbound intake auth — v4: Brevo offers NO signatures, so
                                       #   this header token IS the whole provider scheme (§7.6)
MAIL_INBOUND_SIGNING_KEY=              # v4, OPTIONAL — OUR HMAC defence-in-depth layer (NOT a
                                       #   Brevo scheme); once set, a valid signature is REQUIRED
MAIL_INBOUND_SIGNATURE_TOLERANCE_S=300 # v4 — replay window for OUR signature scheme
MAIL_INBOUND_MAX_BYTES=5242880         # total inbound message cap (5 MB default) — whole-delivery
                                       #   REFUSAL, applied pre-parse (§7.6 v4 cap semantics)
MAIL_INBOUND_MAX_ATTACHMENT_BYTES=10485760  # v4 — per-attachment cap: DROP-but-thread (§7.6)
MAIL_INBOUND_MAX_ATTACHMENTS=10        # v4 — count cap: same drop-but-thread semantics
MAIL_INBOUND_RATE_PER_MIN=…            # v4 — per-source intake rate limit
MAIL_INBOUND_SCAN=off|clamav           # attachment scanning (§7.6)
MAIL_CLAMAV_HOST/PORT/TIMEOUT_MS       # v4 — clamd client wiring (MAIL-14 service)
MAIL_SENDER_INTERVAL_MS=15000
MAIL_MAGIC_LINKS_ENABLED=0|1           # §9 — stays 0 for real users until the staging SLO gate (§15 R5)
```

**Transport TLS rule (v3):** the `smtp` adapter sends credentials only over TLS — when
`USER`/`PASSWORD` are set, `requireTLS` is forced on; when both are empty (the dev sink),
plaintext is allowed; otherwise nodemailer's opportunistic STARTTLS applies. This makes the
authless Mailpit hop legal in dev while making leaked-creds-over-plaintext unrepresentable at
staging.

(If the relay refuses subdomain envelope senders — M2 VERIFY, §15 R1 — the `*_FROM` values fall
back to root-domain addresses and `MAIL_REPLY_DOMAIN` needs the same re-check for the inbound MX
host. All of that is a staging `.env` edit under A12, which is the point.)

### 4.2 Domains, DNS, and the guardrails (owner-confirmed; supersedes v1 Q1)

> **STAGING-STAGE section (v3).** Nothing below executes in dev — it is the MAIL-01A/01B reopen
> content, tracked as §15 R1–R3/R9. Dev uses `*.gaiada.invalid` defaults + the Mailpit sink (§4.3).

The ERP is served on `gaiada.online`; **all employee mail is Google Workspace on `gaiada.com`.**

| Identity | Purpose | Provider path |
|---|---|---|
| `auth.gaiada.com` | Magic links, password reset, verify-email (Keycloak) | Workspace relay |
| `notify.gaiada.com` | Approval + risk-warning mail; **inbound** `reply+<token>@` | Outbound: relay (Brevo failover). **Inbound: MX → Brevo inbound** (§7.6) |
| `forms.gaiada.online` | Zone B client-site form mail (internet-triggerable) | Brevo — **stays off gaiada.com** |

DNS guardrails (binding on the devops ticket):

- Adding `auth`/`notify` subdomain records — **including the MX on `notify.gaiada.com`** —
  cannot affect Workspace mail: Workspace MX lives on the **root**, and subdomain SPF/DKIM
  resolve at the subdomain. The ticket must **not touch root MX or root SPF** (asserted in its AC).
- Check whether `_dmarc.gaiada.com` sets a policy — **subdomains inherit unless `sp=` is set**;
  publish per-subdomain `_dmarc` records so the sending subdomains carry their own policy either way.
- Subdomain SPF must include BOTH senders (`include:_spf.google.com` for the relay + Brevo's
  include, so the failover flip needs no DNS change). DKIM: relay signs with the Workspace root
  domain — relaxed DMARC alignment covers a subdomain `From:`; verify alignment on a real header
  during MAIL-01A, and add Brevo's DKIM keys per identity.
- **Who holds DNS for `gaiada.com`** — resolving the custodian is step 0 of MAIL-01A **at the
  staging reopen** (§15 R1). Under M15 this is no longer a blocker of anything in dev.

### 4.3 Dev-stage provider simulation — Mailpit on gda-aicenter (v3; M15/A11)

**Why the server, not local:** the standing 2026-07-31 owner decision — local stack OFF,
gda-aicenter is truth. Dev-stage evidence must come from real runs on the box.

- **Service:** `mailpit` in `infra/compose/docker-compose.vps.yml` — the same file/project as its
  consumers, so `keycloak`, `platform`, and the Alertmanager pair reach `mailpit:1025` natively.
  Pinned image tag (`axllent/mailpit:v1.x` — pin the current release at build time, per estate
  practice). SMTP `:1025` internal-only; UI + API `:8025` published **on the server loopback
  only** (`127.0.0.1:8025:8025`), reached via `ssh -L 8025:localhost:8025 gda-aicenter`. Never
  internet-exposed — it holds live password-reset links. Persist `MP_DATABASE=/data/mailpit.db`
  on a named volume so captured evidence survives restarts.
- **Profile + the two deploy traps (both have bitten this repo before):**
  1. `profiles: [mail-dev]` — and `mail-dev` MUST be added to the GitHub repo variable
     `COMPOSE_PROFILES` in the same change. `deploy.yml` passes that variable to every compose
     call and runs `up -d --remove-orphans`: a project service whose profile is not in the
     variable is **deleted on the next deploy** (the whisper near-miss). Update deploy.yml's
     lane comment (`data,bot,auth,multisite,whisper,jobs`) too.
  2. Compose env passthrough — Mailpit itself needs no platform env, but every `MAIL_*` var the
     platform consumes must be listed in the `platform` service `environment:` block in the same
     ticket that introduces it (§10; 4+ features have shipped silently disabled this way).
- **Evidence surface:** Mailpit's HTTP API — `GET /api/v1/messages`,
  `GET /api/v1/message/:id`, `GET /api/v1/search?query=…`, `DELETE /api/v1/messages` (reset
  between runs) — so ACs assert by curl over the tunnel, not by screenshot.
- **At staging:** the swap is `.env` only (relay host/creds per stream, real `*_FROM` domains per
  §4.2); the sink service can stay (it receives nothing once env points away) or its profile is
  dropped from `COMPOSE_PROFILES`. ClamAV (MAIL-14) deliberately does NOT share the `mail-dev`
  profile — real inbound at staging still needs scanning, so it lives under its own `scan`
  profile and survives the sink's retirement.

## 5. Data model — migration **landed as `0077_mail_core.sql`** (was cut as `0076`)

> **Ledger note (re-verified AGAIN 2026-08-04 for v3, `ls platform-nest/migrations | sort | tail`
> — other sessions are actively landing migrations):** head is still `0075_client_portal.sql`;
> `0071_it_network_discovery.sql` has landed **since the v2 check** (closing half of the 0070/0071
> gap the `0014a` cut flagged). `0058`/`0059` are permanently-orphaned reservations — do NOT
> fill. `0070` is still claimed by the **unlanded staged file**
> `docs/superpowers/plans/wd23a-1/0070_core_google_oauth_states.sql.staged` — do NOT fill.
> **Next unused is still `0076` → `0076_mail_core.sql`.** The Gmail provider-CHECK widening (§8B) and
> the magic-link table (§9) ship in their own later migrations at whatever numbers are then free
> (deliberately NOT reserved — reservations have rotted 3× in this repo). Per
> `migrations/README.md` rule 5, re-run the listing immediately before writing DDL.
>
> **v4 ledger outcome (what actually happened — rule 5 earned its keep):** the note above was
> itself stale by SEVEN numbers at build time, and `0076` was taken **mid-session** by a
> concurrent session landing `0076_core_google_oauth_states.sql` (WD-23A-1). Mail core shipped as
> **`0077_mail_core.sql`** — DDL as sketched below, number different;
> `platform-nest/migrations/README.md` carries the drift record. Head at v4 writing time is
> `0078_automation_approval_execution.sql` (the D14 program's first migration — §7.4). Every
> `0076` reference in this doc and the ticket plan reads as `0077`; the magic-link and Gmail-CHECK
> migrations still take the then-current next-unused number at their own build time.

```sql
-- 0077_mail_core.sql (cut as 0076; renumbered at land time per README rule 5) — GLOBAL tables
-- (no RLS; §6.1). platform_owner creates them; default
-- privileges auto-grant DML to platform_app. No backfill DML — nothing whose effect depends on
-- what RLS lets the runner see — so the 0052+ CI backfill/RLS lint has nothing to bite on
-- (stated so nobody goes looking for the missing backfill).

CREATE TABLE mail_log (
  id uuid PRIMARY KEY,
  stream text NOT NULL CHECK (stream IN ('notify','auth')),
  tenant_id uuid REFERENCES companies(id),        -- provenance; NULL for auth mail
  user_id uuid REFERENCES users(id),              -- recipient user when known
  to_email text NOT NULL,
  template_key text NOT NULL,                     -- 'approval.warning' | 'approval.actionable' | 'auth.magic_link' | …
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',            -- template input, PII-lean (ids + titles, never bodies twice)
  notification_ids uuid[] NOT NULL DEFAULT '{}',  -- the notifications rows this mail carries (A5 audit trail)
  entity_type text,                               -- the triggering entity (log UI + threading):
  entity_id uuid,                                 --   'automation_approval' | 'agency_approval' | 'pipeline_run' | …
  reply_token text UNIQUE,                        -- VERP inbound correlation; NULL = no-reply mail (128-bit CSPRNG, base64url)
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','delivered','bounced','failed','suppressed')),
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  provider text, provider_message_id text,
  queued_at timestamptz NOT NULL DEFAULT now(),
  provider_accepted_at timestamptz,               -- SMTP 250 time (M8 instrumentation)
  delivered_at timestamptz,                       -- from provider webhook (Brevo sends only — the relay has no event feed; §7.7)
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_log_due_idx    ON mail_log (next_attempt_at) WHERE status IN ('queued','sending');
CREATE INDEX mail_log_user_idx   ON mail_log (user_id, created_at);
CREATE INDEX mail_log_tenant_idx ON mail_log (tenant_id, created_at) WHERE tenant_id IS NOT NULL;
CREATE INDEX mail_log_entity_idx ON mail_log (entity_type, entity_id) WHERE entity_id IS NOT NULL;

CREATE TABLE mail_suppressions (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  stream text NOT NULL DEFAULT '*',
  reason text NOT NULL CHECK (reason IN ('hard_bounce','complaint','manual')),
  provider text, detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email, stream)
);

-- Inbound replies to system mail (M13). UNTRUSTED CONTENT: body_html_sanitized has already been
-- through the server-side allowlist sanitizer at intake; the raw MIME is never stored.
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY,
  mail_log_id uuid NOT NULL REFERENCES mail_log(id),  -- the outbound mail this replies to (via reply_token)
  tenant_id uuid REFERENCES companies(id),            -- copied provenance from mail_log
  entity_type text, entity_id uuid,                   -- copied from mail_log (threading denorm)
  provider text NOT NULL,                             -- 'brevo-inbound' | 'imap-poll'
  provider_message_id text NOT NULL,                  -- idempotency key
  from_email text NOT NULL,      -- DISPLAY METADATA ONLY — sender addresses are forgeable; never
                                 -- used for authorization or matching (the reply_token is the match)
  subject text,
  body_text text NOT NULL,
  body_html_sanitized text,
  attachments jsonb NOT NULL DEFAULT '[]',            -- [{fileRef, name, bytes, scanStatus: 'pending'|'clean'|'infected'|'skipped'}]
  size_bytes int NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  origin_site text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_message_id)
);
CREATE INDEX mail_messages_entity_idx ON mail_messages (entity_type, entity_id, received_at);
CREATE INDEX mail_messages_log_idx    ON mail_messages (mail_log_id);
```

**Dropped from v1 DDL:** `mail_notification_prefs` (no preference surface — M9: required-approval
mail is not opt-out-able; suppressions remain the only mute, and they're bounce-driven, not
chosen) and `mail_digest_runs` (digest cancelled). Retention: `payload`/`subject`/`body_*` are the
content columns; a later janitor can null them after 90 days (follow-up, not v1).

### 5.1 Suppression semantics (unchanged from v1)

- `hard_bounce`/`complaint` → `stream='*'`; enqueue-time check writes `status='suppressed'`
  (auditable, never sent). Exact lowercased address match only.
- **Auth-stream exception:** suppression still applies, but the magic-link API surfaces
  "delivery unavailable — contact an admin" instead of silently succeeding (§9) — a suppressed
  auth address must never look like a sent one.

## 6. Multi-tenancy + RLS posture

### 6.1 Why the mail tables are global (A4/F2) — the forced move, shown (preserved from v1)

> **⚠️ SUPERSEDED IN PART — MAIL-22 (2026-08-05, owner-approved).** The reasoning below is correct
> about the **standard `tenant_isolation` policy**, but its conclusion — "no RLS at all" — was wrong,
> and shipping it broke a real invariant: `src/db/rls.test.ts`'s *"every tenant-scoped table has
> FORCE RLS"* selects every table carrying a `tenant_id` column, so `mail_log` and `mail_messages`
> made the mail module the first FORCE-RLS violation in the estate. That test exists precisely to
> catch forgotten RLS, and widening it would have degraded the guard for every future table.
>
> The escape was already in the codebase: `0015_site_subscriptions_rls.sql` keeps a
> **non-tenant-isolated** table under FORCE RLS by gating a policy on a GUC. RLS never required the
> `tenant_id = ANY(<set>)` predicate — only the standard policy did.
>
> **Actual shipped design:** all three mail tables carry `ENABLE` + `FORCE ROW LEVEL SECURITY` plus a
> `mail_context` policy — `USING/WITH CHECK (current_setting('app.mail_context', true) = 'on')` —
> whose predicate ignores `tenant_id` entirely, so NULL-tenant auth mail stays fully readable and
> writable and F2 is not recreated. A new `withMailContext()` in `src/db/index.ts` sets it inside a
> transaction (`withGlobal` has no transaction, and `SET LOCAL` needs one); `withGlobal` itself is
> unchanged, so `users`/`identity_links` callers are unaffected. `0077` was amended in place rather
> than superseded, since it had never been applied to any persistent database.
>
> **Be precise about what this buys:** it is defence in depth, not a new primary gate. Code that sets
> the GUC still sees all mail rows. What it restores is the catch on cross-tenant reads from code
> that forgot to establish context — exactly the failure the invariant guards. The compensating
> controls listed below remain the primary authorization, and every one of them still applies.

The platform's standard posture is FORCE RLS + `tenant_isolation` on the authorized-tenant-set
GUC. Mail cannot use **that policy**, for a structural reason:

1. Auth mail has **no tenant** (`tenant_id NULL` — magic links exist before any tenant context).
2. Under the standard policy, `tenant_id = ANY(<set>)` is NULL for a NULL tenant ⇒ the row is
   invisible to **every** tenant-scoped query.
3. It is also invisible to `withGlobal` (FORCE RLS + unset GUC ⇒ policy false) and to
   migrations/scripts — `platform_owner` is deliberately NOBYPASSRLS (the 0050 trap class). A
   NULL-tenant row in a FORCE-RLS table is readable by **nobody**, as a permanent design property.

**Recommendation stands: global tables**, same class as `users`/`identity_links` (the sanctioned
`withGlobal` surface per `src/db/index.ts`). Compensating controls, since RLS is not doing the
work here:

- User-facing read paths, complete list: elevated-only `GET /api/admin/mail/log[/:id[/thread]]`
  (isElevated, filterable by tenant/stream/status/entity), and the entity-thread read
  `GET /api/:tenantId/mail/threads?entityType&entityId` which is authorized by an `authorize()`
  call **on the parent entity** (A10) before any global-table read happens — a caller who cannot
  read the approval/run cannot read its thread. The portal reuses the same rule through the
  portal BFF (portal-scope predicate applies to the entity first).
- All writes are internal code paths (tap, sender, webhook + inbound intake). There is no
  "send arbitrary mail" endpoint at any privilege.
- Tests must include: non-elevated caller 403s on admin log; thread read 403s/404s exactly as the
  parent entity does; no endpoint serializes `mail_log.payload` or `mail_messages.body_*` to a
  caller who fails the entity check.

### 6.2 Tenancy of content

Approval/warning mail carries exactly one notification's context ⇒ its `tenant_id`. Inbound
messages copy provenance from the outbound row they answer. Auth mail is `tenant_id NULL`. (The
v1 cross-tenant digest case is gone with the digest.)

## 7. Send + receive paths

### 7.1 What triggers mail — attached to the EXISTING risk classification (M9a)

**No new classifier is built.** The estate already classifies automation writes:

- `ModuleContract.mcpTools[].impact ∈ {low, medium, high}` (`src/modules/contract.ts`) — declared
  per tool at module level.
- The **mcp-hub write gate** (`mcp-hub/src/policy.ts` + `automation-policy.ts`, WS4 §3/D14) lets
  **low**-impact automation writes run unattended and refuses **medium / high / unclassified**
  with a `suspend:` reason; the workflow then files `approvals.request` → a row in
  `automation_approvals` with `impact ∈ {medium, high, unclassified}`
  (`automation-approvals.controller.ts` — `IMPACTS` allows exactly that set).
- WS8 agent writes bubble into the same surface (`origin='agent'`).

**Mail trigger for (a):** the creation of an `automation_approvals` row with origin
`automation|agent` — i.e. exactly "an automation was about to perform a medium-or-higher-risk
action and was suspended". By construction, low-impact actions neither suspend nor mail;
`unclassified` suspends (fail-closed) and therefore mails. There is no path where a medium+
automation write executes without first landing in this table — so "about to do X" and "requires
approval" are the same row; what differs is the **wording** (§7.4).

### 7.2 What triggers mail — anything requiring human approval (M9b/M10)

The unified approvals surface (`GET /api/approvals`, `approvals.controller.ts`) already
enumerates every human-approval ask in the ERP, from three sources:

| Origin | Source table | Created by | Mail recipients (the resolved decider set, §7.3) |
|---|---|---|---|
| `automation` / `agent` | `automation_approvals` | hub gate suspension | tenant `company_admin` + `group_executive` members |
| `hr` | `automation_approvals` (origin='hr') | leave request flow | the above **+** the providing unit's `hr_manager` (module_manager scoped to module='hr', WSD-2/WSD-4) |
| `agency` | `agency_approvals` | brief/asset review submission | **settled (ex-Q-V8, v4):** `company_admin` + `module_approver` → concretely **`agency_approver`** — the policy's `approve` action set (it has no `decide` action); NOT `group_executive` (§7.3) |
| `pipeline` | `pipeline_gates` | gate opens (PRD sign, scope sign-off, feedback) | **clients**: `resolveClientRecipients()` (`client-notify.ts`) — active contacts, project-scoped, `capability='signer'` only for signature gates; **staff-decided gates**: run owner (fallback creator) |

The mail mechanism is the v1 tap, with the allowlist collapsed to exactly **two** notification
types: `approval.requested` (NEW — MAIL-06 adds it for automation/agent/hr/agency creates) and
`pipeline.gate.opened` (EXISTS — client-notify.ts already emits it). Nothing else in the bell
produces email. `mention`, `comment`, `approval_decided`, `hr.leave.decided`, `scope.signed`,
assignments, trackers — all stay in-app only (v1's broader `IMMEDIATE_TYPES` list is withdrawn).

`mailIntake(n)` (inside `notify()`, post-insert, fail-soft — a thrown mail error must never fail
the calling write path, test-pinned):

```
if !MAIL_ENABLED → return
if n.type ∉ {approval.requested, pipeline.gate.opened} → return
resolve email: users.email (NOT NULL UNIQUE since 0001 — client contacts are users rows too,
               so one resolution path serves staff and clients: M10)
suppression check → enqueue mail_log(stream='notify',
    template = wordingClass(n)  — §7.4,
    tenant_id = n.tenant_id, entity ref from payload, notification_ids=[n.id],
    reply_token = new token)
```

Volume: suspensions + gate opens are a handful per day across the estate — the provider
free-tier question is moot at any provider, and the Workspace relay (~10k/day) is comfortably
oversized. (F1 corollary: mail volume ≈ approvals volume because the tap has no other inputs.)

### 7.3 Approver resolution — F1, and whether a "decider" exists (preserved + extended)

**F1 (verified again 2026-08-04):** creating an approval notifies nobody today.
`automation-approvals.controller.ts` `create()` inserts + `writeActivity` — no `notify()`, no
outbox event. `agency.controller.ts`'s two `agency_approvals` INSERT paths likewise notify
nobody (only the decide path notifies — `approval_decided` back to the requester). The approvals
inbox is pull-only on the request side. Only pipeline gates notify on open (client-notify.ts).
**MAIL-06 closes this for the in-app bell AND gives email its substrate** — a real existing UX
gap, not just mail plumbing. **v4 correction: this enumeration was incomplete** — a third live
`automation_approvals` insert site (the Google-Ads change-proposal suspend path,
`modules/search/search.controller.ts`) was equally broken and was NOT named here; MAIL-06 found
and fixed it with the same shared resolver, so the wired set is FOUR create sites (automation
controller, hr `fileLeave()`, agency's two paths, search's suspend path — the latter riding the
automation-controller origin). See the header F1 correction.

**Does a decider concept exist?** Not as data. There is **no per-approval decider column** and no
assignment step anywhere in the schema. "Who may decide" exists only as Cerbos policy:

- `resource_automation_approval.yaml`: `decide` → derived roles `company_admin`,
  `group_executive`; plus `read`+`decide` for `module_manager` when `resource.attr.module == "hr"`
  (the providing unit's hr_manager).
- `resource_pipeline_gate.yaml`: staff `decide`; client-side gates decide via
  `resource_portal.yaml` (`decide`/`sign`) with `portal-scope.ts` row predicates.
- `resource_agency_approval.yaml`: **settled at build (ex-Q-V8, v4)** — the policy has **no
  `decide` action**; its decide-equivalent is **`approve`**, granted to derived roles
  `company_admin` + `module_approver`. `module_approver` string-composes `"<module>_approver"`
  and the controller always passes `module: "agency"`, so the concrete role is
  **`agency_approver`**. NOT `group_executive` — that role decides `automation_approval` only.
  Mirrored (routing only, Cerbos stays authoritative) in `src/core/approval-deciders.ts` (MAIL-06).

**Resolution rule (v1): mail the mirrored Cerbos DECIDE set, resolved via the role/membership
tables at create time** — the same resolution direction the code already uses elsewhere
(Cerbos answers "may X decide?"; the role tables answer "who are the X?"). The sets are small
(1–3 admins per tenant; named signer contacts per client). Requester is self-skipped (notify()
already skips self). **An explicit per-approval decider assignment (route to ONE named person) is
a real future refinement — it needs schema + assignment UI + reassignment/escalation semantics —
and is deliberately NOT in this program.** If the owner wants single-person routing, that is a
new design conversation, flagged as an open question (§14 Q-V4).

### 7.4 Sequencing and wording — the D14 constraint (M12)

**D14 has no resume path**: approving a suspended automation write executes NOTHING.
`automation-approvals.controller.ts`'s own header says it — "v1 records + decides; it does NOT
re-drive the approved tool call (a Temporal/durable concern the spec defers)." An email saying
"approve this" while approving does nothing would manufacture false confidence that a high-risk
action ran. Therefore two **wording classes**, chosen per origin by whether deciding actually
executes its full effect today:

| Wording class | Origins | Rationale |
|---|---|---|
| `approval.warning` — *"Automation X requested ⟨tool⟩ (impact: high) in ⟨company⟩. **It is suspended; nothing has run.** Review it in the ERP: ⟨link⟩"* | `automation`, `agent` | Deciding records a verdict but re-drives nothing (D14 gap). The mail is purely informational and must **never** contain approve/reject language or imply a decision executes anything (test-pinned wording gate). |
| `approval.actionable` — *"Your decision is needed on ⟨subject⟩: ⟨link⟩"* | `pipeline` (deciding records the signature/feedback and the pipeline advances), `hr` (the leave-decision event handler consumes `automation_approval.decided` and applies it — WSD-4), `agency` (the review state change IS the effect) | Deciding does what it says today, so the mail may say so. |

Build sequence (binding on the ticket plan):

1. **Warning stream first** — ships the whole mail spine (send, log, log UI, inbound threading)
   into production with zero D14 dependency and zero false promises.
2. **D14 resume path** — OUT OF SCOPE for this program to build, and the **hard prerequisite**
   for step 3. Cross-references: the controller header above; the WS4 completion state
   ("only Temporal/minted-creds remain"); the standing platform-wide gap record that with the
   DEF-2 race this makes **Temporal a real decision, not speculative** (full-fidelity register +
   `2026-08-03-agentic-native-erp-plan.md`, where the D14 resume path is named the top blocker).
   **v4 update:** the resume path is now an executing program of its own —
   `docs/superpowers/plans/2026-08-05-d14-resume-path-plan.md`, whose first migration
   `0078_automation_approval_execution.sql` (splitting execution state from decision state on
   `automation_approvals`) has landed. The step-3 wording flip stays gated on that program
   **completing** (an execution-status column existing is not a resume path), stays a
   one-constant change, and requires an architect design-review at flip time because the flip
   converts a safety wording into an executable promise.
3. **Actionable approval mail for automation/agent** — flip the wording class only once approving
   actually executes. A one-constant change by design (the wording class is data on the origin).

### 7.5 Approval link security (M11 — locked)

- The email body carries **one deep link to the ERP entity** — staff: the approvals inbox /
  entity href (`/approvals`, `/pipeline/:runId`); clients: the portal
  (`/portal/approvals/:runId`). **No action buttons. No approve-by-reply** (sender addresses are
  forgeable ⇒ approve-by-reply is approval forgery by construction; inbound replies thread as
  *comments*, never as decisions — §7.6).
- **v4 — per-item approval landing (owner-approved; ticket APPR-01, cross-program, in flight):**
  as built, emailed approval links landed on the bare `/approvals` LIST — no per-item route
  existed (`entityHref()` in `platform-ui/src/lib/mail.ts` mapped `automation_approval` and
  `agency_approval` both to `/approvals` with no id, while `pipeline_run` correctly got
  `/pipeline/:id`). The owner approved adding **`/approvals/[id]`** as the per-item landing page.
  Binding on APPR-01 from this design's side: the fix must land on **both** halves — the UI route
  AND the backend-emitted `payload.href` on `approval.requested` notifications (MAIL-06's four
  call sites currently emit `href: "/approvals"`) — because MAIL-05's tap only absolutises
  whatever route it is handed (`MAIL_LINK_BASE_URL` + href); it never re-derives one. A UI route
  with no href change leaves every already-queued and future mail pointing at the list. APPR-01
  also provides the mount point for MAIL-15's deferred approval-detail thread panel (§8A). The
  M11 constraints apply to the new route unchanged: plain URL, auth at the door, no token, no
  action params.
- The link is a **plain URL** — it carries no token, no session, no capability. Authentication
  happens at the door: valid session/JWT → straight to the entity; expired → the normal SSO
  reauth first, then land on the target (the platform-ui middleware's validated `?return=`
  pattern — verify the OIDC flow preserves the deep-link target end-to-end; QA item).
- **Approval deep links MUST NOT be magic links.** A magic link is a bearer credential sitting in
  an inbox — inbox access would become approval power. Magic links stay scoped to low-risk
  convenience **login** only (§9, explicit non-goal there).

### 7.6 Inbound — system-mail threads (M13, NEW; this REVERSES v1's "sending only")

**Address + routing:** every threads-eligible outbound mail sets
`Reply-To: reply+<token>@notify.gaiada.com` (`reply_token`, 128-bit CSPRNG base64url, unique per
outbound mail — VERP-style). MX on `notify.gaiada.com` → **Brevo inbound parsing** →
token-authenticated webhook `POST /api/mail/inbound/brevo` (v4: Brevo offers **no** webhook
signing — see the auth bullet below). Fallback if Brevo inbound disappoints at verification
(§15 R3, ex-Q-V2): a **single provider-hosted mailbox polled over IMAP** (chained-timeout sweeper, same
A2 pattern) — still no mailbox hosting and no IMAP **server** of ours; that decision survives.

**Matching:** the `+<token>` local part → `mail_log.reply_token` → the originating row → its
`entity_type`/`entity_id`/`tenant_id`. The **token is the match; the sender address is display
metadata only** (forgeable). No token / unknown token → count + log + drop with 204 (A9).

**Untrusted-input handling (all binding):**

- Authenticate the webhook — **v4, grounded in Brevo's actual capabilities:** Brevo does **NOT
  sign inbound webhooks**. Its documented mechanisms are (1) basic-auth credentials embedded in
  the webhook URL, (2) a token-bearing request header defined on the webhook object, (3)
  arbitrary custom headers — no payload signature exists (verified against Brevo's docs
  2026-08-04, recorded in `src/mail/inbound/auth.ts`). "Provider signature where offered"
  therefore resolves to **none offered**: the **`MAIL_INBOUND_TOKEN` header check**
  (`x-gaiada-mail-inbound-token`, constant-time, fail-closed when unset) **IS the
  provider-documented scheme** and satisfies this requirement by itself. The HMAC-SHA256 verifier
  that was also built — `MAIL_INBOUND_SIGNING_KEY` over the RAW request bytes,
  `t=<unix>,v1=<hex>` header, timestamp-bound via `MAIL_INBOUND_SIGNATURE_TOLERANCE_S` (default
  300 s), REQUIRED once the key is configured — is **OURS: defence-in-depth**, exercisable only
  by callers we control (the fixture corpus, the replay script, any future fronting proxy we
  sign from). It must never be documented or configured as a Brevo scheme. A reader finding no
  provider-signature verification in the code is looking at **compliance with this paragraph,
  not a gap**. Idempotent by `(provider, provider_message_id)` UNIQUE.
- Size caps at intake (`MAIL_INBOUND_MAX_BYTES`, default 5 MB total; per-attachment + count caps).
- **Never store or render raw provider HTML.** Server-side allowlist sanitizer at intake; store
  `body_text` + `body_html_sanitized` only; render sanitized content in a constrained container.
- Attachments land in a **quarantine area** of the existing file store and are ClamAV-scanned
  before any user can download (`MAIL_INBOUND_SCAN=clamav`; `scanStatus` gates the download
  endpoint; `skipped` when scanning is off — then downloads are admin-only). Note honestly:
  ClamAV exists in this estate **as the webdesk-blueprint pattern only** — MAIL-14 is its first
  actual instantiation (opt-in compose service, like the observability stack).
- **v4 — attachment payload reality:** Brevo inbound delivers attachment **`DownloadToken`s, not
  bytes** — a token to be exchanged at Brevo's API (account key) for the content. Dev fixtures
  inline bytes so the quarantine→scan→download-gate path runs end-to-end in dev; the
  **token→bytes fetch is real staging work** behind the existing `NormalizedAttachment` seam and
  is carried as an explicit §15 R3 step. The fail-closed rule is stage-independent: an
  unfetched/unfetchable attachment stays `scanStatus='pending'` — quarantined, download refused
  at every privilege — and renders as existing-but-unservable; it is never promoted to
  `skipped`/admin-downloadable when there is nothing to download.
- **v4 — cap semantics RATIFIED as implemented** (`src/mail/inbound/intake.ts`; this was an
  implementer interpretation of v3's "per-attachment + count caps", now design text): an
  over-cap or over-count **individual** attachment is **dropped while the message still
  threads** — the human's reply text is the C1 feature, and refusing a delivery over one
  oversized attachment would discard it (our 4xx never reaches the human sender anyway; the
  provider does not relay it). Only the **total request cap** (`MAIL_INBOUND_MAX_BYTES`, applied
  pre-parse) refuses a whole delivery — that one is a resource limit on the request, not a
  content decision. Binding rider on the ratification: the drop must stay **visible** — the
  stored attachment metadata keeps `rejected: true` + `rejectReason`
  (`too_large`/`too_many`) and the thread UI renders the omission; a silent drop on a decision
  surface would misrepresent what the sender sent.
- UI renders inbound messages with a provenance banner: *"Email reply — sender unverified"*, so a
  forged `From:` cannot lend authority to thread content sitting on a decision surface.

**Dev-stage intake — the fixture replay harness (v3, A13; substitutes Brevo in dev, and is the
better adversarial test):** the webhook endpoint above is built **for real**, and dev drives it
with a committed corpus of recorded-shape provider payloads
(`platform-nest/src/mail/__fixtures__/inbound/`), two ways: the test suite (every case, in CI,
forever) and a replay script (`npm run mail:replay-inbound -- --base <url>`) that POSTs the same
corpus at the live dev box. The corpus MUST cover, at minimum:

- forged/spoofed sender; a valid-looking sender paired with a **wrong** `reply_token`;
- unknown token and absent token (the A9 drop paths);
- replayed `(provider, provider_message_id)` (idempotency);
- oversized body; oversized single attachment; too-many-attachments;
- HTML with `<script>`, `<style>`/CSS payloads, inline event handlers, and remote-image trackers;
- encoding attacks (charset tricks, RFC-2047 encoded headers, base64/quoted-printable edge cases);
- quoted-reply bloat (the whole prior thread quoted back);
- a relay NDR/bounce shape (feeds the §7.7 bounce-capture path — the stated inbound bonus).

These are exactly the messages a live provider would never conveniently send on demand — the
corpus is a **higher-fidelity adversarial test than a live provider** and is kept permanently as
the regression suite (A13); staging appends real-captured Brevo samples rather than discarding
anything (v4: "incl. real signatures" is struck — Brevo has none; what staging appends is real
payload shapes and the real token-wall configuration). What the corpus cannot prove — Brevo
plan/availability, real payload drift, the `DownloadToken`→bytes exchange, real NDR formats — is
§15 R3/R4.

**A13, vindicated at build (v4).** Before any live traffic existed, the corpus caught **three
real defects invisible to type-checking**: two Fastify raw-body/content-length bugs that made
every inbound post hang or 500, and a void-element bug where a mail containing `<embed>`
**silently lost every byte after it** — including the human's reply. That is precisely the defect
class A13 predicted a live provider would never surface on demand. Wherever A13's cost is
questioned in the future, this paragraph is the answer: the corpus stays in CI permanently, and
staging appends to it, never replaces it.

**Quoted history (v4 — a real functional gap found at build, decided here as A15).** As landed,
intake caps `body_text` by keeping the FIRST 128 KB and truncating the rest with an explicit
marker (`sanitizeInboundText`). That is correct for top-posted replies — but a **bottom-posted**
reply (the human's text BELOW the quoted thread) can be truncated away entirely, losing exactly
the content C1 exists to capture; and because the raw MIME is never stored, the loss is
unrecoverable. The implementer deliberately refused intake-side quote *stripping* (right call —
see 3 below) and assumed collapse was MAIL-15 render work; MAIL-15 landed without it, so the
concern was owned by nobody. Decision:

1. **Intake (MAIL-19): change the cap SHAPE, not the intake philosophy.** For an over-cap
   plain-text body, keep **head + tail** (~¾ head / ¼ tail of the budget) with an explicit
   `[truncated at intake: N characters omitted here]` marker at the elision point. This is
   heuristic-free — the reply survives at either end regardless of posting style — and intake
   still "caps and records, never interprets", the invariant that protects the untrusted path.
   `body_html_sanitized` stays head-capped (splicing HTML mid-document would break the
   rebuilt-balanced-tags guarantee); the no-loss guarantee rides on `body_text`, which is
   NOT NULL and always renderable. New corpus cases pin it: bottom-posted reply under an
   over-cap quote (the regression this exists to prevent), a top-posted over-cap equivalent, and
   an elision-marker spoof (hostile sender embedding our marker text). No schema change.
2. **Render (MAIL-20): quote-collapse at display time.** Detect the FIRST quote boundary
   (`On … wrote:`, `>`-prefixed runs, `-----Original Message-----` / Outlook `From:` blocks,
   `gmail_quote`/`blockquote` in the sanitized HTML) and collapse everything below it behind
   "Show quoted history" in the thread panel + admin detail. Fail-safe by construction: no
   boundary detected → show everything; wrong boundary → the reader clicks expand. The
   extraction is **computed at render, never stored** — heuristics improve retroactively, and a
   misfire can never destroy data.
3. **Rejected: storing only an extracted "reply portion" at intake.** Quote-boundary detection
   is heuristic, and humans legitimately quote (a narrative "On Monday, John wrote:" is a false
   boundary); with no raw MIME retained, a false positive silently discards the only copy of
   part of a human's message. Render-side-only was equally rejected: it cannot recover what the
   intake cap already discarded. Intake-side *cap-shape* + render-side *interpretation* is the
   only split where every failure mode is recoverable.

**Threading surface:** messages render (1) on the entity — approval detail, run workspace, portal
run view — via `GET /api/:t/mail/threads` (entity-authorized, A10), and (2) in the admin mail log
(§8A). Replies are **conversation, not decisions** (§7.5).

**Bounce synergy:** relay sends have no event feed; their bounces come back as NDR mail to the
envelope sender — which is the inbound address. The intake classifies NDRs (best-effort) →
`mail_log.status='bounced'` + suppression, giving relay sends bounce visibility without a
provider API.

### 7.7 The sender worker + provider events (v1, minus digest)

Sender: chained-setTimeout sweep every `MAIL_SENDER_INTERVAL_MS`; claim
`status='queued' AND next_attempt_at <= now()` with `FOR UPDATE SKIP LOCKED` (LIMIT 20); per row:
suppression re-check → adapter send → `sent` + `provider_accepted_at`, or backoff
(`min(2^attempts, 60)` minutes, `failed` after 5). **Auth-stream rows sort first.** Two platform
instances are safe by construction (SKIP LOCKED).

Delivery events: `POST /api/mail/webhooks/brevo` (token header; Brevo-sent mail only) —
`delivered` → `delivered_at`; `hard_bounce`/`blocked` → `bounced` + suppression `'*'`;
`complaint` → suppression; `soft_bounce` → log. Unknown shapes: log + 204 (never 5xx a provider
retry loop into existence). **Relay-sent mail gets `provider_accepted_at` only** (+ NDR
classification per §7.6) — the log UI must render that honestly: "accepted by relay" is not
"delivered". **Dev note (v3):** against the sink there are no provider events at all — every row
caps at `sent`/`provider_accepted_at`, `delivered_at` stays NULL, and the same "accepted ≠
delivered" honesty is what keeps the dev log UI truthful without special-casing.

### 7.8 Failure modes, named

| Failure | Behavior |
|---|---|
| Relay down / creds wrong | Rows accumulate `queued` with backoff; WS9 alerts on queue depth + failure rate; operator flips `MAIL_STREAM_*_TRANSPORT=brevo` (A8). In-app notifications unaffected (fail-soft tap). |
| `MAIL_ENABLED=0` (default) | Module dark: no workers, tap returns immediately, dev-log adapter. The compose-passthrough trap (§10) lands HERE — visibly dark, not half-alive. |
| Redis down | Irrelevant — no Redis dependency in this module (A2). |
| Recipient suppressed | `suppressed` row; auth flow surfaces it loudly (§5.1). |
| Inbound webhook forged / replayed | Signature+token reject; `(provider, provider_message_id)` UNIQUE makes replay a no-op. |
| Inbound flood | Size caps + per-source rate limit at intake; unmatched tokens drop (A9); worst case is rows in a global table, never sends. |
| Two platform instances | SKIP LOCKED (sender) + UNIQUE (inbound idempotency) — safe. |

## 8. The mail surface in the ERP (NEW — owner wants all three tiers)

### 8A. Sent-mail log + threads (build now)

- **BFF:** `GET /api/admin/mail/log` (elevated-only; filters: stream, status, tenant, entity,
  date; pagination), `GET /api/admin/mail/log/:id` (full row incl. provider events timeline),
  `GET /api/admin/mail/log/:id/thread` (inbound replies). Entity-scoped thread read
  `GET /api/:t/mail/threads?entityType&entityId` per A10 (powers the entity panels + portal).
- **UI:** `/admin/mail` — list with status chips (queued/sent/delivered/bounced/suppressed —
  rendering the relay's "accepted ≠ delivered" honestly), recipient, stream, the **triggering
  entity as a deep link**, detail pane with thread. Entity surfaces (approval detail, run
  workspace, portal run) get a thread panel fed by the entity-scoped read. **v4:** MAIL-15 found
  there IS no approval-detail surface — approvals are decided inline on the `/approvals` list —
  so the panel shipped on the run workspace + portal run view only; the approval-detail mount
  point is **APPR-01's `/approvals/[id]`** (§7.5), which wires the deferred panel when it lands.
- Contract updates land in `docs/FRONTEND-BFF-CONTRACT.md` with the code, per repo convention.

### 8B. Deep-link-to-act

Covered by §7.5 — the ERP is the system of record; email is only a pointer into it. No mail-side
state.

### 8C. Staff Gmail read surface (IN the roadmap — staging-ready, NOT parked)

Owner will have Google keys in staging and wants this ready for the staging stage; the OAuth app
setup happens at the staging window (owner action, §15 R7). Design constraints, all
owner-locked (M14):

- **Internal-type OAuth app** within the gaiada.com Workspace ⇒ exempt from restricted-scope
  verification and the CASA assessment — the unlock that makes it free. Consequence: **employees
  only.** Client contacts can never be included without flipping to External + paying for an
  assessment; the client-side conversation stays on the §7.6 thread channel. Enforced
  structurally: the link endpoints require staff membership (`isStaff` semantics — any
  non-`client` role; NOT `isElevated`), not merely a login.
- **NO domain-wide delegation.** DWD would let a compromised ERP read every employee's mailbox.
  **Per-user OAuth only**: individually consented, individually revocable, narrowest workable
  scope — `gmail.readonly` (metadata scope cannot fetch bodies; readonly is the floor for a read
  pane). No send scope: system mail sends from the system identity only (M5).
- **Render on demand, cache nothing.** BFF endpoints proxy the Gmail API per request
  (list/threads/message view, self-only — the caller's own connection, keyed on
  `req.principal.userId`, never a caller-supplied user id). **No mail content in the ERP DB, in
  logs, or in OTel attributes** — test-pinned. Critical because Google keys land in staging and
  real employee mail must never be mirrored into a staging database.
- **Reconcile with existing machinery — do not duplicate:**
  - Tokens live in the **0033 `integration_connections` vault** (AES-256-GCM `enc:v1:` via
    `secret-box.ts`, key = `INTEGRATION_TOKEN_KEY` — mind the compose-passthrough history on
    exactly that var), `owner_kind='user'`, following the Drive precedent. The vault's provider
    CHECK is `('github','google_drive','claude')` today → a small migration widens it with
    `'google_gmail'`.
  - The in-flight OAuth state machine is the **core `google_oauth_states` table** staged as
    `docs/superpowers/plans/wd23a-1/0070_core_google_oauth_states.sql.staged` (WD-23A-1,
    **unlanded**). Gmail linking rides that one hardened state machine — **hard dependency: land
    WD-23A-1 first** (its own program, its own number), then widen ITS provider CHECK too. If
    WD-23A-1 is still unlanded when the staging window opens, escalate to the owner — do NOT
    build a second state machine.
- **Gmail API cost:** free with existing Workspace seats (~1B quota units/day/project,
  250 units/user/sec) — **all quota + policy specifics VERIFY-AT-BUILD-TIME**; Google shifts
  these, and the internal-app verification exemption itself must be re-confirmed (§15 R7).

**v3 honesty note — the ONE genuinely constrained surface, and the program's highest
re-verification risk.** Two independent hard blockers stand regardless of stage: (a) a real
internal-type Google OAuth client (Q-O2 → §15 R7); (b) **WD-23A-1's `google_oauth_states`
machine landing** — still unlanded as of the v3 check (the staged `0070` file above). A fixture
Gmail is the **least faithful simulation in this program**: real API pagination, thread/label
semantics, rate limits, token refresh and revocation, and consent-screen behaviour are ALL
unexercised — and without WD-23A-1 the OAuth link flow cannot exist either, so a dev build would
be two-fakes-deep (fake transport AND fake auth). Dev evidence here proves almost nothing that
staging will rely on.

**Architect verdict (A14): build the seam, defer the wave.** Dev builds **MAIL-16D only** — the
`GmailClient` interface, a fixture-backed implementation, and a contract-test suite that BOTH
implementations must pass (the live adapter runs the same suite unmodified at staging). The link
flow + live adapter (MAIL-16) and the reading-pane UI (MAIL-17) wait for the staging window.
Reasoning, in order of weight: (1) the two risk cores — the OAuth flow and real API semantics —
are precisely what fixtures cannot exercise, so dev-building them buys verification that is void
at staging (pure re-run cost, no risk retired); (2) the reading pane's information architecture
depends on real thread/label/pagination semantics — UI built on invented semantics is a rework
magnet, strictly worse than building it once against real data; (3) WD-23A-1 is a hard
prerequisite regardless, so a dev-built link flow would either duplicate the state machine
(forbidden) or sit unverifiable; (4) the seam ticket is small, keeps the adapter contract honest,
and hands staging a ready-made harness. This is the one wave where "finish it in dev" would cost
more than it saves.

## 9. Magic links — low-risk convenience login ONLY (designed now, built last)

Design unchanged from v1 (single-use hashed tokens, always-202 + flattened-timing enumeration
resistance, rate limits, atomic consume, standard `sealSession` cookie, hybrid-mode coexistence,
suppressed-address surfacing, M8 SLO gate: p95 delivered−queued < 60s / p99 < 180s over ≥7 days
of auth-stream traffic before real users). Table `auth_magic_links` ships in its own later
migration at the then-current next-unused number. Full mechanics: v1 §8 content is retained
verbatim in the ticket (MAIL-10) spec references — token model, flow, guards, strict-`oidc`
target-state constraint.

**Explicit NON-GOAL (M11, new):** magic links are **never** an approval mechanism and never
appear in approval or warning mail. A magic link is a bearer credential in an inbox; an approval
deep link must be inert (plain URL, auth at the door, §7.5). Scope stays: low-risk convenience
login. Any future proposal to "streamline approvals" by tokenizing the link re-opens M11 with the
owner — it is not an implementation judgment call.

**v3 resequencing — magic links move EARLIER (W8 → W6), deliberately.** Against the Mailpit sink
they have zero external dependency, and their hard parts — single-use consume, TTL, replay,
enumeration/timing resistance — are pure logic that a fake SMTP exercises completely; v2's
"build last" was provider-driven (the live SLO needed a real stream), not logic-driven, and no
longer orders the dev stage. They still sit AFTER the approval-mail spine (W2–W5) because that
spine is this program's mission and the 1–2 concurrency cap prices every slot. Two things
deliberately do NOT move: `MAIL_MAGIC_LINKS_ENABLED` stays `0` for real users, and the M8 SLO
(p95 delivered−queued < 60s / p99 < 180s over ≥7 days of real auth-stream traffic) is measurable
only on the real relay — both are §15 R5.

## 10. Keycloak + Alertmanager + compose wiring (zero application code)

**Dev stage (v3) — both consumers point at the sink first; the relay-credential shape below is
the staging reopen (§15 R6/R8):**

- **Alertmanager → Mailpit:** `SMTP_SMARTHOST=mailpit:1025`, `SMTP_FROM=alerts@notify.gaiada.invalid`,
  empty auth — **and `smtp_require_tls: false`**, which is Alertmanager's global default `true`
  and will refuse the TLS-less sink. That needs a one-line template + compose change:
  `smtp_require_tls: ${SMTP_REQUIRE_TLS}` in `infra/observability/alertmanager/alertmanager.yml`
  and `SMTP_REQUIRE_TLS` (compose default `true`) added to the `&am_env` block — superseding v2's
  "do not edit compose" for exactly this line. The WS9 stack is not currently up on gda-aicenter:
  MAIL-02 brings up ONLY the alertmanager pair (render + alertmanager) as a **separate compose
  project attached to the stack network** (the n8n precedent — a separate project survives
  `deploy.yml`'s `--remove-orphans`), leaving the full observability stack opt-in as before.
- **Keycloak → Mailpit:** live realm `smtpServer` = `host mailpit, port 1025,
  from no-reply@auth.gaiada.invalid`, no auth/TLS — via kcadm/REST (`/idp` prefix) plus the repo
  realm JSON. **ex-Q-V6 SETTLED (v4, proved empirically by MAIL-03):** Keycloak realm import does
  **NOT** substitute `${env.*}` placeholders — a throwaway realm imported with a literal
  `${env.ZZZ_TEST_SMTP_HOST}` placeholder (env var set and passed through) persisted the
  unexpanded string. Consequence, shipped: `infra/compose/keycloak/gaiada-realm.json` carries a
  real working dev-default `smtpServer` block (the Mailpit shape) instead of inert placeholders,
  and `infra/compose/keycloak/configure-smtp.sh` (reads the keycloak service's own `KC_SMTP_*`
  env, pushes via `kcadm update`) is the fresh-boot path for any non-default value — runbook:
  `docs/runbooks/idp-keycloak.md`.
  Then run the REAL flows end-to-end: forgot-password and verify-email for a dev user — the mail
  lands in Mailpit, and the link inside it points at the live `erp.gaiada.online/idp` realm and is
  clicked through to completion. This also answers the provisioner question in dev: with
  verify-email proven against the sink, `emailVerified: true` **can be dropped for dev-created
  users**; retiring it for real users is staging-gated (§15 R6) — doing so before real
  deliverability is proven would lock out anyone whose verification mail never arrives.

**Staging shape (unchanged from v2 — relay credentials):**

- **Compose passthrough rule** applies to every var in §4.1 — a var in `infra/compose/.env` does
  nothing unless the consuming service's `environment:` block forwards it (this repo shipped 4+
  features silently disabled that way). **v4 — it happened again, inside this very program:**
  eight `MAIL_INBOUND_*`/`MAIL_CLAMAV_*` vars (MAIL-13's additions) landed in `config.ts` but not
  in the `platform` service `environment:` block, and would have shipped silently disabled —
  caught and fixed 2026-08-05 (`docker-compose.vps.yml` now forwards all of them). The rule is
  binding **per ticket, not per program**: the same ticket that introduces a var wires the
  passthrough, and its AC greps `docker-compose.vps.yml` for the var name.
- **Alertmanager:** already passthrough'd via `&am_env`. Server-side `.env` values only
  (notify-stream relay creds) + `amtool check-config` + a test alert. Do not touch
  `alertmanager.local.yml`.
- **Keycloak realm SMTP** (auth-stream relay creds): live realm via kcadm/REST
  (`PUT /admin/realms/gaiada`, `smtpServer` object; server path prefix `/idp`); repo realm JSON
  keeps its working dev-default block (**ex-Q-V6 settled: realm import does NOT substitute env
  placeholders** — the staging swap therefore runs `configure-smtp.sh` with the auth-stream relay
  creds, never a placeholder edit). Never commit a literal password. `gaiada-provisioner` keeps
  `emailVerified: true` (unchanged).

## 11. Observability + ops

- Counters (fail-soft OTel): `mail_enqueued_total{stream,template}`, `mail_sent_total{stream}`,
  `mail_failed_total{stream}`, `mail_suppressed_total`, `mail_send_duration_ms`,
  `mail_queue_depth{stream}`, **new:** `mail_inbound_total{provider,outcome}` (outcome =
  threaded|unmatched|rejected), `mail_inbound_rejected_total{reason}` (auth|size|dupe).
- WS9 alerts: queue depth > 50 for 15m; failure rate > 20% over 1h (the A8 "flip the transport"
  pager); **any** auth-stream `failed` row; inbound rejection spike.
- Runbook: relay + Brevo dashboards, per-stream key rotation, suppression review, transport
  failover flip procedure, "approval mail didn't arrive" triage (approvals row → notifications →
  mail_log → provider events/NDR, in that order).

## 12. Secrets custody

Relay credentials (per stream), Brevo keys (failover + inbound + forms), `MAIL_WEBHOOK_TOKEN`,
`MAIL_INBOUND_TOKEN`, and (8C) the internal Google OAuth client id/secret: server-side
`infra/compose/.env` on gda-aicenter (never committed), recorded in the gitignored
`CREDENTIALS.local.md`, examples in `.env.example` — platform-nest env → OpenBao target-state.
Separate streams stay separate secrets: rotating one must not touch the others.

**Dev stage (v3): no external secrets exist at all.** `MAIL_WEBHOOK_TOKEN`/`MAIL_INBOUND_TOKEN`
are random locals minted on the box; the sink is authless. Every credential named above activates
at the staging reopen (§15) and lands in server-side `.env` + `CREDENTIALS.local.md` then.

## 13. Registration + status tracking

- `docs/modules/MODULES.md`: `mail` section — `0.0.9+ · IN PROGRESS` at v4 (per-ticket landing
  records live there and in the CHANGELOG; the original `0.0.0 PLANNED` row is history).
- `docs/modules/CHANGELOG.md`: per-ticket entries `0.0.1`–`0.0.9` landed; v4 amendment entry added.
- `docs/FRONTEND-BFF-CONTRACT.md`: endpoint additions ship with the code tickets.
- Status language everywhere: PLANNED → IN PROGRESS → PROTOTYPED → DEV-VERIFIED. Nothing here may
  be described as "built/done".

> **Status-language discipline (v3 — binding on every ticket AC, MODULES/CHANGELOG entry, and
> release note in this program):** anything verified only against Mailpit or the fixture corpus
> is at best **DEV-VERIFIED** — never "done", never production-ready. Specifically **UNVERIFIED
> until the staging reopen closes**: deliverability and inbox placement (**a Mailpit catch proves
> rendering and wiring; it proves NOTHING about deliverability**), the SPF/DKIM/DMARC posture,
> the M8 auth-stream latency SLO, Brevo inbound fidelity + the real token-wall configuration
> (v4: "real webhook signatures" is struck — Brevo has none, §7.6), real NDR classifiability, and
> everything Gmail. No ticket AC may claim any of these; the `mail` entry in `MODULES.md` carries
> this caveat verbatim until §15 is closed.
>
> **v4 addition — the billing wall:** while GitHub Actions is billing-blocked (Q-O4) there is NO
> deploy path (`release.yml` → signed GHCR images → `deploy.yml`; the box never compiles), so
> anything whose evidence requires a deploy or a CI run is **code-complete-but-unverifiable**:
> report it as IN PROGRESS with its live leg PENDING-DEPLOY, never DEV-VERIFIED on local suites
> alone. (Box-direct devops work — MAIL-00/02/03/14 — is unaffected: its evidence never needed
> the pipeline.) Nothing verified only against Mailpit or fixtures may read as production-ready;
> deliverability, inbox placement, and SLO claims stay UNVERIFIED regardless of stage.

## 14. Open questions + where the old registers went (v3)

**Questions genuinely open for the owner (v4):**

| # | Question | Recommendation |
|---|---|---|
| Q-V4 | Single-person decider routing ("route to THE responsible person, not the admin set") — wants schema + assignment UI + escalation semantics. | Defer; v1 mails the resolved Cerbos DECIDE set (small). Revisit after the warning stream has run for a while. |
| Q-O4 | *(new, v4 — THE binding constraint on the whole program)* **GitHub Actions billing.** The only deploy path is `release.yml` (cosign-signed GHCR images) → `deploy.yml`; the box never compiles. While billing is blocked: MAIL-09 cannot execute, MAIL-10/11 and MAIL-18's live legs are blocked behind it, dev-stage exit criterion #3 (corpus shown running in CI) is unprovable, ex-Q-V7 (OIDC deep-link preservation) stays unsettled, and repo↔server drift accumulates (ticket plan v4, MAIL-21). | Owner action: **restore billing.** The architect recommends AGAINST an interim manual deploy path — it would bypass image signing and recreate exactly the drift this program just documented. The moment billing returns, run the ticket plan v4 **deferred live-verification batch in order**, starting with the `COMPOSE_PROFILES` repo-var fix (append `mail-dev,scan` — it was permission-denied when MAIL-00 tried), which MUST precede the first deploy or `--remove-orphans` deletes the mailpit + clamav containers. |

**Disposition of v2's blockers + verify register (M15 — ONE list now, not two):**

- **Q-O1 / Q-O2 / Q-O3 are no longer blockers of anything.** Each is converted into a §15 row
  (R1, R7, R3 respectively) with a simulated dev-stage substitute. They become owner actions at
  the *staging* stage.
- **Dev-provable verifies moved into dev ticket ACs** (they need no external key, so they are not
  reopen rows): **Q-V6** (Keycloak realm-import env-placeholder substitution → MAIL-03) —
  **SETTLED v4: import does NOT substitute; `configure-smtp.sh` is the fresh-boot path (§10)**;
  **Q-V7** (OIDC reauth preserves the deep-link target — provable against the LIVE
  `erp.gaiada.online` SSO → MAIL-09) — **still OPEN: MAIL-09 is blocked behind Q-O4**;
  **Q-V8** (`resource_agency_approval.yaml` exact DECIDE set — the policy is in-repo → MAIL-06) —
  **SETTLED v4: no `decide` action; `approve` → `company_admin` + `module_approver` ⇒ concretely
  `agency_approver` (§7.3)**.
- **Provider-dependent verifies folded into §15**: Q-V1 → R1, Q-V2 → R3, Q-V3 → R1, Q-V5 → R7,
  Q-V9 → R4. The Q-V numbers are retired; §15 is the single authoritative list.

## 15. Staging Reopen Register (v3 — THE handover to the staging stage)

Authoritative, one row per simulated dependency. **Dev-stage completion means every row below has
its dev substitute DEV-VERIFIED and its staging column untouched; the staging stage begins by
executing this table top to bottom.** Nothing in this table may be marked done by dev evidence.

| # | What was simulated | Dev substitute | What the dev evidence does NOT prove | Exact re-verification steps at staging | Ticket ACs to re-run |
|---|---|---|---|---|---|
| R1 | **Workspace SMTP relay + DNS identity** (Q-O1, ex-Q-V1/Q-V3): relay enablement/auth mode, subdomain envelope acceptance, SPF/DKIM/DMARC on `auth.`/`notify.` subdomains, `_dmarc.gaiada.com` `sp=` inheritance | Mailpit sink + `*.gaiada.invalid` env defaults (A11/A12) | Any DNS record; relay auth mode or caps; whether the relay accepts **subdomain envelope senders** (M2 fallback undecided); DKIM alignment on a real header; that root MX/SPF stay untouched | Identify the `gaiada.com` DNS custodian (owner, step 0). Execute MAIL-01A verbatim: enable/confirm relay, record auth mode; publish subdomain SPF (BOTH `_spf.google.com` + Brevo include) + per-subdomain `_dmarc`; check root `_dmarc` `sp=`; byte-diff root MX/SPF before/after; verify subdomain-envelope acceptance or record the root-address fallback; DKIM-alignment check on a real received header; 20-send latency sample | MAIL-01A (full); MAIL-04 `verify()` against real creds; MAIL-09 smokes 1–2 re-run with real mail |
| R2 | **Deliverability + inbox placement** | Mailpit catch — **proves rendering and wiring, and proves NOTHING about deliverability** | Inbox-vs-spam on any real provider; sending reputation; that SPF/DKIM/DMARC evaluate to pass outside our own config | Real sends per stream to a Workspace inbox AND ≥1 consumer inbox (e.g. a personal gmail.com); raw headers attached showing SPF/DKIM/DMARC pass; spam-folder check recorded; repeat after any DNS change | MAIL-09 (real-recipient variant of every smoke) |
| R3 | **Brevo: failover leg + inbound webhook + intake auth + attachment fetch** (Q-O3, ex-Q-V2) — **RE-SCOPED v4: Brevo does not sign webhooks** (token header / URL basic-auth / custom headers are its only mechanisms, §7.6), so v3's "verify signature validation against real signatures" is void — there is nothing real to verify against. The HMAC verifier is OURS (defence-in-depth) and is exercised by the corpus + replay script, never by Brevo. | Fixture replay harness (A13) — real endpoint, committed adversarial corpus; OUR HMAC scheme verified against self-generated signatures; attachment **bytes inlined in fixtures** (real Brevo sends `DownloadToken`s) | Brevo signup/plan actually offers inbound parsing + per-message webhooks; real payload shapes match the recorded-shape corpus; the **token wall as actually configured on a real Brevo webhook object**; the **`DownloadToken`→bytes exchange** (never exercised in dev); MX routing on the notify subdomain; the failover transport flip | Execute MAIL-01B verbatim (signup, per-role keys, MX, forms identity). Configure the webhook object to send `x-gaiada-mail-inbound-token` and prove a token-less/wrong-token post (Brevo's webhook tester) is 401'd. Send real mail to `reply+<token>@…`; assert threading end-to-end. **Build + verify the `DownloadToken`→bytes fetch** behind the `NormalizedAttachment` seam (Brevo attachment API, account key; fail-closed stands — unfetchable ⇒ `pending` ⇒ quarantined ⇒ download refused), then re-run the quarantine→scan→download-gate ACs with really-fetched bytes incl. EICAR. Capture ≥10 real payloads, DIFF against the corpus and APPEND them (A13 — never replace). Flip `MAIL_STREAM_NOTIFY_TRANSPORT=brevo` once and send. | MAIL-01B (full); MAIL-13 webhook-auth + threading + attachment ACs against real traffic; MAIL-18 forged-webhook attack re-run against the real auth configuration (token wall; OUR HMAC only where we front the webhook with a signer we control) |
| R4 | **Relay NDR/bounce classifiability** (ex-Q-V9) | A fixture NDR shape in the corpus | That the relay's REAL NDR format is classifiable; the accepted failure mode (bounce shows as `sent`) rate | Force a real hard bounce (nonexistent mailbox on a real domain); assert `mail_log.status='bounced'` + suppression row; record the real NDR format in the runbook | MAIL-13 NDR AC |
| R5 | **Auth-stream latency SLO + magic-link enablement** (M8) | None — sink latency is sub-ms and meaningless | p95 delivered−queued < 60s / p99 < 180s on the real relay; real-user login quality | ≥7 days of real auth-stream traffic; run the SLO query from `mail_log`; owner quality review; only then `MAIL_MAGIC_LINKS_ENABLED=1` for real users; one-shot re-probe of the enumeration timing-diff on staging infra | MAIL-11 SLO leg (adversarial leg does NOT re-run in full — logic is environment-independent; the timing re-probe only) |
| R6 | **Keycloak SMTP on the real relay + `emailVerified:true` retirement** | Realm SMTP → sink; both flows (reset, verify-email) completed against Mailpit; dev users verified without the workaround | Relay auth/TLS from Keycloak; real deliverability of reset/verify mail to employee inboxes | Swap realm `smtpServer` to auth-stream relay creds (TLS on); re-run forgot-password + verify-email to a real inbox; THEN the owner decides retiring `emailVerified:true` in `gaiada-provisioner` — not before deliverability is proven (a premature retirement locks out anyone whose mail never arrives) | MAIL-03 (both flows, real inbox) |
| R7 | **Google: internal-type OAuth client + the whole Gmail wave** (Q-O2, ex-Q-V5, + WD-23A-1) | Fixture `GmailClient` + contract suite (MAIL-16D, A14). No link flow, no UI | Everything live: internal-app verification/CASA exemption still holds; consent screen; quotas + rate limits; token refresh/revocation; real thread/label/pagination semantics; `gmail.readonly` still the narrowest body-capable scope | Land WD-23A-1 (hard gate — never build a second state machine); owner creates the Internal-type client (~15 min) + hands creds to staging custody; execute MAIL-16 then MAIL-17 in full; the live adapter MUST pass MAIL-16D's contract suite unmodified | All MAIL-16 + MAIL-17 ACs (first run — nothing to re-run; dev never ran them). **Highest re-verification risk in the program** |
| R8 | **Alertmanager email transport on the real relay** (D15 second transport) | `SMTP_SMARTHOST=mailpit:1025` + `SMTP_REQUIRE_TLS=false` | Relay auth/TLS from Alertmanager; that the D15 email leg works as an INDEPENDENT production transport | Real notify-stream creds in server `.env`, `SMTP_REQUIRE_TLS=true`; `amtool check-config`; synthetic alert to a real inbox alongside the Telegram/ntfy legs | MAIL-02 |
| R9 | **Zone B forms identity** (`forms.gaiada.online`) | None — parked (webdesk is `0.0.0 PLANNED`; nothing consumes it) | Anything — it was never exercised | MAIL-01B forms leg (SPF/DKIM on `gaiada.online`, dedicated Brevo forms key, custody per §12) at the staging window or when webdesk P2 starts, whichever first; then MAIL-12 hands the adapter contract over | MAIL-01B forms AC; MAIL-12 |
