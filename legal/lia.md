# Legitimate Interests Assessment (LIA)

**DRAFT — not legal advice. For review by qualified counsel before use.**

---

**Document:** Legitimate Interests Assessment (LIA)
**Product:** WhatsApp project-status bot ("the Bot")
**Controller:** [CONTROLLER ENTITY] (the Gaiada group / relevant child company) — "the Controller" «ASSUMPTION: confirm which entity is the Controller»
**Primary jurisdiction:** Indonesia (UU PDP No. 27/2022); drafted to GDPR-grade to cover EU/Singapore (PDPA) exposure. See [JURISDICTION] where specifics are required.
**Lawful basis assessed:** Legitimate interests (Art. 6(1)(f) GDPR equivalent; the corresponding "legitimate interest" ground under UU PDP)
**Data Protection contact:** [DPO NAME/EMAIL]
**Version / date:** [VERSION] / [DATE]

> **Why this LIA exists.** Consent is *not* relied on as the lawful basis, because the primary data subjects are employees and the employer/employee power imbalance means consent cannot be freely given (and is therefore not valid). A Legitimate Interests Assessment is the appropriate mechanism to document and justify the chosen basis. This document records the three-part test — purpose, necessity, and balancing — and the safeguards on which the outcome depends.

---

## 1. Purpose test — the legitimate interest

**The interest, stated as the purpose (verbatim):**

> *project progress tracking, workflow efficiency, and making it simpler to query work-related information.*

**What the Bot does.** The Bot reads messages in company **work groups** and work-related direct messages, stores them, produces twice-daily (12:00 and 18:00 GMT+8) project-status summaries delivered to **the management group**, and answers **work-related content** questions on request.

**Is this a real, lawful, and legitimate business interest?**

- **Real and present, not speculative.** Managing project delivery, reducing the manual overhead of status reporting, and being able to retrieve work information quickly are concrete operational needs of any active business. The interest is the Controller's own operational and management interest in running its projects efficiently.
- **Lawful.** The processing pursues an ordinary commercial/administrative objective. It does not further any unlawful aim, and the Bot is confined to work-related content in work channels (see Section 2). Processing must still comply with UU PDP / GDPR principles (lawfulness, fairness, transparency, purpose limitation, data minimisation, security) — this LIA addresses those.
- **Legitimate (specific and articulable).** The purpose is narrowly framed around project status and work-information retrieval. It is **not** used to make decisions about individuals — there is no performance management, discipline, ranking, or evaluation of persons. «ASSUMPTION: confirm this scope limit holds and is enforced.»
- **Third-party interests.** The management group and wider business benefit from timely, accurate project visibility; there is no material third-party public-interest dimension being claimed.

**Conclusion on the purpose test:** There is a genuine, lawful, and clearly articulated legitimate interest. The purpose test is satisfied.

---

## 2. Necessity test — is the processing necessary for that interest?

The question is not whether the Bot is the *only* conceivable option, but whether the processing is a **reasonable and proportionate** way to achieve the purpose, and whether a **less intrusive** means would achieve the *same* result.

**Why the processing is necessary:**

- **The core function requires reading and summarising work messages.** Producing an accurate project-status summary and answering work-related questions inherently depends on access to the underlying work-related content. There is no way to summarise or query information that is not processed.
- **Sender identity is needed for meaningful status.** Attributing updates to a source (WhatsApp number / display name) is necessary for the summaries to be useful and verifiable; anonymising the sender would materially degrade the purpose (you could not tell who owns a blocker or a deliverable).

**Why less-intrusive alternatives are insufficient:**

- **Manual status reports / stand-ups.** These impose recurring human effort, are inconsistent, lag real activity, and are themselves a data-processing activity (managers still read the same work content). They do not eliminate processing of employees' work communications; they make it slower and less reliable, defeating the "workflow efficiency" and "simpler to query" limbs of the purpose.
- **Summaries without storage.** Twice-daily summarisation and on-request Q&A over recent project activity require retaining messages for a limited window; ephemeral, no-storage processing cannot answer later queries or produce scheduled summaries.
- **Aggregate/anonymous processing only.** As above, useful project status needs source attribution, so full anonymisation is not a viable substitute for the stated purpose.

**How the scope limit keeps processing minimal (data minimisation):**

