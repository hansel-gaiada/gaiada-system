// The AuthGuard populates request.principal; controllers read it. Ambient augmentation so
// every file sees the typed field (mirrors the Fastify core's `declare module`).
import type { Principal } from "./rbac/principal";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
  }
}
