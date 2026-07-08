// Global action kill-switch. `actionsEnabled()` is checked before every mutating
// action executes; flipping the runtime toggle fail-closes all writes with no redeploy.
import { config } from "../config";

let enabled = config.actionsEnabledDefault;

export function actionsEnabled(): boolean {
  return enabled;
}

export function setActionsEnabled(on: boolean): void {
  enabled = on;
}

export function killSwitchMessage(): string {
  return "Actions are temporarily disabled. Reading and Q&A still work — please try again later.";
}
