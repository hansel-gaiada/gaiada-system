# Day-One Foundations — Crypto-Shred KEK Hierarchy & Ingestion Scrubber

**Date:** 2026-07-05
**Status:** Design LOCKED (day-one, unretrofittable — must be true before first real-message ingestion)
**Relates to:** D2 (compliance gate), U1 (divestiture), U11 (key lifecycle), D9 (derived-store erasure), U3 (break-glass), D8 (egress DLP — the *second* layer).
**Why this doc exists:** these two mechanisms cannot be retrofitted. If the first message is ingested without them, the resulting corpus (in WORM backups, PITR, embeddings, LoRA) is permanently un-eraseable and may be un-divestible and in PCI scope. Everything else in the program can evolve; these are cast at message #1.

---

## Part A — Crypto-Shred KEK Hierarchy

### A1. The property we're buying
Immutable WORM backups + PITR + replication make *data deletion* impossible by design. Crypto-shredding delivers deletion anyway: encrypt the data, and **destroy the key, not the data**. Ciphertext in WORM/PITR/replicas becomes permanently unreadable; the key never lived in those backups (it lives in a separately-managed store that *can* be destroyed). **Erase = destroy key — atomic across every copy that exists or ever existed.**

### A2. Envelope model — DECIDED
- **Root key** (in the key store) wraps **KEKs** (key-encryption-keys) which wrap **DEKs** (per-record/field data-encryption-keys). Data encrypted with DEKs; DEKs stored **wrapped** alongside the data (so they ride into backups — but are useless without their KEK).
- **Shred primitive = destroy a KEK** in the key store → every DEK it wrapped is instantly orphaned everywhere.

### A3. Two-axis independent keys — DECIDED
Each DEK's wrapping key is derived as **`KDF(subject_KEK, entity_KEK)`**:
- **Destroy `subject_KEK`** → that data-subject's data is erased across all copies and all entities they appear in (right-to-erasure).
- **Destroy `entity_KEK`** → that whole child company's data is severed (clean divestiture — U1).
- The two operations are **independent** and both instant. A record with no personal-data subject still gets an entity key (divestiture works for all company data, not just PII).

