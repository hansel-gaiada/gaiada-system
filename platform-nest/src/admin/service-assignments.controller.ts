// ORG-3: the service_assignments row lifecycle (propose/accept/revoke/suspend/resume/relink).
// Scoped deliberately narrow — this ticket does NOT build the reconciler (ORG-6): rows written
// here are dormant metadata, exactly like 0026 itself, until ORG-6/7 wire the grant projector.
// No membership/user_roles/service_grant_claims row is ever touched from this controller.
//
// Same file conventions as company-admin.controller.ts: authorize() (throws 403/401) -> RLS-bound
// query via withTenants -> writeActivity + outbox event on every write.
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { newId, withGlobal, withTenants } from "../db";
import { authorize, writeActivity } from "../core/http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import { allModules, getModule } from "../modules/registry";
import type { Principal } from "../rbac/principal";
import { config } from "../config";
import { reconcileAssignment, reconcileProvider, collectSubtreePersons } from "./service-reconciler";
import type { Envelope, EnvelopeCompany } from "../core/envelope";

// ---- shape of the org-structure blob node we need (mirrors company-admin.controller.ts's OrgNode) ----
interface BlobNode {
  id: string;
  name: string;
  kind: string;
  children?: BlobNode[];
}

const UNIT_KINDS = new Set(["department", "division"]);
const MODULE_KEY_RE = /^[a-z][a-z0-9_]*$/;

function findNode(root: BlobNode, nodeId: string): BlobNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}

function isGlobalActor(principal: Principal): boolean {
  return principal.roles.some(
    (g) => g.scopeType === "global" && (g.role === "platform_admin" || g.role === "group_executive"),
  );
}

function assertValidModuleKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !MODULE_KEY_RE.test(key)) {
    throw new UnprocessableEntityException("invalid module key");
  }
  // Format-only validation until the module registry is populated (WSA-2 is a separate, not-yet
  // -landed ticket) — once modules register, unknown keys 422 automatically. See the completion
  // report for this deliberate, narrow deviation.
  if (allModules().length > 0 && !getModule(key)) {
    throw new UnprocessableEntityException(`unknown module: ${key}`);
  }
}

/** Walk parent_company_id to the ultimate root (A5: same-holding validation). */
async function holdingRoot(companyId: string): Promise<string> {
  let current = companyId;
  for (let i = 0; i < 20; i++) {
    const { rows } = await withGlobal((c) =>
      c.query<{ parent_company_id: string | null }>(
        `SELECT parent_company_id FROM companies WHERE id = $1 AND deleted_at IS NULL`,
        [current],
      ),
    );
    if (!rows[0]) throw new NotFoundException(`company not found: ${current}`);
    if (!rows[0].parent_company_id) return current;
    current = rows[0].parent_company_id;
  }
  throw new BadRequestException("parent_company_id chain exceeds max depth (possible cycle)");
}

async function fetchOrgNode(providerTenantId: string, nodeId: string): Promise<BlobNode> {
  const { rows } = await withTenants([providerTenantId], (c) =>
    c.query<{ structure: { root: BlobNode } }>(
      `SELECT structure FROM company_org_structure WHERE tenant_id = $1`,
      [providerTenantId],
    ),
  );
  if (!rows[0]) throw new NotFoundException("provider has no org structure set");
  const node = findNode(rows[0].structure.root, nodeId);
  if (!node) throw new NotFoundException(`org node not found: ${nodeId}`);
  if (!UNIT_KINDS.has(node.kind)) {
    throw new UnprocessableEntityException(`node ${nodeId} is kind '${node.kind}', not department/division`);
  }
  return node;
}

