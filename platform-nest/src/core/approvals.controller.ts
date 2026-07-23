// WSUX-1 (UX-2 daily-work spec, contract §9a) — `GET /api/approvals`: the unified cross-origin +
// cross-company approvals read. Unions three EXISTING, independently-authorized sources into one
// normalized, urgency-sorted `Envelope<UnifiedApprovalItem>`:
//   - agency_approvals    (origin "agency")               — agency.controller.ts's own source
//   - pipeline_gates       (origin "pipeline")             — pipeline.controller.ts's own source
//   - automation_approvals (origin "automation"|"agent"|"hr") — automation-approvals.controller.ts's
//     own source (hr-origin rows are automation_approvals rows with origin='hr', per WSD-4)
//
// This endpoint is READ-ONLY. It does not decide anything (WSUX-2 builds the generic decide
// façade) and it introduces NO new authorization model: every visibility check below is the SAME
// authorize()/Cerbos call each origin's native controller already makes, just probed per
// (tenant, origin[, module]) leg instead of per-request. A caller never sees a row here they
// couldn't already see by calling the native endpoint directly (D-UX-2: never widen visibility).
//
// D-UX-2 fan-out rule: cross-company reads are N parallel single-tenant `withTenants([t])` legs —
// NEVER a widened GUC set. Every withTenants() call below passes a single-element array literal,
// so `npm run lint:withtenants` (A1) stays green with zero new allowlist entries.
import { BadRequestException, Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { withGlobal, withTenants } from "../db";
import { authorize } from "./http";
import { AuthGuard } from "../auth/guards";
import type { Principal } from "../rbac/principal";
import type { Envelope, EnvelopeCompany } from "./envelope";
import { ageBonus, ORIGIN_BASE_WEIGHT, IMPACT_BONUS, type ApprovalOrigin } from "./approvals-urgency";

export interface UnifiedApprovalItem {
  id: string;
  origin: ApprovalOrigin;
  tenantId: string;
  company: string;
  subject: string;
  subjectHref?: string;
  previewUrl?: string;
  createdAt: string; // ISO
  ageMs: number;
  urgencyScore: number;
  decidable: boolean;
  // Additive to the contract's documented shape (D-UX-3's interface is non-exhaustive): the
  // decided-history mode needs SOME terminal-state field, and every origin already has one.
  status: string;
}

type ApprovalStatus = "pending" | "decided";
type Sort = "urgency" | "age";

const ALL_ORIGINS: ApprovalOrigin[] = ["agency", "pipeline", "hr", "automation", "agent"];

function parseOrigins(raw: string | undefined): ApprovalOrigin[] {
  if (!raw) return ALL_ORIGINS;
  const requested = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  for (const o of requested) {
    if (!ALL_ORIGINS.includes(o as ApprovalOrigin)) {
      throw new BadRequestException(`origin must be a comma-separated subset of ${ALL_ORIGINS.join(",")}`);
    }
  }
  return ALL_ORIGINS.filter((o) => requested.has(o));
}

function parseStatus(raw: string | undefined): ApprovalStatus {
  if (raw === undefined || raw === "pending") return "pending";
  if (raw === "decided") return "decided";
  throw new BadRequestException("status must be pending|decided");
}

function parseSort(raw: string | undefined): Sort {
  if (raw === undefined || raw === "urgency") return "urgency";
  if (raw === "age") return "age";
  throw new BadRequestException("sort must be urgency|age");
}

async function namesFor(ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const { rows } = await withGlobal((c) =>
    c.query<{ id: string; name: string }>(`SELECT id, name FROM companies WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]),
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Soft Cerbos probe (mirrors service-assignments.controller.ts's canRead()): a denial here never
 *  propagates as a request-wide error — it just means this (tenant, origin) leg contributes zero
 *  items, or (for the decide probe) that this leg's items are read-only. */
async function canDo(principal: Principal, tenantId: string, kind: string, action: string, module?: string): Promise<boolean> {
  try {
    await authorize(principal, { kind, tenantId, module }, action);
    return true;
  } catch {
    return false;
  }
}

function iso(v: string | Date): string {
  return new Date(v).toISOString();
}

async function agencyLeg(
  principal: Principal,
  tenantId: string,
  companyName: string,
  status: ApprovalStatus,
): Promise<{ items: UnifiedApprovalItem[]; readable: boolean }> {
  const readable = await canDo(principal, tenantId, "agency_approval", "read");
  if (!readable) return { items: [], readable: false };
  const decidable = await canDo(principal, tenantId, "agency_approval", "approve");
  const now = Date.now();
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ id: string; subject: string; created_at: string; campaign_id: string; status: string; decided_at: string | null }>(
      status === "pending"
        ? `SELECT a.id, a.subject, a.created_at, a.campaign_id, a.status
           FROM agency_approvals a JOIN agency_campaigns c ON c.id = a.campaign_id
           WHERE a.status = 'pending' AND a.deleted_at IS NULL ORDER BY a.created_at`
        : `SELECT a.id, a.subject, a.created_at, a.campaign_id, a.status
           FROM agency_approvals a JOIN agency_campaigns c ON c.id = a.campaign_id
           WHERE a.status IN ('approved','rejected') AND a.deleted_at IS NULL ORDER BY a.decided_at DESC LIMIT 200`,
    ),
  );
  const items: UnifiedApprovalItem[] = rows.map((r) => {
    const ageMs = now - new Date(r.created_at).getTime();
    return {
      id: r.id,
      origin: "agency",
      tenantId,
      company: companyName,
      subject: r.subject,
      subjectHref: `/agency/campaigns/${r.campaign_id}`,
      createdAt: iso(r.created_at),
      ageMs,
      urgencyScore: ORIGIN_BASE_WEIGHT.agency + ageBonus(ageMs),
      decidable,
      status: r.status,
    };
  });
  return { items, readable: true };
}

async function pipelineLeg(
  principal: Principal,
  tenantId: string,
  companyName: string,
  status: ApprovalStatus,
): Promise<{ items: UnifiedApprovalItem[]; readable: boolean }> {
  const readable = await canDo(principal, tenantId, "pipeline_gate", "read");
  if (!readable) return { items: [], readable: false };
  const decidable = await canDo(principal, tenantId, "pipeline_gate", "decide");
  const now = Date.now();
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{ id: string; run_id: string; kind: string; actor_side: string; decision: string | null; created_at: string; title: string | null }>(
      `SELECT g.id, g.run_id, g.kind, g.actor_side, g.decision, g.created_at, r.title
       FROM pipeline_gates g LEFT JOIN pipeline_runs r ON r.id = g.run_id
       WHERE g.status = $1 AND g.deleted_at IS NULL ORDER BY g.created_at DESC LIMIT 200`,
      [status === "pending" ? "pending" : "decided"],
    ),
  );
  const items: UnifiedApprovalItem[] = rows.map((r) => {
    const ageMs = now - new Date(r.created_at).getTime();
    return {
      id: r.id,
      origin: "pipeline",
      tenantId,
      company: companyName,
      subject: `${r.kind}${r.title ? ` — ${r.title}` : ""}`,
      subjectHref: `/pipeline/runs/${r.run_id}`,
      createdAt: iso(r.created_at),
      ageMs,
      urgencyScore: ORIGIN_BASE_WEIGHT.pipeline + ageBonus(ageMs),
      decidable,
      status: status === "pending" ? "pending" : (r.decision ?? "decided"),
    };
  });
  return { items, readable: true };
}

/** automation_approvals backs THREE unified origins (automation, agent, hr — WSD-4). `subOrigins`
 *  is whichever of those the caller actually requested; each gets its OWN read/decide probe since
 *  hr rows are additionally reachable by a served-company module_manager who cannot see
 *  automation/agent rows (resource_automation_approval.yaml's module_manager rule). */
async function automationLeg(
  principal: Principal,
  tenantId: string,
  companyName: string,
  status: ApprovalStatus,
  subOrigins: ApprovalOrigin[],
): Promise<{ items: UnifiedApprovalItem[]; readable: boolean }> {
  const wantsHr = subOrigins.includes("hr");
  const wantsOther = subOrigins.some((o) => o === "automation" || o === "agent");

  const readableHr = wantsHr && (await canDo(principal, tenantId, "automation_approval", "read", "hr"));
  const readableOther = wantsOther && (await canDo(principal, tenantId, "automation_approval", "read"));
  if (!readableHr && !readableOther) return { items: [], readable: false };

  const decidableHr = readableHr && (await canDo(principal, tenantId, "automation_approval", "decide", "hr"));
  const decidableOther = readableOther && (await canDo(principal, tenantId, "automation_approval", "decide"));

  const readableOrigins = subOrigins.filter((o) => (o === "hr" ? readableHr : readableOther));
  if (!readableOrigins.length) return { items: [], readable: false };

  const now = Date.now();
  const { rows } = await withTenants([tenantId], (c) =>
    c.query<{
      id: string; workflow_id: string; tool_name: string; impact: string; reason: string | null;
      tool_args: { href?: string } | null; origin: string; created_at: string; status: string;
    }>(
      `SELECT id, workflow_id, tool_name, impact, reason, tool_args, origin, created_at, status
       FROM automation_approvals
       WHERE deleted_at IS NULL AND origin = ANY($1::text[])
         AND ${status === "pending" ? "status = 'pending'" : "status IN ('approved','rejected')"}
       ORDER BY created_at DESC LIMIT 200`,
      [readableOrigins],
    ),
  );
  const items: UnifiedApprovalItem[] = rows.map((r) => {
    const ageMs = now - new Date(r.created_at).getTime();
    const origin = r.origin as ApprovalOrigin;
    return {
      id: r.id,
      origin,
      tenantId,
      company: companyName,
      subject: r.reason ?? `${r.tool_name} (${r.workflow_id})`,
      subjectHref: r.tool_args?.href,
      createdAt: iso(r.created_at),
      ageMs,
      urgencyScore: ORIGIN_BASE_WEIGHT[origin] + (IMPACT_BONUS[r.impact] ?? 0) + ageBonus(ageMs),
      decidable: origin === "hr" ? decidableHr : decidableOther,
      status: r.status,
    };
  });
  return { items, readable: true };
}

@Controller("api")
@UseGuards(AuthGuard)
export class ApprovalsController {
  @Get("approvals")
  async unified(
    @Req() req: FastifyRequest,
    @Query("scope") scopeRaw = "all",
    @Query("origin") originRaw?: string,
    @Query("status") statusRaw?: string,
    @Query("sort") sortRaw?: string,
  ): Promise<Envelope<UnifiedApprovalItem>> {
    const origins = parseOrigins(originRaw);
    const status = parseStatus(statusRaw);
    const sort = parseSort(sortRaw);

    // D-UX-2: fan out across the caller's OWN authorized companies (their live memberships),
    // exactly like service-scopes.ts / the ORG-7b envelope reads — never a client-supplied
    // arbitrary tenant set. scope=<companyId> narrows to ONE company (still soft-probed below,
    // never a hard 403, so a crafted/foreign id degrades to an excluded envelope entry instead of
    // leaking whether it exists).
    const scopeIds =
      scopeRaw === "all" ? [...new Set(req.principal.companies)] : [scopeRaw];

    const nameById = await namesFor(scopeIds);
    const items: UnifiedApprovalItem[] = [];
    const companies: EnvelopeCompany[] = [];

    for (const tenantId of scopeIds) {
      const companyName = nameById.get(tenantId) ?? "";
      try {
        let anyReadable = false;
        const wantsAgency = origins.includes("agency");
        const wantsPipeline = origins.includes("pipeline");
        const automationSubOrigins = origins.filter((o) => o === "automation" || o === "agent" || o === "hr");

        if (wantsAgency) {
          const leg = await agencyLeg(req.principal, tenantId, companyName, status);
          if (leg.readable) anyReadable = true;
          items.push(...leg.items);
        }
        if (wantsPipeline) {
          const leg = await pipelineLeg(req.principal, tenantId, companyName, status);
          if (leg.readable) anyReadable = true;
          items.push(...leg.items);
        }
        if (automationSubOrigins.length) {
          const leg = await automationLeg(req.principal, tenantId, companyName, status, automationSubOrigins);
          if (leg.readable) anyReadable = true;
          items.push(...leg.items);
        }

        if (!anyReadable) {
          // F1 (envelope hygiene): no name on an excluded entry.
          companies.push({ id: tenantId, included: false, reason: "no_access" });
          continue;
        }
        companies.push({ id: tenantId, name: companyName, included: true });
      } catch {
        // D-UX-2: a downed leg (e.g. a query error) is reported, never a request-wide 500 —
        // the OTHER tenants' legs still complete and return real data.
        companies.push({ id: tenantId, included: false, reason: "error" });
      }
    }

    items.sort((a, b) => (sort === "urgency" ? b.urgencyScore - a.urgencyScore : b.ageMs - a.ageMs));
    return { items, companies };
  }
}
