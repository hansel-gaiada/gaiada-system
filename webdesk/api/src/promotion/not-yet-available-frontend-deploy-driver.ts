// WSK-25 — copies ../control/release/not-yet-available-release-transport.ts's shape exactly: a
// documented, typed error, never a stack trace, never a fabricated success. Default binding for
// FRONTEND_DEPLOY_DRIVER in every environment until a real delphi/helios/Hostinger adapter exists
// (WSK-26'/29). The command that calls this (promotion-command.service.ts's `promote()`) treats
// this error as an EXPECTED, non-fatal outcome for the frontend sub-steps only — the content half
// of the promotion has already committed by the time this runs, and this failure does not roll
// that back (see that file's header for why "content promoted, frontend pending" is a distinct,
// honest terminal status rather than being folded into a blanket "failed").
import { Injectable } from "@nestjs/common";
import type { FrontendDeployDriver, FrontendDeployInput, FrontendDeployResult } from "./frontend-deploy-driver";

export class FrontendDeployNotAvailableError extends Error {
  readonly code = "FRONTEND_DEPLOY_NOT_AVAILABLE";
  constructor(step: string) {
    super(
      `frontend-deploy driver for step '${step}' is not yet implemented — the delphi/helios/Hostinger ` +
        `adapters are WSK-26'/29's build (design WSK-D26). Both hosts are OBSERVE-ONLY by owner ruling and ` +
        `unreachable from this dev machine, so this could not be built or verified live. The content half of ` +
        `this promotion (snapshot, migrate, content import) already committed before this step ran; only the ` +
        `box-side frontend effect is missing.`,
    );
  }
}

/** Default binding for FRONTEND_DEPLOY_DRIVER. Every call fails with a documented, typed error. */
@Injectable()
export class NotYetAvailableFrontendDeployDriver implements FrontendDeployDriver {
  async execute(input: FrontendDeployInput): Promise<FrontendDeployResult> {
    throw new FrontendDeployNotAvailableError(input.step);
  }
}
