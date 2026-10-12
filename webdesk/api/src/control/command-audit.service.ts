// WSK-21 — "immutable audit row for every command" (ticket AC), built entirely on WSK-05's
// AuditService (audit_entries: actor, action, args_hash, ws4_approval_id — §04/§11). This file
// only adds the GUC-context plumbing + a consistent `control.<command>[.replay]` action naming;
// it does not reimplement hashing or the insert itself (AuditService.hashArgs/record do that).
//
// M3 T5a: the lifecycle, schema.apply, keys and release commands NO LONGER audit through this
// class. They run in the shared command envelope (command-envelope.ts), which writes the same
// `control.<command>` / `control.<command>.replay` rows itself, as the first statement of the
// command's own transaction (so a HIGH command claims its WS4 approval before its effect). M3 T5b
// moved the promotion (content.promote / content.rollback) and privacy (find / export / erase)
// commands onto the envelope too. site.archive (0019) is on the envelope as well. What still audits
// through this class: schema.propose and contract.read (reads). Other services still inject it but no longer call it.
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
