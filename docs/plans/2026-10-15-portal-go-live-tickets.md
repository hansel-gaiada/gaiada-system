# Before real clients use the portal (tickets)

**Status: IN PROGRESS** (started 2026-10-15, paused the same day, resumed 2026-10-26; owner: "start this phase Before real clients use the portal"). Wave 1 is being built.
This phase blocks go-live: no real client signs in to the portal until every item below is done.

- **Parent plan:** `docs/plans/2026-10-10-three-perspectives.md` §8 ("Blocks any real client seeing the new portal")
  and its decision log.
- **Rulings in force:**
  - PV-D40 to PV-D42: MFA, Midtrans and the DEV MOCK billing setup are simulated for review.
  - PV-D44: simple signing only; no PSrE.
  - PV-D45: real MFA and real billing come after staging.
  - **PV-D46 (new):** approvals tighten. This revisits PV-D27.
  - **PV-D47 (new):** client mail covers the things a client must act on.
  - The placeholder register (`docs/PLACEHOLDER-PRINCIPALS.md`, P-03 and P-04).
  - The mail design (`docs/superpowers/specs/2026-08-04-zone-a-mail-design.md`) and its staging reopen register.
- **Base:** `origin/main` at `57846487` (1.0.0-alpha.427), rebased 2026-10-26 from the draft read at `2fcf2911` (413).
- **Paths:** `PN` = `platform-nest/`, `UI` = `platform-ui/src/`, `HUB` = `mcp-hub/src/`.

## The shape of this phase

The phase has three kinds of work. Only the first is code.

1. **Build now (waves 1 to 3).** This is work that needs nothing from the owner:
   - a readiness check that measures every go-live blocker on the live estate;
   - the portal contrast pass;
   - the client legal pack drafted for counsel;
   - the approval tightening (PV-D46);
   - client mail (PV-D47), built and proved against the Mailpit sink;
   - the cut-over runbook.
2. **Owner and admin actions.** These are steps no code can take:
   - the Midtrans merchant account and its keys;
   - real billing values;
   - counsel's review;
   - the Google Workspace SMTP relay and the `notify.gaiada.com` DNS records;
   - naming each client's real representatives;
   - the data path at staging (PGL-Q1).
3. **The cut-over itself.** This happens after staging (PV-D45), in the order the runbook gives:
   - real MFA on and its simulation off;
   - real Midtrans on and its simulation off;
   - the DEV MOCK billing setup replaced and the seal key rotated;
   - placeholders P-03 and P-04 retired;
   - the client mail flag on, with a real sender.

   The readiness check must read all-PASS before the first real client logs in.

## Findings from reading the code (they shaped the tickets)

1. **Legal Gate 1 does not cover the portal yet.** `legal/` is the Gate 1 pack for the WhatsApp work-summary bot. It
   treats clients as third parties to be "detected and excluded". The portal holds clients' own personal data, which
   the pack never covers:
   - contact names and emails;
   - typed signatures with their content hash, time, a salted hash of the IP and the user agent;
   - messages and files;
   - payment status from Midtrans.

   AI also processes client data: agents draft replies, and reports carry AI narratives. "Legal Gate 1 green" for the
   portal therefore needs a client-portal addendum (as `website-visitor-addendum.md` did for the website) and
   counsel's sign-off on it. → **PGL-03.**
2. **Invites never leave the ERP.** `POST /api/:t/clients/:id/contacts` returns the raw invite token once, and a PM
   copies the link to the client (`client-contacts.controller.ts`, "There is no email transport in this estate"). The
   token is stored only as a sha256 hash. The mail spool (`mail_log`) stores each mail's `payload` and recomposes it at
   send time. **An invite email must therefore never put the raw token in `mail_log`.** That would leave a bearer
   credential at rest in the database. → **PGL-10** (Opus).
