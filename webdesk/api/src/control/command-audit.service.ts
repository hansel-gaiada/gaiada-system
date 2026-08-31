// WSK-21 — "immutable audit row for every command" (ticket AC), built entirely on WSK-05's
// AuditService (audit_entries: actor, action, args_hash, ws4_approval_id — §04/§11). This file
// only adds the GUC-context plumbing + a consistent `control.<command>[.replay]` action naming;
// it does not reimplement hashing or the insert itself (AuditService.hashArgs/record do that).
//
// Scope: audited here are the C-05 command set's actual commands (lifecycle/schema/keys/release)
// plus contract.read (explicitly named in the ticket's command list, §5). Deliberately NOT
// audited: job.get/job.list — those are read-only status polls of a job a real command already
// created and audited; a UI polling job status every few seconds would otherwise flood
// audit_entries with rows that carry no new information. See jobs/jobs.controller.ts's header.
import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { AuditService, type AuditArgs } from "../audit/audit.service";
import type { CommandName } from "./command-types";

interface RecordCommandOpts {
  command: CommandName;
  actor: string;
  args: AuditArgs;
  ws4ApprovalId?: string | null;
  /** True when this call was an idempotent replay (no new side effect occurred) — recorded via the action name, never silently merged into a fresh-execution row. */
  replayed?: boolean;
}

@Injectable()
export class CommandAuditService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  /** Tenant-scoped command audit row, written under `webdesk.tenant_ctx` for the given tenant. */
  async recordTenant(opts: RecordCommandOpts & { tenantId: string }): Promise<void> {
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

  /** Platform-level command audit row (tenant_id NULL) — tenant.provision/archive only, per 0001's own comment on the dual-mode `tenants`/`audit_entries` policies. */
  async recordPlatform(opts: RecordCommandOpts): Promise<void> {
    await this.db.withPlatformCtx((client) =>
      this.audit.record(client, {
        tenantId: null,
        actor: opts.actor,
        action: opts.replayed ? `control.${opts.command}.replay` : `control.${opts.command}`,
        args: opts.args,
        ws4ApprovalId: opts.ws4ApprovalId ?? null,
      }),
    );
  }
}
