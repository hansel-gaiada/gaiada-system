// WSK-38 — asserts PRIVACY_COMMAND_REGISTRY (src/privacy/command-types.ts) matches this ticket's
// own "correct impact class" decision, restated in test form the same way
// test/control-command-registry.spec.ts pins WSK-21's own registry. Pure — no database, no Nest
// bootstrap.
import { describe, expect, it } from "vitest";
import { PRIVACY_COMMAND_REGISTRY, type PrivacyCommandName, type PrivacyCommandMeta } from "../src/privacy/command-types";

const EXPECTED: Record<PrivacyCommandName, Omit<PrivacyCommandMeta, "command">> = {
  "privacy.find": { impactClass: "high", scope: "webdesk:operate", jobTracked: false },
  "privacy.export": { impactClass: "high", scope: "webdesk:operate", jobTracked: false },
  "privacy.erase": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
};

describe("privacy command registry — the DSR impact-class map (design §11/WSK-D22b)", () => {
  it("has exactly the expected command set, no more, no fewer", () => {
    expect(Object.keys(PRIVACY_COMMAND_REGISTRY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [command, expected] of Object.entries(EXPECTED)) {
    it(`${command}: impactClass=${expected.impactClass} scope=${expected.scope} jobTracked=${expected.jobTracked}`, () => {
      const meta = PRIVACY_COMMAND_REGISTRY[command as PrivacyCommandName];
      expect(meta.command).toBe(command);
      expect(meta.impactClass).toBe(expected.impactClass);
      expect(meta.scope).toBe(expected.scope);
      expect(meta.jobTracked).toBe(expected.jobTracked);
    });
  }

  it("all three commands are HIGH impact — find/export are WS4-gated too, not just erase (ticket's explicit instruction)", () => {
    for (const meta of Object.values(PRIVACY_COMMAND_REGISTRY)) {
      expect(meta.impactClass).toBe("high");
    }
  });

  it("only privacy.erase uses webdesk:promote — the scope tier this command surface reserves for irreversible actions elsewhere (tenant.archive/site.archive/release.rollback)", () => {
    expect(PRIVACY_COMMAND_REGISTRY["privacy.erase"].scope).toBe("webdesk:promote");
    expect(PRIVACY_COMMAND_REGISTRY["privacy.find"].scope).toBe("webdesk:operate");
    expect(PRIVACY_COMMAND_REGISTRY["privacy.export"].scope).toBe("webdesk:operate");
  });
});