3. **Client mail today has two types:**
   - `pipeline.gate.opened`, the sign-off gates;
   - `conversation.message.staff` (PV4-06), behind `CONVERSATION_CLIENT_MAIL_ENABLED`. Compose does not pass that flag
     through, so it cannot be switched on by accident.

   A contract sent to sign notifies the client in-app (`contract.sent`, `contracts.controller.ts`), but it is not on the
   mail allowlist (`MAIL_NOTIFICATION_TYPES` in `PN/src/mail/intake.ts`). An issued invoice emits `invoice.issued` for
   the document job only. **The client is not notified at all**, beyond the portal list. → **PGL-09.**
4. **The approval hook for PV-D46 already exists.** `ExecutableApprovalEntry.approverCheck`
   (`PN/src/core/approval-executables.ts`) is enforced at decide time (`automation-approvals.controller.ts`, before the
   decide UPDATE). The executor re-checks the stored `decided_by` as a second wall (`approval-execute.ts`). Today only
   `invoicePayments.decide` declares one: "not the payment's recorder". A credential reveal has its own
   decider ≠ requester rule (VLT-3), which is the model for PV-D46 (1). → **PGL-05, PGL-06.**
5. **PV-D27 (3) is already narrowed and pinned.** PV-D28 gave n8n one workflow, `wf:billing-chaser`, which may only
   read and remind. `HUB/automation-policy.test.ts` pins that workflow's scope to `clients.list`, `contracts.list`,
   `invoicePayments.list` and `notify`. The gap: nothing stops a future workflow entry from naming a write tool on
   contracts or payments. → **PGL-07**, a structural test over every entry.
6. **The portal still dims seven labels with opacity**, for example `PortalBits.tsx:91`, `portal/invoices/page.tsx:111`
   and `portal/profile/page.tsx:121`. axe left 13 to 116 text elements per page "incomplete" because the backgrounds
   are translucent, so a green axe sweep says nothing about contrast. → **PGL-02.**
7. **Placeholder P-04 is visible to clients.** `hansel@gaiada.com` is a client-wide signer contact on every client.
   The People list shows staff contacts as `side: "provider"` by design (PV2). P-04 is still a signer on the client
   side: anything it signs is recorded as the client's signature. The P-03 logins are `.test` addresses that can never
   receive mail, and one of them (`portal@hubble-bali.test`) is a test signer on Kuta Surf Academy. → **PGL-01**
   measures both; the cut-over retires both.
8. **The RLS zero-row trap is the main danger for a readiness check.** A query without its tenant setting reads ZERO
   rows, and "zero placeholder contacts" would then report PASS. Every check must prove it can see rows (a positive
   control) before it may report PASS. → **PGL-01.**

## Lead's calls in planning (the owner can overturn any of them)

- **One readiness check, run inside the platform container**, not an HTTP route. It needs the process environment (the
  flags) and the database, and nothing else needs it. It is read-only, and its exit code is the go-live gate.
- **The data path at staging is not decided now (PGL-Q1).** PV-D45 already puts the real setup after staging. The
  readiness check works for both paths:
  - a fresh production database, where the placeholders never exist;
  - a cleaned live database, where they are retired.
- **One flag for all client mail, `CLIENT_MAIL_ENABLED`.** It replaces `CONVERSATION_CLIENT_MAIL_ENABLED`, which is
  kept as a read-only alias for one release. Compose passes the flag through only at cut-over, as the board already
  says for the conversation flag.
- **PV-D46 (1) applies to high impact only**, the tier PV-D27 (1) named. A one-person company can still countersign
  directly in the UI. Only the agent path needs a second person.
- **Mail language: English for v1.** Indonesian copy waits for counsel's translated notices (PGL-03).

## Contract and numbering

- **Reserved:**
  - FRONTEND-BFF-CONTRACT §62 (client mail: the invite route's response when mail is on, and the new client
    notification types);
  - PERMISSION-CONTRACT §52 (PV-D46 approver rules);
  - migration slot `202610261100` (PGL-10, if it needs one).

  On main at 427, DW-10 used BFF §57 to §61 and PERMISSION §47 to §51. Check the files' highest numbers again at landing.
