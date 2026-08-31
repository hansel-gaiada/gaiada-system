// WSK-19 — the mirror's HTTP surface (design §06's "Zone A end").
//
//   POST /api/:tenantId/modules/webdev/contracts/refresh  -> 201 | 200 | 409 | 502 | 503
//   GET  /api/:tenantId/modules/webdev/contracts[?slug=]  -> 200 [snapshot]
//
// A SEPARATE controller from `WebdevController` and `ZoneBEventsController` (not an addition to
// either) — `WebdevController` lives under `src/modules/webdev/`, which this ticket's hard
// constraints forbid editing, and `ZoneBEventsController` is a different concurrent ticket's owned
// file. Nest has no trouble registering multiple controller classes on the SAME `@Controller()`
// path prefix as long as their own route sets are disjoint (`ZoneBEventsController`'s own header
// already establishes this precedent for this exact prefix), which they are here.
//
// ── AUTHZ NOTE ──────────────────────────────────────────────────────────────────────────────────
// `authorize()` runs against the NEW Cerbos resource kind `webdev_contract_snapshot`
// (resource_webdev_contract_snapshot.yaml, this ticket's own new file). UNLIKE the zoneb-events
// intake, a human calling `refresh` directly IS an ordinary staff action (design §08's button
// matrix) — the WS4 suspension only applies when an AUTOMATION principal calls the MCP tool
// (`webdev.refreshContract`, impact:"medium" on the ModuleContract), which is D14's job, not this
// controller's.
//
// ── THE ERROR ENVELOPE (`../../http-error.filter.ts`, an EXISTING shared file this ticket does
//    NOT edit) ─────────────────────────────────────────────────────────────────────────────────
// A thrown exception's `message` field is what survives, renamed to `error` in the response body —
// "Throwers set `message`, not `error`" is a standing estate lesson (a prior ticket lost every
// typed token to this exact rename). Every OTHER key on the thrown body is DROPPED unless it is
// one of the filter's explicit additive passthroughs (`field`, `existing`, `site`). So: the
// determinism-breach body below reuses `existing` — genuinely apt here, it IS the existing row's
// data, the same shape MI-03's triage 409 established the precedent for. The hash-mismatch body
// carries no second object (there is no "existing" anything to show a transport-corruption
// caller) — its full diagnostic detail (claimedHash/recomputedHash) stays a SERVICE-level contract
// (`RefreshOutcome`), asserted directly in `contract-snapshot.service.test.ts`; the HTTP layer's
// job is only the status code + the token, per this file's own test.
import { BadRequestException, BadGatewayException, ConflictException, Body, Controller, Get, Param, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { authorize } from "../../core/http";
import { AuthGuard } from "../../auth/guards";
import { ModuleEnabledGuard } from "../module-enabled.guard";
import { createWebdevControlHttpDriver } from "./contract-fetch-http";
import { ContractControlNotConfiguredError, type WebdevControlProvider } from "./contract-fetch-provider";
import { refreshContractSnapshot, listContractSnapshots, WebdevControlEgressError, type SnapshotDto } from "./contract-snapshot.service";

/** Test seam, matching `WebdevController`'s own `setProvisionProviderForTests` precedent — never
 *  set in production. */
let providerOverride: WebdevControlProvider | null = null;
export function setWebdevControlProviderForTests(p: WebdevControlProvider | null): void {
  providerOverride = p;
}

function resolveProvider(): WebdevControlProvider {
  if (providerOverride) return providerOverride;
  try {
    return createWebdevControlHttpDriver();
  } catch (err) {
    if (err instanceof ContractControlNotConfiguredError) {
      throw new ServiceUnavailableException("webdev control channel not configured");
    }
    throw err;
  }
}

const SLUG_RE = /^[a-z0-9-]{1,63}$/;

@Controller("api/:tenantId/modules/webdev")
@UseGuards(AuthGuard, ModuleEnabledGuard("webdev"))
export class ContractSnapshotsController {
  @Get("contracts")
  async list(
    @Req() req: FastifyRequest,
    @Param("tenantId") tenantId: string,
    @Query("slug") slug?: string,
  ): Promise<SnapshotDto[]> {
    await authorize(req.principal, { kind: "webdev_contract_snapshot", tenantId, module: "webdev" }, "read");
    return listContractSnapshots(tenantId, slug);
  }

  /**
   * The rail's Zone A end (design §06). Returns 201 for a brand-new (slug, version) row and
   * **200 for an idempotent replay** — a re-fetch of a version already on file, whose recomputed
   * hash MATCHES what is stored, changes nothing and is not an error.
   *
   * THE TWO TRIPWIRES (ticket's own emphasis):
   *   - hash_mismatch      -> 502 (Zone B's own claim disagrees with what we downloaded — a
   *                           transport-layer/upstream-integrity problem, not a client error).
   *   - determinism_breach -> 409, but ALSO an outbox event + a severity:"critical" activity row
   *                           (the service's own job) — "alerting, not merely 4xx" per the ticket.
   */
  @Post("contracts/refresh")
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param("tenantId") tenantId: string,
    @Body() body: { slug?: string },
  ): Promise<SnapshotDto> {
    await authorize(req.principal, { kind: "webdev_contract_snapshot", tenantId, module: "webdev" }, "refresh");

    const slug = body?.slug?.trim().toLowerCase() ?? "";
    if (!SLUG_RE.test(slug)) throw new BadRequestException("slug is required (^[a-z0-9-]{1,63}$)");

    const provider = resolveProvider();
    let outcome;
    try {
      outcome = await refreshContractSnapshot({ tenantId, slug, fetchedBy: req.principal.userId, provider });
    } catch (err) {
      if (err instanceof WebdevControlEgressError) {
        throw new BadGatewayException({ message: "webdev_control_egress_error", detail: err.message });
      }
      throw err;
    }

    switch (outcome.outcome) {
      case "created":
        reply.status(201);
        return outcome.snapshot;
      case "idempotent":
        reply.status(200);
        return outcome.snapshot;
      case "hash_mismatch":
        // Tripwire (a): transport corruption between Zone B's claim and what we downloaded. An
        // upstream-integrity failure, not a client-input error — 502, not 4xx-for-bad-input. The
        // token itself (`error: "contract_hash_mismatch"`) is what survives the shared error
        // filter's reshape — see this file's own header note.
        throw new BadGatewayException({ message: "contract_hash_mismatch" });
      case "determinism_breach":
        // Tripwire (b): ALREADY alerted (event + activity) inside the service. The HTTP status is
        // secondary to that — 409 because the caller's request cannot be fulfilled as an ordinary
        // idempotent replay, not because this is a routine conflict. `existing` is the ONE extra
        // object the shared filter forwards (see header note) — reused here for the row this
        // refresh collided with.
        throw new ConflictException({
          message: "contract_determinism_breach",
          existing: {
            snapshotId: outcome.existingSnapshotId,
            existingHash: outcome.existingHash,
            recomputedHash: outcome.recomputedHash,
            contractVersion: outcome.contractVersion,
          },
        });
      default: {
        const never: never = outcome;
        throw new Error(`unhandled refresh outcome: ${JSON.stringify(never)}`);
      }
    }
  }
}
