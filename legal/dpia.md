# Data Protection Impact Assessment (DPIA)

**DRAFT — not legal advice. For review by qualified counsel before use.**

| Field | Value |
|---|---|
| Processing activity | WhatsApp work-summary bot ("the Bot") |
| Controller | [CONTROLLER ENTITY] — the Gaiada group / relevant child company «ASSUMPTION: confirm which legal entity» ("the Controller") |
| Primary jurisdiction | Indonesia (UU PDP No. 27/2022); drafted to GDPR-grade for EU/SG exposure. See [JURISDICTION] «ASSUMPTION» |
| Lawful basis | Legitimate interests (see the Legitimate Interests Assessment, `lia.md`) — **not** consent |
| DPO / contact | [DPO NAME/EMAIL] |
| Status | DRAFT — pending counsel review and risk sign-off |
| Version / date | v0.1 — [DATE] |

> This DPIA should be read together with the Legitimate Interests Assessment (`lia.md`), the Records of Processing (`ropa.md`), and the retention/DSR procedure (`retention-and-dsr-procedure.md`). It must be re-run when processing materially changes (see Section 8).

---

## 1. Description of the processing

### 1.1 Nature of the processing

The Bot is an automated assistant that operates inside WhatsApp. It:

1. **Ingests** messages from company **work groups** and **work-related** direct messages;
2. **Scrubs** sensitive identifiers at ingestion (redaction before storage — see 1.4);
3. **Encrypts** personal-data fields and **stores** them;
4. **Summarizes** activity into twice-daily (12:00 and 18:00 GMT+8) project-status summaries delivered to a designated **management group**; and
5. **Answers** work-related questions on request.

### 1.2 Scope of the processing

- **Content in scope:** work-related content only — project updates, task status, coordination, and work-related queries.
- **Channels in scope:** work groups and work-related DMs only.
- **Content/channels out of scope:** personal, private, or non-work chats; social groups.
- **Volume:** ongoing/continuous ingestion across participating work groups. «ASSUMPTION: confirm number of groups, participants, and message volume.»
- **Automation:** the Bot summarizes and answers queries. It performs **no decisions, profiling, evaluation, ranking, or scoring of individuals** (no performance management, discipline, or HR use). This scope limit is central to the necessity/proportionality case and to the residual-risk rating — see Sections 3 and 7. «ASSUMPTION: confirm this holds and keep it true.»

### 1.3 Context of the processing

- **Relationship:** employer/employee. Because of the employer–employee power imbalance, **consent is not relied upon**; the lawful basis is **legitimate interests** (`lia.md`).
- **Reasonable expectations:** employees are told through the employee-monitoring notice and privacy notice (`employee-monitoring-notice.md`, `privacy-notice.md`) that work channels are processed by the Bot for the stated purpose.
- **Data subjects with lower expectations:** third parties (clients/vendors) who may appear in work groups — handled by detection and exclusion (see Section 2 and Risk R2).
- **Novelty / sensitivity:** automated ingestion of workplace chat is monitoring-adjacent and can create a chilling effect if poorly scoped; the design deliberately narrows scope to mitigate this.

### 1.4 Purposes of the processing

Verbatim stated purpose: **project progress tracking, workflow efficiency, and making it simpler to query work-related information.**

No secondary or incompatible purposes are permitted without a fresh assessment. In particular, the data is **not** repurposed for monitoring individual productivity, evaluating persons, or any disciplinary/HR decision.

### 1.5 Data flow