- **Rulings:** PV-D46 and PV-D47 are recorded with this plan. The next free ruling number is PV-D48.
- **Ticket prefix:** `PGL-` (portal go-live).

## Waves

| Wave | Tickets | Seat (model) | Needs |
|---|---|---|---|
| 1 | PGL-01 readiness check · PGL-02 contrast pass · PGL-03 legal pack draft | Sonnet · Sonnet · Sonnet | nothing |
| 2 | PGL-05 + PGL-06 + PGL-07 (one dispatch) · then PGL-08 live proof | Opus (authz core) · lead | release of wave 2 |
| 3 | PGL-09 client action mail · PGL-10 invitation mail · PGL-11 proof on sumopod | Sonnet · Opus · QA | wave 2 landed |
| — | PGL-04 cut-over runbook | lead | PGL-01 |
| after staging | the cut-over (board boxes) | owner + lead | owner actions |

### PGL-01: the go-live readiness check (backend, ops)

- **What:** `PN/src/ops/portal-go-live-check.ts`, run with
  `docker exec gaiada-platform-1 node dist/ops/portal-go-live-check.js [--json]`. It is read-only (a `BEGIN READ ONLY`
  transaction) and prints one line per check: `PASS`, `BLOCK`, `WARN`, `INFO` or `MANUAL`, with its evidence.
- **Exit codes:**
  - `0` when nothing is BLOCK;
  - `1` when any check is BLOCK;
  - `2` when a check could not run. An error is never a PASS.
- **Checks** (ids are stable, so the runbook can cite them):

  | Id | Check | BLOCK when |
  |---|---|---|
  | `mfa.simulation` | `MFA_SIMULATION_ENABLED` | it is `1` |
  | `mfa.real` | a real second factor reached the platform (an `amr`-sourced high-assurance step-up recorded in the last 30 days, or the closest recorded evidence the code has; name the source in the evidence) | none is found |
  | `payments.simulation` | `PAYMENTS_SIMULATION_ENABLED`, `MIDTRANS_ENVIRONMENT` | the flag is `1`, or the environment is not `production` |
  | `payments.keys` | `MIDTRANS_SERVER_KEY`, `MIDTRANS_TENANT_ID`, and the clearing account on that company's billing profile | any is missing, or the key starts with `SIM-` (print only whether it is set and its prefix class, never the key) |
  | `signatures.simulation` | `SIGNATURE_SIMULATION_ENABLED` | it is `1` |
  | `billing.mock` | every billing profile | its legal name contains `DEV MOCK`, its bank is `MOCK BANK` or account `0000000000`, or its prefix ends in `-DEV` |
  | `seal.mock` | every active seal certificate | its subject contains `DEV MOCK`, or does not match its company's billing legal name |
  | `placeholders.p03` | ACTIVE `client_contacts` whose user's email matches `portal@%.test` | any exist (list the clients) |
  | `placeholders.p04` | ACTIVE `signer` contacts held by a user whose `kind` is not `client` | any exist (list the user and the count). Staff **viewer** contacts are WARN |
  | `mail.sender` | `MAIL_ENABLED`, and the notify stream's relay host and From address | mail is off, the relay is `mailpit`, or the From address is on a `.invalid` or `.test` domain |
  | `mail.client` | `CLIENT_MAIL_ENABLED` (or the conversation alias until PGL-09 lands) | it is not `1` |
  | `data.simulated` | counts of simulated payments, simulated signatures and simulated MFA step-ups | INFO only: points at PGL-Q1 |
  | `legal.gate1`, `mail.deliverability`, `contrast.manual` | cannot be measured | MANUAL: printed with the runbook step that clears it |

- **The trap (finding 8):** every database check first runs a positive control. For example, it counts `clients` in
  each tenant and gets more than zero, through the same connection and RLS context as the check itself. If the control
  reads zero, the check is an ERROR (exit 2), never a PASS. Use the same tenant iteration as
  `ops/client-reports-backfill.ts`.
- **Tests:**
  - unit tests per check;
  - DB tests on the sumopod test database;
  - **teeth:** each BLOCK is proven by seeding the bad state and seeing BLOCK, and the positive control is proven by
    running a check with the tenant setting deliberately unset and seeing exit 2.
