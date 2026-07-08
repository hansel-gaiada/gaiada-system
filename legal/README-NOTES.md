# Legal — Gate 1 Pack (Notes & Status)

> ⚠️ **DRAFTS — NOT LEGAL ADVICE.** Everything in this folder is a working draft to accelerate and reduce the cost of legal review. **A qualified lawyer in the applicable jurisdiction(s) must review, localize, and sign off before any real employee/client data is ingested.**

This folder holds the **Gate 1 (legal basis)** documents for the WhatsApp work-summary bot. Revisit and update it when the full system is built (see "Revisit later").

---

## The stated purpose (basis of every document here)

The bot exists for **project progress tracking, workflow efficiency, and making it simpler to query work-related information.** It operates **only in work groups and in work-related direct messages, and only for work-related content.** This narrow, work-scoped purpose is the foundation of the legitimate-interests case.

## Documents in this folder

| File | What it is | Status | Needs before use |
|---|---|---|---|
| `lia.md` | Legitimate Interests Assessment — the lawful basis (NOT consent) | DRAFT | Lawyer review; confirm assumptions |
| `dpia.md` | Data Protection Impact Assessment | DRAFT | Lawyer review; risk sign-off |
| `ropa.md` | Records of Processing / data map | DRAFT | Confirm data categories + recipients |
| `employee-monitoring-notice.md` | The notice employees receive (short in-group + full text) | DRAFT | Lawyer review; localize + translate (Indonesian) |
| `privacy-notice.md` | Data-subject privacy notice | DRAFT | Lawyer review; add contact/DPO |
| `retention-and-dsr-procedure.md` | Retention schedule + access/erasure procedure | DRAFT | Confirm retention periods |
| `trial-consent-notice.md` | Opt-in **trial** consent + notice (enables the near-free trial NOW) | DRAFT | Confirm volunteer list; light review |

## Shared assumptions used across the drafts (confirm / correct these)

- **«ASSUMPTION» Jurisdiction:** Indonesia (UU PDP No. 27/2022) as primary; drafted to **GDPR-grade** so it also covers EU/SG exposure. → *Confirm actual jurisdictions with counsel.*
- **«ASSUMPTION» Controller:** the Gaiada group / relevant child company as data controller. → *Confirm which legal entity.*
- **«ASSUMPTION» Lawful basis:** **legitimate interests** (LIA), not consent (employer–employee power imbalance).
- **«ASSUMPTION» No automated decisions about individuals** — summaries are for operational oversight, **not** performance management, discipline, or evaluation of persons. *(This materially strengthens the DPIA — confirm it's true and keep it true.)*
- **«ASSUMPTION» Retention:** raw messages **90 days**, summaries **12 months**, then auto-purge. → *Confirm.*
- **«ASSUMPTION» AI provider for real data:** paid tier with a **DPA + no-training** terms (or local model). The **free tier is used only for the opt-in trial with no real/regulated data.**
- **«ASSUMPTION» Third parties:** clients/vendors in project groups are **detected and excluded** (no basis to process their data) unless a separate basis/contract exists.
- **«ASSUMPTION» Special-category data** (faces/health/biometrics) is **suppressed** in the media pipeline.
- **«ASSUMPTION» Contact point / DPO:** to be assigned. → *Provide a name/email.*

## Open items for you / counsel

1. Confirm jurisdictions + whether registration/DPO is required.
2. Confirm the controller entity(ies).
3. Confirm retention periods.
4. Confirm "no decisions about individuals" holds.
5. Provide a data-protection contact (name/email).
6. Confirm works-council / employee-rep consultation needs.
7. Confirm client/third-party contractual position (can their comms be processed at all?).

## Revisit later (when the whole system is built)

- **Re-run the DPIA** when: local models replace cloud AI, the MCP hub gives the bot company-DB access, additional verticals/companies come online, or agent auto-actions are added.
- **Update the RoPA** whenever processing, recipients, retention, or transfers change.
- **Cross-border transfers:** re-assess (and likely retire) the transfer basis once processing moves to **local models** (target-state) — the transfer risk largely disappears.
- **Per-entity divestiture:** confirm the crypto-shred **per-entity key domains** make a company's data cleanly severable (ties U1) — relevant if a child company is ever sold.
- **Retention vs immutable backups:** confirm erasure is honored via **crypto-shred** (destroy key), since WORM backups can't be edited (ties day-one spec).
- **Localization:** ensure notices are translated (Indonesian) and the AI eval suites cover local-language quality (ties U10).

## Related

- Inputs: `docs/superpowers/specs/2026-07-05-gate1-intake-questionnaire.md`
- Technical gate (Gate 2): `docs/superpowers/specs/2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md`
- Compliance design: `docs/superpowers/specs/2026-07-04-compliance-data-governance.md`
