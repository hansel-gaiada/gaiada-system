import { Controller, Get } from "@nestjs/common";
import { allModules } from "../modules/registry";

// The app version this build reports (docs/modules/VERSIONING.md). Set from /VERSION at deploy
// time. Deliberately "unknown" when unset rather than a hardcoded default: a build that cannot
// state its version should say so, not quietly claim to be something it isn't.
const APP_VERSION = process.env.APP_VERSION?.trim() || "unknown";

// Root-level health (matches the Fastify server's GET /health { ok, modules }). modules =
// the registry's compiled-in + registered module keys.
@Controller()
export class HealthController {
  @Get("health")
  health(): { ok: true; version: string; modules: string[] } {
    return { ok: true, version: APP_VERSION, modules: allModules().map((m) => m.key) };
  }
}
