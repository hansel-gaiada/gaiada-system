**DRAFT — not legal advice. For review by qualified counsel before use.**

# Records of Processing Activities (RoPA) / Data Map

> This RoPA records the processing carried out by the WhatsApp work-summary bot ("the Bot"). It is drafted to satisfy accountability obligations under Indonesia's UU PDP No. 27/2022 and, to be defensible for any EU/SG exposure, to **GDPR Article 30** grade. It must be kept current whenever processing, recipients, retention, or transfers change.

| Field | Value |
|---|---|
| Processing activity | Automated reading, storage, summarization, and querying of work-related WhatsApp messages ("the Bot") |
| RoPA version | 0.1 (DRAFT) |
| Date | [DATE] |
| Owner | [DPO NAME/EMAIL] |
| Applicable law | Indonesia (UU PDP No. 27/2022) primary; drafted to GDPR-grade. «ASSUMPTION: confirm jurisdictions» → [JURISDICTION] |
| Status | Pre-Gate-1; not yet in production with real data |

---

## 1. Controller

| Item | Detail |
|---|---|
| Controller (Pengendali Data Pribadi) | The Gaiada group / relevant child company. «ASSUMPTION: confirm which legal entity» → [CONTROLLER ENTITY] |
| Registered address | [CONTROLLER ADDRESS] |
| Data-protection contact / DPO | [DPO NAME/EMAIL] |
| Representative (if required for cross-border reach) | [EU/OTHER REPRESENTATIVE — if applicable] «ASSUMPTION: confirm whether a representative is required» |

Note on multi-entity structure: the Bot uses **per-entity** encryption key domains (see §10, "crypto-shred"), so each child company's data is cryptographically severable. Where more than one Gaiada entity acts as a controller, each entity is the controller for its own tenant, and this RoPA should be instantiated per controlling entity.

---

## 2. Processor(s) and sub-processors

| Role | Party | Function | Contractual safeguard |
|---|---|---|---|
| Processor — AI | "the AI processor": Anthropic (Claude) and/or Google (Gemini) | Generates project-status summaries and answers work-related queries from message content | **Data Processing Agreement with no-training terms** (paid/enterprise tier) for any real/regulated data. Free tier is used **only** for the opt-in trial with **no real/regulated data**. Option to migrate to a **local model** to remove third-party processing. |
| Processor — hosting / infrastructure | [HOSTING PROVIDER] «ASSUMPTION: confirm provider & region» | Storage, compute, backups for the Bot's datastore and pipeline | DPA required; region and sub-processor list to be recorded. |
| Processor — messaging transport | [WhatsApp / WhatsApp Business API PROVIDER] «ASSUMPTION: confirm how the Bot connects to WhatsApp» | Delivery of inbound/outbound messages | Terms/DPA to be confirmed; note WhatsApp's own controller/processor role. |

Sub-processor register: maintain a current list of each processor's sub-processors, their functions, and their locations. Free-tier AI usage is quarantined to the trial and is **never** fed real employee/client data.

---

## 3. Purposes of processing

Stated purpose (verbatim): **project progress tracking, workflow efficiency, and making it simpler to query work-related information.**

| # | Purpose | Description |
|---|---|---|
| P1 | Project progress tracking | Ingest work-related messages and produce twice-daily (12:00 & 18:00 GMT+8) project-status summaries delivered to the management group. |
| P2 | Workflow efficiency | Reduce manual status-collection overhead by automating summarization. |
| P3 | Query answering | Answer work-related questions on request from authorized users. |

Scope limit (material to proportionality): the Bot operates **only** in work groups and work-related DMs, and **only** on work-related content. It is **not** used for decisions about individuals — no performance management, discipline, or evaluation of persons. «ASSUMPTION: confirm this holds and keep it true.»

---

## 4. Lawful basis

