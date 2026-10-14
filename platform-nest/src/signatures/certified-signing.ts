// PV5-11 — certified signing, the ERP's side (plan PV5-11; design decisions 11-15; rulings PV-D8, PV-D25, PV-D43).
//
// Two operations, both provider-neutral (they speak only provider.ts shapes):
//
// ── 1. START: create the envelope when the CLIENT reaches the sign step (startCertifiedEnvelope) ──────────────
// Never at send: a PSrE charges per signature (blueprint §4), so an envelope exists only once a client signer has
// actually asked to sign. Under the contract's row lock:
//   * an envelope that already exists is returned (one per contract; the provider dedupes on our partner reference too,
//     so a retry after a lost answer cannot create a second one);
//   * the fixed content is read from the bytes we hold (the attached file's stored bytes, else the exact UTF-8 body) and
//     its SHA-256 MUST equal `contracts.content_sha256`, else NOTHING is sent to the provider (409 `content_mismatch`);
//   * the provider's own hash of what it received must equal it too;
//   * the envelope names two signers: the client's signer and our countersigner; `signature_provider` +
//     `provider_envelope_id` are written in the same transaction (frozen by trg_contracts_envelope_frozen afterwards).
//
// ── 2. SYNC: apply what the PROVIDER says, never what a notice says (syncEnvelope) ────────────────────────────
// Called for a claimed notice (process.ts) and by the reconciliation sweep. The notice is a trigger only (VIDA's has no
// HMAC; blueprint §4): the envelope's status is RE-FETCHED from the provider and only that is written.
//   * the re-fetched status must name OUR envelope, OUR partner reference and the contract's fixed hash, or nothing is
//     written (refused, the company's owners are told);
//   * each signer the provider reports as signed becomes a `contract_signatures` row with `provider` and
//     `provider_envelope_id` (the database's trg_contract_signatures_tier_guard refuses anything else on a certified
//     contract), carrying the contract's fixed hash;
//   * COMPLETED: the signed PDF and the certificate are downloaded and CHECKED (the provider adapter verifies the
//     signature against the delivered certificate with the PV5-07 seal verifier, that the certificate is the provider's,
//     and that the document carries exactly the fixed content) BEFORE anything is stored; then both are stored as files
//     with their SHA-256 (roles `contract_certified_copy` / `contract_certified_certificate`, records under
//     202610132000's role-file guard), the contract becomes `signed`, and `contract.signed` is emitted. PV5-07's sealing
//     job skips a certified contract: its document IS the provider's signed copy.
// Idempotent: signatures are ON CONFLICT DO NOTHING, the copy is one live file per role (ux_files_live_role), the status
// flip is guarded, and the contract row lock serialises a notice and the sweep.
import { BadGatewayException, ConflictException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseError, type PoolClient } from "pg";
import { newId, withTenants } from "../db";
import { config } from "../config";
import { storage } from "../core/storage";
import { sha256Hex } from "../core/content-hash";
import { emitEvent } from "../events/outbox.service";
import { writeActivity } from "../core/http";
import { notifyBestEffort, resolveClientRecipients } from "../core/client-notify";
import {
  SignatureProviderRequestError, SignatureProviderUnavailableError, type EnvelopeStatus, type SignatureProviderAccount, type SignedDocument,
} from "./provider";
import { NO_CERTIFIED_PROVIDER } from "../core/signature-provider";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Our reference for a contract's envelope, echoed by the provider (VIDA's partnerTrxId). */
export function partnerRefFor(tenantId: string, contractId: string): string {
  return `${tenantId.toLowerCase()}:${contractId.toLowerCase()}`;
}

/** The company a partner reference names, or null when it is not one of ours. */
export function tenantOfPartnerRef(ref: string): { tenantId: string; contractId: string } | null {
  const [t, k, ...rest] = ref.split(":");
  if (rest.length || !t || !k || !UUID.test(t) || !UUID.test(k)) return null;
  return { tenantId: t.toLowerCase(), contractId: k.toLowerCase() };
}

const SAFE_NAME = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "agreement";

