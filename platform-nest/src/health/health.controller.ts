import { Controller, Get } from "@nestjs/common";
import { allModules } from "../modules/registry";

// Root-level health (matches the Fastify server's GET /health { ok, modules }). modules =
// the registry's compiled-in + registered module keys.
@Controller()
export class HealthController {
  @Get("health")
  health(): { ok: true; modules: string[] } {
    return { ok: true, modules: allModules().map((m) => m.key) };
  }
}
