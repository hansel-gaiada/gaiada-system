// WSK-38 — a SHADOW registry, deliberately shaped byte-for-byte like
// ../control/command-types.ts's own COMMAND_REGISTRY, for the three DSR commands (design §11,
// WSK-D22b: "find / export / delete ... as a WS4-gated audited control-plane command surfaced in
// the console").
//
// WHY THIS IS A SEPARATE FILE, NOT AN EDIT TO control/command-types.ts: this ticket's hard
// constraints forbid touching `control/**` — command-types.ts's own `CommandName` union and
// `COMMAND_REGISTRY` map are exactly that file. This module is therefore a parallel, structurally
// IDENTICAL registry that a follow-up merges into the real one with a small, mechanical diff (see
// ../../../README.md's "WSK-38" section for the exact three-row/one-import patch). Everything here
// is written so that merge is a rename, not a redesign: same field names (command/impactClass/
// scope/jobTracked), same `ImpactClass`/`ControlScope` value domain (imported TYPE-ONLY from
// control/command-types.ts — reusing the type is a read, not an edit), same naming convention
// (`<noun>.<verb>`).
//
// THE IMPACT-CLASS DECISION (the "correct impact class" the ticket asks for, restated here where
// the registry itself lives — full reasoning in the README): all three commands are HIGH. This is
// a deliberate widening beyond the generic C-05 default (where `find`/`export`-shaped reads would
// normally sit at `read`/`medium`): finding or exporting a real human's COMPLETE footprint across
// a tenant concentrates PII in a way a single ordinary read never does, and design §11/WSK-D22b's
// own wording — "as a WS4-gated ... command", no carve-out for find/export — reads as all three
// deserving the same human-approval discipline, not just the destructive one. What DOES
// distinguish erase from the other two is its SCOPE: `webdesk:promote`, the same scope tier this
// command surface already reserves for every other genuinely irreversible action
// (tenant.archive/site.archive/release.rollback in control/command-types.ts) — find/export stay on
// `webdesk:operate`, the tier for consequential-but-non-destructive operations. So while all three
// require WS4, only erase sits in the "irreversible" scope tier — which is the concrete, checkable
// form "erase is irreversible — treat it accordingly" takes in this registry.
import type { ImpactClass, ControlScope } from "../control/command-types";

export type PrivacyCommandName = "privacy.find" | "privacy.export" | "privacy.erase";

export interface PrivacyCommandMeta {
  readonly command: PrivacyCommandName;
  readonly impactClass: ImpactClass;
  readonly scope: ControlScope;
  readonly jobTracked: boolean;
}

export const PRIVACY_COMMAND_REGISTRY: Readonly<Record<PrivacyCommandName, PrivacyCommandMeta>> = Object.freeze({
  "privacy.find": { command: "privacy.find", impactClass: "high", scope: "webdesk:operate", jobTracked: false },
  "privacy.export": { command: "privacy.export", impactClass: "high", scope: "webdesk:operate", jobTracked: false },
  "privacy.erase": { command: "privacy.erase", impactClass: "high", scope: "webdesk:promote", jobTracked: false },
});

export function privacyCommandMeta(command: PrivacyCommandName): PrivacyCommandMeta {
  return PRIVACY_COMMAND_REGISTRY[command];
}
