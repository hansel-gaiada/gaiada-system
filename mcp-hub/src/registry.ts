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
}

const tools = new Map<string, HubTool>();

export function registerTool(t: HubTool): void {
  tools.set(t.name, t);
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
