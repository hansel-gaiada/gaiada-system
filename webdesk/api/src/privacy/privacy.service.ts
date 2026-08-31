// WSK-38 — the three DSR commands' orchestration. Every method: resolve the tenant (reusing
// TenantLookupService verbatim, same pattern KeysCommandService/LifecycleService already use),
// normalize+hash the identifier (identifier.ts), do the tenant-scoped work under `db.withTenant`,
// write a `dsr_requests` row (the DSR-specific ledger — migrations/0007_privacy_dsr.sql), and THEN
// (separately, same convention KeysCommandService already established) write the generic
// `control.privacy.<x>` audit_entries row via the reused CommandAuditService. Every audit/ledger
// write below carries `subjectRefHash` only — NEVER the raw identifier — see identifier.ts's
// header for why: a durable row proving a DSR action happened must not itself become a second,
// un-erasable copy of the very PII a subsequent erase is supposed to remove.
//
// find/export are DELIBERATELY NOT run through IdempotencyStore: every lookup or export of a real
// person's data is itself a distinct, auditable access — collapsing a second identical call into
// "the same command, no new effect" would silently UNDER-count how many times this tenant's ops
// staff looked at that person's data, which is the opposite of what a DSR audit trail is for. Only
// `erase` is idempotency-wrapped, matching WSK-21's "every command double-fired must produce one
// effect" doctrine for a genuinely destructive command.
import { Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { CommandAuditService } from "../control/command-audit.service";
import { AuditService } from "../audit/audit.service";
import { IdempotencyStore } from "../control/idempotency/idempotency-store";
import type { CommandName } from "../control/command-types";
import { PrivacyRepository, type MatchedSubmissionRow, type MediaAssetLookupRow } from "./privacy.repository";
import { PrivacyAttachmentsService, type ExportedAttachment } from "./privacy-attachments.service";
import { normalizeIdentifier, hashIdentifier } from "./identifier";
import type { PrivacyCommandName } from "./command-types";
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
};

export type ExportedSubmission = {
  submissionId: string;
  formDefId: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  consent: { text: string; version: string; acceptedAt: string };
  fields: Record<string, unknown>;
  attachments: ExportedAttachment[];
};

export type ExportResult = {
  tenantSlug: string;
  identifier: string;
  generatedAt: string;
  dsrRequestId: string;
  submissions: ExportedSubmission[];
};

export type EraseResult = {
  tenantSlug: string;
  identifier: string;
  erasedAt: string;
  dsrRequestId: string | null;
  submissionCount: number;
  attachmentCount: number;
  replayed: boolean;
};

function attachmentRefs(row: MatchedSubmissionRow): SubmissionAttachmentRef[] {
  return Array.isArray(row.payload?.attachments) ? row.payload.attachments : [];
}

/**
 * `CommandAuditService.recordTenant`/`recordPlatform` are typed against
 * `control/command-types.ts`'s own `CommandName` union (built to name only the C-05 command set).
 * The cast below is the one place this module reaches for a control-plane name that isn't in that
 * union — safe because `CommandAuditService` only ever interpolates `opts.command` into a string
 * (`control.${opts.command}`), never branches on it structurally. See
 * policy/privacy-command-authorization.guard.ts's header for the sibling cast and the same
 * reasoning.
 */
function asControlCommandName(name: PrivacyCommandName): CommandName {
  return name as unknown as CommandName;
}

