import type { ControlScope } from "../command-types";

export interface ControlPrincipal {
  /** Opaque caller identity — a Zone A service/automation principal id. Attribution only, per
   *  the same convention as `api_keys`/`releases`/`audit_entries`.created_by/actor across this
   *  ledger: never trusted for authorization by itself. */
  subject: string;
  scopes: ControlScope[];
  /** True for an automation-initiated call (bots/scheduled flows) vs a human-driven ERP click — §07: "medium for automation principals". */
  automation: boolean;
}
