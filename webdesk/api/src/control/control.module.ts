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
// M6-P4r-b -- the live contract-codegen rail (queue, worker, trigger). tenant.provision and schema.apply
// queue a run after their commit; contract.regenerate is the re-run / backfill command.
import { ContractCodegenModule } from "../codegen/contract-codegen.module";
// WSK-41 — the content commands fan their post-commit events out through the tenant-webhook
// dispatcher (TenantWebhooksModule exports it). AppModule already imports TenantWebhooksModule;
// Nest modules are singletons, so this adds no second queue or worker in the real app.
import { TenantWebhooksModule } from "../tenant-webhooks/tenant-webhooks.module";

import { CommandAuditService } from "./command-audit.service";
import { CommandEnvelope } from "./command-envelope";
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
import { ContractRegenerateController } from "./contract/contract-regenerate.controller";
import { ContractRegenerateService } from "./contract/contract-regenerate.service";

// WSK-41 — content authoring commands + the editorial principal seam + the durable idempotency store.
import { PgIdempotencyStore } from "./idempotency/pg-idempotency-store";
import { EDITORIAL_PRINCIPAL_RESOLVER } from "./auth/editorial-principal";
import { EditorialAssertionGuard } from "./auth/editorial-assertion.guard";
import { DevModeEditorialPrincipalResolver } from "./auth/dev-mode-editorial-principal-resolver";
// WSK-40 — the real Ed25519 editorial assertion verifier (pinned JWKS file + jti replay store).
import { RealEditorialPrincipalResolver } from "./auth/real-editorial-principal-resolver";
import { ContentCommandsService } from "./content/content-commands.service";
import { ContentCommandsController } from "./content/content-commands.controller";
// WSK-46 — draft-preview tokens (mint / revoke), on the shared command envelope.
import { PreviewTokenCommandsService } from "./content/preview-token-commands.service";
import { PreviewTokenCommandsController } from "./content/preview-token-commands.controller";
// WSK-43a — the media library's writes (upload token / update / delete), on the shared command envelope.
import { MediaCommandsService } from "./content/media-commands.service";
import { MediaCommandsController } from "./content/media-commands.controller";
// WSK-51 — the editor's live read commands (design §4): tenant.list + the content reads.
import { ContentReadsService } from "./content/content-reads.service";
import { ContentReadsController } from "./content/content-reads.controller";
import { TenantReadsService } from "./tenants/tenant-reads.service";
import { TenantReadsController } from "./tenants/tenant-reads.controller";
// M5-L1/L2 — forms.submission.get.
import { FormsReadsService } from "./forms/forms-reads.service";
import { FormsReadsController } from "./forms/forms-reads.controller";
// M5-L1d — forms.define / forms.def.list / forms.def.get.
import { FormDefsService } from "./forms/form-defs.service";
import { FormDefsController } from "./forms/form-defs.controller";
// M5-V3-a -- consent.status.
import { ConsentStatusService } from "./consent/consent-status.service";
import { ConsentStatusController } from "./consent/consent-status.controller";
// M5-W2b — the writers' room review commands and reads.
import { EditorialCommandsService } from "./editorial/editorial-commands.service";
import { EditorialCommandsController } from "./editorial/editorial-commands.controller";
import { EditorialReadsService } from "./editorial/editorial-reads.service";
import { EditorialReadsController } from "./editorial/editorial-reads.controller";

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

// WSK-41 — the editorial principal (Layer 2e, write-plane design §5). Same environment-conditional
// pattern as the two bindings above: the dev-mode header stub under NODE_ENV=test, and everywhere
// else a resolver that refuses every content write with 503 editorial-keys-not-configured, because
// there is nothing to verify an assertion against until WSK-40 lands. WSK-40 SWAPPED THE NEXT LINE
// ONLY: RealEditorialPrincipalResolver verifies the Ed25519 assertion against the pinned JWKS file and
// consumes its jti; with no JWKS file it still answers 503 editorial-keys-not-configured, exactly as
// NotConfiguredEditorialPrincipalResolver did (that class stays, used by the WSK-41 gate spec).
const editorialPrincipalResolverClass = process.env.NODE_ENV === "test" ? DevModeEditorialPrincipalResolver : RealEditorialPrincipalResolver;

