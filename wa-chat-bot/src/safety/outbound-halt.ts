// Global outbound halt: a manual, operator-facing "stop every outbound send NOW" switch.
// Deliberately SEPARATE from the action kill-switch (kill-switch.ts): that one is scoped to
// mutating /actions by design (its own message says "Reading and Q&A still work") and that
// contract must not change. This is the broader emergency stop for a real ban-risk incident
// (e.g. the session-reconnect-loop observed today) — when on, NOTHING leaves the bot on any
// surface: no reply, no digest, no media/reaction/button send. Mirrors the kill-switch /
// post-toggle runtime-override pattern: env sets the boot default, the runtime setter
// overrides it with no redeploy (an admin route wiring this is a follow-up for server.ts,
// noted in the report — this module only provides the primitive).
import { config } from "../config";

let halted = config.outboundHaltDefault;

export function outboundHaltEnabled(): boolean {
  return halted;
}

export function setOutboundHalt(on: boolean): void {
  halted = on;
}

/** Test-only reset to the configured boot default. */
export function resetOutboundHalt(): void {
  halted = config.outboundHaltDefault;
}
