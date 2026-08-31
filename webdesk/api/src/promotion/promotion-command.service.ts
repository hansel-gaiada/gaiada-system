// WSK-25 — the promotion engine itself: snapshot-first -> migrate -> content export/import -> FE
// deploy (behind the not-yet-available seam) -> purge/warm, and rollback = content restore.
//
// ============================================================================================
// THE ORDERING THAT MATTERS MOST (read before changing promote()):
// ============================================================================================
// Step 1 (snapshot) runs to completion — including its own COMMIT, inside
// PromotionSnapshotService.takeSnapshot — and this function `await`s that BEFORE step 2 (migrate
// +import) even builds its transaction. That is not a comment-level promise: it is two SEPARATE
// calls to `db.withTenant(...)`, each opening and closing its OWN connection/transaction, in
// sequence, with nothing overlapping them. If step 2 throws — a real Postgres constraint
// violation from a corrupt bundle, a dropped connection, anything — step 2's OWN transaction rolls
// back (leaving the target's content exactly as it was), and step 1's snapshot is already
// permanently on disk in a transaction that finished and closed before step 2 ever opened,
// unreachable by step 2's ROLLBACK. test/promotion-snapshot-first.spec.ts injects a real failure
// here (a bundle that violates content_items' own CHECK constraint) and queries the snapshot row
// back on a FRESH connection afterward to prove this, rather than merely asserting the happy path
// wrote one row.
// ============================================================================================
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { DbService } from "../db/db.service";
import { TenantLookupService } from "../tenants/tenant-lookup.service";
import { AuditService } from "../audit/audit.service";
import { IdempotencyStore } from "../control/idempotency/idempotency-store";
import { ContentBundleService } from "./content-bundle.service";
import { PromotionSnapshotService } from "./promotion-snapshot.service";
import { PromotionAuditService } from "./promotion-audit.service";
import { FRONTEND_DEPLOY_DRIVER, type FrontendDeployDriver } from "./frontend-deploy-driver";
import type { ContentBundle } from "./content-bundle.types";

interface ResolvedTarget {
  tenant: { id: string; slug: string };
  siteId: string;
  targetEnvId: string;
}

