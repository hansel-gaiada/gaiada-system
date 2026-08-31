// WSK-31 — the Zone A HTTP surface backing the §07 WebDesk control-plane MCP tool set
// (docs/blueprints/webdesk-design.md §07/§09; index.ts's own WSK-31 section names every route).
//
// A SEPARATE controller from `WebdevController`/`ZoneBEventsController` (not an addition to either)
// — this ticket's hard constraints report edits to EXISTING files under this module directory and
// make them nowhere except index.ts; a new file is the additive path WSK-12 already established for
// exactly this situation (see zoneb-events.controller.ts's own header for the precedent).
//
// ── EVERY ROUTE HERE IS AN HONEST STUB, AND THAT IS DELIBERATE ─────────────────────────────────────
// WSK-23 (the ERP module egress client + BFF — mTLS + KC client-credentials + the §03 Layer-4 WS4
// assertion into Zone B) has not landed (PROGRESS.md Part D, 2026-08-27: still ⬜ NOT DONE, and this
// ticket's own dependency line names it: "WSK-21–23"). So there is genuinely no live channel from
// Zone A into Zone B for any of these commands to reach — WSK-22's own control channel is still
// "PROVISIONAL: built + agent-verified on WINDOWS", with no real `webdesk-control` Keycloak client
// minted yet. Every handler below therefore does the ONE thing that is honestly buildable today:
// it runs the REAL authz + WS4 gate BEFORE the platform would ever touch Zone B, then answers
// `501 webdesk_control_plane_not_wired` — the SAME "documented 501" shape WSK-21 already shipped
// for `site.archive`/`contract.read` (PROGRESS.md's WSK-21 row).
//
// WHY A REAL, CALLABLE ROUTE RATHER THAN AN `mcpTools` ENTRY WITH NO `pathTemplate` ("informational-
// only", `mcp-hub/src/module-tools.ts`'s own term for a tool nothing can call): an uncallable tool
// can never be driven through a genuine `authorize()`/`authorizeCall()` request, so this ticket's
// "test that matters" — proving reads are free, medium suspends automation only, HIGH suspends
// EVERY principal class — would only ever be assertable against a mock, not the real gate. A route
// that genuinely runs the gate and then 501s is honestly PROTOTYPED, not a lie:
// `modules/social/index.ts`'s own rule ("a declared tool whose endpoint does not exist is a lie the
// hub will happily publish") is about a tool with NO endpoint at all, not one whose endpoint is
// real but honestly unfinished.
//
// WHEN WSK-23 LANDS: replace the `NOT_WIRED` body below with the real Zone B egress call, per
// command. Nothing about the tool registrations (index.ts), the impact classes, the D14 registry
// entries (approval-executables.ts) or the Cerbos policy needs to change for that — this file is the
// ONLY thing that gets rewired.
//
// ── AUTHZ ────────────────────────────────────────────────────────────────────────────────────────
// `authorize()` runs against the EXISTING `webdev_provisioned_site` Cerbos kind, TWO NEW actions
// added additively (`operate` for the §07 MEDIUM commands, `promote` for the §07 HIGH ones — names
// taken verbatim from design §09's own description of the REAL eventual kind,
// "resource_webdesk_site (read/operate/promote)"). Reusing the sibling kind rather than standing up
// a brand-new `resource_webdesk_site` kind avoids the SIX-artifact cost (catalog + groups + a
// seeding migration + both bundle resolvers + a regenerated bundle) for a controller that is itself
// a placeholder; WSK-23 stands up the real kind and this file gets re-pointed at it, action names
// unchanged. See `resource_webdev_provisioned_site.yaml`'s own WSK-31 note for the company-scoped
// authz tiers this grants (company_admin/manager/module_manager) and for what it deliberately does
// NOT add (the IAM-04-ROLLOUT-B12 permission-mirror arm — flagged, not built, same call WSK-12 made
// for `resource_webdev_zoneb_event.yaml`'s own `record` action).
//
// Company-scoped authz here is NECESSARY but not SUFFICIENT for the seven HIGH commands — it only
// answers "is this principal a webdev operator in this tenant at all". The thing that makes them
// suspend for WS4 regardless of caller attendance is mcp-hub's `ALWAYS_WS4_TOOLS` gate
// (`mcp-hub/src/policy.ts`) + its Cerbos mirror (`resource_mcp_tool.yaml`) — enforced BEFORE the
// hub ever calls this endpoint, so this controller does not (and structurally cannot, today) verify
// WS4 status itself, matching every other MCP-fronted write tool in the estate (e.g.
// `webdev.provisionSite`'s own endpoint trusts the hub's gate + Cerbos the same way).
import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";

