**DRAFT — not legal advice. For review by qualified counsel before use.**

# Employee Monitoring Notice

**Document:** Employee Monitoring Notice (WhatsApp work-group summarization bot)
**Controller:** [CONTROLLER ENTITY] (the Gaiada group / relevant child company) («ASSUMPTION: confirm which entity is the controller»)
**Primary jurisdiction:** Indonesia — Undang-Undang Perlindungan Data Pribadi (UU PDP) No. 27/2022. Drafted to GDPR-grade so EU/Singapore (PDPA) exposure is covered. («ASSUMPTION»)
**Version / date:** [VERSION] — [DATE]
**Contact:** [DPO NAME/EMAIL]

> **Localization required.** This notice must be provided to employees in **Bahasa Indonesia** (and any other working language of affected staff) before it is relied upon. The Indonesian translation is the operative version for Indonesian employees; keep both versions consistent. Do not deploy Part A or Part B until counsel has approved the translation.

**Defined terms** (used consistently throughout): **the Bot**, **the Controller**, **work groups**, **work-related content**, **the management group**, **the AI processor**, **crypto-shred**.

---

## PART A — Short In-Group Notice

*(Plain-language version. Suitable to pin in each WhatsApp work group and to show during onboarding. Translate to Bahasa Indonesia before use.)*

> **📌 This work group is summarized by an automated assistant ("the Bot").**
>
> To help track project progress and make work information easier to find, the Bot reads **work-related content** in this group and produces short status summaries twice a day (12:00 and 18:00, GMT+8) for the **management group**. It can also answer work-related questions when asked.
>
> **What it collects:** work chat messages and the sender's WhatsApp number and display name. Sensitive identifiers such as **card numbers and national IDs/passports (e.g. KTP) are automatically removed before anything is stored**, and are never kept.
>
> **What it is NOT:** the Bot is **not** used to evaluate, manage, discipline, or make decisions about you as an individual. It is a project tool, not a performance-monitoring tool.
>
> **How long:** raw messages are kept for **90 days**; summaries for **12 months**; then deleted automatically.
>
> **Your choices:** you can ask to see, correct, or delete your data, or object to this processing. Please keep personal, non-work chats out of this group.
>
> **Questions or objections:** contact [DPO NAME/EMAIL]. A fuller monitoring policy is available at [POLICY LOCATION].

---

## PART B — Employee Monitoring Policy (Full)

*(Translate to Bahasa Indonesia before use. This is the detailed policy referenced in Part A.)*

### 1. Purpose of this notice

This notice explains how [CONTROLLER ENTITY] (**the Controller**) uses an automated WhatsApp assistant (**the Bot**) that reads and summarizes messages in company **work groups** and **work-related content**. It describes what personal data is processed, why, on what legal basis, who receives it, how long it is kept, and the rights available to affected individuals. It is issued to comply with the transparency obligations under UU PDP No. 27/2022 and, to the extent applicable, the EU GDPR and other data-protection laws in [JURISDICTION].

### 2. What the Bot does

The Bot:

1. reads messages in designated **work groups** and **work-related** direct messages;
2. removes sensitive identifiers, encrypts remaining personal-data fields, and stores the content;
3. produces **twice-daily** project-status summaries (at **12:00 and 18:00, GMT+8**) delivered to **the management group**; and
4. answers **work-related** questions on request.

**Processing flow:** ingest → scrub sensitive identifiers (redact before storage) → encrypt personal-data fields → store → summarize → deliver to the management group → answer queries.

### 3. Purpose and scope limit (proportionality)

**Purpose.** The Bot is used solely for **project progress tracking, workflow efficiency, and making it simpler to query work-related information**.

**Scope limit.** The Bot operates **only** in **work groups** and **work-related** direct messages, and **only** on **work-related content**. It is **not** used to make decisions about individuals — there is **no performance management, disciplinary use, or evaluation of persons** based on the Bot's processing. («ASSUMPTION: confirm this scope limit holds in practice and is enforced technically and by policy.»)

Employees are asked not to share personal, private, or non-work content in **work groups**, and to keep sensitive or special-category information out of monitored channels.

### 4. Who is affected (data subjects)

- **Employees** are the primary data subjects.
- **Third parties** (clients, vendors) whose messages may appear in project groups are **detected and excluded** from processing unless a separate lawful basis or contractual arrangement exists for them.

