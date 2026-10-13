// PV5-14 / owner ruling PV-D40 — the SIMULATED second factor's two routes (dev stage only). The mechanism and
// every property it keeps narrow are explained in ./step-up.ts; this file is only the HTTP surface.
//
//   GET  /api/auth/step-up            -> { available, reason?, active, simulated, expiresAt, assurance, ttlSeconds }
//   POST /api/auth/step-up/simulate   body { confirm: true }
//                                     -> 200 { active: true, simulated: true, expiresAt, assurance: "high",
//                                              assuranceSource: "simulated" }
//
// Both answer 404 while `MFA_SIMULATION_ENABLED` is off (the flag guard runs BEFORE authentication, so an off
// flag is indistinguishable from a route that does not exist, for everyone).
//
// Not tenant-scoped on purpose: a step-up belongs to a person's sign-in session, not to a company. What IS
// per company is the audit: one `auth.step_up_simulated` row in every company the person is staff of.
//
// Refusals (403 unless noted; `reason` is the machine code, `error` the sentence):
//   step_up_interactive_only    not an interactive sign-in: an OBO envelope, an agent, a D14 re-drive, the dev
//                               header or any other service-token path. An agent never inherits a human's step-up.
//   step_up_not_for_automation  an `automation` or `bot` account.
//   step_up_staff_only          a portal (client) principal: `users.kind` other than `employee`, no grant outside
//                               the client-side roles, or no active staff membership.
//   already_high_assurance      409: the session already holds a REAL second factor; nothing to simulate.
//   session_unbound             409: the IdP token names no session (`sid` / `session_state`), so a step-up
//                               could not be bound to this session alone. Fails closed.
//   step_up_store_unavailable   503: no REDIS_URL / Redis unreachable.
// Authorization runs before validation: `confirm` is checked last (400, field `confirm`).
import {
  BadRequestException, Body, CanActivate, ConflictException, Controller, ForbiddenException, Get, HttpCode,
  Injectable, NotFoundException, OnModuleInit, Post, Req, ServiceUnavailableException, UseGuards,
} from "@nestjs/common";
import type { FastifyRequest } from "fastify";
import { config } from "../config";
import { withGlobal } from "../db";
import { writeActivity } from "../core/http";
import { AuthGuard } from "./guards";
import type { Principal } from "../rbac/principal";
import { STEP_UP_TTL_MS, clearSimulatedStepUp, readActiveStepUp, recordSimulatedStepUp } from "./step-up";

/** Runs BEFORE AuthGuard: flag off => 404 for every caller, authenticated or not. */
@Injectable()
export class MfaSimulationFlagGuard implements CanActivate {
  canActivate(): boolean {
    if (!config.mfaSimulationEnabled) throw new NotFoundException("not found");
    return true;
  }
}

/** The client-side grant roles, as platform-ui's `CLIENT_SIDE_ROLES` (lib/rbac.ts) names them. */
const CLIENT_SIDE_ROLES: ReadonlySet<string> = new Set(["client", "client_website_editor"]);

type Refusal = { status: 403 | 409; reason: string; message: string };

const REFUSE = {
  interactive: {
    status: 403, reason: "step_up_interactive_only",
    message: "a second factor can only be simulated from your own signed-in session; agents, automations, chat channels and re-driven approvals never can",
  },
  automation: {
    status: 403, reason: "step_up_not_for_automation",
    message: "automation and bot accounts can never hold a second factor, simulated or real",
  },
  staff: {
    status: 403, reason: "step_up_staff_only",
    message: "only staff can simulate a second factor",
  },
  alreadyHigh: {
    status: 409, reason: "already_high_assurance",
    message: "this session already holds a real second factor; there is nothing to simulate",
  },
  unbound: {
    status: 409, reason: "session_unbound",
    message: "your sign-in carries no session id, so a simulated second factor could not be bound to this session alone; sign in again",
  },
} satisfies Record<string, Refusal>;

/** The companies this person is STAFF of (active membership in a live company). Memberships are FORCE-RLS behind
 *  the `principal_lookup` policy, so the read sets `app.principal_user_id` in its own transaction, exactly as
 *  `assemblePrincipal()` does. Client-contact companies are deliberately NOT included. */
async function staffCompanies(userId: string): Promise<string[]> {
  return withGlobal(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("SELECT set_config('app.principal_user_id', $1, true)", [userId]);
      const r = await c.query<{ tenant_id: string }>(
        `SELECT DISTINCT m.tenant_id FROM company_memberships m JOIN companies co ON co.id = m.tenant_id
          WHERE m.user_id = $1 AND m.status = 'active' AND m.deleted_at IS NULL AND co.deleted_at IS NULL
          ORDER BY m.tenant_id`,
        [userId],
      );
      await c.query("COMMIT");
      return r.rows.map((x) => x.tenant_id);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  });
}

/** Who may simulate, decided in the order the ticket names: interactive session, human, staff, state. Returns the
 *  first refusal, or the staff companies (for the audit rows) and the session reference. */
async function eligibility(req: FastifyRequest): Promise<
  { ok: false; refusal: Refusal } | { ok: true; companies: string[]; sessionRef: string; principal: Principal }