@Injectable()
export class PrivacyCommandService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly repo: PrivacyRepository,
    private readonly attachments: PrivacyAttachmentsService,
    private readonly commandAudit: CommandAuditService,
    private readonly auditHash: AuditService,
    private readonly idempotency: IdempotencyStore,
  ) {}

  private async resolveActiveTenant(slug: string) {
    const tenant = await this.tenants.bySlug(slug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    return tenant;
  }

  async find(input: { tenantSlug: string; identifier: string; actor: string; ws4ApprovalId: string | null }): Promise<FindResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const normalized = normalizeIdentifier(input.identifier);
    const subjectRefHash = hashIdentifier(normalized);

    const { matches, dsrRequestId } = await this.db.withTenant(tenant.id, (db) =>
      db.transaction(async (client) => {
        const rows = await this.repo.findByIdentifier(client, tenant.id, normalized);
        const matches: FindMatch[] = rows.map((r) => ({
          submissionId: r.id,
          formDefId: r.form_def_id,
          status: r.status,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          attachmentCount: attachmentRefs(r).length,
        }));
        const totalAttachments = matches.reduce((sum, m) => sum + m.attachmentCount, 0);
        const dsr = await this.repo.insertDsrRequest(client, {
          tenantId: tenant.id,
          kind: "find",
          subjectRefHash,
          requestedBy: input.actor,
          ws4ApprovalId: input.ws4ApprovalId,
          submissionCount: rows.length,
          attachmentCount: totalAttachments,
        });
        return { matches, dsrRequestId: dsr.id };
      }),
    );

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: asControlCommandName("privacy.find"),
      actor: input.actor,
      args: { subjectRefHash, matchCount: matches.length },
      ws4ApprovalId: input.ws4ApprovalId,
    });

    return { tenantSlug: input.tenantSlug, identifier: input.identifier, generatedAt: new Date().toISOString(), dsrRequestId, matches };
  }

  async export(input: { tenantSlug: string; identifier: string; actor: string; ws4ApprovalId: string | null }): Promise<ExportResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const normalized = normalizeIdentifier(input.identifier);
    const subjectRefHash = hashIdentifier(normalized);

    // Step 1 — match + record the DSR request, one transaction (same shape as find()).
    const { rows, dsrRequestId } = await this.db.withTenant(tenant.id, (db) =>
      db.transaction(async (client) => {
        const rows = await this.repo.findByIdentifier(client, tenant.id, normalized);
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
        return { rows, dsrRequestId: dsr.id };
      }),
    );

    // Step 2 — fetch attachment bytes. Storage I/O has no place inside a DB transaction, so this
    // runs as its own tenant-scoped unit, after the transaction above has already committed.
    const submissions: ExportedSubmission[] = [];
    for (const row of rows) {
      const refs = attachmentRefs(row);
      const assetRows = await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) => this.repo.findMediaAssetsByIds(client, tenant.id, refs.map((r) => r.mediaAssetId))),
      );
      const byId = new Map<string, MediaAssetLookupRow>(assetRows.map((a) => [a.id, a]));
      const exportedAttachments: ExportedAttachment[] = [];
      for (const ref of refs) {
        const assetRow = byId.get(ref.mediaAssetId);
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
        attachments: exportedAttachments,
      });
    }

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: asControlCommandName("privacy.export"),
      actor: input.actor,
      args: { subjectRefHash, submissionCount: rows.length },
      ws4ApprovalId: input.ws4ApprovalId,
    });

    return { tenantSlug: input.tenantSlug, identifier: input.identifier, generatedAt: new Date().toISOString(), dsrRequestId, submissions };
  }

  async erase(input: {
    tenantSlug: string;
    identifier: string;
    actor: string;
    idempotencyKey: string;
    ws4ApprovalId: string | null;
  }): Promise<EraseResult> {
    const tenant = await this.resolveActiveTenant(input.tenantSlug);
    const normalized = normalizeIdentifier(input.identifier);
    const subjectRefHash = hashIdentifier(normalized);
    const args = { tenantSlug: input.tenantSlug, subjectRefHash };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:privacy.erase:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, () => this.performErase(tenant.id, normalized, subjectRefHash, input));

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command: asControlCommandName("privacy.erase"),
      actor: input.actor,
      args: { subjectRefHash, submissionCount: result.submissionCount, attachmentCount: result.attachmentCount },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, tenantSlug: input.tenantSlug, identifier: input.identifier, replayed };
  }

  /**
   * The actual erasure. Ordering is deliberate (see privacy-attachments.service.ts's header for
   * the full reasoning): match -> delete every storage object FIRST, one by one, aborting BEFORE
   * any DB row is touched if even one delete fails -> only then scrub `submissions` + remove
   * `media_assets` rows + record `dsr_requests`, atomically in one transaction. A caller who
   * retries after an abort re-runs `find` implicitly (nothing was scrubbed yet) — safe, since nulling
   * happens only in the final transaction.
   */
  private async performErase(
    tenantId: string,
    normalizedIdentifier: string,
    subjectRefHash: string,
    input: { tenantSlug: string; actor: string; ws4ApprovalId: string | null },
  ): Promise<Omit<EraseResult, "tenantSlug" | "identifier" | "replayed">> {
    const rows = await this.db.withTenant(tenantId, (db) => db.transaction((client) => this.repo.findByIdentifier(client, tenantId, normalizedIdentifier)));

    if (rows.length === 0) {
      // Nothing left to erase (already erased, already purged with a cleared ref, or never
      // existed) — a successful no-op, not an error; see this file's header on domain-level
      // idempotency.
      const dsr = await this.db.withTenant(tenantId, (db) =>
        db.transaction((client) =>
          this.repo.insertDsrRequest(client, {
            tenantId,
            kind: "erase",
            subjectRefHash,
            requestedBy: input.actor,
            ws4ApprovalId: input.ws4ApprovalId,
            submissionCount: 0,
            attachmentCount: 0,
          }),
        ),
      );
      return { erasedAt: new Date().toISOString(), dsrRequestId: dsr.id, submissionCount: 0, attachmentCount: 0 };
    }

    const submissionIds = rows.map((r) => r.id);
    const attachmentAssetIds = rows.flatMap((r) => attachmentRefs(r).map((a) => a.mediaAssetId));

    if (attachmentAssetIds.length > 0) {
      const assetRows = await this.db.withTenant(tenantId, (db) => db.transaction((client) => this.repo.findMediaAssetsByIds(client, tenantId, attachmentAssetIds)));
      for (const assetRow of assetRows) {
        try {
          await this.attachments.deleteForErase(assetRow);
        } catch (err) {
          // Abort BEFORE touching any DB row — see this method's header. The caller can retry the
          // whole erase once the storage-layer problem is resolved; nothing has been scrubbed.
          throw new ServiceUnavailableException(
            `erase refused: could not delete attachment object for media asset ${assetRow.id}: ${String(err)}`,
          );
        }
      }
    }

    const dsrRequestId = await this.db.withTenant(tenantId, (db) =>
      db.transaction(async (client) => {
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
        return dsr.id;
      }),
    );

    return {
      erasedAt: new Date().toISOString(),
      dsrRequestId,
      submissionCount: submissionIds.length,
      attachmentCount: attachmentAssetIds.length,
    };
  }
}
