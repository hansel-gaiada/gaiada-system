// Tool registry (WS2 §6): core tools + (later) module-contributed tools aggregate here.
// Every tool declares the MINIMUM assurance needed; visibility and calls are policy-gated.
import type { Principal, Assurance } from "./principal";

export interface HubTool {
  name: string;
  description: string;
  /** Minimum assurance to SEE and CALL this tool. */
  minAssurance: Assurance;
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
