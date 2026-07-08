# Compliance & Data Governance (cross-cutting track)

**Date:** 2026-07-04
**Status:** Design stub (brainstorming stage — not being built yet)
**Parent:** `2026-07-04-gaiada-ai-platform-roadmap.md` (cross-cutting track under Governance/WS6 + WS7)
**Scope:** Regulatory posture and data governance across radically different businesses. Table stakes for a system meant to be enterprise-grade and defensible.

---

## 0. D2 Resolution — Pre-Ingestion Compliance Gate (LOCKED)

**Regime:** design to **GDPR-grade** (strictest) as the default — this also satisfies **Indonesia UU PDP No. 27/2022**, **SG PDPA**, and any EU-client exposure. Confirm exact scope with legal counsel (open action).

**Hard gate — NO production ingestion of any real message until ALL are live:**
1. **Lawful basis documented and it is NOT employee consent** (power imbalance invalidates it). Use Legitimate-Interest Assessment + **DPIA** + proportionality; works-council/employee notice where applicable.
2. **Per-individual notice + opt-out**; **third-party detection + exclusion** (clients/vendors in project groups never consented) via `identity_links`.
3. **Special-category suppression** in the vision/transcription pipeline (faces/health/biometric have no Art. 9 basis by default).
4. **Retention TTL + automatic purge** on ingested messages/media.
5. **PAN blocking at WhatsApp ingestion** (Luhn) — a card number never enters DB/backups/vectors, keeping the estate out of PCI scope.
6. **Cross-border transfer basis** for cloud-AI + Google Drive (SCCs/adequacy) — see §0.2.

**Day-one technical safeguards (LOCKED — impossible to retrofit):**
- **Per-subject envelope encryption / crypto-shred:** personal data encrypted under a per-data-subject KEK; erasure = destroy the key → renders WORM/PITR ciphertext dead. This is the ONLY way right-to-erasure coexists with immutable backups. **Day-one schema decision.**
- **PII kept out of derived stores:** hash/pseudonymize in the hash-chained audit; exclude raw PII from embeddings + fine-tuning corpora; retrain-on-erasure policy. Prevents un-eraseable copies proliferating (ties to D9).
- **PAN block + retention TTL** as above.

> **Detailed design (LOCKED):** the KEK hierarchy (two-axis `KDF(subject_KEK, entity_KEK)`, self-hosted OpenBao on an isolated VPS, field-level PII + media encryption, HMAC-pseudonym lookup) and the ingestion scrubber (Luhn PAN + KTP/passport, redact-before-persist, runs on media-derived text too) are fully specified in **`2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md`**, including the day-one gate checklist.

### 0.2 Cross-border tension with the cloud-AI-first v1 (D1)
v1 is cloud-AI-first (Claude/Gemini APIs) and uses Google Drive — both are **cross-border transfers + external processing** of personal data. Therefore: (a) route all private-chat AI through the Gateway with **redaction/PAN-block before egress**; (b) **block special-category + regulated data from cloud egress** (local/on-prem only — gates the regulated verticals behind the target-state local build); (c) establish SCCs/DPAs with providers; (d) pin/segment by region where required.

### 0.3 Legal action item
Engage counsel to (1) confirm applicable regimes + registration duties, (2) validate the lawful basis + DPIA, (3) approve the monitoring notice wording, (4) confirm PCI scope decision. **Blocking for launch, not for design.**

---

## 1. Regulatory surface (per business)

- **Resort/hotel:** **PCI-DSS** (card payments), guest **PII**, possibly hospitality-specific rules. Consider isolating the cardholder-data environment (or use a compliant payment processor so card data never touches core systems).
- **Marine/logistics:** cargo/manifest, customs, safety records.
- **All:** employee PII, and — critically — the **WhatsApp bot reads private employee conversations** → **consent + labor-law** obligations; notice that the bot is present and summarizing; retention limits.

## 2. Data governance

- **Classification** — tag data sensitivity (public/internal/confidential/regulated); drives Gateway egress DLP + RLS + retention.
- **Residency** — multi-jurisdiction; keep regulated data in-region (aligns with per-site local-first).
- **Retention & erasure** — policies per data class; **right-to-erasure** workflow (tricky with immutable backups + event sourcing → use crypto-shredding / tombstoning strategies).
- **Consent** — capture + honor (WhatsApp monitoring, AI processing of personal data).
- **Audit** — the tamper-evident audit trail (WS7) is the compliance evidence base.

## 3. AI-specific governance

- **What data may reach which model** (Gateway DLP + allowlist) — external providers get policy-filtered data only.
- **AI decision auditability** — trace + log agent actions (WS8/WS9); human-in-loop for high-impact.
- **Data-use for training** — fine-tuning only on permitted data; document lineage.

## 4. Approach

- Not a one-time gate — a **continuous track** woven into each workstream (privacy-by-design).
- Prioritize by risk: PCI (resort payments) and WhatsApp consent are the near-term must-haves; broaden as verticals come online.

## 4b. Risk register (accepted business risks)

| Risk | Rating | Owner | Acceptance |
|---|---|---|---|
| **WhatsApp unofficial-client ToS violation** (Surface #1 runs on a reverse-engineered client reading private chats) | Medium probability, **high blast radius** (estate-wide summary outage on ban) | (assign) | Explicitly accepted; mitigated by warm-standby number + ban-recovery runbook + Telegram fallback (bot spec §8.1). Revisit if Meta enforcement escalates. |

## 5. Open items
- Which entity/jurisdictions actually apply (legal input needed).
- PCI scope decision (isolate vs outsource card handling).
- Right-to-erasure mechanism vs immutable backups (crypto-shredding design).
- WhatsApp monitoring consent/notice wording + legal sign-off.
- Data-classification taxonomy.
