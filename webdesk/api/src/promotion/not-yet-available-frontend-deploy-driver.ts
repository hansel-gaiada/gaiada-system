// WSK-25 — copies ../control/release/not-yet-available-release-transport.ts's shape exactly: a
// documented, typed error, never a stack trace, never a fabricated success. Default binding for
// FRONTEND_DEPLOY_DRIVER in every environment: the control plane deploys nothing (WSK-D29/D79). The command that calls this (promotion-command.service.ts's `promote()`) treats
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
      `frontend-deploy driver for step '${step}' is not yet implemented here, and no host should be configured ` +
        `for it: the control plane holds no SSH key and deploys nothing (WSK-D29). Delivery is per site and runs ` +
        `in the site's own CI (WSK-D79): bind the site's delivery with POST sites/:id/delivery-binding (M6-P6g) ` +
        `and follow infra/runbooks/webdesk-staging-rebuild.md. The content half of this promotion (snapshot, ` +
        `migrate, content import) already committed before this step ran; only the box-side frontend effect is ` +
        `missing, by design.`,
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
