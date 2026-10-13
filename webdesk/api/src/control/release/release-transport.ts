import type { CommandName } from "../command-types";

export const RELEASE_TRANSPORT = Symbol("RELEASE_TRANSPORT");

export type ReleaseTransportKind = "deploy" | "promote" | "rollback" | "rebuild";

export interface ReleaseTransportInput {
  kind: ReleaseTransportKind;
  command: CommandName;
  tenantSlug: string;
  envId: string;
  version?: string;
  args: Record<string, unknown>;
}

export interface ReleaseTransportResult {
  ok: true;
  detail: string;
}

/**
 * THE SEAM the ticket asks for: "define the seam and leave the transport unimplemented behind an
 * interface." RETIRED AS A DEPLOY PATH (M6-P6j, WSK-D29/D79): no control-plane adapter will be built.
 * Delivery is per site, run by the site's own CI over SFTP (webdesk/templates/_deploy/); `delphi`,
 * `helios` and Hostinger are per-site targets reached that way. `releases/releases-command.service.ts` never talks to a box directly; it only ever
 * calls this interface, bound in `control.module.ts` to `NotYetAvailableReleaseTransport` by
 * default.
 */
export interface ReleaseTransportAdapter {
  execute(input: ReleaseTransportInput): Promise<ReleaseTransportResult>;
}
