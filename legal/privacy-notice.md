# Privacy Notice (Data Subjects)

**DRAFT — not legal advice. For review by qualified counsel before use.**

_Last updated: [DATE] · Version: [VERSION]_

---

## 1. About this notice

This Privacy Notice explains how **the Controller** processes personal data through **the Bot**, a WhatsApp assistant that operates in company work groups and work-related direct messages. It is addressed to the people whose personal data may be processed (**data subjects**) — primarily employees, and in limited cases third parties such as clients or vendors who appear in **work groups**.

Please read this notice so you understand what data is processed, why, on what legal basis, who receives it, and what rights you have.

**Defined terms** used throughout: _"the Bot"_, _"the Controller"_, _"work groups"_, _"work-related content"_, _"the management group"_, _"the AI processor"_, and _"crypto-shred"_ (defined where they first appear or in Section 12).

---

## 2. Who is the Controller (who is responsible for your data)

The data controller is **[CONTROLLER ENTITY]**, part of the Gaiada group of companies.

- Controller: **[CONTROLLER ENTITY]** («ASSUMPTION: confirm which Gaiada group entity is the responsible controller»)
- Registered address: [CONTROLLER ADDRESS]
- Contact for privacy matters / Data Protection Officer: **[DPO NAME/EMAIL]**

If you are unsure which entity is responsible for a specific work group, contact the DPO using the details above.

---

## 3. What the Bot does

**The Bot** reads messages in company **work groups** and work-related direct messages, stores them, and:

- produces **twice-daily project-status summaries** (at 12:00 and 18:00, GMT+8) delivered to **the management group**; and
- answers **work-related** questions on request.

**Purpose (stated):** _project progress tracking, workflow efficiency, and making it simpler to query work-related information._

**Scope limit.** The Bot operates **only** in **work groups** and work-related DMs, and **only** on **work-related content**. It is **not** used to make decisions about individuals — there is no performance management, disciplinary use, or evaluation of persons through the Bot. «ASSUMPTION: confirm this scope limit holds in practice.»

---

## 4. What personal data is processed and how it is collected

Data is collected automatically as messages are sent in **work groups** and work-related DMs. Categories processed include:

- **Work chat text** — the content of work-related messages.
- **Sender identity** — WhatsApp number and display name.
- **Media (Phase 2, planned):** voice notes, images, and documents shared in **work groups**. «ASSUMPTION: Phase 2 not yet live; confirm timing before this section takes effect.»

**Data that is deliberately NOT stored.** To limit exposure, the following are handled by protective controls at the point of collection:

- **Payment card numbers (PAN)** and **national identifiers** (for example, Indonesian KTP numbers and passport numbers) are **detected and redacted at ingestion** and are **never stored**.
- **Special-category / sensitive data** (for example, faces, health information, or biometrics) is **suppressed in the media pipeline** and is not retained.

**Third parties.** Where clients, vendors, or other third parties appear in **work groups**, the Bot is designed to **detect and exclude** their content unless a separate lawful basis or contract exists to cover it.

---

## 5. How your data is processed (processing flow)

Personal data moves through the following stages:

1. **Ingest** — the message is received from the **work group** or work-related DM.
2. **Scrub sensitive identifiers** — PAN, national IDs, and special-category data are redacted or suppressed **before storage**.
3. **Encrypt** — personal-data fields are encrypted.
4. **Store** — the encrypted, scrubbed record is stored.
5. **Summarize** — the Bot generates project-status summaries.
6. **Deliver** — summaries are delivered to **the management group**.
7. **Answer queries** — the Bot responds to **work-related** questions on request.

---

## 6. Legal basis for processing

The Controller relies on **legitimate interests** as the lawful basis (under [JURISDICTION] law and, to the extent applicable, Article 6(1)(f) GDPR-grade standards). The legitimate interests are project progress tracking, workflow efficiency, and simpler querying of work-related information.

**Consent is deliberately NOT relied upon** for employees, because the employer/employee power imbalance means consent would not be freely given and therefore would not be valid.

You have the right to **object** to processing based on legitimate interests — see Section 9.

«ASSUMPTION: a Legitimate Interests Assessment (LIA) / balancing test is completed and retained by the Controller.»