@Module({
  imports: [DbModule, AuditModule, ApiKeysModule, TenantsModule, CodegenModule, ContractCodegenModule, TenantWebhooksModule],
  controllers: [
    LifecycleController,
    SchemaController,
    KeysController,
    ReleasesController,
    JobsController,
    ContractController,
    ContractRegenerateController,
    ContentCommandsController,
    PreviewTokenCommandsController,
    MediaCommandsController,
    ContentReadsController,
    TenantReadsController,
    FormsReadsController,
    ConsentStatusController,
    FormDefsController,
    EditorialCommandsController,
    EditorialReadsController,
  ],
  providers: [
    CommandAuditService,
    CommandEnvelope,
    JobsService,
    ControlAuthGuard,
    CommandAuthorizationGuard,
    LifecycleService,
    SchemaService,
    KeysCommandService,
    ReleasesCommandService,
    ContractRegenerateService,
    PgIdempotencyStore,
    EditorialAssertionGuard,
    ContentCommandsService,
    PreviewTokenCommandsService,
    MediaCommandsService,
    ContentReadsService,
    TenantReadsService,
    FormsReadsService,
    ConsentStatusService,
    FormDefsService,
    EditorialCommandsService,
    EditorialReadsService,
    { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: controlChannelAuthenticatorClass },
    { provide: POLICY_DECISION_POINT, useClass: policyDecisionPointClass },
    { provide: RELEASE_TRANSPORT, useClass: NotYetAvailableReleaseTransport },
    { provide: EDITORIAL_PRINCIPAL_RESOLVER, useClass: editorialPrincipalResolverClass },
  ],
  // WSK-32 (coordinator edit) — `ControlAuthGuard` is exported so a SIBLING module can gate its
  // own routes with the REAL control-channel authenticator instead of standing up a second,
  // weaker one. WSK-32 shipped its own `SchemaDraftAuthGuard` precisely because this array held
  // only `JobsService`; that stub accepted ANY non-empty `x-webdesk-control-principal` value and
  // then wrote it into an audit row, so the audit trail was caller-controlled.
  //
  // WSK-25 (additive correction) — the comment above claimed "the guard's own dependency still
  // resolves inside THIS module", but that was never actually runtime-proven (WSK-32's own suite
  // is fakes-only, per its ticket report — it never boots a real Nest app with ControlModule +
  // a sibling module together). Building PromotionModule as that SAME sibling pattern and
  // actually booting it (Test.createTestingModule({imports:[ControlModule, PromotionModule]}))
  // surfaced a real DI error: "Nest can't resolve dependencies of the ControlAuthGuard (?)...
  // Symbol(CONTROL_CHANNEL_AUTHENTICATOR) at index [0] is not available in the PromotionModule
  // context." Cross-module class-reference `@UseGuards(ControlAuthGuard)` resolution needs
  // ControlAuthGuard's OWN constructor dependency reachable from the CONSUMING module's import
  // graph too — exporting the guard class alone was not sufficient. Exporting the token it
  // depends on closes the actual gap (this fixes the SAME latent issue for SchemaDraftModule,
  // not just PromotionModule — neither had ever been proven to boot).
  // WSK-33/25 — exporting the GUARD CLASSES alone is NOT enough, and believing it was put a
  // non-booting app on main. `@UseGuards(SomeGuard)` in a consuming module makes Nest INSTANTIATE
  // that guard in THAT module's injector, so the guard's own constructor dependencies must be
  // resolvable there. With only the classes exported, AppModule died at boot with:
  //
  //   Nest can't resolve dependencies of the ControlAuthGuard (?). Please make sure that the
  //   argument Symbol(CONTROL_CHANNEL_AUTHENTICATOR) at index [0] is available in the
  //   SchemaDraftModule context.
  //
  // `tsc` was clean and 135 tests passed, because every one of those suites bound its guards
  // ad-hoc inside a Test.createTestingModule() and NONE booted the real module.
  // test/zz-real-boot.spec.ts now exists so that cannot be true again.
  //
  // POLICY_DECISION_POINT is here for the same reason as CONTROL_CHANNEL_AUTHENTICATOR:
  // CommandAuthorizationGuard needs it, and SchemaDraftModule uses that guard.
  //
  // These are exported, NOT re-bound. The environment-conditional choice above (real
  // authenticator/PDP everywhere except NODE_ENV=test) stays the single source of that decision, so
  // a consuming module cannot accidentally bind the dev-mode stub in production.
  exports: [
    JobsService,
    ControlAuthGuard,
    CommandAuthorizationGuard,
    CONTROL_CHANNEL_AUTHENTICATOR,
    POLICY_DECISION_POINT,
  ],
})
export class ControlModule {}