- **Live, after the release:** run it read-only on gda-aicenter. On review data today it is expected to BLOCK on almost
  every line. That output becomes the first column of the runbook's checklist.
- **Docs:** `PN/src/ops/README.md` and `docs/runbooks` (or `infra/runbooks`) cross-links. No BFF section.

### PGL-02: the portal colour-contrast pass (UI)

- **What:** replace the opacity dimming on the seven labels with ink tokens that pass:
  - invoices, invoice detail and contract signers;
  - profile and `PortalFacts` (`PortalBits.tsx`);
  - any others a grep finds.

  The project page's "Back" already moved to `--ink-subtle`, which is the pattern to follow.
- **Then measure every portal text style against its real background, in light and dark.** Composite translucent
  surfaces over the page background first, then compute the ratio:
  - body text needs ≥ 4.5:1;
  - large text and UI glyphs need ≥ 3:1.

  Fix tokens or usages that fail. Prefer changing a portal usage to a passing token over editing a shared token: a
  shared token change touches the staff app too, so it needs its own note.
- **Guard:** a static test that fails on `opacity` applied to text in portal files. Hover, disabled and transition
  uses are allowed.
- **Evidence:**
  - a contrast table (token pair, surface, ratio, theme) committed with the change;
  - screenshots of the 13 portal pages in light and dark, for the lead's manual look;
  - `e2e/a11y-axe-portal.spec.ts` on sumopod, which must stay green.
- **Seat:** Sonnet, senior UI/UX. Name the `frontend-design` skill.

### PGL-03: the client-portal legal pack (draft for counsel)

- **What:** `legal/client-portal-addendum.md`, shaped like `legal/website-visitor-addendum.md`. It must cover:
  - **Scope:** the portal's data subjects (client contacts) and data categories:
    - identity and contact details;
    - the signature record (name, content hash, time, a salted IP hash and the user agent; PGL-03 found the raw IP is not stored);
    - Conversation messages and files;
    - payment status (no card data, which stays with Midtrans);
    - notifications and mail.
  - **Roles:** controller per group company, for contact data. Processor, for client content we handle on the client's
    behalf (their website forms and leads, social and search accounts).
  - **Lawful basis:** performance of the client contract. Name any legitimate-interest uses.
  - **RoPA rows** for the portal's processing.
  - **Retention:** statutory periods for contracts and invoices, marked «ASSUMPTION».
  - **Data-subject rights handling**, tied to `legal/retention-and-dsr-procedure.md`.
  - **Recipients and sub-processors:** Midtrans, the Google Workspace relay, the AI providers behind the gateway (agent
    drafts, report narratives), and hosting.
  - **Cross-border transfers.**
  - **Drafts:** a portal privacy notice, and portal terms of use. The terms include the client's consent to our
    attested electronic signature under UU ITE and PP 71/2019, and must say plainly that it is not a certified PSrE
    signature (PV-D44).
  - **"Legal Gate 1 green for the portal":** a checklist of exactly what counsel must review and sign. The board's item
    ticks against it.
- Update `legal/README-NOTES.md`'s table. Mark every assumption «ASSUMPTION», and add open items for the owner and
  counsel. These are drafts, not legal advice.
- **Then (a later ticket, after counsel):** the portal shows the privacy notice and terms, and the first login records
  acceptance. This is out of scope here.
- **Seat:** Sonnet.

### PGL-04: the cut-over runbook (lead)

