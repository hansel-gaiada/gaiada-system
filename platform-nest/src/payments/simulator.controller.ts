// PV-D41 — the simulated Midtrans' own HTTP API: the three routes the real adapter (midtrans.ts) calls, served by
// platform-nest itself under /internal/ (nginx sends only /api/ paths to platform-nest, so this is reachable on loopback
// and the compose network, not from the internet). Same shapes, same HTTP Basic (server key, empty password) as Midtrans.
//
//   POST /internal/payments/midtrans-sim/snap/v1/transactions   -> 201 {token, redirect_url}  (Snap create)
//   GET  /internal/payments/midtrans-sim/v2/:orderId/status     -> 200 status body | 404 no transaction yet
//   POST /internal/payments/midtrans-sim/v2/:orderId/expire     -> 200 | 404 | 412 (settled)
//
// Every route answers 404 unless the simulated Midtrans is the configured provider (PAYMENTS_SIMULATION_ENABLED=1 AND
// MIDTRANS_ENVIRONMENT=simulated), and 401 to a wrong key, before reading anything. The merchant company is
// MIDTRANS_TENANT_ID (the simulator stands in for that company's merchant account).
import { Body, Controller, Get, NotFoundException, Param, Post, Req, Res, UnauthorizedException } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { configuredProvider, SIMULATOR_PATH } from "./registry";
import { simCreate, simExpire, simStatus, simulatorAuthorized } from "./simulator";

function activeTenant(req: FastifyRequest): string {
  const gw = configuredProvider("midtrans");
  if (!gw || gw.provider.environment !== "simulated") throw new NotFoundException("not found");
  const h = req.headers.authorization;
  if (!simulatorAuthorized(Array.isArray(h) ? h[0] : h)) throw new UnauthorizedException("unauthorized");
  return gw.tenantId;
}

@Controller(SIMULATOR_PATH.replace(/^\//, ""))
export class MidtransSimulatorController {
  @Post("snap/v1/transactions")
  async create(@Req() req: FastifyRequest, @Body() body: unknown, @Res() res: FastifyReply) {
    const tenantId = activeTenant(req);
    const out = await simCreate(tenantId, body);
    return res.status(out.status).send(out.json);
  }

  @Get("v2/:orderId/status")
  async status(@Req() req: FastifyRequest, @Param("orderId") orderId: string, @Res() res: FastifyReply) {
    const tenantId = activeTenant(req);
    const out = await simStatus(tenantId, orderId);
    return res.status(out.status).send(out.json);
  }

  @Post("v2/:orderId/expire")
  async expire(@Req() req: FastifyRequest, @Param("orderId") orderId: string, @Res() res: FastifyReply) {
    const tenantId = activeTenant(req);
    const out = await simExpire(tenantId, orderId);
    return res.status(out.status).send(out.json);
  }
}
