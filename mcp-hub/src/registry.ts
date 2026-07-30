// Tool registry (WS2 §6): core tools + (later) module-contributed tools aggregate here.
// Every tool declares the MINIMUM assurance needed; visibility and calls are policy-gated.
import type { Principal, Assurance } from "./principal";

/** D14 impact taxonomy on write tools. A mutating tool MUST declare one; an unclassified
 *  write (write:true, impact undefined) is treated as confirm-required by the automation gate. */
export type Impact = "low" | "medium" | "high";

export interface HubTool {
  name: string;
  description: string;
  /** Minimum assurance to SEE and CALL this tool. */
  minAssurance: Assurance;
  /** True for mutating tools (platform writes). Read/probe tools omit it. */
  write?: boolean;
  /** D14 impact tier — required on write tools; drives the automation write gate (§3). */
  impact?: Impact;
  inputSchema: Record<string, unknown>; // JSON Schema advertised over MCP
  handler: (args: Record<string, unknown>, principal: Principal) => Promise<string>;
  /** Where this tool came from: a built-in group ("core", "platform", …) or a module key.
   *  Stamped at registration by withSource() — a tool never declares its own source, so the
   *  attribution can't drift from the registration site. Admin-console metadata only. */
  source?: string;
}

const tools = new Map<string, HubTool>();

// Registration-time source label. registerTool() is called from many places; rather than thread a
// source argument through every call site (and let them disagree), each registration GROUP wraps
// itself in withSource() and every tool registered inside inherits the label.
let currentSource = "core";

/** Run `fn` with every tool it registers attributed to `source`. Restores the previous label
 *  afterwards (including on throw) so a failing group can't mislabel later registrations. */
export function withSource<T>(source: string, fn: () => T): T {
  const prev = currentSource;
  currentSource = source;
  try {
    return fn();
  } finally {
    currentSource = prev;
  }
}

export function registerTool(t: HubTool): void {
  tools.set(t.name, { ...t, source: t.source ?? currentSource });
}

export function getTool(name: string): HubTool | undefined {
  return tools.get(name);
}

export function allTools(): HubTool[] {
  return [...tools.values()];
}

export function resetRegistry(): void {
  tools.clear();
}
