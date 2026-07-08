**DRAFT — not legal advice. For review by qualified counsel before use.**

# Retention Schedule & Data-Subject-Rights Procedure

**Document:** Gate-1 legal pack — retention schedule and data-subject-rights (DSR) operating procedure
**Product:** The WhatsApp work-summary bot ("the Bot")
**Controller:** [CONTROLLER ENTITY] (the Gaiada group / relevant child company) ("the Controller") «ASSUMPTION: confirm which legal entity»
**Jurisdiction:** [JURISDICTION] — Indonesia (UU PDP No. 27/2022) as primary; drafted to GDPR-grade to cover EU/SG exposure «ASSUMPTION»
**Data-protection contact:** [DPO NAME/EMAIL]
**Status:** DRAFT — confirm retention periods and assumptions with counsel before use.

---

## Purpose & scope of this document

This document sets out (1) how long each category of personal data the Bot processes is kept and how it is destroyed, and (2) the procedure by which data subjects exercise their rights and how the Controller fulfils each right, including the technical mechanics of erasure against immutable backups.

Reminder of the Bot's purpose (the basis of every control here): **project progress tracking, workflow efficiency, and making it simpler to query work-related information.** The Bot operates **only in work groups and work-related direct messages, and only for work-related content.** It is **not** used for decisions about individuals (no performance management, discipline, or evaluation of persons). «ASSUMPTION: confirm this holds.» Data minimisation and short retention are therefore central to the legitimate-interests case, not optional.

### Defined terms
- **the Bot** — the WhatsApp system that reads, stores, summarises and answers questions on work-related content.
- **the Controller** — [CONTROLLER ENTITY].
- **work groups** — company WhatsApp work groups the Bot operates in.
- **work-related content** — messages and media concerning company work, the only content the Bot processes.
- **the management group** — the internal WhatsApp group that receives twice-daily (12:00 & 18:00 GMT+8) status summaries.
- **the AI processor** — the AI service used to generate summaries and answers (Claude / Google Gemini under a Data Processing Agreement with no-training terms, or a local model). The free AI tier is used only for the opt-in trial with no real/regulated data.
- **crypto-shred** — erasure by destroying the encryption key so the underlying ciphertext becomes permanently unrecoverable, even in immutable/WORM backups.

---

# Part 1 — Retention Schedule

## 1.1 Principles
- **Minimise at ingestion.** Card numbers (PAN) and national IDs (e.g. Indonesian KTP)/passports are detected and redacted before storage and are never stored. Special-category data (faces/health/biometrics) is suppressed in the media pipeline. These items have **no retention period because they are never persisted.**
- **Keep only as long as needed.** Raw work-related content is short-lived; only the derived summaries persist for an operational window.
- **Destroy, don't just hide.** Disposal is by **crypto-shred** (destroying the relevant encryption key) plus a **tombstone** record proving disposal, so erasure is effective even against immutable backups.
- **Per-subject + per-entity key domains.** Personal-data fields are encrypted under keys scoped per data subject and per entity, which makes both routine purges and rights-based erasure surgical and verifiable.

## 1.2 Schedule

| # | Data type | Retention period | Trigger for clock | Disposal method |
|---|---|---|---|---|
| 1 | **Raw messages** — work chat text; sender identity (WhatsApp number, display name) | **90 days** «ASSUMPTION: confirm» | Message ingestion timestamp | Auto-purge job destroys the per-subject/per-entity content key (**crypto-shred**) and writes a **tombstone**; live rows deleted |
| 2 | **Derived summaries** — twice-daily project-status summaries delivered to the management group | **12 months** «ASSUMPTION: confirm» | Summary generation date | Auto-purge job crypto-shreds the summary's key and writes a tombstone; live rows deleted |
| 3 | **Media (Phase 2)** — voice notes, images, documents (after special-category suppression + PAN/ID redaction) | **90 days** «ASSUMPTION: align with raw messages; confirm» | Media ingestion timestamp | Crypto-shred key + tombstone; live object deleted |
| 4 | **PAN (card numbers), national IDs (KTP)/passports** | **Not retained** — redacted at ingestion before storage | N/A (never persisted) | N/A — never written to storage |
| 5 | **Special-category data** (faces/health/biometrics) | **Not retained** — suppressed in media pipeline | N/A (never persisted) | N/A — never written to storage |
| 6 | **Audit / access logs** (who accessed what, when) | [RETENTION — e.g. 12–24 months] «ASSUMPTION: set with counsel; must outlast operational data to evidence compliance» | Log entry timestamp | Time-based purge; retain in tamper-evident store until expiry |
| 7 | **DSR request log** (Part 2.6) | [RETENTION — e.g. 3 years or per limitation period] «ASSUMPTION: set with counsel» | Request closure date | Time-based purge |
| 8 | **Third-party (client/vendor) content** detected in work groups | **Not retained** — detected and excluded unless a separate basis/contract exists | N/A (excluded at ingestion) | N/A — dropped before storage (see Part 3) |
| 9 | **Trial data** (opt-in trial on free AI tier) | Per `trial-consent-notice.md`; **no real/regulated data** | Trial enrolment | Crypto-shred + tombstone at trial end |

