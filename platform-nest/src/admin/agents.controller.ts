// `GET /api/agents` — the seat registry, read-only (P1).
//
// This is what makes `agent_registry` REACHABLE. The migration (202608221745) created the table; the
// hub's `agents.list` needs to read it; and the hub has no database access by design ("Models come
// from the Gateway. Tools come from the MCP hub... There is no direct DB access"). So the router's
// "who can help with this?" question has to be answered here.
//
// ── WHY THIS IS NOT UNDER /api/:t/ ───────────────────────────────────────────────────────────────
// Nearly every business route in this platform is tenant-scoped. This one deliberately is not,
// because a seat's `company_scope` is its REACH, not its owner: a group-scoped seat (NULL) belongs to
// no tenant by construction, and the router must be able to see it. Forcing a tenant prefix would
// make group seats unaddressable and quietly under-route — a failure that reads as "the agent didn't
// know about that department" rather than as an authorization error.
//
// ── WHY NO RLS IS INVOLVED, AND WHY THAT IS SAFE ─────────────────────────────────────────────────
// `agent_registry` is a GLOBAL table (same posture as `permissions`, `roles`, `infra_hosts`), read
// via withGlobal(). It contains no business data — it is platform configuration describing our own
// workforce. The filtering below is therefore a CONVENIENCE for the caller, never the security
// boundary: what a seat may actually DO is decided by Cerbos at the point of action, and what a
// caller may see of a seat is bounded by requiring an authenticated principal to reach this route at
// all. Treat this endpoint as "the catalogue", not as an authorization surface.
import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { withGlobal } from "../db";

export interface AgentSeat {
  name: string;
  kind: "department" | "system" | "security" | "edge" | "external";
  /** null = group scope (cross-company). See the migration's note on the two partial unique indexes. */
  companyScope: string | null;
  capabilityTags: string[];
  toolNamespaces: string[];
  maxImpact: "read" | "low_write" | "medium_write" | "high_write";
  modelClass: string;
  enabled: boolean;
  version: number;
}

interface Row {
  name: string;
  kind: string;
  company_scope: string | null;
  capability_tags: string[] | null;
  tool_namespaces: string[] | null;
  max_impact: string;
  model_class: string;
  enabled: boolean;
  version: number;
}

@Controller("api/agents")
@UseGuards(AuthGuard)
export class AgentsController {
  /**
   * List seats the caller can address.
   *
   * `tenant` narrows to that company's seats PLUS the group-scoped ones — not instead of them. A
   * router asking "who serves company X" must still see the group seats that serve every company, or
   * it will conclude no one can help with anything cross-cutting.
   *
   * `enabled` defaults to TRUE. The disabled ones are real rows and deliberately fetchable, but a
   * router that offered them would route to a seat that cannot run — and `enabled=false` is the
   * program's kill switch, so honouring it by default is what makes the switch mean anything.
   */
  @Get()
  async list(
    @Req() _req: FastifyRequest,
    @Query("tenant") tenant?: string,
    @Query("capability") capability?: string,
    @Query("includeDisabled") includeDisabled?: string,
  ): Promise<{ seats: AgentSeat[] }> {
    const wantDisabled = includeDisabled === "true" || includeDisabled === "1";

    // Parameterised throughout. `capability_tags && $2` is the GIN-indexed array overlap, matching
    // the index the migration creates — a LIKE over a joined string would ignore it.
    const { rows } = await withGlobal((c) =>
      c.query<Row>(
        `SELECT name, kind, company_scope, capability_tags, tool_namespaces, max_impact, model_class,
                enabled, version
           FROM agent_registry
          WHERE ($1::uuid IS NULL OR company_scope = $1::uuid OR company_scope IS NULL)
            AND ($2::text[] IS NULL OR capability_tags && $2::text[])
            AND ($3::boolean OR enabled)
          ORDER BY kind, name`,
        [tenant ?? null, capability ? [capability] : null, wantDisabled],
      ),
    );

    return {
      seats: rows.map((r) => ({
        name: r.name,
        kind: r.kind as AgentSeat["kind"],
        companyScope: r.company_scope,
        capabilityTags: r.capability_tags ?? [],
        // Returned so the ROUTER can explain its choice, and so a mismatch between what a seat
        // advertises and what the hub actually serves it becomes visible rather than silent. It is
        // NOT an authorization statement: the hub's own tool view and Cerbos decide reach.
        toolNamespaces: r.tool_namespaces ?? [],
        maxImpact: r.max_impact as AgentSeat["maxImpact"],
        modelClass: r.model_class,
        enabled: r.enabled,
        version: r.version,
      })),
    };
  }
}