### A4. Key custody — DECIDED (v1)
**Self-hosted OpenBao/Vault on a dedicated, hardened VPS** (keys stay on Gaiada infra). Migrate to HSM-backed / all-local in target-state; the hierarchy is identical, so this is swappable. **Three non-negotiable conditions:**
1. **Isolation:** the key-custody VPS runs **no app/DB code**; reachable only via its API over **mTLS**. Never co-locate keys with the ciphertext plane.
2. **Off-box key-material backup:** OpenBao storage + **Shamir unseal shares** backed up **securely and separately** (encrypted, off the box). *Losing them = the inverse catastrophe: all data permanently unreadable with no attacker involved.* An explicit unseal + **M-of-N break-glass** procedure (U3) is required.
3. **Availability:** documented recovery + ideally a warm replica; if the key store is down, encrypt/decrypt stalls — handle gracefully (queue, don't crash).

*(Trade recorded: self-host = max privacy, you own durability/HA/loss risk. Managed KMS was the lower-ops alternative; revisit if solo ops proves too heavy.)*

### A5. Encryption scope — DECIDED
- **Encrypt:** personal-data fields + media blobs, under the subject×entity keys.
- **Leave queryable:** non-personal operational data (plaintext + RLS) — preserves indexing/search/joins where there's no personal data.
- **Lookup:** for identifiers you must match on (e.g. phone → `identity_links`), store a **keyed HMAC pseudonym** (equality lookup) alongside the encrypted value. On erasure the encrypted value dies; the HMAC index entry is tombstoned.
- **Derived stores (D9):** exclude raw PII from embeddings/KG (pseudonymize before embedding), OR encrypt personal-data-bearing derived artifacts under the same subject key — so the shred reaches them. LoRA/fine-tune corpora exclude raw PII (retrain-on-erasure policy).

### A6. Operations
- **Erasure (per subject):** destroy `subject_KEK` → tombstone its HMAC index entries → log the erasure (without PII) in the audit. Verify by attempting decrypt (must fail).
- **Divestiture (per entity):** destroy `entity_KEK`. Requires shared derived stores (the "one brain" KG) to be **partitioned per entity** so severance is clean (U1) — cross-entity nodes must be separable or independently keyed.
- **Rotation (U11):** rotate root/KEKs on policy; DEKs re-wrapped; rotation must preserve the ability to destroy (never merge subjects/entities under one key).
- **Verification:** periodic drill — encrypt test data, destroy its key, confirm unrecoverable from a restored backup.

### A7. Failure modes to design against
- **Key loss** (see A4.2) — the dominant risk; backup discipline is the mitigation.
- **Key/ciphertext co-location** — forbidden (A4.1); would defeat the shred.
- **Key store outage** — graceful degradation, not data-plane crash.

---

## Part B — Ingestion Sensitive-Data Scrubber (PAN+)

### B1. The property we're buying
Keep the estate **out of PCI-DSS scope** (a categorically larger compliance regime) and keep high-risk identifiers out of the permanent corpus — by ensuring they are **never persisted in the first place.** Only works **before persistence**.

### B2. Detection — DECIDED
- **PAN:** Luhn checksum + regex for 13–19-digit card-BIN patterns; context-aware to reduce false positives. **Fail-safe = redact when unsure** (masking a stray non-card number is harmless).
- **Pluggable pattern registry** (per jurisdiction): mandatory **PAN**, plus **Indonesian KTP (national ID)**, **passport**, and similar high-risk identifiers for the operating regions. New patterns added without touching the pipeline.

### B3. Pipeline placement — DECIDED (the critical part)
The scrubber runs **at the ingestion normalizer, before any persistence, any AI call, or any embedding** — AND on **every text the media pipeline produces**: voice-note transcription, OCR, image/vision description. Extracted text is scrubbed **before** it is stored or embedded. (A PAN spoken in a voice note or photographed on a receipt is a PAN.)

### B4. Action — DECIDED
- **Redact/mask** the match to `[REDACTED-CARD]` / `[REDACTED-ID]` before storage — the real value is never persisted anywhere.
- **Log the detection event WITHOUT the value** (audit + education signal).
- **Optionally auto-reply** to the sender that card/ID details shouldn't be shared here.
- *(Not tokenization — a token vault shifts PCI scope rather than eliminating it; a chat bot has no reason to retain PANs.)*

### B5. Relationship to egress DLP (D8)
The ingestion scrubber is the **primary** control (prevents storage). The Gateway egress DLP (D8) is a **second, independent layer** (prevents leakage to external AI). Both exist; ingestion is authoritative for the storage guarantee.

### B6. Testing
Fixtures: valid vs invalid-Luhn numbers; KTP/passport samples; a PAN embedded in transcription output; a PAN in an OCR'd image; false-positive candidates (order numbers, phone numbers). Assert nothing containing a live PAN is ever written to DB/object-store/vectors.

---

## Day-One Gate — must ALL be true before the first real message

- [ ] KEK hierarchy live: root + per-subject + per-entity KEKs; DEK wrapping via `KDF(subject_KEK, entity_KEK)`.
- [ ] Key custody VPS: isolated (no app/DB), mTLS-only, unseal shares + storage backed up off-box, M-of-N break-glass documented.
- [ ] Personal-data fields + media encrypted; HMAC pseudonym lookup in place; derived stores exclude raw PII.
- [ ] Ingestion scrubber active on message text **and** all media-derived text; redact + log-without-value.
- [ ] Erasure + divestiture runbooks drafted; a key-destruction → restore-from-backup verification drill has passed once.

*(This gate is a subset of the D2 hard compliance gate; the D2 gate additionally requires lawful basis, notice/opt-out, third-party exclusion, retention TTL, and cross-border basis.)*