| Item | Detail |
|---|---|
| Lawful basis | **Legitimate interests** of the Controller in running its operations efficiently (project tracking, workflow efficiency, work-information retrieval). |
| Why not consent | Consent is **not** relied upon: the employer/employee power imbalance means consent cannot be freely given, so it would not be valid. |
| Supporting assessment | See `lia.md` (Legitimate Interests Assessment) for the balancing test and safeguards, and `dpia.md` for risk analysis. |
| Basis for third-party data | None by default — third parties (clients/vendors) are **detected and excluded** unless a separate basis/contract exists (see §5). |
| UU PDP note | Under UU PDP No. 27/2022, confirm the corresponding lawful-processing ground and any notice obligations with counsel. «ASSUMPTION». |

---

## 5. Categories of data subjects

| Category | Included? | Notes |
|---|---|---|
| Employees / workers of the Controller | Yes (primary) | Participants in work groups and work-related DMs. |
| Third parties (clients, vendors, contractors) appearing in project groups | **Detected and excluded** | Their personal data is not processed for the Bot's purposes unless a separate lawful basis/contract exists. «ASSUMPTION: confirm client/third-party contractual position.» |

---

## 6. Categories of personal data

### 6.1 Data processed and stored

| Category | Examples | Notes |
|---|---|---|
| Work chat text | Message body of work-related content | Stored with personal-data fields encrypted (see §10). |
| Sender identity | WhatsApp number; display name | Used to attribute messages within a work group. |
| Derived summaries | Twice-daily project-status summaries; query answers | Generated from the above; delivered to the management group. |
| Media (Phase 2) | Voice notes, images, documents | Roadmap item; see suppression rules in §6.3. Update this RoPA before Phase 2 goes live. |

### 6.2 Data detected and redacted at ingestion — never stored

| Category | Handling |
|---|---|
| Payment card numbers (PAN) | **Detected and redacted at ingestion**; never written to storage. |
| National IDs (e.g. Indonesian KTP), passport numbers | **Detected and redacted at ingestion**; never written to storage. |

### 6.3 Special-category / sensitive data — suppressed

| Category | Handling |
|---|---|
| Faces, health data, biometrics (in media) | **Suppressed in the media pipeline** — not extracted, not stored. |

Design intent: the ingestion scrubber removes PAN and national-ID/passport identifiers **before** storage, and the media pipeline suppresses special-category content, so these categories are not held by the Bot. Confirm scrubber/suppression coverage and false-negative handling with the technical gate (`docs/superpowers/specs/2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md`).

---

## 7. Recipients

| Recipient | Type | What they receive | Basis / safeguard |
|---|---|---|---|
| The management group | Internal | Twice-daily project-status summaries; query answers | Internal operational oversight under legitimate interests; access limited to authorized members. |
| The AI processor (Claude / Gemini) | External processor | Message content sent for summarization/query answering | DPA + no-training terms (real data) **or** local model. Free tier: trial only, no real data. See §2 and §8. |
| Hosting / infrastructure provider | External processor | Data at rest and in processing | DPA; see §2. |

No sale of personal data and no use for advertising. No disclosure to other third parties without a lawful basis.

---

## 8. International transfers and safeguards

| Item | Detail |
|---|---|
| Transfer trigger | Sending message content to a cloud **AI processor** constitutes a **cross-border transfer** where the processor (or its infrastructure) is outside [JURISDICTION]. «ASSUMPTION: confirm processing regions.» |
| Transfer mechanism | **SCCs / adequacy / DPA** as applicable to the destination. Confirm the specific mechanism per processor and region with counsel. |
| Mitigations | Egress **DLP** on outbound content; ingestion redaction (§6.2) and special-category suppression (§6.3) reduce what leaves the boundary; option to move to a **local model**, which would largely remove the transfer. |
| UU PDP cross-border rule | Confirm UU PDP No. 27/2022 cross-border transfer conditions (adequacy / adequate safeguards / consent-or-other-ground) are met. «ASSUMPTION». |
| Target state | Re-assess and likely retire the transfer basis once processing moves to local models. |

