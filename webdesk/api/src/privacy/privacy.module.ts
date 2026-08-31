// WSK-38 — Data & Privacy / DSR command surface.
//
// ============================================================================================
// WHY THIS MODULE RE-PROVIDES CONTROL-CHANNEL CLASSES IT DOES NOT OWN, INSTEAD OF IMPORTING
// ControlModule: this ticket's hard constraints forbid editing `control/**`, and ControlModule
// exports only `[JobsService]` — its own `ControlAuthGuard`, `CONTROL_CHANNEL_AUTHENTICATOR` and
// `POLICY_DECISION_POINT` bindings are NOT visible to a module that merely imports ControlModule
// (Nest DI tokens are visible only to the declaring module unless that module exports them). The
// alternative — inventing a SEPARATE, weaker auth mechanism for privacy/** — would mean the most
// PII-concentrated command surface in this codebase (a full-tenant DSR dossier) is gated by
// something OTHER than the real §03 control channel, which is worse than this file's actual
// choice: import the same TS classes `control/**` already defines
// (ControlAuthGuard/DevModeControlChannelAuthenticator/RealControlChannelAuthenticator/
// DevModePolicyDecisionPoint/RealPolicyDecisionPoint — none of them edited, all of them read-only
// imports, exactly how forms.service.ts imports MediaService from a module it does not own) and
// bind them AGAIN under THIS module's own DI graph. Every request behind this module's guards goes
// through the IDENTICAL Layer 1-4 logic every other control-plane route does — two separate
// instances of stateless verifiers, not two different mechanisms. The SAME NODE_ENV=test
// dev-mode-stub convention control.module.ts documents is mirrored here for the identical reason
// (WSK-21/22's own existing 55+ tests never see this module and are therefore untouched either
// way).
//
// The properly-merged end state (this ticket's README section spells out the exact diff) is: this
// binding duplication collapses the day `PrivacyController`/`PrivacyCommandAuthorizationGuard`/
// `PRIVACY_COMMAND_REGISTRY` move into `control/**` and `PrivacyController` joins
// `ControlModule.controllers` — at which point this module either shrinks to nothing or is
// deleted outright. Until then, this duplication is the honest cost of "build the real WS4-gated
// surface without touching files outside this ticket's ownership."
// ============================================================================================
import { Module } from "@nestjs/common";
import { DbModule } from "../db/db.module";
import { AuditModule } from "../audit/audit.module";
import { TenantsModule } from "../tenants/tenants.module";
import { StorageModule } from "../storage/storage.module";

import { CONTROL_CHANNEL_AUTHENTICATOR } from "../control/auth/control-channel-authenticator";
import { DevModeControlChannelAuthenticator } from "../control/auth/dev-mode-control-channel-authenticator";
import { RealControlChannelAuthenticator } from "../control/auth/real-control-channel-authenticator";
import { ControlAuthGuard } from "../control/auth/control-auth.guard";

import { POLICY_DECISION_POINT } from "../control/policy/policy-decision-point";
import { DevModePolicyDecisionPoint } from "../control/policy/dev-mode-policy-decision-point";
import { RealPolicyDecisionPoint } from "../control/policy/real-policy-decision-point";

import { CommandAuditService } from "../control/command-audit.service";
import { IdempotencyStore } from "../control/idempotency/idempotency-store";

import { PrivacyCommandAuthorizationGuard } from "./policy/privacy-command-authorization.guard";
import { PrivacyRepository } from "./privacy.repository";
import { PrivacyAttachmentsService } from "./privacy-attachments.service";
import { PrivacyCommandService } from "./privacy.service";
import { PrivacyController } from "./privacy.controller";
import { ResidencyStatementService } from "./residency-statement.service";

const controlChannelAuthenticatorClass =
  process.env.NODE_ENV === "test" ? DevModeControlChannelAuthenticator : RealControlChannelAuthenticator;
const policyDecisionPointClass = process.env.NODE_ENV === "test" ? DevModePolicyDecisionPoint : RealPolicyDecisionPoint;

@Module({
  imports: [DbModule, AuditModule, TenantsModule, StorageModule],
  controllers: [PrivacyController],
  providers: [
    ControlAuthGuard,
    PrivacyCommandAuthorizationGuard,
    CommandAuditService,
    IdempotencyStore,
    PrivacyRepository,
    PrivacyAttachmentsService,
    PrivacyCommandService,
    ResidencyStatementService,
    { provide: CONTROL_CHANNEL_AUTHENTICATOR, useClass: controlChannelAuthenticatorClass },
    { provide: POLICY_DECISION_POINT, useClass: policyDecisionPointClass },
  ],
  exports: [PrivacyCommandService, ResidencyStatementService],
})
export class PrivacyModule {}