async function resolveSiteAndEnv(
  db: DbService,
  tenantId: string,
  siteId: string,
  envId: string,
): Promise<{ siteId: string; envId: string }> {
  return db.withTenant(tenantId, async (scoped) => {
    const site = await scoped.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2`, [siteId, tenantId]);
    if (!site.rows[0]) throw new NotFoundException("site not found for this tenant");
    const env = await scoped.query(`SELECT 1 FROM environments WHERE id = $1 AND site_id = $2 AND tenant_id = $3`, [envId, siteId, tenantId]);
    if (!env.rows[0]) throw new NotFoundException("environment not found for this site/tenant");
    return { siteId, envId };
  });
}

export interface PromoteInput {
  tenantSlug: string;
  siteId: string;
  targetEnvId: string;
  sourceEnvId?: string | null;
  version?: string;
  /** Caller-supplied export (e.g. from a prior content.export call against a DIFFERENT Zone B instance — see this ticket's report for why Zone B never fetches this itself). Omitted => self-export from this same instance's current content (first-launch/no-op-content case). */
  bundle?: ContentBundle;
  actor: string;
  idempotencyKey: string;
  ws4ApprovalId: string | null;
}

export interface RollbackInput {
  tenantSlug: string;
  siteId: string;
  targetEnvId: string;
  version?: string;
  actor: string;
  idempotencyKey: string;
  ws4ApprovalId: string | null;
}

export interface ExportInput {
  tenantSlug: string;
  siteId: string;
  actor: string;
}

@Injectable()
export class PromotionCommandService {
  constructor(
    private readonly db: DbService,
    private readonly tenants: TenantLookupService,
    private readonly auditHash: AuditService,
    private readonly idempotency: IdempotencyStore,
    private readonly bundles: ContentBundleService,
    private readonly snapshots: PromotionSnapshotService,
    private readonly promotionAudit: PromotionAuditService,
    @Inject(FRONTEND_DEPLOY_DRIVER) private readonly frontend: FrontendDeployDriver,
  ) {}

  private async resolveTarget(tenantSlug: string, siteId: string, targetEnvId: string): Promise<ResolvedTarget> {
    const tenant = await this.tenants.bySlug(tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    await resolveSiteAndEnv(this.db, tenant.id, siteId, targetEnvId);
    return { tenant, siteId, targetEnvId };
  }

  async exportContent(input: ExportInput) {
    const tenant = await this.tenants.bySlug(input.tenantSlug);
    if (!tenant || tenant.status !== "active") throw new NotFoundException("tenant not found");
    const bundle = await this.bundles.exportBundle(tenant.id, input.siteId);
    await this.promotionAudit.record({
      tenantId: tenant.id,
      command: "content.export",
      actor: input.actor,
      args: { tenantSlug: input.tenantSlug, siteId: input.siteId, itemCount: bundle.contentItems.length },
    });
    return { bundle };
  }

  async promote(input: PromoteInput) {
    const { tenant, siteId, targetEnvId } = await this.resolveTarget(input.tenantSlug, input.siteId, input.targetEnvId);
    if (input.sourceEnvId) await resolveSiteAndEnv(this.db, tenant.id, siteId, input.sourceEnvId);

    const version = input.version ?? `promote-${Date.now()}`;
    const args = {
      tenantSlug: input.tenantSlug,
      siteId,
      targetEnvId,
      sourceEnvId: input.sourceEnvId ?? null,
      version,
      bundleProvided: Boolean(input.bundle),
    };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:content.promote:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      const run = await this.db.withTenant(tenant.id, (db) =>
        db.transaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO promotion_runs (id, tenant_id, site_id, source_env_id, target_env_id, kind, version, status, current_step, created_by)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, 'promote', $5, 'pending', 'snapshot', $6)
             RETURNING id`,
            [tenant.id, siteId, input.sourceEnvId ?? null, targetEnvId, version, input.actor],
          );
          return rows[0];
        }),
      );

      // --- STEP 1: snapshot-first. Must fully commit before step 2 ever begins. -----------------
      const snapshot = await this.snapshots.takeSnapshot({ tenantId: tenant.id, promotionRunId: run.id, envId: targetEnvId, siteId });
      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(`UPDATE promotion_runs SET status = 'snapshotted', snapshot_id = $1, current_step = 'migrate' WHERE id = $2`, [
            snapshot.id,
            run.id,
          ]),
        ),
      );

      // --- STEP 2: migrate + content import (one atomic transaction; a failure here rolls back --
      //     entirely and leaves the target's content exactly as the snapshot just captured it).
      const bundleToApply = input.bundle ?? (await this.bundles.exportBundle(tenant.id, siteId));
      let applyResult;
      try {
        applyResult = await this.db.withTenant(tenant.id, (db) =>
          db.transaction((client) => this.bundles.applyBundle(client, tenant.id, siteId, bundleToApply, "merge")),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.db.withTenant(tenant.id, (db) =>
          db.transaction((client) =>
            client.query(
              `UPDATE promotion_runs SET status = 'failed', current_step = 'migrate_import', error_detail = $1::jsonb, completed_at = now() WHERE id = $2`,
              [JSON.stringify({ step: "migrate_import", message }), run.id],
            ),
          ),
        );
        throw err;
      }

      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(`UPDATE promotion_runs SET status = 'content_promoted', current_step = 'frontend_deploy' WHERE id = $1`, [run.id]),
        ),
      );

      // --- STEP 3: frontend artifact deploy -> domain/TLS activate -> purge/warm ----------------
      //     Expected to fail today (NotYetAvailableFrontendDeployDriver) — this is honest, not a
      //     bug: the content half above has already committed, and this failure must not roll
      //     that back. See frontend-deploy-driver.ts's header.
      let frontendDeployed = false;
      let frontendReason: string | undefined;
      try {
        for (const step of ["deployArtifact", "activateDomain", "purgeAndWarm"] as const) {
          await this.frontend.execute({ step, tenantSlug: input.tenantSlug, envId: targetEnvId, version });
        }
        frontendDeployed = true;
      } catch (err) {
        frontendReason = err instanceof Error ? err.message : String(err);
      }

      const finalStatus = frontendDeployed ? "completed" : "content_promoted_frontend_pending";
      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(
            `UPDATE promotion_runs SET status = $1, current_step = 'done', error_detail = $2::jsonb, completed_at = now() WHERE id = $3`,
            [finalStatus, frontendReason ? JSON.stringify({ step: "frontend_deploy", message: frontendReason }) : null, run.id],
          ),
        ),
      );

      if (frontendDeployed) {
        await this.db.withTenant(tenant.id, (db) =>
          db.transaction((client) =>
            client.query(
              `INSERT INTO releases (env_id, tenant_id, version, kind, snapshot_ref, created_by)
               VALUES ($1, $2, $3, 'promote', $4::jsonb, $5)
               ON CONFLICT (env_id, version) DO NOTHING`,
              [targetEnvId, tenant.id, version, JSON.stringify({ promotionRunId: run.id, snapshotId: snapshot.id }), input.actor],
            ),
          ),
        );
      }

      return {
        promotionRunId: run.id,
        status: finalStatus,
        snapshot: { id: snapshot.id, checksum: snapshot.checksum, itemCount: snapshot.itemCount },
        applyResult,
        frontendDeploy: { ok: frontendDeployed, reason: frontendReason },
      };
    });

    await this.promotionAudit.record({
      tenantId: tenant.id,
      command: "content.promote",
      actor: input.actor,
      args: { ...args, promotionRunId: result.promotionRunId, status: result.status },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, replayed };
  }

  async rollback(input: RollbackInput) {
    const { tenant, siteId, targetEnvId } = await this.resolveTarget(input.tenantSlug, input.siteId, input.targetEnvId);

    // MUST refuse when no snapshot exists — never a silent no-op. Checked BEFORE the idempotency
    // wrapper opens so a repeated call with no snapshot refuses identically every time, rather
    // than caching a "success" that never happened.
    const snapshot = await this.snapshots.latestSnapshot(tenant.id, targetEnvId);
    if (!snapshot) {
      throw new ConflictException(
        `no promotion_snapshots row exists for environment '${targetEnvId}' — nothing to roll back to. ` +
          `A rollback can only restore a POINT THAT WAS ACTUALLY SNAPSHOTTED (every content.promote takes one first); ` +
          `refusing rather than silently leaving the environment unchanged and reporting success.`,
      );
    }

    const version = input.version ?? `rollback-${snapshot.id.slice(0, 8)}`;
    const args = { tenantSlug: input.tenantSlug, siteId, targetEnvId, version, restoreFromSnapshotId: snapshot.id };
    const commandHash = this.auditHash.hashArgs(args);
    const scopeKey = `${input.tenantSlug}:content.rollback:${input.idempotencyKey}`;

    const { result, replayed } = await this.idempotency.run(scopeKey, commandHash, async () => {
      const run = await this.db.withTenant(tenant.id, (db) =>
        db.transaction(async (client) => {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO promotion_runs (id, tenant_id, site_id, source_env_id, target_env_id, kind, version, status, current_step, snapshot_id, created_by)
             VALUES (gen_random_uuid(), $1, $2, NULL, $3, 'rollback', $4, 'pending', 'restore', $5, $6)
             RETURNING id`,
            [tenant.id, siteId, targetEnvId, version, snapshot.id, input.actor],
          );
          return rows[0];
        }),
      );

      let applyResult;
      try {
        applyResult = await this.db.withTenant(tenant.id, (db) =>
          db.transaction((client) => this.bundles.applyBundle(client, tenant.id, siteId, snapshot.bundle, "restore")),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.db.withTenant(tenant.id, (db) =>
          db.transaction((client) =>
            client.query(
              `UPDATE promotion_runs SET status = 'failed', current_step = 'restore', error_detail = $1::jsonb, completed_at = now() WHERE id = $2`,
              [JSON.stringify({ step: "restore", message }), run.id],
            ),
          ),
        );
        throw err;
      }

      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(`UPDATE promotion_runs SET status = 'rolled_back', current_step = 'done', completed_at = now() WHERE id = $1`, [run.id]),
        ),
      );

      await this.db.withTenant(tenant.id, (db) =>
        db.transaction((client) =>
          client.query(
            `INSERT INTO releases (env_id, tenant_id, version, kind, snapshot_ref, created_by)
             VALUES ($1, $2, $3, 'rollback', $4::jsonb, $5)
             ON CONFLICT (env_id, version) DO NOTHING`,
            [targetEnvId, tenant.id, version, JSON.stringify({ promotionRunId: run.id, restoredFromSnapshotId: snapshot.id }), input.actor],
          ),
        ),
      );

      return { promotionRunId: run.id, status: "rolled_back" as const, restoredFromSnapshotId: snapshot.id, applyResult };
    });

    await this.promotionAudit.record({
      tenantId: tenant.id,
      command: "content.rollback",
      actor: input.actor,
      args: { ...args, promotionRunId: result.promotionRunId },
      ws4ApprovalId: input.ws4ApprovalId,
      replayed,
    });

    return { ...result, replayed };
  }
}