---

## 9. Retention periods

| Data | Retention | Then |
|---|---|---|
| Raw messages | **90 days** | Auto-purge. «ASSUMPTION: confirm.» |
| Summaries | **12 months** | Auto-purge. «ASSUMPTION: confirm.» |
| Redacted identifiers (PAN, national IDs) | Not retained | Never stored (§6.2). |
| Special-category media content | Not retained | Suppressed (§6.3). |
| Audit logs | [AUDIT LOG RETENTION] «ASSUMPTION: confirm» | Per security/compliance policy. |
| Immutable backups | Governed by backup cycle | Erasure honored via **crypto-shred** (destroy key) despite WORM/immutable backups — see §10. |

Erasure interaction with backups: because some backups are immutable, deletion of individual records within them is not possible; erasure is instead achieved by destroying the relevant encryption key ("crypto-shred"), rendering the data unrecoverable. See `retention-and-dsr-procedure.md`.

---

## 10. Technical and organizational security measures (TOMs)

| Measure | Description |
|---|---|
| Crypto-shred encryption | **Per-subject + per-entity** encryption keys. Erasure = destroy the key, making the data unrecoverable; this works even against immutable/WORM backups. Also enables clean per-entity severability (e.g. divestiture). |
| Encryption of personal-data fields | Personal-data fields are encrypted before storage. |
| Row-level tenant isolation | Each tenant's/entity's data is isolated at the row level to prevent cross-tenant access. |
| Zero-trust access | Access controls follow a zero-trust model; least-privilege for the management group and operators. |
| Audit logging | Access and processing events are logged for accountability. |
| Ingestion redaction | PAN and national-ID/passport identifiers are detected and redacted **before** storage (§6.2). |
| Special-category suppression | Faces/health/biometrics suppressed in the media pipeline (§6.3). |
| Egress DLP | Data-loss-prevention controls on content leaving the boundary to the AI processor (§8). |
| Retention limits & auto-purge | Enforced retention windows with automatic deletion (§9). |
| Scope limiting | Bot restricted to work groups / work-related DMs / work-related content; third parties detected and excluded. |

---

## 11. Data-subject rights

| Right | How honored |
|---|---|
| Access | Provide the data held about the subject on verified request. |
| Rectification | Correct inaccurate personal data. |
| Erasure | Honored via **crypto-shred** (destroy the subject/entity key), effective even against immutable backups. |
| Objection / restriction | Handle objections to legitimate-interests processing and requests to restrict. |
| Contact | [DPO NAME/EMAIL] |

Procedure detail is maintained in `retention-and-dsr-procedure.md` and the data-subject-facing `privacy-notice.md`.

---

## 12. Change control

Update this RoPA whenever any of the following change: purposes, categories of data or data subjects, recipients or sub-processors, international transfers or their safeguards, retention periods, or the security measures. Re-assessment triggers (see `README-NOTES.md`) include: introduction of local models, MCP hub granting the Bot company-DB access, additional verticals/companies onboarding, Phase 2 media processing going live, or any agent auto-actions being added.

---

## Open questions for counsel (see also §§ above)

1. Confirm the controlling legal entity(ies) → [CONTROLLER ENTITY].
2. Confirm applicable jurisdiction(s) → [JURISDICTION] and whether DPO/registration is required.
3. Confirm hosting provider, region(s), and the messaging-transport (WhatsApp) processor arrangement.
4. Confirm the cross-border transfer mechanism per AI processor and region (SCCs/adequacy/DPA).
5. Confirm retention periods (raw 90 days; summaries 12 months) and audit-log retention.
6. Confirm the "no decisions about individuals" scope limit holds.
7. Confirm the client/third-party contractual position (whether their comms may be processed at all).
8. Provide the data-protection contact / DPO → [DPO NAME/EMAIL].
