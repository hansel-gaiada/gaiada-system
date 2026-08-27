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
 * interface." Under WSK-D26 the real deploy targets are `delphi` (staging), `helios`
 * (production), and Hostinger (WordPress) — those adapters are WSK-25/26'/29's build, not this
 * ticket's. `releases/releases-command.service.ts` never talks to a box directly; it only ever
 * calls this interface, bound in `control.module.ts` to `NotYetAvailableReleaseTransport` by
 * default.
 */
export interface ReleaseTransportAdapter {
  execute(input: ReleaseTransportInput): Promise<ReleaseTransportResult>;
}