**Notes.**
- Periods are **maximums**. Data may be purged earlier on erasure requests (Part 2) or when no longer needed.
- Purge jobs run automatically on a schedule; each run emits an auditable record (count purged, key IDs shredded, tombstone IDs) to the audit log.
- Changing any period here requires updating the RoPA (`ropa.md`) and re-checking the DPIA (`dpia.md`).

## 1.3 Disposal mechanics (crypto-shred + tombstone)
1. Identify the target key domain (per-subject and/or per-entity) for the records due for disposal.
2. **Destroy the key** in the key-management system; without the key the ciphertext is unrecoverable everywhere it exists, **including immutable/WORM backups**.
3. Delete the live ciphertext rows/objects (best-effort; correctness does not depend on it once the key is gone).
4. Write a **tombstone**: an immutable record noting *what class of data*, *which key domain*, *when*, *why* (scheduled purge vs. DSR), and *by which job/actor* — **without** retaining the personal data itself.
5. Emit the disposal event to the audit log.

---

# Part 2 — Data-Subject-Rights (DSR) Procedure

Rights covered: **access, rectification, erasure, objection/restriction.** Because the lawful basis is **legitimate interests** (not consent — employer/employee power imbalance invalidates consent), the **right to object** is available and must be handled substantively (balancing test), and **portability** (which attaches to consent/contract bases) is generally **not** applicable «ASSUMPTION: confirm with counsel».

## 2.1 How a request arrives
- **Primary channel:** email to **[DPO NAME/EMAIL]**.
- **Alternative channels:** any request recognised as a rights request through any channel (e.g. a message to a manager, HR, or in a work group) must be **forwarded to [DPO NAME/EMAIL] within [1 business day]** and logged. A request does not have to use the word "rights" or cite a law to count.
- The Controller does not require a specific form, but may offer one to speed handling.

## 2.2 Identity verification
- Verify the requester is the data subject (or an authorised representative) **using the least data necessary.**
- Because the Bot's core identifier is the **WhatsApp number + display name**, verification is normally by confirming control of that number and matching internal employee records «ASSUMPTION: confirm acceptable method with counsel/HR».
- Do **not** collect national IDs/passports for verification (they are otherwise redacted and never stored); if additional proof is unavoidable, view-and-discard only — do not persist.
- If identity cannot be verified, the Controller may refuse or seek proportionate further information, documenting the reason.

## 2.3 Response SLA
- **Acknowledge within [3 business days]** of receipt.
- **Substantively respond within [30 calendar days]** of a verified request (GDPR-grade default), extendable by up to **[a further 60 days]** for complex/multiple requests with notice and reasons to the subject. «ASSUMPTION: align with UU PDP timelines — confirm the statutory period for [JURISDICTION]; UU PDP may specify a shorter/different window.»
- Requests are handled **free of charge**, save for manifestly unfounded/excessive requests where a reasonable fee or refusal may apply, documented.

## 2.4 Fulfilling each right (technical mechanics)

### Access
- Retrieve, for the subject's key domain, the **raw messages within the 90-day window** and any **summaries within the 12-month window** that reference them.
- Provide a copy of the personal data plus purpose, categories, recipients (the management group; the AI processor), retention, transfer basis, and the source of the data.
- Redact third-party personal data appearing in the same content (see Part 3) so the response does not disclose others' data.

### Rectification
- Correct inaccurate **sender identity** attributes (e.g. display-name mapping) at the data layer.
- Message *content* is a historical record of what was sent; where content is factually wrong, annotate/flag rather than rewrite, and correct any **derived summary** that materially relied on it. Document what was changed.

### Erasure (right to be forgotten) — via crypto-shred
This is the primary reason the architecture uses per-subject keys.
1. Resolve the subject to their **per-subject key domain** (scoped within the relevant **per-entity** domain).
2. **Destroy the subject's key** in the key-management system. All of that subject's encrypted content becomes permanently unrecoverable **everywhere**, including **immutable/WORM backups** that cannot themselves be edited — this is how erasure reaches backups without breaking backup immutability.
3. Delete live ciphertext rows (best-effort) and write a **tombstone** (Part 1.3) evidencing the erasure without keeping the personal data.
4. Where the subject's data is entangled in **multi-party summaries**, either regenerate the summary without the subject's contribution or crypto-shred at the field level so their personal-data fields are unrecoverable while the aggregate operational record survives «ASSUMPTION: confirm field-level granularity is implemented».
5. **Limits:** erasure may be declined/deferred where retention is legally required (e.g. audit/DSR logs, legal-hold); document the exemption and its basis. A **legal hold** suspends both scheduled purge and erasure for the specific data in scope.

