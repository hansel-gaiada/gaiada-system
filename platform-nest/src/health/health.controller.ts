import { Controller, Get } from "@nestjs/common";
import { allModules } from "../modules/registry";
import { isSocialSimulationEnabled } from "../modules/social/publisher/simulation";
import { realPublisherKey } from "../modules/social/publisher/registry";

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
//
// SCP-Sa2 (owner ruling SCP-D9): the simulator now runs BESIDE a real publishing engine, so `socialPublisher` says which
// real engine this process registered ('postiz' | 'mixpost' | 'none'), never its URL or key. Additive and always
// present. `socialSimulation: true` with `socialPublisher: 'postiz'` is the side-by-side mode.
@Controller()
export class HealthController {
  @Get("health")
  health(): {
    ok: true; version: string; modules: string[]; socialSimulation: boolean; socialPublisher: "postiz" | "mixpost" | "none";
  } {
    return {
      ok: true,
      version: APP_VERSION,
      modules: allModules().map((m) => m.key),
      socialSimulation: isSocialSimulationEnabled(),
      socialPublisher: realPublisherKey(),
    };
  }
}