- **What:** `infra/runbooks/portal-go-live.md`. It covers:
  - **Preconditions:** staging done, the owner actions done, the PGL-Q1 data path chosen.
  - **The ordered steps.** Each step gets a backup, the command, a verify (a readiness-check id turning PASS) and a
    revert:
    1. real MFA (`infra/runbooks/enable-mfa.md`), then `MFA_SIMULATION_ENABLED=0`;
    2. real billing values, then the seal key rotated (`infra/runbooks/company-seal-keys.md`);
    3. Midtrans production keys, then `PAYMENTS_SIMULATION_ENABLED=0` (`infra/runbooks/midtrans-payments.md`);
    4. the mail sender, then the compose passthrough for `CLIENT_MAIL_ENABLED`, then the flag on;
    5. P-03 and P-04 retired (register procedure);
    6. the readiness check all-PASS;
    7. the first real client invited.
  - The house rules for flag flips: back up `.env`, pass `GAIADA_TAG`/`APP_VERSION` inline, and recreate only
    `platform` with `--no-deps`.
- Written after PGL-01, so it can cite the check ids.
- Runbook: `infra/runbooks/portal-go-live.md` (PLANNED).

### PGL-05: nobody approves their own agent's high-impact request (backend, authz)

- **Rule (PV-D46 (1)):** at decide time, an `approved` decision on a row whose origin is `agent` or `automation`, and
  whose tool is high impact, is refused when the decider is:
  - the row's filer (`requested_by`); or
  - the human the request acts for (the `actFor` user recorded on the row); or
  - the decider is acting for either of them.

  The refusal is a 403 with `reason: "self_approval"`, and the row stays `pending`.
- **The second wall:** the executor re-checks the stored `decided_by` before it runs, the same way it does for
  `approverCheck`.
- **Nobody is exempt**, `platform_admin` included. Reject is still allowed, because rejecting executes nothing.
- **Generic:** this is a decide-gate rule, not a per-entry `approverCheck`, so a future high-impact tool is covered
  without new code. Find where impact is known at decide time: the row, or the hub's tool definition. Document the
  source.
- **Contracts:** PERMISSION-CONTRACT §52. The approvals UI shows why Approve is refused; a disabled button with the
  reason is enough.

### PGL-06: approving an agent's countersign needs the countersign right (backend, authz)

- **Rule (PV-D46 (2)):** `contracts.countersign` gets an `approverCheck`. The approver must pass the Cerbos
  `countersign` check on that contract, exactly as if they were countersigning it themselves. Otherwise the refusal is a
  403 with `reason: "countersign_right_required"`.
- This sits on top of PGL-05, so an approver must hold the right **and** not be the filer.

### PGL-07: no workflow may hold a contract or payment write tool (HUB, test)

- **Rule (PV-D46 (3)):** a structural test over EVERY `AUTOMATION_ALLOWLIST` entry. No workflow may name a write tool
  in `contracts.*` or `invoicePayments.*`. Today only `wf:billing-chaser` names any, and only reads plus `notify`.
- **Teeth:** add a write tool to a copy of the list and see the test fail.

### PGL-08: prove PV-D46 live with the accounts we have (lead + QA)

The owner's condition: "you need to be able to test it with all the accounts we have, so we can simulate and prove it".

- **Accounts:**
  - `hansel@gaiada.com` (`platform_admin`, which holds countersign);
  - `qa.finance.staff@gaiada.com` (still holds the temporary `manager` grant on Gaia Digital Agency from PV-5);
  - the other `qa.*` logins;
  - placeholder contacts for the client side.
- **Before the drive:** read each account's live grants, and record the matrix in this ticket.
- **Temporary grants:** where a case needs a second person who holds countersign, grant the `owner` role on Gaia
  Digital Agency to ONE QA login for the drive only. Add it to `docs/PLACEHOLDER-PRINCIPALS.md` in the same change, and
  revoke it after.
- **Cases** (each filed through the agent path, as the D14 drives were):

  | # | Filer (agent acts for) | Approver | Expected |
  |---|---|---|---|
  | 1 | hansel@ | hansel@ | 403 `self_approval`; row stays pending |
  | 2 | hansel@ | qa.finance.staff@ (generic approve right) | executes (non-countersign high-impact tool) |
  | 3 | qa.finance.staff@ | qa.finance.staff@ | 403 `self_approval` |
  | 4 | hansel@, `contracts.countersign` | qa.finance.staff@ (no countersign right) | 403 `countersign_right_required` |
  | 5 | hansel@, `contracts.countersign` | the QA login with the temporary `owner` grant | executes; the contract is countersigned |
  | 6 | any | reject by the filer | allowed; nothing executes |

