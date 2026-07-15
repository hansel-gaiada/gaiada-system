// Discovery instrumentation (Task 3.8): what do people actually use the assistant for?
// Feeds WS0 discovery / ERP requirements. Privacy-respecting BY SHAPE: the event type
// has no fields for message text, chat ids, or sender ids — only interaction metadata.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config";
import { recordDiscovery } from "./metrics";

export interface DiscoveryEvent {
  ts: number;
  surface: "whatsapp" | "telegram";
  kind: "command" | "mention" | "reply" | "dm";
  command?: string; // command name only, never its arguments
  isGroup: boolean;
}

export function emitDiscovery(e: DiscoveryEvent): void {
  recordDiscovery(e); // WS9: mirror as a PII-free metric (the JSONL log stays the source of truth)
  try {
    mkdirSync(dirname(config.discoveryFile), { recursive: true });
    appendFileSync(config.discoveryFile, JSON.stringify(e) + "\n");
  } catch (err) {
    console.warn(`[discovery] emit failed: ${(err as Error).message}`); // never block the reply
  }
}