/** Lazily create (or refresh) the relational anchor for a blob node. Provider-scoped. */
async function upsertOrgUnit(client: PoolClient, providerTenantId: string, node: BlobNode): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO org_units (id, tenant_id, node_id, kind, name)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, node_id) DO UPDATE SET name = $5, kind = $4, status = 'active', updated_at = now()
     RETURNING id`,
    [newId(), providerTenantId, node.id, node.kind, node.name],
  );
  return rows[0].id;
}

interface AssignmentRow {
  id: string;
  unit_id: string;
  provider_tenant_id: string;
  target_tenant_id: string;
  module_key: string;
  status: string;
  unit_name: string;
  unit_kind: string;
  unit_status: string;
  lead_user_id: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  suspended_at: string | null;
}

/** Fetch a row scoped to `sessionTenantId` (either side is legally visible per the dual-side
 *  sa_select policy — see 0026). 404 if it doesn't exist / isn't visible from this side. */
async function fetchAssignment(sessionTenantId: string, id: string): Promise<AssignmentRow> {
  const { rows } = await withTenants([sessionTenantId], (c) =>
    c.query<AssignmentRow>(`SELECT * FROM service_assignments WHERE id = $1`, [id]),
  );
  if (!rows[0]) throw new NotFoundException("service assignment not found");
  return rows[0];
}

/** A16: per-tenant dual outbox emission with a shared correlationId (the assignment id) so both
 *  sides' audit/sync/n8n consumers can join the two halves of one cross-company action. */
async function emitDual(
  providerTenantId: string,
  targetTenantId: string,
  assignmentId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const full = { ...payload, correlationId: assignmentId };
  await withTenants([providerTenantId], (c) =>
    emitEvent(c, providerTenantId, "service_assignment", assignmentId, eventType, full),
  );
  await withTenants([targetTenantId], (c) =>
    emitEvent(c, targetTenantId, "service_assignment", assignmentId, eventType, full),
  );
}

// ---- ORG-7b read-surface helpers (Envelope<T> fan-out) ----

/** Batch display-name lookup for an envelope's `companies[]`, global (no tenant scope needed —
 *  company name is not sensitive; visibility of the underlying ROWS is what RLS/authorize gate). */
async function namesFor(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id = ANY($1::uuid[])`, [ids]),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Cerbos-authoritative per-company visibility probe for an envelope fan-out: never lets a denial
 *  propagate as a request-wide 403 — the caller becomes {included:false, reason:"no_access"}
 *  instead, per the UX-2 inclusion-envelope contract (never a silent drop, never a leak). */
async function canRead(principal: Principal, tenantId: string): Promise<boolean> {
  try {
    await authorize(principal, { kind: "service_assignment", tenantId }, "read");
    return true;
  } catch {
    return false;
  }
}

function parseCsv(raw: string | undefined): string[] {
  return raw
    ? [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))]
    : [];
}