```
WhatsApp work groups / work-related DMs
        │  (ingest)
        ▼
[1] INGESTION SCRUBBER  ── redact PAN + national IDs (KTP/passport) BEFORE storage
        │                 ── detect & EXCLUDE third-party (client/vendor) data
        │                 ── SUPPRESS special-category media (faces/health/biometrics)
        ▼
[2] ENCRYPTION  ── per-subject + per-entity crypto-shred keys; row-level tenant isolation
        ▼
[3] STORAGE  ── encrypted personal-data fields; audit logging; retention limits
        │
        ├──► [4] SUMMARIZE ──► the management group (internal recipient)  [12:00 & 18:00 GMT+8]
        │            │
        └──► [5] ANSWER QUERIES on request
                     │
                     ▼
             THE AI PROCESSOR (Claude / Google Gemini)
             ── cross-border transfer; under DPA + no-training terms (or local model)
             ── free AI tier: opt-in TRIAL only, NO real/regulated data
             ── egress DLP on the outbound path
```

Key data-flow controls, in order: (a) redact before storage; (b) encrypt before storage; (c) egress DLP before any transfer to the AI processor; (d) auto-purge at retention limits.

---

## 2. Data categories and data subjects

### 2.1 Data subjects

| Data subject | Role | Treatment |
|---|---|---|
| **Employees / staff** | Primary data subjects; participants in work groups and work-related DMs | Processed under legitimate interests, within the stated purpose and scope limit |
| **Third parties (clients/vendors)** | May appear in work groups | **Detected and excluded** — not processed unless a separate lawful basis/contract exists «ASSUMPTION: confirm contractual position; see R2» |

### 2.2 Data categories

| Category | Examples | Handling |
|---|---|---|
| Work chat text | Messages, project updates, coordination, queries | Encrypted at rest; retained per schedule |
| Sender identity | WhatsApp number, display name | Encrypted personal-data field; row-level tenant isolation |
| Media (Phase 2) | Voice notes, images, documents | Media pipeline with special-category **suppression**; not in scope until Phase 2 |
| **Payment card numbers (PAN)** | Card numbers | **Detected and redacted at ingestion — never stored** |
| **National IDs** | Indonesian KTP, passport numbers | **Detected and redacted at ingestion — never stored** |
| **Special-category data** | Faces, health, biometrics | **Suppressed** in the media pipeline; not intentionally processed |

Special-category data and government identifiers are **not** a deliberate part of the processing. The design goal is to keep them out of storage entirely (redaction/suppression at ingestion). Residual leakage risk is addressed in Section 5 (R3).

---

## 3. Necessity and proportionality

### 3.1 Necessity

The stated purpose — project progress tracking, workflow efficiency, and easier querying of work-related information — genuinely requires reading and summarizing work-channel content. There is no materially less-intrusive way to auto-generate accurate status summaries and answer work queries than to process the underlying work messages. Consent is unavailable as a basis (power imbalance), and no contractual/legal-obligation basis fits; **legitimate interests** is the appropriate basis, assessed in the LIA (`lia.md`).

### 3.2 Proportionality (data minimisation and scope limit)

The processing is bounded so that intrusion stays proportionate to the purpose:

- **Channel scope:** work groups and work-related DMs only — **not** personal chats.
- **Content scope:** work-related content only.
- **No decisions about individuals:** the Bot does not evaluate, score, profile, or discipline persons; summaries serve operational oversight, not HR/performance use.
- **Minimisation at ingestion:** PAN and national IDs are redacted and never stored; special-category media is suppressed; third-party data is excluded.
- **Recipient limitation:** summaries go only to the management group; transfers to the AI processor are governed by a DPA with no-training terms (or a local model).
- **Storage limitation:** raw messages 90 days, summaries 12 months, then auto-purge «ASSUMPTION: confirm».
- **Security proportionate to risk:** per-subject + per-entity crypto-shred encryption, row-level tenant isolation, zero-trust access, audit logging, egress DLP.

These measures tie directly to the balancing test in the LIA: the scope limit and minimisation controls are what bring the Controller's legitimate interests into balance with data-subject rights and expectations.

---

## 4. Consultation

«ASSUMPTION: confirm the consultation steps below are completed and record outcomes before go-live.»

