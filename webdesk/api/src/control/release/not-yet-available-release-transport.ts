import { Injectable } from "@nestjs/common";
import type { ReleaseTransportAdapter, ReleaseTransportInput, ReleaseTransportResult } from "./release-transport";

export class TransportNotAvailableError extends Error {
  readonly code = "TRANSPORT_NOT_AVAILABLE";
  constructor(kind: string) {
    super(
      `release transport for '${kind}' is not yet implemented — the delphi/helios/Hostinger adapters are ` +
        `WSK-25/26'/29's build (design WSK-D26). The job this belongs to lands in the 'failed' state with ` +
        `this same message; the command itself (idempotency, audit, job tracking) still ran correctly — ` +
        `only the actual box-side effect is missing.`,
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