/** The one honest answer every route below gives. A typed `error` token (this estate's error
 *  envelope, `http-error.filter.ts`), not prose alone, so a caller (the hub, a future console) can
 *  branch on it rather than string-matching a sentence. */
const NOT_WIRED = {
  error: "webdesk_control_plane_not_wired",
  message:
    "The WebDesk Zone B control-plane egress client (WSK-23) has not landed yet. This command is " +
    "registered, impact-classified and WS4-gated (see webdesk-design.md §07), but there is no live " +
    "channel into Zone B for it to reach yet. See PROGRESS.md Part D.",
};

function siteResource(tenantId: string) {
  return { kind: "webdev_provisioned_site", tenantId, module: "webdev" } as const;
}

@Controller("api/:tenantId/modules/webdev/control")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class WebdeskControlController {
  // ── reads (§07: "read", Cerbos gate: `read`) ──────────────────────────────────────────────────
  @Get("sites")
  @HttpCode(501)
  async listSites(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "read");
    return NOT_WIRED;
  }

  @Get("sites/:siteId/status")
  @HttpCode(501)
  async siteStatus(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "read");
    return NOT_WIRED;
  }

  @Get("sites/:siteId/submissions")
  @HttpCode(501)
  async listSubmissions(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "read");
    return NOT_WIRED;
  }

  // ── low write, draft-only (§07: never suspends; still authz-gated as `operate`) ──────────────
  @Post("schema/propose")
  @HttpCode(501)
  async proposeSchema(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, siteResource(tenantId), "operate");
    requireObjectBody(body);
    return NOT_WIRED;
  }

  // ── medium writes (§07: WS4 for automation principals; Cerbos gate: `operate`) ────────────────
  @Post("schema/apply")
  @HttpCode(501)
  async applySchema(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, siteResource(tenantId), "operate");
    requireObjectBody(body);
    return NOT_WIRED;
  }

  @Post("sites")
  @HttpCode(501)
  async provisionSite(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, siteResource(tenantId), "operate");
    requireObjectBody(body);
    return NOT_WIRED;
  }

  @Post("sites/:siteId/deploy/staging")
  @HttpCode(501)
  async deployStaging(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "operate");
    return NOT_WIRED;
  }

  // ── HIGH writes (§07: ALWAYS WS4, every principal class; Cerbos gate: `promote`) ───────────────
  @Post("sites/:siteId/promote")
  @HttpCode(501)
  async promoteSite(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    return NOT_WIRED;
  }

  @Post("sites/:siteId/rollback")
  @HttpCode(501)
  async rollbackSite(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    return NOT_WIRED;
  }

  @Post("sites/:siteId/domain")
  @HttpCode(501)
  async setDomain(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    requireObjectBody(body);
    return NOT_WIRED;
  }

  @Post("sites/:siteId/keys")
  @HttpCode(501)
  async mintKey(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string, @Body() body: unknown) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    requireObjectBody(body);
    return NOT_WIRED;
  }

  @Post("keys/:keyId/rotate")
  @HttpCode(501)
  async rotateKey(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    return NOT_WIRED;
  }

  @Post("keys/:keyId/revoke")
  @HttpCode(501)
  async revokeKey(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    return NOT_WIRED;
  }

  @Post("sites/:siteId/archive")
  @HttpCode(501)
  async archiveSite(@Req() req: FastifyRequest, @Param("tenantId") tenantId: string) {
    await authorize(req.principal, siteResource(tenantId), "promote");
    return NOT_WIRED;
  }
}

/** Malformed input is refused before the (stub) domain layer, same discipline
 *  `zoneb-events.controller.ts` already applies — never a 500 for a body that is not an object. */
function requireObjectBody(body: unknown): void {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestException({ message: "expected a JSON object body" });
  }
}
