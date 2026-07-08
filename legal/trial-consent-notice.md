**DRAFT — not legal advice. For review by qualified counsel before use.**

# Opt-In Trial — Consent & Notice

**Document type:** Volunteer consent form + short notice (opt-in trial only)
**Product:** WhatsApp work-summary bot ("the Bot")
**Controller:** [CONTROLLER ENTITY] (Gaiada group / relevant child company — «ASSUMPTION: confirm which entity»)
**Jurisdiction:** [JURISDICTION] — Indonesia (UU PDP No. 27/2022) as primary; drafted to GDPR-grade. «ASSUMPTION»
**Contact:** [DPO NAME/EMAIL]
**Version / date:** [VERSION] — [DATE]

---

> **Scope of this document.** This form governs a **limited opt-in trial** run by volunteers. It is a **consent-based** exercise for the trial only. It is **separate and distinct** from how the Bot will operate in production, which relies on **legitimate interests** (see the Legitimate Interests Assessment and Employee Monitoring Notice), **not** on this consent. Signing this form does not consent to, waive rights in, or otherwise affect the production processing.

---

## 1. What the trial is

The Bot is a WhatsApp assistant that reads messages in designated **work groups** and work-related direct messages, stores them, produces twice-daily project-status summaries (12:00 and 18:00 GMT+8) delivered to a **management group**, and answers work-related questions on request.

The **purpose** of the Bot is **project progress tracking, workflow efficiency, and making it simpler to query work-related information.**

The purpose of **this trial** is narrower: to evaluate the Bot's usefulness, summary quality, and fit before any production rollout. The trial runs in one or more **dedicated trial group(s)** created specifically for this purpose, joined only by consenting volunteers.

The Bot is **not** used to make decisions about individuals. It performs **no** performance management, discipline, or evaluation of persons. «ASSUMPTION: confirm this holds.»

## 2. Who takes part

- Participation is limited to **volunteer employees** who sign this form.
- **No real, regulated, confidential, or client/third-party data** is to be used in the trial (see Section 4).
- **Clients, vendors, and other third parties do not take part** and their communications must not be introduced into the trial group.

## 3. What data is processed during the trial

Only the following is processed, and **only** for the trial evaluation:

- **Work-related content** you post in the trial group(s): message text (and, if the trial reaches media testing, any voice notes, images, or documents you deliberately submit as test material).
- **Sender identity:** your WhatsApp number and display name.
- **Trial-generated outputs:** the summaries and query answers produced by the Bot, and basic operational/audit logs.

Processing follows the same flow as production: **ingest → scrub sensitive identifiers (redact before storage) → encrypt personal-data fields → store → summarize → deliver to the management group → answer queries.** Card numbers (PAN) and national IDs (e.g. Indonesian KTP)/passports are **detected and redacted at ingestion and never stored**; special-category data (faces/health/biometrics) is **suppressed** in the media pipeline. **You must still not post such data** during the trial (see Section 4).

## 4. Important: the trial uses a FREE AI tier — keep trial data non-sensitive

To keep the trial low-cost, the Bot sends content to a **free-tier AI processor** (Claude / Google Gemini). The free tier is **not** covered by a Data Processing Agreement or no-training terms.

**Because of this, you must treat all trial content as if it may be seen or retained by the AI processor.** Do **not** post into the trial group any:

- real client, customer, vendor, or third-party information;
- confidential, proprietary, or commercially sensitive business information;
- personal data of anyone who has not consented (including colleagues who are not in the trial);
- special-category data (health, biometric, religious, political, etc.);
- payment card numbers, national IDs (KTP), passport numbers, or other regulated identifiers;
- credentials, passwords, or security secrets.

Use **synthetic, dummy, or clearly non-sensitive work-style content** for testing. If you are unsure whether something is safe to post, do not post it.

> This restriction is what distinguishes the trial from production. In production, real data is only sent to the AI processor under a **Data Processing Agreement with no-training terms** (or a local model). During the trial, that protection does **not** apply, so real/regulated data is prohibited.

## 5. Cross-border transfer (trial)

Sending content to a cloud AI processor is a **cross-border transfer** of data outside [JURISDICTION]. «ASSUMPTION» For the trial, this risk is managed by the **no-real-data rule** above rather than by transfer safeguards. Production processing will instead rely on appropriate transfer mechanisms (SCCs / adequacy / DPA) and/or a local model.

## 6. Voluntary participation and withdrawal

- Participation is **entirely voluntary.** You may decline to join with **no consequences** for your employment, standing, or treatment.
- You may **withdraw at any time, for any reason**, without giving a reason and without penalty.
- **To withdraw:** leave the trial group, or notify [DPO NAME/EMAIL]. Withdrawal takes effect promptly on receipt.
- Withdrawal stops further processing of your data. On request, trial data attributable to you will be **deleted** (erasure is honored via **crypto-shred** — destroying your encryption key renders the data unrecoverable, even in immutable backups).

## 7. Your rights during the trial

You may **access, rectify, or erase** your trial data, and **object to or restrict** its processing, at any time. To exercise any right, contact **[DPO NAME/EMAIL]**. Because the trial is consent-based, withdrawing consent (Section 6) is itself a complete route to stopping processing and having your data deleted.

## 8. Duration, retention, and end of trial

- **Trial duration:** [TRIAL START DATE] to [TRIAL END DATE] (or until earlier termination). «ASSUMPTION: confirm dates.»
- **Retention during the trial** mirrors the production limits unless a shorter period is set for the trial: raw messages **90 days**, summaries **12 months**, then auto-purge. «ASSUMPTION: confirm — consider deleting all trial data at trial end instead.»
- **At the end of the trial**, trial group(s) will be closed and trial data will be deleted or purged in line with the above.

## 9. Contact

Questions, withdrawal requests, or rights requests: **[DPO NAME/EMAIL]**
Controller: **[CONTROLLER ENTITY]**

---

## 10. Consent affirmation (to be acknowledged by each volunteer)

> By signing below (or by confirming acceptance in the manner indicated), I acknowledge and agree that:
>
> - I have read and understood this Opt-In Trial — Consent & Notice.
> - My participation is **voluntary** and I may **withdraw at any time without penalty**.
> - I understand the trial uses a **free-tier AI processor** and I agree **not to post real, confidential, client/third-party, special-category, or regulated data** into the trial.
> - I understand my work-related messages, WhatsApp number, and display name will be processed **only for the trial** as described above.
> - I understand this consent covers the **trial only** and is **separate** from the Controller's production processing, which relies on **legitimate interests** rather than my consent.
> - I know how to exercise my rights and how to withdraw (via [DPO NAME/EMAIL] or by leaving the trial group).

| Field | Entry |
|---|---|
| Volunteer name | ______________________________ |
| WhatsApp display name / number | ______________________________ |
| Signature / acceptance | ______________________________ |
| Date | ______________________________ |

---

*This is a working draft to accelerate legal review. A qualified lawyer in the applicable jurisdiction(s) must review, localize, and (for Indonesia) translate into Indonesian before use.*