---

## 7. Who receives your data (recipients)

- **The management group** — an internal group that receives the twice-daily summaries.
- **The AI processor** — an external AI service (Claude / Google Gemini) used to generate summaries and answer queries.

**Safeguards on the AI processor:**

- For **real or regulated data**, the AI processor is engaged under a **Data Processing Agreement (DPA)** that includes **no-training terms** (your data is not used to train the provider's models), **or** a **local model** is used instead.
- The **free AI tier** is used **only** for the opt-in trial and **only with no real or regulated data**.

The Controller does not sell personal data.

---

## 8. International transfers and safeguards

Sending **work-related content** to a cloud **AI processor** may involve a **cross-border transfer** of personal data outside [JURISDICTION].

Where this occurs, the transfer is protected by appropriate safeguards, which may include **Standard Contractual Clauses (SCCs)**, an **adequacy** determination, and/or the **DPA** described above. Transfers are further mitigated by **egress data-loss-prevention (DLP)** controls and by the **option to move to local models** that keep processing in-region.

«ASSUMPTION: confirm the specific transfer mechanism, the AI processor's hosting region(s), and that SCCs/adequacy/DPA are in place before real data is sent.»

---

## 9. How long data is kept (retention)

- **Raw messages:** retained for **90 days**, then auto-purged.
- **Summaries:** retained for **12 months**, then auto-purged.

After these periods, data is automatically purged. «ASSUMPTION: confirm retention periods and purge mechanics with counsel and operations.»

---

## 10. How your data is protected (security safeguards)

The Controller applies the following safeguards:

- **Per-subject and per-entity encryption using crypto-shred** — each data subject and each entity has its own encryption key.
- **Row-level tenant isolation** — records are segregated so one tenant's data cannot be read from another's context.
- **Zero-trust access controls** — access is not granted by default and is verified per request.
- **Audit logging** — access and processing events are logged.
- **Ingestion redaction** — PAN and national IDs are redacted at ingestion (see Section 4).
- **Retention limits** — see Section 9.

**crypto-shred (defined):** an approach in which erasing a data subject's personal data is achieved by **destroying the encryption key** for that subject. Because the underlying encrypted data becomes permanently unreadable once the key is destroyed, erasure works **even where immutable backups exist** (the encrypted copies in backups can no longer be decrypted).

---

## 11. Your rights as a data subject

Subject to the conditions and exceptions in [JURISDICTION] law (and, where applicable, GDPR-grade standards), you have the right to:

- **Access** — obtain confirmation of, and a copy of, the personal data processed about you.
- **Rectification** — have inaccurate or incomplete data corrected.
- **Erasure** — have your personal data deleted; this is **honored via crypto-shred** (destroying your encryption key renders your data permanently unreadable, including in immutable backups).
- **Objection** — object to processing based on legitimate interests (see Section 6).
- **Restriction** — request that processing be limited in certain circumstances.
- **Complaint to a supervisory authority** — lodge a complaint with the relevant data protection authority in [JURISDICTION] (for Indonesia, the authority designated under UU PDP No. 27/2022; for EU/SG exposure, the relevant EU supervisory authority or the PDPC of Singapore, as applicable).

**How to exercise your rights.** Contact **[DPO NAME/EMAIL]**. The Controller will respond within the timeframe required by applicable law. We may need to verify your identity before acting on a request.

---

## 12. Definitions

- **the Bot** — the WhatsApp assistant described in Section 3.
- **the Controller** — **[CONTROLLER ENTITY]**, the entity responsible for the processing (Section 2).
- **work groups** — company work-related WhatsApp groups in which the Bot operates.
- **work-related content** — work-related messages and material; the only content the Bot processes.
- **the management group** — the internal group that receives the twice-daily summaries.
- **the AI processor** — the external AI service (Claude / Google Gemini) or a local model used for summarization and query answering.
- **crypto-shred** — key-destruction erasure, as defined in Section 10.

---

## 13. Changes to this notice

The Controller may update this notice from time to time. Material changes will be communicated through the usual internal channels, and the "Last updated" date at the top will be revised. Please review this notice periodically.

**Questions or requests:** **[DPO NAME/EMAIL]**.
