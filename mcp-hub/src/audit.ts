// Tool-call audit (WS2 §8): who (OBO principal), which tool, decision, outcome.
// Args are NOT recorded (redaction-by-omission until the classifier exists).
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { recordToolAudit } from "./metrics";
import type { Principal } from "./principal";

export interface ToolAudit {
  ts: number;
  tool: string;
  principal: { provider: string; externalId: string; assurance: string };
  decision: "allow" | "deny";
  ok?: boolean; // handler outcome when allowed
  reason?: string; // deny reason
}

export function auditToolCall(e: ToolAudit): void {
  recordToolAudit(e); // WS9: mirror the decision as a metric (audit remains the source of truth)
  try {
    mkdirSync(dirname(config.auditFile), { recursive: true });
    appendFileSync(config.auditFile, JSON.stringify(e) + "\n");
  } catch (err) {
    console.warn(`[audit] write failed: ${(err as Error).message}`);
  }
}

export function principalRef(p: Principal): ToolAudit["principal"] {
  return { provider: p.provider, externalId: p.externalId, assurance: p.assurance };
}