@Controller("api")
@UseGuards(AuthGuard)
export class ServiceAssignmentsController {
  // ---- create (propose) ----
  @Post(":tenantId/org-structure/units/:nodeId/assignments")
  @HttpCode(201)
  async propose(
    @Req() req: FastifyRequest,
    @Param("tenantId") providerTenantId: string,
    @Param("nodeId") nodeId: string,
    @Body() body: { targets?: unknown; module?: unknown; leadUserId?: unknown },
    @Query("dryRun") dryRunRaw?: string,
  ) {
    await authorize(req.principal, { kind: "service_assignment", tenantId: providerTenantId }, "propose");

    const moduleKey = body?.module;
    assertValidModuleKey(moduleKey);

    const rawTargets = Array.isArray(body?.targets) ? body.targets : [];
    const targets = [...new Set(rawTargets.filter((t): t is string => typeof t === "string" && t.length > 0))];
    if (targets.length === 0) throw new BadRequestException("targets: non-empty array of company ids required");
    if (targets.includes(providerTenantId)) throw new BadRequestException("a company cannot serve itself");

    const leadUserId = typeof body?.leadUserId === "string" ? body.leadUserId : null;

    // ---- ORG-7b dry-run (?dryRun=1): a pure PREVIEW — who WOULD be materialized + which targets
    // are legal — reads only (the provider's org blob subtree + its own membership table), never
    // writes a service_assignments row. Reuses the reconciler's OWN collectSubtreePersons (not a
    // re-implementation) so the preview can never drift from what a real reconcile would place.
    // Envelope-shaped (UX-2 §6): each requested target becomes a `companies[]` entry
    // (included:false + reason for cross-holding/nonexistent, never silently omitted); `items` is
    // the staff list, which is the same regardless of which targets are legal — placement is a
    // property of the provider unit alone, not of any one target.
    if (dryRunRaw === "1") {
      if (!config.serviceAssignmentsEnabled) {
        throw new ConflictException("service-assignment dry-run is disabled (SERVICE_ASSIGNMENTS_ENABLED)");
      }
      const providerRoot = await holdingRoot(providerTenantId);
      const nameById = await namesFor([...targets, providerTenantId]);
      const companies: EnvelopeCompany[] = [];
      for (const target of targets) {
        const { rows: exists } = await withGlobal((c) =>
          c.query<{ id: string }>(`SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL`, [target]),
        );
        if (!exists[0]) {
          companies.push({ id: target, name: nameById.get(target) ?? target, included: false, reason: "no_access" });
          continue;
        }
        const targetRoot = await holdingRoot(target);
        if (targetRoot !== providerRoot) {
          companies.push({ id: target, name: nameById.get(target) ?? target, included: false, reason: "no_access" });
          continue;
        }
        companies.push({ id: target, name: nameById.get(target) ?? target, included: true });
      }

      const node = await fetchOrgNode(providerTenantId, nodeId);
      const persons = collectSubtreePersons(node);
      let items: Array<{ userId: string; name: string; email: string; role: "staff" | "manager" }> = [];
      if (persons.length) {
        const { rows } = await withTenants([providerTenantId], (c) =>
          c.query<{ user_id: string; name: string; email: string }>(
            `SELECT m.user_id, u.name, u.email FROM company_memberships m JOIN users u ON u.id = m.user_id
             WHERE m.tenant_id = $1 AND m.user_id = ANY($2::uuid[]) AND m.status = 'active' AND m.deleted_at IS NULL`,
            [providerTenantId, persons],
          ),
        );
        items = rows.map((r) => ({
          userId: r.user_id,
          name: r.name,
          email: r.email,
          role: r.user_id === leadUserId ? ("manager" as const) : ("staff" as const),
        }));
      }
      return { dryRun: true, unit: { nodeId: node.id, name: node.name, kind: node.kind }, items, companies };
    }

    // Validate every target BEFORE writing anything (A5 same-holding + existence).
    const providerRoot = await holdingRoot(providerTenantId);
    for (const target of targets) {
      const { rows } = await withGlobal((c) =>
        c.query<{ id: string }>(`SELECT id FROM companies WHERE id = $1 AND deleted_at IS NULL`, [target]),
      );
      if (!rows[0]) throw new NotFoundException(`target company not found: ${target}`);
      const targetRoot = await holdingRoot(target);
      if (targetRoot !== providerRoot) {
        throw new UnprocessableEntityException(
          `target ${target} is not in the same holding as the provider — cross-holding service assignments are not allowed`,
        );
      }
    }

    const node = await fetchOrgNode(providerTenantId, nodeId);
    const global = isGlobalActor(req.principal);
    const status = global ? "active" : "proposed";

    const created: Array<{ id: string; target: string; status: string }> = [];
    await withTenants([providerTenantId], async (c) => {
      const unitId = await upsertOrgUnit(c, providerTenantId, node);
      for (const target of targets) {
        const id = newId();
        try {
          await c.query(
            `INSERT INTO service_assignments
               (id, unit_id, provider_tenant_id, target_tenant_id, module_key, status,
                lead_user_id, unit_name, unit_kind, unit_status, created_by,
                accepted_by, accepted_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12)`,
            [
              id,
              unitId,
              providerTenantId,
              target,
              moduleKey,
              status,
              leadUserId,
              node.name,
              node.kind,
              req.principal.userId,
              null, // accepted_by — no target-side consent recorded at creation time either way
              null, // accepted_at
            ],
          );
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            throw new ConflictException(
              `a live service assignment already exists for this unit/target(${target})/module`,
            );
          }
          throw err;
        }
        await emitEvent(c, providerTenantId, "service_assignment", id, `service_assignment.${status === "active" ? "activated" : "proposed"}`, {
          correlationId: id,
          targetTenantId: target,
          module: moduleKey,
          status,
        });
        created.push({ id, target, status });
      }
    });