- **Data subjects (employees):** views to be sought via the employee-monitoring notice and a feedback/objection channel. Employees can object/raise concerns to [DPO NAME/EMAIL]. «ASSUMPTION: confirm method and that objections are logged and handled.»
- **Employee representatives / works council / union:** consult if any exists or is required in [JURISDICTION]. «ASSUMPTION: confirm whether a works-council/union or Indonesian labor-consultation requirement applies.»
- **DPO / privacy function:** [DPO NAME/EMAIL] to review this DPIA and advise. «ASSUMPTION: confirm DPO is appointed and whether appointment is mandatory in [JURISDICTION].»
- **Processors:** the AI processor's terms (DPA, no-training, transfer mechanism) to be reviewed as part of vendor due diligence.
- **Supervisory authority:** consult the relevant authority only if residual risk remains **high** after mitigation (see Section 7). Under GDPR-grade practice, prior consultation is required where high residual risk cannot be mitigated. «ASSUMPTION: confirm whether prior consultation / DPIA filing is required under UU PDP No. 27/2022 and [JURISDICTION].»

---

## 5. Risk assessment

Scoring: Likelihood and Severity each rated **Low / Medium / High**. "Residual" reflects risk **after** the mitigations in Section 6 are applied. Ratings are a drafting starting point for counsel/risk sign-off, not a final determination.

| # | Risk | Likelihood (inherent) | Severity (inherent) | Key mitigations | Residual |
|---|---|---|---|---|---|
| **R1** | **Employee monitoring / chilling effect** — staff feel surveilled; self-censorship; disproportionate intrusion | Medium | High | Scope limit (work channels/content only); **no decisions about individuals**; transparent notice; objection channel; legitimate-interests balancing (LIA) | Low–Medium |
| **R2** | **Third-party (client/vendor) data** processed without a basis | Medium | Medium | Detection and **exclusion** of third-party data at ingestion; confirm contractual position before any inclusion | Low |
| **R3** | **Special-category leakage** — faces/health/biometrics enter the pipeline | Medium | High | Media-pipeline **suppression** of special-category data; ingestion redaction; Phase-2 media gated on controls | Low–Medium |
| **R4** | **Cross-border transfer to AI processor** — content leaves [JURISDICTION]; foreign-government/access exposure; training on data | Medium | High | DPA + **no-training** terms; SCCs/adequacy/transfer mechanism; **egress DLP**; free tier only for no-real-data trial; **option to move to local models** | Medium |
| **R5** | **Re-identification** — redacted/aggregated data links back to individuals | Low–Medium | Medium | Redaction of direct identifiers at ingestion; encryption of identity fields; summaries avoid unnecessary personal detail; access controls | Low |
| **R6** | **Over-retention** — data kept longer than needed | Medium | Medium | Retention limits (raw 90 days / summaries 12 months) with **auto-purge**; documented schedule «ASSUMPTION» | Low |
| **R7** | **Security breach / unauthorized access** — exfiltration or cross-tenant access | Medium | High | Per-subject + per-entity encryption; **row-level tenant isolation**; **zero-trust** access; audit logging; egress DLP | Low–Medium |
| **R8** | **Un-erasable backups** — erasure requests can't be honored against immutable/WORM backups | Medium | High | **Crypto-shred**: erasure = destroy the key, rendering data unrecoverable even in immutable backups; per-subject key domains | Low |

---

## 6. Mitigations mapped to technical safeguards

| Safeguard (from the build) | Risks addressed | Effect |
|---|---|---|
| **Ingestion redaction** of PAN and national IDs (KTP/passport) — never stored | R3, R5 | Removes highest-harm identifiers before storage exists |
| **Special-category suppression** in the media pipeline | R3 | Keeps faces/health/biometrics out of the store |
| **Third-party detection & exclusion** | R2 | Prevents processing data with no lawful basis |
| **Per-subject + per-entity crypto-shred encryption** | R7, R8, R5 | Confidentiality; erasure despite immutable backups; clean per-entity severability |
| **Row-level tenant isolation** | R7 | Prevents cross-tenant/cross-company access |
| **Zero-trust access control** | R7 | Minimizes standing access; least privilege |
| **Audit logging** | R1, R7 | Detects misuse; supports accountability and DSR handling |
| **Egress DLP** on the AI-processor path | R4, R3, R5 | Blocks sensitive content leaving before transfer |
| **DPA + no-training terms (or local model)** | R4 | Contractual + technical limit on processor use of data |
| **Local-model option (target state)** | R4 | Removes/greatly reduces the cross-border transfer entirely |
| **Retention limits + auto-purge** (90d raw / 12m summaries) | R6 | Storage limitation; shrinks breach blast radius |
| **Scope limit + "no decisions about individuals"** | R1, R5 | Core proportionality control; reduces intrusion and chilling effect |
| **Transparent notices + objection channel** | R1 | Meets transparency; supports rights and the LIA balancing test |

