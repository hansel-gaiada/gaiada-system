// Phase B admin backend: per-company org structure + compliance-gate status. Backs
// platform-ui's lib/org.ts and lib/adminData.ts (compliance) contracts. Org reads are open
// to any member; org writes + all compliance access are elevated (Cerbos is the boundary).
import {
  BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Put, Req, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withTenants } from "../db";
import { config } from "../config";
import { authorize, writeActivity } from "../core/http";
import { AuthGuard } from "../auth/guards";
// P2-06 §4.2: the org-structure write pipeline (sanitize -> persist -> sweep -> closure -> emit)
// lives in ONE place now, because the JML flows in employees.controller.ts are its second caller.
// This controller is a caller, not an owner — do not re-inline any step here.
import {
  applyOrgStructure, sanitizeStructure, type OrgStructure,
} from "./org-structure.service";

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
    await withTenants([tenantId], (c) => applyOrgStructure(c, tenantId, structure));
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