- **Channel limit.** The Bot operates **only** in **work groups** and work-related DMs, not personal or social channels.
- **Content limit.** It processes **only work-related content**.
- **Subject limit.** Third parties (clients/vendors) who may appear in project groups are **detected and excluded** unless a separate lawful basis or contract exists.
- **Sensitive-data limits at ingestion.** Card numbers (PAN) and national IDs (e.g. Indonesian KTP)/passports are **detected and redacted at ingestion and never stored**. Special-category data (faces/health/biometrics) is **suppressed** in the media pipeline (Phase 2 voice notes, images, documents).
- **Retention limit.** Raw messages are retained **90 days**, summaries **12 months**, then auto-purged. «ASSUMPTION: confirm retention periods.»

**Conclusion on the necessity test:** The processing is necessary and proportionate to the stated interest, the identified alternatives do not achieve the same result with less intrusion, and the scope limit confines the processing to what is required. The necessity test is satisfied.

---

## 3. Balancing test — interests of the Controller vs. rights of data subjects

Here the Controller's legitimate interest is weighed against the interests, rights, and freedoms of the data subjects — primarily **employees**, with incidental third parties handled by exclusion.

### 3.1 Nature of the data and potential impact

- **Data categories:** work chat text; sender identity (WhatsApp number, display name); later (Phase 2) voice notes, images, documents. PAN and national IDs are redacted at ingestion; special-category data is suppressed.
- **Potential negative impact on employees if unmitigated:** a sense of monitoring/surveillance in work channels; concern that communications are stored and analysed; risk of function creep (e.g., drift toward evaluating individuals); confidentiality risk if work content leaks; risk from sending content to an external AI processor across borders.

### 3.2 Reasonable expectations

- Employees can reasonably expect that **work communications in work channels** are visible to, and used by, the employer for **work management** purposes. Processing occurs only in work groups / work-related DMs and only on work-related content, which aligns with those expectations.
- Expectations are reinforced by **transparency** (privacy notice / staff notice describing the Bot, its purpose, retention, and rights) and the availability of an **objection/opt-out** route.
- Processing that fell **outside** these expectations — monitoring personal chats, or using the data to make decisions about individuals — is **out of scope and prohibited**, which keeps the processing within what employees would reasonably anticipate.

### 3.3 Safeguards that tip the balance in favour of the Controller

