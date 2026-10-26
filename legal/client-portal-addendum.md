**DRAFT — not legal advice. For review by qualified counsel before use.**

# Client-Portal Addendum to the Legal Pack

> ⚠️ **DRAFTS — NOT LEGAL ADVICE.** This document is a working draft to accelerate and reduce the cost of legal review. **A qualified data-protection lawyer in the applicable jurisdiction(s) must review, localize, and sign off before any real client contact's data is entered into the client portal.** Nothing here is a ruling. Facts not established by the repository are marked «ASSUMPTION: …» for counsel or the owner to confirm. **English only:** the Indonesian versions of the privacy notice (§12) and the terms of use (§13) wait for counsel's translated notices.

## 0. Header

| Field | Value |
|---|---|
| Document | Client-portal addendum (scope, roles, lawful basis, DPIA-lite, RoPA rows, retention, rights, the portal privacy notice draft, the portal terms-of-use draft, and the "Legal Gate 1 green for the portal" checklist) |
| Ticket | PGL-03 (`docs/plans/2026-10-15-portal-go-live-tickets.md`) |
| Version / status | v0.1 — DRAFT, PLANNED for counsel review. Nothing here has been reviewed by counsel |
| Date | 2026-10-26 |
| Controller | [CONTROLLER ENTITY] — the group company that contracts the client «ASSUMPTION: confirm which legal entity, per client contract; see §3 and open item 1» |
| Primary jurisdiction | Indonesia (UU PDP No. 27/2022); drafted to GDPR-grade for any EU/SG exposure. See [JURISDICTION] «ASSUMPTION: confirm jurisdictions» |
| DPO / contact | [DPO NAME/EMAIL] |
| Lawful bases used | Performance of the client contract (main basis); a few narrow legitimate-interests uses (§4); legal obligation for statutory records |
| Sources | `platform-nest/src/core/client-contacts.controller.ts`, `client-invites.ts`, `portal-commerce.controller.ts`, `evidence.ts`, `conversation-core.ts`, `portal-conversation.controller.ts`, `client-notify.ts`, `client-reports.ts`, `storage.ts`; `platform-nest/src/mail/intake.ts`, `queue.ts`; `platform-nest/src/payments/midtrans.ts`, `process.ts`; `platform-nest/src/modules/clients/account-summary/draft.ts`; `ai-gateway-go/CLAUDE.md` and `internal/providers/`; migrations named in §2; `docs/plans/2026-10-15-portal-go-live-tickets.md`; `docs/plans/2026-10-10-three-perspectives.md` (PV-D44) |
| Basis of scope | Owner ruling PV-D44 (2026-10-15): simple signing only, no certified (PSrE) tier |

**How to read this alongside the pack.** The existing pack (`README-NOTES.md`, `lia.md`, `dpia.md`, `ropa.md`, `privacy-notice.md`, `retention-and-dsr-procedure.md`) covers the WhatsApp work-summary bot and its employees, and it treats clients and vendors as third parties to be "detected and excluded". `website-visitor-addendum.md` covers visitors and leads of the public website. **Neither covers the client portal**, where a client's own people (contacts) log in, sign agreements, message us, receive reports and pay invoices. This addendum is separate and stands on its own. It follows the shape and conventions of `website-visitor-addendum.md`:

- It reuses the pack's conventions: «ASSUMPTION» markers, [CONTROLLER ENTITY] / [JURISDICTION] / [DPO] placeholders, the Likelihood / Severity / Residual risk table.
- §11 holds RoPA rows in the format of `ropa.md`, ready to paste.
- Lawful basis differs from the bot. Clients' contacts are not employees, and the portal exists because of a contract. The basis is therefore the performance of that contract, not legitimate interests and not consent, except where §4 says otherwise.

**Status vocabulary** (matches the repo): **IN CODE** = found in the repository at the sha named in the PGL-03 brief (release 1.0.0-alpha.427 plus the go-live plan); **PLANNED** = not built; **UNVERIFIED** = stated in a plan but not found in code by the drafter. "IN CODE" is not "DEV-VERIFIED": nothing in this addendum has been run on a Linux server by this ticket. The portal itself is PLANNED for real client data: it runs on mock seed today.

---

## 1. Scope

### 1.1 In scope

| Item | Detail |
|---|---|
| Surface | The client portal (`/portal/...` in `platform-ui`; routes in `platform-nest/src/core/portal-*.controller.ts`), the PM-facing contact invite surface (`client-contacts.controller.ts`), and the staff side of Conversation, contracts, invoices and published client reports, so far as it handles a client contact's personal data |
| Systems touched | The ERP database (`platform-nest`, Postgres), file storage (`platform-nest/src/core/storage.ts`), Keycloak (login), the mail spool and relay (`platform-nest/src/mail/`), the Midtrans adapter (`platform-nest/src/payments/`), the AI gateway (`ai-gateway-go`) and the agents that call it |
| Environments | Production only. «ASSUMPTION: staging and the current dev stage hold only mock seed data, per the owner ruling in the workspace `CLAUDE.md` of 2026-10-13; confirm no real client data is in either before go-live (PGL-Q1)» |
| Hosting | «ASSUMPTION: the ERP and its file store run on the `gda-aicenter` VM (Google Cloud, likely asia-southeast1, as `website-visitor-addendum.md` §11 item 16 also assumes). Region, provider contract and backup location must be confirmed» |

### 1.2 Out of scope (needs its own analysis)

