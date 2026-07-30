// Tool-call audit (WS2 §8): who (OBO principal), which tool, decision, outcome.
// Args are NOT recorded (redaction-by-omission until the classifier exists).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
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

/** Most-recent audit entries, NEWEST FIRST — the read side of the JSONL trail, for the platform
 *  admin console. Mirrors the gateway's audit.ReadRecent: a missing file is "no activity yet"
 *  (empty list, not an error), and an unparseable line is skipped rather than failing the read —
 *  a torn last line during an append must not blank out the whole trail. */
export function readRecentAudit(file: string, limit = 100): ToolAudit[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: ToolAudit[] = [];
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as ToolAudit);
    } catch {
      /* skip a torn/corrupt line */
    }
  }
  return out;
}
