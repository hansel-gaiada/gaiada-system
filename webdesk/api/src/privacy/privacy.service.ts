// WSK-38 — the three DSR commands' orchestration. Every method: resolve the tenant (reusing
// TenantLookupService verbatim, same pattern KeysCommandService/LifecycleService already use),
// normalize+hash the identifier (identifier.ts), do the tenant-scoped work under `db.withTenant`,
// write a `dsr_requests` row (the DSR-specific ledger — migrations/0007_privacy_dsr.sql), and the
// generic `control.privacy.<x>` audit_entries row. Every audit/ledger write below carries
// `subjectRefHash` only — NEVER the raw identifier — see identifier.ts's header for why: a durable row
// proving a DSR action happened must not itself become a second, un-erasable copy of the very PII a
// subsequent erase is supposed to remove.
//
// ============================================================================================
// M3 T5b — ALL THREE COMMANDS CLAIM THEIR WS4 APPROVAL FIRST (WSK-41 command envelope)
// ============================================================================================
// find, export and erase are HIGH. Each runs in CommandEnvelope: ONE transaction whose FIRST statement
// is the audit row `control.privacy.<x>` carrying the ws4_approval_id (that insert claims the approval,
// 0009 §3 ux_audit_entries_ws4_once), then the command's own reads and writes on THE SAME CLIENT, then
// the idempotency record. A reused approval therefore fails at the first statement (403
// ws4-approval-already-used) with no personal data read, no storage touched, nothing written. Before
// T5b find and export read first and audited after (a reused approval had already been served), and
// erase deduped in process memory only.
//
// Pre-envelope refusals (unknown or inactive tenant, a bad identifier, a bad or missing key, no WS4
// approval) happen before the envelope: no audit row, no idempotency row, the approval is not consumed.
//
// WHAT EACH COMMAND STORES in control_idempotency_keys (7 days), and why:
//   find    {dsrRequestId, matchCount, secretWithheld}. The response lists an identified person's
//           submissions (ids, forms, timestamps) and echoes the identifier: personal data, and a trace
//           that would outlive the erase the person may ask for. Withheld: a replay is 409
//           idempotency-response-withheld.
//   export  {dsrRequestId, submissionCount, secretWithheld}. The response IS the personal data (field
//           values, consent, attachment bytes). Withheld, same replay. The personal data never enters
//           the envelope at all: the effect hands back only the ledger reference, and the response is
//           built from what the effect read, after the commit (the attachment bytes come from storage,
//           which has no place inside a database transaction).
//   erase   the whole summary {erasedAt, dsrRequestId, submissionCount, attachmentCount}: counts and a
//           ledger id, no identifier and nothing erased. A replay returns it, `replayed: true`.
// find and export keep their old non-idempotent character: with no Idempotency-Key header each call
// gets a fresh server-side key, so every call is still a distinct, audited access (see the note that
// used to sit here: collapsing two lookups into one would under-count how often a person's data was
// looked at). A caller who DOES send a key gets 409 withheld on the second call, never a second read.
//
// THE AUDIT ROW'S ARGS are the request only ({subjectRefHash}); the result counts the old after-the-
// fact row carried (submission/attachment counts) are not known before the effect runs, and they are in
// the dsr_requests row written in the same transaction.
//
// ERASE KEEPS ITS ORDER inside the one transaction: match -> delete every storage object FIRST, one by
// one, aborting BEFORE any DB row is touched if even one delete fails -> only then scrub `submissions`,
// remove `media_assets` rows and record `dsr_requests`. An abort rolls the claim back with it (the
// approval is NOT consumed by an erase that did not happen, and a retry with it works). Storage deletes
// are not transactional: objects deleted before a later database failure stay deleted while their rows
// stay, which is the same exposure the old ordering had, and a retry deletes the rest.
import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { DbService } from "../db/db.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { AuditService } from "../audit/audit.service";
import { CommandEnvelope, type EnvelopeInput } from "../control/command-envelope";
import type { CommandName } from "../control/command-types";
import { PrivacyRepository, type ConsentRecordRow, type MatchedSubmissionRow, type MediaAssetLookupRow } from "./privacy.repository";
import { PrivacyAttachmentsService, type ExportedAttachment } from "./privacy-attachments.service";
import { resolveSubject, hashIdentifier } from "./identifier";
import { PRIVACY_COMMAND_REGISTRY, type PrivacyCommandName } from "./command-types";
import type { SubmissionAttachmentRef } from "../forms/dto";

export type FindMatch = {
  submissionId: string;
  formDefId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  attachmentCount: number;
};