- **Scope limit** — work channels only, work-related content only (Section 2).
- **No decisions about individuals** — no performance management, discipline, ranking, or evaluation of persons; the tool is for project status, not people assessment. This removes the most serious category of impact on individuals. «ASSUMPTION: confirm and enforce.»
- **Encryption and crypto-shred** — per-subject and per-entity **crypto-shred** encryption of personal-data fields; erasure is achieved by destroying the key, which works even against immutable backups. Row-level tenant isolation and zero-trust access control limit who and what can reach the data.
- **Redaction at ingestion** — PAN, national IDs/passports redacted before storage and never stored; special-category data suppressed in the media pipeline.
- **Retention limits** — raw messages 90 days, summaries 12 months, then auto-purge (Section 2). «ASSUMPTION: confirm.»
- **Audit logging** — access and processing are logged, deterring and detecting misuse.
- **Third-party exclusion** — clients/vendors detected and excluded absent a separate basis/contract.
- **Notice and opt-out / objection** — data subjects are informed and can object/opt out (Section 4 of the pack's rights handling; contact [DPO NAME/EMAIL]).
- **Processor controls** — for real data, the **AI processor** (Claude / Google Gemini) is engaged under a **Data Processing Agreement with no-training terms**, or a **local model** is used. The **free AI tier** is used **only** for the opt-in trial with **no real/regulated data**.
- **International transfer controls** — sending content to a cloud **AI processor** is a cross-border transfer requiring **SCCs / adequacy / DPA**, mitigated by egress DLP and the option to move to **local models**. «ASSUMPTION: confirm transfer mechanism per [JURISDICTION].»

### 3.4 Weighing

Against the employees' interests sits a genuine and proportionate management interest, exercised within employees' reasonable expectations for work channels. The most impactful risks — surveillance-style evaluation of individuals, exposure of highly sensitive identifiers, indefinite retention, uncontrolled external/cross-border disclosure — are specifically neutralised by the scope limit, the "no decisions about individuals" rule, ingestion redaction and special-category suppression, retention limits, crypto-shred erasure, tenant isolation, audit logging, transparency, opt-out, and processor/transfer controls. On balance, with these safeguards operating, the Controller's interest is **not overridden** by the interests or fundamental rights and freedoms of the data subjects.

**Note on the power imbalance:** because employees cannot freely consent, the burden shifts to the safeguards above to keep the processing fair. The balance holds *only while those safeguards are actually implemented and maintained*; if any material safeguard fails, this assessment must be revisited (Section 6).

---

## 4. Outcome

**Legitimate interests IS an appropriate lawful basis for this processing, subject to the safeguards in Section 5.**

- The **purpose test** is satisfied — a real, lawful, clearly articulated interest.
- The **necessity test** is satisfied — the processing is necessary and proportionate; less-intrusive alternatives do not achieve the same result; the scope limit keeps it minimal.
- The **balancing test** is satisfied **conditionally** — the Controller's interest is not overridden **provided** the safeguards remain in force. This is a conditional pass, not an unconditional one.

Consent is **not** relied upon (invalid under the employer/employee power imbalance). This LIA should be recorded in the Controller's Article 30-equivalent records of processing and reviewed on the triggers in Section 6.

---

## 5. Safeguards summary

| # | Safeguard | Effect |
|---|-----------|--------|
| 1 | Scope limit (work groups / work-related DMs; work-related content only) | Data minimisation; keeps processing within reasonable expectations |
| 2 | No decisions about individuals | Removes performance/discipline/evaluation impact |
| 3 | Ingestion redaction of PAN and national IDs/passports (never stored) | Prevents storage of high-risk identifiers |
| 4 | Special-category suppression in media pipeline (faces/health/biometrics) | Avoids processing special-category data |
| 5 | Third-party (client/vendor) detection and exclusion | Confines processing to lawful subjects |
| 6 | Per-subject + per-entity **crypto-shred** encryption | Confidentiality; erasure even against immutable backups |
| 7 | Row-level tenant isolation; zero-trust access | Limits access; contains breach blast radius |
| 8 | Audit logging | Detects/deters misuse; accountability |
| 9 | Retention limits (raw 90 days; summaries 12 months; auto-purge) | Storage limitation «ASSUMPTION: confirm» |
| 10 | Transparency notice + objection/opt-out | Fairness; supports reasonable expectations and rights |
| 11 | AI processor under DPA with no-training terms, or local model | Controls processor use; no model training on data |
| 12 | Free AI tier only for opt-in trial with no real/regulated data | Segregates unregulated processing |
| 13 | International-transfer controls (SCCs/adequacy/DPA; egress DLP; local-model option) | Lawful cross-border transfer «ASSUMPTION: confirm mechanism» |
| 14 | Data-subject rights honoured (access, rectification, erasure via crypto-shred, objection/restriction) | Enforceable rights; contact [DPO NAME/EMAIL] |

---

## 6. Review triggers

This LIA must be re-run (and the outcome reconsidered) if any of the following occurs:

- **Scheduled review:** at least every 12 months, or per the Controller's policy cycle.
- **Change of purpose:** any use of the Bot beyond project progress tracking, workflow efficiency, and querying work-related information — in particular any move toward **decisions about individuals** (performance, discipline, evaluation), which would likely require a fresh basis and a DPIA.
- **Change of scope:** operating outside work groups / work-related DMs, or processing non-work content.
- **New data categories / Phase 2 rollout:** enabling voice notes, images, or documents; any change that risks capturing special-category data if suppression fails.
- **Change of processor or transfer path:** new AI processor, change to training terms, loss of DPA/SCC coverage, or new international-transfer destination.
- **Safeguard failure or degradation:** failure of ingestion redaction, special-category suppression, crypto-shred/erasure, tenant isolation, or audit logging.
- **Retention change:** any change to the 90-day / 12-month retention model.
- **Regulatory or legal change:** amendments or implementing regulations under UU PDP, GDPR, PDPA, or relevant guidance in [JURISDICTION]; a relevant regulator decision.
- **Complaint, objection pattern, or incident:** a personal-data breach, a pattern of objections/opt-outs, or a data-subject complaint indicating the balance no longer holds.

---

*End of document. This LIA is a draft prepared for review by qualified counsel and the [DPO NAME/EMAIL]; bracketed placeholders and «ASSUMPTION» markers must be resolved before reliance.*
