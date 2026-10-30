// SCP-5 W5-A0 — the company rules' seed twin (BFF §63.30.3): `socialRulesDefaults.json` is byte-identical to the backend's
// `platform-nest/src/modules/social/social-rules-defaults.json`, the defaults DEMO_MODE's rules store starts from (63.30.5). Pure; runs anywhere.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import seed from "./socialRulesDefaults.json";

// Same trick as scpStageMachine.test.ts: route the path through a variable so Vite leaves it a real file:// read.
function readFileAt(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("SCP-5 company rules · the seed twin", () => {
  it("socialRulesDefaults.json is byte-identical to the backend's social-rules-defaults.json", () => {
    const nestRaw = readFileAt("../../../platform-nest/src/modules/social/social-rules-defaults.json");
    const uiRaw = readFileAt("./socialRulesDefaults.json");
    expect(uiRaw).toBe(nestRaw);
  });

  it("holds the five sections and names its version", () => {
    expect(Object.keys(seed).filter((k) => k !== "_about")).toEqual(["defaultsVersion", "reports", "ideas", "cycle", "audit", "saved"]);
    expect(typeof seed.defaultsVersion).toBe("string");
  });
});