export type FindResult = {
  tenantSlug: string;
  identifier: string;
  generatedAt: string;
  dsrRequestId: string;
  matches: FindMatch[];
  /** M5-G6 (additive): present only when the identifier is a consent id (uuid): how many consent_records it has. */
  consentRecordCount?: number;
};

export type ExportedSubmission = {
  submissionId: string;
  formDefId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  consent: { text: string; version: string; acceptedAt: string };
  fields: Record<string, unknown>;
  /** M5-L2 (additive): where the visitor came from, as stored; null when none was supplied (or already purged). */
  attribution: Record<string, unknown> | null;
  /** M5-L2 (additive): the visitor's banner choice at submit time; null = unknown = no consent. */
  visitorConsent: Record<string, unknown> | null;
  attachments: ExportedAttachment[];
};

export type ExportedConsentRecord = {
  consentId: string;
  siteId: string;
  action: string;
  analytics: boolean;
  marketing: boolean;
  noticeVersion: string;
  recordedAt: string;
  userAgentClass: string;
};

function exportedConsent(r: ConsentRecordRow): ExportedConsentRecord {
  return {
    consentId: r.consent_id,
    siteId: r.site_id,
    action: r.action,
    analytics: r.analytics,
    marketing: r.marketing,
    noticeVersion: r.notice_version,
    recordedAt: r.recorded_at,
    userAgentClass: r.user_agent_class,
  };
}

export type ExportResult = {
  tenantSlug: string;
  identifier: string;
  generatedAt: string;
  dsrRequestId: string;
  submissions: ExportedSubmission[];
  /** M5-G6 (additive): present only when the identifier is a consent id (uuid): its whole decision history, oldest first. */
  consentRecords?: ExportedConsentRecord[];
};

export type EraseResult = {
  tenantSlug: string;
  identifier: string;
  erasedAt: string;
  dsrRequestId: string | null;
  submissionCount: number;
  attachmentCount: number;
  /** M5-G6 (additive): present only when the identifier is a consent id (uuid): how many consent_records were deleted. */
  consentRecordCount?: number;
  replayed: boolean;
};

/** What erase hands the envelope, and what is stored: counts and a ledger id, nothing personal. */
type EraseSummary = Omit<EraseResult, "tenantSlug" | "identifier" | "replayed">;

function attachmentRefs(row: MatchedSubmissionRow): SubmissionAttachmentRef[] {
  return Array.isArray(row.payload?.attachments) ? row.payload.attachments : [];
}

/**
 * The envelope is typed against `control/command-types.ts`'s own `CommandName` union (the C-05 command
 * set); the three privacy commands live in this module's shadow registry (command-types.ts here). The
 * cast below is the one place this module reaches for a control-plane name that isn't in that union —
 * safe because the envelope only interpolates the name into a string (`control.${command}`) and into
 * the idempotency row's `command` column, and takes the impact class from `impactClass`, which this
 * file always passes from the shadow registry. See policy/privacy-command-authorization.guard.ts's
 * header for the sibling cast and the same reasoning.
 */
function asControlCommandName(name: PrivacyCommandName): CommandName {
  return name as unknown as CommandName;
}

const WITHHELD_DETAIL =
  "This command's response is personal data, which is never stored. Nothing was changed and nothing was read again. Run the command again under a new approval.";

