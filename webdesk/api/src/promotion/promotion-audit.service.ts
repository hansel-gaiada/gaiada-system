// WSK-25 — a tenant-scoped audit-row writer, same GUC-context pattern as
// ../control/command-audit.service.ts, deliberately NOT that class reused directly: its
// `command: CommandName` parameter is the closed union from ../control/command-types.ts, and this
// ticket's own scope note says to stay out of that shared file (a small, self-contained
// duplication here is cheaper than widening a registry another concurrent session may also be
// touching). Writes to the SAME `audit_entries` table (../audit/audit.service.ts, unmodified) —
// `control.content.*` action rows sit alongside every other command's `control.*` row, filterable
// the same way.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AuditService, type AuditArgs } from "../audit/audit.service";

@Injectable()
export class PromotionAuditService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async record(opts: {
    tenantId: string;
    command: "content.export" | "content.promote" | "content.rollback";
    actor: string;
    args: AuditArgs;
    ws4ApprovalId?: string | null;
    replayed?: boolean;
  }): Promise<void> {
    await this.db.withTenant(opts.tenantId, (db) =>
      db.transaction((client) =>
        this.audit.record(client, {
          tenantId: opts.tenantId,
          actor: opts.actor,
          action: opts.replayed ? `control.${opts.command}.replay` : `control.${opts.command}`,
          args: opts.args,
          ws4ApprovalId: opts.ws4ApprovalId ?? null,
        }),
      ),
    );
  }
}
