import { Injectable } from "@nestjs/common";
import type { ReleaseTransportAdapter, ReleaseTransportInput, ReleaseTransportResult } from "./release-transport";

export class TransportNotAvailableError extends Error {
  readonly code = "TRANSPORT_NOT_AVAILABLE";
  constructor(kind: string) {
    super(
      `release transport for '${kind}' is not yet implemented here, and no host should be configured for it: ` +
        `the control plane holds no SSH key and deploys nothing (WSK-D29). Delivery is per site and runs in the ` +
        `site's own CI (WSK-D79): bind the site's delivery with POST sites/:id/delivery-binding (M6-P6g) and ` +
        `follow infra/runbooks/webdesk-staging-rebuild.md. The job this belongs to lands in the 'failed' state ` +
        `with this same message; the command itself (idempotency, audit, job tracking) still ran correctly — ` +
        `only the box-side effect is missing, by design.`,
    );
  }
}

/** Default binding for RELEASE_TRANSPORT. Every call fails with a documented, typed error — never a stack trace, never a fabricated success. */
@Injectable()
export class NotYetAvailableReleaseTransport implements ReleaseTransportAdapter {
  async execute(input: ReleaseTransportInput): Promise<ReleaseTransportResult> {
    throw new TransportNotAvailableError(input.kind);
  }
}
