# Runbook — Key Custody (OpenBao Transit)

**Implements:** day-one spec task 0.4 / Phase 5a.10. The bot's envelope encryption (v2)
double-wraps every DEK under a per-subject and a per-entity transit key; **key destruction
in OpenBao is the crypto-shred**. Verified: the full crypto suite incl. the
shred-survives-restore drill passes against a live transit engine
(`BAO_URL=... BAO_TOKEN=... npx vitest run src/crypto` in `wa-chat-bot/`).

## Local dev

```bash
cd wa-chat-bot && docker compose --profile kms up -d
docker exec gaiada-openbao bao secrets enable transit
# .env: BAO_URL=http://localhost:8200  BAO_TOKEN=<BAO_TOKEN from .env>
```
Dev mode is in-memory and auto-unsealed — keys vanish on restart. Dev only, by design.
Without BAO_* set, the bot falls back to LocalKms (`data/keys.json`) — dev only; that file
must NEVER be in a backup set (see `erasure-divestiture.md`).

## Production (ISOLATED VPS — never beside the app or DB)

1. **Provision a dedicated small VPS** running nothing else. Firewall: inbound 8200 only
   from the app VPS's IP (or WireGuard); SSH by key only.
2. **Install OpenBao** (raft storage, TLS listener with a real cert):
   `storage "raft" { path = "/opt/openbao/data" }` + `listener "tcp" { tls_cert_file, tls_key_file }`.
3. **Initialize with Shamir 3-of-5:** `bao operator init -key-shares=5 -key-threshold=3`.
   Distribute the 5 unseal shares to 5 distinct places (password manager, printed in a safe,
   trusted person, …) — never all in one location, never on either VPS.
4. **Enable transit:** `bao secrets enable transit`.
5. **Least-privilege app token** (NOT root):
   ```hcl
   path "transit/keys/*"        { capabilities = ["create", "update", "delete"] }
   path "transit/encrypt/*"     { capabilities = ["update"] }
   path "transit/decrypt/*"     { capabilities = ["update"] }
   path "transit/hmac/*"        { capabilities = ["update"] }
   ```
   `bao token create -policy=gaiada-bot -period=768h` → `BAO_TOKEN` in the app's env.
   Rotate on a calendar reminder; revoke immediately on any suspicion.
6. **Off-box backup:** nightly `bao operator raft snapshot save` → encrypt (age/gpg) →
   copy off-box. The snapshot contains key material — it is the ONE backup that must be
   encrypted and stored separately from all data backups, or the shred is void.
7. **Unseal after reboot:** any 3 shareholders run `bao operator unseal`. Until unsealed,
   the bot's decrypt paths fail closed ([erased] placeholders; ingestion keeps working —
   new encrypts fail → messages queue as errors, alert fires).
8. **Break-glass:** losing quorum (3+ shares) = permanent loss of all encrypted PII —
   that is the guarantee working as designed. Document shareholders + a quarterly
   share-verification drill in the risk register.

## Drill cadence

Quarterly: run the shred drill against production OpenBao with a synthetic subject
(`encrypt → snapshot → delete key → restore snapshot elsewhere → decrypt fails`), and one
unseal exercise with 3 shareholders. Record both in the risk register.
