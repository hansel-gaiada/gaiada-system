import { Controller, Get } from "@nestjs/common";
import { allModules } from "../modules/registry";
import { isSocialSimulationEnabled } from "../modules/social/publisher/simulation";

// The app version this build reports (docs/modules/VERSIONING.md). Set from /VERSION at deploy
// time. Deliberately "unknown" when unset rather than a hardcoded default: a build that cannot
// state its version should say so, not quietly claim to be something it isn't.
const APP_VERSION = process.env.APP_VERSION?.trim() || "unknown";

// Root-level health (matches the Fastify server's GET /health { ok, modules }). modules =
// the registry's compiled-in + registered module keys.
//
// SCP-Sa (plan §8, SCP-S "Sa"): `socialSimulation` says whether the SOCIAL SIMULATOR is switched on
// (SOCIAL_SIMULATION_ENABLED, dev review only). Additive and always present (a real boolean, never absent), so a
// monitor or an operator can see from outside that a server is still simulating publishes before it holds real data.
// Read at call time, like every other reader of the switch.
@Controller()
export class HealthController {
  @Get("health")
  health(): { ok: true; version: string; modules: string[]; socialSimulation: boolean } {
    return {
      ok: true,
      version: APP_VERSION,
      modules: allModules().map((m) => m.key),
      socialSimulation: isSocialSimulationEnabled(),
    };
  }
}
