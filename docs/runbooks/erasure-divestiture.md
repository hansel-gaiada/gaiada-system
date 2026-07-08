# Runbook — Per-Subject Erasure & Per-Entity Divestiture (Crypto-Shred)

**Scope:** wa-chat-bot (trial + hardened). Implements the day-one spec
(`docs/superpowers/specs/2026-07-05-day-one-crypto-shred-and-ingestion-scrubber.md`).
Verified by the automated drill `wa-chat-bot/src/crypto/shred-restore.drill.test.ts` (Task 0.10).

## How the shred works (two-axis)

Every PII field is encrypted under a DEK derived from **both** a per-subject KEK and a
per-entity KEK (`HKDF(subject_KEK ‖ entity_KEK)`). Destroying **either** key makes every
ciphertext under it permanently unreadable — including copies in backups — because backups
contain ciphertext only, never key material.

| Axis | Trigger | Destroy | Effect |
|---|---|---|---|
| Subject | Right-to-erasure / opt-out | `subject:<senderId>` KEK | All of that person's PII fields, everywhere, incl. backups |
| Entity | Divestiture / offboarding a company | `entity:<chatId/tenant>` KEK | All PII in that entity's scope |

## Per-subject erasure procedure

1. **Verify the request** (identity of the requester; log the DSR per `legal/` retention/DSR doc).
2. **Destroy the subject KEK:** call `eraseSubject(senderId)` (`wa-chat-bot/src/crypto/envelope.ts`).
   - Trial (LocalKms): removes the key from `data/keys.json`.
   - Production (OpenBao transit): `DELETE /v1/transit/keys/subject:<id>` with `deletion_allowed=true` — see `key-custody.md` (Task 0.4, pending).
3. **Tombstone the pseudonym index:** the HMAC pseudonym (`sender_pseudonym` column) is keyed
   by the destroyed subject KEK, so no new lookups can link to it; optionally null the column
   for the subject's rows to remove the stable token itself.
4. **Audit:** write an erasure audit row (who/when/what key id). Never log the plaintext identity.
5. **Verify:** read one of the subject's rows — the sender must decode as `[erased]`.

## Per-entity divestiture procedure

1. Confirm the divestiture decision in writing (management sign-off).
2. Call `eraseEntity(entityId)` — destroys `entity:<id>` KEK.
3. Optionally hard-delete the entity's plaintext (non-PII) rows per the divestiture agreement.
4. Audit + verify as above.

## Backup discipline (what makes the shred hold)

- **Backups must NEVER include KMS key material.** Trial: `data/keys.json` is excluded from
  any backup set (it lives with the KMS role, not the data role). Production: keys live only
  in OpenBao on the isolated VPS; DB dumps physically cannot contain them.
- Re-onboarding a subject after erasure mints a **new** KEK; pre-erasure ciphertexts stay dead
  (verified in the drill).

## Drill cadence

Run the drill on every CI run (it's part of `npm test`). Re-run manually after any KMS or
envelope change: `npx vitest run src/crypto/shred-restore.drill.test.ts`.