@Injectable()
export class PrivacyCommandService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly repo: PrivacyRepository,
    private readonly attachments: PrivacyAttachmentsService,
    private readonly auditHash: AuditService,
    private readonly envelope: CommandEnvelope,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    return tenant;
  }

  /** The envelope fields every privacy command shares. */
  private claim(
    command: PrivacyCommandName,
    input: { tenantSlug: string; actor: string; ws4ApprovalId: string | null; idempotencyKey?: string },
    tenantId: string,
    subjectRefHash: string,
  ): Pick<EnvelopeInput<object>, "command" | "impactClass" | "scope" | "scopeKey" | "requestHash" | "actor" | "auditArgs" | "ws4ApprovalId"> {
    return {
      command: asControlCommandName(command),
      impactClass: PRIVACY_COMMAND_REGISTRY[command].impactClass,
      scope: { kind: "tenant", tenantId },
      // find and export default to a fresh key per call: each call is its own audited access.
      scopeKey: `${input.tenantSlug}:${command}:${input.idempotencyKey ?? randomUUID()}`,
      requestHash: this.auditHash.hashArgs({ tenantSlug: input.tenantSlug, subjectRefHash }),
      actor: input.actor,
      auditArgs: { subjectRefHash },
      ws4ApprovalId: input.ws4ApprovalId,
    };
  }

  async find(input: {
    tenantSlug: string;
    identifier: string;
    actor: string;
    ws4ApprovalId: string | null;
    idempotencyKey?: string;
  }): Promise<FindResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const subject = resolveSubject(input.identifier);
    const normalized = subject.normalized;
    const subjectRefHash = hashIdentifier(subject.hashBasis);

    const out = await this.envelope.run<FindResult>({
      ...this.claim("privacy.find", input, tenant.id, subjectRefHash),
      effect: async (client) => {
        const rows = await this.repo.findByIdentifier(client, tenant.id, normalized, subject.phoneRef);
        const matches: FindMatch[] = rows.map((r) => ({
          submissionId: r.id,
          formDefId: r.form_def_id,
          status: r.status,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          attachmentCount: attachmentRefs(r).length,
        }));
        const totalAttachments = matches.reduce((sum, m) => sum + m.attachmentCount, 0);
        const consentRecordCount = subject.consentId ? (await this.repo.findConsentRecords(client, tenant.id, subject.consentId)).length : undefined;
        const dsr = await this.repo.insertDsrRequest(client, {
          tenantId: tenant.id,
          kind: "find",
          subjectRefHash,
          requestedBy: input.actor,
          ws4ApprovalId: input.ws4ApprovalId,
          submissionCount: rows.length,
          attachmentCount: totalAttachments,
        });
        return {
          result: {
            tenantSlug: input.tenantSlug,
            identifier: input.identifier,
            generatedAt: new Date().toISOString(),
            dsrRequestId: dsr.id,
            matches,
            ...(consentRecordCount !== undefined ? { consentRecordCount } : {}),
          },
        };
      },
      // Only the ledger reference is stored; see the header.
      withhold: (r) => ({ stored: { dsrRequestId: r.dsrRequestId, matchCount: r.matches.length } }),
      withheldDetail: WITHHELD_DETAIL,
    });
    // find has never carried `replayed` (a replay is refused as withheld, so this is always a fresh run).
    const { replayed: _replayed, ...body } = out;
    return body;
  }

  async export(input: {
    tenantSlug: string;
    identifier: string;
    actor: string;
    ws4ApprovalId: string | null;
    idempotencyKey?: string;
  }): Promise<ExportResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const subject = resolveSubject(input.identifier);
    const normalized = subject.normalized;
    const subjectRefHash = hashIdentifier(subject.hashBasis);

    // The personal data stays in this closure: the envelope only ever sees the ledger reference.
    let plan: { rows: MatchedSubmissionRow[]; assetsById: Map<string, MediaAssetLookupRow>; dsrRequestId: string; consent?: ConsentRecordRow[] } | undefined;

    await this.envelope.run<{ dsrRequestId: string; submissionCount: number }>({
      ...this.claim("privacy.export", input, tenant.id, subjectRefHash),
      effect: async (client) => {
        const rows = await this.repo.findByIdentifier(client, tenant.id, normalized, subject.phoneRef);
        const totalAttachments = rows.reduce((sum, r) => sum + attachmentRefs(r).length, 0);
        const dsr = await this.repo.insertDsrRequest(client, {
          tenantId: tenant.id,
          kind: "export",
          subjectRefHash,
          requestedBy: input.actor,
          ws4ApprovalId: input.ws4ApprovalId,
          submissionCount: rows.length,
          attachmentCount: totalAttachments,
        });
        // Attachment METADATA is a database read, so it happens here on the claim's client. The bytes
        // come from storage after the commit (below): storage I/O has no place inside a transaction.
        const assetIds = rows.flatMap((r) => attachmentRefs(r).map((a) => a.mediaAssetId));
        const assetRows = await this.repo.findMediaAssetsByIds(client, tenant.id, assetIds);
        const consent = subject.consentId ? await this.repo.findConsentRecords(client, tenant.id, subject.consentId) : undefined;
        plan = { rows, assetsById: new Map(assetRows.map((a) => [a.id, a])), dsrRequestId: dsr.id, consent };
        return { result: { dsrRequestId: dsr.id, submissionCount: rows.length } };
      },
      withhold: (r) => ({ stored: r }),
      withheldDetail: WITHHELD_DETAIL,
    });
    if (!plan) throw new Error("privacy.export: the envelope returned without running the effect"); // a replay is refused as withheld, so unreachable

    const submissions: ExportedSubmission[] = [];
    for (const row of plan.rows) {
      const exportedAttachments: ExportedAttachment[] = [];
      for (const ref of attachmentRefs(row)) {
        const assetRow = plan.assetsById.get(ref.mediaAssetId);
        if (!assetRow) {
          exportedAttachments.push({
            mediaAssetId: ref.mediaAssetId,
            mime: ref.mime,
            sizeBytes: ref.sizeBytes,
            contentBase64: null,
            unavailableReason: "media asset record no longer exists (already erased/deleted)",
          });
          continue;
        }
        exportedAttachments.push(await this.attachments.fetchForExport(assetRow));
      }
      submissions.push({
        submissionId: row.id,
        formDefId: row.form_def_id,
        status: row.status,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        consent: { text: row.consent_notice_text, version: row.consent_notice_version, acceptedAt: row.consent_accepted_at },
        fields: row.payload?.fields ?? {},
        attribution: row.attribution ?? null,
        visitorConsent: row.visitor_consent ?? null,
        attachments: exportedAttachments,
      });
    }

    return {
      tenantSlug: input.tenantSlug,
      identifier: input.identifier,
      generatedAt: new Date().toISOString(),
      dsrRequestId: plan.dsrRequestId,
      submissions,
      ...(plan.consent ? { consentRecords: plan.consent.map(exportedConsent) } : {}),
    };
  }

  async erase(input: {
    tenantSlug: string;
    identifier: string;
    actor: string;
    idempotencyKey: string;
    ws4ApprovalId: string | null;
  }): Promise<EraseResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const subject = resolveSubject(input.identifier);
    const normalized = subject.normalized;
    const subjectRefHash = hashIdentifier(subject.hashBasis);

    const { replayed, ...summary } = await this.envelope.run<EraseSummary>({
      ...this.claim("privacy.erase", input, tenant.id, subjectRefHash),
      effect: async (client) => ({ result: await this.performEraseInTx(client, tenant.id, normalized, subject.phoneRef, subject.consentId ?? null, subjectRefHash, input) }),
    });

    return { ...summary, tenantSlug: input.tenantSlug, identifier: input.identifier, replayed };
  }

  /**
   * The actual erasure, on the envelope's client (the claim's transaction). Ordering is deliberate
   * (see this file's header, and privacy-attachments.service.ts's for the full reasoning).
   */
  private async performEraseInTx(
    client: PoolClient,
    tenantId: string,
    normalizedIdentifier: string,
    phoneRef: string | null,
    consentId: string | null,
    subjectRefHash: string,
    input: { actor: string; ws4ApprovalId: string | null },
  ): Promise<EraseSummary> {
    const rows = await this.repo.findByIdentifier(client, tenantId, normalizedIdentifier, phoneRef);
    // M5-G6: a consent id also erases its consent_records (same transaction, so a later abort rolls it back too).
    const consentExtra = async (): Promise<{ consentRecordCount?: number }> =>
      consentId ? { consentRecordCount: await this.repo.deleteConsentRecords(client, tenantId, consentId) } : {};

    if (rows.length === 0) {
      // Nothing left to erase (already erased, already purged with a cleared ref, or never
      // existed) — a successful no-op, not an error; the ledger still records the request.
      const dsr = await this.repo.insertDsrRequest(client, {
        tenantId,
        kind: "erase",
        subjectRefHash,
        requestedBy: input.actor,
        ws4ApprovalId: input.ws4ApprovalId,
        submissionCount: 0,
        attachmentCount: 0,
      });
      return { erasedAt: new Date().toISOString(), dsrRequestId: dsr.id, submissionCount: 0, attachmentCount: 0, ...(await consentExtra()) };
    }

    const submissionIds = rows.map((r) => r.id);
    const attachmentAssetIds = rows.flatMap((r) => attachmentRefs(r).map((a) => a.mediaAssetId));

    if (attachmentAssetIds.length > 0) {
      const assetRows = await this.repo.findMediaAssetsByIds(client, tenantId, attachmentAssetIds);
      for (const assetRow of assetRows) {
        try {
          await this.attachments.deleteForErase(assetRow);
        } catch (err) {
          // Abort BEFORE touching any DB row. The throw rolls the claim back too: the approval is
          // not consumed, and the caller can retry the whole erase once storage is healthy.
          throw new ServiceUnavailableException(
            `erase refused: could not delete attachment object for media asset ${assetRow.id}: ${String(err)}`,
          );
        }
      }
    }

    const erasedCount = await this.repo.eraseSubmissions(client, tenantId, submissionIds);
    await this.repo.deleteMediaAssets(client, tenantId, attachmentAssetIds);
    const dsr = await this.repo.insertDsrRequest(client, {
      tenantId,
      kind: "erase",
      subjectRefHash,
      requestedBy: input.actor,
      ws4ApprovalId: input.ws4ApprovalId,
      submissionCount: erasedCount,
      attachmentCount: attachmentAssetIds.length,
    });

    return {
      erasedAt: new Date().toISOString(),
      dsrRequestId: dsr.id,
      submissionCount: submissionIds.length,
      attachmentCount: attachmentAssetIds.length,
      ...(await consentExtra()),
    };
  }
}
