# Runbook: certified signing through the SIMULATED PSrE (review stage, PV-D43)

**Ticket:** PV5-11. **Ruling:** PV-D43 (owner, 2026-10-14): "sign it as this is still review". Certified signing is
unparked for the REVIEW stage with a simulated certified-signature provider (PSrE), labelled, audited, flag-gated, and
**switched off before the ERP holds real data**. The real PSrE (VIDA, PV-D25) comes later as a second adapter.
**Status of this document: PLANNED.** Nothing below has been run on a server.

## 1. What the simulation is, and what it is not

- It is an in-process stand-in for a PSrE (`platform-nest/src/signatures/simulated-psre.ts`). The client signs on a
  labelled portal page, our countersigner (an owner of the company) on a labelled staff page; the simulator sends a notice
  to the ERP's own webhook, the ERP re-fetches the envelope and records the signatures, and on completion it stores the
  simulator's signed PDF and certificate as the contract's certified copy.
- It is **not** a certified electronic signature. No PSrE issued a certificate, nobody's identity was verified by a PSrE,
  and the certificate is self-issued by the simulator (subject "SIMULATED PSrE (review stage) - not a certification
  authority"). Every page and PDF says SIMULATED; Documents says "Certified (simulated)".
- **Key custody:** the simulator's signing key is generated in the platform process's memory the first time it signs
  and is never written anywhere (no file, no database row, no env var, no log). Each signed document carries, and the
  ERP stores next to it, the certificate it was signed with, so it stays verifiable. A restart starts a new simulated
  identity; there is no key to provision, back up, rotate or clean up. The notice credential is in memory too.
- Notices travel over the loopback (`http://127.0.0.1:${PLATFORM_PORT}/api/webhooks/signatures/simulated`). If one is
  lost, the signature sweep re-fetches open envelopes every 5 minutes and catches up.

## 2. Switch it on (dev / review stage only)

Preconditions: migration `202610150300_pv5_certified_signing_simulated.sql` is applied (it runs on boot with the release
that carries it), and the ERP holds **mock data only** (the standing owner ruling of 2026-10-13).

1. On the server, in the compose `.env` next to `docker-compose.vps.yml`, set:

   ```
   SIGNATURE_SIMULATION_ENABLED=1
   ```

   The compose file already passes it through (`SIGNATURE_SIMULATION_ENABLED: ${SIGNATURE_SIMULATION_ENABLED:-0}`); a
   value only in `.env` with no passthrough row would never reach the container.
2. Recreate the platform container with the usual server compose file set (see `infra/runbooks/deploy-vps.md`; do not
   use `--remove-orphans`, and make sure `.env` carries the current release tag first).
3. Check the boot log says so, once:

   ```
   docker logs <platform container> 2>&1 | grep 'signatures:simulation-enabled'
   ```

   Expect one `[signatures:simulation-enabled] SIGNATURE_SIMULATION_ENABLED is ON (PV-D43, review stage only) …` line
   and `[signatures] notice retry sweep on …`.
4. No Cerbos change is needed (the routes use the existing `contract` `countersign` / `read` and `portal` `sign` /
   `read` actions).

## 3. Drive it once (the review check)

On a placeholder client (live ERP data is seed), as staff: draft a contract, **Mark certified**, **Send**. As the
client's signer in the portal: open the contract, **Sign with Simulated PSrE (review stage)**, sign on the simulated
page. As an owner: on the client's billing tab, **Countersign at Simulated PSrE (review stage)**, sign. Then check:

- the contract is **Signed**; its signed copy is the certified copy, and Documents shows **Certified (simulated)** with
  a Certificate link, in the portal and on the staff billing tab;
- the PDF opens in a reader, says SIMULATED on every page, and its signature reads as intact (the reader also says the
  signer's identity is not trusted, which is correct);
- the contract's activity shows `certified_envelope_created`, two `certified_signed` and `certified_completed`, each
  with `simulated: true`.

## 4. Switch it OFF before real client data (required)

1. Set `SIGNATURE_SIMULATION_ENABLED=0` (or remove the line) in the server `.env`, recreate the platform container, and
   check the boot log now says `[signatures] certified signing is off …`.
2. Effects: "Mark certified" and sending a certified-tier contract answer 409 `no_certified_provider` again; the
   simulator's pages and its webhook answer 404; the sweep does not start. Contracts already signed keep their certified
   copy and certificate, still labelled simulated (they are records and cannot be deleted).
3. Any certified contract still waiting for a signature cannot be completed any more. Void it and re-issue it (attested,
   or certified once the real PSrE adapter exists). List them with:

   ```sql
   -- run through the platform's tenant context (withTenants), or as the owner role with the tenant GUC set
   SELECT id, title, status, provider_envelope_id FROM contracts
    WHERE signature_tier = 'certified' AND signature_provider = 'simulated' AND status = 'sent';
   ```

4. Record on the board that the simulation is off, next to the MFA simulation item ("Before real clients use the
   portal").

## 5. Rollback

The flag is the rollback: off restores the pre-PV5-11 behaviour exactly. The migration is additive; reversing it is
only possible while no certified copy exists (see its header).
