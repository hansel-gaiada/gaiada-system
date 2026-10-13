# Runbook - company sealing keys (PV5-07, ruling PV-D25): create, check, rotate

**Status: PROTOTYPED.** The code is proved on the Linux CI gate with keys generated at test time. **No live key exists
yet, and nothing here has been run on a server.** The orchestrator runs every live step.
Plan: `docs/plans/2026-10-12-pv5-contracts-billing-tickets.md` (PV5-07, decision 21). Code: `platform-nest/src/core/document-seal.ts`,
`document-jobs.ts`, the CLI `platform-nest/src/ops/seal-key.ts` (shipped in the image as `dist/ops/seal-key.js`).

## What the key is

Each signed contract gets ONE PDF (the agreement, then its evidence page) sealed with a PAdES signature made with
the company's own key. Readers show it as "unmodified since sealed" and the signer's identity as **not verified**: the
certificate is self-issued in the billing profile's legal name, not issued by a certification authority. Legally the
signatures stay uncertified (PV-D8 attested tier). There is no third-party timestamp.

| Half | Where | Who reads it |
|---|---|---|
| **Private key** (secret): `seal-key.pem`, AES-256 encrypted PKCS#8 | ERP host `/etc/gaiada/seal-keys/<companyId>/`, dir `0700 root:root`, file `0400 root:root` | `platform` container, read-only mount at `/run/seal-keys/` (`infra/compose/docker-compose.vps.yml`) |
| **Passphrase** (secret): `seal-key.pass` | same directory, `0400 root:root` | same |
| **Certificate** (public) | `company_seal_certificates` (one row per key, kept after rotation) | the seal job; anyone verifying an old seal |

Never in the repo, the database or an env var. `env_file` mangles a multi-line PEM (empty on one compose, 27
characters on another), which is why both secrets are files. `SEAL_KEYS_HOST_DIR` in the ERP `.env` overrides the
host directory; leave it unset.

## What happens before a key exists (today on live)

Issuing and signing are unaffected: the job runs after commit. For each signed contract (with fixed content) the job
records `blocked` / `seal_key_missing` in `document_jobs`, the copy stays "being prepared" (`signedCopyFileId: null`),
and each owner of the company gets ONE `document.preparation_blocked` notification per contract. The sweep retries
hourly and at every boot. Invoice PDFs need only the renderer, not a key.

## Create a company's key

Prerequisite: the company's billing profile exists (its legal name names the certificate).

```sh
sudo install -d -m 0700 -o root -g root /etc/gaiada/seal-keys
# One-off container from the platform image, the key dir mounted READ-WRITE (the service mounts it read-only).
# $COMPOSE = the server's usual compose invocation for the ERP project (see the server-compose-file-set note).
$COMPOSE run --rm --no-deps -v /etc/gaiada/seal-keys:/seal-keys platform \
  node dist/ops/seal-key.js create --company <company uuid> --out /seal-keys
```

It prints the serial, the SHA-256 fingerprint, the validity (5 years; `--years N` for 1-20) and the two file paths,
never the key or the passphrase. It refuses to overwrite an existing key. No restart is needed: the directory mount
shows new files, and the next sweep (or a restart, which sweeps at boot) seals what was waiting.

Check: `docker exec gaiada-platform-1 node dist/ops/seal-key.js list --company <uuid>` lists the certificates on record.

## Verify a sealed copy

```sh
docker cp copy.pdf gaiada-platform-1:/tmp/copy.pdf
docker exec gaiada-platform-1 node dist/ops/seal-key.js verify --company <uuid> --pdf /tmp/copy.pdf
```

`VERIFIES` against a serial means the PDF is byte-for-byte what was sealed with that company's key. Any PAdES-aware
reader (Adobe Acrobat, Foxit) shows the same "document not modified" result without our systems.

## Rotate

1. `sudo mv /etc/gaiada/seal-keys/<uuid> /root/seal-keys-retired-<date>-<uuid>` (out of the mount).
2. Run **Create** again. A new certificate row is added; the old one stays, so seals made with the old key still verify.
3. Shred the retired directory once the new key has sealed one copy (`list` shows both serials).

Compromise: rotate at once. Copies sealed with the compromised key remain checkable against its certificate but should
be re-issued; that is a counsel question (PV5-Q1), not a script.

## Failure reasons (`document_jobs.last_error`)

| Reason | Meaning | Fix |
|---|---|---|
| `seal_keys_dir_not_configured` | `SEAL_KEYS_DIR` empty in the container | the compose file sets it to `/run/seal-keys`; check the deployed compose |
| `seal_key_missing` | no `<companyId>/seal-key.pem` + `.pass` under the mount | Create |
| `seal_key_unreadable` | wrong passphrase file, or not an RSA key | re-create (rotate) |
| `seal_certificate_missing` | no current certificate row matches the mounted key | the insert failed or the key was swapped by hand: rotate |
| `renderer_not_configured` / `render_failed` / `render_unverified` | report-renderer absent, failing, or it rendered a page that was not this document | fix report-renderer; retried with backoff |
| `content_mismatch` | the agreement's stored bytes no longer hash to what both parties signed | **never sealed, never retried**: investigate the file store |