interface FixedContentRow {
  id: string; client_id: string; project_id: string | null; title: string; reference: string | null; version: number;
  status: string; signature_tier: string | null; content_sha256: string | null; file_id: string | null; body_md: string | null;
  signature_provider: string | null; provider_envelope_id: string | null; term_ended: boolean;
}

/** The exact bytes a contract's content hash covers, with a name and a type for the provider. Never re-derived from
 *  anything but what we hold. */
async function fixedContent(c: PoolClient, tenantId: string, k: FixedContentRow): Promise<{ bytes: Buffer; filename: string; contentType: string }> {
  if (k.file_id) {
    const f = (await c.query<{ storage_key: string | null; filename: string; content_type: string | null }>(
      `SELECT storage_key, filename, content_type FROM files WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
      [k.file_id, tenantId],
    )).rows[0];
    if (!f || !f.storage_key) {
      throw new ConflictException({ message: "the agreement's attached document is gone or has no stored content; nothing was sent to the signing provider", reason: "content_missing" });
    }
    let bytes: Buffer;
    try {
      bytes = await storage().get(f.storage_key);
    } catch {
      throw new ServiceUnavailableException({ message: "the agreement's document could not be read right now; try again shortly", reason: "content_unreadable" });
    }
    return { bytes, filename: f.filename || "agreement", contentType: f.content_type || "application/octet-stream" };
  }
  return {
    bytes: Buffer.from(k.body_md ?? "", "utf8"),
    filename: `${SAFE_NAME(k.reference ?? k.title)}.md`,
    contentType: "text/markdown; charset=utf-8",
  };
}

export interface StartedEnvelope {
  envelopeId: string;
  provider: string;
  created: boolean;
}

/**
 * Create (or return) the envelope for a SENT, CERTIFIED contract. The caller has authorized the person and checked the
 * contract is theirs to sign (portal scope, signer capability, the hash they saw). Runs under the contract's row lock.
 */
export async function startCertifiedEnvelope(
  account: SignatureProviderAccount, tenantId: string, contractId: string,
): Promise<StartedEnvelope> {
  return withTenants([tenantId], async (c) => {
    const k = (await c.query<FixedContentRow>(
      `SELECT id, client_id, project_id, title, reference, version, status, signature_tier, content_sha256, file_id, body_md,
              signature_provider, provider_envelope_id, (ends_on IS NOT NULL AND ends_on < current_date) AS term_ended
         FROM contracts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [contractId],
    )).rows[0];
    if (!k) throw new NotFoundException("contract not found");
    if (k.provider_envelope_id) {
      if (k.signature_provider !== account.name) {
        throw new ConflictException({ message: "this agreement is being signed through another signing provider", reason: "other_provider" });
      }
      return { envelopeId: k.provider_envelope_id, provider: account.name, created: false };
    }
    if (k.status !== "sent") throw new ConflictException({ message: `this agreement is ${k.status} and cannot be signed`, reason: "not_sent" });
    if (k.signature_tier !== "certified" || !k.content_sha256) {
      throw new ConflictException({ message: "this agreement is not signed through a certified signing provider", reason: "not_certified" });
    }
    if (k.term_ended) throw new ConflictException({ message: "this agreement's term has ended; ask your account manager to re-issue it", reason: "term_ended" });

    // The fixed content, from the bytes we hold. A difference from the hash fixed at send stops everything.
    const doc = await fixedContent(c, tenantId, k);
    const sha = sha256Hex(doc.bytes);
    if (sha !== k.content_sha256) {
      throw new ConflictException({
        message: "the agreement's document no longer matches the content fixed when it was sent; nothing was sent to the signing provider",
        reason: "content_mismatch",
      });
    }
    const names = (await c.query<{ client: string | null; legal: string | null; company: string | null }>(
      `SELECT (SELECT name FROM clients WHERE id = $2) AS client,
              (SELECT legal_name FROM company_billing_profiles WHERE tenant_id = $1) AS legal,
              (SELECT name FROM companies WHERE id = $1) AS company`,
      [tenantId, k.client_id],
    )).rows[0];

    let created: { envelopeId: string; documentSha256: string };
    try {
      created = await account.forCompany(tenantId).createEnvelope({
        partnerRef: partnerRefFor(tenantId, contractId),
        title: k.reference ? `${k.title} (${k.reference})` : k.title,
        document: { bytes: doc.bytes, filename: doc.filename, contentType: doc.contentType, sha256: sha },
        signers: [
          { role: "client", displayName: `${names?.client ?? "The client"}, authorised signatory` },
          { role: "countersigner", displayName: `${names?.legal ?? names?.company ?? "Our company"}, authorised signatory` },
        ],
      });
    } catch (err) {
      if (err instanceof SignatureProviderUnavailableError) {
        throw new ServiceUnavailableException({ message: "the signing provider cannot be reached right now; try again shortly", reason: "provider_unavailable" });
      }
      if (err instanceof SignatureProviderRequestError) {
        throw new BadGatewayException({ message: `the signing provider refused the agreement (${err.message})`, reason: "provider_refused" });
      }
      throw err;
    }
    if (created.documentSha256 !== k.content_sha256) {
      // The provider holds different bytes than the ones both parties are to sign: never let anyone sign it.
      throw new ConflictException({
        message: "the signing provider reports a different document than the one fixed when this agreement was sent; signing was stopped",
        reason: "content_mismatch",
      });
    }
    await c.query(
      `UPDATE contracts SET signature_provider = $2, provider_envelope_id = $3, updated_at = now() WHERE id = $1`,
      [contractId, account.name, created.envelopeId],
    );
    await emitEvent(c, tenantId, "contract", contractId, "contract.certified_envelope_created", {
      clientId: k.client_id, provider: account.name, simulated: account.simulated, envelopeId: created.envelopeId,
    });
    return { envelopeId: created.envelopeId, provider: account.name, created: true };
  });
}