### Objection / restriction
- On a valid **objection** (legitimate-interests basis), **stop processing the objector's content** unless the Controller demonstrates compelling legitimate grounds that override the subject's interests; record the balancing outcome.
- Practical implementation: add the subject to an **ingestion suppression / exclusion list** so their future messages are not stored or summarised, and (for restriction) freeze existing data from further use pending resolution.

## 2.5 When third parties or special categories are involved
- If a request touches content containing other people's personal data, disclose only the requester's data and redact others'.
- Special-category data and PAN/national-IDs are never stored, so they are out of scope of access/erasure by design — state this in the response where relevant.

## 2.6 DSR request log
Maintain an auditable log for every request containing: request ID; date received; channel; right(s) invoked; identity-verification method and outcome; entity/key domain affected; actions taken (including **key/tombstone IDs** for erasures); any exemption relied on; date acknowledged; date closed; handler. Retain per row 7 of the schedule. The log records the **fact and handling** of requests — not the personal data content itself.

---

# Part 3 — Third-Party Exclusion & Special-Category Suppression (Operating Notes)

These controls run at/near **ingestion**, before storage, and are what allow the schedule and DSR procedure above to stay narrow.

## 3.1 Third-party (client/vendor) exclusion
- **Data subjects in scope:** employees (primary). Third parties (clients/vendors) may appear in work groups but are **detected and excluded** unless a separate basis/contract exists.
- **Mechanism:** at ingestion, classify senders/participants; content authored by non-employees (or clearly about identifiable third parties) is dropped/redacted before storage. It is not summarised and not sent to the AI processor.
- **If a separate basis exists** (e.g. a client contract/DPA permitting processing), configure an explicit allow-listed exception, referencing that basis; log the exception. Absent that, exclusion is the default.
- **Detection is imperfect:** operate on a **redact/drop-on-doubt** default and review misclassification reports periodically. Escalate systematic gaps to [DPO NAME/EMAIL].

## 3.2 Special-category suppression
- **Special-category data** (faces/health/biometrics) is **suppressed in the media pipeline** and never stored.
- **Phase 2 media** (voice notes, images, documents) passes through suppression + PAN/national-ID redaction **before** any storage or transfer to the AI processor.
- Images/video: biometric/face content is suppressed; documents/images are scanned for PAN and national-ID/passport patterns and **redacted at ingestion**.
- Suppression failures are treated as potential incidents: quarantine, do not store, and log for review.

## 3.3 Egress / transfer safeguards (interaction with retention & DSR)
- Sending content to a cloud **AI processor** is a **cross-border transfer** and requires SCCs/adequacy/DPA; it is mitigated by **egress DLP** and the option to move to **local models**. «ASSUMPTION»
- The **free AI tier** receives **no real/regulated data** — trial only.
- Egress DLP acts as a second line after ingestion redaction: it blocks PAN/national-ID/special-category leakage on the path to the AI processor, reinforcing that such data is never retained anywhere.

---

## Assumptions made (confirm with counsel)
- Retention periods (raw 90d, summaries 12mo, media 90d) are the assumed maximums — **confirm.**
- SLA windows ([3d] acknowledge, [30d]+[60d] respond) are GDPR-grade defaults — **confirm against UU PDP statutory timelines for [JURISDICTION].**
- Portability is treated as not applicable under a legitimate-interests basis — **confirm.**
- Identity verification via WhatsApp-number control + employee-record match is acceptable and proportionate — **confirm.**
- Field-level crypto-shred within multi-party summaries is implemented — **confirm.**
- Audit-log and DSR-log retention values are placeholders — **set with counsel.**
- The "no decisions about individuals" scope limit holds and is kept true — **confirm.**

## Open items for counsel
1. Confirm the controller entity ([CONTROLLER ENTITY]) and DPO/contact ([DPO NAME/EMAIL]).
2. Confirm statutory DSR response deadlines and acknowledgement duties under UU PDP for [JURISDICTION]; reconcile with the GDPR-grade defaults used here.
3. Confirm the correct handling of the right to object under a legitimate-interests basis (balancing test documentation), and whether restriction/portability apply.
4. Confirm identity-verification method(s) that are acceptable without collecting national IDs.
5. Confirm legal-hold and statutory-retention exemptions that override scheduled purge and erasure.
6. Confirm the cross-border transfer mechanism (SCCs/adequacy/DPA) for the AI processor and the roadmap to local models.
7. Confirm whether tombstones + crypto-shred satisfy the regulator's definition of "erasure" in [JURISDICTION] given immutable/WORM backups.
