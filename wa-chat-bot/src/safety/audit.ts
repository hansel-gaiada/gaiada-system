// Append-only, PII-safe audit of every mutating-action attempt. One JSON line per
// entry (like discovery.ts). Actor ids are hashed, never stored raw; free text is scrubbed.
import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config";
import { scrub } from "../scrub";

export interface ActionAuditEntry {
  ts: number;
  surface: string;
  chatId: string;
  actor: string;
  action: string;
  argsSummary: string;
  decision: "allow" | "deny" | "stepup";
  outcome: "done" | "failed" | "blocked";
  error?: string;
}

export function actorHash(surface: string, externalId: string): string {
  return createHash("sha256").update(`${surface}|${externalId}`).digest("hex").slice(0, 16);
}

export async function recordActionAudit(entry: ActionAuditEntry): Promise<void> {
  const safe = { ...entry, argsSummary: scrub(entry.argsSummary).clean };
  await mkdir(dirname(config.actionAuditFile), { recursive: true });
  await appendFile(config.actionAuditFile, JSON.stringify(safe) + "\n", "utf8");
}

export async function readActionAudit(limit = 1000): Promise<ActionAuditEntry[]> {
  let raw = "";
  try {
    raw = await readFile(config.actionAuditFile, "utf8");
  } catch {
    return [];
  }
  const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as ActionAuditEntry);
  return rows.slice(-limit);
}
