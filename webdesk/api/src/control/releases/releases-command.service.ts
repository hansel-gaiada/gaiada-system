// WSK-21 — the "release" quarter of the C-05 command set: deploy/promote/rollback/triggerRebuild
// as TRACKED, QUERYABLE JOBS (ticket AC), never blocking calls. Every command returns a jobId
// immediately; the actual work (ReleaseTransportAdapter.execute — unimplemented behind an
// interface per the ticket brief, see ../release/release-transport.ts) runs in the background
// and the caller polls `GET .../jobs/:jobId` (jobs/jobs.controller.ts).
//
// M3 T5a — the shared command envelope (../command-envelope.ts). promote and rollback are HIGH, so
// their `control.release.*` audit row, which CLAIMS the WS4 approval, is the first statement of the
// envelope's transaction: two concurrent requests with one approval start ONE job, not two. The
// command itself has no database effect to run in that transaction. Its effect is the job, and the
// transport call behind it is not a database write, so both run in the `after` step:
//   after (post-commit, fail-soft): create the in-memory job record under the id already returned in
//   the response, then start it in the background (`void jobs.run`, which never throws).
//   If `after` itself throws (it cannot today: JobsService.create is a synchronous Map write), the
//   command stays committed and the response's jobId has no record, so GET .../jobs/:jobId is 404.
//   That is no worse than before: the job store is in-memory and a restart already loses every job.
// The `releases` row stays where it was, in the background job and AFTER transport.execute succeeds,
// in its own short transaction (ON CONFLICT DO NOTHING). Moving it into the envelope would record a
// promote/rollback that has not happened yet, and would write it even when the transport fails.
// The job id is generated before the transaction, because the audit row that names it is the first
// statement and the job record is created only after commit (a rolled-back command leaves no job).
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { DbService } from "../../db/db.service";
import { TenantLookupService } from "../../tenants/tenant-lookup.service";
import { AuditService } from "../../audit/audit.service";
import { CommandAuditService } from "../command-audit.service";
import { CommandEnvelope } from "../command-envelope";
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
    private readonly envelope: CommandEnvelope,
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
    const jobId = randomUUID();

    return this.envelope.run<{ jobId: string }>({
      command,
      scope: { kind: "tenant", tenantId: tenant.id },
      scopeKey: `${input.tenantSlug}:${command}:${input.idempotencyKey}`,
      requestHash: this.auditHash.hashArgs(args),
      actor: input.actor,
      auditArgs: { ...args, jobId },
      ws4ApprovalId: input.ws4ApprovalId,
      effect: async () => ({
        result: { jobId },
        after: async () => {
          this.jobs.create({ id: jobId, tenantSlug: input.tenantSlug, command, impactClass: meta.impactClass });

          // Fire-and-forget: the command returns the job immediately (ticket AC: "not blocking
          // calls"). Any failure is captured INSIDE jobs.run — this can never become an unhandled
          // rejection reaching the process.
          void this.jobs.run(jobId, async () => {
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
        },
      }),
    });
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