- The **public website** (visitors, leads): `website-visitor-addendum.md`.
- **Staff** data in the ERP and the WhatsApp bot: the existing pack.
- **Client sites run on WebDesk** and their form submissions. For those the client is the controller and Gaiada the processor (WebDesk's WSK-38 design). §3.2 names the role but this addendum does not analyse WebDesk's processing.
- **Certified (PSrE) signing.** Dropped by PV-D44. The code stays dormant behind `SIGNATURE_SIMULATION_ENABLED=0`. If a certified provider is ever wanted, this addendum needs a new section.
- **The "later" ticket** that shows the privacy notice and terms inside the portal and records acceptance at first login (PGL-03 "Then"). Until it is built, acceptance cannot be recorded (open item 9).

### 1.3 Data subjects

| Data subject | Who | Notes |
|---|---|---|
| Client contacts | People a project manager invites to the portal, as `signer` or `viewer`, client-wide or per project (`client_contacts.capability`, `project_id`) | The main data subjects. Individuals acting for a client organisation; a sole trader client is an individual in their own right |
| Invited, not yet active | Same people between invite and acceptance (`client_contacts.status = 'invited'`) | A `users` row and an invite exist; no login yet |
| People named in client content | Anyone named in a message, an attachment, a payment proof or a report | Third parties, not aware of this processing; see R-P6 |
| People who write to the client's channels | Authors of social comments and direct messages, and website-form submitters on a client site | Only in the processor role (§3.2) |

---

## 2. Data categories, grounded in the code

Each row names the stored fields and the file or migration that proves it. "Visible to the client" means the contact can see the data about themselves or their organisation in the portal.

| # | Category | Fields actually stored | Source in the repo | Notes |
|---|---|---|---|---|
| D1 | **Identity and contact details** | `users`: `id`, `email` (unique, lower-cased), `name`, `title`, `status`, `session_version`, `origin_site`, timestamps, `deleted_at`. `client_contacts`: `client_id`, `user_id`, `project_id`, `capability` (`signer` or `viewer`), `status` (`invited`, `active`, `revoked`), `invited_by`, `invited_at`, `activated_at`, `revoked_at`, `deleted_at` | `platform-nest/migrations/0001_core.sql` (`users`); `0072_client_contacts_and_engagement_setup.sql` (`client_contacts`); `src/core/client-contacts.controller.ts` (`invite`, `revoke`, `view`) | The same `users` row is reused if the person is already staff or a contact of another client (find-or-create by email). No phone, address, national ID or photo is collected by this surface |
| D2 | **Invite record** | `client_invites`: `email`, `token_hash` (SHA-256 only), `expires_at` (default 72 hours, `CLIENT_INVITE_TTL_SECONDS`), `consumed_at`, `invited_by`. The raw token is returned once to the inviting staff member and is never stored | `0072_...sql` (`client_invites`); `src/core/client-invites.ts`; `src/config.ts` (`clientInvites.ttlSeconds`) | Today a PM copies the link to the client; there is no email transport for invites. PGL-10 will add one and must keep the raw token out of `mail_log` (go-live plan, finding 2) |
| D3 | **Login identity (Keycloak)** | On accept: a Keycloak user with `username` = `email`, `email`, `emailVerified: true`, optional first name, and a password the person chose (at least 10 characters) or a generated one. Keycloak holds the credential hash and its own session and login-event records | `src/core/client-contacts.controller.ts` (`ClientInviteAcceptController.accept`); `src/core/keycloak-admin.ts` (`createUser`, `disableUser`) | «ASSUMPTION: Keycloak login events are on and retained for a period that has not been confirmed; its host and region are the same as D1's. Confirm both.» The ERP stores no password |
| D4 | **The typed-signature record** | `contract_signatures` (one row per party, `client` and `provider`): `signer` (user id), `signer_name` (the typed name, passed through `scrubText`, 200 characters), `signer_title` (optional, same), `ip_hash`, `user_agent` (raw string, capped at 400 characters), `signed_at`, `content_sha256` (the hash of the fixed contract text the signer saw and echoed), `schedule_sha256` (the instalment schedule, copied from the contract), `provider` and `provider_envelope_id` (NULL for an attested signature), `signature_ref` (unused in v1). Signing also requires an explicit `agree: true` attestation, which is checked but not stored as its own field; the row's existence is the record | `0075_client_portal.sql` (`contract_signatures`); `202610130400_pv5_billing_data_model.sql` §6; `202610181100_contract_instalments.sql` (`schedule_sha256`); `src/core/portal-commerce.controller.ts` (the client signing route, around the `INSERT INTO contract_signatures`); `src/core/evidence.ts` | **Correction to the go-live plan.** The plan lists "IP and user agent". The code stores a **salted hash of the IP, not the address**: `hashForEvidence()` is a truncated (32 hex characters) SHA-256 of `<tenantId>:<ip>`. The tenant id is the salt and it is not secret, so the value is **pseudonymous, not anonymous**: someone holding the table and the tenant id could test candidate IPv4 addresses. The user agent is stored as sent. After PV5-07 each signed copy is also sealed with a company key and carries an evidence page; the exact fields on the evidence page were not traced «ASSUMPTION: confirm they match this row» |
| D5 | **Conversation messages** | `conversation_threads`: `client_id`, `project_id`, `subject`, `status`, `created_by`, `created_side`, `last_message_at`. `conversation_messages`: `author_id`, `author_side` (`client` or `staff`), `body` (1 to 10,000 characters), `drafted_by` (the agent user whose draft a staff reply came from), `created_at`. `conversation_reads`: `user_id`, `last_read_at` | `202610122330_pv4_conversation_data_model.sql`; `src/core/conversation-core.ts`; `src/core/portal-conversation.controller.ts` | **Messages are permanent (PV-D34):** there is no edit and no retract, and a static test (`conversation-messages-permanent.test.ts`) fails if application code updates or deletes them. This collides with erasure and storage limitation: see §8 and §9 |
| D6 | **Conversation files** | `files`: `uploader_id`, `target_entity_type = 'conversation'`, `target_entity_id` (the message), `filename`, `content_type`, `byte_size`, `storage_key`, `sha256`, `scrubbed`. Up to 10 MB per message in total. Text attachments pass through the day-one scrub (card numbers and national-ID patterns are redacted); binaries pass through unchanged | `src/core/conversation-core.ts` (`prepareAttachments`, `storeAttachments`); `src/core/storage.ts` (bytes on local disk under `config.filesDir`, tenant-prefixed keys) | «ASSUMPTION: the bytes sit on the ERP host's disk, covered by whatever backup the host has; confirm location, encryption at rest and backup retention.» A binary (image, PDF) can hold anything, including personal data of third parties |
| D7 | **Payment status and payment proofs** | `payment_checkouts`: `invoice_id`, `client_id`, `amount`, `currency_code`, `provider`, `provider_checkout_id` (our own order id), `checkout_url`, `status`, `expires_at`, `created_by`. `provider_events`: `provider`, `event_id`, `kind`, `status`, `error`. `invoice_payments`: `amount`, `currency`, `paid_on`, `method`, `reference` (for an online payment: `Online payment <ref> (<payment method word>)`), `status`, `recorded_by`, `proof_file_id`, `note`, and the Midtrans payment id for gateway payments | `202610130400_pv5_billing_data_model.sql` §9, §10; `0075_client_portal.sql` (`invoice_payments`); `src/payments/midtrans.ts` (request body is `transaction_details: { order_id, gross_amount }`, `expiry`, `callbacks`); `src/payments/process.ts` (the `INSERT INTO invoice_payments`) | **No card data is stored or sent by us.** The Snap request carries only our order id and the amount; no customer name, email or card field is in it. We keep Midtrans' `redirect_url` and never its token, and no provider script is embedded in our pages (header of `midtrans.ts`). The payer enters card or bank details on Midtrans' hosted page, so Midtrans is the controller or processor for that step («ASSUMPTION», §6). What comes back is a status and a payment-type word such as the method name. A client who pays by bank transfer may upload a **transfer receipt** as a `files` row (target `invoice_payment`, via `invoice_payments.proof_file_id`); a receipt image can show an account number and a name «ASSUMPTION: receipts are scrubbed as text only; binary receipts are not». `midtrans.ts` itself says several Midtrans behaviours are **UNVERIFIED until a sandbox drive** (no Midtrans account yet); this addendum assumes the request and reply shapes in that header |
| D8 | **Notifications** | `notifications`: `user_id`, `type`, `payload` (jsonb), `read_at`. For Conversation the payload is a short fixed title, the deep link and the thread id: **no message text** (header of `conversation-notify.ts`) | `0001_core.sql` (`notifications`); `src/core/conversation-notify.ts`; `src/core/client-notify.ts` (who is told: active contacts only, by capability and scope) | Notifications are in-app (the portal bell) |
| D9 | **Mail (the spool)** | `mail_log`: `to_email`, `user_id`, `template_key`, `subject`, `payload` (jsonb, "PII-lean: ids and titles, never bodies twice": a thread id, a link, a title, a company name, a tool name and an impact word), `status`, `attempts`, `provider`, `provider_message_id`, `reply_token` (for mail that can be replied to), timestamps. `mail_suppressions`: `email`, `reason` (bounce, complaint, manual) | `0077_mail_core.sql`; `src/mail/intake.ts` (the allow-list: `approval.requested`, `pipeline.gate.opened`, and `conversation.message.staff`); `src/mail/queue.ts`; `src/config.ts` (`mailStreamConfig`) | Mail to a client is limited to two kinds today: a sign-off gate opened, and (behind `CONVERSATION_CLIENT_MAIL_ENABLED`, default off) a pointer to the portal when staff wrote in Conversation, at most one per contact per thread until it is read. The mail carries a link, not the message. **Transport is a Google Workspace SMTP relay by default, with Brevo as a configured failover** (`MAIL_STREAM_<stream>_TRANSPORT`). Inbound replies to mail that carries a reply token are stored as sanitised HTML in `mail_messages` «ASSUMPTION: a client could reply by email to a gate mail; whether that reply is routed to staff and how long it is kept has not been traced» |
| D10 | **Published client reports and documents** | `client_reports` (status `draft`, `published`, `withdrawn`; source `social_report`, `search_report` or `account_summary`); the report's own `files` row (role `client_report_file`, never deleted); for an account summary, a narrative with `source` `ai`, `deterministic` or `human`, and the model label | `src/core/client-reports.ts`; `src/modules/clients/account-summary/draft.ts`; `src/modules/search/search-reports.controller.ts` | A report is about the client's own marketing results. It can name the client's people or the people who wrote to their channels «ASSUMPTION: report content is mostly aggregate; confirm» |
| D11 | **Audit and activity trail** | activity-log rows (actor, action, entity), outbox `events` (e.g. `client_contact.invited`, `contract.client_signed`), client-access audit rows (`writeClientAccessAuditTx`) | `src/core/http.ts` (`writeActivity`); `src/events/outbox.service.ts`; `src/core/client-website-access.controller.ts` | These identify the contact by user id. Retention is not set in code (§8) |

### 2.1 Never collected by the portal (binding intent)

- Card numbers: not requested, not stored, not sent to Midtrans by us. The scrub redacts card-number patterns found in uploaded text.
- National ID numbers, passports, photographs, health or biometric data: no field exists for them. A binary attachment can still contain them (R-P6).
- Contact **phone numbers and postal addresses**: not collected by the invite surface (D1).
- Location, device identifiers, advertising or analytics tags: the portal does not load the website's trackers «ASSUMPTION: confirm that `platform-ui` portal pages load no third-party script or analytics tag; not checked by this ticket».

---

## 3. Roles: controller and processor

### 3.1 Controller, for contact data

For the portal's own data about client contacts (D1 to D9, D11), **the group company that contracts the client is the controller**, one controller per client contract (`ropa.md` §1 already says to instantiate the RoPA per controlling entity). The portal runs as a multi-company ERP, so each contact is scoped by `tenant_id` (the group company) and `client_id`.

«ASSUMPTION: which group company is the controller for each client, whether more than one company can be a controller for the same contact (a contact invited by two companies), and whether the holding company is a joint controller of the shared platform.» → open item 1.

### 3.2 Processor, for client content

For content the client owns and Gaiada handles on the client's behalf, **the client is the controller and Gaiada is the processor**:

| Client content | Where | Source |
|---|---|---|
| Form submissions and leads on a client's own website | WebDesk `submissions` | `webdesk/migrations/0003_forms.sql`; WebDesk WSK-38 design |
| Comments, direct messages, mentions and reviews on the client's social accounts (author handle, author name, text, an AI-stamped sentiment) | `social_inbox_threads`, `social_inbox_messages` | `0105_module_social.sql` |
| Search and ads account connections (tokens held in the connections vault) and the data pulled with them | `integration_connections` and the search module tables | `0033_integration_connections.sql` |

A **data-processing agreement (DPA)** with each client is therefore required before Gaiada handles that content. «ASSUMPTION: no such DPA text exists in the repo; counsel to supply or approve a template.» → open item 2. The same group company can hold both roles for the same client (controller for the contact, processor for their content); the notice (§12) says so.

### 3.3 Where the line is blurry

- **Reports and account summaries** are written by Gaiada about the client's results. The numbers come from the client's accounts (processor role) and the report is Gaiada's own work product for the client (controller of its own contact data inside it). Counsel to confirm that a split analysis is not needed. → open item 3.
- **Conversation** is Gaiada talking to the client's people about the work. Gaiada is the controller of that record; where the client pastes its own customers' data into a message or attachment, Gaiada receives data it did not ask for (R-P6).

---

## 4. Lawful basis per purpose

### 4.1 Summary

| Purpose | Basis | Why |
|---|---|---|
| Creating the contact's account, logging them in, scoping what they see | Performance of the client contract (the client asked for portal access for its people) | Needed to deliver the service the contract describes |
| Contract signing: recording the typed name, the content hash, the time and the evidence hashes | Performance of the contract; legal obligation or legitimate interests for the evidence value «ASSUMPTION: counsel to choose; see §4.3» | The record is what makes the signature provable |
| Conversation messages and files | Performance of the contract | The client asked to work with us through the portal |
| Invoices, payment checkout, payment status | Performance of the contract; legal obligation for the financial record | Collecting and recording payment |
| In-app notifications and the two client mail types | Performance of the contract | The contract's workflow needs the client to act or to know |
| Published reports and account summaries | Performance of the contract | The service the client bought |
| Security logging, abuse prevention, rate limits on portal routes | Legitimate interests (§4.2) | Needed to run the portal safely |
| Audit and activity trail | Legitimate interests (§4.2) and legal obligation «ASSUMPTION» | Accountability, dispute evidence |
| AI drafting of replies and report narratives | Performance of the contract for the output; legitimate interests for the processing by an AI provider (§5) | The client is served faster; staff stay in control |
| Statutory record keeping (contracts, invoices) | Legal obligation | Tax and company-document law «ASSUMPTION: §8» |

**Consent is not used** for the portal's core processing. The client's agreement to the terms (§13) is **contractual acceptance and, for signing, an explicit consent to the electronic-signature method**; it is not a consent used as the lawful basis for processing personal data. «ASSUMPTION: counsel to confirm this separation under UU PDP.»

### 4.2 Legitimate-interests uses (mini-LIAs)

**A. Security logs and rate limits on portal routes.** *Interest:* keep the portal safe for clients and for us. *Necessity:* the portal is a login surface that handles signing and payment. *Balance:* the data is the IP, the user agent, the route and the time; kept for a short period; used for no other purpose «ASSUMPTION: the log host and retention are the same unknowns as `website-visitor-addendum.md` item 16».

**B. Audit and activity trail.** *Interest:* show who did what to a client record, answer a dispute, detect misuse by staff. *Necessity:* append-only user ids on actions are the minimum. *Balance:* the data subjects are the contacts and the staff who dealt with them; the effect on them is low and they would expect it.

**C. AI processing by a provider (§5).** *Interest:* faster and more consistent drafts for the client. *Necessity:* only the minimum the draft needs is sent; the model never acts alone. *Balance:* see §5.3: a human sends every reply and publishes every report.

### 4.3 The signing evidence

The signature record (D4) is kept so that Gaiada and the client can show what was agreed, by whom and when. Counsel to decide whether the record rests on the contract, on a legal obligation (for example, proof of agreement), or on legitimate interests, and to confirm that the **salted IP hash and the user agent** are proportionate. → open item 5.

---

## 5. AI processing of client data

### 5.1 What happens, and which service calls the AI

| Use | What the AI sees | Who calls it | Source |
|---|---|---|---|
| **Account-summary narrative** (a monthly report to a client) | The snapshot's own numbers and labels, nothing else; a prompt built from "grounding facts". The completion is rejected if it states a number the facts do not hold, and any failure falls back to a deterministic text | **`platform-nest`**, which makes one `completeViaGateway` call to the AI gateway (`ai-gateway-go`). Staff edit and publish it | `src/modules/clients/account-summary/draft.ts`; `document.ts`; `src/modules/reports/narrative.ts` |
| **Report narratives** for staff performance reports (`ReportDocument`) | The same discipline: aggregate numbers, names and period label; no free text, no message text | **`platform-nest`** (`report-seal.ts`), one gateway call per document | `src/modules/reports/report-seal.ts`; `narrative.ts`. These are staff reports; they reach a client only if published through a client report, which §3.3 and open item 3 cover |
| **Search and social report narratives** and other drafts for a client's accounts | The client's marketing metrics; for social, the text of inbound comments and messages («ASSUMPTION: the inbox sentiment stamp and draft replies send comment text to the model; not traced») | **`platform-nest`** modules `search` and `social` (`ai-drafts.ts`, `gateway-client.ts`) | `src/modules/search/ai-drafts.ts`; `src/modules/social/ai-drafts.ts` |
| **Draft replies in Conversation** | Whatever the calling agent reads with `conversation.listThreads` and `conversation.getThread`: the thread's **message text** and subject | **No `platform-nest` code calls an AI for this.** The platform only offers the tool `conversation.draftReply` (`core-tools.ts`, PV4-07). The model call happens in the **agent** that calls the tool through the MCP hub: the platform agents in `ai-agents/` (models "come from the Gateway", no provider key there) and the Hermes agent, whose version-controlled config names **a model provider directly (Gemini)**, with a recorded plan to move behind the gateway (`hermes-config/config.yaml.tmpl`) | `src/core/core-tools.ts`; `src/core/conversation-core.ts` (`conversation_drafts`: staff-only table, never read by the portal); `ai-agents/CLAUDE.md`; `hermes-config/config.yaml.tmpl` (captured 2026-08-23) |

«ASSUMPTION: the Hermes agent still uses a direct provider key. If so, a client's message text reaches that provider outside the gateway's DLP scrub, daily cap and egress audit. Confirm the live configuration; if it is still direct, either move it behind the gateway before the portal goes live or exclude Conversation from that agent.» → open item 7.

### 5.2 The gateway, and who the AI providers are

`ai-gateway-go` is the only service that holds provider keys (`ai-gateway-go/CLAUDE.md`). It offers a provider chain with failover (Anthropic Claude, Google Gemini, and an OpenAI-compatible endpoint that can front OpenRouter or Ollama Cloud, ending in a keyless `echo` terminator), a fail-closed DLP scrub (card-number and national-ID patterns), a daily cost cap and an egress audit with a dial-time allowlist.

«ASSUMPTION: which provider actually serves client data in production, on which tier, with what data-processing terms and "no training" setting, and in which region. The repo does not say. The existing pack's assumption (paid tier with a DPA and no-training terms, or a local model; the free tier only for the opt-in trial with no real data) is **carried over** and must be true for client content as well.» → open items 6 and 7.

### 5.3 Controls that are IN CODE

- **Agents draft, staff send** (PV-D23): an agent cannot post, send a draft or close a thread; the platform refuses with a typed reason and the Cerbos policy denies it. A human sends each message, and the author on the record is the staff member (`drafted_by` records provenance). Drafts are stored in `conversation_drafts` and are never shown to the client.
- **A human publishes each report.** An AI narrative is a draft that a staff member edits (`source` becomes `human`) and publishes.
- **Hallucinated-numeral guard** on report narratives (a number not in the facts voids the text).
- **No automated decision with legal effect** about a client contact is made by any AI in the portal. «ASSUMPTION: confirm this stays true. The AI never decides who may sign, pay or log in.»

### 5.4 What the notice must say

That AI helps draft replies and reports, that staff review them, which kinds of provider receive the text, and how to object (§9, §12).

---

## 6. Recipients and sub-processors

| Party | Role | Function | Data | Safeguard needed |
|---|---|---|---|---|
| Group staff with the matching permission | Recipients | Handle the client's account | D1 to D11 as their role allows | Cerbos, tenant isolation (RLS), per-client portal scope |
| **Midtrans** (Snap hosted checkout; sandbox, then production) | «ASSUMPTION: independent controller for card and bank details the payer enters on its page; processor-like for the status we receive; confirm» | Online payment | We send: our order id, the amount, expiry, a return URL. We receive: status, payment type, times | Merchant terms and its privacy terms accepted and filed; production keys; counsel on the role split |
| **Google Workspace SMTP relay** («ASSUMPTION: the default mail transport; the go-live plan lists the Workspace relay and `notify.gaiada.com` DNS as owner actions») | Processor | Deliver client mail | Recipient email, subject, link, a short title | Workspace data-processing terms; SPF, DKIM, DMARC |
| **Brevo** (configured failover, `MAIL_STREAM_*_TRANSPORT=brevo`) | Processor, **only if switched on** «ASSUMPTION: off by default» | Failover transport; delivery events | As above, plus delivery webhooks | DPA before it is ever switched on; add to the register |
| **AI providers behind the gateway** (§5.2) | Processor | Drafts and narratives | The prompt text (§5.1) | DPA with no-training terms; DLP in front; region known |
| **Keycloak** (ours, self-hosted) | Part of our own system | Login | D3 | Hosting and backup as D1 |
| **Hosting** of the ERP, the database and the file store («ASSUMPTION: `gda-aicenter`, a cloud VM; the provider and its region to be confirmed») | Processor | Store everything | All | Provider DPA; region; backups |
| **Cloudflare** | «ASSUMPTION: only if the portal is behind its proxy or uses Turnstile; not traced here» | Network edge | IP and request metadata | Confirm and add if used |
| Counsel, auditors, tax authorities, courts | Recipients on a legal basis | Compliance | As required | Need-to-know; log the disclosure |

A **current sub-processor list** must be kept and shown to clients on request (the existing pack's practice; `ropa.md` §2).

---

## 7. Cross-border transfers

| Item | Detail |
|---|---|
| Trigger | The AI providers behind the gateway (US and global), Midtrans (Indonesia; a payer's card network is global), the mail relay (Google, global), and the hosting region if outside Indonesia |
| Mechanism | «ASSUMPTION: UU PDP cross-border rules (adequate protection, adequate and binding safeguards, or consent) apply to the provider transfers; EU/SG clients' contacts would add GDPR transfer rules and standard contractual clauses» → open item 4 |
| Mitigation | The gateway's DLP scrub in front of every provider; prompts built from the minimum (§5.1); the hash-only evidence design (D4); the option, in the existing pack's target state, to move to local models, which would largely remove the transfer risk |

---

## 8. Retention

The repository sets **no retention for any portal table** (checked: no purge or prune code for `mail_log`, `notifications`, `conversation_*`, `client_contacts` or `contract_signatures`; messages are permanent by design, PV-D34; client-report files are records that are never deleted). Every period below is therefore a **proposal** and every statutory reference is an «ASSUMPTION» for counsel.

| # | Data | Proposed retention | Trigger | Basis for the period | Disposal |
|---|---|---|---|---|---|
| 1 | Contact identity (`users`, `client_contacts`) | Active: while the contact is active. After revoke: **24 months**, then anonymise the person fields «ASSUMPTION» | `revoked_at` | Dispute window; no statute found | Pseudonymise `users.email` and `name`; keep ids for referential integrity (the audit and signature rows point at the user) |
| 2 | Open invites (`client_invites`) | Until expiry (72 h) and consumed or expired rows **30 days** «ASSUMPTION» | `expires_at` | Security | Delete |
| 3 | Signed contracts, signature rows, sealed copies and evidence | **10 years** from the end of the contract «ASSUMPTION: Indonesian company-document and tax record-keeping rules point to about ten years for financial documents; counsel to confirm the figure and the start date» | Contract end | Legal obligation; evidence | Cannot be erased while the period runs; restrict access |
| 4 | Invoices, payment records, payment proofs | **10 years** «ASSUMPTION: same as row 3» | Invoice date | Legal obligation | As row 3 |
| 5 | Checkouts and provider events (`payment_checkouts`, `provider_events`) | Same as the payment they belong to | — | Reconciliation | As row 3 |
| 6 | Conversation messages and files | **Permanent today (PV-D34).** Proposed: for the life of the client relationship plus **24 months** «ASSUMPTION», then export-and-delete or anonymise authors | Client relationship end | Service record; dispute window | **Needs a counsel-approved, operator-run purge**: the code deliberately cannot delete messages. The database has an operator escape hatch (`app.conversation_purge`, named only by the test); using it on a client's thread is a documented operator act, never an application route |
| 7 | Notifications (`notifications`) | **12 months** «ASSUMPTION» | `created_at` | Low value after reading | Delete (no job exists yet) |
| 8 | Mail spool (`mail_log`, `mail_messages` for replies) | **12 months** «ASSUMPTION» | `created_at` | Delivery proof, abuse | Delete (no job exists yet) |
| 9 | Published client reports and their files | Same as the client relationship plus **24 months**; the file is a record (the role guard forbids deleting or changing it) | Report date | Service record | Needs the same operator path as row 6 |
| 10 | Audit and activity trail | **24 months** «ASSUMPTION: the existing pack leaves audit retention to counsel, `retention-and-dsr-procedure.md` row 6» | Entry time | Accountability | Time-based purge |
| 11 | Keycloak account and login events | Account: deleted at the contact's pseudonymisation (row 1). Login events: «ASSUMPTION: confirm the realm setting» | — | Security | Delete in the realm |
| 12 | Security and access logs for portal routes | **14 days** «ASSUMPTION: same as `website-visitor-addendum.md` F16» | Entry time | Abuse prevention | Expire |
| 13 | AI prompts at the provider | Per provider terms «ASSUMPTION: no-training, no retention beyond the request; confirm per provider» | — | — | — |
| 14 | DSR request log | As `retention-and-dsr-procedure.md` row 7 | Closure | Accountability | As that row |

**Gaps to schedule before go-live** (they are tickets, not part of this draft): purge jobs for rows 2, 7, 8, 10; an operator procedure for row 6 and 9; a pseudonymise command for row 1.

---

## 9. Data-subject rights

The procedure is `retention-and-dsr-procedure.md` Part 2 (channel, identity check, SLA, request log, legal hold). It was written for employees and the bot; this section says how it applies to a client contact. The basis here is mainly **contract**, so access, rectification, erasure and objection (to the legitimate-interests uses only) apply, and **portability** applies to data the contact provided under the contract «ASSUMPTION: counsel to confirm».

### 9.1 How each right works, per system

| System | Identify the person by | Access / export | Erasure / objection |
|---|---|---|---|
| `users`, `client_contacts` | Email | Query by email across tenants (the `principal_lookup` policy admits one user's rows across tenants) | Pseudonymise per §8 row 1; a contact can be **revoked** at once (`/client-contacts/:id/revoke`), which disables the Keycloak account when it was their last active contact |
| Keycloak | Email | Admin console | Delete the user |
| Typed-signature rows | Signer user id | Export the row (hashes, time, typed name, user agent) | **Not erasable while the contract period runs** (§8 row 3). The row survives with the name; the IP is only a hash |
| Conversation messages | Author user id | Export the contact's messages and files | **Messages cannot be deleted by the application (PV-D34).** An erasure request needs an operator purge and counsel's view on the retention conflict (R-P4) |
| Files | Uploader id | Export | Delete the object and row; blocked for files under a non-draft contract and for client-report files (record guards) |
| Payments | Invoice or client id | Export | Not erasable inside the statutory period |
| `notifications`, `mail_log`, `mail_suppressions` | `user_id` or email | Query | Delete rows older than the retention; keep the `mail_suppressions` entry (it holds the address in clear) so a bounced address is not mailed again, and tell the contact why |
| AI providers | — | Prompts are not stored by us beyond the draft rows | Provider-side deletion per terms |
| WebDesk submissions, social inbox, search accounts (processor role) | — | **Refer the request to the client (the controller)** and help with export or erase on its instruction | As instructed; WSK-38 covers WebDesk `submissions` |

### 9.2 What does not exist yet

- **No ERP privacy command covers portal contacts.** The only DSR tooling in the ERP is the agency-intake set (`agency_privacy.find`, `.export`, `.erase`, `src/core/agency-privacy.*.ts`), built for web-lead and discovery-intake data. A contact request is a **manual, operator-run** job until a command like it is built (the existing pattern: hash-only identifier in a request ledger, find, export, erase). → follow-up ticket; open item 8.
- The privacy and DPO address in the portal itself, and the first-login acceptance record (§1.2).

### 9.3 Timelines and channel

As the existing procedure: email to [DPO NAME/EMAIL], acknowledge in [3 business days], respond in [30 days]. «ASSUMPTION: align with UU PDP's statutory period.» A request from a contact about content that belongs to the client's own customers is passed to the client (the controller) within [5 business days].

---

## 10. DPIA-lite

A full DPIA is **not** drafted here: the processing is limited to business contacts, uses small data sets, and makes no automated decisions. A short risk table follows; counsel to decide whether UU PDP requires a formal impact assessment for any item (R-P3, R-P5). The existing `dpia.md` stays the model if counsel asks for the longer form.

| ID | Risk | L | S | Residual | Mitigations IN CODE or proposed |
|---|---|---|---|---|---|
| R-P1 | A contact sees another client's data | Low | High | Low | Per-client portal scope (`resolvePortalScope`), tenant RLS on the portal tables, "reach first, then capability" ordering in the signing route; DB-backed tests exist but have not been run for this ticket |
| R-P2 | An invite link is stolen and used | Medium | High | Medium | HMAC-signed token with the tenant inside, single use by an atomic UPDATE, 72-hour TTL, only the hash stored, bound to the invited email; the accept route refuses to adopt a staff account (an account-takeover case closed 2026-10-13). Residual: today a PM copies the link by hand |
| R-P3 | A contact cannot withdraw or erase because messages are permanent | Medium | Medium | Medium | PV-D34 is deliberate. Needs counsel's view and an operator purge procedure (§8 row 6; open item 8) |
| R-P4 | Retention conflict: contract and invoice records must be kept, yet the contact asks for erasure | Medium | Low | Low | Pseudonymise person fields and keep the record; state the legal-obligation limit in the notice |
| R-P5 | Client content goes to an AI provider with weak terms or in the wrong region | Medium | High | **Medium until open items 6 and 7 close** | Gateway DLP and cap; agents draft and staff send; minimum prompts; Hermes may be outside the gateway (§5.1) |
| R-P6 | Third-party personal data pasted or uploaded by a client (a customer's name, a document) | High | Medium | Medium | Scrub of text attachments; message length cap; the notice asks the client not to upload what it has no right to share; binaries are not scanned |
| R-P7 | The signature evidence is weaker than the notice says | Medium | Medium | Medium | The row stores a pseudonymous IP hash and a user agent; the terms (§13) describe it honestly as attested, not certified (PV-D44) |
| R-P8 | Mail is sent to a wrong or old address | Low | Medium | Low | The invite binds the email; the mail carries a link, not content; suppression list; allow-list of three mail kinds |
| R-P9 | A client contact account has no second factor (PGL-Q2) | Medium | High (signs and pays) | Medium | Default: not required for v1. Counsel may change this. Cross-reference: PGL-Q2 in the go-live plan; staff MFA is separate (PV-D40/PV-D45) |
| R-P10 | A breach affecting contacts | Low | High | Medium | Breach process and the UU PDP notification timeline are counsel items (open item 12) |

L = likelihood, S = severity.

---

## 11. RoPA entries (rows for `ropa.md`)

Format follows `ropa.md`. Controller, DPO and jurisdiction are [CONTROLLER ENTITY], [DPO NAME/EMAIL], [JURISDICTION].

| ID | Activity | Purpose | Data subjects | Data categories | Basis | Recipients | Transfer | Retention | Security |
|---|---|---|---|---|---|---|---|---|---|
| P1 | Portal contact management and login | Give a client's people access to the portal | Client contacts | D1, D2, D3 | Contract | Staff with the permission; Keycloak (ours) | Host region «ASSUMPTION» | §8 rows 1, 2, 11 | RLS, Cerbos, hashed invite token, no stored password |
| P2 | Contract signing (typed, attested) | Record who agreed to what, when | Contacts with `signer` capability; provider-side signer staff | D4 | Contract; legal obligation or LI «ASSUMPTION» | Staff; the client | Host region | 10 years «ASSUMPTION» | Content hash echo, tenant RLS, salted IP hash, company seal on the signed copy |
| P3 | Conversation | Work with the client about a project | Contacts; staff; people named | D5, D6 | Contract | Staff in scope; the AI agents that draft (§5) | Host region; AI providers | §8 row 6 | Scope kernel, scrub of text attachments, drafts staff-only |
| P4 | Invoicing and online payment | Collect payment, record status | Contacts who pay or view invoices | D7 | Contract; legal obligation | Finance staff; Midtrans | Midtrans; card networks «ASSUMPTION» | 10 years «ASSUMPTION» | No card data; signed provider notice re-fetched through the status API before any write |
| P5 | Notifications | Tell the client what needs them | Active contacts | D8 | Contract | Staff (own side); none external | — | 12 months «ASSUMPTION» | Payload carries ids and titles only |
| P6 | Client mail | Mail a sign-off gate and a Conversation pointer | Active contacts | D9 | Contract | Mail relay (Workspace; Brevo only if switched on) | Provider regions | 12 months «ASSUMPTION» | Allow-list of mail kinds, throttle, no message text in the mail, suppression list |
| P7 | Reports and account summaries | Deliver results to the client | Contacts; people in report content | D10 | Contract | Staff; AI via the gateway for the narrative | AI providers | §8 row 9 | Human publishes, numeral guard, record guard on the file |
| P8 | AI drafting of replies and narratives | Faster drafts, staff-controlled | Contacts; people in messages | Text of D5, D10 | Contract for the output; LI for the processing | AI providers behind the gateway; agents | US and global «ASSUMPTION» | Per provider terms | DLP scrub, cost cap, egress audit, agents cannot send |
| P9 | Security logging and audit trail | Keep the portal safe; accountability | Contacts; staff | IP, user agent, D11 | LI; legal obligation «ASSUMPTION» | Staff with the permission; host | Host region | §8 rows 10, 12 | Append-only, restricted access |
| P10 | Processing client content for the client (processor) | Run the client's site forms, social and search accounts | The client's own customers and audience | WebDesk `submissions`; social inbox rows; connection tokens | Controller's instructions (DPA) | Per the DPA | Per the DPA | Per the DPA | Tenant RLS, vault, WSK-38 |

### 11.1 Processors and joint controllers

As §6. Midtrans is listed as an independent controller or recipient pending counsel's answer.

### 11.2 Transfers

As §7.

---

## 12. Portal privacy notice (DRAFT)

> **DRAFT — not legal advice.** English text. **An Indonesian version is required** (UU PDP expects the notice in a language the person understands) and waits for counsel's translated notice. Brackets are placeholders. Counsel to review every sentence. The text describes the portal as it is designed; it is not shown to anyone until the "later" ticket (§1.2) is built.

### Summary (shown first)

**Your privacy in the client portal, in short.**

- Your project manager at [CONTROLLER ENTITY] invited you so you can work with us in the portal: read documents, sign agreements, message us, see reports and pay invoices.
- We keep your name and work email, what you do in the portal (signatures, messages, files, payments) and a security record of it.
- When you sign, we record your typed name, the time, the exact text you signed (as a fingerprint), your browser's identity string and a scrambled version of your network address. We do not keep the address itself.
- We never receive or keep your card details. Online payments are made on Midtrans' own page.
- AI tools may help us draft replies and report text. A member of our team reads and sends every reply and publishes every report.
- Some records, such as signed agreements and invoices, must be kept for years, even if you ask us to delete your account.
- Questions or requests: [DPO NAME/EMAIL].

### Full text

**1. Who we are.** [CONTROLLER ENTITY], part of the Gaiada group, [CONTROLLER ADDRESS], is responsible for your personal data in the portal. Contact for privacy: [DPO NAME/EMAIL]. «ASSUMPTION: confirm entity.» For content we handle on behalf of your organisation (for example the forms on its website or its social media inbox), your organisation is responsible and we act on its instructions.

**2. What we collect and why.**

| What | Why | Our basis |
|---|---|---|
| Name, work email, job title (if given), the client and projects you may see, whether you may sign or only view | To create your account and decide what you can see | Our contract with your organisation |
| Login details held by our login service (your email and a password you choose; we do not see it) | To let you log in | Our contract |
| For a signature: your typed name and title, the time, a fingerprint of the exact agreement text and schedule you saw, your browser's identity string and a scrambled (hashed) version of your network address | To prove what was agreed, by whom, and when | Our contract; our legal interest in evidence «counsel to confirm» |
| Messages and files you send us | To work with you on your projects | Our contract |
| Invoice and payment information: amounts, dates, status, a reference, and any transfer receipt you upload | To collect and record payment | Our contract; legal obligation for financial records |
| Notifications and emails we send you | To tell you what needs your attention | Our contract |
| Reports and summaries we publish to you | To deliver the service | Our contract |
| Security and audit records (who did what, when, from which route) | To keep the portal safe and to answer disputes | Our legitimate interests; legal obligations |

**3. Card details.** We do not collect, see or store card numbers. If you pay online you are sent to a Midtrans page. Midtrans handles what you enter there under its own terms and privacy notice; we receive only the result of the payment.

**4. AI.** We use AI services, through our own gateway, to help draft replies and report text. What is sent is limited to what the draft needs. A member of our team reviews and sends each reply and publishes each report, and no AI decides anything about you. «Counsel to confirm the wording on provider names, regions and no-training terms once open items 6 and 7 are answered.»

**5. Who receives your data.** Our staff who work with your organisation; our service providers: hosting [HOSTING PROVIDER], email delivery (Google Workspace [and Brevo if used]), the payment provider (Midtrans), and AI providers behind our gateway; and, where the law requires, authorities and advisers. A list of our providers is available from [DPO NAME/EMAIL].

**6. Transfers outside Indonesia.** Some providers process data outside Indonesia («ASSUMPTION: the US and other regions»). We rely on [TRANSFER MECHANISM] «counsel to complete» and give you a copy of the safeguards on request.

**7. How long we keep it.** As long as you have an active account, and afterwards for [24 months] for your contact details and conversation records «ASSUMPTION». Signed agreements, invoices and payment records are kept for [10 years] «ASSUMPTION: statutory» because the law requires it. Our mail and notification records are kept for [12 months] «ASSUMPTION».

**8. Your rights.** You may ask us to give you a copy of your data, correct it, delete it, restrict or object to its use where our basis is legitimate interests, and to receive the data you gave us. We cannot delete records we must keep by law, and our message history is kept as a permanent record of what was said «counsel to confirm how this is worded». To use a right, write to [DPO NAME/EMAIL]. We answer within [30 days]. You may complain to [REGULATOR].

**9. Security.** Access is restricted by organisation and by project. Your invite link works once and expires in 72 hours. We store only a fingerprint of it.

**10. Changes.** We will tell you in the portal if this notice changes in a way that matters to you.

---

## 13. Portal terms of use (DRAFT)

> **DRAFT — not legal advice.** English text. An Indonesian version is required for use in Indonesia and waits for counsel. Brackets are placeholders. Counsel to review every sentence, in particular §13.4 and §13.5, which touch UU ITE, PP 71/2019 and the Civil Code on proof and consent.

**13.1 Who and what.** These terms govern your use of the client portal operated by [CONTROLLER ENTITY] ("we"). They sit on top of your organisation's contract with us; if they conflict with that contract, the contract wins on the points it covers «counsel to confirm».

**13.2 Your account.** You were invited by your project manager; the link works once and expires. Keep your login private. You are responsible for what is done with it. Tell us at once if you think someone else has used it. We may suspend or revoke an account that is misused, or when your organisation or we end your access. You will lose access to the portal when you are revoked, but not the records of what you did.

**13.3 What you may do.** You may use the portal for your organisation's work with us. You may not try to see another organisation's data, probe or disrupt the portal, upload malware, or upload personal data you have no right to share. Upload only what the work needs.

**13.4 Electronic signature (attested signature).** When you sign an agreement in the portal you do so by **typing your name and confirming that you agree** to the exact text shown. You agree that:

1. this typed-name confirmation is your **electronic signature** and is intended to bind you, or the organisation you are authorised to sign for, in the same way as a handwritten signature, **to the extent the law allows**, including under Indonesian Law No. 11 of 2008 on Electronic Information and Transactions (UU ITE), as amended, and Government Regulation No. 71 of 2019 on the Implementation of Electronic Systems and Transactions (PP 71/2019) «counsel to confirm the citations and that the method satisfies the law's requirements for this kind of document»;
2. you are authorised to sign for your organisation, and you are the person whose name you typed;
3. we record, as evidence of the signing, the typed name, the time, a fingerprint (hash) of the exact agreement text and instalment schedule you saw, your browser's identity string and a salted hash of your network address (not the address itself); and we keep a signed copy, sealed with our company key, with an evidence page;
4. we may use these records to show that you signed, and in a dispute;
5. an agreement you sign is final: to change it, a new version must be issued.

**13.5 This is NOT a certified electronic signature.** The signature in the portal is an **attested electronic signature made in our own system**. **It is not a certified electronic signature issued by an Indonesian certified electronic certification provider (PSrE).** (This follows the owner's ruling PV-D44, "simple signing only, no PSrE".) A certified signature can carry a stronger presumption of validity in some situations. By signing here, you accept an attested signature and that **a certified signature is not offered**. If your organisation, a regulator or a counterparty needs a certified signature or a wet-ink signature for a document, tell your project manager before signing. «Counsel to confirm whether any document type we put in the portal legally requires a certified signature or a wet-ink signature, and whether stamp duty (bea meterai) or an e-Meterai applies: see open item 10 and PV5-Q2.»

**13.6 Payments.** Online payments are made on Midtrans' hosted page under Midtrans' terms. We do not receive your card details. A payment is recorded when the provider confirms it to us and we have checked the status. If you pay by bank transfer you may upload the receipt; staff confirm it. Do not upload more than the receipt needs.

**13.7 Messages, files and AI.** Your messages are kept as a permanent record. Staff reply; AI tools may help staff draft replies and reports, but staff send and publish them. Do not send card numbers or national ID numbers; our systems redact some but not all of them.

**13.8 Privacy.** Our portal privacy notice (§12 above, once approved) explains how we use your personal data.

**13.9 Availability and changes.** We aim to keep the portal available but do not promise uninterrupted service «counsel to confirm against the master contract». We may change these terms; where a change matters we will tell you in the portal.

**13.10 Law and disputes.** Indonesian law governs these terms. «Counsel to set the forum, language and dispute process; and the effect of an English version.»

---

## 14. "Legal Gate 1 green for the portal": the checklist

The board item "Legal Gate 1 green for the portal" ticks against this checklist, **and only when counsel has reviewed and signed each line**. A drafter's tick is not enough, and an item answered "not required" must say who decided and why. Status of every line today: **PLANNED** (not reviewed).

| # | Counsel reviews and signs | Document section | Signed (name, date) |
|---|---|---|---|
| G1 | Controller entity per client contract, and whether any group company is a joint controller | §3.1, open item 1 | |
| G2 | Processor role for client content, and the DPA template to use | §3.2, open item 2 | |
| G3 | Lawful bases per purpose, and that consent is not the basis; the three legitimate-interests tests | §4 | |
| G4 | Signing evidence: basis, and proportionality of the salted IP hash and user agent | §4.3, D4, open item 5 | |
| G5 | AI processing: the providers, tier, no-training terms, region and the Hermes configuration | §5, open items 6 and 7 | |
| G6 | Recipients, sub-processors and Midtrans' role | §6, open item 3 | |
| G7 | Cross-border transfer mechanism per provider | §7, open item 4 | |
| G8 | Retention periods, statutory periods and the retention-versus-erasure conflict (permanent messages) | §8, open items 8 and 11 | |
| G9 | Data-subject rights handling for a client contact, including the processor-role referral and the manual procedure until a command exists | §9, open item 8 | |
| G10 | DPIA-lite: whether UU PDP requires a formal impact assessment, and the breach process | §10, open item 12 | |
| G11 | RoPA rows P1 to P10 accepted for `ropa.md` | §11 | |
| G12 | The portal privacy notice text, and the Indonesian translation | §12, open item 13 | |
| G13 | The portal terms of use, including §13.4 (attested signature, UU ITE, PP 71/2019) and §13.5 (not a PSrE signature, PV-D44) | §13, open item 10 | |
| G14 | Whether any document type needs a certified or wet-ink signature, and stamp duty / e-Meterai (PV5-Q2) | open item 10 | |
| G15 | PGL-Q2: whether client contacts must use MFA (default: not for v1) | open item 14 | |
| G16 | A named DPO or contact, and whether registration or a DPO is required | open item 15 | |
| G17 | Counsel's sign-off on this checklist as a whole, with the date and the version of this addendum reviewed | — | |

**What the board item does not cover:** deliverability of mail, Midtrans production keys and the other cut-over steps (PGL-04), and the later ticket that shows the notice and records acceptance.

---

## 15. Open items for counsel and the owner

| # | Item | For | Decision needed |
|---|---|---|---|
| 1 | **Controller entity** per client contract; whether more than one group company can control one contact; the holding company's role | Owner, counsel | Name the entity; instantiate the RoPA per entity |
| 2 | **DPA template** for the processor role (client website forms, social and search accounts) | Counsel | Approve or supply; decide when it is signed relative to access |
| 3 | **Midtrans' role** (independent controller or processor) and the split analysis for reports and account summaries (§3.3) | Counsel | Opinion |
| 4 | **UU PDP cross-border transfer basis** for the AI providers, Midtrans, the mail relay and the hosting region; the EU/SG equivalent | Counsel | Per-vendor mechanism |
| 5 | **Signing evidence:** basis; is a salted IP hash plus the user agent proportionate; the evidence page fields | Counsel | Pick the basis; confirm |
| 6 | **AI providers actually used in production:** names, tier, DPA, no-training, region | Owner | Confirm and record |
| 7 | **Hermes direct provider:** is the agent still configured outside the gateway? If so, move it behind the gateway before go-live or exclude Conversation | Owner (integrator) | Confirm the live config; decide |
| 8 | **Erasure against permanent messages (PV-D34)** and the manual procedure for a contact's rights request; an ERP privacy command for portal contacts (none exists) | Counsel, owner | Counsel's view on the conflict; schedule a command and a purge procedure |
| 9 | **Acceptance record:** the later ticket that shows this notice and the terms and records acceptance at first login | Owner | Schedule after counsel's text |
| 10 | **Signature law:** confirm the attested-signature wording under UU ITE and PP 71/2019; whether any document type needs a PSrE or wet-ink signature; **stamp duty and e-Meterai (cross-reference PV5-Q2** in `docs/plans/2026-10-12-pv5-contracts-billing-tickets.md`: the system applies none today; staff handle it outside the ERP until counsel answers) | Counsel | Opinion |
| 11 | **Statutory retention periods** for contracts, invoices and payment records, and the start date | Counsel | Confirm or change §8 |
| 12 | **Breach notification** timeline and any DPIA filing duty | Counsel | Opinion |
| 13 | **Indonesian versions** of §12 and §13 | Counsel | Translate; review |
| 14 | **PGL-Q2: do client contacts need MFA?** Default in the go-live plan: not required for v1; staff MFA only (PV-D40/PV-D45). Clients sign and pay, so counsel's view may change this | Owner, counsel | Confirm or require |
| 15 | **DPO / contact:** appoint or designate; whether UU PDP requires a DPO; publish the address | Owner, counsel | Name and email for [DPO NAME/EMAIL] |
| 16 | **Hosting, region, backups and encryption at rest** for the ERP host, the file store and Keycloak | Owner | Confirm; record in the RoPA |
| 17 | **Keycloak login-event retention** and who can read them | Owner | Confirm the realm setting |
| 18 | **Brevo failover:** may it ever be switched on for client mail; DPA first | Owner | Decide; add to the register |
| 19 | **Client replies by email** to a gate mail (reply token, stored sanitised): routed where, kept how long | Owner (backend) | Confirm and set retention |
| 20 | **Portal third-party scripts:** confirm the portal loads none (no analytics, fonts or tag manager) | Owner (frontend) | Confirm; the notice assumes none |
| 21 | **Client-uploaded binaries** (images, PDFs, transfer receipts) are not scanned for personal data. Accept the residual risk or add a control | Counsel, owner | Decide |
| 22 | **Retention jobs** for notifications, mail log, invites and the audit trail do not exist; build before go-live or accept the exposure | Owner | Schedule |

---

## 16. What this addendum amends in the existing pack

- **`README-NOTES.md`:** a row is added to the table; nothing is removed.
- **`ropa.md`:** the rows in §11 are for pasting; this ticket did not edit it.
- **The pack's stance that clients and vendors are "detected and excluded"** (`retention-and-dsr-procedure.md` Part 3.1, `README-NOTES.md` open item 7) applies to the **WhatsApp bot**. It does not apply to the portal. This addendum does not contradict it, but a reader must not infer from it that client data is out of scope for Gaiada as a whole.
- **The go-live plan's description of the signature record** ("IP and user agent") is corrected in D4: the IP is stored as a salted hash.

---

*This is a DRAFT to accelerate legal review. It is not legal advice and must be reviewed, localized and signed off by qualified counsel in the applicable jurisdiction(s) before any real client contact's data is entered into the client portal.*
