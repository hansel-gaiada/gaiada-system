// Egress audit (WS3 §8): every outbound AI call leaves a record — metadata only, never
// payload content. Append-only JSONL; ship to the tamper-evident trail when WS9 lands.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";

export interface EgressAudit {
  ts: number;
  capability: "llm" | "media" | "embed";
  provider: string | null; // null when blocked before egress
  ok: boolean;
  blocked?: "auth" | "budget" | "dlp" | "provider";
  redactions: number;
  latencyMs: number;
}

export function auditEgress(e: EgressAudit): void {
  try {
    mkdirSync(dirname(config.auditFile), { recursive: true });
    appendFileSync(config.auditFile, JSON.stringify(e) + "\n");
  } catch (err) {
    console.warn(`[audit] write failed: ${(err as Error).message}`);
  }
}
