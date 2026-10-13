// The AuthGuard populates request.principal; controllers read it. Ambient augmentation so
// every file sees the typed field (mirrors the Fastify core's `declare module`).
import type { Principal } from "./rbac/principal";

declare module "fastify" {
  interface FastifyRequest {
    principal: Principal;
    /** PV5-14: set by the AuthGuard ONLY on the OIDC bearer path (an interactive sign-in). `sessionRef` is the
     *  hashed (user, IdP session) reference a simulated step-up binds to; null when the token named no session.
     *  Undefined on every service-token path (OBO envelope, agent, D14 re-drive, dev x-user-id). */
    authSession?: { kind: "oidc"; sessionRef: string | null };
  }
}
