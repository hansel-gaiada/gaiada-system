// WSK-21 — asserts COMMAND_REGISTRY (src/control/command-types.ts) matches design §07's
// impact-class table, restated for the actual C-05 command set this ticket builds. Pure — no
// database, no Nest bootstrap. See command-types.ts's own header for the two documented
// departures from §07's literal wording (schema.propose folded into `read`; job.get/job.list are
// this ticket's own addition).
import { describe, expect, it } from "vitest";
import { COMMAND_REGISTRY, type CommandName, type CommandMeta } from "../src/control/command-types";

const EXPECTED: Record<CommandName, Omit<CommandMeta, "command">> = {
  "tenant.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "tenant.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "site.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "site.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "environment.provision": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "environment.archive": { impactClass: "high", scope: "webdesk:promote", jobTracked: false },
  "schema.propose": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "schema.apply": { impactClass: "medium", scope: "webdesk:operate", jobTracked: false },
  "key.mint": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.rotate": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "key.revoke": { impactClass: "high", scope: "webdesk:keys", jobTracked: false },
  "release.deploy": { impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "release.promote": { impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.rollback": { impactClass: "high", scope: "webdesk:promote", jobTracked: true },
  "release.triggerRebuild": { impactClass: "medium", scope: "webdesk:operate", jobTracked: true },
  "job.get": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "job.list": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
  "contract.read": { impactClass: "read", scope: "webdesk:read", jobTracked: false },
};

describe("control command registry — the impact-class map (design §07)", () => {
  it("has exactly the expected command set, no more, no fewer", () => {
    expect(Object.keys(COMMAND_REGISTRY).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [command, expected] of Object.entries(EXPECTED)) {
    it(`${command}: impactClass=${expected.impactClass} scope=${expected.scope} jobTracked=${expected.jobTracked}`, () => {
      const meta = COMMAND_REGISTRY[command as CommandName];
      expect(meta.command).toBe(command);
      expect(meta.impactClass).toBe(expected.impactClass);
      expect(meta.scope).toBe(expected.scope);
      expect(meta.jobTracked).toBe(expected.jobTracked);
    });
  }

  it("every HIGH-impact command uses webdesk:promote or webdesk:keys, never webdesk:read/operate (design §03 Layer 3/4)", () => {
    for (const meta of Object.values(COMMAND_REGISTRY)) {
      if (meta.impactClass === "high") {
        expect(["webdesk:promote", "webdesk:keys"]).toContain(meta.scope);
      }
    }
  });

  it("only release.* commands are job-tracked (deploy/promote/rollback/triggerRebuild — the C-05 'release' quarter)", () => {
    const jobTracked = Object.values(COMMAND_REGISTRY).filter((m) => m.jobTracked).map((m) => m.command);
    expect(jobTracked.sort()).toEqual(
      ["release.deploy", "release.promote", "release.rollback", "release.triggerRebuild"].sort(),
    );
  });
});