> {
  const p = req.principal;
  const session = req.authSession;
  // Interactive only: the AuthGuard sets `authSession` on the OIDC bearer path alone. `via`/`actFor` can never
  // be present there; checked anyway so a future path that sets both cannot open this.
  if (session?.kind !== "oidc" || !p.userId || p.via || p.actFor) return { ok: false, refusal: REFUSE.interactive };
  if (p.kind === "automation" || p.kind === "bot") return { ok: false, refusal: REFUSE.automation };
  if (p.kind !== "employee") return { ok: false, refusal: REFUSE.staff };
  // A portal contact whose account kind was never set to `client` is still not staff: it must hold at least one
  // grant outside the client-side roles (the UI's `isStaff`, platform-ui lib/rbac.ts CLIENT_SIDE_ROLES).
  if (!p.roles.some((g) => !CLIENT_SIDE_ROLES.has(g.role))) return { ok: false, refusal: REFUSE.staff };
  const companies = await staffCompanies(p.userId);
  if (companies.length === 0) return { ok: false, refusal: REFUSE.staff };
  if (p.assurance === "high" && p.assuranceSource !== "simulated") return { ok: false, refusal: REFUSE.alreadyHigh };
  if (p.assurance === "low") return { ok: false, refusal: REFUSE.interactive };
  const sessionRef = session.sessionRef;
  if (!sessionRef) return { ok: false, refusal: REFUSE.unbound };
  return { ok: true, companies, sessionRef, principal: p };
}

function throwRefusal(r: Refusal): never {
  if (r.status === 409) throw new ConflictException({ message: r.message, reason: r.reason });
  throw new ForbiddenException({ message: r.message, reason: r.reason });
}

@Controller("api")
export class StepUpController implements OnModuleInit {
  onModuleInit(): void {
    // Loud on boot, so an ERP that still has the simulation on is visible in the logs of every start.
    if (config.mfaSimulationEnabled) {
      console.warn(
        "[auth:mfa-simulation-enabled] MFA_SIMULATION_ENABLED is ON (PV-D40, dev stage only): staff can raise their " +
          "own session to high assurance with a SIMULATED second factor for 15 minutes. Turn it off before real client data.",
      );
    }
  }

  @Get("auth/step-up")
  @UseGuards(MfaSimulationFlagGuard, AuthGuard)
  async status(@Req() req: FastifyRequest) {
    const p = req.principal;
    const e = await eligibility(req);
    // An already-SIMULATED session stays available (simulating again restarts the 15 minutes); a REAL second
    // factor is not (`already_high_assurance`).
    let available = e.ok;
    let reason: string | undefined = e.ok ? undefined : e.refusal.reason;
    if (available && !config.redisUrl) {
      available = false;
      reason = "step_up_store_unavailable";
    }
    return {
      available,
      ...(reason ? { reason } : {}),
      active: p.assurance === "high",
      simulated: p.assuranceSource === "simulated",
      expiresAt: p.assuranceSource === "simulated" ? p.assuranceExpiresAt ?? null : null,
      assurance: p.assurance,
      ttlSeconds: STEP_UP_TTL_MS / 1000,
    };
  }

  @Post("auth/step-up/simulate")
  @HttpCode(200)
  @UseGuards(MfaSimulationFlagGuard, AuthGuard)
  async simulate(@Req() req: FastifyRequest, @Body() body: { confirm?: unknown } | undefined) {
    const e = await eligibility(req);
    if (!e.ok) throwRefusal(e.refusal);
    // Validation only after every authorization decision above.
    if (body?.confirm !== true) {
      throw new BadRequestException({ message: "confirm the simulated second factor with { confirm: true }", field: "confirm" });
    }
    if (!config.redisUrl) {
      throw new ServiceUnavailableException({ message: "the step-up store is not configured (REDIS_URL)", reason: "step_up_store_unavailable" });
    }
    const userId = e.principal.userId as string;
    let rec;
    try {
      rec = await recordSimulatedStepUp(userId, e.sessionRef);
    } catch (err) {
      console.error(`[auth:step-up-store] could not record a simulated step-up: ${(err as Error).message}`);
      throw new ServiceUnavailableException({ message: "the step-up store is unavailable; try again", reason: "step_up_store_unavailable" });
    }
    // The audit is part of the step-up: if it cannot be written, the step-up is withdrawn and the call fails.
    try {
      for (const tenantId of e.companies) {
        await writeActivity(tenantId, userId, "auth.step_up_simulated", "user", userId, {
          simulated: true,
          assuranceSource: "simulated",
          expiresAt: rec.expiresAt,
          ttlSeconds: STEP_UP_TTL_MS / 1000,
          // A short, non-reversible prefix of the hashed (user, IdP session) reference: enough to tell two
          // step-ups of one person apart in the audit, never the session id itself.
          session: e.sessionRef.slice(0, 12),
          ruling: "PV-D40",
        });
      }
    } catch (err) {
      await clearSimulatedStepUp(e.sessionRef);
      throw err;
    }
    // Once per step-up (this route), never per request.
    console.warn(
      `[auth:mfa-simulated] user=${userId} session=${e.sessionRef.slice(0, 12)} expiresAt=${rec.expiresAt} ` +
        `companies=${e.companies.length} (PV-D40 simulated second factor, dev stage)`,
    );
    // Read back through the same check every later request uses, so the answer cannot claim more than the
    // next request will see.
    const active = await readActiveStepUp(userId, e.sessionRef);
    return {
      active: !!active,
      simulated: true,
      expiresAt: rec.expiresAt,
      assurance: active ? "high" : e.principal.assurance,
      assuranceSource: "simulated",
    };
  }
}