    for (const c of created) {
      await withTenants([c.target], (client) =>
        emitEvent(client, c.target, "service_assignment", c.id, `service_assignment.${c.status === "active" ? "activated" : "proposed"}`, {
          correlationId: c.id,
          providerTenantId,
          unitId: node.id,
          unitName: node.name,
          module: moduleKey,
          status: c.status,
        }),
      );
      await writeActivity(providerTenantId, req.principal.userId, "proposed", "service_assignment", c.id, {
        targetTenantId: c.target,
        module: moduleKey,
        status: c.status,
      });
    }

    return { assignments: created };
  }

  // ---- target-side accept (proposed -> active) ----
  @Post(":tenantId/org-structure/assignments/:id/accept")
  @HttpCode(200)
  async accept(@Req() req: FastifyRequest, @Param("tenantId") targetTenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId: targetTenantId }, "accept");

    const row = await fetchAssignment(targetTenantId, id);
    if (row.target_tenant_id !== targetTenantId) {
      throw new ForbiddenException("accept must be called from the target company's side");
    }
    if (row.status !== "proposed") {
      throw new ConflictException(`assignment is '${row.status}', not 'proposed'`);
    }

    await withTenants([targetTenantId], (c) =>
      c.query(
        `UPDATE service_assignments SET status = 'active', accepted_by = $2, accepted_at = now() WHERE id = $1`,
        [id, req.principal.userId],
      ),
    );

    await emitDual(row.provider_tenant_id, targetTenantId, id, "service_assignment.activated", {
      module: row.module_key,
      providerTenantId: row.provider_tenant_id,
      targetTenantId,
    });
    await writeActivity(targetTenantId, req.principal.userId, "accepted", "service_assignment", id, {
      providerTenantId: row.provider_tenant_id,
      module: row.module_key,
    });

    return { ok: true, status: "active" };
  }

  // ---- revoke (either side) — an UPDATE to status='revoked', never a DELETE ----
  @Delete(":tenantId/org-structure/assignments/:id")
  @HttpCode(200)
  async revoke(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "revoke");

    const row = await fetchAssignment(tenantId, id);
    if (row.status === "revoked") throw new ConflictException("assignment already revoked");

    const { rowCount } = await withTenants([tenantId], (c) =>
      c.query(
        `UPDATE service_assignments SET status = 'revoked', revoked_by = $2, revoked_at = now()
         WHERE id = $1 AND status <> 'revoked'`,
        [id, req.principal.userId],
      ),
    );
    if (!rowCount) throw new ConflictException("assignment already revoked");

    await emitDual(row.provider_tenant_id, row.target_tenant_id, id, "service_assignment.revoked", {
      module: row.module_key,
      providerTenantId: row.provider_tenant_id,
      targetTenantId: row.target_tenant_id,
      revokedFrom: tenantId,
    });
    await writeActivity(tenantId, req.principal.userId, "revoked", "service_assignment", id, {
      module: row.module_key,
    });

    return { ok: true, status: "revoked" };
  }

  // ---- suspend / resume (either side) — temporary freeze without losing the edge (A16) ----
  @Patch(":tenantId/org-structure/assignments/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "suspend");
    const row = await fetchAssignment(tenantId, id);
    if (row.status !== "active") throw new ConflictException(`only an 'active' assignment can be suspended (is '${row.status}')`);

    await withTenants([tenantId], (c) =>
      c.query(`UPDATE service_assignments SET status = 'suspended', suspended_at = now() WHERE id = $1`, [id]),
    );
    await emitDual(row.provider_tenant_id, row.target_tenant_id, id, "service_assignment.suspended", {
      module: row.module_key,
      providerTenantId: row.provider_tenant_id,
      targetTenantId: row.target_tenant_id,
    });
    await writeActivity(tenantId, req.principal.userId, "suspended", "service_assignment", id, {});
    return { ok: true, status: "suspended" };
  }

  @Patch(":tenantId/org-structure/assignments/:id/resume")
  @HttpCode(200)
  async resume(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "resume");
    const row = await fetchAssignment(tenantId, id);
    if (row.status !== "suspended") throw new ConflictException(`only a 'suspended' assignment can be resumed (is '${row.status}')`);

    await withTenants([tenantId], (c) =>
      c.query(`UPDATE service_assignments SET status = 'active', suspended_at = NULL WHERE id = $1`, [id]),
    );
    await emitDual(row.provider_tenant_id, row.target_tenant_id, id, "service_assignment.resumed", {
      module: row.module_key,
      providerTenantId: row.provider_tenant_id,
      targetTenantId: row.target_tenant_id,
    });
    await writeActivity(tenantId, req.principal.userId, "resumed", "service_assignment", id, {});
    return { ok: true, status: "active" };
  }

  // ---- re-link (unit_id PATCH) — provider-admin/global ONLY (GATE-1 consent rule) ----
  @Patch(":tenantId/org-structure/assignments/:id")
  @HttpCode(200)
  async relink(
    @Req() req: FastifyRequest,
    @Param("tenantId") providerTenantId: string,
    @Param("id") id: string,
    @Body() body: { nodeId?: unknown },
  ) {
    await authorize(req.principal, { kind: "service_assignment", tenantId: providerTenantId }, "relink");

    const row = await fetchAssignment(providerTenantId, id);
    if (row.provider_tenant_id !== providerTenantId) {
      throw new ForbiddenException("relink must be initiated by the provider company");
    }
    if (row.status === "revoked") throw new ConflictException("cannot relink a revoked assignment");

    const nodeId = body?.nodeId;
    if (typeof nodeId !== "string" || !nodeId) throw new BadRequestException("nodeId required");

    const node = await fetchOrgNode(providerTenantId, nodeId);
    const global = isGlobalActor(req.principal);
    // Orphan-repair (the row's CURRENT denormalized unit_status is 'orphaned') re-links skip
    // re-consent — the relationship's authority was never revoked, only its anchor went stale.
    const isOrphanRepair = row.unit_status === "orphaned";
    const wasLiveNonOrphan = (row.status === "active" || row.status === "suspended") && !isOrphanRepair;
    const reconsentRequired = !global && wasLiveNonOrphan;

    let unitId = "";
    let newStatus = row.status;
    await withTenants([providerTenantId], async (c) => {
      unitId = await upsertOrgUnit(c, providerTenantId, node);
      if (reconsentRequired) {
        newStatus = "proposed";
        await c.query(
          `UPDATE service_assignments
             SET unit_id = $2, unit_name = $3, unit_kind = $4, unit_status = 'active',
                 status = 'proposed', accepted_by = NULL, accepted_at = NULL, suspended_at = NULL
           WHERE id = $1`,
          [id, unitId, node.name, node.kind],
        );
      } else {
        await c.query(
          `UPDATE service_assignments SET unit_id = $2, unit_name = $3, unit_kind = $4, unit_status = 'active'
           WHERE id = $1`,
          [id, unitId, node.name, node.kind],
        );
      }
    });

    await emitDual(providerTenantId, row.target_tenant_id, id, "service_assignment.relinked", {
      module: row.module_key,
      providerTenantId,
      targetTenantId: row.target_tenant_id,
      newNodeId: node.id,
      reconsentRequired,
      status: newStatus,
    });
    await writeActivity(providerTenantId, req.principal.userId, "relinked", "service_assignment", id, {
      newNodeId: node.id,
      reconsentRequired,
    });

    return { ok: true, status: newStatus, reconsentRequired };
  }

  // ---- ORG-7: manual reconcile (either side) — admin/global ONLY (see the Cerbos policy note:
  //      this bypasses the propose/accept consent handshake's normal pacing, forcing an immediate
  //      re-materialization, so it is scoped to the same actors who can already auto-active-create).
  //      Idempotent: re-running with nothing changed is a documented no-op (service-reconciler.ts).
  @Post(":tenantId/org-structure/assignments/:id/reconcile")
  @HttpCode(200)
  async reconcileOne(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Param("id") id: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "reconcile");
    // 404s if the row doesn't exist / isn't visible from this side (dual-side sa_select).
    const row = await fetchAssignment(tenantId, id);
    if (!config.serviceAssignmentsEnabled) {
      throw new ConflictException("service-assignment reconciler is disabled (SERVICE_ASSIGNMENTS_ENABLED)");
    }
    const result = await reconcileAssignment(id, tenantId);
    // Only null when the flag is off (already excluded above) or the row vanished mid-request.
    if (!result) throw new NotFoundException("service assignment not found");
    await writeActivity(tenantId, req.principal.userId, "reconciled", "service_assignment", id, {
      module: row.module_key,
      granted: result.granted,
      revoked: result.revoked,
      orphaned: result.orphaned,
      skipped: result.skipped,
    });
    return result;
  }

  // ---- ORG-7: provider-level manual reconcile — re-diffs every live-ish assignment this
  //      tenant provides (the same fan-out reconcileProvider does off an org_structure.updated
  //      event), for an admin who wants to force convergence without waiting on the event loop.
  @Post(":tenantId/org-structure/reconcile")
  @HttpCode(200)
  async reconcileAllForProvider(@Req() req: FastifyRequest, @Param("tenantId") providerTenantId: string) {
    await authorize(req.principal, { kind: "service_assignment", tenantId: providerTenantId }, "reconcile");
    if (!config.serviceAssignmentsEnabled) {
      throw new ConflictException("service-assignment reconciler is disabled (SERVICE_ASSIGNMENTS_ENABLED)");
    }
    const results = await reconcileProvider(providerTenantId);
    await writeActivity(providerTenantId, req.principal.userId, "reconciled", "service_assignment", providerTenantId, {
      count: results.length,
    });
    return { results };
  }

  // ---- ORG-7b: GET assignments (UX-2 read surface) ----
  // The URL's own `:tenantId` is authorized the NORMAL way — a hard authorize() that throws/
  // propagates a real 403, exactly like every other endpoint in this controller (contract
  // convention: "403 → not authorized, readers surface a limited-access state" — that's a
  // request-level concern for the resource actually being addressed, not an envelope concern).
  // `companyIds` OPTIONALLY WIDENS the fan-out beyond `:tenantId` (e.g. an hr_staff wanting "all
  // served companies" in one call, per UX-2 §3's ServicedBlock "All served (N)" pill) — each EXTRA
  // id is independently authorize()-probed and a denial there becomes {included:false,
  // reason:"no_access"} in the envelope (never a request-wide 403, never a silent drop) — that
  // softening is precisely what the inclusion-envelope exists for on a caller-named, optional set.
  @Get(":tenantId/org-structure/assignments")
  async listAssignments(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("direction") direction = "provided",
    @Query("companyIds") companyIdsRaw?: string,
    @Query("status") statusRaw?: string,
  ): Promise<Envelope<Record<string, unknown>>> {
    if (!config.serviceAssignmentsEnabled) {
      throw new ConflictException("service-assignment reads are disabled (SERVICE_ASSIGNMENTS_ENABLED)");
    }
    if (direction !== "provided" && direction !== "served") {
      throw new BadRequestException("direction must be 'provided' or 'served'");
    }
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "read");

    const statusFilter = statusRaw ? statusRaw.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const extraIds = parseCsv(companyIdsRaw).filter((id) => id !== tenantId);
    const scopeIds = [tenantId, ...extraIds];
    const nameById = await namesFor(scopeIds);

    const items: Record<string, unknown>[] = [];
    const companies: EnvelopeCompany[] = [];
    const col = direction === "provided" ? "provider_tenant_id" : "target_tenant_id";

    for (const cid of scopeIds) {
      if (cid !== tenantId && !(await canRead(req.principal, cid))) {
        companies.push({ id: cid, name: nameById.get(cid) ?? cid, included: false, reason: "no_access" });
        continue;
      }
      const clauses = [`${col} = $1`];
      const params: unknown[] = [cid];
      if (statusFilter?.length) {
        params.push(statusFilter);
        clauses.push(`status = ANY($${params.length})`);
      }
      const { rows } = await withTenants([cid], (c) =>
        c.query<AssignmentRow>(
          `SELECT * FROM service_assignments WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC`,
          params,
        ),
      );
      for (const r of rows) {
        items.push({
          id: r.id,
          unitId: r.unit_id,
          unitName: r.unit_name,
          unitKind: r.unit_kind,
          unitStatus: r.unit_status,
          providerTenantId: r.provider_tenant_id,
          targetTenantId: r.target_tenant_id,
          moduleKey: r.module_key,
          status: r.status,
          leadUserId: r.lead_user_id,
          acceptedBy: r.accepted_by,
          acceptedAt: r.accepted_at,
          suspendedAt: r.suspended_at,
        });
      }
      companies.push({ id: cid, name: nameById.get(cid) ?? cid, included: true });
    }
    return { items, companies };
  }

  // ---- ORG-7b: GET service-units (UX-2 read surface) ----
  // Provider-side only (org_units stays strictly provider-side per A8) — units of `:tenantId`
  // (+ optional `companyIds` widen) that currently have at least one live-ish service_assignment.
  // No raw provider userIds leave this endpoint (A6): just unit identity + served-company count +
  // the module keys served, matching the "opaque handles, no raw ids to the target" rule.
  @Get(":tenantId/org-structure/service-units")
  async listServiceUnits(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("companyIds") companyIdsRaw?: string,
  ): Promise<Envelope<Record<string, unknown>>> {
    if (!config.serviceAssignmentsEnabled) {
      throw new ConflictException("service-assignment reads are disabled (SERVICE_ASSIGNMENTS_ENABLED)");
    }
    await authorize(req.principal, { kind: "service_assignment", tenantId }, "read");

    const extraIds = parseCsv(companyIdsRaw).filter((id) => id !== tenantId);
    const scopeIds = [tenantId, ...extraIds];
    const nameById = await namesFor(scopeIds);

    const items: Record<string, unknown>[] = [];
    const companies: EnvelopeCompany[] = [];

    for (const cid of scopeIds) {
      if (cid !== tenantId && !(await canRead(req.principal, cid))) {
        companies.push({ id: cid, name: nameById.get(cid) ?? cid, included: false, reason: "no_access" });
        continue;
      }
      const { rows } = await withTenants([cid], (c) =>
        c.query<{
          id: string; node_id: string; name: string; kind: string; status: string;
          served_count: number; modules: string[];
        }>(
          `SELECT ou.id, ou.node_id, ou.name, ou.kind, ou.status,
                  count(DISTINCT sa.target_tenant_id)::int AS served_count,
                  array_agg(DISTINCT sa.module_key) AS modules
           FROM org_units ou
           JOIN service_assignments sa ON sa.unit_id = ou.id AND sa.status IN ('active','suspended','proposed')
           WHERE ou.tenant_id = $1
           GROUP BY ou.id, ou.node_id, ou.name, ou.kind, ou.status`,
          [cid],
        ),
      );
      for (const r of rows) {
        items.push({
          unitId: r.id,
          nodeId: r.node_id,
          name: r.name,
          kind: r.kind,
          status: r.status,
          servedCompanyCount: r.served_count,
          modules: r.modules,
          providerTenantId: cid,
        });
      }
      companies.push({ id: cid, name: nameById.get(cid) ?? cid, included: true });
    }
    return { items, companies };
  }
}