/** Throws the 409 every certified entry point answers when no provider is set up. */
export function noCertifiedProvider(): never {
  throw new ConflictException({ message: NO_CERTIFIED_PROVIDER, reason: "no_certified_provider" });
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// SYNC
// ══════════════════════════════════════════════════════════════════════════════════════════════════

export type SyncOutcome =
  | { status: "skipped"; reason: string }
  | { status: "retry"; reason: string }
  /** The provider's account cannot be applied (not ours, other content, an invalid signed document). Nothing written. */
  | { status: "refused"; reason: string; outcome: string }
  | { status: "pending"; outcome: string; newSignatures: number }
  | { status: "completed"; outcome: string; newSignatures: number; copyFileId: string; certificateFileId: string };

interface SyncContract {
  id: string; clientId: string; projectId: string | null; title: string; reference: string | null; version: number;
  status: string; tier: string | null; contentSha256: string | null; provider: string | null; envelopeId: string | null;
}

async function loadSyncContract(tenantId: string, contractId: string): Promise<SyncContract | null> {
  const r = await withTenants([tenantId], (c) =>
    c.query<SyncContract>(
      `SELECT id, client_id AS "clientId", project_id AS "projectId", title, reference, version, status,
              signature_tier AS tier, content_sha256 AS "contentSha256", signature_provider AS provider,
              provider_envelope_id AS "envelopeId"
         FROM contracts WHERE id = $1 AND deleted_at IS NULL`,
      [contractId],
    ),
  );
  return r.rows[0] ?? null;
}

/** Store downloaded bytes under a fresh key; returns what the files rows need. */
async function putBytes(tenantId: string, bytes: Buffer): Promise<{ fileId: string; storageKey: string; sha256: string; size: number }> {
  const fileId = newId();
  const storageKey = `${tenantId}/${fileId}`;
  await storage().put(storageKey, bytes);
  return { fileId, storageKey, sha256: sha256Hex(bytes), size: bytes.byteLength };
}

/**
 * Re-fetch the envelope from the provider and apply it. The ONLY place certified signatures, the certified copy and the
 * `signed` status of a certified contract are written.
 */
export async function syncEnvelope(account: SignatureProviderAccount, tenantId: string, contractId: string): Promise<SyncOutcome> {
  const k = await loadSyncContract(tenantId, contractId);
  if (!k || !k.envelopeId) return { status: "skipped", reason: "no envelope for this contract" };
  if (k.provider !== account.name) return { status: "skipped", reason: `the contract is signed through ${k.provider}, not ${account.name}` };
  if (k.status === "void") return { status: "skipped", reason: "the contract was voided" };
  // Already signed: the certified copy, its certificate and the status were written in ONE transaction, so there is
  // nothing left to apply (and nothing to download again).
  if (k.status === "signed") return { status: "skipped", reason: "already signed" };
  if (k.tier !== "certified" || !k.contentSha256) return { status: "refused", reason: "not_certified", outcome: "the contract is not in the certified tier" };
  const envelopeId = k.envelopeId;
  const provider = account.forCompany(tenantId);

  // 1. THE RE-FETCH. The provider's own account of the envelope, never the notice's.
  let st: EnvelopeStatus;
  try {
    st = await provider.getEnvelopeStatus(envelopeId);
  } catch (e) {
    return { status: "retry", reason: `envelope status check failed: ${(e as Error)?.message ?? String(e)}` };
  }
  if (st.state === "unknown") return { status: "refused", reason: "unknown_envelope", outcome: `the provider does not know envelope ${envelopeId}` };
  if (st.envelopeId !== envelopeId || st.partnerRef !== partnerRefFor(tenantId, contractId)) {
    return { status: "refused", reason: "partner_mismatch", outcome: `the provider's envelope ${st.envelopeId} is not this contract's` };
  }
  if (st.documentSha256 !== k.contentSha256) {
    return { status: "refused", reason: "document_mismatch", outcome: "the provider holds a different document than the content fixed at send; nothing was recorded" };
  }
  const signed = st.signers.filter((s) => s.state === "signed" && s.signedAt);
  const roles = new Set(signed.map((s) => s.role));
  if (st.state === "declined" || st.state === "expired") {
    return { status: "pending", outcome: `the provider reports the envelope ${st.state}; nothing was recorded`, newSignatures: 0 };
  }

  // 2. Completed: download and CHECK the signed document before anything is stored.
  let signedDoc: SignedDocument | null = null;
  if (st.state === "completed") {
    if (!roles.has("client") || !roles.has("countersigner")) {
      return { status: "refused", reason: "incomplete_completion", outcome: "the provider reports the envelope complete without both signatures" };
    }
    try {
      signedDoc = await provider.downloadSigned(envelopeId);
    } catch (e) {
      return { status: "retry", reason: `the signed document could not be downloaded: ${(e as Error)?.message ?? String(e)}` };
    }
    const v = await provider.verifySignedDocument(signedDoc, k.contentSha256);
    if (!v.ok) {
      return { status: "refused", reason: "signed_document_invalid", outcome: `the provider's signed document did not verify (${v.reason}); nothing was stored` };
    }
  }

  // 3. Store the bytes (before the transaction; removed again if they end up unused).
  const stored = signedDoc
    ? { copy: await putBytes(tenantId, signedDoc.pdf), cert: await putBytes(tenantId, Buffer.from(signedDoc.certificatePem, "utf8")) }
    : null;
  let usedStored = false;

  type Applied = { newSigs: Array<{ party: string; signerId: string | null; signedAt: string }>; completedNow: boolean; copyFileId: string | null; certificateFileId: string | null };
  let applied: Applied;
  try {
    applied = await withTenants([tenantId], async (c) => {
      const cur = (await c.query<{ status: string; envelope: string | null; provider: string | null }>(
        `SELECT status, provider_envelope_id AS envelope, signature_provider AS provider FROM contracts WHERE id = $1 FOR UPDATE`, [contractId],
      )).rows[0];
      if (!cur || cur.envelope !== envelopeId || cur.provider !== account.name) {
        return { newSigs: [], completedNow: false, copyFileId: null, certificateFileId: null };
      }
      if (cur.status === "void") return { newSigs: [], completedNow: false, copyFileId: null, certificateFileId: null };
      const have = new Set((await c.query<{ party: string }>(`SELECT party FROM contract_signatures WHERE contract_id = $1`, [contractId])).rows.map((r) => r.party));
      const newSigs: Applied["newSigs"] = [];
      for (const s of signed) {
        const party = s.role === "client" ? "client" : "provider";
        if (have.has(party)) continue;
        const signerId = s.signerRef && UUID.test(s.signerRef)
          ? ((await c.query<{ id: string }>(`SELECT id FROM users WHERE id = $1`, [s.signerRef])).rows[0]?.id ?? null)
          : null;
        const ins = await c.query(
          `INSERT INTO contract_signatures
             (id, tenant_id, contract_id, party, signer, signer_name, signer_title, ip_hash, user_agent, content_sha256,
              provider, provider_envelope_id, signed_at, origin_site)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, $8, $9, $10, $11::timestamptz, $12)
           ON CONFLICT (contract_id, party) DO NOTHING`,
          [newId(), tenantId, contractId, party, signerId, (s.signerName ?? "").slice(0, 200) || null,
           s.signerTitle ? s.signerTitle.slice(0, 200) : null, k.contentSha256, account.name, envelopeId, s.signedAt, config.originSite],
        );
        if (ins.rowCount) {
          have.add(party);
          newSigs.push({ party, signerId, signedAt: s.signedAt as string });
        }
      }

      let completedNow = false;
      let copyFileId: string | null = null;
      let certificateFileId: string | null = null;
      if (stored && have.has("client") && have.has("provider")) {
        const live = (await c.query<{ id: string; role: string }>(
          `SELECT id, role FROM files WHERE target_entity_type = 'contract' AND target_entity_id = $1
              AND role IN ('contract_certified_copy', 'contract_certified_certificate') AND deleted_at IS NULL`,
          [contractId],
        )).rows;
        copyFileId = live.find((f) => f.role === "contract_certified_copy")?.id ?? null;
        certificateFileId = live.find((f) => f.role === "contract_certified_certificate")?.id ?? null;
        const base = `contract-${SAFE_NAME(k.reference ?? k.id)}-v${k.version}-certified${account.simulated ? "-SIMULATED" : ""}`;
        if (!copyFileId) {
          await c.query(
            `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type,
                                byte_size, storage_key, sha256, scrubbed, origin_site, role)
             VALUES ($1, $2, NULL, 'contract', $3, $4, 'application/pdf', $5, $6, $7, false, $8, 'contract_certified_copy')`,
            [stored.copy.fileId, tenantId, contractId, `${base}.pdf`, stored.copy.size, stored.copy.storageKey, stored.copy.sha256, config.originSite],
          );
          copyFileId = stored.copy.fileId;
          usedStored = true;
        }
        if (!certificateFileId) {
          await c.query(
            `INSERT INTO files (id, tenant_id, uploader_id, target_entity_type, target_entity_id, filename, content_type,
                                byte_size, storage_key, sha256, scrubbed, origin_site, role)
             VALUES ($1, $2, NULL, 'contract', $3, $4, 'application/x-pem-file', $5, $6, $7, false, $8, 'contract_certified_certificate')`,
            [stored.cert.fileId, tenantId, contractId, `${base}-certificate.pem`, stored.cert.size, stored.cert.storageKey, stored.cert.sha256, config.originSite],
          );
          certificateFileId = stored.cert.fileId;
          usedStored = true;
        }
        const flip = await c.query(
          `UPDATE contracts SET status = 'signed', signed_at = now(), updated_at = now() WHERE id = $1 AND status = 'sent'`, [contractId],
        );
        completedNow = (flip.rowCount ?? 0) > 0;
        if (completedNow) {
          await emitEvent(c, tenantId, "contract", contractId, "contract.signed", {
            clientId: k.clientId, parties: [...have], via: "certified_provider", provider: account.name, simulated: account.simulated,
          });
        }
      } else {
        for (const s of newSigs) {
          await emitEvent(c, tenantId, "contract", contractId, s.party === "client" ? "contract.client_signed" : "contract.provider_signed", {
            clientId: k.clientId, parties: [...have], via: "certified_provider", provider: account.name, simulated: account.simulated,
          });
        }
      }
      return { newSigs, completedNow, copyFileId, certificateFileId };
    });
  } catch (e) {
    if (stored) {
      await storage().del(stored.copy.storageKey).catch(() => undefined);
      await storage().del(stored.cert.storageKey).catch(() => undefined);
    }
    // A concurrent sync stored the copy first: this run stored nothing and the next one finds it.
    if (e instanceof DatabaseError && e.code === "23505" && e.constraint === "ux_files_live_role") {
      return { status: "retry", reason: "another run stored the certified copy at the same moment" };
    }
    throw e;
  }
  if (stored && !usedStored) {
    await storage().del(stored.copy.storageKey).catch(() => undefined);
    await storage().del(stored.cert.storageKey).catch(() => undefined);
  }

  // 4. After commit: the audit and the people who need to know.
  for (const s of applied.newSigs) {
    await writeActivity(tenantId, s.signerId, "certified_signed", "contract", contractId, {
      party: s.party, provider: account.name, simulated: account.simulated, envelopeId, signedAt: s.signedAt,
    });
  }
  if (applied.completedNow && stored) {
    await writeActivity(tenantId, null, "certified_completed", "contract", contractId, {
      provider: account.name, simulated: account.simulated, envelopeId,
      certifiedCopyFileId: applied.copyFileId, certifiedCopySha256: stored.copy.sha256,
      certificateFileId: applied.certificateFileId, certificateSha256: stored.cert.sha256,
    });
  }
  await announce(account, tenantId, k, applied.newSigs.map((s) => s.party), applied.completedNow);

  if (applied.completedNow || (st.state === "completed" && applied.copyFileId && applied.certificateFileId)) {
    return {
      status: "completed",
      outcome: applied.completedNow ? "completed: the certified copy and its certificate are stored and the contract is signed" : "already completed",
      newSignatures: applied.newSigs.length,
      copyFileId: applied.copyFileId as string,
      certificateFileId: applied.certificateFileId as string,
    };
  }
  return {
    status: "pending",
    outcome: applied.newSigs.length ? `recorded ${applied.newSigs.map((s) => s.party).join(" and ")} signature` : "nothing new at the provider",
    newSignatures: applied.newSigs.length,
  };
}

/** Best-effort notices: our side when the client signed at the provider, the client when the agreement is complete. */
async function announce(account: SignatureProviderAccount, tenantId: string, k: SyncContract, newParties: string[], completed: boolean): Promise<void> {
  try {
    const label = account.label;
    if (newParties.includes("client") && !completed) {
      const owners = await withTenants([tenantId], (c) =>
        c.query<{ owner_id: string }>(
          `SELECT DISTINCT owner_id FROM projects WHERE client_id = $1 AND owner_id IS NOT NULL AND deleted_at IS NULL`, [k.clientId],
        ),
      );
      await notifyBestEffort(tenantId, null, owners.rows.map((r) => r.owner_id), "contract.client_signed", {
        title: `Client signed ${k.title} at ${label}: countersign there`,
        href: `/clients/${k.clientId}/billing`,
        entityType: "contract",
        entityId: k.id,
        severity: "warning",
      });
    }
    if (completed) {
      const recipients = await withTenants([tenantId], (c) => resolveClientRecipients(c, { clientId: k.clientId, projectId: k.projectId, kind: "general" }));
      await notifyBestEffort(tenantId, null, recipients, "contract.signed", {
        title: `Agreement fully signed${account.simulated ? " (simulated certified signature)" : ""}: ${k.title}`,
        href: `/portal/contracts/${k.id}`,
        entityType: "contract",
        entityId: k.id,
        severity: "info",
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[signatures] notices for contract ${k.id} failed:`, (err as Error)?.message ?? err);
  }
}
