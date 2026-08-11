// Phase B admin backend: per-company org structure + compliance-gate status. Backs
// platform-ui's lib/org.ts and lib/adminData.ts (compliance) contracts. Org reads are open
// to any member; org writes + all compliance access are elevated (Cerbos is the boundary).
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
import { withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { emitEvent } from "../events/outbox.service";
import { AuthGuard } from "../auth/guards";
import {
  deriveBlobPlacements, diffMembershipSweep, isUuidShaped, todayIso,
  type BlobPlacement, type OpenPrimaryMembership,
} from "../core/dept-resolution";
import { rebuildOrgUnitClosure } from "../core/org-unit-closure";

// ---- Org-structure types + sanitizer (mirror platform-ui/src/lib/org.ts) ----
// Canonical depth: holding → company → department → division → role → person.
// Legacy "team" nodes are migrated to "division" on read/write.
const ORG_KINDS = new Set(["holding", "company", "department", "division", "role", "person"]);
const MAX_NODES = 300;
const MAX_DEPTH = 8;

interface OrgNode {
  id: string;
  name: string;
  kind: string;
  assigneeId: string | null;
  assigneeName: string | null;
  children: OrgNode[];
}
interface OrgStructure {
  root: OrgNode;
  updatedAt?: string | null;
}

/** Coerce arbitrary input into a safe OrgStructure: valid kinds, string names, bounded
 *  node-count and depth (defends against cycles/abuse). Root is forced to kind "company". */
function sanitizeStructure(input: unknown, fallbackName = "Company"): OrgStructure {
  let count = 0;
  function node(raw: unknown, depth: number): OrgNode {
    const r = (raw ?? {}) as Record<string, unknown>;
    count += 1;
    const rawKind = r.kind === "team" ? "division" : (r.kind as string);
    const kind = ORG_KINDS.has(rawKind) ? rawKind : "role";
    const rawChildren = Array.isArray(r.children) ? r.children : [];
    const children: OrgNode[] = [];
    if (depth < MAX_DEPTH) {
      for (const c of rawChildren) {
        if (count >= MAX_NODES) break;
        children.push(node(c, depth + 1));
      }
    }
    return {
      id: typeof r.id === "string" && r.id ? r.id : `n-${count}`,
      name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 80) : "Untitled",
      kind,
      assigneeId: typeof r.assigneeId === "string" ? r.assigneeId : null,
      assigneeName: typeof r.assigneeName === "string" ? r.assigneeName : null,
      children,
    };
  }
  const obj = (input ?? {}) as Record<string, unknown>;
  const root = node(obj.root ?? obj, 0);
  root.kind = "company";
  if (root.name === "Untitled") root.name = fallbackName;
  return { root };
}

// ---- Compliance-gate template (the six launch gates; status/evidence persisted per tenant) ----
const GATE_STATUSES = new Set(["open", "in_progress", "passed", "waived"]);
const GATE_TEMPLATE: { key: string; title: string; description: string }[] = [
  { key: "G.1", title: "Lawful basis + DPIA/LIA", description: "Lawful basis established and DPIA/LIA completed (not employee consent)." },
  { key: "G.2", title: "Monitoring notice + per-individual opt-out", description: "Monitoring notice issued and a working per-individual opt-out is in place." },
  { key: "G.3", title: "Retention TTL + auto-purge", description: "Retention TTL configured with automatic purge enforced." },
  { key: "G.4", title: "Day-one gate (crypto-shred + scrubber) passed", description: "The technical day-one gate — crypto-shred store and PAN/KTP scrubber — has passed." },
  { key: "G.5", title: "WA ToS risk acceptance recorded", description: "WhatsApp Terms of Service risk acceptance has been recorded." },
  { key: "G.6", title: "Legal counsel engaged (jurisdiction/PCI)", description: "Legal counsel engaged on jurisdiction and PCI considerations." },
];

