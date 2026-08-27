import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { AuditModule } from "../audit/audit.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { TenantsModule } from "../tenants/tenants.module";
// WSK-15 — ContractController's real dependency (ContractReadService). ControlModule already
// declares ContractController in `controllers` (WSK-21); Nest resolves a controller's
// constructor params from THIS module's own providers or its imported modules' exports, so
// ContractController cannot receive ContractReadService without this import. See this ticket's
// final report for why editing control.module.ts (rather than only contract.controller.ts) was
// necessary despite the ticket's ownership list naming only the controller file.
import { CodegenModule } from "../codegen/codegen.module";

import { CommandAuditService } from "./command-audit.service";
import { IdempotencyStore } from "./idempotency/idempotency-store";
import { JobsService } from "./jobs/jobs.service";

import { CONTROL_CHANNEL_AUTHENTICATOR } from "./auth/control-channel-authenticator";
import { DevModeControlChannelAuthenticator } from "./auth/dev-mode-control-channel-authenticator";
import { RealControlChannelAuthenticator } from "./auth/real-control-channel-authenticator";
import { ControlAuthGuard } from "./auth/control-auth.guard";

import { POLICY_DECISION_POINT } from "./policy/policy-decision-point";
import { DevModePolicyDecisionPoint } from "./policy/dev-mode-policy-decision-point";
import { RealPolicyDecisionPoint } from "./policy/real-policy-decision-point";
import { CommandAuthorizationGuard } from "./policy/command-authorization.guard";

import { RELEASE_TRANSPORT } from "./release/release-transport";
import { NotYetAvailableReleaseTransport } from "./release/not-yet-available-release-transport";

import { LifecycleService } from "./lifecycle/lifecycle.service";
import { LifecycleController } from "./lifecycle/lifecycle.controller";
import { SchemaService } from "./schema/schema.service";
import { SchemaController } from "./schema/schema.controller";
import { KeysCommandService } from "./keys/keys-command.service";
import { KeysController } from "./keys/keys.controller";
import { ReleasesCommandService } from "./releases/releases-command.service";
import { ReleasesController } from "./releases/releases.controller";
import { JobsController } from "./jobs/jobs.controller";
import { ContractController } from "./contract/contract.controller";

/**
 * ============================================================================================
 * WSK-21 — Control-plane API v1 (Zone B). LOUD WARNING, restated once at the module root: every
 * route this module registers is a Zone B CONTROL-PLANE command (design §03/§07/§08's C-05
 * command set — lifecycle · schema · keys · release · rebuild — plus the §06 contract-read
 * extension).
 *
 * WSK-22 — `CONTROL_CHANNEL_AUTHENTICATOR` and `POLICY_DECISION_POINT` are now bound
 * ENVIRONMENT-CONDITIONALLY: `RealControlChannelAuthenticator`/`RealPolicyDecisionPoint` (synccert
 * mTLS + offline-JWKS-verified Keycloak client-credentials token + Layer-3 scope check + a real
 * HMAC-verified, single-use WS4 assertion — see auth/real-control-channel-authenticator.ts and
 * policy/real-policy-decision-point.ts) for every environment EXCEPT `NODE_ENV=test`, where the
 * DEV-MODE STUBS stay bound so WSK-21's own existing 36 tests (test/control-authz.spec.ts,
 * control-commands.spec.ts, control-jobs.spec.ts — none of which this ticket may edit, and all of
 * which assert against the dev-mode header contract) keep passing UNCHANGED. This mirrors an
 * already-established convention in this exact codebase (../app.ts's own
 * `NODE_ENV === "test" ? ... : ...` logger switch; ../config.ts's `requireInProd`).
 * test/control-auth-*.spec.ts (WSK-22's own adversarial suite) forces the REAL implementations
 * regardless of NODE_ENV via NestJS's `overrideProvider(...).useClass(...)` — see that file.
 *
 * A Zone B Cerbos sidecar (design §03 Layer 3 / D-11) is still NOT stood up — RealPolicyDecisionPoint
 * does the token-scope check locally, same as the dev-mode stub did, per this ticket's own brief
 * ("Layer 3 ... via WSK-21's PolicyDecisionPoint", not "stand up Cerbos"). The sidecar container
 * itself remains `webdesk/docker-compose.yml` + `webdesk/cerbos/`-shaped work outside this
 * ticket's scope (WSK-21's own README already flagged this the same way; WSK-31 is where a real
 * Cerbos `check()` call swaps in behind this same interface).
 *
 * STILL NOT wired into ../app.module.ts — that file is out of this ticket's owned scope
 * (`control/auth/**`, `control/policy/**` only, per the ticket's hard constraints). See
 * ../../README.md's "WSK-22" section for the exact required changes (the app.module.ts import
 * line, the Caddyfile control vhost, and the new env vars/secrets) this ticket reports rather than
 * makes.
 * ============================================================================================
 */
const controlChannelAuthenticatorClass =
  process.env.NODE_ENV === "test" ? DevModeControlChannelAuthenticator : RealControlChannelAuthenticator;
const policyDecisionPointClass = process.env.NODE_ENV === "test" ? DevModePolicyDecisionPoint : RealPolicyDecisionPoint;

@Module({
  imports: [DbModule, AuditModule, ApiKeysModule, TenantsModule, CodegenModule],
  controllers: [LifecycleController, SchemaController, KeysController, ReleasesController, JobsController, ContractController],
  providers: [
    CommandAuditService,
    IdempotencyStore,
    JobsService,
    ControlAuthGuard,
    CommandAuthorizationGuard,
    LifecycleService,
    SchemaService,
    KeysCommandService,
    ReleasesCommandService,
    { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: controlChannelAuthenticatorClass },
    { provide: POLICY_DECISION_POINT, useClass: policyDecisionPointClass },
    { provide: RELEASE_TRANSPORT, useClass: NotYetAvailableReleaseTransport },
  ],
  // WSK-32 (coordinator edit) — `ControlAuthGuard` is exported so a SIBLING module can gate its
  // own routes with the REAL control-channel authenticator instead of standing up a second,
  // weaker one. WSK-32 shipped its own `SchemaDraftAuthGuard` precisely because this array held
  // only `JobsService`; that stub accepted ANY non-empty `x-webdesk-control-principal` value and
  // then wrote it into an audit row, so the audit trail was caller-controlled. Exporting the
  // guard (not the `CONTROL_CHANNEL_AUTHENTICATOR` token) is the narrow fix: the guard's own
  // dependency still resolves inside THIS module, so the environment-conditional binding above
  // — real authenticator everywhere except NODE_ENV=test — keeps applying to every consumer.
  exports: [JobsService, ControlAuthGuard],
})
export class ControlModule {}