- **Then:**
  - the Cerbos probe for the countersign check;
  - a hub check that the billing-chaser scope is unchanged;
  - teardown: label each test contract and request "ZZ TEST PGL-08", and revoke the temporary grant.

### PGL-09: client mail for the things to act on (backend + templates)

- **Rule (PV-D47):** mail reaches a client contact for:
  - **a contract to sign:** `contract.sent`, client recipients only;
  - **an issued invoice to pay:** a new client notification `invoice.issued`, linking to `/portal/invoices/:id`;
  - **a sign-off gate:** already mailed;
  - **a staff message in Conversation:** built, with its throttle.

  Reports and other news stay in-app.
- **The flag:** `CLIENT_MAIL_ENABLED` gates every client-recipient type. Off means no `mail_log` row and no enqueue,
  exactly as the conversation flag behaves today. `CONVERSATION_CLIENT_MAIL_ENABLED` stays as an alias for one release.
- **Templates:** pointer mails only. No amounts beyond the invoice number and total, no contract text, and no
  action-by-reply. Approval-style deep links go to the portal, and an expired session takes the normal SSO path (mail
  design rule: never a magic link). Each template is rendered by `GET /api/admin/mail/log/:id/preview`.
- **Contract:** BFF §62.
- **Seat:** Sonnet, senior integrator.

### PGL-10: the invitation email (backend, security)

- **Rule (PV-D47):** an invite can go by mail. The raw token must never be at rest: it must not reach `mail_log`, logs
  or the outbox.
- **Design to decide in the ticket (Opus).** For example, the sender mints the token at send time and stores only its
  hash. Or the payload carries a reference to a sealed, single-use token record, which the sender redeems and clears.
- **Keep:**
  - the hand-forwarded link, when mail is off or for a PM's choice;
  - expiry, single use and a resend that issues a new token;
  - the PV-6 revoke and Keycloak fixes (release 386).
- **Teeth:** a test that fails if any `mail_log.payload` or log line contains a token that hashes to a live invite.
- **Contract:** BFF §62 (the invite route says whether the invite was mailed). Migration slot `202610261100` if needed.

### PGL-11: client mail proved on sumopod (QA)

- **Against Mailpit on sumopod:**
  - each of the five types renders, and its link lands on the right portal page for the right contact;
  - nothing mails while the flag is off;
  - a viewer gets no "to sign" mail for a contract they cannot sign;
  - a contact limited to some projects gets mail only for their projects.
- **Honesty rule (mail design):** a Mailpit catch proves rendering and wiring, nothing about deliverability.
  Deliverability is a MANUAL readiness item at cut-over.

## Open for the owner

- **PGL-Q1, the data path at staging:** start production from a fresh database, or clean the current one (purge mock
  rows, reverse mock ledger postings, retire placeholders)? **Default: decide at staging.** The readiness check covers
  both.
- **PGL-Q2, do client contacts need MFA?** Default: not required for v1; staff MFA only (PV-D40/PV-D45). Clients sign and
  pay, so counsel's review (PGL-03) may change this.
- **Owner actions, on the board:**
  - the Midtrans merchant account (sandbox, then production);
  - real billing values for each company that bills clients;
  - the Google Workspace SMTP relay for the ERP host, and DNS for `notify.gaiada.com` (SPF, DKIM, DMARC);
  - counsel's review of PGL-03;
  - the real representatives for each client;
  - running real MFA after staging.

## Not in this phase (and where each goes)

| Item | Why not here | Where |
|---|---|---|
| Report-published mail | PV-D47 keeps reports in-app | — |
| Showing the privacy notice and terms in the portal, with acceptance | Needs counsel's text first | a ticket after PGL-03's review |
| Certified (PSrE) signing | PV-D44 dropped it | — |
| Staff MFA enforcement realm-wide | An owner decision in `enable-mfa.md` §3.6 | the cut-over, step 1 |