---

## 7. Residual risk and sign-off

### 7.1 Residual risk summary

With the mitigations in Section 6 applied, most risks reduce to **Low** or **Low–Medium**. The notable residual items are:

- **R4 (cross-border transfer to the AI processor): Medium.** This is the principal residual risk while cloud AI is used. It is mitigated by DPA/no-training terms, a valid transfer mechanism (SCCs/adequacy/DPA), egress DLP, and restricting the free tier to no-real-data trials. It reduces further toward **Low** once processing moves to **local models** (target state). «ASSUMPTION: confirm transfer mechanism and processor terms with counsel.»
- **R1 (chilling effect) and R3/R7 (special-category leakage / breach): Low–Medium**, contingent on the scope limit holding, suppression/redaction performing reliably, and the "no decisions about individuals" commitment remaining true.

**Provisional overall residual risk: Medium, trending Low** as local-model adoption and Phase-2 media controls mature. On the current design, **no residual risk is assessed as "high" that cannot be mitigated** — subject to counsel confirmation, this suggests prior supervisory-authority consultation is **not** triggered. «ASSUMPTION: confirm against UU PDP No. 27/2022 and [JURISDICTION].»

### 7.2 Actions / conditions before go-live

1. Counsel review of this DPIA and the LIA; confirm lawful basis and balancing.
2. Confirm the controller entity ([CONTROLLER ENTITY]) and jurisdiction(s) ([JURISDICTION]).
3. Appoint and publish the data-protection contact ([DPO NAME/EMAIL]).
4. Execute the AI-processor DPA (no-training) and confirm the transfer mechanism (SCCs/adequacy) before any real data is sent.
5. Verify ingestion redaction, special-category suppression, and third-party exclusion via testing before ingesting real data (ties to Gate-2 technical spec).
6. Confirm retention periods and that auto-purge and crypto-shred erasure work end-to-end (including against immutable backups).
7. Complete employee / employee-representative consultation and record outcomes.
8. Re-run this DPIA on the triggers in Section 8.

### 7.3 Re-assessment triggers (Section 8)

Re-run this DPIA when: local models replace cloud AI; the Bot gains company-database access (e.g., MCP hub); additional verticals/companies come online; Phase-2 media (voice/images/documents) is enabled; any automated action or decision-making about individuals is contemplated; retention, recipients, or transfer mechanisms change.

### 7.4 Sign-off block

| Role | Name | Decision | Date | Signature |
|---|---|---|---|---|
| Assessment author | [AUTHOR] | Prepared | [DATE] | __________ |
| Data Protection Officer / privacy | [DPO NAME/EMAIL] | Reviewed / advised | ______ | __________ |
| Legal counsel ([JURISDICTION]) | [COUNSEL] | Approved / conditions | ______ | __________ |
| Business owner ([CONTROLLER ENTITY]) | [OWNER] | Accepts residual risk | ______ | __________ |

**Decision:** ☐ Proceed  ☐ Proceed with conditions (list above)  ☐ Do not proceed  ☐ Consult supervisory authority

---

*This is a DRAFT to accelerate legal review. It is not legal advice and must be reviewed, localized, and signed off by qualified counsel in the applicable jurisdiction(s) before any real employee or client data is ingested.*
