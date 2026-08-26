// WSK-21 — the "release" quarter of the C-05 command set: deploy/promote/rollback/triggerRebuild
// as TRACKED, QUERYABLE JOBS (ticket AC), never blocking calls. Every command returns a jobId
// immediately; the actual work (ReleaseTransportAdapter.execute — unimplemented behind an
// interface per the ticket brief, see ../release/release-transport.ts) runs in the background
// and the caller polls `GET .../jobs/:jobId` (jobs/jobs.controller.ts).
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { IdempotencyStore } from "../idempotency/idempotency-store";
import { JobsService } from "../jobs/jobs.service";
import { COMMAND_REGISTRY, type CommandName } from "../command-types";
import { RELEASE_TRANSPORT, type ReleaseTransportAdapter, type ReleaseTransportKind } from "../release/release-transport";

interface ReleaseCommandInput {
  tenantSlug: string;
  envId: string;
  version?: string;
  actor: string;
  idempotencyKey: string;
  ws4ApprovalId: string | null;
}

@Injectable()
export class ReleasesCommandService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly commandAudit: CommandAuditService,
    private readonly idempotency: IdempotencyStore,
    private readonly auditHash: AuditService,
    private readonly jobs: JobsService,
    @Inject(RELEASE_TRANSPORT) private readonly transport: ReleaseTransportAdapter,
  ) {}

  private async resolveEnv(tenantSlug: string, envId: string) {
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    const env = await this.db.withTenant(tenant.id, async (db) => {
      const { rows } = await db.query<{ id: string; site_id: string; name: string }>(
        `SELECT id, site_id, name FROM environments WHERE id = $1 AND tenant_id = $2`,
        [envId, tenant.id],
      );
      return rows[0] ?? null;
    });
    if (!env) throw new NotFoundException("environment not found for this tenant");
    return { tenant, env };
  }

  private async dispatch(command: CommandName, kind: ReleaseTransportKind, input: ReleaseCommandInput) {
    const { tenant, env } = await this.resolveEnv(input.tenantSlug, input.envId);
    const meta = COMMAND_REGISTRY[command];

    const args = { tenantSlug: input.tenantSlug, envId: input.envId, version: input.version ?? null, command };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:${command}:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      const job = this.jobs.create({ tenantSlug: input.tenantSlug, command, impactClass: meta.impactClass });

      // Fire-and-forget: the command returns the job immediately (ticket AC: "not blocking
      // calls"). Any failure is captured INSIDE jobs.run — this can never become an unhandled
      // rejection reaching the process.
      void this.jobs.run(job.id, async () => {
        const outcome = await this.transport.execute({
          kind,
          command,
          tenantSlug: input.tenantSlug,
          envId: input.envId,
          version: input.version,
          args: { siteId: env.site_id, envName: env.name },
        });

        // Only the kinds the frozen `releases.kind` CHECK constraint actually admits get a
        // durable row (0001_platform_core.sql: CHECK (kind IN ('deploy','promote','rollback'))) —
        // 'rebuild' has no domain row to write; its effect is the transport call + this job +
        // the audit trail only, which is honest given it has no release/version semantics of its
        // own (design §12: "triggerRebuild" is listed alongside deploy/promote/rollback but the
        // schema was never given a fourth `releases.kind` value for it).
        if ((kind === "deploy" || kind === "promote" || kind === "rollback") && input.version) {
          await this.db.withTenant(tenant.id, (db) =>
            db.transaction((client) =>
              client.query(
                `INSERT INTO releases (env_id, tenant_id, version, kind, snapshot_ref, created_by)
                 VALUES ($1, $2, $3, $4, $5::jsonb, $6)
                 ON CONFLICT (env_id, version) DO NOTHING`,
                [input.envId, tenant.id, input.version, kind, JSON.stringify({ transport: outcome.detail }), input.actor],
              ),
            ),
          );
        }

        return outcome;
      });

      return { jobId: job.id };
    });

    await this.commandAudit.recordTenant({
      tenantId: tenant.id,
      command,
      actor: input.actor,
      args: { ...args, jobId: result.jobId },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { jobId: result.jobId, replayed };
  }

  deploy(input: ReleaseCommandInput) {
    return this.dispatch("release.deploy", "deploy", input);
  }

  promote(input: ReleaseCommandInput) {
    return this.dispatch("release.promote", "promote", input);
  }

  rollback(input: ReleaseCommandInput) {
    return this.dispatch("release.rollback", "rollback", input);
  }

  triggerRebuild(input: ReleaseCommandInput) {
    return this.dispatch("release.triggerRebuild", "rebuild", input);
  }
}
