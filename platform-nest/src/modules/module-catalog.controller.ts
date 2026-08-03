// Module catalog: the list of modules COMPILED INTO this build, independent of any tenant's
// enable flag. The settings UI needs this because a module's row must stay visible after it is
// disabled — a UI that derives its list from companies.enabled_modules alone loses the row (and
// with it the only way back on) the moment you turn a module off.
//
// Read-only and tenant-agnostic (the registry is a compile-time artifact), so this is a plain
// AuthGuard route with no authorize() call and deliberately NO ModuleEnabledGuard: gating the
// catalog on enablement would reintroduce exactly the disappearing-row problem it exists to fix.
// Per-tenant enablement stays where it belongs — isModuleEnabled() at each module's controller.
import { Controller, ForbiddenException, Get, Param, Req, UseGuards } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { AuthGuard } from "../auth/guards";
import { allModules, enabledModuleKeys } from "./registry";

export interface ModuleCatalogEntry {
  key: string;
  /** First uiManifest label if the module declares one — a human-facing name for the toggle row. */
  label: string;
  /** Nav paths this module owns (uiManifest), so the UI can say what turning it off will dark. */
  paths: string[];
}

@Controller("api")
@UseGuards(AuthGuard)
export class ModuleCatalogController {
  @Get("module-catalog")
  catalog(): ModuleCatalogEntry[] {
    return allModules().map((m) => ({
      key: m.key,
      label: m.uiManifest[0]?.label ?? m.key,
      paths: m.uiManifest.map((u) => u.path),
    }));
  }

  /**
   * The EFFECTIVE module set for one company: its own `enabled_modules` plus anything served to it
   * by an active service_assignment (`enabledModuleKeys` — the same rule ModuleEnabledGuard
   * enforces, so a UI reading this can never disagree with what the API will allow).
   *
   * Membership-gated rather than authorize()'d: this is metadata about which surfaces exist, needed
   * by every page a member can already open — not company administration. A caller with no
   * membership in `tenantId` (and no global admin role) gets 403 rather than a list.
   */
  @Get(":tenantId/modules-enabled")
  async enabled(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
  ): Promise<{ tenantId: string; enabled: string[] }> {
    const isAdmin = req.principal.roles.some((r) => r.role === "platform_admin" && r.scopeType === "global");
    if (!isAdmin && !req.principal.companies.includes(tenantId)) {
      throw new ForbiddenException("not a member of this company");
    }
    return { tenantId, enabled: await enabledModuleKeys(tenantId) };
  }
}