### 5. Categories of personal data

- **Work chat text** (message content classified as **work-related content**).
- **Sender identity**: WhatsApp number and display name.
- **Phase 2 (future)**: voice notes, images, and documents shared in **work groups**.

**Redacted at ingestion and never stored:** payment card numbers (PAN) and national identity numbers / passports (e.g. Indonesian KTP) are **detected and redacted at ingestion** before storage.

**Suppressed:** special-category data (including faces, health information, and biometrics) is **suppressed in the media pipeline** and not processed.

### 6. Legal basis

The Controller relies on **legitimate interests** — namely the legitimate interest in project coordination, operational oversight, and workflow efficiency — as the lawful basis for this processing.

The Controller does **not** rely on employee consent, because the employer/employee relationship involves a power imbalance that makes freely-given consent unreliable as a basis. A legitimate-interests assessment (LIA) balancing the Controller's interests against employees' rights and freedoms should be completed and retained. («ASSUMPTION: an LIA will be prepared and reviewed by counsel. Note that UU PDP's precise equivalent to GDPR Art. 6(1)(f) "legitimate interests" should be confirmed and mapped to the appropriate UU PDP lawful basis.»)

### 7. Recipients and processors

- **The management group** (internal): receives the twice-daily summaries and query responses.
- **The AI processor** (Claude / Google Gemini): processes content to generate summaries and answers.
  - For **real / regulated data**, the AI processor is engaged under a **Data Processing Agreement (DPA) with no-training terms**, or a **local model** is used.
  - The **free AI tier** is used **only** for the opt-in trial and with **no real or regulated data**.

Access within the Controller is restricted to authorized personnel on a need-to-know basis (see Section 10).

### 8. International transfers

Sending **work-related content** to a cloud-based **AI processor** constitutes a **cross-border transfer** of personal data. Such transfers require an appropriate safeguard — Standard Contractual Clauses (SCCs), an adequacy determination, or an equivalent DPA-based mechanism recognized under [JURISDICTION].

Transfer risk is mitigated by **egress data-loss-prevention (DLP)** controls and by the option to move processing to a **local model** so that regulated data need not leave the relevant jurisdiction. («ASSUMPTION: confirm the specific transfer mechanism(s) and the UU PDP cross-border transfer requirements applicable to the chosen AI processor.»)

### 9. Retention

- **Raw messages:** retained for **90 days**.
- **Summaries:** retained for **12 months**.
- After these periods, data is **auto-purged**. («ASSUMPTION: confirm retention periods with counsel and business owners.»)

### 10. Security safeguards

- **Per-subject and per-entity crypto-shred encryption**: personal-data fields are encrypted, and erasure is achieved by destroying the relevant key (**crypto-shred**) — this renders data unrecoverable even where immutable backups exist.
- **Row-level tenant isolation** between entities.
- **Zero-trust access** controls.
- **Audit logging** of access and processing.
- **Ingestion redaction** of PAN and national-ID/passport identifiers.
- **Retention limits** with automatic purge (Section 9).

### 11. Your rights

Subject to applicable law, affected individuals may exercise the following rights:

- **Access** — obtain confirmation and a copy of personal data processed.
- **Rectification** — correct inaccurate or incomplete data.
- **Erasure** — request deletion; honored via **crypto-shred** (destruction of the relevant encryption key).
- **Objection / restriction** — object to, or request restriction of, processing based on legitimate interests.

Because the lawful basis is **legitimate interests**, individuals have a particular right to **object** to processing on grounds relating to their situation; the Controller will then reassess the balancing test.

To exercise any right, contact **[DPO NAME/EMAIL]**. Requests will be handled within the timeframe required by [JURISDICTION] law.

### 12. Opt-out and questions

Employees who wish to object to or opt out of this processing, or who have questions about it, should contact **[DPO NAME/EMAIL]**. Where an objection cannot be accommodated (for example, because processing is necessary and the Controller's overriding legitimate grounds prevail), the Controller will explain the reasons.

### 13. Contact

**Data Protection Officer / responsible contact:** [DPO NAME/EMAIL]
**Controller:** [CONTROLLER ENTITY]

---

*End of draft. Provide the Bahasa Indonesia translation alongside this document before deployment. Populate all bracketed placeholders and resolve all «ASSUMPTION» notes with qualified counsel.*
