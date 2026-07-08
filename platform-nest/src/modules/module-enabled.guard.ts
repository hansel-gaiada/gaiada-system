// Per-tenant module enable gate (Nest port of server.ts's module preHandler). A module
// controller mounts under /api/:tenantId/modules/<key>; this guard 404s if the tenant hasn't
// enabled that module (companies.enabled_modules), exactly like the Fastify server.
import { CanActivate, ExecutionContext, Injectable, NotFoundException } from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { isModuleEnabled } from "./registry";

/** Factory: a guard bound to a specific module key (each vertical is its own Nest module). */
export function ModuleEnabledGuard(moduleKey: string): new () => CanActivate {
  @Injectable()
  class Guard implements CanActivate {
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
      const req = ctx.switchToHttp().getRequest<FastifyRequest>();
      const tenantId = (req.params as { tenantId?: string }).tenantId ?? "";
      if (!(await isModuleEnabled(tenantId, moduleKey))) {
        throw new NotFoundException(`module ${moduleKey} not enabled for this company`);
      }
      return true;
    }
  }
  return Guard;
}