@Controller("api")
@UseGuards(AuthGuard)
export class CompanyAdminController {
  // ---- Org structure ----
  @Get(":tenantId/org-structure")
  async getOrg(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "org_structure", tenantId }, "read");
    const rows = await withTenants([tenantId], (c) =>
      c.query<{ structure: OrgStructure; updated_at: string }>(
        `SELECT structure, updated_at FROM company_org_structure WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    if (!rows.rows[0]) throw new NotFoundException("no org structure set");
    return { ...rows.rows[0].structure, updatedAt: rows.rows[0].updated_at };
  }

  @Put(":tenantId/org-structure")
  @HttpCode(200)
  async putOrg(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, { kind: "org_structure", tenantId }, "update");
    if (!body || typeof body !== "object" || !(body as Record<string, unknown>).root) {
      throw new BadRequestException("org structure with a root node required");
    }
    const structure = sanitizeStructure(body);
    await withTenants([tenantId], async (c) => {
      await c.query(
        `INSERT INTO company_org_structure (tenant_id, structure, origin_site)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id) DO UPDATE SET structure = $2, updated_at = now()`,
        [tenantId, JSON.stringify(structure), config.originSite],
      );
      // TR-04 (§3.2 Blocker 2) — every org-blob write is also a membership-sweep write: close/open
      // org_unit_memberships rows so department resolution stays time-aware (a transfer never
      // rewrites history). Same transaction as the blob write, so a sweep failure rolls back the
      // structure change too rather than leaving them inconsistent.
      await sweepMemberships(c, tenantId, structure.root);
      // IAM-09 — every org-blob write is ALSO a closure rebuild: org_unit_closure is wholesale
      // DELETE+re-INSERTed for this tenant, in the SAME transaction as the blob write, so the
      // closure can never disagree with the tree it describes (a node moved/deleted is trivially
      // correct — there is no incremental diff to get wrong). Load-bearing prerequisite for
      // HIER-2's (not yet built) org_unit_lead subtree cascade.
      await rebuildOrgUnitClosure(c, tenantId, structure.root);
      await emitEvent(c, tenantId, "org_structure", tenantId, "org_structure.updated", {
        nodeCount: countNodes(structure.root),
      });
    });
    await writeActivity(tenantId, req.principal.userId, "updated", "org_structure", tenantId);
    return { ok: true };
  }

  // ---- Compliance gates ----
  @Get(":tenantId/compliance-gates")
  async getGates(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, { kind: "compliance_gate", tenantId }, "read");
    const stored = await withTenants([tenantId], (c) =>
      c.query<{ key: string; status: string; evidence_url: string | null }>(
        `SELECT key, status, evidence_url FROM compliance_gates WHERE tenant_id = $1`,
        [tenantId],
      ),
    );
    const byKey = new Map(stored.rows.map((r) => [r.key, r]));
    return GATE_TEMPLATE.map((g) => {
      const s = byKey.get(g.key);
      return {
        id: g.key,
        key: g.key,
        title: g.title,
        description: g.description,
        status: s?.status ?? "open",
        evidence_url: s?.evidence_url ?? null,
      };
    });
  }

  @Patch(":tenantId/compliance-gates/:gateKey")
  @HttpCode(200)
  async patchGate(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Param("gateKey") gateKey: string,
    @Body() body: { status?: string; evidence_url?: string | null },
  ) {
    await authorize(req.principal, { kind: "compliance_gate", tenantId }, "update");
    if (!GATE_TEMPLATE.some((g) => g.key === gateKey)) throw new NotFoundException("unknown compliance gate");
    const { status, evidence_url } = body ?? {};
    if (status !== undefined && !GATE_STATUSES.has(status)) throw new BadRequestException("invalid status");
    if (status === undefined && evidence_url === undefined) throw new BadRequestException("nothing to update");
    await withTenants([tenantId], (c) =>
      c.query(
        `INSERT INTO compliance_gates (tenant_id, key, status, evidence_url, origin_site)
         VALUES ($1, $2, COALESCE($3, 'open'), $4, $5)
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           status = COALESCE($3, compliance_gates.status),
           evidence_url = CASE WHEN $6 THEN $4 ELSE compliance_gates.evidence_url END,
           updated_at = now()`,
        [tenantId, gateKey, status ?? null, evidence_url ?? null, config.originSite, evidence_url !== undefined],
      ),
    );
    await writeActivity(tenantId, req.principal.userId, "updated", "compliance_gate", tenantId, { key: gateKey, status });
    return { ok: true };
  }
}

function countNodes(node: OrgNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

// ---- TR-04 (§3.2 Blocker 2) — the org-blob PUT hook: the membership sweep ----
// Diffs the NEW blob's person placements against the tenant's currently-open PRIMARY
// org_unit_memberships rows and executes the resulting ops as plain SQL inside the SAME
// transaction as the blob write (called from putOrg, inside its withTenants([tenantId], ...)),
// so a sweep failure rolls back the structure change too rather than leaving them inconsistent.
// The diff itself is a PURE function (core/dept-resolution.ts, unit-tested there incl. the
// as-of transfer case) — this function is pure I/O around it: read candidates, defensively
// resolve them to real users (mirrors the 0055 backfill's "uuid-shaped AND present in users"
// guard, §15), read the currently-open rows, diff, write. `config.originSite` is passed
// EXPLICITLY on every insert (§15 ruling: org_unit_memberships has NO column default for
// origin_site — a default would silently mislabel a site-originated row as central under the
// sync engine's site/central topology).
async function sweepMemberships(c: PoolClient, tenantId: string, root: OrgNode): Promise<void> {
  const candidates: BlobPlacement[] = deriveBlobPlacements(root);

  const uuidCandidates = candidates.filter((p) => isUuidShaped(p.userId));
  const knownUserIds = uuidCandidates.length
    ? new Set(
        (
          await c.query<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::uuid[])`, [
            uuidCandidates.map((p) => p.userId),
          ])
        ).rows.map((r) => r.id),
      )
    : new Set<string>();
  // Never invent a person, never abort the PUT for an unrepresentable ref — same posture as the
  // 0055 backfill's DEFENSIVE PERSON-REF RESOLUTION.
  const placements = uuidCandidates.filter((p) => knownUserIds.has(p.userId));

  const openRows = (
    await c.query<OpenPrimaryMembership>(
      `SELECT user_id AS "userId", unit_node_id AS "unitNodeId", valid_from::text AS "validFrom"
         FROM org_unit_memberships
        WHERE tenant_id = $1 AND is_primary AND valid_to IS NULL`,
      [tenantId],
    )
  ).rows;

  const ops = diffMembershipSweep(placements, openRows, todayIso());

  for (const op of ops) {
    if (op.kind === "add") {
      await c.query(
        `INSERT INTO org_unit_memberships
           (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, $3, true, $4, NULL, 'org_blob', $5)
         ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.unitNodeId, op.validFrom, config.originSite],
      );
    } else if (op.kind === "amend") {
      await c.query(
        `UPDATE org_unit_memberships SET unit_node_id = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.unitNodeId],
      );
    } else if (op.kind === "transfer") {
      // Sequenced so the transfer is atomic and legal: close the old row FIRST (the EXCLUDE
      // constraint is checked per-statement, not deferred), THEN open the new one — closing at
      // `today - 1` (never `today`) is what keeps the two ranges non-overlapping under the
      // constraint's inclusive-both-ends daterange (see org-unit-memberships.test.ts's "ADJACENT
      // non-overlapping primary ranges are ALLOWED" case, which this reproduces exactly).
      await c.query(
        `UPDATE org_unit_memberships SET valid_to = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.closeValidTo],
      );
      await c.query(
        `INSERT INTO org_unit_memberships
           (tenant_id, user_id, unit_node_id, is_primary, valid_from, valid_to, source, origin_site)
         VALUES ($1, $2, $3, true, $4, NULL, 'org_blob', $5)
         ON CONFLICT DO NOTHING`,
        [tenantId, op.userId, op.openUnitNodeId, op.openValidFrom, config.originSite],
      );
    } else {
      // 'remove' — person no longer resolvable anywhere in the new blob; close, open nothing.
      await c.query(
        `UPDATE org_unit_memberships SET valid_to = $3
          WHERE tenant_id = $1 AND user_id = $2 AND is_primary AND valid_to IS NULL`,
        [tenantId, op.userId, op.closeValidTo],
      );
    }
  }
}
