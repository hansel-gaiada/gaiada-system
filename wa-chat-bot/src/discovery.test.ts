import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { config } from "./config";
import { emitDiscovery } from "./discovery";

const DIR = "data/test-discovery";

describe("discovery instrumentation (Task 3.8)", () => {
  beforeEach(() => {
    rmSync(DIR, { recursive: true, force: true });
    config.discoveryFile = `${DIR}/discovery.jsonl`;
  });
  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  it("records interaction metadata without any PII fields", () => {
    emitDiscovery({ ts: 1, surface: "whatsapp", kind: "command", command: "capture", isGroup: true });
    emitDiscovery({ ts: 2, surface: "telegram", kind: "dm", isGroup: false });
    const lines = readFileSync(config.discoveryFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first).toEqual({ ts: 1, surface: "whatsapp", kind: "command", command: "capture", isGroup: true });
    // No message content, sender, or chat identifiers — by shape.
    for (const line of lines) {
      const keys = Object.keys(JSON.parse(line));
      for (const k of keys) expect(["ts", "surface", "kind", "command", "isGroup"]).toContain(k);
    }
  });
});
