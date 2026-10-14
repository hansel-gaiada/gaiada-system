// DW-8i (docs/FRONTEND-BFF-CONTRACT.md §46) — knowledge search for staff.
//
//   GET /api/:tenantId/knowledge/search?q=&limit=
//
// The route is a thin shell round `search-filter.ts`, which is where the rule lives: every hit the store returns is re-checked
// against the caller's READ right on its source record before it is shown (D-UX-2, never widen visibility), and a family with no
// such check is never returned. Gate: `activity` · `read` on the tenant, the gate `GET :tenantId/knowledge/sources` uses; there is
// no new Cerbos kind. The query text is never written to the activity or audit logs (it can carry personal data, and a search is
// not an action on a record): nothing here logs it, and `authorize()` audits only a denial, by action and kind.
import { BadRequestException, Controller, Get, Param, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../../auth/guards";
import { authorize } from "../../core/http";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { KnowledgeUnavailableError, searchKnowledgeStrict } from "../search/knowledge-client";
import { lastIngestRun } from "./ingest/scheduler";
import { collapseHits, filterReadableHits, searchTopK, snippetOf } from "./search-filter";

const Q_MIN = 2;
const Q_MAX = 200;
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 20;

/** `limit` is 1 to 20, default 10. A value that is not a whole number falls back to the default; a number outside the range is clamped. */
function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,6}$/.test(raw.trim())) return LIMIT_DEFAULT;
  return Math.min(Math.max(Number(raw.trim()), 1), LIMIT_MAX);
}

/** The last successful internal-tier sweep's finish time for this company, or null (no sweep yet, or the last one had errors). */
function indexedAtFor(tenantId: string): string | null {
  const r = lastIngestRun().results.find((x) => x.tier === "internal" && x.tenantId === tenantId);
  return r && r.errors.length === 0 && r.finishedAt ? r.finishedAt : null;
}

@Controller("api")
@UseGuards(AuthGuard)
export class KnowledgeSearchController {
  @Get(":tenantId/knowledge/search")
  @UseGuards(ModuleEnabledGuard("knowledge"))
  async search(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Query("q") qRaw?: unknown, @Query("limit") limitRaw?: unknown) {
    // Authorise first: the query is validated AFTER, so validation never pre-empts a 403.
    await authorize(req.principal, { kind: "activity", tenantId }, "read");
    const q = typeof qRaw === "string" ? qRaw.trim() : "";
    if (q.length < Q_MIN || q.length > Q_MAX) throw new BadRequestException("query_invalid");
    const limit = parseLimit(limitRaw);

    let hits;
    try {
      hits = await searchKnowledgeStrict(req.principal.userId ?? "", q, searchTopK(limit));
    } catch (e) {
      if (e instanceof KnowledgeUnavailableError) throw new ServiceUnavailableException("knowledge_unavailable");
      throw e;
    }

    const allowed = await filterReadableHits(req.principal, tenantId, collapseHits(hits, tenantId));
    return {
      query: q,
      results: allowed.slice(0, limit).map((a) => ({
        sourceRef: a.candidate.hit.sourceRef,
        family: a.candidate.family,
        title: a.title,
        snippet: snippetOf(a.candidate.hit.text),
        href: a.href,
        score: a.candidate.hit.score,
      })),
      indexedAt: indexedAtFor(tenantId),
    };
  }
}
