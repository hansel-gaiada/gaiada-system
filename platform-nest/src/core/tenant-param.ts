// ── THE `:tenantId` PATH PARAMETER IS A UUID, AND UNTIL NOW NOTHING SAID SO (2026-08-24) ─────────
//
// THE DEFECT. `/api/undefined/projects` and `/api/not-a-uuid/pm/tasks` both answered
// `500 [unhandled-exception]`. Nothing between the router and Postgres ever asked whether the
// segment was a company id: the raw text was carried into `withTenants([...])`, set as the
// `app.current_tenant_ids` GUC, and only died deep inside RLS when `app_current_tenants()` cast it
// to `uuid[]`. A caller's malformed input surfaced as a server fault — the wrong status, the wrong
// blame, and a stack trace in the log for something that is simply a bad request.
//
// `undefined` is not a hypothetical value. It is what a client produces when the id it meant to
// interpolate was absent, which is exactly the MCP-hub failure this shipped alongside — the hub's
// `String(args.tenantId)` on a missing argument. Both halves of that path are now closed: the hub
// refuses to send it, and the platform refuses to accept it.
//
// WHY A FASTIFY HOOK AND NOT A PIPE. `@Param("tenantId")` appears at **602 call sites** across
// every module. A `ParseUUIDPipe` would need adding to all of them, and — the part that actually
// matters — to every one written after today. This hook keys off the ROUTE having a `tenantId`
// param at all, so a controller added next month is covered because it named its parameter
// `tenantId`, not because someone remembered a pipe. Routes with no such param (`/api/admin/*`,
// `/api/me`, `/health`) never see it: Fastify's router prefers a static segment over a parametric
// one, so `request.params.tenantId` is undefined there and the hook returns immediately.
//
// ⚠ IT RUNS BEFORE THE AuthGuard, and that is a deliberate trade. Nest's guards execute inside the
// route handler, downstream of every Fastify hook, so a malformed path is refused before the caller
// is authenticated. The disclosure is that a route takes a tenant id — which the URL the caller
// just typed already told them — and the alternative is worse: 602 handlers each holding a live
// uuid cast reachable by an unauthenticated request.
//
// It is a SHAPE check, never an authorization one. A well-formed uuid for a company the caller may
// not touch still reaches Cerbos and RLS and is still denied there. Nothing here grants anything.

import type { FastifyInstance } from "fastify";

/** The route-parameter name every tenant-scoped controller uses (`@Controller("api/:tenantId/…")`). */
export const TENANT_PARAM = "tenantId";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Is this path segment shaped like a company id? Exported so a test can pin the shape without
 *  standing up an app, and so any future caller uses THIS predicate rather than a fifth copy of
 *  the regex. */
export function isTenantIdShaped(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Echo the offending value back so the caller can see what it actually sent — bounded and
 *  JSON-escaped, because it is attacker-controlled and ends up in a response body and a log line.
 *  A caller that sent 4 KB of junk gets told it sent junk, not shown all of it. */
function quoteForMessage(value: string): string {
  const clipped = value.length > 64 ? `${value.slice(0, 64)}…` : value;
  return JSON.stringify(clipped);
}

/**
 * Reject a malformed `:tenantId` with 400 before it can reach a uuid cast.
 *
 * Registered from `main.ts` alongside the other root-instance hooks and, like them, BEFORE
 * `app.init()`: Fastify snapshots the hook list into each route's context at registration time, so
 * a hook added after Nest registers its routes would silently apply to none of them.
 */
export function registerTenantParamValidation(fastify: FastifyInstance): void {
  fastify.addHook("preValidation", async (req, reply) => {
    const params = req.params as Record<string, unknown> | undefined;
    const raw = params?.[TENANT_PARAM];
    // Not a tenant-scoped route (or a router that produced no string) — nothing to say.
    if (typeof raw !== "string") return;
    if (isTenantIdShaped(raw)) return;
    // `{ error: msg }` — the shape every other error in this app uses; the UI and bot read `.error`.
    return reply
      .code(400)
      .send({ error: `invalid tenantId ${quoteForMessage(raw)}: expected a company uuid` });
  });
}
